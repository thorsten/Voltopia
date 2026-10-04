import { describe, expect, it } from 'vitest';
import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { computeDemand, decayStep, growthStep } from './growth.ts';
import { placePlant } from './energy.ts';
import { PlantType } from '../shared/types.ts';
import { buildPowerLines } from './powerLines.ts';
import { buildRoads } from './roads.ts';
import { SERVICE_FIRE } from './services.ts';
import {
  ageStageOf,
  collectDiffs,
  createSimState,
  SupplyStatus,
  TileType,
  Zone,
  type SimState,
} from './state.ts';
import { paintZones } from './zones.ts';

const SIZE = 16;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);

/** A state with a horizontal road at y=5 and residential zoning above it. */
function cityWithRoad(): SimState {
  const state = createSimState(42, SIZE);
  const road = Array.from({ length: 10 }, (_, x) => at(x + 2, 5));
  buildRoads(state, road);
  return state;
}

function runGrowth(state: SimState, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    growthStep(state, computeDemand(state));
  }
}

function totalDensity(state: SimState, zone: Zone): number {
  let sum = 0;
  for (let i = 0; i < state.layers.zone.length; i++) {
    if (state.layers.zone[i] === zone && state.layers.tileType[i] === TileType.Empty) {
      sum += state.layers.density[i];
    }
  }
  return sum;
}

