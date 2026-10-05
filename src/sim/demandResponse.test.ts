import { describe, expect, it } from 'vitest';
import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import {
  callBudgetTicks,
  demandResponseStep,
  dispatchDemandResponse,
  setDemandResponse,
} from './demandResponse.ts';
import { createSimState, deserializeState, serializeState } from './state.ts';
import { buildStats, stepTick } from './tick.ts';

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

describe('dispatchDemandResponse', () => {
  const { shedShare, activationPricePerEnergyUnit } = BALANCE.demandResponse;
  const { importCapacity, importCostPerEnergyUnit } = BALANCE.market;
  /** Spot factor at which importing costs exactly the activation premium. */
  const breakEven = activationPricePerEnergyUnit / importCostPerEnergyUnit;

  function contracted(): ReturnType<typeof createSimState> {
    const state = createSimState(1, SIZE);
    state.demandResponse.active = true;
    state.tick = 1; // not a day boundary
    return state;
  }

  it('sheds nothing with the contract off', () => {
    const state = createSimState(1, SIZE);
    const call = dispatchDemandResponse(state, 100, 50, breakEven + 1);
    expect(call).toEqual({ pool: 0, shed: 0 });
    expect(state.demandResponse.callBudget).toBe(callBudgetTicks());
  });

  it('the pool is shedShare of the business base load', () => {
    const state = contracted();
    expect(dispatchDemandResponse(state, 100, 0, 1).pool).toBeCloseTo(shedShare * 100, 9);
  });

  it('sheds up to the pool when importing is dearer than a call', () => {
    const state = contracted();
    const call = dispatchDemandResponse(state, 100, 30, breakEven);
    expect(call.shed).toBeCloseTo(30, 9);
    const big = dispatchDemandResponse(contracted(), 100, 1000, breakEven);
    expect(big.shed).toBeCloseTo(shedShare * 100, 9);
  });

  it('sheds nothing at abundance prices while the link can carry the shortfall', () => {
    const state = contracted();
    const call = dispatchDemandResponse(state, 100, importCapacity, breakEven - 0.01);
    expect(call.shed).toBe(0);
    expect(state.demandResponse.callBudget).toBe(callBudgetTicks());
  });

  it('sheds only the excess over the link at abundance prices', () => {
    const state = contracted();
    const call = dispatchDemandResponse(state, 100, importCapacity + 10, breakEven - 0.01);
    expect(call.shed).toBeCloseTo(10, 9);
  });

  it('spends the call budget in proportion to the pool used', () => {
    const state = contracted();
    dispatchDemandResponse(state, 100, shedShare * 100, breakEven); // a full-pool tick
    expect(state.demandResponse.callBudget).toBeCloseTo(callBudgetTicks() - 1, 9);
    dispatchDemandResponse(state, 100, shedShare * 50, breakEven); // half the pool
    expect(state.demandResponse.callBudget).toBeCloseTo(callBudgetTicks() - 1.5, 9);
  });

  it('runs the budget down to a partial last call and then nothing', () => {
    const state = contracted();
    state.demandResponse.callBudget = 0.25;
    const partial = dispatchDemandResponse(state, 100, 1000, breakEven);
    expect(partial.shed).toBeCloseTo(0.25 * shedShare * 100, 9);
    expect(state.demandResponse.callBudget).toBeCloseTo(0, 9);
    expect(dispatchDemandResponse(state, 100, 1000, breakEven).shed).toBe(0);
  });

  it('refills the budget at the start of a day', () => {
    const state = contracted();
    state.demandResponse.callBudget = 0;
    state.tick = TICKS_PER_DAY;
    const call = dispatchDemandResponse(state, 100, 1000, breakEven);
    expect(call.shed).toBeCloseTo(shedShare * 100, 9);
    expect(state.demandResponse.callBudget).toBeCloseTo(callBudgetTicks() - 1, 9);
  });

  it('never sheds more than the shortfall', () => {
    const state = contracted();
    expect(dispatchDemandResponse(state, 100, 5, breakEven).shed).toBeCloseTo(5, 9);
  });

  it('adds industrialShedShare of the industrial load to the pool', () => {
    const { shedShare, industrialShedShare } = BALANCE.demandResponse;
    const pool = dispatchDemandResponse(contracted(), 100, 0, 1, 50).pool;
    expect(pool).toBeCloseTo(shedShare * 100 + industrialShedShare * 50, 9);
  });

  it('the industrial pool is available on a dark night when the offices are idle', () => {
    const { industrialShedShare } = BALANCE.demandResponse;
    const call = dispatchDemandResponse(contracted(), 0, 40, breakEven + 1, 50);
    expect(call.pool).toBeCloseTo(industrialShedShare * 50, 9);
    expect(call.shed).toBeCloseTo(Math.min(40, industrialShedShare * 50), 9);
  });
});

