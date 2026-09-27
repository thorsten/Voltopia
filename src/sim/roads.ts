import { BALANCE } from '../shared/constants.ts';
import { DIRECTIONS, inBounds, tileIndex, tileX, tileY } from '../shared/grid.ts';
import { RoadClass, Terrain } from '../shared/types.ts';
import { clearPowerLines } from './powerLines.ts';
import { clearBusStops } from './transit.ts';
import { clearForest, fellingCost } from './forest.ts';
import {
  BuildIntent,
  bumpGridVersion,
  isBuildable,
  markDirty,
  slopeCostMultiplier,
  snapshotTile,
  TileType,
  withNeighbors,
  Zone,
  type SimState,
  type UndoEntry,
} from './state.ts';

/** Recompute the 4-bit connection mask of a tile (0 for non-roads). */
export function recomputeRoadMask(state: SimState, index: number): void {
  const { layers } = state;
  const previous = layers.roadMask[index];
  let mask = 0;
  if (layers.tileType[index] === TileType.Road) {
    const x = tileX(index, state.size);
    const y = tileY(index, state.size);
    for (const { dx, dy, bit } of DIRECTIONS) {
      if (!inBounds(x + dx, y + dy, state.size)) continue;
      const neighbor = tileIndex(x + dx, y + dy, state.size);
      if (layers.tileType[neighbor] === TileType.Road) mask |= bit;
    }
  }
  if (mask !== previous) {
    layers.roadMask[index] = mask;
    markDirty(state, index);
  }
}

export interface BuildResult {
  rejected?: string;
}

/**
 * Build roads on the given tiles. Only empty, unbuilt tiles are paved;
 * existing roads on the path are kept (and not charged again). With
 * `avenue`, empty tiles become avenues and existing streets are
 * upgraded for the price difference; existing avenues are skipped.
 */
export function buildRoads(state: SimState, tiles: number[], avenue = false): BuildResult {
  const { layers } = state;
  const isUpgrade = (index: number): boolean =>
    avenue &&
    layers.tileType[index] === TileType.Road &&
    layers.roadClass[index] === RoadClass.Street;
  const buildable = tiles.filter(
    (index) => isUpgrade(index) || isBuildable(state, index, BuildIntent.Road),
  );
  if (buildable.length === 0) return {};

  const cost = buildable.reduce(
    (sum, index) =>
      sum +
      Math.round(roadPrice(state, index, avenue) * slopeCostMultiplier(state, index)) +
      fellingCost(state, index),
    0,
  );
  if (cost > state.money) {
    return { rejected: 'notEnoughMoney' };
  }

  const affected = withNeighbors(state, buildable);
  const undo: UndoEntry = {
    moneyDelta: cost,
    tiles: [...affected].map((index) => snapshotTile(state, index)),
  };

  state.money -= cost;
  for (const index of buildable) {
    layers.tileType[index] = TileType.Road;
    layers.roadClass[index] = avenue ? RoadClass.Avenue : RoadClass.Street;
    layers.zone[index] = Zone.None;
    layers.density[index] = 0;
    layers.variant[index] = 0;
    clearForest(state, index);
    markDirty(state, index);
  }
  for (const index of affected) recomputeRoadMask(state, index);

  state.undoStack.push(undo);
  return {};
}

/** Base price of paving (or upgrading) one tile, before the slope surcharge. */
function roadPrice(state: SimState, index: number, avenue: boolean): number {
  const { roadPerTile, bridgePerTile, avenuePerTile, avenueBridgePerTile } = BALANCE.costs;
  const river = state.layers.terrain[index] === Terrain.River;
  if (!avenue) return river ? bridgePerTile : roadPerTile;
  const full = river ? avenueBridgePerTile : avenuePerTile;
  const alreadyRoad = state.layers.tileType[index] === TileType.Road;
  return alreadyRoad ? full - (river ? bridgePerTile : roadPerTile) : full;
}

/**
 * Remove roads, zones, buildings and plants from the given tiles. A tile
 * that carries a power line or a bus stop loses only those; whatever else
 * stands there survives for a second pass.
 */
export function bulldozeTiles(state: SimState, tiles: number[]): BuildResult {
  const { layers } = state;
  const lineTiles = tiles.filter((index) => layers.powerLine[index] !== 0);
  const stopTiles = tiles.filter((index) => layers.busStop[index] !== 0);
  const clearable = tiles.filter(
    (index) =>
      layers.powerLine[index] === 0 &&
      layers.busStop[index] === 0 &&
      (layers.tileType[index] !== TileType.Empty ||
        layers.zone[index] !== Zone.None ||
        layers.density[index] !== 0),
  );
  // Bare woodland is cleared by the bulldozer too, for the felling fee —
  // but only where there is nothing else to remove first.
  const woodTiles = tiles.filter(
    (index) =>
      layers.forest[index] !== 0 && layers.powerLine[index] === 0 && layers.busStop[index] === 0,
  );
  if (
    lineTiles.length === 0 &&
    stopTiles.length === 0 &&
    clearable.length === 0 &&
    woodTiles.length === 0
  ) {
    return {};
  }

  const felling = woodTiles.reduce((sum, index) => sum + fellingCost(state, index), 0);
  if (felling > state.money) return { rejected: 'notEnoughMoney' };

  const affected = withNeighbors(state, [...lineTiles, ...stopTiles, ...clearable, ...woodTiles]);
  const undo: UndoEntry = {
    // Positive: undoing refunds what the felling cost (see buildRoads).
    moneyDelta: felling,
    tiles: [...affected].map((index) => snapshotTile(state, index)),
  };
  state.money -= felling;
  for (const index of woodTiles) clearForest(state, index);

  if (lineTiles.length > 0) clearPowerLines(state, lineTiles);
  // Removing the wreck removes the damage with it.
  for (const index of lineTiles) layers.damage[index] = 0;
  if (stopTiles.length > 0) clearBusStops(state, stopTiles);
  for (const index of clearable) {
    layers.tileType[index] = TileType.Empty;
    layers.roadClass[index] = RoadClass.Street;
    layers.zone[index] = Zone.None;
    layers.density[index] = 0;
    layers.variant[index] = 0;
    layers.plantType[index] = 0;
    layers.buildingAge[index] = 0;
    layers.busStop[index] = 0;
    layers.damage[index] = 0;
    markDirty(state, index);
  }
  for (const index of affected) recomputeRoadMask(state, index);
  // A cleared tile may have been a plant: connectivity must be recomputed.
  if (clearable.length > 0) bumpGridVersion(state);

  state.undoStack.push(undo);
  return {};
}

/** Revert the most recent build/bulldoze action. */
export function undoLastAction(state: SimState): BuildResult {
  const entry = state.undoStack.pop();
  if (!entry) return { rejected: 'nothingToUndo' };

  const { layers } = state;
  state.money += entry.moneyDelta;
  for (const tile of entry.tiles) {
    layers.tileType[tile.index] = tile.tileType;
    layers.roadMask[tile.index] = tile.roadMask;
    layers.roadClass[tile.index] = tile.roadClass;
    layers.busStop[tile.index] = tile.busStop;
    layers.powerLine[tile.index] = tile.powerLine;
    layers.zone[tile.index] = tile.zone;
    layers.density[tile.index] = tile.density;
    layers.variant[tile.index] = tile.variant;
    layers.plantType[tile.index] = tile.plantType;
    layers.forest[tile.index] = tile.forest;
    layers.damage[tile.index] = tile.damage;
    markDirty(state, tile.index);
  }
  bumpGridVersion(state);
  return {};
}
