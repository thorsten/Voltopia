import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import { countBuildings, type SimState } from './state.ts';

export { countBuildings };

/** Share of buildings with a smart meter, 0 without buildings. */
export function meteredCoverage(state: SimState): number {
  const buildings = countBuildings(state);
  if (buildings === 0) return 0;
  return Math.min(1, state.smartMeters.metered / buildings);
}

/** Start or pause the crews. */
export function setSmartMeterRollout(state: SimState, active: boolean): void {
  state.smartMeters.active = active;
  state.statsDirty = true;
}

/**
 * One tick of the rollout: meters vanish with demolished buildings; while
 * active, crews accumulate installsPerDay / TICKS_PER_DAY per tick and
 * install one meter per whole unit, each billed at costPerMeter, as long
 * as the treasury can pay (the carry waits otherwise — no debt). Returns
 * the money spent this tick and records it for the budget.
 */
export function smartMetersStep(state: SimState): number {
  const meters = state.smartMeters;
  const buildings = countBuildings(state);
  if (meters.metered > buildings) meters.metered = buildings;
  let spent = 0;
  if (meters.active && meters.metered < buildings) {
    const { installsPerDay, costPerMeter } = BALANCE.smartMeters;
    meters.installCarry += installsPerDay / TICKS_PER_DAY;
    // Carry must not grow without bound while broke: cap it at 1 unit of
    // credit, otherwise a long broke stretch installs a burst of meters
    // the moment money arrives.
    if (meters.installCarry > 1) meters.installCarry = 1;
    while (meters.installCarry >= 1 && meters.metered < buildings) {
      if (state.money - spent < costPerMeter) break;
      meters.installCarry -= 1;
      meters.metered++;
      spent += costPerMeter;
    }
    // Reaching full coverage drops any leftover carry: the next new
    // building should not get an instant meter from stale credit.
    if (meters.metered >= buildings) meters.installCarry = 0;
  }
  state.money -= spent;
  state.lastSmartMeterCost = spent;
  if (spent > 0) state.statsDirty = true;
  return spent;
}
