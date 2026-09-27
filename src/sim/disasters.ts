import { BALANCE } from '../shared/constants.ts';
import { DisasterKind, TileType } from '../shared/types.ts';
import { bumpGridVersion, markDirty, type SimState } from './state.ts';

/** Highest value the quantised damage layer can hold. */
export const MAX_DAMAGE = 255;

/**
 * Add damage points to a tile. The grid is only re-derived on the
 * transition from intact to damaged — that is when a line stops
 * conducting or a plant stops feeding.
 */
export function addDamage(state: SimState, index: number, points: number): void {
  const { damage } = state.layers;
  const before = damage[index];
  const next = Math.min(MAX_DAMAGE, before + Math.max(1, Math.round(points)));
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
