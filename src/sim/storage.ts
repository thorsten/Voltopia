/**
 * Storage lives on the plant tiles: `layers.stored` holds what each
 * battery, pumped-storage plant, hydrogen plant or heat store holds. An
 * island's pool is the sum over its tiles of one kind; charging spreads
 * in proportion to headroom and discharging in proportion to stored
 * energy, which is exactly one shared pool and never overfills a tile
 * after islands merge. A damaged plant has no capacity (its level is
 * frozen until repaired), so `storageTilesOfKind` leaves it out.
 */
import { PlantType, TileType } from '../shared/types.ts';
import { installedStorageCapacityAt, storageCapacityAt, type SimState } from './state.ts';

export { storageCapacityAt };

/** Intact tiles of one storage kind, optionally only those on island `islandNumber`. */
export function storageTilesOfKind(
  state: SimState,
  plant: PlantType,
  islandNumber?: number,
): number[] {
  const { tileType, plantType, damage, island } = state.layers;
  const tiles: number[] = [];
  for (let i = 0; i < tileType.length; i++) {
    if (tileType[i] !== TileType.Plant || plantType[i] !== plant || damage[i] !== 0) continue;
    if (islandNumber !== undefined && island[i] !== islandNumber) continue;
    tiles.push(i);
  }
  return tiles;
}

/**
 * Stored energy and capacity summed over the given tiles — normally the
 * intact tiles of one kind, as `storageTilesOfKind` returns them.
 */
export function poolOf(
  state: SimState,
  tiles: readonly number[],
): { stored: number; capacity: number } {
  let stored = 0;
  let capacity = 0;
  for (const t of tiles) {
    // Clamp here too: a save edited by hand may hold more than fits. The
    // bound is the installed capacity, so passing a damaged plant would
    // not empty the level it is frozen at — but it still adds no
    // capacity, so nothing charges or draws it.
    const installed = installedStorageCapacityAt(state, t);
    if (state.layers.stored[t] > installed) state.layers.stored[t] = installed;
    stored += state.layers.stored[t];
    capacity += storageCapacityAt(state, t);
  }
  return { stored, capacity };
}

/**
 * Absorb `energy` into the tiles in proportion to headroom, up to
 * capacity. A damaged tile has 0 capacity but a nonzero (frozen) level,
 * so it is excluded up front — otherwise its "headroom" would read
 * negative and the share computed from the rest would drain it.
 */
export function chargeTiles(state: SimState, tiles: readonly number[], energy: number): void {
  if (energy <= 0) return;
  const chargeable = tiles.filter((t) => storageCapacityAt(state, t) > 0);
  let headroom = 0;
  for (const t of chargeable) headroom += storageCapacityAt(state, t) - state.layers.stored[t];
  if (headroom <= 0) return;
  const share = Math.min(1, energy / headroom);
  for (const t of chargeable) {
    const room = storageCapacityAt(state, t) - state.layers.stored[t];
    state.layers.stored[t] += room * share;
  }
}

/**
 * Release `energy` from the tiles in proportion to what each holds. A
 * damaged tile is excluded up front: its frozen level must stay frozen.
 */
export function dischargeTiles(state: SimState, tiles: readonly number[], energy: number): void {
  if (energy <= 0) return;
  const dischargeable = tiles.filter((t) => storageCapacityAt(state, t) > 0);
  let stored = 0;
  for (const t of dischargeable) stored += state.layers.stored[t];
  if (stored <= 0) return;
  const share = Math.min(1, energy / stored);
  for (const t of dischargeable) state.layers.stored[t] -= state.layers.stored[t] * share;
}

/** Multiply every tile's level by `factor` (standing losses). A damaged tile's frozen level is skipped. */
export function scaleTiles(state: SimState, tiles: readonly number[], factor: number): void {
  for (const t of tiles) {
    if (storageCapacityAt(state, t) <= 0) continue;
    state.layers.stored[t] *= factor;
  }
}

/** Everything the city's intact plants of one storage kind hold. */
export function storedByKind(state: SimState, plant: PlantType): number {
  return poolOf(state, storageTilesOfKind(state, plant)).stored;
}
