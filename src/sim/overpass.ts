import { BALANCE } from '../shared/constants.ts';
import {
  DIR_E,
  DIR_N,
  DIR_S,
  DIR_W,
  LINE_PRESENT,
  tileIndex,
  tileX,
  tileY,
} from '../shared/grid.ts';
import type { BuildResult } from './roads.ts';
import {
  markDirty,
  snapshotTile,
  Terrain,
  TileType,
  type SimState,
  type UndoEntry,
} from './state.ts';

const AXIS_NS = DIR_N | DIR_S;
const AXIS_EW = DIR_E | DIR_W;
const SIDES = DIR_N | DIR_E | DIR_S | DIR_W;

type Axis = 'ns' | 'ew';

/** The axis a straight mask runs along: 'ns', 'ew', or null for anything else. */
function straightAxis(bits: number): Axis | null {
  if (bits === AXIS_NS) return 'ns';
  if (bits === AXIS_EW) return 'ew';
  return null;
}

/** The two tiles on either side of `index` along `axis` (-1 when off the grid). */
function alongAxis(state: SimState, index: number, axis: Axis): [number, number] {
  const x = tileX(index, state.size);
  const y = tileY(index, state.size);
  const inside = (nx: number, ny: number) =>
    nx >= 0 && ny >= 0 && nx < state.size && ny < state.size ? tileIndex(nx, ny, state.size) : -1;
  return axis === 'ns'
    ? [inside(x, y - 1), inside(x, y + 1)]
    : [inside(x - 1, y), inside(x + 1, y)];
}

/**
 * The road axis of an overpass-shaped tile: a road tile with straight
 * track and a straight road across it. Null otherwise.
 */
function crossingRoadAxis(state: SimState, index: number): Axis | null {
  const { layers } = state;
  if (layers.tileType[index] !== TileType.Road) return null;
  if ((layers.rail[index] & LINE_PRESENT) === 0) return null;
  const track = straightAxis(layers.rail[index] & SIDES);
  const road = straightAxis(layers.roadMask[index] & SIDES);
  if (track === null || road === null || track === road) return null;
  return road;
}

/** Whether `index` can serve as a ramp of an overpass at `deck`: a plain road tile. */
function isRampRoom(state: SimState, index: number, deck: number, axis: Axis): boolean {
  if (index < 0) return false;
  const { layers } = state;
  if (layers.tileType[index] !== TileType.Road) return false;
  if (layers.rail[index] !== 0) return false;
  if (layers.terrain[index] === Terrain.River) return false;
  if (layers.overpass[index] !== 0) return false;
  // Not already the ramp of an overpass on its other side along the same axis.
  const [a, b] = alongAxis(state, index, axis);
  const other = a === deck ? b : a;
  return !(other >= 0 && layers.overpass[other] !== 0 && crossingRoadAxis(state, other) === axis);
}

/**
 * Why an overpass cannot be built on `index`, or null when it can. The
 * checks run in order: level crossing with straight track, straight road
 * across it, ramp room on both sides, no damage.
 */
export function overpassRejection(state: SimState, index: number): string | null {
  const { layers } = state;
  if (layers.tileType[index] !== TileType.Road || (layers.rail[index] & LINE_PRESENT) === 0)
    return 'needsLevelCrossing';
  if (layers.terrain[index] === Terrain.River) return 'needsLevelCrossing';
  const track = straightAxis(layers.rail[index] & SIDES);
  if (track === null) return 'needsLevelCrossing';
  const road = straightAxis(layers.roadMask[index] & SIDES);
  if (road === null || road === track) return 'needsStraightCrossing';
  const [a, b] = alongAxis(state, index, road);
  if (!isRampRoom(state, a, index, road) || !isRampRoom(state, b, index, road))
    return 'needsRampRoom';
  if (layers.damage[index] !== 0) return 'damaged';
  return null;
}

/** Whether an existing overpass at `index` still meets its build rules. */
export function overpassStillValid(state: SimState, index: number): boolean {
  const axis = crossingRoadAxis(state, index);
  if (axis === null || state.layers.terrain[index] === Terrain.River) return false;
  const [a, b] = alongAxis(state, index, axis);
  return isRampRoom(state, a, index, axis) && isRampRoom(state, b, index, axis);
}

/**
 * Upgrade level crossings to road overpasses. Tiles that already carry
 * one are skipped without charge; a click that builds nothing reports
 * the first tile's rejection.
 */
export function buildOverpasses(state: SimState, tiles: number[]): BuildResult {
  const { layers } = state;
  const fresh = tiles.filter((index) => layers.overpass[index] === 0);
  if (fresh.length === 0) return {};
  const buildable = fresh.filter((index) => overpassRejection(state, index) === null);
  if (buildable.length === 0) {
    return { rejected: overpassRejection(state, fresh[0]) ?? 'needsLevelCrossing' };
  }
  const cost = buildable.length * BALANCE.costs.overpass;
  if (cost > state.money) return { rejected: 'notEnoughMoney' };

  const undo: UndoEntry = {
    moneyDelta: cost,
    tiles: buildable.map((index) => snapshotTile(state, index)),
  };
  state.money -= cost;
  for (const index of buildable) {
    layers.overpass[index] = 1;
    markDirty(state, index);
  }
  state.undoStack.push(undo);
  return {};
}

/**
 * Drop every overpass among `tiles` whose crossing or ramp room is gone
 * (no refund). Callers pass the edited tiles plus their 4-neighbours.
 */
export function clearInvalidOverpasses(state: SimState, tiles: Iterable<number>): void {
  const { layers } = state;
  for (const index of tiles) {
    if (layers.overpass[index] === 0) continue;
    if (overpassStillValid(state, index)) continue;
    layers.overpass[index] = 0;
    markDirty(state, index);
  }
}