describe('demandResponseStep', () => {
  const { retainerPerBuildingPerDay, activationPricePerEnergyUnit } = BALANCE.demandResponse;

  it('bills nothing with the contract off', () => {
    const state = createSimState(1, SIZE);
    state.lastEnergy.shed = 10;
    state.lastEnergy.contractedBuildings = 5;
    const before = state.money;
    expect(demandResponseStep(state)).toBe(0);
    expect(state.money).toBe(before);
    expect(state.lastDemandResponseCost).toBe(0);
  });

  it('bills the retainer per contracted building and day plus the activation premium', () => {
    const state = createSimState(1, SIZE);
    state.demandResponse.active = true;
    state.lastEnergy.contractedBuildings = 5;
    state.lastEnergy.shed = 10;
    const before = state.money;
    const spent = demandResponseStep(state);
    const retainer = (5 * retainerPerBuildingPerDay) / TICKS_PER_DAY;
    expect(spent).toBeCloseTo(retainer + 10 * activationPricePerEnergyUnit, 9);
    expect(state.money).toBeCloseTo(before - spent, 9);
    expect(state.lastDemandResponseCost).toBeCloseTo(spent, 9);
  });

  it('a day of retainer is exactly retainerPerBuildingPerDay per building', () => {
    const state = createSimState(1, SIZE);
    state.demandResponse.active = true;
    state.lastEnergy.contractedBuildings = 3;
    let total = 0;
    for (let t = 0; t < TICKS_PER_DAY; t++) total += demandResponseStep(state);
    expect(total).toBeCloseTo(3 * retainerPerBuildingPerDay, 6);
  });

  it('keeps billing when the treasury is empty (a contract, not a purchase)', () => {
    const state = createSimState(1, SIZE);
    state.demandResponse.active = true;
    state.lastEnergy.contractedBuildings = 1;
    state.money = 0;
    demandResponseStep(state);
    expect(state.money).toBeLessThan(0);
  });

  it('reaches the stats and the budget line', () => {
    const state = createSimState(1, SIZE);
    state.demandResponse.active = true;
    state.demandResponse.callBudget = callBudgetTicks() / 2;
    state.lastEnergy.contractedBuildings = 4;
    state.lastEnergy.shed = 2;
    state.lastEnergy.shedPool = 8;
    const spent = demandResponseStep(state);
    const stats = buildStats(state);
    expect(stats.demandResponse).toEqual({
      active: true,
      pool: 8,
      shed: 2,
      callHoursLeft: BALANCE.demandResponse.maxCallHoursPerDay / 2,
      contractedBuildings: 4,
      retainerPerBuildingPerDay,
      activationPrice: activationPricePerEnergyUnit,
    });
    expect(stats.energy.consumption.shed).toBe(2);
    expect(stats.budget.demandResponse).toBeCloseTo(spent, 9);
  });

  it('is billed every tick of a running city', () => {
    const state = createSimState(1, SIZE);
    state.demandResponse.active = true;
    stepTick(state);
    // No businesses yet: the retainer is zero, but the step ran.
    expect(state.lastDemandResponseCost).toBe(0);
    expect(buildStats(state).budget.demandResponse).toBe(0);
  });
});
