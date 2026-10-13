import { describe, expect, it } from 'vitest';
import { BALANCE } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { buildOverpasses, overpassRejection } from './overpass.ts';
import { buildRail } from './rail.ts';
import { buildRoads, bulldozeTiles, undoLastAction } from './roads.ts';
import { collectDiffs, createSimState, Terrain, type SimState } from './state.ts';

const SIZE = 16;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);
const CROSSING = at(5, 8);

/** A north-south road crossed by an east-west track at (5, 8). */
function crossingTown(): SimState {
  const state = createSimState(1, SIZE);
  state.layers.elevation.fill(0);
  state.money = 1e6;
  buildRoads(
    state,
    Array.from({ length: 12 }, (_, i) => at(5, i + 2)),
  );
  buildRail(
    state,
    Array.from({ length: 12 }, (_, i) => at(i + 2, 8)),
  );
  return state;
}

describe('buildOverpasses', () => {
  it('upgrades a straight level crossing for the overpass price', () => {
    const state = crossingTown();
    const before = state.money;
    expect(buildOverpasses(state, [CROSSING])).toEqual({});
    expect(state.layers.overpass[CROSSING]).toBe(1);
    expect(state.money).toBe(before - BALANCE.costs.overpass);
    expect(collectDiffs(state).find((d) => d.index === CROSSING)?.overpass).toBe(1);
  });

  it('a second click on the same tile is silent and free', () => {
    const state = crossingTown();
    buildOverpasses(state, [CROSSING]);
    const before = state.money;
    expect(buildOverpasses(state, [CROSSING])).toEqual({});
    expect(state.money).toBe(before);
  });

  it('undo restores the plain crossing and refunds the price', () => {
    const state = crossingTown();
    const before = state.money;
    buildOverpasses(state, [CROSSING]);
    expect(undoLastAction(state)).toEqual({});
    expect(state.layers.overpass[CROSSING]).toBe(0);
    expect(state.money).toBe(before);
  });

  it('rejects a tile that is no level crossing', () => {
    const state = crossingTown();
    expect(overpassRejection(state, at(5, 4))).toBe('needsLevelCrossing'); // road, no track
    expect(overpassRejection(state, at(3, 8))).toBe('needsLevelCrossing'); // track, no road
    expect(overpassRejection(state, at(9, 12))).toBe('needsLevelCrossing'); // empty
    expect(buildOverpasses(state, [at(5, 4)])).toEqual({ rejected: 'needsLevelCrossing' });
  });

  it('rejects a crossing on a river tile', () => {
    const state = crossingTown();
    state.layers.terrain[CROSSING] = Terrain.River;
    expect(overpassRejection(state, CROSSING)).toBe('needsLevelCrossing');
  });

  it('rejects a bend or junction of the track', () => {
    const state = crossingTown();
    buildRail(state, [at(5, 7)]); // spur north out of the crossing: a junction
    expect(overpassRejection(state, CROSSING)).toBe('needsLevelCrossing');
  });

  it('rejects a road that is not straight across the track', () => {
    const state = crossingTown();
    buildRoads(state, [at(6, 8)]); // a road arm east along the track: T-junction
    expect(overpassRejection(state, CROSSING)).toBe('needsStraightCrossing');
  });

  it('rejects a crossing without ramp room', () => {
    const state = crossingTown();
    // A missing road neighbour also takes the road's arm with it, so the
    // straightness rule rejects first; ramp room is about what the road
    // neighbour carries.
    bulldozeTiles(state, [at(5, 9)]); // south neighbour gone
    expect(overpassRejection(state, CROSSING)).toBe('needsStraightCrossing');
    const river = crossingTown();
    river.layers.terrain[at(5, 7)] = Terrain.River; // under the north ramp
    expect(overpassRejection(river, CROSSING)).toBe('needsRampRoom');
    const stacked = crossingTown();
    buildRail(
      stacked,
      Array.from({ length: 12 }, (_, i) => at(i + 2, 10)),
    );
    buildOverpasses(stacked, [at(5, 10)]); // (5, 9) is now that overpass's ramp
    expect(overpassRejection(stacked, CROSSING)).toBe('needsRampRoom');
  });

  it('rejects a damaged tile and short funds', () => {
    const state = crossingTown();
    state.layers.damage[CROSSING] = 1;
    expect(overpassRejection(state, CROSSING)).toBe('damaged');
    const poor = crossingTown();
    poor.money = BALANCE.costs.overpass - 1;
    expect(buildOverpasses(poor, [CROSSING])).toEqual({ rejected: 'notEnoughMoney' });
    expect(poor.layers.overpass[CROSSING]).toBe(0);
  });
});

describe('overpass removal', () => {
  it('goes when its track is removed', () => {
    const state = crossingTown();
    buildOverpasses(state, [CROSSING]);
    bulldozeTiles(state, [CROSSING]); // clears the track (and the road)
    expect(state.layers.overpass[CROSSING]).toBe(0);
  });

  it('goes when a ramp road is bulldozed', () => {
    const state = crossingTown();
    buildOverpasses(state, [CROSSING]);
    bulldozeTiles(state, [at(5, 7)]);
    expect(state.layers.overpass[CROSSING]).toBe(0);
  });

  it('goes when the track becomes a junction', () => {
    const state = crossingTown();
    buildOverpasses(state, [CROSSING]);
    buildRail(state, [at(5, 7)]);
    expect(state.layers.overpass[CROSSING]).toBe(0);
  });

  it('goes when the road grows an arm along the track', () => {
    const state = crossingTown();
    buildOverpasses(state, [CROSSING]);
    buildRoads(state, [at(6, 8)]);
    expect(state.layers.overpass[CROSSING]).toBe(0);
  });

  it('survives an avenue upgrade of its ramps and of itself', () => {
    const state = crossingTown();
    buildOverpasses(state, [CROSSING]);
    buildRoads(state, [at(5, 7), CROSSING, at(5, 9)], true);
    expect(state.layers.overpass[CROSSING]).toBe(1);
  });

  it('removal is covered by the undo of the removing action', () => {
    const state = crossingTown();
    buildOverpasses(state, [CROSSING]);
    bulldozeTiles(state, [at(5, 9)]);
    undoLastAction(state);
    expect(state.layers.overpass[CROSSING]).toBe(1);
  });
});
