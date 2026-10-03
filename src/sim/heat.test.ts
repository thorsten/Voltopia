import { describe, expect, it } from 'vitest';
import { BALANCE } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { HEATED_NONE, HEATED_SERVED, HEATED_TRUNK } from '../shared/types.ts';
import { placePlant } from './energy.ts';
import { heatPumpCop, plantReach, recomputeHeated } from './heat.ts';
import { buildRoads } from './roads.ts';
import { createSimState, PlantType, TileType, Zone, type SimState } from './state.ts';

const SIZE = 48;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);

function freshState(): SimState {
  const state = createSimState(1, SIZE);
  state.money = 1e9;
  return state;
}

/** A road running east from (x0, y) for `length` tiles. */
function roadEast(state: SimState, x0: number, y: number, length: number): void {
  buildRoads(
    state,
    Array.from({ length }, (_, i) => at(x0 + i, y)),
  );
}

/** A heat plant at (x, y), energised by a wind turbine ring south of it. */
function poweredHeatPlant(state: SimState, x: number, y: number): void {
  placePlant(state, at(x, y), PlantType.HeatPlant);
  placePlant(state, at(x, y + 2), PlantType.WindTurbine);
}

function building(state: SimState, x: number, y: number, density = 1): void {
  state.layers.zone[at(x, y)] = Zone.Residential;
  state.layers.density[at(x, y)] = density;
}

describe('heatPumpCop', () => {
  const cfg = BALANCE.heat;

  it('is copWarm at and above the warm temperature', () => {
    expect(heatPumpCop(cfg.copWarmTemperature)).toBe(cfg.copWarm);
    expect(heatPumpCop(cfg.copWarmTemperature + 30)).toBe(cfg.copWarm);
  });

  it('is copCold at and below the cold temperature', () => {
    expect(heatPumpCop(cfg.copColdTemperature)).toBe(cfg.copCold);
    expect(heatPumpCop(cfg.copColdTemperature - 30)).toBe(cfg.copCold);
  });

  it('is linear and monotone in between', () => {
    const mid = (cfg.copWarmTemperature + cfg.copColdTemperature) / 2;
    expect(heatPumpCop(mid)).toBeCloseTo((cfg.copWarm + cfg.copCold) / 2, 6);
    expect(heatPumpCop(mid + 1)).toBeGreaterThan(heatPumpCop(mid));
  });
});

describe('plantReach', () => {
  it('reaches reachHops road tiles from the plant and not one more', () => {
    const state = freshState();
    // Plant at (2, 10); the road starts right next to it at (3, 10).
    roadEast(state, 3, 10, 30);
    placePlant(state, at(2, 10), PlantType.HeatPlant);
    const reach = new Set(plantReach(state, at(2, 10)));
    const hops = BALANCE.heat.reachHops;
    expect(reach.has(at(3, 10))).toBe(true);
    expect(reach.has(at(3 + hops - 1, 10))).toBe(true);
    expect(reach.has(at(3 + hops, 10))).toBe(false);
    expect(reach.size).toBe(hops);
  });

  it('is empty for a plant with no adjacent road', () => {
    const state = freshState();
    roadEast(state, 10, 10, 5);
    placePlant(state, at(2, 2), PlantType.HeatPlant);
    expect(plantReach(state, at(2, 2))).toEqual([]);
  });
});

describe('recomputeHeated', () => {
  it('marks reached roads as trunk and road-adjacent buildings as served', () => {
    const state = freshState();
    roadEast(state, 3, 10, 30);
    poweredHeatPlant(state, 2, 10);
    building(state, 5, 9); // north of the road, within reach
    building(state, 5, 11); // south of the road, within reach
    building(state, 3 + BALANCE.heat.reachHops + 2, 9); // beyond reach
    recomputeHeated(state);
    const { heated } = state.layers;
    expect(heated[at(3, 10)]).toBe(HEATED_TRUNK);
    expect(heated[at(5, 9)]).toBe(HEATED_SERVED);
    expect(heated[at(5, 11)]).toBe(HEATED_SERVED);
    expect(heated[at(3 + BALANCE.heat.reachHops + 2, 9)]).toBe(HEATED_NONE);
    expect(heated[at(2, 10)]).toBe(HEATED_NONE); // the plant tile itself
  });

  it('two plants union their reach', () => {
    const state = freshState();
    roadEast(state, 3, 10, 40);
    poweredHeatPlant(state, 2, 10);
    poweredHeatPlant(state, 30, 11); // its road neighbour is (30, 10)
    recomputeHeated(state);
    expect(state.layers.heated[at(3, 10)]).toBe(HEATED_TRUNK);
    expect(state.layers.heated[at(30, 10)]).toBe(HEATED_TRUNK);
    // (17,10) is 14 hops from the first plant's road and 13 from the second's.
    expect(state.layers.heated[at(17, 10)]).toBe(HEATED_NONE);
  });

  it('an unpowered plant reaches nothing', () => {
    const state = freshState();
    roadEast(state, 3, 10, 10);
    placePlant(state, at(2, 10), PlantType.HeatPlant); // no turbine, no lines
    building(state, 4, 9);
    recomputeHeated(state);
    expect(state.layers.heated[at(3, 10)]).toBe(HEATED_NONE);
    expect(state.layers.heated[at(4, 9)]).toBe(HEATED_NONE);
  });

  it('a damaged plant drops out and returns once repaired', () => {
    const state = freshState();
    roadEast(state, 3, 10, 10);
    poweredHeatPlant(state, 2, 10);
    recomputeHeated(state);
    expect(state.layers.heated[at(3, 10)]).toBe(HEATED_TRUNK);
    state.layers.damage[at(2, 10)] = 50;
    recomputeHeated(state);
    expect(state.layers.heated[at(3, 10)]).toBe(HEATED_NONE);
    state.layers.damage[at(2, 10)] = 0;
    recomputeHeated(state);
    expect(state.layers.heated[at(3, 10)]).toBe(HEATED_TRUNK);
  });

  it('marks only changed tiles dirty', () => {
    const state = freshState();
    roadEast(state, 3, 10, 10);
    poweredHeatPlant(state, 2, 10);
    recomputeHeated(state);
    state.dirty.clear();
    recomputeHeated(state);
    expect(state.dirty.size).toBe(0);
    state.layers.tileType[at(2, 10)] = TileType.Empty;
    state.layers.plantType[at(2, 10)] = PlantType.None;
    state.gridVersion++;
    recomputeHeated(state);
    expect(state.dirty.has(at(3, 10))).toBe(true);
    expect(state.layers.heated[at(3, 10)]).toBe(HEATED_NONE);
  });
});
