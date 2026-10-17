import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import { POLICY_IDS, type PolicyId } from '../shared/types.ts';
import type { SimState } from './state.ts';

export { POLICY_IDS, type PolicyId };

export function defaultPolicies(): Record<PolicyId, boolean> {
  return {
    rooftopPvMandate: false,
    nightTariff: false,
    speedLimit: false,
    smartMeterMandate: false,
  };
}

export function policyActive(state: SimState, id: PolicyId): boolean {
  return state.policies[id];
}

/** Administration cost of the active ordinances per in-game day. */
export function policyDailyCost(state: SimState): number {
  let total = 0;
  for (const id of POLICY_IDS) if (state.policies[id]) total += BALANCE.policies[id].dailyCost;
  return total;
}

/**
 * Happiness term of the active ordinances. The smart-meter mandate only
 * weighs while meters are still being forced on households. Coverage is
 * computed inline (smartMeters.ts imports this module); zero buildings
 * count as full coverage.
 */
export function policyHappiness(state: SimState): number {
  const buildings = state.lastBuildingCount;
  const coverage = buildings <= 0 ? 1 : Math.min(1, state.smartMeters.metered / buildings);
  let total = 0;
  for (const id of POLICY_IDS) {
    if (!state.policies[id]) continue;
    if (id === 'smartMeterMandate' && coverage >= 1) continue;
    total += BALANCE.policies[id].happiness;
  }
  return total;
}

/**
 * Charge this tick's administration cost and whatever subsidies the
 * growth step booked into `lastPolicySubsidy` since the last tick.
 */
export function policiesStep(state: SimState): void {
  const admin = policyDailyCost(state) / TICKS_PER_DAY;
  const spent = admin + state.lastPolicySubsidy;
  state.money -= spent;
  state.lastPolicyCost = spent;
  state.lastPolicySubsidy = 0;
  if (spent > 0) state.statsDirty = true;
}
