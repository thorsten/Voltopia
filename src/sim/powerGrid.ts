import { BALANCE } from '../shared/constants.ts';
import {
  chebyshevDistance,
  LINE_PRESENT,
  lShapedPath,
  neighbors4,
  tileIndex,
  tileX,
  tileY,
} from '../shared/grid.ts';
import { PlantType, TileType } from '../shared/types.ts';
import { isSupplySource } from '../shared/plants.ts';
import { recomputePowerLineMask } from './powerLines.ts';
import type { SimState } from './state.ts';

export { isSupplySource };

/** Union-find over tile indices (parent[i] === -1: not in any set yet). */
function findRoot(parent: Int32Array, i: number): number {
  let root = i;
  while (parent[root] !== root) root = parent[root];
  while (parent[i] !== root) {
    const next = parent[i];
    parent[i] = root;
    i = next;
  }
  return root;
}
function unite(parent: Int32Array, a: number, b: number): void {
  const ra = findRoot(parent, a);
  const rb = findRoot(parent, b);
  if (ra === rb) return;
  // The lower root wins so the final numbering by lowest tile is stable.
  if (ra < rb) parent[rb] = ra;
  else parent[ra] = rb;
}

/**
 * Rebuild the energized and island layers when plants or lines changed:
 * flood-fill from every supply plant over 4-connected, undamaged line
 * tiles, then stamp the connection radius around every energised line
 * tile and every supply plant. Tiles stamped from two components unite
 * them (rings are connections, never borders), so every energised tile
 * belongs to exactly one island. Islands are numbered 1.. ascending by
 * their lowest tile index, which is also the island's key.
 */
export function recomputeGrid(state: SimState): void {
  if (state.gridComputedVersion === state.gridVersion) return;
  const { layers } = state;
  const size = state.size;
  const { powerLine, energized, island, tileType, plantType, damage } = layers;
  const radius = BALANCE.energy.lineSupplyRadius;
  const tiles = size * size;

  // 1. Components of sources and the line tiles they reach.
  const parent = new Int32Array(tiles).fill(-1);
  const reached = new Uint8Array(tiles);
  const queue: number[] = [];
  const stamps: number[] = []; // every source and reached line tile
  for (let i = 0; i < tiles; i++) {
    if (tileType[i] !== TileType.Plant || !isSupplySource(plantType[i] as PlantType)) continue;
    if (damage[i] !== 0) continue; // a damaged plant feeds nothing
    parent[i] = i;
    stamps.push(i);
    for (const n of neighbors4(i, size)) {
      if (powerLine[n] === 0 || damage[n] !== 0) continue;
      if (reached[n] === 0) {
        reached[n] = 1;
        parent[n] = n;
        stamps.push(n);
        queue.push(n);
      }
      unite(parent, i, n);
    }
  }
  while (queue.length > 0) {
    const index = queue.pop()!;
    for (const n of neighbors4(index, size)) {
      if (powerLine[n] === 0 || damage[n] !== 0) continue;
      if (reached[n] === 0) {
        reached[n] = 1;
        parent[n] = n;
        stamps.push(n);
        queue.push(n);
      }
      unite(parent, index, n);
    }
  }

  // 2. Stamp rings; a tile in two rings unites their components.
  const stampedBy = new Int32Array(tiles).fill(-1);
  for (const source of stamps) {
    const cx = tileX(source, size);
    const cy = tileY(source, size);
    const x0 = Math.max(0, cx - radius);
    const x1 = Math.min(size - 1, cx + radius);
    const y0 = Math.max(0, cy - radius);
    const y1 = Math.min(size - 1, cy + radius);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const t = tileIndex(x, y, size);
        if (stampedBy[t] === -1) stampedBy[t] = source;
        else unite(parent, stampedBy[t], source);
      }
    }
  }

  // 3. Number islands ascending by lowest tile; the lowest tile is the key.
  energized.fill(0);
  island.fill(0);
  const numberOfRoot = new Map<number, number>();
  const keys: number[] = [-1];
  for (let t = 0; t < tiles; t++) {
    if (stampedBy[t] === -1) continue;
    const root = findRoot(parent, stampedBy[t]);
    let n = numberOfRoot.get(root);
    if (n === undefined) {
      n = keys.length;
      numberOfRoot.set(root, n);
      keys.push(t); // first tile in index order == lowest tile of the island
    }
    island[t] = n;
    energized[t] = 1;
  }
  state.islandKeys = keys;
  state.gridComputedVersion = state.gridVersion;
}

