import { describe, expect, it } from 'vitest';
import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { PlantType, Zone } from '../shared/types.ts';
import { happinessStep } from './happiness.ts';
import {
  batteryDrainPerTile,
  carSpeedTilesPerSecond,
  homeChargingAllowed,
  householdFlexShare,
  policiesStep,
  policyDailyCost,
  policyHappiness,
  rooftopPeakAt,
  smartMeterCityCost,
  smartMeterInstallsPerDay,
  type PolicyId,
} from './policies.ts';
import { refreshBuildingCount, setSmartMeterRollout, smartMetersStep } from './smartMeters.ts';
import { ticksAtHour } from './vehicles.ts';
import { growthStep, computeDemand } from './growth.ts';
import { buildRoads, bulldozeTiles, undoLastAction } from './roads.ts';
import { createSimState, deserializeState, serializeState, type SimState } from './state.ts';
import { SimEngine } from './engine.ts';
import { buildStats } from './tick.ts';
import { paintZones } from './zones.ts';

const SIZE = 16;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);

describe('policies registry', () => {
  it('a new state has every policy off and no cost', () => {
    const state = createSimState(1, SIZE);
    expect(Object.values(state.policies).every((v) => v === false)).toBe(true);
    expect(policyDailyCost(state)).toBe(0);
    expect(policyHappiness(state)).toBe(0);
  });

  it('books the daily cost per tick into the budget line', () => {
    const state = createSimState(1, SIZE);
    state.policies.speedLimit = true;
    state.policies.nightTariff = true;
    const money = state.money;
    policiesStep(state);
    const perTick =
      (BALANCE.policies.speedLimit.dailyCost + BALANCE.policies.nightTariff.dailyCost) /
      TICKS_PER_DAY;
    expect(state.money).toBeCloseTo(money - perTick, 9);
    expect(state.lastPolicyCost).toBeCloseTo(perTick, 9);
    expect(buildStats(state).budget.policies).toBeCloseTo(perTick, 9);
  });

  it('sums the happiness terms; the mandate term vanishes at full coverage', () => {
    const state = createSimState(1, SIZE);
    state.policies.speedLimit = true;
    state.policies.nightTariff = true;
    expect(policyHappiness(state)).toBeCloseTo(
      BALANCE.policies.speedLimit.happiness + BALANCE.policies.nightTariff.happiness,
    );
    state.policies.smartMeterMandate = true;
    // No buildings: coverage counts as complete, so no penalty.
    expect(policyHappiness(state)).toBeCloseTo(
      BALANCE.policies.speedLimit.happiness + BALANCE.policies.nightTariff.happiness,
    );
    buildRoads(state, [at(2, 2), at(3, 2)]);
    paintZones(state, [at(2, 1)], Zone.Residential);
    state.layers.density[at(2, 1)] = 1;
    state.lastBuildingCount = 1;
    state.smartMeters.metered = 0;
    state.smartMeters.active = true;
    expect(policyHappiness(state)).toBeCloseTo(
      BALANCE.policies.speedLimit.happiness +
        BALANCE.policies.nightTariff.happiness +
        BALANCE.policies.smartMeterMandate.happiness,
    );
  });

  it('the mandate weighs only while the rollout runs below full coverage', () => {
    const state = createSimState(1, SIZE);
    state.policies.smartMeterMandate = true;
    state.lastBuildingCount = 4;
    state.smartMeters.metered = 1;
    state.smartMeters.active = false;
    // Paused rollout: no meters are forced on anyone, so no unrest...
    expect(policyHappiness(state)).toBe(0);
    // ...but the ordinance's standing cost is still charged.
    expect(policyDailyCost(state)).toBe(BALANCE.policies.smartMeterMandate.dailyCost);
    state.smartMeters.active = true;
    expect(policyHappiness(state)).toBeCloseTo(BALANCE.policies.smartMeterMandate.happiness);
  });

  it('two engines with the same seed and ordinance script stay identical', () => {
    const size = 24;
    const idx = (x: number, y: number) => tileIndex(x, y, size);
    const run = (): string => {
      const engine = new SimEngine(5, size);
      engine.applyCommand({ type: 'init', seed: 5, size });
      engine.state.money = 1e9;
      engine.state.layers.elevation.fill(0);
      const road = Array.from({ length: 16 }, (_, i) => idx(i + 4, 12));
      engine.applyCommand({ type: 'buildRoad', tiles: road });
      engine.applyCommand({ type: 'placePlant', tile: idx(4, 11), plant: PlantType.WindTurbine });
      engine.applyCommand({
        type: 'paintZone',
        tiles: road.flatMap((tile) => [tile - size, tile + size]).slice(2),
        zone: Zone.Residential,
      });
      engine.applyCommand({ type: 'setSmartMeterRollout', active: true });
      const script: Record<number, [PolicyId, boolean][]> = {
        0: [
          ['rooftopPvMandate', true],
          ['speedLimit', true],
        ],
        60: [['nightTariff', true]],
        120: [['smartMeterMandate', true]],
        240: [['speedLimit', false]],
        360: [['rooftopPvMandate', false]],
      };
      for (let t = 0; t < TICKS_PER_DAY / 2; t++) {
        for (const [id, active] of script[t] ?? []) {
          engine.applyCommand({ type: 'setPolicy', id, active });
        }
        engine.tick();
      }
      // The script must have grown a town, or the comparison proves little.
      expect(engine.state.lastBuildingCount).toBeGreaterThan(0);
      return JSON.stringify(serializeState(engine.state));
    };
    expect(run()).toBe(run());
  });

  it('happinessStep moves the target by the policy term', () => {
    const run = (speedLimit: boolean): number => {
      const state = createSimState(1, SIZE);
      state.policies.speedLimit = speedLimit;
      for (let i = 0; i < 200; i++) happinessStep(state, 0);
      return state.happiness;
    };
    expect(run(true)).toBeLessThan(run(false));
  });

  it('survives a save round trip and defaults when absent or unknown', () => {
    const state = createSimState(1, SIZE);
    state.policies.nightTariff = true;
    const save = serializeState(state);
    expect(deserializeState(save).policies.nightTariff).toBe(true);
    expect(deserializeState(save).policies.speedLimit).toBe(false);
    delete save.policies;
    expect(Object.values(deserializeState(save).policies).every((v) => v === false)).toBe(true);
    (save as { policies?: Record<string, boolean> }).policies = { bogus: true, speedLimit: true };
    const loaded = deserializeState(save);
    expect(loaded.policies.speedLimit).toBe(true);
    expect('bogus' in loaded.policies).toBe(false);
  });
});

