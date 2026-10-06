import { BALANCE } from '../shared/constants.ts';
import {
  DIRECTIONS,
  inBounds,
  LINE_PRESENT,
  neighbors4,
  tileIndex,
  tileX,
  tileY,
} from '../shared/grid.ts';
import type { BuildResult } from './roads.ts';
import { clearForest, fellingCost } from './forest.ts';
import {
  BuildIntent,
  buildRejection,
  isBuildable,
  markDirty,
  slopeCostMultiplier,
  snapshotTile,
  Terrain,
  withNeighbors,
  type SimState,
  type UndoEntry,
} from './state.ts';

/** A tile that carries track. */
export function hasRail(state: SimState, index: number): boolean {
  return state.layers.rail[index] !== 0;
}

/** Recompute a track tile's connection bits from its 4-neighbours; track tiles keep LINE_PRESENT. */
export function recomputeRailMask(state: SimState, index: number): void {
  const { layers } = state;
  const previous = layers.rail[index];
  if (previous === 0) return;
  let mask = LINE_PRESENT;
  const x = tileX(index, state.size);
  const y = tileY(index, state.size);
  for (const { dx, dy, bit } of DIRECTIONS) {
    if (!inBounds(x + dx, y + dy, state.size)) continue;
    if (layers.rail[tileIndex(x + dx, y + dy, state.size)] !== 0) mask |= bit;
  }
  if (mask !== previous) {
    layers.rail[index] = mask;
    markDirty(state, index);
  }
}

/** Price of one track tile: a bridge over the river costs more; slopes surcharge. */
export function railTileCost(state: SimState, index: number): number {
  const base =
    state.layers.terrain[index] === Terrain.River
      ? BALANCE.costs.railBridgePerTile
      : BALANCE.costs.railPerTile;
  return Math.round(base * slopeCostMultiplier(state, index));
}

function bumpRailVersion(state: SimState): void {
  state.railVersion++;
}

/**
 * Lay track on the given tiles. Tiles that already carry track are kept
 * and not charged again; blocked tiles are skipped. A drag blocked on
 * every tile explains itself; one that only retraces track stays silent.
 */
export function buildRail(state: SimState, tiles: number[]): BuildResult {
  const { layers } = state;
  const buildable = tiles.filter(
    (index) => layers.rail[index] === 0 && isBuildable(state, index, BuildIntent.Rail),
  );
  if (buildable.length === 0) {
    const blocked = tiles.find((index) => layers.rail[index] === 0);
    if (blocked === undefined) return {};
    return { rejected: buildRejection(state, blocked, BuildIntent.Rail) ?? undefined };
  }
  const cost = buildable.reduce(
    (sum, index) => sum + railTileCost(state, index) + fellingCost(state, index),
    0,
  );
  if (cost > state.money) return { rejected: 'notEnoughMoney' };

  const affected = withNeighbors(state, buildable);
  const undo: UndoEntry = {
    moneyDelta: cost,
    tiles: [...affected].map((index) => snapshotTile(state, index)),
  };
  state.money -= cost;
  for (const index of buildable) {
    layers.rail[index] = LINE_PRESENT;
    clearForest(state, index);
    markDirty(state, index);
  }
  for (const index of affected) recomputeRailMask(state, index);
  bumpRailVersion(state);
  state.undoStack.push(undo);
  return {};
}

/** Remove the track from the given tiles; roads and lines on them stay. The caller owns the undo entry. */
export function clearRail(state: SimState, tiles: number[]): void {
  const { layers } = state;
  for (const index of tiles) {
    layers.rail[index] = 0;
    markDirty(state, index);
  }
  for (const index of withNeighbors(state, tiles)) recomputeRailMask(state, index);
  bumpRailVersion(state);
}

export function countRailTiles(state: SimState): number {
  const { rail } = state.layers;
  let count = 0;
  for (let i = 0; i < rail.length; i++) if (rail[i] !== 0) count++;
  return count;
}

/**
 * Label the connected track components into `layers.railNetwork`
 * (1.. ascending by lowest tile index, which is the network's key in
 * `railNetworkKeys`). Union-find over 4-neighbours; version-gated, so a
 * tick without a track change costs one comparison.
 */
export function recomputeRailNetworks(state: SimState): void {
  if (state.railComputedVersion === state.railVersion) return;
  const { rail, railNetwork } = state.layers;
  const tiles = rail.length;
  const parent = new Int32Array(tiles);
  for (let i = 0; i < tiles; i++) parent[i] = i;
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // Keep the lower root so the root is the component's lowest tile.
    if (ra < rb) parent[rb] = ra;
    else parent[ra] = rb;
  };
  for (let i = 0; i < tiles; i++) {
    if (rail[i] === 0) continue;
    for (const n of neighbors4(i, state.size)) if (rail[n] !== 0 && n > i) union(i, n);
  }
  const keys: number[] = [-1];
  const numberOfRoot = new Map<number, number>();
  railNetwork.fill(0);
  for (let i = 0; i < tiles; i++) {
    if (rail[i] === 0) continue;
    const root = find(i);
    let n = numberOfRoot.get(root);
    if (n === undefined) {
      n = keys.length;
      keys.push(root);
      numberOfRoot.set(root, n);
    }
    railNetwork[i] = n;
  }
  state.railNetworkKeys = keys;
  state.railComputedVersion = state.railVersion;
}

/** Network number of a track tile (0 = no track). Recomputes when stale. */
export function railNetworkOf(state: SimState, index: number): number {
  recomputeRailNetworks(state);
  return state.layers.railNetwork[index];
}

/** Track tiles in network `network`. */
export function railNetworkTiles(state: SimState, network: number): number {
  recomputeRailNetworks(state);
  let count = 0;
  for (const n of state.layers.railNetwork) if (n === network) count++;
  return count;
}
