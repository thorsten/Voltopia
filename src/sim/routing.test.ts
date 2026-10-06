import { describe, expect, it } from 'vitest';
import { tileIndex } from '../shared/grid.ts';
import {
  findRoadPath,
  roadDistances,
  findRailPath,
  railDistances,
  nearestNeighbourOrder,
} from './routing.ts';
import { buildRoads } from './roads.ts';
import { buildRail } from './rail.ts';
import { createSimState } from './state.ts';

const SIZE = 24;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);

/** One straight street from (2,10) to (20,10) plus a stub going south at x=10. */
function town() {
  const state = createSimState(1, SIZE);
  buildRoads(
    state,
    Array.from({ length: 19 }, (_, i) => at(i + 2, 10)),
  );
  buildRoads(state, [at(10, 11), at(10, 12), at(10, 13)]);
  return state;
}

describe('roadDistances', () => {
  it('matches path lengths on an unloaded street map', () => {
    const state = town();
    const distances = roadDistances(state, at(2, 10));
    expect(distances.get(at(2, 10))).toBe(0);
    expect(distances.get(at(20, 10))).toBe(18);
    expect(distances.get(at(10, 13))).toBe(findRoadPath(state, at(2, 10), at(10, 13))!.length - 1);
  });

  it('omits tiles beyond maxCost and non-road tiles', () => {
    const state = town();
    const distances = roadDistances(state, at(2, 10), 5);
    expect(distances.has(at(7, 10))).toBe(true);
    expect(distances.has(at(8, 10))).toBe(false);
    expect(distances.has(at(2, 9))).toBe(false);
  });

  it('is empty from a non-road tile', () => {
    const state = town();
    expect(roadDistances(state, at(0, 0)).size).toBe(0);
  });

  it('is deterministic', () => {
    const a = [...roadDistances(town(), at(2, 10)).entries()];
    const b = [...roadDistances(town(), at(2, 10)).entries()];
    expect(a).toEqual(b);
  });
});

describe('rail routing', () => {
  /** Track from (2,5) to (20,5) with a branch south at x = 10; a road crosses at x = 6. */
  function rails() {
    const state = createSimState(1, SIZE);
    state.layers.elevation.fill(0);
    state.money = 1e9;
    buildRail(
      state,
      Array.from({ length: 19 }, (_, i) => at(i + 2, 5)),
    );
    buildRail(state, [at(10, 6), at(10, 7)]);
    buildRoads(state, [at(6, 4), at(6, 5), at(6, 6)]);
    return state;
  }

  it('routes along track, through a level crossing, never onto plain roads', () => {
    const state = rails();
    const path = findRailPath(state, at(2, 5), at(10, 7));
    expect(path).not.toBeNull();
    expect(path![0]).toBe(at(2, 5));
    expect(path![path!.length - 1]).toBe(at(10, 7));
    expect(path).toContain(at(6, 5));
    expect(path).not.toContain(at(6, 4));
    expect(path!.length).toBe(11);
    expect(findRailPath(state, at(2, 5), at(6, 4))).toBeNull();
  });

  it('rail distances ignore traffic load and road class', () => {
    const state = rails();
    state.layers.trafficLoad[at(6, 5)] = 255;
    const d = railDistances(state, at(2, 5));
    expect(d.get(at(20, 5))).toBe(18);
    expect(d.get(at(10, 7))).toBe(10);
    expect(d.has(at(6, 4))).toBe(false);
    expect(railDistances(state, at(2, 5), 3).has(at(6, 5))).toBe(false);
    expect(railDistances(state, at(0, 0)).size).toBe(0);
  });

  it('findRoadPath still refuses track-only tiles', () => {
    const state = rails();
    expect(findRoadPath(state, at(6, 4), at(2, 5))).toBeNull();
  });
});

describe('nearestNeighbourOrder', () => {
  it('breaks a cost tie by the lower tile index and recomputes the map from each pick', () => {
    const a = at(1, 0);
    const b = at(2, 0);
    const c = at(3, 0);
    const remaining = new Set([b, c, a]);
    const initial = new Map([
      [a, 5],
      [b, 5], // tied with a; a wins on the lower tile index
      [c, 8],
    ]);
    const fromA = new Map([
      [b, 2],
      [c, 100],
    ]);
    const fromB = new Map([[c, 1]]);
    const distancesFrom = (tile: number) => (tile === a ? fromA : fromB);
    expect(nearestNeighbourOrder(remaining, distancesFrom, initial)).toEqual([a, b, c]);
    expect(remaining.size).toBe(0);
  });

  it('stops and leaves the rest in `remaining` once nothing left is reachable', () => {
    const a = at(1, 0);
    const b = at(2, 0);
    const remaining = new Set([a, b]);
    expect(nearestNeighbourOrder(remaining, () => new Map(), new Map())).toEqual([]);
    expect(remaining.size).toBe(2);
  });
});
