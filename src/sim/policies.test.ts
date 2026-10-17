import { describe, expect, it } from 'vitest';
import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { Zone } from '../shared/types.ts';
import { happinessStep } from './happiness.ts';
import { policiesStep, policyDailyCost, policyHappiness, rooftopPeakAt } from './policies.ts';
import { growthStep, computeDemand } from './growth.ts';
import { bulldozeTiles, undoLastAction } from './roads.ts';
import { buildRoads } from './roads.ts';
import { createSimState, deserializeState, serializeState, type SimState } from './state.ts';
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
    expect(policyHappiness(state)).toBeCloseTo(
      BALANCE.policies.speedLimit.happiness +
        BALANCE.policies.nightTariff.happiness +
        BALANCE.policies.smartMeterMandate.happiness,
    );
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
