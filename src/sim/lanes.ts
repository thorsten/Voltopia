import { BALANCE } from '../shared/constants.ts';
import { LINE_PRESENT } from '../shared/grid.ts';
import { RoadLane } from '../shared/types.ts';
import type { BuildResult } from './roads.ts';
import {
  markDirty,
  snapshotTile,
  Terrain,
  TileType,
  type SimState,
  type UndoEntry,
} from './state.ts';
import { isOverpassRamp } from './overpass.ts';

/** Price of putting `kind` on one road tile (None is free). */
export function lanePrice(kind: RoadLane): number {
  if (kind === RoadLane.Bike) return BALANCE.costs.bikeLanePerTile;
  if (kind === RoadLane.Pedestrian) return BALANCE.costs.pedestrianPerTile;
  return 0;
}

/**
 * Why `kind` cannot go on `index`, or null when it can. A pedestrian
 * street closes the tile to motor traffic, so it is refused where a bus
 * stop stands, where the road bridges the river, on a level crossing
 * and on an overpass deck or ramp.
 */
export function laneRejection(state: SimState, index: number, kind: RoadLane): string | null {
  const { layers } = state;
  if (layers.tileType[index] !== TileType.Road) return 'needsExistingRoad';
  if (kind !== RoadLane.Pedestrian) return null;
  if (layers.busStop[index] !== 0) return 'pedestrianBlocked';
  if (layers.terrain[index] === Terrain.River) return 'pedestrianBlocked';
  if ((layers.rail[index] & LINE_PRESENT) !== 0) return 'pedestrianBlocked';
  if (layers.overpass[index] !== 0 || isOverpassRamp(state, index)) return 'pedestrianBlocked';
  return null;
}

/**
 * Put `kind` on the given road tiles. Tiles already carrying it are
 * skipped and not charged; tiles that refuse it are skipped silently
 * unless nothing at all is built, when the first reason is reported.
 */
export function buildLanes(state: SimState, tiles: number[], kind: RoadLane): BuildResult {
  const { layers } = state;
  const built: number[] = [];
  let firstRejection: string | null = null;
  for (const index of tiles) {
    if (layers.tileType[index] === TileType.Road && layers.roadLane[index] === kind) continue;
    const rejection = laneRejection(state, index, kind);
    if (rejection !== null) {
      firstRejection ??= rejection;
      continue;
    }
    built.push(index);
  }
  if (built.length === 0) return firstRejection ? { rejected: firstRejection } : {};
  const cost = built.length * lanePrice(kind);
  if (cost > state.money) return { rejected: 'notEnoughMoney' };
  const undo: UndoEntry = {
    moneyDelta: cost,
    tiles: built.map((index) => snapshotTile(state, index)),
  };
  state.money -= cost;
  for (const index of built) {
    layers.roadLane[index] = kind;
    markDirty(state, index);
  }
  state.undoStack.push(undo);
  return {};
}
