import { describe, expect, it } from 'vitest';
import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import {
  callBudgetTicks,
  demandResponseStep,
  dispatchCall,
  setDemandResponse,
} from './demandResponse.ts';
import { placePlant } from './energy.ts';
import { poolForIsland, syncIslandPools, type IslandPool } from './islandPools.ts';
import { recomputeGrid } from './powerGrid.ts';
import { createSimState, deserializeState, PlantType, serializeState } from './state.ts';
import { buildStats, stepTick } from './tick.ts';

const SIZE = 16;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);

/** A fresh island pool, its budget overridable for a given test. */
function pool(callBudget: number = callBudgetTicks()): IslandPool {
  return { flexBacklog: 0, callBudget };
}

describe('demand-response contract state', () => {
  it('starts off', () => {
    const state = createSimState(1, SIZE);
    expect(state.demandResponse).toEqual({ active: false });
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

  it('round-trips the contract and the shed total', () => {
    const state = createSimState(1, SIZE);
    state.demandResponse = { active: true };
    state.goalProgress.shedTotal = 321;
    const restored = deserializeState(serializeState(state));
    expect(restored.demandResponse).toEqual({ active: true });
    expect(restored.goalProgress.shedTotal).toBe(321);
  });

  it('loads an old save with the contract off', () => {
    const state = createSimState(1, SIZE);
    const save = serializeState(state);
    delete save.demandResponse;
    delete save.shedTotal;
    const restored = deserializeState(save);
    expect(restored.demandResponse).toEqual({ active: false });
    expect(restored.goalProgress.shedTotal).toBe(0);
  });
});

describe('dispatchCall', () => {
  const { shedShare, activationPricePerEnergyUnit } = BALANCE.demandResponse;
  const { importCapacity, importCostPerEnergyUnit } = BALANCE.market;
  /** Spot factor at which importing costs exactly the activation premium. */
  const breakEven = activationPricePerEnergyUnit / importCostPerEnergyUnit;

  it('sheds nothing with the contract off', () => {
    const p = pool();
    const call = dispatchCall(p, false, 100, 0, 50, breakEven + 1, importCapacity);
    expect(call).toEqual({ pool: 0, shed: 0 });
    expect(p.callBudget).toBe(callBudgetTicks());
  });

  it('the pool is shedShare of the business base load', () => {
    expect(dispatchCall(pool(), true, 100, 0, 0, 1, importCapacity).pool).toBeCloseTo(
      shedShare * 100,
      9,
    );
  });

  it('sheds up to the pool when importing is dearer than a call', () => {
    const call = dispatchCall(pool(), true, 100, 0, 30, breakEven, importCapacity);
    expect(call.shed).toBeCloseTo(30, 9);
    const big = dispatchCall(pool(), true, 100, 0, 1000, breakEven, importCapacity);
    expect(big.shed).toBeCloseTo(shedShare * 100, 9);
  });

  it('sheds nothing at abundance prices while the link can carry the shortfall', () => {
    const p = pool();
    const call = dispatchCall(p, true, 100, 0, importCapacity, breakEven - 0.01, importCapacity);
    expect(call.shed).toBe(0);
    expect(p.callBudget).toBe(callBudgetTicks());
  });

  it('sheds only the excess over the link at abundance prices', () => {
    const call = dispatchCall(
      pool(),
      true,
      100,
      0,
      importCapacity + 10,
      breakEven - 0.01,
      importCapacity,
    );
    expect(call.shed).toBeCloseTo(10, 9);
  });

  it('spends the call budget in proportion to the pool used', () => {
    const p = pool();
    dispatchCall(p, true, 100, 0, shedShare * 100, breakEven, importCapacity); // a full-pool tick
    expect(p.callBudget).toBeCloseTo(callBudgetTicks() - 1, 9);
    dispatchCall(p, true, 100, 0, shedShare * 50, breakEven, importCapacity); // half the pool
    expect(p.callBudget).toBeCloseTo(callBudgetTicks() - 1.5, 9);
  });

  it('runs the budget down to a partial last call and then nothing', () => {
    const p = pool(0.25);
    const partial = dispatchCall(p, true, 100, 0, 1000, breakEven, importCapacity);
    expect(partial.shed).toBeCloseTo(0.25 * shedShare * 100, 9);
    expect(p.callBudget).toBeCloseTo(0, 9);
    expect(dispatchCall(p, true, 100, 0, 1000, breakEven, importCapacity).shed).toBe(0);
  });

  it('never sheds more than the shortfall', () => {
    expect(dispatchCall(pool(), true, 100, 0, 5, breakEven, importCapacity).shed).toBeCloseTo(5, 9);
  });

  it('adds industrialShedShare of the industrial load to the pool', () => {
    const { shedShare, industrialShedShare } = BALANCE.demandResponse;
    const call = dispatchCall(pool(), true, 100, 50, 0, 1, importCapacity).pool;
    expect(call).toBeCloseTo(shedShare * 100 + industrialShedShare * 50, 9);
  });

  it('the industrial pool is available on a dark night when the offices are idle', () => {
    const { industrialShedShare } = BALANCE.demandResponse;
    const call = dispatchCall(pool(), true, 0, 50, 40, breakEven + 1, importCapacity);
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
    state.money = 1e9;
    placePlant(state, at(2, 2), PlantType.WindTurbine);
    recomputeGrid(state);
    syncIslandPools(state);
    state.demandResponse.active = true;
    poolForIsland(state, 1).callBudget = callBudgetTicks() / 2;
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
