import { TICKS_PER_DAY } from '../shared/constants.ts';
import { callBudgetTicks } from './demandResponse.ts';
import { recomputeGrid } from './powerGrid.ts';
import type { SimState } from './state.ts';

/** Per-island state that must survive a grid recompute: keyed by the island's lowest tile index. */
export interface IslandPool {
  /** Deferred flexible energy waiting for renewable surplus (energy units). */
  flexBacklog: number;
  /** Ticks of full-pool demand-response shedding still allowed today (fractions for partial calls). */
  callBudget: number;
}

function freshPool(): IslandPool {
  return { flexBacklog: 0, callBudget: callBudgetTicks() };
}

/** Fold `pool` into whatever `map` already holds for new island `n` (sum backlog, min budget). */
function mergeInto(map: Map<number, IslandPool>, n: number, pool: IslandPool): void {
  const existing = map.get(n);
  if (!existing) {
    map.set(n, pool);
  } else {
    existing.flexBacklog += pool.flexBacklog;
    existing.callBudget = Math.min(existing.callBudget, pool.callBudget);
  }
}

/**
 * Bring `state.islandPools` in line with the islands of this tick, by
 * tile-set overlap against the labelling the pools were last synced to
 * (`layers.prevIsland` / `state.prevIslandKeys`, snapshotted by
 * `recomputeGrid`) — not by whether a vanished key's own tile happens
 * to still be energised. An old island's pool goes to whichever new
 * island shares the most of its tiles (ties keep the lower new number);
 * that is how a split keeps the pool under the larger fragment even
 * when the old key tile itself drops out (merge subsumes ownership
 * transfer too: both are just "most overlap"). Two old islands landing
 * on the same new island merge (`flexBacklog` summed, `callBudget` =
 * min). A new island nobody's old tiles overlap starts fresh. The daily
 * budget refill runs here for every pool on the first tick of a day.
 */
export function syncIslandPools(state: SimState): void {
  recomputeGrid(state);
  if (state.poolsSyncedVersion !== state.gridComputedVersion) {
    const { island, prevIsland } = state.layers;
    const keys = state.islandKeys;
    const prevKeys = state.prevIslandKeys;

    // overlap[o][n] = tiles of old island o that now lie in new island n.
    const overlap: number[][] = Array.from({ length: prevKeys.length }, () =>
      Array.from<number>({ length: keys.length }).fill(0),
    );
    for (let t = 0; t < island.length; t++) {
      overlap[prevIsland[t]][island[t]]++;
    }

    // For each old island, the new island owning the most of its tiles
    // inherits its pool; two old islands landing on the same new one merge.
    const inherited = new Map<number, IslandPool>(); // new island number -> pool
    const claimed = new Set<number>(); // old keys this pass has already accounted for
    for (let o = 1; o < prevKeys.length; o++) {
      const key = prevKeys[o];
      claimed.add(key);
      const old = state.islandPools.get(key);
      if (!old) continue;
      let bestN = 0;
      let bestCount = 0;
      for (let n = 1; n < keys.length; n++) {
        if (overlap[o][n] > bestCount) {
          bestCount = overlap[o][n];
          bestN = n;
        }
      }
      if (bestN === 0) continue; // this old island left no trace on any new one
      mergeInto(inherited, bestN, old);
    }
    // Safety net for an entry already keyed exactly to a *current*
    // island but never visited above, because its key isn't any
    // `prevKeys[o]` — the labelling pools were last synced to may be
    // stale relative to the map itself, not just relative to the grid:
    // `deserializeState` restores a save's pools straight from their
    // saved keys without forcing a recompute first (staying as lazy
    // about the grid as `islandKeys` already is), so the first real
    // sync afterwards sees a `state.islandPools` that already matches
    // the current labelling while `prevIslandKeys` still says "no
    // islands". Dropping such an entry just because the overlap pass
    // never reached it would be exactly the kind of silent data loss
    // this function exists to prevent.
    for (const [key, pool] of state.islandPools) {
      if (claimed.has(key)) continue;
      const n = keys.indexOf(key);
      if (n <= 0) continue;
      mergeInto(inherited, n, pool);
    }

    const next = new Map<number, IslandPool>();
    for (let n = 1; n < keys.length; n++) {
      next.set(keys[n], inherited.get(n) ?? freshPool());
    }
    state.islandPools = next;
    state.poolsSyncedVersion = state.gridComputedVersion;
  }
  // Tick 0 is the pre-game state, never a simulated tick on its own —
  // `stepTick` always increments before calling this — so it must not
  // count as "the first tick of a day" here: a setup call before the
  // first real tick (building two islands, priming a pool for a test)
  // would otherwise have its budget silently refilled back to full on
  // every subsequent sync at that same tick 0.
  if (state.tick !== 0 && state.tick % TICKS_PER_DAY === 0) {
    for (const pool of state.islandPools.values()) pool.callBudget = callBudgetTicks();
  }
}

export function poolForIsland(state: SimState, islandNumber: number): IslandPool {
  const key = state.islandKeys[islandNumber];
  const pool = key === undefined || key < 0 ? undefined : state.islandPools.get(key);
  if (!pool) throw new Error(`no pool for island ${islandNumber}`);
  return pool;
}
