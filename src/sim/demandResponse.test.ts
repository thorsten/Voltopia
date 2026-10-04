import { describe, expect, it } from 'vitest';
import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import { callBudgetTicks, setDemandResponse } from './demandResponse.ts';
import { createSimState, deserializeState, serializeState } from './state.ts';

const SIZE = 16;

describe('demand-response contract state', () => {
  it('starts off with a full call budget', () => {
    const state = createSimState(1, SIZE);
    expect(state.demandResponse).toEqual({ active: false, callBudget: callBudgetTicks() });
    expect(state.lastDemandResponseCost).toBe(0);
    expect(state.goalProgress.shedTotal).toBe(0);
  });

  it('callBudgetTicks is maxCallHoursPerDay in ticks', () => {
    expect(callBudgetTicks()).toBeCloseTo(
      (BALANCE.demandResponse.maxCallHoursPerDay * TICKS_PER_DAY) / 24,
      9,
    );
  });

  it('setDemandResponse flips the contract and marks the stats dirty', () => {
    const state = createSimState(1, SIZE);
    state.statsDirty = false;
    setDemandResponse(state, true);
    expect(state.demandResponse.active).toBe(true);
    expect(state.statsDirty).toBe(true);
    setDemandResponse(state, false);
    expect(state.demandResponse.active).toBe(false);
  });

  it('round-trips the contract, the call budget and the shed total', () => {
    const state = createSimState(1, SIZE);
    state.demandResponse = { active: true, callBudget: 12.5 };
    state.goalProgress.shedTotal = 321;
    const restored = deserializeState(serializeState(state));
    expect(restored.demandResponse).toEqual({ active: true, callBudget: 12.5 });
    expect(restored.goalProgress.shedTotal).toBe(321);
  });

  it('loads an old save with the contract off and a full budget', () => {
    const state = createSimState(1, SIZE);
    const save = serializeState(state);
    delete save.demandResponse;
    delete save.shedTotal;
    const restored = deserializeState(save);
    expect(restored.demandResponse).toEqual({ active: false, callBudget: callBudgetTicks() });
    expect(restored.goalProgress.shedTotal).toBe(0);
  });

  it('clamps a hand-edited call budget into the daily allowance', () => {
    const state = createSimState(1, SIZE);
    const save = serializeState(state);
    save.demandResponse = { active: true, callBudget: 1e9 };
    expect(deserializeState(save).demandResponse.callBudget).toBe(callBudgetTicks());
    save.demandResponse = { active: true, callBudget: Number.NaN };
    expect(deserializeState(save).demandResponse.callBudget).toBe(callBudgetTicks());
  });
});
