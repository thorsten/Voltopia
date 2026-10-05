import { describe, expect, it } from 'vitest';
import { TICKS_PER_DAY } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { PlantType } from '../shared/types.ts';
import { addDamage } from './disasters.ts';
import { callBudgetTicks } from './demandResponse.ts';
import { placePlant } from './energy.ts';
import { poolForIsland, syncIslandPools } from './islandPools.ts';
import { buildPowerLines } from './powerLines.ts';
import { islandCount, islandKey, islandOf, recomputeGrid } from './powerGrid.ts';
import { bumpGridVersion, createSimState, type SimState } from './state.ts';

const SIZE = 24;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);

function twoIslands(): SimState {
  const state = createSimState(1, SIZE);
  state.money = 1e9;
  placePlant(state, at(2, 2), PlantType.WindTurbine);
  placePlant(state, at(18, 18), PlantType.SolarFarm);
  recomputeGrid(state);
  syncIslandPools(state);
  return state;
}

describe('island pools', () => {
  it('gives every island a fresh pool and prunes vanished keys', () => {
    const state = twoIslands();
    expect(islandCount(state)).toBe(2);
    expect(poolForIsland(state, 1)).toEqual({ flexBacklog: 0, callBudget: callBudgetTicks() });
    expect(state.islandPools.size).toBe(2);
  });

  it('a merge adds the backlogs and keeps the smaller budget under the surviving key', () => {
    const state = twoIslands();
    poolForIsland(state, 1).flexBacklog = 100;
    poolForIsland(state, 1).callBudget = 10;
    poolForIsland(state, 2).flexBacklog = 50;
    poolForIsland(state, 2).callBudget = 4;
    buildPowerLines(
      state,
      Array.from({ length: 16 }, (_, i) => at(3 + i, 2)),
    );
    buildPowerLines(
      state,
      Array.from({ length: 16 }, (_, i) => at(18, 3 + i)),
    );
    recomputeGrid(state);
    syncIslandPools(state);
    expect(islandCount(state)).toBe(1);
    expect(state.islandPools.size).toBe(1);
    expect(poolForIsland(state, 1)).toEqual({ flexBacklog: 150, callBudget: 4 });
  });

  it('a split leaves the surviving key everything and starts the new island fresh', () => {
    const state = createSimState(1, SIZE);
    state.money = 1e9;
    placePlant(state, at(2, 2), PlantType.WindTurbine);
    buildPowerLines(
      state,
      Array.from({ length: 12 }, (_, i) => at(3 + i, 2)),
    );
    placePlant(state, at(15, 2), PlantType.SolarFarm);
    recomputeGrid(state);
    syncIslandPools(state);
    poolForIsland(state, 1).flexBacklog = 80;
    poolForIsland(state, 1).callBudget = 3;
    for (let x = 6; x <= 12; x++) addDamage(state, at(x, 2), 10); // a gap longer than two rings
    bumpGridVersion(state);
    recomputeGrid(state);
    syncIslandPools(state);
    expect(islandCount(state)).toBe(2);
    expect(poolForIsland(state, 1)).toEqual({ flexBacklog: 80, callBudget: 3 });
    expect(poolForIsland(state, 2)).toEqual({ flexBacklog: 0, callBudget: callBudgetTicks() });
    expect(state.islandPools.get(islandKey(state, 2))).toBeDefined();
  });

  it('refills every budget on the first tick of a day', () => {
    const state = twoIslands();
    poolForIsland(state, 1).callBudget = 0;
    state.tick = TICKS_PER_DAY;
    syncIslandPools(state);
    expect(poolForIsland(state, 1).callBudget).toBe(callBudgetTicks());
  });

  it('a key tile dropping out of coverage does not lose the pool: ownership follows tile overlap', () => {
    const state = createSimState(1, SIZE);
    state.money = 1e9;
    // A stands alone; it only joins the line+B island below by ring
    // overlap, not by flood-fill adjacency, and its own ring corner
    // (not its plant tile) is the lowest tile — and so the key — of the
    // merged island.
    placePlant(state, at(2, 2), PlantType.WindTurbine); // A
    buildPowerLines(
      state,
      Array.from({ length: 7 }, (_, i) => at(2, 6 + i)), // a line, not adjacent to A
    );
    placePlant(state, at(2, 13), PlantType.SolarFarm); // B, flood-fills through the line
    recomputeGrid(state);
    syncIslandPools(state);
    expect(islandCount(state)).toBe(1); // ring overlap already unites A with the line+B island
    const oldKey = islandKey(state, 1);
    poolForIsland(state, 1).flexBacklog = 999;
    poolForIsland(state, 1).callBudget = 1;

    addDamage(state, at(2, 2), 10); // A stops being a source; its own ring corner drops
    bumpGridVersion(state);
    recomputeGrid(state);
    syncIslandPools(state);

    expect(islandCount(state)).toBe(1); // the line+B network is still one island
    const newKey = islandKey(state, 1);
    expect(newKey).not.toBe(oldKey); // the key tile itself is no longer covered
    expect(poolForIsland(state, 1)).toEqual({ flexBacklog: 999, callBudget: 1 });
  });

  it('a split keeps the pool under the bigger fragment even when the smaller one keeps the lower key', () => {
    const state = createSimState(1, SIZE);
    state.money = 1e9;
    placePlant(state, at(2, 2), PlantType.WindTurbine); // west: alone, smaller, lower key
    buildPowerLines(
      state,
      Array.from({ length: 12 }, (_, i) => at(3 + i, 2)),
    );
    // East: three plants whose overlapping rings make a much bigger
    // fragment than the lone west plant, but at higher tile indices.
    placePlant(state, at(15, 2), PlantType.SolarFarm);
    placePlant(state, at(15, 5), PlantType.SolarFarm);
    placePlant(state, at(15, 8), PlantType.SolarFarm);
    recomputeGrid(state);
    syncIslandPools(state);
    expect(islandCount(state)).toBe(1);
    poolForIsland(state, 1).flexBacklog = 60;
    poolForIsland(state, 1).callBudget = 2;

    for (let x = 6; x <= 12; x++) addDamage(state, at(x, 2), 10); // a gap longer than two rings
    bumpGridVersion(state);
    recomputeGrid(state);
    syncIslandPools(state);

    expect(islandCount(state)).toBe(2);
    const west = islandOf(state, at(2, 2));
    const east = islandOf(state, at(15, 2));
    expect(west).not.toBe(east);
    // The west fragment still keeps the lower key (its ring always
    // reached further toward the map's corner than the east cluster's)...
    expect(islandKey(state, west)).toBeLessThan(islandKey(state, east));
    // ...but the bigger eastern fragment is the one that inherits the pool.
    expect(poolForIsland(state, east)).toEqual({ flexBacklog: 60, callBudget: 2 });
    expect(poolForIsland(state, west)).toEqual({ flexBacklog: 0, callBudget: callBudgetTicks() });
  });

  it('several recomputes between two syncs still map against the labelling of the last sync', () => {
    const state = twoIslands();
    poolForIsland(state, 1).flexBacklog = 40;
    poolForIsland(state, 1).callBudget = 6;

    // First intermediate change: recomputed but not synced. The grid
    // was synced right before this, so the snapshot does update now —
    // to the two-island layout the pools were just synced to.
    buildPowerLines(state, [at(10, 10)]);
    recomputeGrid(state);
    const snapshotKeys = [...state.prevIslandKeys];
    expect(snapshotKeys.length).toBe(3); // [-1, island1's key, island2's key]

    // Second intermediate change: recomputed but still not synced. The
    // snapshot must not move again — it still has to describe the
    // labelling the pools were synced to, not this unsynced recompute.
    buildPowerLines(state, [at(11, 10)]);
    recomputeGrid(state);
    expect([...state.prevIslandKeys]).toEqual(snapshotKeys);

    // Neither original island's own tiles ever changed, so the pool
    // must still be exactly what it was.
    syncIslandPools(state);
    expect(poolForIsland(state, 1)).toEqual({ flexBacklog: 40, callBudget: 6 });
  });
});
