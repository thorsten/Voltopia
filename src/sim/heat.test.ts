import { describe, expect, it } from 'vitest';
import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { HEATED_NONE, HEATED_SERVED, HEATED_TRUNK } from '../shared/types.ts';
import { heatingConsumption, placePlant } from './energy.ts';
import {
  chargeHeatStore,
  heatPumpCop,
  heatStep,
  IDLE_HEAT,
  nightNeedsHeat,
  plantReach,
  recomputeHeated,
} from './heat.ts';
import { buildPowerLines } from './powerLines.ts';
import { buildRoads } from './roads.ts';
import {
  collectDiffs,
  createSimState,
  deserializeState,
  serializeState,
  PlantType,
  TileType,
  Zone,
  type SimState,
} from './state.ts';
import { stepTick } from './tick.ts';

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

/**
 * One powered plant (two when `plants` is 2: the second at the east end
 * of the road), a 40-tile road, and `count` served residential buildings
 * of `density` on alternating sides of the road (x = 4 + floor(i / 2)).
 * A power line strung at y = row + 2 (the turbines' row, clear of both the
 * road and the buildings either side of it) carries the turbines'
 * energisation the length of the village, so every building the trunk
 * reaches is also connected — only the road-hop reach, not the turbines'
 * own small supply ring, decides who is served.
 */
function village(state: SimState, count: number, density = 1, plants = 1): void {
  roadEast(state, 3, 10, 40); // x = 3..42
  poweredHeatPlant(state, 2, 10);
  if (plants === 2) poweredHeatPlant(state, 43, 10);
  buildPowerLines(
    state,
    Array.from({ length: 40 }, (_, i) => at(3 + i, 12)),
  );
  for (let i = 0; i < count; i++) {
    building(state, 4 + Math.floor(i / 2), i % 2 === 0 ? 9 : 11, density);
  }
}

/** Heat demand of `count` residential buildings of `density` at `temperature`. */
function demandOf(state: SimState, count: number, temperature: number, density = 1): number {
  return count * heatingConsumption(Zone.Residential, density, temperature, state.insulation);
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

  it('does not serve a damaged building, and serves it again once repaired', () => {
    const state = freshState();
    roadEast(state, 3, 10, 10);
    poweredHeatPlant(state, 2, 10);
    building(state, 4, 9);
    state.layers.damage[at(4, 9)] = 40;
    recomputeHeated(state);
    expect(state.layers.heated[at(4, 9)]).toBe(HEATED_NONE);
    state.layers.damage[at(4, 9)] = 0;
    recomputeHeated(state);
    expect(state.layers.heated[at(4, 9)]).toBe(HEATED_SERVED);
  });

  it('does not serve a building beside the network that no supply ring reaches', () => {
    const state = freshState();
    roadEast(state, 3, 10, 12);
    poweredHeatPlant(state, 2, 10); // turbine ring (radius 3) ends at x = 5
    building(state, 12, 9); // trunk road at (12,10) is within reach, but no power here
    recomputeHeated(state);
    expect(state.layers.heated[at(12, 10)]).toBe(HEATED_TRUNK);
    expect(state.layers.energized[at(12, 9)]).toBe(0);
    expect(state.layers.heated[at(12, 9)]).toBe(HEATED_NONE);
  });
});

