import { describe, expect, it } from 'vitest';
import { BALANCE } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { DisasterKind, PlantType, TileType, Zone } from '../shared/types.ts';
import { placePlant } from './energy.ts';
import { dryness, fireCandidates, fireRisk, fireSpec } from './fire.ts';
import { buildRoads } from './roads.ts';
import { recomputeServices, SERVICE_FIRE } from './services.ts';
import { createSimState, type SimState } from './state.ts';

const SIZE = 24;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);

/** A dry summer city: warm, cloudless, no snow. */
function dryCity(seed = 1): SimState {
  const state = createSimState(seed, SIZE);
  state.season = { ...state.season, temperature: 26 };
  state.weather.cloudCover = 0;
  state.weather.snowpack = 0;
  return state;
}

function block(state: SimState, x0: number, x1: number, y: number, density = 3): void {
  for (let x = x0; x <= x1; x++) {
    state.layers.zone[at(x, y)] = Zone.Residential;
    state.layers.density[at(x, y)] = density;
  }
}

function fire(state: SimState, origin: number, severity = 1) {
  return {
    id: 1,
    kind: DisasterKind.Fire,
    severity,
    startTick: state.tick,
    endTick: state.tick + fireSpec.durationTicks,
    origin,
    tiles: [origin],
    intensity: [BALANCE.disasters.fire.burnTicks],
  };
}

describe('dryness', () => {
  it('is high in a warm, cloudless, snow-free city', () => {
    expect(dryness(dryCity())).toBeGreaterThan(0.8);
  });

  it('is zero under snow', () => {
    const state = dryCity();
    state.weather.snowpack = 1;
    expect(dryness(state)).toBe(0);
  });

  it('is zero in overcast weather', () => {
    const state = dryCity();
    state.weather.cloudCover = 1;
    expect(dryness(state)).toBe(0);
  });
});

describe('fireRisk', () => {
  it('is zero in a city with nothing to burn', () => {
    expect(fireRisk(dryCity())).toBe(0);
  });

  it('falls once the buildings have fire cover', () => {
    const bare = dryCity();
    block(bare, 4, 11, 4);
    const risky = fireRisk(bare);

    const covered = dryCity();
    block(covered, 4, 11, 4);
    buildRoads(covered, [at(7, 6)]);
    placePlant(covered, at(7, 5), PlantType.FireStation);
    placePlant(covered, at(8, 5), PlantType.WindTurbine);
    recomputeServices(covered);
    expect((covered.layers.services[at(7, 4)] & SERVICE_FIRE) !== 0).toBe(true);

    expect(fireRisk(covered)).toBeLessThan(risky);
  });

  it('lists mature woods as ignition candidates in a drought', () => {
    const state = dryCity();
    state.layers.forest[at(9, 9)] = BALANCE.forest.maxStage;
    expect(fireCandidates(state)).toContain(at(9, 9));
  });
});

describe('a burning city', () => {
  it('spreads along a row of buildings', () => {
    const state = dryCity(19);
    block(state, 4, 14, 4);
    const event = fire(state, at(4, 4));
    for (let i = 0; i < fireSpec.durationTicks; i++) fireSpec.apply(state, event);
    expect(event.tiles.length).toBeGreaterThan(1);
    expect(state.layers.damage[at(4, 4)]).toBeGreaterThan(0);
  });

  it('stops at a road — roads are firebreaks', () => {
    const state = dryCity(12);
    block(state, 4, 6, 4);
    buildRoads(state, [at(7, 4)]);
    block(state, 8, 12, 4);
    const event = fire(state, at(4, 4));
    for (let i = 0; i < fireSpec.durationTicks; i++) fireSpec.apply(state, event);
    expect(state.layers.damage[at(7, 4)]).toBe(0);
    for (let x = 8; x <= 12; x++) expect(state.layers.damage[at(x, 4)]).toBe(0);
  });

  it('burns out faster under fire cover', () => {
    const burn = (covered: boolean): number => {
      const state = dryCity(13);
      block(state, 4, 14, 4);
      if (covered) {
        for (let x = 4; x <= 14; x++) state.layers.services[at(x, 4)] = SERVICE_FIRE;
      }
      const event = fire(state, at(4, 4));
      let ticks = 0;
      while (ticks < fireSpec.durationTicks && !fireSpec.apply(state, event)) ticks++;
      return event.tiles.length;
    };
    expect(burn(true)).toBeLessThan(burn(false));
  });

  it('burns woods down to bare ground instead of damaging them', () => {
    const state = dryCity(14);
    state.layers.forest[at(5, 5)] = BALANCE.forest.maxStage;
    const event = fire(state, at(5, 5));
    fireSpec.apply(state, event);
    expect(state.layers.forest[at(5, 5)]).toBe(0);
    expect(state.layers.damage[at(5, 5)]).toBe(0);
  });

  it('reports itself finished once everything is out', () => {
    const state = dryCity(15);
    state.layers.zone[at(5, 5)] = Zone.Residential;
    state.layers.density[at(5, 5)] = 1;
    const event = fire(state, at(5, 5));
    let done = false;
    for (let i = 0; i < fireSpec.durationTicks && !done; i++) done = fireSpec.apply(state, event);
    expect(done).toBe(true);
  });

  it('finds no site when there is nothing flammable', () => {
    const state = dryCity(16);
    state.layers.tileType[at(5, 5)] = TileType.Road;
    expect(fireSpec.plan(state, 1)).toBe(null);
  });
});
