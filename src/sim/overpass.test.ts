import { describe, expect, it } from 'vitest';
import {
  BALANCE,
  OVERPASS_LONG_RAMP_TILES as LONG,
  OVERPASS_SHORT_RAMP_TILES as SHORT,
} from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { buildOverpasses, isOverpassRamp, overpassRejection } from './overpass.ts';
import { buildRail } from './rail.ts';
import { buildRoads, bulldozeTiles, undoLastAction } from './roads.ts';
import {
  collectDiffs,
  createSimState,
  deserializeState,
  serializeState,
  Terrain,
  type SimState,
} from './state.ts';

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
    expect(state.layers.overpass[CROSSING]).toBe(LONG);
    expect(state.money).toBe(before - BALANCE.costs.overpass);
    expect(collectDiffs(state).find((d) => d.index === CROSSING)?.overpass).toBe(LONG);
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
    const farRiver = crossingTown();
    farRiver.layers.terrain[at(5, 10)] = Terrain.River; // under the far south ramp tile
    expect(overpassRejection(farRiver, CROSSING)).toBeNull(); // short ramps still fit
    const stacked = crossingTown();
    buildRail(
      stacked,
      Array.from({ length: 12 }, (_, i) => at(i + 2, 11)),
    );
    expect(buildOverpasses(stacked, [at(5, 11)])).toEqual({}); // its ramps (5, 9), (5, 10) overlap ours
    expect(overpassRejection(stacked, CROSSING)).toBe('needsRampRoom');
  });

  it('a side street two tiles out leaves room for short ramps only', () => {
    const state = crossingTown();
    buildRoads(state, [at(6, 10)]); // side street off the far south ramp tile
    expect(overpassRejection(state, CROSSING)).toBeNull();
    expect(buildOverpasses(state, [CROSSING])).toEqual({});
    expect(state.layers.overpass[CROSSING]).toBe(SHORT);
    expect(collectDiffs(state).find((d) => d.index === CROSSING)?.overpass).toBe(SHORT);
    const fine = crossingTown();
    buildRoads(fine, [at(6, 11)]); // three tiles out: beyond the ramp
    expect(overpassRejection(fine, CROSSING)).toBeNull();
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
    expect(state.layers.overpass[CROSSING]).toBe(LONG);
  });

  it('removal is covered by the undo of the removing action', () => {
    const state = crossingTown();
    buildOverpasses(state, [CROSSING]);
    bulldozeTiles(state, [at(5, 9)]);
    undoLastAction(state);
    expect(state.layers.overpass[CROSSING]).toBe(LONG);
  });
});

describe('overpass save games', () => {
  it('survives serialize → deserialize', () => {
    const state = crossingTown();
    buildOverpasses(state, [CROSSING]);
    const restored = deserializeState(serializeState(state));
    expect(restored.layers.overpass[CROSSING]).toBe(LONG);
  });

  it('loads a save without the layer as all zeros', () => {
    const state = crossingTown();
    buildOverpasses(state, [CROSSING]);
    const save = serializeState(state);
    delete save.layers.overpass;
    const restored = deserializeState(save);
    expect(restored.layers.overpass.every((v) => v === 0)).toBe(true);
  });
});

describe('overpass build rules after review', () => {
  it('builds the crossings of one drag one by one, so two cannot share a ramp', () => {
    const state = crossingTown();
    buildRail(
      state,
      Array.from({ length: 12 }, (_, i) => at(i + 2, 11)),
    );
    const before = state.money;
    // Crossings at (5, 8) and (5, 11) would share the ramp tiles (5, 9) and (5, 10).
    expect(buildOverpasses(state, [at(5, 8), at(5, 9), at(5, 10), at(5, 11)])).toEqual({});
    expect(state.layers.overpass[at(5, 8)]).toBe(LONG);
    expect(state.layers.overpass[at(5, 11)]).toBe(0);
    expect(state.money).toBe(before - BALANCE.costs.overpass);
  });

  it('rejects a ramp tile that is a junction, and drops the overpass when a side street joins its ramp', () => {
    const state = crossingTown();
    buildRoads(state, [at(6, 7)]); // side street off the north ramp
    expect(overpassRejection(state, CROSSING)).toBe('needsRampRoom');
    const later = crossingTown();
    buildOverpasses(later, [CROSSING]);
    buildRoads(later, [at(4, 9)]); // side street off the south ramp
    expect(later.layers.overpass[CROSSING]).toBe(0);
    const farLater = crossingTown();
    buildOverpasses(farLater, [CROSSING]);
    buildRoads(farLater, [at(4, 10)]); // side street off the far south ramp tile
    expect(farLater.layers.overpass[CROSSING]).toBe(SHORT); // degrades to short ramps
  });

  it('accepts a dead-end ramp that only leads to the deck', () => {
    const state = crossingTown();
    bulldozeTiles(state, [at(5, 2), at(5, 3), at(5, 4), at(5, 5)]);
    // (5, 6) is now a dead end pointing south, two tiles from the crossing.
    expect(overpassRejection(state, CROSSING)).toBeNull();
    bulldozeTiles(state, [at(5, 6)]);
    // Only one ramp tile left on the north side, a dead end: a short ramp.
    expect(overpassRejection(state, CROSSING)).toBeNull();
    expect(buildOverpasses(state, [CROSSING])).toEqual({});
    expect(state.layers.overpass[CROSSING]).toBe(SHORT);
  });
});

