import { describe, expect, it } from 'vitest';
import { TICKS_PER_DAY } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { PlantType } from '../shared/types.ts';
import { addDamage } from './disasters.ts';
import { callBudgetTicks } from './demandResponse.ts';
import { placePlant } from './energy.ts';
import { poolForIsland, syncIslandPools } from './islandPools.ts';
import { buildPowerLines } from './powerLines.ts';
import { islandCount, islandKey, recomputeGrid } from './powerGrid.ts';
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
});
