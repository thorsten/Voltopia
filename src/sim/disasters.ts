import { BALANCE } from '../shared/constants.ts';
import {
  DisasterKind,
  TileType,
  type DisasterEvent,
  type DisasterInfo,
  type DisasterStats,
} from '../shared/types.ts';
import { fireSpec } from './fire.ts';
import { floodSpec } from './flood.ts';
import { bumpGridVersion, markDirty, type SimState } from './state.ts';
import { stormGust, stormSpec } from './storm.ts';

/** Highest value the quantised damage layer can hold. */
export const MAX_DAMAGE = 255;

/**
 * Add damage points to a tile. The grid is only re-derived on the
 * transition from intact to damaged — that is when a line stops
 * conducting or a plant stops feeding.
 *
 * An increment that rounds to nothing is nothing: this used to floor at
 * one point per call, which silently made every slow effect a fast one —
 * a flood running longer than MAX_DAMAGE ticks wrote off every tile it
 * covered whatever its own rate said. Callers that want a sub-point rate
 * accumulate it themselves (see floodSpec.apply) and pass whole points.
 */
export function addDamage(state: SimState, index: number, points: number): void {
  const added = Math.round(points);
  if (added <= 0) return;
  const { damage } = state.layers;
  const before = damage[index];
  const next = Math.min(MAX_DAMAGE, before + added);
  if (next === before) return;
  damage[index] = next;
  if (before === 0) bumpGridVersion(state);
  markDirty(state, index);
}

/** Make a tile intact again (repaired, or bulldozed away). */
export function clearDamage(state: SimState, index: number): void {
  if (state.layers.damage[index] === 0) return;
  state.layers.damage[index] = 0;
  bumpGridVersion(state);
  markDirty(state, index);
}

export function isDamaged(state: SimState, index: number): boolean {
  return state.layers.damage[index] !== 0;
}

export function damagedTileCount(state: SimState): number {
  const { damage } = state.layers;
  let count = 0;
  for (let i = 0; i < damage.length; i++) {
    if (damage[i] !== 0) count++;
  }
  return count;
}

/** Tiles covered by an active event; they are not repaired while it runs. */
export function activeDisasterTiles(state: SimState): Set<number> {
  const tiles = new Set<number>();
  for (const event of state.disasters.active) {
    for (const index of event.tiles) tiles.add(index);
  }
  return tiles;
}

/** Kind of the active event covering a tile, or null. */
export function disasterKindAt(state: SimState, index: number): DisasterKind | null {
  for (const event of state.disasters.active) {
    if (event.tiles.includes(index)) return event.kind;
  }
  return null;
}

/**
 * One tick of repairs: every damaged tile outside an active event heals
 * `pointsPerTick` damage points and bills `costPerPoint` per point.
 *
 * An empty treasury freezes the damage instead of running into debt, so
 * a city that went broke in a storm stays repairable once money flows
 * again. The scan then stops at the first tile it cannot afford, which
 * favours low tile indices — deterministic, and the alternative (spread
 * the last coins thinly over every wreck) repairs nothing at all.
 */
export function repairStep(state: SimState): number {
  const { pointsPerTick, costPerPoint } = BALANCE.disasters.repair;
  const { damage } = state.layers;
  const blocked = activeDisasterTiles(state);
  let spend = 0;
  for (let i = 0; i < damage.length; i++) {
    if (damage[i] === 0 || blocked.has(i)) continue;
    const points = Math.min(damage[i], pointsPerTick);
    const cost = points * costPerPoint;
    if (cost > state.money - spend) break;
    spend += cost;
    damage[i] -= points;
    if (damage[i] === 0) bumpGridVersion(state);
    markDirty(state, i);
  }
  state.money -= spend;
  state.lastRepairCost = spend;
  return spend;
}

/** Share of buildings that are damaged (0 when the city has none). */
export function damagedBuildingShare(state: SimState): number {
  const { tileType, density, damage } = state.layers;
  let buildings = 0;
  let damaged = 0;
  for (let i = 0; i < tileType.length; i++) {
    if (tileType[i] !== TileType.Empty || density[i] === 0) continue;
    buildings++;
    if (damage[i] !== 0) damaged++;
  }
  return buildings > 0 ? damaged / buildings : 0;
}

/**
 * What one kind of disaster contributes to the shared lifecycle. The
 * framework owns warnings, damage bookkeeping, repair and stats; a kind
 * only answers three questions: how likely is it right now, where does it
 * strike, and what does one tick of it do.
 */
