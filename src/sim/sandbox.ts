import { BALANCE } from '../shared/constants.ts';
import type { SimState } from './state.ts';

/**
 * Sandbox cities never run out of money: the treasury is reset to
 * BALANCE.sandbox.treasury after every command and at the end of every
 * tick. Costs and flows are booked exactly as in a normal city, so the
 * budget lines stay honest; only the balance is pinned.
 */
export function pinSandboxTreasury(state: SimState): void {
  if (state.sandbox) state.money = BALANCE.sandbox.treasury;
}