describe('overpass ramp fallback', () => {
  it('builds long ramps where both sides have room', () => {
    const state = crossingTown();
    buildOverpasses(state, [CROSSING]);
    expect(state.layers.overpass[CROSSING]).toBe(LONG);
  });

  it('builds short ramps on both sides when a junction is two tiles out on one side', () => {
    const state = crossingTown();
    buildRoads(state, [at(4, 6)]); // side street off (5, 6), north
    expect(buildOverpasses(state, [CROSSING])).toEqual({});
    expect(state.layers.overpass[CROSSING]).toBe(SHORT);
  });

  it('rejects a crossing with a junction right beside it', () => {
    const state = crossingTown();
    buildRoads(state, [at(4, 9)]);
    expect(overpassRejection(state, CROSSING)).toBe('needsRampRoom');
    expect(buildOverpasses(state, [CROSSING])).toEqual({ rejected: 'needsRampRoom' });
  });

  it('degrades long ramps to short when a side street joins two tiles out, and drops them when one joins beside', () => {
    const state = crossingTown();
    buildOverpasses(state, [CROSSING]);
    collectDiffs(state);
    buildRoads(state, [at(6, 10)]);
    expect(state.layers.overpass[CROSSING]).toBe(SHORT);
    expect(collectDiffs(state).find((d) => d.index === CROSSING)?.overpass).toBe(SHORT);
    buildRoads(state, [at(6, 7)]);
    expect(state.layers.overpass[CROSSING]).toBe(0);
  });

  it('grows back to long ramps when the side street goes, and on undo', () => {
    const state = crossingTown();
    buildOverpasses(state, [CROSSING]);
    buildRoads(state, [at(6, 10)]);
    expect(state.layers.overpass[CROSSING]).toBe(SHORT);
    undoLastAction(state);
    expect(state.layers.overpass[CROSSING]).toBe(LONG);
    buildRoads(state, [at(6, 10)]);
    bulldozeTiles(state, [at(6, 10)]);
    expect(state.layers.overpass[CROSSING]).toBe(LONG);
  });

  it('spaces overpasses by their actual ramp lengths', () => {
    // Long at (5, 8), another four tiles south: only short ramps fit there.
    const state = crossingTown();
    buildOverpasses(state, [CROSSING]);
    buildRail(
      state,
      Array.from({ length: 12 }, (_, i) => at(i + 2, 12)),
    );
    expect(buildOverpasses(state, [at(5, 12)])).toEqual({});
    expect(state.layers.overpass[CROSSING]).toBe(LONG);
    expect(state.layers.overpass[at(5, 12)]).toBe(SHORT);
    // Short at (5, 8) (junction two tiles north), another three tiles south: short too.
    const near = crossingTown();
    buildRoads(near, [at(4, 6)]);
    buildOverpasses(near, [CROSSING]);
    buildRail(
      near,
      Array.from({ length: 12 }, (_, i) => at(i + 2, 11)),
    );
    expect(buildOverpasses(near, [at(5, 11)])).toEqual({});
    expect(near.layers.overpass[CROSSING]).toBe(SHORT);
    expect(near.layers.overpass[at(5, 11)]).toBe(SHORT);
    // Two tiles apart they would share the ramp tile between them.
    const shared = crossingTown();
    buildRoads(shared, [at(4, 6)]);
    buildOverpasses(shared, [CROSSING]);
    buildRail(
      shared,
      Array.from({ length: 12 }, (_, i) => at(i + 2, 10)),
    );
    expect(buildOverpasses(shared, [at(5, 10)])).toEqual({ rejected: 'needsRampRoom' });
  });

  it('fits the ramps of an old save (stored as 1) to the room they have now', () => {
    const state = crossingTown();
    buildRail(
      state,
      Array.from({ length: 12 }, (_, i) => at(i + 2, 12)),
    );
    buildOverpasses(state, [CROSSING, at(5, 12)]);
    // A third crossing with a side street two tiles out.
    buildRoads(
      state,
      Array.from({ length: 9 }, (_, i) => at(10, i + 2)),
    );
    buildRoads(state, [at(11, 6)]);
    buildOverpasses(state, [at(10, 8)]);
    expect(state.layers.overpass[at(10, 8)]).toBe(SHORT);
    const save = serializeState(state);
    const legacy = new Uint8Array(save.layers.overpass!).map((v) => (v === 0 ? 0 : 1));
    // A stray mark on a tile that is no crossing at all is dropped.
    legacy[at(5, 4)] = 1;
    save.layers.overpass = legacy.buffer;
    const restored = deserializeState(save);
    expect(restored.layers.overpass[CROSSING]).toBe(LONG);
    expect(restored.layers.overpass[at(5, 12)]).toBe(SHORT); // spaced against the long one
    expect(restored.layers.overpass[at(10, 8)]).toBe(SHORT);
    expect(restored.layers.overpass[at(5, 4)]).toBe(0);
  });

  it('tells ramp tiles from deck and bystanders', () => {
    const state = crossingTown();
    buildOverpasses(state, [CROSSING]);
    for (const y of [6, 7, 9, 10]) expect(isOverpassRamp(state, at(5, y))).toBe(true);
    for (const tile of [CROSSING, at(5, 5), at(5, 11)]) {
      expect(isOverpassRamp(state, tile)).toBe(false);
    }
  });
});
