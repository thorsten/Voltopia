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

/**
 * Bring `state.islandPools` in line with the islands of this tick.
 * Merge: a vanished key whose tile now sits on another island adds its
 * backlog to that island's pool and takes the smaller budget. Split: the
 * surviving key keeps everything, the new key starts fresh. Keys whose
 * tile is no longer energised are dropped. The daily budget refill runs
 * here for every pool on the first tick of a day.
 */
export function syncIslandPools(state: SimState): void {
  recomputeGrid(state);
  const { island } = state.layers;
  const keys = state.islandKeys;
  if (state.poolsSyncedVersion !== state.gridComputedVersion) {
    const current = new Set<number>();
    for (let n = 1; n < keys.length; n++) current.add(keys[n]);
    for (const [key, pool] of [...state.islandPools]) {
      if (current.has(key)) continue;
      const n = island[key];
      if (n !== 0) {
        const target = keys[n];
        const into = state.islandPools.get(target) ?? freshPool();
        into.flexBacklog += pool.flexBacklog;
        into.callBudget = Math.min(into.callBudget, pool.callBudget);
        state.islandPools.set(target, into);
      }
      state.islandPools.delete(key);
    }
    for (const key of current) {
      if (!state.islandPools.has(key)) state.islandPools.set(key, freshPool());
    }
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
