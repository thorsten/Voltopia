import { describe, expect, it } from 'vitest';
import { BALANCE } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import {
  DisasterKind,
  PlantType,
  Terrain,
  TileType,
  Zone,
  type DisasterEvent,
} from '../shared/types.ts';
import { placePlant } from './energy.ts';
import { floodArea, floodRisk, floodSpec } from './flood.ts';
import { buildPowerLines } from './powerLines.ts';
import { buildRoads } from './roads.ts';
import { createSimState, type SimState } from './state.ts';
import { generateTerrain } from './terrain.ts';
import { generateWater } from './water.ts';

const SIZE = 32;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);

/**
 * Let a flood soak for `ticks` ticks. The tick has to advance: the
 * per-tile damage is a sub-point-per-tick rate accumulated from
 * `state.tick - event.startTick`, so applying the same tick over and over
 * (as these fixtures used to) is a flood standing still.
 */
function soak(state: SimState, event: DisasterEvent, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    floodSpec.apply(state, event);
    state.tick++;
  }
}

/** A map with a real river carved into real relief. */
function river(seed = 1): SimState {
  const state = createSimState(seed, SIZE);
  generateTerrain(state);
  generateWater(state);
  return state;
}

/** A flat valley: one river column at elevation 0, land rising to the east. */
function valley(): SimState {
  const state = createSimState(2, SIZE);
  for (let y = 0; y < SIZE; y++) {
    state.layers.terrain[at(0, y)] = Terrain.River;
    for (let x = 1; x < SIZE; x++) state.layers.elevation[at(x, y)] = Math.min(7, x);
  }
  return state;
}

describe('floodRisk', () => {
  it('is zero while the river runs low', () => {
    const state = river();
    state.weather.riverFlow = 0.2;
    expect(floodRisk(state)).toBe(0);
  });

  it('rises with the flow and again with a melting snowpack', () => {
    const state = river();
    state.weather.riverFlow = 1;
    state.weather.snowpack = 0;
    state.season = { ...state.season, temperature: 20 };
    const plain = floodRisk(state);
    state.weather.snowpack = 0.5;
    expect(floodRisk(state)).toBeGreaterThan(plain);
    expect(plain).toBeGreaterThan(0);
  });
});

describe('floodArea', () => {
  it('covers the low ground next to the water and nothing above the water line', () => {
    const state = valley();
    const { tiles, depth } = floodArea(state, 1);
    const rise = BALANCE.disasters.flood.maxRise;
    expect(tiles.length).toBeGreaterThan(0);
    for (const index of tiles) {
      expect(state.layers.elevation[index]).toBeLessThanOrEqual(rise);
      expect(state.layers.terrain[index]).toBe(Terrain.Land);
    }
    expect(tiles).toContain(at(1, 5));
    expect(tiles).not.toContain(at(7, 5));
    expect(depth).toHaveLength(tiles.length);
  });

  it('loses one level of head per tile of land, so flat ground bounds it', () => {
    // Dead-flat ground is the case relief cannot bound: carrying the water
    // line inland unchanged walked it across the whole map (the balancing
    // probe measured the mildest flood covering every land tile on three of
    // six seeds). Here the only thing stopping the water is the decay, so
    // the reach is exactly `rise` tiles and the depth steps down by one.
    const state = createSimState(3, SIZE);
    for (let y = 0; y < SIZE; y++) state.layers.terrain[at(0, y)] = Terrain.River;
    const rise = BALANCE.disasters.flood.maxRise;
    const { tiles, depth } = floodArea(state, 1);
    const depthAt = new Map(tiles.map((index, i) => [index, depth[i]]));
    for (let x = 1; x <= rise; x++) expect(depthAt.get(at(x, 5))).toBe(rise - x);
    expect(depthAt.has(at(rise + 1, 5))).toBe(false);
  });

  it('is deterministic for the same map and severity', () => {
    const a = floodArea(valley(), 0.7).tiles;
    const b = floodArea(valley(), 0.7).tiles;
    expect(a).toEqual(b);
  });

  it('grows with severity and never shrinks', () => {
    const state = valley();
    const small = floodArea(state, 0.2).tiles.length;
    const large = floodArea(state, 1).tiles.length;
    expect(large).toBeGreaterThanOrEqual(small);
  });

  it('never drops a tile as severity rises, on real generated terrain', () => {
    // The assertion the old hop-count bound failed. A bigger flood must be
    // a superset of every smaller one — otherwise a lot that drowned last
    // spring stays dry in a worse flood, and "building in the floodplain is
    // an informed choice" stops being true. Counting tiles is not enough:
    // the bound that broke this swapped one tile for another at the step
    // where it tightened, so compare the sets themselves. Real relief, not
    // the flat fixture, because a synthetic map is exactly where a
    // path-order bug hides.
    for (const seed of [1, 2, 3, 4, 5]) {
      const state = river(seed);
      let previous = new Set<number>();
      let grew = false;
      for (let severity = 0.05; severity <= 1.0001; severity += 0.05) {
        const tiles = new Set(floodArea(state, severity).tiles);
        for (const index of previous) {
          expect(tiles.has(index)).toBe(true);
        }
        if (tiles.size > previous.size) grew = true;
        previous = tiles;
      }
      // A sweep over a map the water never reaches would pass vacuously.
      expect(previous.size).toBeGreaterThan(0);
      expect(grew).toBe(true);
    }
  });

  it('leaves the terrain layer untouched', () => {
    const state = river(5);
    const before = Uint8Array.from(state.layers.terrain);
    const plan = floodSpec.plan(state, 1);
    expect(plan).not.toBe(null);
    const event = {
      id: 1,
      kind: DisasterKind.Flood,
      severity: 1,
      startTick: 0,
      endTick: 100,
      ...plan!,
    };
    soak(state, event, 20);
    expect(state.layers.terrain).toEqual(before);
  });
});

