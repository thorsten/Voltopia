import { describe, expect, it } from 'vitest';
import { BALANCE } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { RoadLane, Terrain } from '../shared/types.ts';
import { buildLanes } from './lanes.ts';
import { buildOverpasses } from './overpass.ts';
import { buildRail } from './rail.ts';
import { buildRoads, bulldozeTiles, undoLastAction } from './roads.ts';
import { createSimState, type SimState } from './state.ts';
import { buildBusStops } from './transit.ts';

const SIZE = 16;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);

function town(): SimState {
  const state = createSimState(1, SIZE);
  state.layers.elevation.fill(0);
  state.layers.terrain.fill(Terrain.Land);
  state.money = 100_000;
  buildRoads(
    state,
    Array.from({ length: 10 }, (_, x) => at(x + 2, 8)),
  );
  return state;
}

describe('buildLanes', () => {
  it('paints bike lanes on road tiles, skips the rest, charges per changed tile', () => {
    const state = town();
    const before = state.money;
    const result = buildLanes(state, [at(2, 8), at(3, 8), at(3, 3)], RoadLane.Bike);
    expect(result).toEqual({});
    expect(state.layers.roadLane[at(2, 8)]).toBe(RoadLane.Bike);
    expect(state.layers.roadLane[at(3, 3)]).toBe(RoadLane.None);
    expect(before - state.money).toBe(2 * BALANCE.costs.bikeLanePerTile);
  });

  it('does not charge tiles that already carry the kind, rejects a batch with nothing to build', () => {
    const state = town();
    buildLanes(state, [at(2, 8)], RoadLane.Bike);
    const before = state.money;
    expect(buildLanes(state, [at(2, 8)], RoadLane.Bike)).toEqual({});
    expect(state.money).toBe(before);
    expect(buildLanes(state, [at(3, 3)], RoadLane.Bike)).toEqual({ rejected: 'needsExistingRoad' });
  });

  it('switching kinds pays the full price of the new kind; None is free', () => {
    const state = town();
    buildLanes(state, [at(2, 8)], RoadLane.Bike);
    const before = state.money;
    buildLanes(state, [at(2, 8)], RoadLane.Pedestrian);
    expect(before - state.money).toBe(BALANCE.costs.pedestrianPerTile);
    const mid = state.money;
    buildLanes(state, [at(2, 8)], RoadLane.None);
    expect(state.money).toBe(mid);
    expect(state.layers.roadLane[at(2, 8)]).toBe(RoadLane.None);
  });

  it('rejects when the treasury cannot pay', () => {
    const state = town();
    state.money = BALANCE.costs.pedestrianPerTile - 1;
    expect(buildLanes(state, [at(2, 8)], RoadLane.Pedestrian)).toEqual({
      rejected: 'notEnoughMoney',
    });
    expect(state.layers.roadLane[at(2, 8)]).toBe(RoadLane.None);
  });

  it('refuses a pedestrian street on a bus stop, a bridge, a level crossing or an overpass', () => {
    const state = town();
    buildBusStops(state, [at(2, 8)]);
    expect(buildLanes(state, [at(2, 8)], RoadLane.Pedestrian)).toEqual({
      rejected: 'pedestrianBlocked',
    });
    // Bike lanes are fine there.
    expect(buildLanes(state, [at(2, 8)], RoadLane.Bike)).toEqual({});

    state.layers.terrain[at(4, 8)] = Terrain.River;
    expect(buildLanes(state, [at(4, 8)], RoadLane.Pedestrian)).toEqual({
      rejected: 'pedestrianBlocked',
    });

    buildRail(state, [at(6, 6), at(6, 7), at(6, 8), at(6, 9), at(6, 10)]);
    expect(buildLanes(state, [at(6, 8)], RoadLane.Pedestrian)).toEqual({
      rejected: 'pedestrianBlocked',
    });
    expect(buildOverpasses(state, [at(6, 8)])).toEqual({});
    // Ramp tiles (5,8) and (7,8) are blocked too.
    expect(buildLanes(state, [at(7, 8)], RoadLane.Pedestrian)).toEqual({
      rejected: 'pedestrianBlocked',
    });
    // A mixed batch builds the allowed tiles and stays silent about the rest.
    expect(buildLanes(state, [at(7, 8), at(9, 8)], RoadLane.Pedestrian)).toEqual({});
    expect(state.layers.roadLane[at(9, 8)]).toBe(RoadLane.Pedestrian);
  });

  it('undo restores the previous lanes and refunds', () => {
    const state = town();
    buildLanes(state, [at(2, 8), at(3, 8)], RoadLane.Bike);
    const before = state.money;
    buildLanes(state, [at(2, 8)], RoadLane.Pedestrian);
    undoLastAction(state);
    expect(state.money).toBe(before);
    expect(state.layers.roadLane[at(2, 8)]).toBe(RoadLane.Bike);
  });

  it('bulldozing a road clears its lane; undoing the bulldoze brings the lane back', () => {
    const state = town();
    buildLanes(state, [at(2, 8)], RoadLane.Pedestrian);
    bulldozeTiles(state, [at(2, 8)]);
    expect(state.layers.roadLane[at(2, 8)]).toBe(RoadLane.None);
    undoLastAction(state);
    expect(state.layers.roadLane[at(2, 8)]).toBe(RoadLane.Pedestrian);
  });
});