export interface DisasterSpec {
  kind: DisasterKind;
  /** Ticks of warning before it becomes active (0 = no warning). */
  warnTicks: number;
  /** Ticks it stays active at most. */
  durationTicks: number;
  /** Severity is drawn uniformly from this range. */
  severityRange: readonly [number, number];
  /** Probability per tick that it starts, before the intensity scale. */
  risk(state: SimState): number;
  /** Where it strikes, or null when the city offers no site. */
  plan(
    state: SimState,
    severity: number,
  ): { origin: number; tiles: number[]; intensity: number[] } | null;
  /** One tick of the active event. Returns true when it is over. */
  apply(state: SimState, event: DisasterEvent): boolean;
}

/** Every kind the game rolls for. Filled in by storm.ts, fire.ts, flood.ts. */
export const DISASTER_SPECS: readonly DisasterSpec[] = [stormSpec, fireSpec, floodSpec];

/**
 * One tick of the disaster lifecycle: roll for a new event, activate
 * whatever is now due, then let every active event work — retiring it
 * once its duration runs out, without one more apply.
 *
 * Activation happens in a single place, right before the active events
 * run, so a warned event (activated on a later tick, before its loop)
 * and an unwarned one (activated this same tick, also before its loop)
 * get exactly the same number of `apply` calls: `durationTicks`.
 *
 * Runs after `updateWeather` (the weather of this tick sets the risk) and
 * before generation and grid connectivity, so this tick's damage is
 * already in effect when the energy balance is computed.
 */
export function disastersStep(
  state: SimState,
  specs: readonly DisasterSpec[] = DISASTER_SPECS,
): void {
  const d = state.disasters;
  if (d.cooldownTicks > 0) d.cooldownTicks--;

  if (d.cooldownTicks === 0 && state.disasterScale > 0) {
    for (const spec of specs) {
      const risk = spec.risk(state) * state.disasterScale;
      if (risk <= 0 || !state.rng.chance(risk)) continue;
      if (!schedule(state, spec)) continue;
      // One event per roll: the cooldown spaces the next one out.
      d.cooldownTicks = BALANCE.disasters.cooldownTicks;
      break;
    }
  }

  activateDue(state);

  if (d.active.length > 0) {
    const running: DisasterEvent[] = [];
    for (const event of d.active) {
      if (state.tick >= event.endTick) {
        // Duration's hard end: retire it without one more apply.
        state.statsDirty = true;
        continue;
      }
      const spec = specs.find((candidate) => candidate.kind === event.kind);
      // A kind that is not in the list (a save from a later version, a
      // test with a narrower list) simply runs out its duration.
      const done = spec ? spec.apply(state, event) : false;
      if (done) state.statsDirty = true;
      else running.push(event);
    }
    d.active = running;
  }

  // The gust is derived state, recomputed every tick from what is active
  // right now. This must run last and unconditionally — after activation,
  // apply and retirement above — or a stale gust would leave the whole
  // wind fleet cut out after a storm has already passed.
  state.weather.gust = stormGust(state);
}

/** Move any pending event whose warning has run out into `active`. */
function activateDue(state: SimState): void {
  const d = state.disasters;
  if (d.pending.length === 0) return;
  const due = d.pending.filter((event) => state.tick >= event.startTick);
  if (due.length === 0) return;
  d.pending = d.pending.filter((event) => state.tick < event.startTick);
  d.active.push(...due);
  state.statsDirty = true;
}

/** Put one event of this kind on the calendar. False when there is no site. */
function schedule(state: SimState, spec: DisasterSpec): boolean {
  const [min, max] = spec.severityRange;
  const severity = state.rng.nextRange(min, max);
  const plan = spec.plan(state, severity);
  if (plan === null) return false;
  state.disasters.pending.push({
    id: state.disasters.nextId++,
    kind: spec.kind,
    severity,
    startTick: state.tick + spec.warnTicks,
    endTick: state.tick + spec.warnTicks + spec.durationTicks,
    origin: plan.origin,
    tiles: plan.tiles,
    intensity: plan.intensity,
  });
  state.statsDirty = true;
  return true;
}

/** Everything the HUD and the agent tools need to know about disasters. */
export function disasterStats(state: SimState): DisasterStats {
  const d = state.disasters;
  return {
    scale: state.disasterScale,
    pending: d.pending.map((event) => info(event, event.startTick - state.tick)),
    active: d.active.map((event) => info(event, event.endTick - state.tick)),
    damagedTiles: damagedTileCount(state),
    repairPerTick: state.lastRepairCost,
  };
}

function info(event: DisasterEvent, ticks: number): DisasterInfo {
  return {
    id: event.id,
    kind: event.kind,
    severity: event.severity,
    ticks: Math.max(0, ticks),
    origin: event.origin,
    tiles: [...event.tiles],
  };
}