/** Island number of a tile (0 = not energised). Recomputes the grid if stale. */
export function islandOf(state: SimState, index: number): number {
  recomputeGrid(state);
  return state.layers.island[index];
}

/** Stable key (lowest tile index) of island `number`; -1 for 0 or unknown. */
export function islandKey(state: SimState, number: number): number {
  recomputeGrid(state);
  return state.islandKeys[number] ?? -1;
}

/** Number of islands on the map. */
export function islandCount(state: SimState): number {
  recomputeGrid(state);
  return state.islandKeys.length - 1;
}

/**
 * Whether a tile can carry a power line. Mirrors `buildRejection`'s
 * PowerLine rule in state.ts (lines share tiles with roads and water but
 * never with buildings or plants); duplicated instead of imported so this
 * module's import of state.ts stays type-only (state.ts imports this one).
 */
function canCarryLine(state: SimState, index: number): boolean {
  const { density, tileType } = state.layers;
  return density[index] === 0 && tileType[index] !== TileType.Plant;
}

/**
 * The road tile closest to `index` within `radius` (Chebyshev), or -1
 * when there is none. Ties go to the lowest tile index.
 */
function nearestRoadTile(state: SimState, index: number, radius: number): number {
  const { tileType } = state.layers;
  const size = state.size;
  const cx = tileX(index, size);
  const cy = tileY(index, size);
  const x0 = Math.max(0, cx - radius);
  const x1 = Math.min(size - 1, cx + radius);
  const y0 = Math.max(0, cy - radius);
  const y1 = Math.min(size - 1, cy + radius);
  let best = -1;
  let bestDistance = Infinity;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const candidate = tileIndex(x, y, size);
      if (tileType[candidate] !== TileType.Road) continue;
      const distance = chebyshevDistance(index, candidate, size);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
      }
    }
  }
  return best;
}

/**
 * One-time migration for saves from before power lines: hook every supply
 * plant up to the nearest road within the old supply radius (an L-shaped
 * connector, since plants never had to touch a street) and put a line on
 * every road tile reachable over roads from there, so the loaded city
 * stays supplied and shows a network along its streets.
 */
export function grantLegacyNetwork(state: SimState): void {
  const { layers } = state;
  const size = state.size;
  const { tileType, plantType, powerLine } = layers;
  const granted: number[] = [];
  const grant = (index: number): void => {
    if (powerLine[index] !== 0) return;
    powerLine[index] = LINE_PRESENT;
    granted.push(index);
  };

  const seen = new Uint8Array(size * size);
  for (let i = 0; i < tileType.length; i++) {
    if (tileType[i] !== TileType.Plant || !isSupplySource(plantType[i] as PlantType)) continue;
    const road = nearestRoadTile(state, i, BALANCE.energy.legacySupplyRadius);
    if (road < 0) continue;
    // Connector from the plant to that road. A building in the way breaks
    // the connector — those plants simply stay unconnected.
    const connector = lShapedPath(
      tileX(i, size),
      tileY(i, size),
      tileX(road, size),
      tileY(road, size),
      size,
    );
    for (const index of connector) {
      if (index === i || !canCarryLine(state, index)) continue;
      grant(index);
    }
    if (seen[road] === 1) continue;
    // Follow the streets from there and light up the whole road network.
    seen[road] = 1;
    const queue: number[] = [road];
    while (queue.length > 0) {
      const index = queue.pop()!;
      grant(index);
      for (const n of neighbors4(index, size)) {
        if (tileType[n] === TileType.Road && seen[n] === 0) {
          seen[n] = 1;
          queue.push(n);
        }
      }
    }
  }

  for (const index of granted) recomputePowerLineMask(state, index);
  // Inline instead of bumpGridVersion(): keeps this module's import of
  // state.ts type-only (state.ts imports this module for the migration).
  state.gridVersion++;
}

