import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import { countBuildings, type SimState } from './state.ts';

export { countBuildings };

/**
 * Recount the buildings and cache the result on the state as the
 * coverage denominator for this tick. `smartMetersStep` calls it once
 * per tick (after growth and decay have settled, before economy, goals
 * and the stats are built), so `meteredCoverage` — asked once per
 * parked vehicle, van and bus — never repeats the full-grid scan.
 * Hand-built test states that never tick must call it themselves.
 */
export function refreshBuildingCount(state: SimState): number {
  state.lastBuildingCount = countBuildings(state);
  return state.lastBuildingCount;
}

/**
 * Share of buildings with a smart meter, 0 without buildings. Reads the
 * per-tick building cache (see `refreshBuildingCount`), so within a tick
 * this is a division, not a grid scan. The cache is one tick old for the
 * steps that run before the refresh (vehicles, the energy balance),
 * which at most mis-weights coverage by the handful of buildings that
 * grew or decayed in the last tick.
 */
export function meteredCoverage(state: SimState): number {
  const buildings = state.lastBuildingCount;
  if (buildings <= 0) return 0;
  return Math.min(1, state.smartMeters.metered / buildings);
}

/** Start or pause the crews. */
export function setSmartMeterRollout(state: SimState, active: boolean): void {
  state.smartMeters.active = active;
  state.statsDirty = true;
}

/**
 * One tick of the rollout: the building count is refreshed (this is the
 * tick's single scan — see `refreshBuildingCount`), meters vanish with
 * demolished buildings, and while active the crews accumulate
 * installsPerDay per tick and install one meter per TICKS_PER_DAY of
 * carry, each billed at costPerMeter, as long as the treasury can pay
 * (the carry waits otherwise — no debt). Returns the money spent this
 * tick and records it for the budget.
 */
export function smartMetersStep(state: SimState): number {
  const meters = state.smartMeters;
  const buildings = refreshBuildingCount(state);
  if (meters.metered > buildings) meters.metered = buildings;
  let spent = 0;
  if (meters.active && meters.metered < buildings) {
    const { installsPerDay, costPerMeter } = BALANCE.smartMeters;
    // Integer arithmetic on purpose: the carry counts ticks' worth of
    // crew time (installsPerDay per tick, TICKS_PER_DAY per meter), so
    // a day installs exactly installsPerDay meters for any rate. Adding
    // installsPerDay / TICKS_PER_DAY per tick instead left a rounding
    // error for every rate that is not a multiple of 15, delaying the
    // day's last install into the next day.
    meters.installCarry += installsPerDay;
    // Carry must not grow without bound while broke: cap it at one
    // meter's worth of credit, otherwise a long broke stretch installs a
    // burst of meters the moment money arrives.
    if (meters.installCarry > TICKS_PER_DAY) meters.installCarry = TICKS_PER_DAY;
    while (meters.installCarry >= TICKS_PER_DAY && meters.metered < buildings) {
      if (state.money - spent < costPerMeter) break;
      meters.installCarry -= TICKS_PER_DAY;
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

/** Deterministic 0..1 per vehicle id (same scheme as the sim's other hashes). */
function hash01(id: number): number {
  let h = (id * 2654435761 + 97) >>> 0;
  h ^= h >>> 13;
  h = (h * 0x5bd1e995) >>> 0;
  return (h >>> 8) / 16777216;
}

/**
 * Whether a vehicle (car, van or bus) charges "smart" — deferring to
 * renewable surplus unless its battery is low. The share follows the
 * rollout: a vehicle is smart when its hash falls under the coverage, so
 * the smart set only ever grows and never flickers between ticks.
 */
export function isSmartVehicle(state: SimState, id: number): boolean {
  return hash01(id) < meteredCoverage(state);
}

const HOURS_PER_DAY = 24;

/**
 * Hours of flexible demand the backlog may hold before comfort wins, at
 * this time of day. By day the plain `backlogHours`; at night the window
 * stretches to an hour past the coming sunrise, capped at
 * `maxBacklogHours`, so load deferred in the evening can reach the
 * morning sun instead of overflowing in the dark. Never below
 * `backlogHours`.
 */
export function comfortWindowHours(
  timeOfDay: number,
  season: { sunrise: number; sunset: number },
): number {
  const { backlogHours, maxBacklogHours } = BALANCE.smartMeters;
  if (timeOfDay >= season.sunrise && timeOfDay <= season.sunset) return backlogHours;
  const hoursUntilSunrise = ((season.sunrise - timeOfDay + 1) % 1) * HOURS_PER_DAY;
  return Math.min(maxBacklogHours, Math.max(backlogHours, hoursUntilSunrise + 1));
}
