import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import type { SimState } from './state.ts';

/** The contract's daily allowance of full-pool shedding, in ticks. */
export function callBudgetTicks(): number {
  return (BALANCE.demandResponse.maxCallHoursPerDay * TICKS_PER_DAY) / 24;
}

/** Sign or end the contract. Ending it clears nothing else: the day's budget keeps counting down. */
export function setDemandResponse(state: SimState, active: boolean): void {
  state.demandResponse.active = active;
  state.statsDirty = true;
}

export interface DemandResponseCall {
  /**
   * Energy the contract could shed this tick (shedShare of the business
   * base load plus industrialShedShare of the industrial base load, 0
   * when off).
   */
  pool: number;
  /** Energy actually shed this tick. */
  shed: number;
}

/**
 * One tick of the contract inside the deficit cascade (after biogas,
 * before import). `shortfall` is what is still uncovered, `spotPrice`
 * the tick's spot factor. Two rules, combined with max rather than
 * summed: the economic call sheds whatever the pool can give whenever
 * importing would cost more than the activation premium; the security
 * call only adds, at abundance prices, the part of the shortfall the
 * import link cannot carry. The day's allowance refills on the first
 * tick of every in-game day and is spent in fractions of a full-pool
 * tick, so a partial call costs a partial tick. Shed energy is gone,
 * not deferred.
 */
export function dispatchDemandResponse(
  state: SimState,
  businessDemand: number,
  shortfall: number,
  spotPrice: number,
  industrialDemand = 0,
): DemandResponseCall {
  const contract = state.demandResponse;
  if (state.tick % TICKS_PER_DAY === 0) contract.callBudget = callBudgetTicks();
  if (!contract.active) return { pool: 0, shed: 0 };
  const { shedShare, industrialShedShare, activationPricePerEnergyUnit } = BALANCE.demandResponse;
  const { importCapacity, importCostPerEnergyUnit } = BALANCE.market;
  const pool = shedShare * businessDemand + industrialShedShare * industrialDemand;
  if (pool <= 0 || shortfall <= 0) return { pool, shed: 0 };
  const available = pool * Math.min(1, Math.max(0, contract.callBudget));
  const importPrice = importCostPerEnergyUnit * spotPrice;
  const economic = importPrice >= activationPricePerEnergyUnit ? Math.min(shortfall, available) : 0;
  const secure = Math.min(Math.max(0, shortfall - importCapacity), available);
  const shed = Math.max(economic, secure);
  contract.callBudget = Math.max(0, contract.callBudget - shed / pool);
  return { pool, shed };
}

/**
 * One tick of the contract's money: the retainer for every contracted
 * business (per building and day, so a day sums to exactly
 * retainerPerBuildingPerDay each) plus the activation premium for what
 * the energy step shed this tick. Runs after the energy step and the
 * smart meters, before the economy, so the cost lands in this tick's
 * budget. A contract is not a purchase: it is billed even when the
 * treasury is empty. Returns the money spent and records it for the
 * budget line.
 */
export function demandResponseStep(state: SimState): number {
  let spent = 0;
  if (state.demandResponse.active) {
    const { retainerPerBuildingPerDay, activationPricePerEnergyUnit } = BALANCE.demandResponse;
    const { contractedBuildings, shed } = state.lastEnergy;
    spent =
      (contractedBuildings * retainerPerBuildingPerDay) / TICKS_PER_DAY +
      shed * activationPricePerEnergyUnit;
  }
  state.money -= spent;
  state.lastDemandResponseCost = spent;
  if (spent > 0) state.statsDirty = true;
  return spent;
}

/** Call hours left today, for the HUD. */
export function callHoursLeft(state: SimState): number {
  return (state.demandResponse.callBudget * 24) / TICKS_PER_DAY;
}