/** A power line touches one of the tile's four sides. */
export function hasLineAttached(state: SimState, index: number): boolean {
  const { powerLine } = state.layers;
  for (const n of neighbors4(index, state.size)) {
    if (powerLine[n] !== 0) return true;
  }
  return false;
}

/**
 * Supply plants standing in each other's supply ring form one park: a
 * plant inside another plant's ring sits on the grid the way a building
 * there does. Returns every supply plant reachable from `start` that
 * way, `start` first. Pure geometry — damage has its own overlay.
 */
function parkOf(state: SimState, start: number): number[] {
  const { tileType, plantType } = state.layers;
  const size = state.size;
  const radius = BALANCE.energy.lineSupplyRadius;
  const members = [start];
  const seen = new Set<number>(members);
  for (let head = 0; head < members.length; head++) {
    const cx = tileX(members[head], size);
    const cy = tileY(members[head], size);
    const x0 = Math.max(0, cx - radius);
    const x1 = Math.min(size - 1, cx + radius);
    const y0 = Math.max(0, cy - radius);
    const y1 = Math.min(size - 1, cy + radius);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const t = tileIndex(x, y, size);
        if (seen.has(t)) continue;
        if (tileType[t] !== TileType.Plant || !isSupplySource(plantType[t] as PlantType)) continue;
        seen.add(t);
        members.push(t);
      }
    }
  }
  return members;
}

/** Whether a building stands inside the supply ring around `index`. */
function hasBuildingInRing(state: SimState, index: number): boolean {
  const { tileType, density } = state.layers;
  const size = state.size;
  const radius = BALANCE.energy.lineSupplyRadius;
  const cx = tileX(index, size);
  const cy = tileY(index, size);
  const x0 = Math.max(0, cx - radius);
  const x1 = Math.min(size - 1, cx + radius);
  const y0 = Math.max(0, cy - radius);
  const y1 = Math.min(size - 1, cy + radius);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const t = tileIndex(x, y, size);
      if (tileType[t] === TileType.Empty && density[t] > 0) return true;
    }
  }
  return false;
}

function isSupplyPlantTile(state: SimState, index: number): boolean {
  const { tileType, plantType } = state.layers;
  return tileType[index] === TileType.Plant && isSupplySource(plantType[index] as PlantType);
}

/**
 * A supply plant tied into the network: a power line touches it or
 * another plant of its park (see `parkOf`). A tidal row along the coast
 * or a geothermal field needs one line stub, not one per plant.
 */
export function isTiedToGrid(state: SimState, index: number): boolean {
  if (!isSupplyPlantTile(state, index)) return false;
  return parkOf(state, index).some((member) => hasLineAttached(state, member));
}

/**
 * A supply plant that serves nothing: neither it nor any plant of its
 * park has a power line attached or a building in its supply ring.
 * Never true for empty tiles or non-supply plants.
 */
export function isIsolatedPlant(state: SimState, index: number): boolean {
  if (!isSupplyPlantTile(state, index)) return false;
  return !parkOf(state, index).some(
    (member) => hasLineAttached(state, member) || hasBuildingInRing(state, member),
  );
}

/**
 * `isIsolatedPlant` for the whole map in one pass (1 = isolated): each
 * park is walked once, so the per-tick refresh stays linear in plants.
 */
export function isolatedPlants(state: SimState): Uint8Array {
  const flags = new Uint8Array(state.size * state.size);
  const seen = new Uint8Array(flags.length);
  for (let i = 0; i < flags.length; i++) {
    if (seen[i] !== 0 || !isSupplyPlantTile(state, i)) continue;
    const park = parkOf(state, i);
    const serves = park.some(
      (member) => hasLineAttached(state, member) || hasBuildingInRing(state, member),
    );
    for (const member of park) {
      seen[member] = 1;
      if (!serves) flags[member] = 1;
    }
  }
  return flags;
}
