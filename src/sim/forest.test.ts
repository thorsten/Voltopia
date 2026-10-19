import { describe, expect, it } from 'vitest';
import { BALANCE } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { PlantType, Terrain, TileType, Zone } from '../shared/types.ts';
import {
  clearForest,
  fellingCost,
  forestCoverage,
  forestShare,
  forestStep,
  generateForest,
  plantForest,
  windForestFactor,
} from './forest.ts';
import { placePlant } from './energy.ts';
import { buildPowerLines } from './powerLines.ts';
import { buildRoads, bulldozeTiles, undoLastAction } from './roads.ts';
import { createSimState, type SimState } from './state.ts';
import { paintZones } from './zones.ts';

const SIZE = 32;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);

function makeState(): SimState {
  return createSimState(1, SIZE);
}

describe('generateForest', () => {
  it('is deterministic per seed and differs between seeds', () => {
    const a = createSimState(7, SIZE);
    const b = createSimState(7, SIZE);
    const c = createSimState(8, SIZE);
    for (const state of [a, b, c]) generateForest(state);
    expect([...a.layers.forest]).toEqual([...b.layers.forest]);
    expect([...a.layers.forest]).not.toEqual([...c.layers.forest]);
  });

  it('covers a meaningful but not overwhelming share of the land', () => {
    for (const seed of [1, 2, 3]) {
      const state = createSimState(seed, 64);
      generateForest(state);
      const share = forestShare(state);
      expect(share, `seed ${seed}`).toBeGreaterThan(0.08);
      expect(share, `seed ${seed}`).toBeLessThan(0.45);
    }
  });

  it('grows only mature woods, and never on water', () => {
    const state = makeState();
    state.layers.terrain[at(4, 4)] = Terrain.River;
    state.layers.terrain[at(5, 4)] = Terrain.Lake;
    generateForest(state);
    expect(state.layers.forest[at(4, 4)]).toBe(0);
    expect(state.layers.forest[at(5, 4)]).toBe(0);
    for (const stage of state.layers.forest) {
      expect(stage === 0 || stage === BALANCE.forest.maxStage).toBe(true);
    }
  });
});

describe('planting', () => {
  it('plants saplings on empty land and charges per tile', () => {
    const state = makeState();
    const before = state.money;
    const tiles = [at(2, 2), at(3, 2)];
    expect(plantForest(state, tiles)).toEqual({});
    expect(state.money).toBe(before - 2 * BALANCE.forest.plantCost);
    for (const tile of tiles) expect(state.layers.forest[tile]).toBe(1);
  });

  it('skips tiles that are already wooded, built on or water', () => {
    const state = makeState();
    state.layers.forest[at(2, 2)] = 2;
    state.layers.tileType[at(3, 2)] = TileType.Road;
    state.layers.terrain[at(4, 2)] = Terrain.Lake;
    const before = state.money;
    plantForest(state, [at(2, 2), at(3, 2), at(4, 2), at(5, 2)]);
    expect(state.money).toBe(before - BALANCE.forest.plantCost);
    expect(state.layers.forest[at(2, 2)]).toBe(2);
    expect(state.layers.forest[at(3, 2)]).toBe(0);
    expect(state.layers.forest[at(4, 2)]).toBe(0);
    expect(state.layers.forest[at(5, 2)]).toBe(1);
  });

  it('rejects planting the player cannot afford', () => {
    const state = makeState();
    state.money = BALANCE.forest.plantCost - 1;
    expect(plantForest(state, [at(2, 2)])).toEqual({ rejected: 'notEnoughMoney' });
    expect(state.layers.forest[at(2, 2)]).toBe(0);
  });

  it('planting can be undone', () => {
    const state = makeState();
    const before = state.money;
    plantForest(state, [at(2, 2)]);
    expect(state.undoStack.length).toBe(1);
    const entry = state.undoStack[state.undoStack.length - 1];
    expect(entry.tiles[0].forest).toBe(0);
    expect(entry.moneyDelta).toBe(before - state.money);
  });
});

describe('felling', () => {
  it('costs nothing on open land and scales with the growth stage', () => {
    const state = makeState();
    expect(fellingCost(state, at(2, 2))).toBe(0);
    state.layers.forest[at(2, 2)] = 1;
    expect(fellingCost(state, at(2, 2))).toBe(BALANCE.forest.fellingCostPerStage);
    state.layers.forest[at(2, 2)] = BALANCE.forest.maxStage;
    expect(fellingCost(state, at(2, 2))).toBe(
      BALANCE.forest.maxStage * BALANCE.forest.fellingCostPerStage,
    );
  });

  it('clearing empties the tile', () => {
    const state = makeState();
    state.layers.forest[at(2, 2)] = 3;
    clearForest(state, at(2, 2));
    expect(state.layers.forest[at(2, 2)]).toBe(0);
    expect(state.dirty.has(at(2, 2))).toBe(true);
  });
});