describe('rooftop-PV mandate', () => {
  /** A zoned, road-adjacent tile that growth will fill; demand forced high. */
  function readyState(): { state: SimState; tile: number } {
    const state = createSimState(3, SIZE);
    state.happiness = 1;
    buildRoads(state, [at(2, 5), at(3, 5), at(4, 5)]);
    paintZones(state, [at(3, 4)], Zone.Residential);
    return { state, tile: at(3, 4) };
  }
  function growUntil(state: SimState, tile: number): void {
    for (let i = 0; i < 2000 && state.layers.density[tile] === 0; i++) {
      growthStep(state, { ...computeDemand(state), residential: 1 });
    }
    expect(state.layers.density[tile]).toBe(1);
  }

  it('a building that spawns under the mandate gets the bit, PV and a subsidy', () => {
    const { state, tile } = readyState();
    state.policies.rooftopPvMandate = true;
    growUntil(state, tile);
    expect(state.layers.pvMandated[tile]).toBe(1);
    expect(rooftopPeakAt(state, tile)).toBe(BALANCE.policies.rooftopPvMandate.mandatePeakDensity1);
    expect(state.lastPolicySubsidy).toBe(BALANCE.policies.rooftopPvMandate.subsidyPerBuilding);
    policiesStep(state);
    expect(state.lastPolicySubsidy).toBe(0);
  });

  it('a building that spawned without the mandate has no PV at density 1 and is not retro-fitted', () => {
    const { state, tile } = readyState();
    growUntil(state, tile);
    expect(state.layers.pvMandated[tile]).toBe(0);
    expect(rooftopPeakAt(state, tile)).toBe(BALANCE.energy.rooftopSolarPeakByDensity[1]);
    state.policies.rooftopPvMandate = true;
    expect(rooftopPeakAt(state, tile)).toBe(BALANCE.energy.rooftopSolarPeakByDensity[1]);
  });

  it('keeps the panels when the mandate is switched off, and the density table wins from density 2', () => {
    const { state, tile } = readyState();
    state.policies.rooftopPvMandate = true;
    growUntil(state, tile);
    state.policies.rooftopPvMandate = false;
    expect(rooftopPeakAt(state, tile)).toBe(BALANCE.policies.rooftopPvMandate.mandatePeakDensity1);
    state.layers.density[tile] = 2;
    expect(rooftopPeakAt(state, tile)).toBe(BALANCE.energy.rooftopSolarPeakByDensity[2]);
  });

  it('bulldozing clears the bit', () => {
    const { state, tile } = readyState();
    state.policies.rooftopPvMandate = true;
    growUntil(state, tile);
    state.money = 1_000_000;
    bulldozeTiles(state, [tile]);
    expect(state.layers.pvMandated[tile]).toBe(0);
  });

  it('an undone bulldoze keeps the mandated rooftop panels', () => {
    const { state, tile } = readyState();
    state.policies.rooftopPvMandate = true;
    growUntil(state, tile);
    state.money = 1_000_000;
    bulldozeTiles(state, [tile]);
    undoLastAction(state);
    expect(state.layers.pvMandated[tile]).toBe(1);
    expect(rooftopPeakAt(state, tile)).toBe(BALANCE.policies.rooftopPvMandate.mandatePeakDensity1);
  });

  it('the bit survives a save round trip and is absent in old saves', () => {
    const { state, tile } = readyState();
    state.policies.rooftopPvMandate = true;
    growUntil(state, tile);
    const save = serializeState(state);
    expect(deserializeState(save).layers.pvMandated[tile]).toBe(1);
    delete save.layers.pvMandated;
    expect(deserializeState(save).layers.pvMandated[tile]).toBe(0);
  });
});

