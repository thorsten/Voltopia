import { describe, expect, it } from 'vitest';
import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { DisasterKind, PlantType, Terrain, Zone } from '../shared/types.ts';
import { placePlant } from './energy.ts';
import { goalsStep, goalStates } from './goals.ts';
import { buildPowerLines } from './powerLines.ts';
import { isCoastalSea } from './sea.ts';
import { refreshBuildingCount } from './smartMeters.ts';
import { createSimState, deserializeState, serializeState, type SimState } from './state.ts';
import { generateTerrain } from './terrain.ts';
import { generateWater } from './water.ts';

const SIZE = 16;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);

/** A generated map: elevation and water (river, lake, sea) but no zoning. */
function generatedState(seed: number, size: number): SimState {
  const state = createSimState(seed, size);
  generateTerrain(state);
  generateWater(state);
  return state;
}

describe('goals', () => {
  it('starts with no goals achieved', () => {
    const state = createSimState(1, SIZE);
    goalsStep(state);
    expect(goalStates(state).every((g) => !g.achieved)).toBe(true);
  });

  it('firstPower unlocks with the first plant', () => {
    const state = createSimState(1, SIZE);
    placePlant(state, at(3, 3), PlantType.WindTurbine);
    goalsStep(state);
    expect(state.goalsAchieved.has('firstPower')).toBe(true);
  });

  it('population goals unlock at their thresholds', () => {
    const state = createSimState(1, SIZE);
    // 5 residential buildings at density 3 = 130 population
    for (let i = 0; i < 5; i++) {
      state.layers.zone[at(i, 1)] = Zone.Residential;
      state.layers.density[at(i, 1)] = 3;
    }
    goalsStep(state);
    expect(state.goalsAchieved.has('population100')).toBe(true);
    expect(state.goalsAchieved.has('population500')).toBe(false);
  });

  it('cleanDay needs a full day without deficit or imports', () => {
    const state = createSimState(1, SIZE);
    for (let i = 0; i < 5; i++) {
      state.layers.zone[at(i, 1)] = Zone.Residential;
      state.layers.density[at(i, 1)] = 3;
    }
    for (let t = 0; t < TICKS_PER_DAY - 1; t++) goalsStep(state);
    expect(state.goalsAchieved.has('cleanDay')).toBe(false);
    goalsStep(state);
    expect(state.goalsAchieved.has('cleanDay')).toBe(true);
  });

  it('an import tick resets the clean-day streak', () => {
    const state = createSimState(1, SIZE);
    for (let i = 0; i < 5; i++) {
      state.layers.zone[at(i, 1)] = Zone.Residential;
      state.layers.density[at(i, 1)] = 3;
    }
    for (let t = 0; t < TICKS_PER_DAY / 2; t++) goalsStep(state);
    state.lastEnergy.gridImport = 5;
    goalsStep(state);
    expect(state.goalProgress.cleanDayTicks).toBe(0);
  });

  it('exporter accumulates exported energy', () => {
    const state = createSimState(1, SIZE);
    state.lastEnergy.gridExport = 10_000;
    goalsStep(state);
    expect(state.goalsAchieved.has('exporter')).toBe(false);
    goalsStep(state);
    expect(state.goalsAchieved.has('exporter')).toBe(true);
  });

  it('achieved goals survive a save/load round trip', () => {
    const state = createSimState(1, SIZE);
    placePlant(state, at(3, 3), PlantType.WindTurbine);
    goalsStep(state);
    const restored = deserializeState(serializeState(state));
    expect(restored.goalsAchieved.has('firstPower')).toBe(true);
  });

  it('hydroPower is achieved by the first run-of-river plant', () => {
    const state = createSimState(1, 16);
    goalsStep(state);
    expect(state.goalsAchieved.has('hydroPower')).toBe(false);
    state.layers.terrain[tileIndex(3, 3, 16)] = Terrain.River;
    placePlant(state, tileIndex(3, 3, 16), PlantType.RunOfRiver);
    goalsStep(state);
    expect(state.goalsAchieved.has('hydroPower')).toBe(true);
  });

  it('tidalPower is achieved by the first tidal plant', () => {
    const state = generatedState(1, 64);
    state.money = 1_000_000;
    goalsStep(state);
    expect(state.goalsAchieved.has('tidalPower')).toBe(false);

    let placed = false;
    for (let i = 0; i < state.layers.terrain.length; i++) {
      if (isCoastalSea(state, i)) {
        placePlant(state, i, PlantType.TidalPlant);
        placed = true;
        break;
      }
    }
    expect(placed).toBe(true);
    goalsStep(state);
    expect(state.goalsAchieved.has('tidalPower')).toBe(true);
  });

  it('gridBuilder is achieved by the first power line', () => {
    const state = createSimState(1, SIZE);
    goalsStep(state);
    expect(state.goalsAchieved.has('gridBuilder')).toBe(false);
    buildPowerLines(state, [at(3, 3)]);
    goalsStep(state);
    expect(state.goalsAchieved.has('gridBuilder')).toBe(true);
  });

  function winterCity() {
    const state = createSimState(1, SIZE);
    for (let i = 0; i < 5; i++) {
      state.layers.zone[at(i, 1)] = Zone.Residential;
      state.layers.density[at(i, 1)] = 3;
    }
    state.season = { ...state.season, season: 'winter' };
    return state;
  }

  it('winterResilience needs a full winter without a deficit tick', () => {
    const state = winterCity();
    const winterTicks = BALANCE.seasons.daysPerSeason * TICKS_PER_DAY;
    for (let t = 0; t < winterTicks - 1; t++) goalsStep(state);
    expect(state.goalsAchieved.has('winterResilience')).toBe(false);
    goalsStep(state);
    expect(state.goalsAchieved.has('winterResilience')).toBe(true);
  });

  it('a deficit tick resets the winter streak', () => {
    const state = winterCity();
    for (let t = 0; t < 100; t++) goalsStep(state);
    expect(state.goalProgress.winterTicks).toBe(100);
    state.lastEnergy.deficit = 1;
    goalsStep(state);
    expect(state.goalProgress.winterTicks).toBe(0);
  });

  it('ticks outside winter do not count and reset the streak', () => {
    const state = winterCity();
    for (let t = 0; t < 100; t++) goalsStep(state);
    state.season = { ...state.season, season: 'spring' };
    goalsStep(state);
    expect(state.goalProgress.winterTicks).toBe(0);
  });

  function summerCity() {
    const state = createSimState(1, SIZE);
    for (let i = 0; i < 5; i++) {
      state.layers.zone[at(i, 1)] = Zone.Residential;
      state.layers.density[at(i, 1)] = 3;
    }
    state.season = { ...state.season, season: 'summer' };
    return state;
  }

  it('summerResilience needs a full summer without a deficit tick', () => {
    const state = summerCity();
    const summerTicks = BALANCE.seasons.daysPerSeason * TICKS_PER_DAY;
    for (let t = 0; t < summerTicks - 1; t++) goalsStep(state);
    expect(state.goalsAchieved.has('summerResilience')).toBe(false);
    goalsStep(state);
    expect(state.goalsAchieved.has('summerResilience')).toBe(true);
  });

  it('a deficit tick resets the summer streak', () => {
    const state = summerCity();
    for (let t = 0; t < 100; t++) goalsStep(state);
    expect(state.goalProgress.summerTicks).toBe(100);
    state.lastEnergy.deficit = 1;
    goalsStep(state);
    expect(state.goalProgress.summerTicks).toBe(0);
  });

  it('ticks outside summer do not count and reset the streak', () => {
    const state = summerCity();
    for (let t = 0; t < 100; t++) goalsStep(state);
    state.season = { ...state.season, season: 'autumn' };
    goalsStep(state);
    expect(state.goalProgress.summerTicks).toBe(0);
  });

  it('safeCity needs population and both coverages', () => {
    const state = createSimState(1, SIZE);
    for (let i = 0; i < 5; i++) {
      state.layers.zone[at(i, 1)] = Zone.Residential;
      state.layers.density[at(i, 1)] = 3; // 130 residents
    }
    const { goalCoverage } = BALANCE.services;
    state.lastServices = { fire: goalCoverage, police: goalCoverage - 0.01 };
    goalsStep(state);
    expect(state.goalsAchieved.has('safeCity')).toBe(false);
    state.lastServices = { fire: goalCoverage, police: goalCoverage };
    goalsStep(state);
    expect(state.goalsAchieved.has('safeCity')).toBe(true);
  });

  it('safeCity ignores empty coverage in a small city', () => {
    const state = createSimState(1, SIZE);
    state.lastServices = { fire: 1, police: 1 };
    goalsStep(state);
    expect(state.goalsAchieved.has('safeCity')).toBe(false);
  });

  function bigCity() {
    const state = createSimState(1, SIZE);
    const homes = Math.ceil(
      BALANCE.traffic.goalMinPopulation / BALANCE.growth.populationByDensity[3],
    );
    for (let i = 0; i < homes; i++) {
      state.layers.zone[at(i % SIZE, 1 + Math.floor(i / SIZE))] = Zone.Residential;
      state.layers.density[at(i % SIZE, 1 + Math.floor(i / SIZE))] = 3;
    }
    return state;
  }

  it('freeFlow needs a whole day of flowing commutes in a big city', () => {
    const state = bigCity();
    state.commuteCongestion = BALANCE.traffic.flowing - 0.01;
    for (let t = 0; t < TICKS_PER_DAY - 1; t++) goalsStep(state);
    expect(state.goalsAchieved.has('freeFlow')).toBe(false);
    goalsStep(state);
    expect(state.goalsAchieved.has('freeFlow')).toBe(true);
  });

  it('a slow tick resets the free-flow streak; small cities never count', () => {
    const state = bigCity();
    state.commuteCongestion = 1;
    for (let t = 0; t < 100; t++) goalsStep(state);
    expect(state.goalProgress.freeFlowTicks).toBe(100);
    state.commuteCongestion = BALANCE.traffic.flowing + 0.01;
    goalsStep(state);
    expect(state.goalProgress.freeFlowTicks).toBe(0);
    const small = createSimState(1, SIZE);
    small.commuteCongestion = 1;
    goalsStep(small);
    expect(small.goalProgress.freeFlowTicks).toBe(0);
  });

  describe('wellStocked', () => {
    it('needs enough shops supplied for a whole day', () => {
      const state = bigCity();
      state.lastDeliveries = {
        suppliedShare: 1,
        shops: BALANCE.deliveries.goalMinShops,
        driving: 0,
        depots: 1,
        factories: 0,
        localShare: 1,
      };
      for (let t = 0; t < TICKS_PER_DAY - 1; t++) goalsStep(state);
      expect(state.goalsAchieved.has('wellStocked')).toBe(false);
      goalsStep(state);
      expect(state.goalsAchieved.has('wellStocked')).toBe(true);
    });

    it('too few shops or a bad share resets the streak', () => {
      const state = bigCity();
      state.lastDeliveries = {
        suppliedShare: 1,
        shops: BALANCE.deliveries.goalMinShops,
        driving: 0,
        depots: 1,
        factories: 0,
        localShare: 1,
      };
      for (let t = 0; t < 50; t++) goalsStep(state);
      expect(state.goalProgress.wellStockedTicks).toBe(50);
      state.lastDeliveries.suppliedShare = BALANCE.deliveries.goalSuppliedShare - 0.01;
      goalsStep(state);
      expect(state.goalProgress.wellStockedTicks).toBe(0);
      state.lastDeliveries = {
        suppliedShare: 1,
        shops: BALANCE.deliveries.goalMinShops - 1,
        driving: 0,
        depots: 1,
        factories: 0,
        localShare: 1,
      };
      goalsStep(state);
      expect(state.goalProgress.wellStockedTicks).toBe(0);
    });
  });

  describe('geothermalBaseload', () => {
    it('achieves the baseload goal after a day at share', () => {
      const state = createSimState(3, 16);
      state.lastEnergy.geothermal = 30;
      state.lastEnergy.solar = 70;
      for (let i = 0; i < TICKS_PER_DAY; i++) goalsStep(state);
      expect(state.goalsAchieved.has('geothermalBaseload')).toBe(true);
    });

    it('does not achieve it below the share', () => {
      const state = createSimState(3, 16);
      state.lastEnergy.geothermal = 5;
      state.lastEnergy.solar = 95;
      for (let i = 0; i < TICKS_PER_DAY * 2; i++) goalsStep(state);
      expect(state.goalsAchieved.has('geothermalBaseload')).toBe(false);
    });
  });

  describe('warmWinter', () => {
    function winterCity(): ReturnType<typeof createSimState> {
      const state = createSimState(3, 16);
      state.season = { ...state.season, season: 'winter' };
      state.lastEnergy.networkHeat = 60;
      state.lastEnergy.heatFallback = 0;
      state.lastEnergy.heatingConsumption = 40;
      return state;
    }

    it('achieves after a full winter day with the network carrying half the heat', () => {
      const state = winterCity();
      for (let i = 0; i < TICKS_PER_DAY - 1; i++) goalsStep(state);
      expect(state.goalsAchieved.has('warmWinter')).toBe(false);
      goalsStep(state);
      expect(state.goalsAchieved.has('warmWinter')).toBe(true);
    });

    it('a fallback tick, a low share, another season or no demand resets the streak', () => {
      const state = winterCity();
      for (let i = 0; i < 10; i++) goalsStep(state);
      expect(state.goalProgress.warmWinterTicks).toBe(10);
      state.lastEnergy.heatFallback = 1;
      goalsStep(state);
      expect(state.goalProgress.warmWinterTicks).toBe(0);

      state.lastEnergy.heatFallback = 0;
      state.lastEnergy.heatingConsumption = 100; // network share 60/160 < 0.5
      goalsStep(state);
      expect(state.goalProgress.warmWinterTicks).toBe(0);

      state.lastEnergy.heatingConsumption = 40;
      state.season = { ...state.season, season: 'summer' };
      goalsStep(state);
      expect(state.goalProgress.warmWinterTicks).toBe(0);

      state.season = { ...state.season, season: 'winter' };
      state.lastEnergy.networkHeat = 0;
      state.lastEnergy.heatingConsumption = 0; // no demand at all
      goalsStep(state);
      expect(state.goalProgress.warmWinterTicks).toBe(0);
    });
  });

  describe('modalShift', () => {
    it('needs a big city and a whole day of riders', () => {
      const state = bigCity();
      state.lastTransit = {
        riderShare: BALANCE.transit.goalRiderShare,
        riders: 30,
        driving: 1,
        stops: 8,
        stopsServed: 8,
        depots: 1,
      };
      for (let t = 0; t < TICKS_PER_DAY - 1; t++) goalsStep(state);
      expect(state.goalsAchieved.has('modalShift')).toBe(false);
      goalsStep(state);
      expect(state.goalsAchieved.has('modalShift')).toBe(true);
    });

    it('a low share or a small city resets the streak', () => {
      const state = bigCity();
      state.lastTransit = {
        riderShare: 0.5,
        riders: 30,
        driving: 1,
        stops: 8,
        stopsServed: 8,
        depots: 1,
      };
      for (let t = 0; t < 50; t++) goalsStep(state);
      expect(state.goalProgress.transitTicks).toBe(50);
      state.lastTransit.riderShare = BALANCE.transit.goalRiderShare - 0.01;
      goalsStep(state);
      expect(state.goalProgress.transitTicks).toBe(0);
      state.lastTransit.riderShare = 0.5;
      const small = createSimState(1, SIZE);
      small.lastTransit = { ...state.lastTransit };
      goalsStep(small);
      expect(small.goalProgress.transitTicks).toBe(0);
    });
  });

  describe('the stormProof goal', () => {
    it('is omitted from goalStates when disasters are off', () => {
      const state = createSimState(1, SIZE);
      state.disasterScale = 0;
      expect(goalStates(state).some((g) => g.id === 'stormProof')).toBe(false);
    });

    it('is included in goalStates at normal intensity', () => {
      const state = createSimState(1, SIZE);
      state.disasterScale = 1;
      expect(goalStates(state).some((g) => g.id === 'stormProof')).toBe(true);
    });

    it('unlocks after riding out a whole storm without a deficit', () => {
      const state = createSimState(1, 32);
      state.disasters.active.push({
        id: 1,
        kind: DisasterKind.Storm,
        severity: 1,
        startTick: 0,
        endTick: 10,
        origin: 0,
        tiles: [],
        intensity: [],
      });
      state.lastEnergy.deficit = 0;
      for (let i = 0; i < 10; i++) {
        state.tick++;
        goalsStep(state);
      }
      state.disasters.active = [];
      goalsStep(state);
      expect(state.goalsAchieved.has('stormProof')).toBe(true);
    });

    it('does not unlock when the storm caused a deficit', () => {
      const state = createSimState(1, 32);
      state.disasters.active.push({
        id: 1,
        kind: DisasterKind.Storm,
        severity: 1,
        startTick: 0,
        endTick: 10,
        origin: 0,
        tiles: [],
        intensity: [],
      });
      for (let i = 0; i < 10; i++) {
        state.tick++;
        state.lastEnergy.deficit = i === 5 ? 12 : 0;
        goalsStep(state);
      }
      state.disasters.active = [];
      goalsStep(state);
      expect(state.goalsAchieved.has('stormProof')).toBe(false);
    });
  });
});