describe('heatStep', () => {
  it('serves demand from the pumps at the COP when the store is empty', () => {
    const state = freshState();
    village(state, 4);
    state.season = { ...state.season, temperature: 0 };
    const heat = heatStep(state);
    const demand = demandOf(state, 4, 0);
    expect(demand).toBeGreaterThan(0);
    expect(heat.demand).toBeCloseTo(demand, 6);
    expect(heat.fromStore).toBe(0);
    expect(heat.pumpHeat).toBeCloseTo(demand, 6);
    expect(heat.cop).toBeCloseTo(heatPumpCop(0), 6);
    expect(heat.pumpPower).toBeCloseTo(demand / heatPumpCop(0), 6);
    expect(heat.fallback).toBe(0);
    expect(heat.networkHeat).toBeCloseTo(demand, 6);
    expect(heat.pumpPowerLeft).toBeCloseTo(BALANCE.heat.pumpPowerLimit - heat.pumpPower, 6);
  });

  it('drains the store before running the pumps', () => {
    const state = freshState();
    village(state, 4);
    placePlant(state, at(2, 14), PlantType.HeatStore);
    state.season = { ...state.season, temperature: 0 };
    state.heatStored = 1_000;
    const heat = heatStep(state);
    expect(heat.fromStore).toBeCloseTo(heat.demand, 6);
    expect(heat.pumpHeat).toBe(0);
    expect(heat.pumpPower).toBe(0);
    // Loss applies after the discharge.
    expect(state.heatStored).toBeCloseTo(
      (1_000 - heat.demand) * (1 - BALANCE.heat.storeLossPerTick),
      6,
    );
  });

  it('honours the store discharge limit and lets the pumps cover the rest', () => {
    const state = freshState();
    // Two plants reach 46 of the 80 dense buildings (≈ 294 heat at full
    // cold), more than one store releases per tick.
    village(state, 80, 3, 2);
    placePlant(state, at(2, 14), PlantType.HeatStore);
    state.season = { ...state.season, temperature: -20 };
    state.heatStored = BALANCE.heat.storeCapacity;
    const heat = heatStep(state);
    expect(heat.demand).toBeGreaterThan(BALANCE.heat.storeDischargeLimit);
    expect(heat.fromStore).toBeCloseTo(BALANCE.heat.storeDischargeLimit, 6);
    expect(heat.pumpHeat).toBeCloseTo(heat.demand - BALANCE.heat.storeDischargeLimit, 6);
    expect(heat.fallback).toBe(0);
  });

  it('falls back past the pump limit when there is no store', () => {
    const state = freshState();
    village(state, 80, 3, 2);
    state.season = { ...state.season, temperature: -20 };
    const heat = heatStep(state);
    const cop = heatPumpCop(-20);
    const pumpLimit = 2 * BALANCE.heat.pumpPowerLimit;
    expect(heat.demand).toBeGreaterThan(pumpLimit * cop);
    expect(heat.fromStore).toBe(0);
    expect(heat.pumpHeat).toBeCloseTo(pumpLimit * cop, 6);
    expect(heat.pumpPower).toBeCloseTo(pumpLimit, 6);
    expect(heat.fallback).toBeCloseTo(heat.demand - heat.pumpHeat, 6);
    expect(heat.pumpPowerLeft).toBeCloseTo(0, 6);
  });

  it('clamps the store to the installed capacity and reports headroom', () => {
    const state = freshState();
    village(state, 0);
    placePlant(state, at(2, 14), PlantType.HeatStore);
    state.season = { ...state.season, temperature: 20 }; // no demand
    state.heatStored = BALANCE.heat.storeCapacity * 5;
    const heat = heatStep(state);
    expect(heat.capacity).toBe(BALANCE.heat.storeCapacity);
    expect(state.heatStored).toBeLessThanOrEqual(BALANCE.heat.storeCapacity);
    expect(heat.headroom).toBeCloseTo(BALANCE.heat.storeCapacity - state.heatStored, 6);
  });

  it('is idle without plants: no demand, full fallback for nobody', () => {
    const state = freshState();
    building(state, 5, 5);
    state.season = { ...state.season, temperature: -5 };
    const heat = heatStep(state);
    expect(heat).toMatchObject({ demand: 0, pumpPower: 0, fallback: 0, networkHeat: 0 });
  });

  it('a damaged served building leaves the heat demand', () => {
    const state = freshState();
    village(state, 2);
    state.season = { ...state.season, temperature: 0 };
    const before = heatStep(state).demand;
    state.layers.damage[at(4, 9)] = 40;
    const after = heatStep(state).demand;
    expect(before).toBeGreaterThan(0);
    expect(after).toBeCloseTo(before / 2, 6);
  });

  it('a damaged store shrinks the capacity and clamps the pool', () => {
    const state = freshState();
    village(state, 0);
    placePlant(state, at(2, 14), PlantType.HeatStore);
    placePlant(state, at(2, 16), PlantType.HeatStore);
    state.season = { ...state.season, temperature: 20 };
    state.heatStored = 2 * BALANCE.heat.storeCapacity;
    state.layers.damage[at(2, 16)] = 40;
    const heat = heatStep(state);
    expect(heat.capacity).toBe(BALANCE.heat.storeCapacity);
    expect(state.heatStored).toBeLessThanOrEqual(BALANCE.heat.storeCapacity);
  });
});

describe('nightNeedsHeat', () => {
  const { comfortTemperature } = BALANCE.seasons.heating;
  const swing = BALANCE.seasons.diurnalAmplitude;

  it('opens when the coming night drops below the comfort temperature', () => {
    expect(nightNeedsHeat(comfortTemperature + swing - 0.5)).toBe(true);
    expect(nightNeedsHeat(-5)).toBe(true);
  });

  it('closes on a warm day', () => {
    expect(nightNeedsHeat(comfortTemperature + swing)).toBe(false);
    expect(nightNeedsHeat(30)).toBe(false);
  });
});

