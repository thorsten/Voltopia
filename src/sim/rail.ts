import { BALANCE } from '../shared/constants.ts';
import {
  chebyshevDistance,
  DIRECTIONS,
  inBounds,
  LINE_PRESENT,
  neighbors4,
  tileIndex,
  tileX,
  tileY,
} from '../shared/grid.ts';
import { MAX_RAIL_AGE, PlantType, StopState } from '../shared/types.ts';
import type { BuildResult } from './roads.ts';
import { isFactory } from './deliveries.ts';
import { clearForest, fellingCost } from './forest.ts';
import {
  BuildIntent,
  buildRejection,
  isBuildable,
  markDirty,
  slopeCostMultiplier,
  snapshotTile,
  stationDueTicks,
  stationServiceTicks,
  stationStateOfAge,
  Terrain,
  TileType,
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

function isPlantOf(state: SimState, tile: number, plant: PlantType): boolean {
  const { tileType, plantType } = state.layers;
  return tile >= 0 && tileType[tile] === TileType.Plant && plantType[tile] === plant;
}
export function isStation(state: SimState, tile: number): boolean {
  return isPlantOf(state, tile, PlantType.TrainStation);
}
export function isTerminal(state: SimState, tile: number): boolean {
  return isPlantOf(state, tile, PlantType.FreightTerminal);
}
export function isYard(state: SimState, tile: number): boolean {
  return isPlantOf(state, tile, PlantType.RailYard);
}

function tilesOf(state: SimState, plant: PlantType): number[] {
  const out: number[] = [];
  for (let i = 0; i < state.layers.tileType.length; i++)
    if (isPlantOf(state, i, plant)) out.push(i);
  return out;
}
export function stationTiles(state: SimState): number[] {
  return tilesOf(state, PlantType.TrainStation);
}
export function terminalTiles(state: SimState): number[] {
  return tilesOf(state, PlantType.FreightTerminal);
}
export function yardTiles(state: SimState): number[] {
  return tilesOf(state, PlantType.RailYard);
}

/** The lowest-index track tile next to a rail plant: where its trains halt. -1 when none. */
export function plantTrack(state: SimState, plant: number): number {
  let track = -1;
  for (const n of neighbors4(plant, state.size)) {
    if (state.layers.rail[n] !== 0 && (track < 0 || n < track)) track = n;
  }
  return track;
}

/** Network of the track a rail plant stands beside (0 when it lost its track). */
export function plantNetwork(state: SimState, plant: number): number {
  const track = plantTrack(state, plant);
  return track < 0 ? 0 : railNetworkOf(state, track);
}

/** True while the station had a passenger train within the service window. */
export function isStationServed(state: SimState, station: number): boolean {
  return isStation(state, station) && state.layers.stationAge[station] <= stationServiceTicks();
}

/**
 * Advance the station, terminal and depot-goods ages by one tick
 * (saturating). Tiles that are not the matching plant sit at
 * MAX_RAIL_AGE. A station is marked dirty when it crosses into "due" or
 * "unserved" so the overlay follows. Returns how many stations and
 * unloading terminals are at least half-way to due — the dispatch
 * threshold `planPassengerTour` / `planFreightTour` use — so
 * `trainsStep` can skip planning while nothing qualifies.
 */
export function ageRailPlants(state: SimState): { stationsDue: number; terminalsDue: number } {
  const { layers } = state;
  const { tileType, plantType, stationAge, terminalAge, railGoodsAge } = layers;
  const due = stationDueTicks();
  const window = stationServiceTicks();
  const minAge = Math.floor(due / 2);
  let stationsDue = 0;
  let terminalsDue = 0;
  for (let i = 0; i < tileType.length; i++) {
    const isPlant = tileType[i] === TileType.Plant;
    const plant = isPlant ? plantType[i] : PlantType.None;
    if (plant === PlantType.TrainStation) {
      const age = stationAge[i];
      if (age >= MAX_RAIL_AGE) {
        stationsDue++;
      } else {
        const next = age + 1;
        stationAge[i] = next;
        if (next === due + 1 || next === window + 1) markDirty(state, i);
        if (next >= minAge) stationsDue++;
      }
    } else if (stationAge[i] !== MAX_RAIL_AGE) {
      stationAge[i] = MAX_RAIL_AGE;
    }
    if (plant === PlantType.FreightTerminal) {
      const age = terminalAge[i];
      if (age >= MAX_RAIL_AGE) {
        if (terminalUnloads(state, i)) terminalsDue++;
      } else {
        const next = age + 1;
        terminalAge[i] = next;
        if (next >= minAge && terminalUnloads(state, i)) terminalsDue++;
      }
    } else if (terminalAge[i] !== MAX_RAIL_AGE) {
      terminalAge[i] = MAX_RAIL_AGE;
    }
    if (plant === PlantType.LogisticsDepot) {
      if (railGoodsAge[i] < MAX_RAIL_AGE) railGoodsAge[i]++;
    } else if (railGoodsAge[i] !== MAX_RAIL_AGE) {
      railGoodsAge[i] = MAX_RAIL_AGE;
    }
  }
  return { stationsDue, terminalsDue };
}

/**
 * Rebuild `railStation`: for every road tile within stationRadius
 * (chessboard) of a served station, the nearest such station (ties:
 * lower index); -1 elsewhere. Changed tiles are marked dirty.
 */
export function updateRailCover(state: SimState): void {
  const { layers, size } = state;
  const next = new Int32Array(layers.railStation.length).fill(-1);
  // A plain array: Int32Array.fill(Number.MAX_SAFE_INTEGER) truncates to -1,
  // which would make every real distance look larger and never win.
  const best: number[] = Array.from({ length: layers.railStation.length }, () => Infinity);
  const r = BALANCE.rail.stationRadius;
  for (const station of stationTiles(state)) {
    if (!isStationServed(state, station)) continue;
    const cx = tileX(station, size);
    const cy = tileY(station, size);
    for (let y = Math.max(0, cy - r); y <= Math.min(size - 1, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x <= Math.min(size - 1, cx + r); x++) {
        const tile = tileIndex(x, y, size);
        if (layers.tileType[tile] !== TileType.Road) continue;
        const d = chebyshevDistance(tile, station, size);
        // stationTiles is ascending, so a strict < keeps the lower index on ties.
        if (d < best[tile]) {
          best[tile] = d;
          next[tile] = station;
        }
      }
    }
  }
  for (let i = 0; i < next.length; i++) {
    if (next[i] === layers.railStation[i]) continue;
    layers.railStation[i] = next[i];
    markDirty(state, i);
  }
}

/** A factory tile that can load goods: a powered factory (see `isFactory`), and intact. */
function isLoadingFactory(state: SimState, tile: number): boolean {
  return isFactory(state, tile) && state.layers.damage[tile] === 0;
}

function tilesWithin(state: SimState, centre: number, radius: number): number[] {
  const { size } = state;
  const cx = tileX(centre, size);
  const cy = tileY(centre, size);
  const out: number[] = [];
  for (let y = Math.max(0, cy - radius); y <= Math.min(size - 1, cy + radius); y++) {
    for (let x = Math.max(0, cx - radius); x <= Math.min(size - 1, cx + radius); x++) {
      out.push(tileIndex(x, y, size));
    }
  }
  return out;
}

/** The terminal has a factory that can load within freightRadius. */
export function terminalLoads(state: SimState, terminal: number): boolean {
  return tilesWithin(state, terminal, BALANCE.rail.freightRadius).some((t) =>
    isLoadingFactory(state, t),
  );
}

/** Logistics depots within freightRadius of a terminal, ascending. */
export function depotsInReach(state: SimState, terminal: number): number[] {
  return tilesWithin(state, terminal, BALANCE.rail.freightRadius).filter((t) =>
    isPlantOf(state, t, PlantType.LogisticsDepot),
  );
}

/** The terminal has a logistics depot within freightRadius. */
export function terminalUnloads(state: SimState, terminal: number): boolean {
  return depotsInReach(state, terminal).length > 0;
}

/** A freight train unloaded here: the terminal and every depot in reach are supplied right now. */
export function stampRailGoods(state: SimState, terminal: number): void {
  state.layers.terminalAge[terminal] = 0;
  for (const depot of depotsInReach(state, terminal)) state.layers.railGoodsAge[depot] = 0;
}

/** Service bucket of a station tile; other tiles count as served. */
export function stationState(state: SimState, tile: number): StopState {
  if (!isStation(state, tile)) return StopState.Served;
  return stationStateOfAge(state.layers.stationAge[tile]);
}
