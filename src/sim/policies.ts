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
 * weighs while meters are still being forced on households: the rollout
 * runs and coverage is below 1. Coverage is computed inline
 * (smartMeters.ts imports this module); zero buildings count as full
 * coverage.
 */
export function policyHappiness(state: SimState): number {
  const buildings = state.lastBuildingCount;
  const coverage = buildings <= 0 ? 1 : Math.min(1, state.smartMeters.metered / buildings);
  let total = 0;
  for (const id of POLICY_IDS) {
    if (!state.policies[id]) continue;
    if (id === 'smartMeterMandate' && (!state.smartMeters.active || coverage >= 1)) continue;
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

/** Rooftop PV peak of the building on `index`: density table, or the mandate's density-1 panels. */
export function rooftopPeakAt(state: SimState, index: number): number {
  const density = state.layers.density[index];
  const table = BALANCE.energy.rooftopSolarPeakByDensity[density] ?? 0;
  if (density === 1 && state.layers.pvMandated[index] === 1) {
    return Math.max(table, BALANCE.policies.rooftopPvMandate.mandatePeakDensity1);
  }
  return table;
}

/** Growth calls this when a building spawns (density 0 to 1). */
export function onBuildingSpawned(state: SimState, index: number): void {
  if (!state.policies.rooftopPvMandate) return;
  state.layers.pvMandated[index] = 1;
  state.lastPolicySubsidy += BALANCE.policies.rooftopPvMandate.subsidyPerBuilding;
}

function hourOfTick(tick: number): number {
  return ((tick % TICKS_PER_DAY) / TICKS_PER_DAY) * 24;
}

/**
 * May a car parked at home plug in now? Smart cars follow the surplus
 * gate in vehicles.ts regardless; under the night tariff a plain car
 * waits for the cheap hours unless it is nearly empty.
 */
export function homeChargingAllowed(
  state: SimState,
  smart: boolean,
  charge: number,
  tick: number,
): boolean {
  if (smart || !state.policies.nightTariff) return true;
  if (charge < BALANCE.vehicles.smartChargeFloor) return true;
  const { nightStartHour, nightEndHour } = BALANCE.policies.nightTariff;
  const hour = hourOfTick(tick);
  return hour >= nightStartHour || hour < nightEndHour;
}

/** Share of household load the smart meters may defer. */
export function householdFlexShare(state: SimState): number {
  const base = BALANCE.smartMeters.householdFlexShare;
  return state.policies.nightTariff ? base * BALANCE.policies.nightTariff.flexShareFactor : base;
}

/** Commuter car speed; buses, vans and trains keep their own speed. */
export function carSpeedTilesPerSecond(state: SimState): number {
  const base = BALANCE.vehicles.speedTilesPerSecond;
  return state.policies.speedLimit ? base * BALANCE.policies.speedLimit.speedFactor : base;
}

export function batteryDrainPerTile(state: SimState): number {
  const base = BALANCE.vehicles.batteryDrainPerTile;
  return state.policies.speedLimit ? base * BALANCE.policies.speedLimit.drainFactor : base;
}

export function smartMeterInstallsPerDay(state: SimState): number {
  const base = BALANCE.smartMeters.installsPerDay;
  return state.policies.smartMeterMandate
    ? base * BALANCE.policies.smartMeterMandate.installFactor
    : base;
}

/** What the city pays per installed meter (households cover the rest under the mandate). */
export function smartMeterCityCost(state: SimState): number {
  const base = BALANCE.smartMeters.costPerMeter;
  return state.policies.smartMeterMandate
    ? base * BALANCE.policies.smartMeterMandate.cityCostShare
    : base;
}
