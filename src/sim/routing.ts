import { BALANCE } from '../shared/constants.ts';
import { neighbors4 } from '../shared/grid.ts';
import { MinHeap } from '../shared/heap.ts';
import { RoadClass } from '../shared/types.ts';
import { TileType, type SimState } from './state.ts';

type TilePredicate = (tile: number) => boolean;
type TileCostFn = (tile: number) => number;

/** Cost of driving onto a road tile: avenues are cheaper, loaded tiles dearer. */
export function tileCost(state: SimState, tile: number): number {
  const { roadClass, trafficLoad } = state.layers;
  const base = roadClass[tile] === RoadClass.Avenue ? 1 / BALANCE.vehicles.avenueSpeedFactor : 1;
  return base * (1 + BALANCE.vehicles.routeLoadPenalty * (trafficLoad[tile] / 255));
}

/**
 * Cheapest route over tiles accepted by `passable` from `from` to `to`
 * (both included), or null when they are not connected. Dijkstra with
 * per-tile `cost`; ties break by tile index, so the result is
 * deterministic.
 */
export function findPath(
  state: SimState,
  from: number,
  to: number,
  passable: TilePredicate,
  cost: TileCostFn,
): number[] | null {
  if (!passable(from) || !passable(to)) return null;
  if (from === to) return [from];
  const tiles = state.size * state.size;
  const distance = new Float64Array(tiles).fill(Infinity);
  const cameFrom = new Int32Array(tiles).fill(-1);
  const settled = new Uint8Array(tiles);
  const heap = new MinHeap();
  distance[from] = 0;
  heap.push(0, from);
  while (heap.size > 0) {
    const tile = heap.pop()!;
    if (settled[tile]) continue;
    settled[tile] = 1;
    if (tile === to) break;
    for (const neighbor of neighbors4(tile, state.size)) {
      if (!passable(neighbor) || settled[neighbor]) continue;
      const next = distance[tile] + cost(neighbor);
      if (next < distance[neighbor]) {
        distance[neighbor] = next;
        cameFrom[neighbor] = tile;
        heap.push(next, neighbor);
      }
    }
  }
  if (cameFrom[to] === -1) return null;
  const path = [to];
  let current = to;
  while (current !== from) {
    current = cameFrom[current];
    path.push(current);
  }
  return path.reverse();
}

/**
 * Route cost from `from` to every passable tile reachable within
 * `maxCost`. Empty when `from` is not passable.
 */
export function distances(
  state: SimState,
  from: number,
  passable: TilePredicate,
  cost: TileCostFn,
  maxCost: number = Infinity,
): Map<number, number> {
  const result = new Map<number, number>();
  if (!passable(from)) return result;
  const tiles = state.size * state.size;
  const distance = new Float64Array(tiles).fill(Infinity);
  const settled = new Uint8Array(tiles);
  const heap = new MinHeap();
  distance[from] = 0;
  heap.push(0, from);
  while (heap.size > 0) {
    const tile = heap.pop()!;
    if (settled[tile]) continue;
    settled[tile] = 1;
    result.set(tile, distance[tile]);
    for (const neighbor of neighbors4(tile, state.size)) {
      if (!passable(neighbor) || settled[neighbor]) continue;
      const next = distance[tile] + cost(neighbor);
      if (next > maxCost || next >= distance[neighbor]) continue;
      distance[neighbor] = next;
      heap.push(next, neighbor);
    }
  }
  return result;
}

const isRoad = (state: SimState) => (tile: number) => state.layers.tileType[tile] === TileType.Road;
const isTrack = (state: SimState) => (tile: number) => state.layers.rail[tile] !== 0;
const flat = () => 1;

/** Road route (see findPath): road class and traffic load price the tiles. */
export function findRoadPath(state: SimState, from: number, to: number): number[] | null {
  return findPath(state, from, to, isRoad(state), (tile) => tileCost(state, tile));
}

export function roadDistances(
  state: SimState,
  from: number,
  maxCost: number = Infinity,
): Map<number, number> {
  return distances(state, from, isRoad(state), (tile) => tileCost(state, tile), maxCost);
}

/** Track route: every track tile costs 1, traffic and road class are irrelevant. */
export function findRailPath(state: SimState, from: number, to: number): number[] | null {
  return findPath(state, from, to, isTrack(state), flat);
}

export function railDistances(
  state: SimState,
  from: number,
  maxCost: number = Infinity,
): Map<number, number> {
  return distances(state, from, isTrack(state), flat, maxCost);
}