describe('a flood in progress', () => {
  it('damages what stands in the floodplain and leaves bare land alone', () => {
    const state = valley();
    state.layers.zone[at(1, 5)] = Zone.Residential;
    state.layers.density[at(1, 5)] = 2;
    placePlant(state, at(1, 7), PlantType.SolarFarm);
    const plan = floodSpec.plan(state, 1)!;
    const event = {
      id: 1,
      kind: DisasterKind.Flood,
      severity: 1,
      startTick: 0,
      endTick: 100,
      ...plan,
    };
    soak(state, event, 10);
    expect(state.layers.damage[at(1, 5)]).toBeGreaterThan(0);
    expect(state.layers.damage[at(1, 7)]).toBeGreaterThan(0);
    expect(state.layers.damage[at(1, 9)]).toBe(0); // bare land just gets wet
  });

  it('runs its full duration', () => {
    const state = valley();
    const plan = floodSpec.plan(state, 1)!;
    expect(
      floodSpec.apply(state, {
        id: 1,
        kind: DisasterKind.Flood,
        severity: 1,
        startTick: 0,
        endTick: 100,
        ...plan,
      }),
    ).toBe(false);
  });

  it('finds no site on a map without a river', () => {
    expect(floodSpec.plan(createSimState(1, SIZE), 1)).toBe(null);
  });

  it('never damages a bare road, but does damage the road under a power line', () => {
    const state = valley();
    const bareRoad = at(1, 10);
    const roadWithLine = at(1, 12);
    buildRoads(state, [bareRoad, roadWithLine]);
    buildPowerLines(state, [roadWithLine]);
    const plan = floodSpec.plan(state, 1)!;
    expect(plan.tiles).toContain(bareRoad);
    expect(plan.tiles).toContain(roadWithLine);
    const event = {
      id: 1,
      kind: DisasterKind.Flood,
      severity: 1,
      startTick: 0,
      endTick: 100,
      ...plan,
    };
    soak(state, event, 10);
    expect(state.layers.damage[bareRoad]).toBe(0);
    expect(state.layers.tileType[bareRoad]).toBe(TileType.Road);
    expect(state.layers.damage[roadWithLine]).toBeGreaterThan(0);
    expect(state.layers.tileType[roadWithLine]).toBe(TileType.Road);
  });
});
