import { BALANCE, OVERPASS_RAMP_TILES } from '../shared/constants.ts';
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
  withNeighbors,
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

/**
 * The tiles `steps` away from `index` along `axis`, both ways: the one
 * toward the grid's origin first (-1 when off the grid).
 */
function alongAxis(state: SimState, index: number, axis: Axis, steps: number): [number, number] {
  const x = tileX(index, state.size);
  const y = tileY(index, state.size);
  const inside = (nx: number, ny: number) =>
    nx >= 0 && ny >= 0 && nx < state.size && ny < state.size ? tileIndex(nx, ny, state.size) : -1;
  return axis === 'ns'
    ? [inside(x, y - steps), inside(x, y + steps)]
    : [inside(x - steps, y), inside(x + steps, y)];
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

/** The connection bit from a ramp at `ramp` toward its deck at `deck` (4-neighbours). */
function bitToward(state: SimState, ramp: number, deck: number): number {
  const dx = tileX(deck, state.size) - tileX(ramp, state.size);
  const dy = tileY(deck, state.size) - tileY(ramp, state.size);
  if (dx > 0) return DIR_E;
  if (dx < 0) return DIR_W;
  return dy > 0 ? DIR_S : DIR_N;
}

/**
 * Whether `index` can serve as a ramp tile of an overpass at `deck`: a
 * plain road tile whose road runs straight along the axis or — on the
 * far tile only — dead-ends toward the deck. A ramp with a side arm
 * would be drawn without it and cars turning off it would meet the
 * slope mid-height.
 */
function isRampTile(
  state: SimState,
  index: number,
  deck: number,
  axis: Axis,
  far: boolean,
): boolean {
  if (index < 0) return false;
  const { layers } = state;
  if (layers.tileType[index] !== TileType.Road) return false;
  if (layers.rail[index] !== 0) return false;
  const road = layers.roadMask[index] & SIDES;
  const straight = road === (axis === 'ns' ? AXIS_NS : AXIS_EW);
  if (!straight && !(far && road === bitToward(state, index, deck))) return false;
  if (layers.terrain[index] === Terrain.River) return false;
  return layers.overpass[index] === 0;
}

/**
 * Whether both ramps of a deck at `index` with road `axis` have room:
 * OVERPASS_RAMP_TILES plain road tiles on each side, and no other
 * overpass of the same axis close enough for its ramps to overlap them.
 */
function hasRampRoom(state: SimState, index: number, axis: Axis): boolean {
  for (let step = 1; step <= OVERPASS_RAMP_TILES; step++) {
    const far = step === OVERPASS_RAMP_TILES;
    for (const tile of alongAxis(state, index, axis, step)) {
      if (!isRampTile(state, tile, index, axis, far)) return false;
    }
  }
  for (let step = OVERPASS_RAMP_TILES + 1; step <= 2 * OVERPASS_RAMP_TILES; step++) {
    for (const tile of alongAxis(state, index, axis, step)) {
      if (tile >= 0 && state.layers.overpass[tile] !== 0 && crossingRoadAxis(state, tile) === axis)
        return false;
    }
  }
  return true;
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
  if (!hasRampRoom(state, index, road)) return 'needsRampRoom';
  if (layers.damage[index] !== 0) return 'damaged';
  return null;
}

/** Whether an existing overpass at `index` still meets its build rules. */
export function overpassStillValid(state: SimState, index: number): boolean {
  const axis = crossingRoadAxis(state, index);
  if (axis === null || state.layers.terrain[index] === Terrain.River) return false;
  return hasRampRoom(state, index, axis);
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
  // Tile by tile, each one set before the next is checked, so two
  // crossings of one drag cannot both claim the road tile between them.
  const built: number[] = [];
  const snapshots: UndoEntry['tiles'] = [];
  let firstRejection: string | null = null;
  for (const index of fresh) {
    if (layers.overpass[index] !== 0) continue;
    const rejection = overpassRejection(state, index);
    if (rejection !== null) {
      firstRejection ??= rejection;
      continue;
    }
    snapshots.push(snapshotTile(state, index));
    layers.overpass[index] = 1;
    built.push(index);
  }
  if (built.length === 0) return { rejected: firstRejection ?? 'needsLevelCrossing' };
  const cost = built.length * BALANCE.costs.overpass;
  if (cost > state.money) {
    for (const index of built) layers.overpass[index] = 0;
    return { rejected: 'notEnoughMoney' };
  }
  state.money -= cost;
  for (const index of built) markDirty(state, index);
  state.undoStack.push({ moneyDelta: cost, tiles: snapshots });
  return {};
}

/**
 * Drop every overpass whose crossing or ramp room is gone (no refund).
 * Callers pass the edited tiles plus their 4-neighbours; as many more
 * rings as the ramp is long are checked here, since a road arm joining
 * the far ramp tile changes that tile's mask.
 */
export function clearInvalidOverpasses(state: SimState, tiles: Iterable<number>): void {
  const { layers } = state;
  let ring = new Set<number>(tiles);
  for (let i = 0; i < OVERPASS_RAMP_TILES; i++) ring = withNeighbors(state, [...ring]);
  for (const index of ring) {
    if (layers.overpass[index] === 0) continue;
    if (overpassStillValid(state, index)) continue;
    layers.overpass[index] = 0;
    markDirty(state, index);
  }
}