describe('night tariff', () => {
  it('without the tariff a non-smart car may charge at home any time', () => {
    const state = createSimState(1, SIZE);
    expect(homeChargingAllowed(state, false, 0.9, ticksAtHour(12))).toBe(true);
  });

  it('with the tariff a non-smart car charges at night, or any time below the floor', () => {
    const state = createSimState(1, SIZE);
    state.policies.nightTariff = true;
    expect(homeChargingAllowed(state, false, 0.9, ticksAtHour(12))).toBe(false);
    expect(homeChargingAllowed(state, false, 0.9, ticksAtHour(23))).toBe(true);
    expect(homeChargingAllowed(state, false, 0.9, ticksAtHour(3))).toBe(true);
    expect(homeChargingAllowed(state, false, 0.9, ticksAtHour(6))).toBe(false);
    const floor = BALANCE.vehicles.smartChargeFloor;
    expect(homeChargingAllowed(state, false, floor - 0.01, ticksAtHour(12))).toBe(true);
  });

  it('leaves smart cars to the surplus gate', () => {
    const state = createSimState(1, SIZE);
    state.policies.nightTariff = true;
    expect(homeChargingAllowed(state, true, 0.9, ticksAtHour(12))).toBe(true);
  });

  it('raises the household flex share', () => {
    const state = createSimState(1, SIZE);
    expect(householdFlexShare(state)).toBe(BALANCE.smartMeters.householdFlexShare);
    state.policies.nightTariff = true;
    expect(householdFlexShare(state)).toBeCloseTo(
      BALANCE.smartMeters.householdFlexShare * BALANCE.policies.nightTariff.flexShareFactor,
    );
  });
});

describe('speed limit', () => {
  it('scales car speed and battery drain only while active', () => {
    const state = createSimState(1, SIZE);
    expect(carSpeedTilesPerSecond(state)).toBe(BALANCE.vehicles.speedTilesPerSecond);
    expect(batteryDrainPerTile(state)).toBe(BALANCE.vehicles.batteryDrainPerTile);
    state.policies.speedLimit = true;
    expect(carSpeedTilesPerSecond(state)).toBeCloseTo(
      BALANCE.vehicles.speedTilesPerSecond * BALANCE.policies.speedLimit.speedFactor,
    );
    expect(batteryDrainPerTile(state)).toBeCloseTo(
      BALANCE.vehicles.batteryDrainPerTile * BALANCE.policies.speedLimit.drainFactor,
    );
  });
});

describe('smart-meter mandate', () => {
  it('doubles the install pace and halves the city share', () => {
    const state = createSimState(1, SIZE);
    expect(smartMeterInstallsPerDay(state)).toBe(BALANCE.smartMeters.installsPerDay);
    expect(smartMeterCityCost(state)).toBe(BALANCE.smartMeters.costPerMeter);
    state.policies.smartMeterMandate = true;
    expect(smartMeterInstallsPerDay(state)).toBe(
      BALANCE.smartMeters.installsPerDay * BALANCE.policies.smartMeterMandate.installFactor,
    );
    expect(smartMeterCityCost(state)).toBeCloseTo(
      BALANCE.smartMeters.costPerMeter * BALANCE.policies.smartMeterMandate.cityCostShare,
    );
  });

  it('a day of rollout installs installFactor times more meters at cityCostShare each', () => {
    const size = 32;
    const idx = (x: number, y: number) => tileIndex(x, y, size);
    const run = (mandate: boolean): { metered: number; spent: number } => {
      const state = createSimState(2, size);
      const road = [];
      const homes = [];
      for (let x = 2; x <= 26; x++) {
        road.push(idx(x, 8));
        homes.push(idx(x, 7), idx(x, 9));
      }
      buildRoads(state, road);
      paintZones(state, homes, Zone.Residential);
      for (const h of homes) state.layers.density[h] = 1;
      refreshBuildingCount(state);
      state.policies.smartMeterMandate = mandate;
      setSmartMeterRollout(state, true);
      state.money = 1_000_000;
      let spent = 0;
      for (let i = 0; i < TICKS_PER_DAY; i++) spent += smartMetersStep(state);
      return { metered: state.smartMeters.metered, spent };
    };
    const plain = run(false);
    const forced = run(true);
    expect(plain.metered).toBeGreaterThan(0);
    expect(forced.metered).toBeLessThan(50);
    expect(forced.metered).toBe(plain.metered * BALANCE.policies.smartMeterMandate.installFactor);
    expect(forced.spent / forced.metered).toBeCloseTo(
      BALANCE.smartMeters.costPerMeter * BALANCE.policies.smartMeterMandate.cityCostShare,
    );
  });
});