describe('growth', () => {
  it('saplings mature over time and stop at the top stage', () => {
    const state = makeState();
    plantForest(state, [at(2, 2)]);
    const stagesSeen = new Set<number>();
    // A full growth cycle per stage, plus slack for the rotating sweep.
    for (let t = 0; t < BALANCE.forest.growthIntervalTicks * (BALANCE.forest.maxStage + 1); t++) {
      state.tick++;
      forestStep(state);
      stagesSeen.add(state.layers.forest[at(2, 2)]);
    }
    expect(state.layers.forest[at(2, 2)]).toBe(BALANCE.forest.maxStage);
    expect(stagesSeen).toContain(2); // passed through the middle stage
  });

  it('never grows woods onto a tile that has none', () => {
    const state = makeState();
    for (let t = 0; t < BALANCE.forest.growthIntervalTicks * 2; t++) {
      state.tick++;
      forestStep(state);
    }
    expect(state.layers.forest.every((stage) => stage === 0)).toBe(true);
  });
});

describe('effects on the city', () => {
  it('forestCoverage is the share of buildings with woods in reach', () => {
    const state = makeState();
    const near = at(10, 10);
    const far = at(28, 28);
    for (const index of [near, far]) {
      state.layers.zone[index] = Zone.Residential;
      state.layers.density[index] = 1;
    }
    expect(forestCoverage(state)).toBe(0);
    state.layers.forest[at(10 + BALANCE.forest.coverRadius, 10)] = BALANCE.forest.maxStage;
    expect(forestCoverage(state)).toBeCloseTo(0.5, 6);
  });

  it('a wind turbine loses output in dense woods, keeps it in the open', () => {
    const state = makeState();
    const turbine = at(16, 16);
    expect(windForestFactor(state, turbine)).toBe(1);
    const radius = BALANCE.forest.windPenaltyRadius;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        state.layers.forest[at(16 + dx, 16 + dy)] = BALANCE.forest.maxStage;
      }
    }
    const factor = windForestFactor(state, turbine);
    expect(factor).toBeLessThan(1);
    expect(factor).toBeCloseTo(1 - BALANCE.forest.maxWindPenalty, 6);
  });

  it('a single nearby tree barely matters', () => {
    const state = makeState();
    state.layers.forest[at(16, 15)] = BALANCE.forest.maxStage;
    const factor = windForestFactor(state, at(16, 16));
    expect(factor).toBeLessThan(1);
    expect(factor).toBeGreaterThan(0.95);
  });
});

describe('building on woods fells them', () => {
  /** A mature wood tile, and what the city can spend. */
  function woodedState(): SimState {
    const state = makeState();
    state.money = 1e6;
    for (const tile of [at(2, 2), at(3, 2), at(4, 2), at(5, 2)]) {
      state.layers.forest[tile] = BALANCE.forest.maxStage;
    }
    return state;
  }

  const fee = BALANCE.forest.maxStage * BALANCE.forest.fellingCostPerStage;

  it('a road pays the felling fee on top and clears the tile', () => {
    const state = woodedState();
    const before = state.money;
    buildRoads(state, [at(2, 2)]);
    expect(state.layers.forest[at(2, 2)]).toBe(0);
    expect(before - state.money).toBe(BALANCE.costs.roadPerTile + fee);
  });

  it('a zone pays the fee and clears the tile', () => {
    const state = woodedState();
    const before = state.money;
    paintZones(state, [at(3, 2)], Zone.Residential);
    expect(state.layers.forest[at(3, 2)]).toBe(0);
    expect(before - state.money).toBe(BALANCE.costs.zonePerTile + fee);
  });

  it('a plant pays the fee and clears the tile', () => {
    const state = woodedState();
    // Spent grant pot: the plant costs its gross price.
    state.finance.grantUsedThisYear = BALANCE.finance.grant.annualPot;
    const before = state.money;
    placePlant(state, at(4, 2), PlantType.SolarFarm);
    expect(state.layers.forest[at(4, 2)]).toBe(0);
    expect(before - state.money).toBe(BALANCE.costs.plant[PlantType.SolarFarm] + fee);
  });

  it('a power line pays the fee and clears the tile', () => {
    const state = woodedState();
    const before = state.money;
    buildPowerLines(state, [at(5, 2)]);
    expect(state.layers.forest[at(5, 2)]).toBe(0);
    expect(before - state.money).toBe(BALANCE.costs.powerLinePerTile + fee);
  });

  it('undo brings the woods back with the money', () => {
    const state = woodedState();
    const before = state.money;
    buildRoads(state, [at(2, 2)]);
    undoLastAction(state);
    expect(state.layers.forest[at(2, 2)]).toBe(BALANCE.forest.maxStage);
    expect(state.money).toBe(before);
  });

  it('the bulldozer fells woods for the same fee', () => {
    const state = woodedState();
    const before = state.money;
    bulldozeTiles(state, [at(2, 2)]);
    expect(state.layers.forest[at(2, 2)]).toBe(0);
    expect(before - state.money).toBe(fee);
  });
});
