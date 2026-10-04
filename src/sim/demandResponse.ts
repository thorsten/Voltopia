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
