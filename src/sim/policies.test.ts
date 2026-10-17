import { describe, expect, it } from 'vitest';
import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { Zone } from '../shared/types.ts';
import { happinessStep } from './happiness.ts';
import { policiesStep, policyDailyCost, policyHappiness } from './policies.ts';
import { buildRoads } from './roads.ts';
import { createSimState, deserializeState, serializeState } from './state.ts';
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
