import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import type { IslandPool } from './islandPools.ts';
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
 * before import), for a single island's pool. `shortfall` is what is
 * still uncovered, `spotPrice` the tick's spot factor. Two rules,
 * combined with max rather than summed: the economic call sheds
 * whatever the pool can give whenever importing would cost more than
 * the activation premium; the security call only adds, at abundance
 * prices, the part of the shortfall the import link cannot carry. The
 * day's allowance is spent in fractions of a full-pool tick, so a
 * partial call costs a partial tick. Shed energy is gone, not deferred.
 * Pure: the caller owns the pool and its daily refill (see
 * `syncIslandPools`).
 */
export function dispatchCall(
  pool: IslandPool,
  active: boolean,
  businessDemand: number,
  industrialDemand: number,
  shortfall: number,
  spotPrice: number,
  importCapacity: number,
): DemandResponseCall {
  if (!active) return { pool: 0, shed: 0 };
  const { shedShare, industrialShedShare, activationPricePerEnergyUnit } = BALANCE.demandResponse;
  const { importCostPerEnergyUnit } = BALANCE.market;
  const size = shedShare * businessDemand + industrialShedShare * industrialDemand;
  if (size <= 0 || shortfall <= 0) return { pool: size, shed: 0 };
  const available = size * Math.min(1, Math.max(0, pool.callBudget));
  const importPrice = importCostPerEnergyUnit * spotPrice;
  const economic = importPrice >= activationPricePerEnergyUnit ? Math.min(shortfall, available) : 0;
  const secure = Math.min(Math.max(0, shortfall - importCapacity), available);
  const shed = Math.max(economic, secure);
  pool.callBudget = Math.max(0, pool.callBudget - shed / size);
  return { pool: size, shed };
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

/** Call hours left today, for the HUD: the tightest island, or the full day without any. */
export function callHoursLeft(state: SimState): number {
  let budget = callBudgetTicks();
  for (const pool of state.islandPools.values()) budget = Math.min(budget, pool.callBudget);
  return (budget * 24) / TICKS_PER_DAY;
}