describe('flexibleCity', () => {
  function flexCity(): SimState {
    const state = createSimState(4, 16);
    for (let i = 0; i < 20; i++) {
      state.layers.zone[at(i % 16, 2 + Math.floor(i / 16))] = Zone.Residential;
      state.layers.density[at(i % 16, 2 + Math.floor(i / 16))] = 3; // population >= 50
    }
    state.smartMeters.metered = 20;
    // The coverage denominator is a per-tick cache; this city never
    // ticked, so refresh it the way stepTick does.
    refreshBuildingCount(state);
    state.lastEnergy.flexDeferred = 1;
    return state;
  }

  it('achieves after half a day of metered, shifting ticks', () => {
    const state = flexCity();
    for (let i = 0; i < TICKS_PER_DAY / 2 - 1; i++) goalsStep(state);
    expect(state.goalsAchieved.has('flexibleCity')).toBe(false);
    goalsStep(state);
    expect(state.goalsAchieved.has('flexibleCity')).toBe(true);
  });

  it('needs coverage and actual shifting', () => {
    const low = flexCity();
    low.smartMeters.metered = 10; // 50 % < goalCoverage
    for (let i = 0; i < TICKS_PER_DAY; i++) goalsStep(low);
    expect(low.goalsAchieved.has('flexibleCity')).toBe(false);
    const idle = flexCity();
    idle.lastEnergy.flexDeferred = 0;
    idle.lastEnergy.flexRecovered = 0;
    for (let i = 0; i < TICKS_PER_DAY; i++) goalsStep(idle);
    expect(idle.goalsAchieved.has('flexibleCity')).toBe(false);
  });

  it('round-trips its progress', () => {
    const state = flexCity();
    for (let i = 0; i < 7; i++) goalsStep(state);
    const restored = deserializeState(serializeState(state));
    expect(restored.goalProgress.flexTicks).toBe(7);
  });
});

describe('loadManager', () => {
  it('achieves once the cumulative shed reaches the target', () => {
    const state = createSimState(4, 16);
    const target = BALANCE.demandResponse.goalShedEnergy;
    state.lastEnergy.shed = target / 4;
    for (let i = 0; i < 3; i++) goalsStep(state);
    expect(state.goalProgress.shedTotal).toBeCloseTo((3 * target) / 4, 9);
    expect(state.goalsAchieved.has('loadManager')).toBe(false);
    goalsStep(state);
    expect(state.goalsAchieved.has('loadManager')).toBe(true);
  });

  it('does not progress without shedding', () => {
    const state = createSimState(4, 16);
    for (let i = 0; i < 100; i++) goalsStep(state);
    expect(state.goalProgress.shedTotal).toBe(0);
    expect(state.goalsAchieved.has('loadManager')).toBe(false);
  });

  it('round-trips its progress', () => {
    const state = createSimState(4, 16);
    state.lastEnergy.shed = 5;
    for (let i = 0; i < 7; i++) goalsStep(state);
    const restored = deserializeState(serializeState(state));
    expect(restored.goalProgress.shedTotal).toBeCloseTo(35, 9);
  });
});
