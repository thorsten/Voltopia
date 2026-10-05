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
import { storageCapacityAt, type SimState } from './state.ts';

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

/** Stored energy and capacity summed over the given tiles. */
export function poolOf(
  state: SimState,
  tiles: readonly number[],
): { stored: number; capacity: number } {
  let stored = 0;
  let capacity = 0;
  for (const t of tiles) {
    const cap = storageCapacityAt(state, t);
    // Clamp here too: a save edited by hand may hold more than fits.
    if (state.layers.stored[t] > cap) state.layers.stored[t] = cap;
    stored += state.layers.stored[t];
    capacity += cap;
  }
  return { stored, capacity };
}

/** Absorb `energy` into the tiles in proportion to headroom, up to capacity. */
export function chargeTiles(state: SimState, tiles: readonly number[], energy: number): void {
  if (energy <= 0) return;
  let headroom = 0;
  for (const t of tiles) headroom += storageCapacityAt(state, t) - state.layers.stored[t];
  if (headroom <= 0) return;
  const share = Math.min(1, energy / headroom);
  for (const t of tiles) {
    const room = storageCapacityAt(state, t) - state.layers.stored[t];
    state.layers.stored[t] += room * share;
  }
}

/** Release `energy` from the tiles in proportion to what each holds. */
export function dischargeTiles(state: SimState, tiles: readonly number[], energy: number): void {
  if (energy <= 0) return;
  let stored = 0;
  for (const t of tiles) stored += state.layers.stored[t];
  if (stored <= 0) return;
  const share = Math.min(1, energy / stored);
  for (const t of tiles) state.layers.stored[t] -= state.layers.stored[t] * share;
}

/** Multiply every tile's level by `factor` (standing losses). */
export function scaleTiles(state: SimState, tiles: readonly number[], factor: number): void {
  for (const t of tiles) state.layers.stored[t] *= factor;
}

/** Everything the city's intact plants of one storage kind hold. */
export function storedByKind(state: SimState, plant: PlantType): number {
  return poolOf(state, storageTilesOfKind(state, plant)).stored;
}