describe('chargeHeatStore', () => {
  function storeState(temperature: number): { state: SimState; heat: ReturnType<typeof heatStep> } {
    const state = freshState();
    village(state, 0);
    placePlant(state, at(2, 14), PlantType.HeatStore);
    state.season = { ...state.season, temperature };
    return { state, heat: heatStep(state) };
  }

  it('stores cop heat units per electricity unit within pump power and headroom', () => {
    const { state, heat } = storeState(0);
    const absorbed = chargeHeatStore(state, heat, 20);
    expect(absorbed).toBeCloseTo(20, 6);
    expect(state.heatStored).toBeCloseTo(20 * heatPumpCop(0), 6);
    expect(heat.pumpPowerLeft).toBeCloseTo(BALANCE.heat.pumpPowerLimit - 20, 6);
  });

  it('is capped by the pump power left', () => {
    const { state, heat } = storeState(0);
    const absorbed = chargeHeatStore(state, heat, 10_000);
    expect(absorbed).toBeCloseTo(BALANCE.heat.pumpPowerLimit, 6);
  });

  it('is capped by the headroom', () => {
    const { state, heat } = storeState(0);
    state.heatStored = BALANCE.heat.storeCapacity - 7;
    heat.headroom = 7;
    const absorbed = chargeHeatStore(state, heat, 10_000);
    expect(absorbed).toBeCloseTo(7 / heatPumpCop(0), 6);
    expect(state.heatStored).toBeCloseTo(BALANCE.heat.storeCapacity, 6);
  });

  it('does nothing while the nights are warm', () => {
    const { state, heat } = storeState(30);
    expect(chargeHeatStore(state, heat, 100)).toBe(0);
    expect(state.heatStored).toBe(0);
  });

  it('does nothing without a plant to pump with', () => {
    const state = freshState();
    placePlant(state, at(2, 14), PlantType.HeatStore);
    state.season = { ...state.season, temperature: 0 };
    const heat = heatStep(state);
    expect(chargeHeatStore(state, heat, 100)).toBe(0);
  });

  it('IDLE_HEAT absorbs nothing', () => {
    const state = freshState();
    expect(chargeHeatStore(state, { ...IDLE_HEAT }, 100)).toBe(0);
  });
});

/**
 * A flat-map winter village built with the same script every time: a
 * plant, a turbine, a store, six served buildings. `createSimState`
 * rather than `SimEngine.init` so no generated river or lake can cut
 * the road.
 */
function scriptedState(seed: number): SimState {
  const state = createSimState(seed, SIZE);
  state.money = 1e9;
  roadEast(state, 3, 10, 20);
  poweredHeatPlant(state, 2, 10);
  placePlant(state, at(2, 14), PlantType.HeatStore);
  // Carries the turbine's energisation the length of the village; see
  // village()'s comment.
  buildPowerLines(
    state,
    Array.from({ length: 20 }, (_, i) => at(3 + i, 12)),
  );
  for (let i = 0; i < 6; i++) building(state, 4 + i, 9, 2);
  // SEASON_ORDER is spring, summer, autumn, winter: a year that started
  // three seasons ago puts day 0 on the first winter day.
  state.seasonOriginDay = -BALANCE.seasons.daysPerSeason * 3;
  return state;
}

describe('district heating is deterministic and survives a reload', () => {
  it('two states with the same seed and script agree on the store and the layer', () => {
    const a = scriptedState(5);
    const b = scriptedState(5);
    for (let i = 0; i < TICKS_PER_DAY; i++) {
      stepTick(a);
      stepTick(b);
    }
    expect(a.heatStored).toBe(b.heatStored);
    expect(a.lastEnergy.networkHeat).toBe(b.lastEnergy.networkHeat);
    expect(Array.from(a.layers.heated)).toEqual(Array.from(b.layers.heated));
    expect(a.lastEnergy.networkHeat).toBeGreaterThan(0);
  });

  it('a save in mid-operation reloads with the same store and rebuilds the layer', () => {
    const live = scriptedState(9);
    for (let i = 0; i < TICKS_PER_DAY / 2; i++) stepTick(live);
    const save = serializeState(live);
    const restored = deserializeState(save);
    expect(restored.heatStored).toBe(live.heatStored);
    // Derived, never saved: empty on load, rebuilt by the first tick.
    expect(restored.layers.heated.every((v) => v === HEATED_NONE)).toBe(true);
    stepTick(restored);
    expect(restored.layers.heated.filter((v) => v === HEATED_SERVED).length).toBe(6);
    expect(restored.layers.heated.filter((v) => v === HEATED_TRUNK).length).toBe(
      BALANCE.heat.reachHops,
    );
  });

  it('the tile diff carries the heated value', () => {
    const state = freshState();
    roadEast(state, 3, 10, 10);
    poweredHeatPlant(state, 2, 10);
    building(state, 4, 9);
    collectDiffs(state); // drain the build diffs
    recomputeHeated(state);
    const diffs = collectDiffs(state);
    expect(diffs.find((d) => d.index === at(3, 10))?.heated).toBe(HEATED_TRUNK);
    expect(diffs.find((d) => d.index === at(4, 9))?.heated).toBe(HEATED_SERVED);
  });
});