describe('computeDemand', () => {
  it('an empty city wants residents (pioneer demand)', () => {
    const state = createSimState(1, SIZE);
    const demand = computeDemand(state);
    expect(demand.residential).toBeGreaterThan(0.5);
  });

  it('population without jobs creates commercial demand', () => {
    const state = createSimState(1, SIZE);
    state.layers.zone[at(1, 1)] = Zone.Residential;
    state.layers.density[at(1, 1)] = 3;
    const demand = computeDemand(state);
    expect(demand.commercial).toBeGreaterThan(0.5);
    expect(demand.retail).toBeGreaterThan(0);
  });

  it('a jobs surplus suppresses commercial demand', () => {
    const state = createSimState(1, SIZE);
    state.layers.zone[at(1, 1)] = Zone.Commercial;
    state.layers.density[at(1, 1)] = 3;
    const demand = computeDemand(state);
    expect(demand.commercial).toBeLessThan(0);
    // jobs attract residents
    expect(demand.residential).toBeGreaterThan(0);
  });

  it('a balanced large city never deadlocks: some zone still meets the growth threshold', () => {
    // 20 residential blocks at density 3 = 520 residents; 15 commercial
    // blocks at density 3 = 330 jobs. Jobs sit just under the sustainable
    // ratio, so a fixed pioneer bonus alone leaves BOTH demands under the
    // threshold and the city freezes.
    const state = createSimState(1, SIZE);
    const { zone, density } = state.layers;
    for (let i = 0; i < 20; i++) {
      const tile = at(i % SIZE, 1 + Math.floor(i / SIZE));
      zone[tile] = Zone.Residential;
      density[tile] = 3;
    }
    for (let i = 0; i < 15; i++) {
      zone[at(i, 3)] = Zone.Commercial;
      density[at(i, 3)] = 3;
    }
    const demand = computeDemand(state);
    const threshold = BALANCE.growth.growthDemandThreshold;
    expect(Math.max(demand.residential, demand.commercial)).toBeGreaterThanOrEqual(threshold);
  });

  it('demand headroom is large enough to rule out a two-sided deadlock', () => {
    // Both demands can only fall under the threshold together when
    // ((1 - threshold) * headroom) ^ 2 < 1; keep the config on the safe side.
    const { demandHeadroom, growthDemandThreshold } = BALANCE.growth;
    expect(demandHeadroom * (1 - growthDemandThreshold)).toBeGreaterThan(1);
  });

  it('demand values stay within -1..1', () => {
    const state = createSimState(1, SIZE);
    for (let i = 0; i < 20; i++) {
      state.layers.zone[at(i % SIZE, Math.floor(i / SIZE))] = Zone.Commercial;
      state.layers.density[at(i % SIZE, Math.floor(i / SIZE))] = 3;
    }
    const demand = computeDemand(state);
    for (const value of Object.values(demand)) {
      expect(value).toBeGreaterThanOrEqual(-1);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

describe('growthStep', () => {
  it('spawns buildings only on zoned tiles next to roads', () => {
    const state = cityWithRoad();
    // zone next to the road and one far away
    paintZones(state, [at(4, 4), at(5, 4), at(6, 4)], Zone.Residential);
    paintZones(state, [at(12, 12)], Zone.Residential);
    runGrowth(state, 2000);
    expect(totalDensity(state, Zone.Residential)).toBeGreaterThan(0);
    expect(state.layers.density[at(12, 12)]).toBe(0);
  });

  it('never grows without any zones', () => {
    const state = cityWithRoad();
    runGrowth(state, 500);
    expect(totalDensity(state, Zone.Residential)).toBe(0);
    expect(totalDensity(state, Zone.Commercial)).toBe(0);
  });

  it('densifies up to level 3 over time (no energy system yet)', () => {
    const state = cityWithRoad();
    paintZones(state, [at(4, 4)], Zone.Residential);
    // fire cover is required for the top density since the services feature
    state.layers.services.fill(SERVICE_FIRE);
    runGrowth(state, BALANCE.growth.densifyMinAge * 30);
    expect(state.layers.density[at(4, 4)]).toBe(3);
  });

  it('does not densify young buildings', () => {
    const state = cityWithRoad();
    paintZones(state, [at(4, 4)], Zone.Residential);
    // Run just enough for a spawn but far less than densifyMinAge.
    runGrowth(state, 50);
    expect(state.layers.density[at(4, 4)]).toBeLessThanOrEqual(1);
  });

  it('stops growing when happiness is too low', () => {
    const state = cityWithRoad();
    paintZones(state, [at(4, 4), at(5, 4)], Zone.Residential);
    state.happiness = BALANCE.happiness.growthMinimum - 0.01;
    runGrowth(state, 1000);
    expect(totalDensity(state, Zone.Residential)).toBe(0);
  });

  it('does not spawn on undersupplied tiles', () => {
    const state = cityWithRoad();
    paintZones(state, [at(4, 4)], Zone.Residential);
    state.layers.supplied[at(4, 4)] = SupplyStatus.Undersupplied;
    runGrowth(state, 1000);
    expect(state.layers.density[at(4, 4)]).toBe(0);
  });

  it('is deterministic for the same seed', () => {
    const build = (): SimState => {
      const state = cityWithRoad();
      paintZones(state, [at(4, 4), at(5, 4), at(6, 4), at(4, 6), at(5, 6)], Zone.Residential);
      runGrowth(state, 800);
      return state;
    };
    const a = build();
    const b = build();
    expect([...a.layers.density]).toEqual([...b.layers.density]);
    expect([...a.layers.variant]).toEqual([...b.layers.variant]);
  });

  it('chronically unpowered buildings decay and eventually empty', () => {
    const state = cityWithRoad();
    placePlant(state, at(14, 14), PlantType.WindTurbine); // activates the grid
    state.layers.zone[at(4, 4)] = Zone.Residential;
    state.layers.density[at(4, 4)] = 3;
    state.layers.supplied[at(4, 4)] = SupplyStatus.Undersupplied;
    for (let i = 0; i < BALANCE.growth.abandonAfterTicks * 8; i++) {
      decayStep(state);
      // decayStep resets nothing here: keep the tile troubled
      state.layers.supplied[at(4, 4)] = SupplyStatus.Undersupplied;
    }
    expect(state.layers.density[at(4, 4)]).toBe(0);
  });

  it('supplied buildings never decay', () => {
    const state = cityWithRoad();
    placePlant(state, at(14, 14), PlantType.WindTurbine);
    state.layers.zone[at(4, 4)] = Zone.Residential;
    state.layers.density[at(4, 4)] = 2;
    state.layers.supplied[at(4, 4)] = SupplyStatus.Supplied;
    for (let i = 0; i < BALANCE.growth.abandonAfterTicks * 4; i++) {
      decayStep(state);
    }
    expect(state.layers.density[at(4, 4)]).toBe(2);
  });

  it('no decay before the first plant exists', () => {
    const state = cityWithRoad();
    state.layers.zone[at(4, 4)] = Zone.Residential;
    state.layers.density[at(4, 4)] = 2;
    state.layers.supplied[at(4, 4)] = SupplyStatus.NotConnected;
    for (let i = 0; i < BALANCE.growth.abandonAfterTicks * 4; i++) {
      decayStep(state);
    }
    expect(state.layers.density[at(4, 4)]).toBe(2);
  });

  it('brief undersupply dips recover instead of accumulating', () => {
    const state = cityWithRoad();
    placePlant(state, at(14, 14), PlantType.WindTurbine);
    state.layers.zone[at(4, 4)] = Zone.Residential;
    state.layers.density[at(4, 4)] = 2;
    // 30% troubled ticks: the leaky counter must stay near zero.
    for (let i = 0; i < BALANCE.growth.abandonAfterTicks * 6; i++) {
      state.layers.supplied[at(4, 4)] =
        i % 10 < 3 ? SupplyStatus.Undersupplied : SupplyStatus.Supplied;
      decayStep(state);
    }
    expect(state.layers.density[at(4, 4)]).toBe(2);
  });

  it('commercial grows once residents exist', () => {
    const state = cityWithRoad();
    paintZones(state, [at(4, 4), at(5, 4), at(6, 4)], Zone.Residential);
    paintZones(state, [at(4, 6), at(5, 6)], Zone.Commercial);
    runGrowth(state, 4000);
    expect(totalDensity(state, Zone.Commercial)).toBeGreaterThan(0);
  });

  it('never spawns a building on a tile that carries a power line', () => {
    const state = cityWithRoad();
    paintZones(state, [at(4, 4), at(5, 4), at(6, 4)], Zone.Residential);
    const zoned: number[] = [];
    for (let i = 0; i < state.layers.zone.length; i++) {
      if (state.layers.zone[i] !== Zone.None) zoned.push(i);
    }
    expect(zoned.length).toBeGreaterThan(0);
    state.money = 1e9;
    buildPowerLines(state, zoned);
    runGrowth(state, 500);
    expect(totalDensity(state, Zone.Residential)).toBe(0);
  });
});

describe('fire coverage gate', () => {
  function readyToDensify(density: number): SimState {
    const state = cityWithRoad();
    paintZones(state, [at(4, 4)], Zone.Residential);
    state.layers.density[at(4, 4)] = density;
    state.layers.buildingAge[at(4, 4)] = BALANCE.growth.densifyMinAge;
    state.layers.supplied[at(4, 4)] = SupplyStatus.Supplied;
    return state;
  }

  it('blocks density 2 -> 3 without fire cover', () => {
    const state = readyToDensify(2);
    runGrowth(state, BALANCE.growth.densifyMinAge * 30);
    expect(state.layers.density[at(4, 4)]).toBe(2);
  });

  it('allows density 2 -> 3 with fire cover', () => {
    const state = readyToDensify(2);
    state.layers.services[at(4, 4)] = SERVICE_FIRE;
    runGrowth(state, BALANCE.growth.densifyMinAge * 30);
    expect(state.layers.density[at(4, 4)]).toBe(3);
  });

  it('does not gate density 1 -> 2', () => {
    const state = readyToDensify(1);
    runGrowth(state, BALANCE.growth.densifyMinAge * 30);
    expect(state.layers.density[at(4, 4)]).toBe(2);
  });
});

describe('delivery gate', () => {
  const demand = { residential: 1, commercial: 1, retail: 1 };
  function shop(age: number) {
    const state = createSimState(3, SIZE);
    buildRoads(state, [at(5, 5), at(6, 5)]);
    state.layers.zone[at(5, 6)] = Zone.Retail;
    state.layers.density[at(5, 6)] = 1;
    state.layers.buildingAge[at(5, 6)] = BALANCE.growth.densifyMinAge;
    state.layers.deliveryAge[at(5, 6)] = age;
    for (let t = 0; t < 4000; t++) growthStep(state, demand);
    return state.layers.density[at(5, 6)];
  }

  it('a shop past the supply window does not densify', () => {
    expect(shop(BALANCE.deliveries.supplyWindowDays * TICKS_PER_DAY + 1)).toBe(1);
  });

  it('a supplied shop densifies', () => {
    expect(shop(0)).toBeGreaterThan(1);
  });
});

describe('age stages (building visuals stage 3)', () => {
  it('marks a building dirty on exactly the ticks its age reaches a threshold', () => {
    // No roads: nothing can spawn or densify, so the only dirty marks
    // come from the age loop.
    const state = createSimState(7, SIZE);
    const index = at(3, 3);
    state.layers.zone[index] = Zone.Residential;
    state.layers.density[index] = 1;
    for (const threshold of BALANCE.growth.ageStageTicks) {
      state.layers.buildingAge[index] = threshold - 2;
      state.dirty.clear();
      growthStep(state, computeDemand(state)); // -> threshold - 1
      expect(state.dirty.has(index)).toBe(false);
      growthStep(state, computeDemand(state)); // -> threshold
      expect(state.dirty.has(index)).toBe(true);
      state.dirty.clear();
      growthStep(state, computeDemand(state)); // -> threshold + 1
      expect(state.dirty.has(index)).toBe(false);
    }
  });

  it('does not age or dirty an empty tile', () => {
    const state = createSimState(7, SIZE);
    const index = at(3, 3);
    state.layers.buildingAge[index] = BALANCE.growth.ageStageTicks[0] - 1;
    state.dirty.clear();
    growthStep(state, computeDemand(state));
    expect(state.layers.buildingAge[index]).toBe(BALANCE.growth.ageStageTicks[0] - 1);
    expect(state.dirty.has(index)).toBe(false);
  });

  it('a densified building starts over as new', () => {
    const state = cityWithRoad();
    const index = at(4, 4);
    paintZones(state, [index], Zone.Residential);
    state.layers.density[index] = 1;
    state.layers.supplied[index] = SupplyStatus.Supplied;
    // Old enough to be weathered and to densify.
    state.layers.buildingAge[index] = BALANCE.growth.ageStageTicks[1] + 10;
    expect(ageStageOf(state.layers.buildingAge[index])).toBe(2);
    for (
      let t = 0;
      t < BALANCE.growth.densifyMinAge * 30 && state.layers.density[index] === 1;
      t++
    ) {
      growthStep(state, computeDemand(state));
    }
    expect(state.layers.density[index]).toBe(2);
    expect(state.layers.buildingAge[index]).toBe(0);
    const diff = collectDiffs(state).find((d) => d.index === index);
    expect(diff?.ageStage).toBe(0);
  });
});
