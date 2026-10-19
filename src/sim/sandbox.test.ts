import { describe, expect, it } from 'vitest';
import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { PlantType, Zone } from '../shared/types.ts';
import { repairStep } from './disasters.ts';
import { placePlant } from './energy.ts';
import { SimEngine } from './engine.ts';
import { buildRoads } from './roads.ts';
import { pinSandboxTreasury } from './sandbox.ts';
import { createSimState, type SimState } from './state.ts';
import { buildStats, stepTick } from './tick.ts';

const SIZE = 32;
const at = (x: number, y: number): number => tileIndex(x, y, SIZE);

function sandboxEngine(seed = 5): SimEngine {
  const engine = new SimEngine(seed, SIZE);
  // The constructor builds an all-land map; keep it (no terrain generation)
  // so the builds below always find buildable ground.
  engine.state.sandbox = true;
  pinSandboxTreasury(engine.state);
  return engine;
}

/**
 * A small city: a road along row 10, one wind turbine and a substation at
 * its ends and a block of settled homes beside it, far more than the
 * turbine supplies, so the substation imports.
 */
function buildCity(state: SimState): void {
  const road: number[] = [];
  for (let x = 2; x < 20; x++) road.push(at(x, 10));
  expect(buildRoads(state, road).rejected).toBeUndefined();
  expect(placePlant(state, at(20, 10), PlantType.WindTurbine).rejected).toBeUndefined();
  // The substation is the import link that covers the shortfall.
  expect(placePlant(state, at(1, 10), PlantType.Substation).rejected).toBeUndefined();
  for (let x = 2; x < 20; x++) {
    for (const y of [9, 11]) {
      state.layers.zone[at(x, y)] = Zone.Residential;
      state.layers.density[at(x, y)] = 3;
    }
  }
}

describe('pinSandboxTreasury', () => {
  it('leaves a normal city alone', () => {
    const state = createSimState(1, SIZE);
    state.money = 123;
    pinSandboxTreasury(state);
    expect(state.money).toBe(123);
  });

  it('pins a sandbox city to the configured treasury', () => {
    const state = createSimState(1, SIZE);
    state.sandbox = true;
    state.money = -50;
    pinSandboxTreasury(state);
    expect(state.money).toBe(BALANCE.sandbox.treasury);
  });
});

describe('sandbox city', () => {
  it('starts a sandbox city from init with the pinned treasury', () => {
    const engine = new SimEngine(1, SIZE);
    engine.applyCommand({ type: 'init', seed: 1, size: SIZE, sandbox: true });
    expect(engine.state.money).toBe(BALANCE.sandbox.treasury);
  });

  it('builds beyond the starting funds and stays pinned after every command', () => {
    const engine = sandboxEngine();
    const turbines = Math.ceil(40_000 / BALANCE.costs.plant[PlantType.WindTurbine]) + 1;
    expect(turbines * BALANCE.costs.plant[PlantType.WindTurbine]).toBeGreaterThan(
      BALANCE.startingMoney,
    );
    for (let i = 0; i < turbines; i++) {
      const events = engine.applyCommand({
        type: 'placePlant',
        tile: at(2 + (i % 14) * 2, 2 + Math.floor(i / 14) * 2),
        plant: PlantType.WindTurbine,
      });
      expect(events).toEqual([]);
      expect(engine.state.money).toBe(BALANCE.sandbox.treasury);
    }
  });

  it('undo refunds and stays pinned', () => {
    const engine = sandboxEngine();
    engine.applyCommand({ type: 'buildRoad', tiles: [at(3, 3), at(4, 3), at(5, 3)] });
    expect(engine.applyCommand({ type: 'undo' })).toEqual([]);
    expect(engine.state.layers.roadMask[at(4, 3)]).toBe(0);
    expect(engine.state.money).toBe(BALANCE.sandbox.treasury);
  });

  it('books every flow of a tick and ends it pinned', () => {
    const engine = sandboxEngine();
    buildCity(engine.state);
    engine.tick();
    expect(engine.state.money).toBe(BALANCE.sandbox.treasury);
    const { budget } = buildStats(engine.state);
    expect(budget.gridUpkeep).toBeGreaterThan(0);
    expect(budget.plantUpkeep).toBeGreaterThan(0);
    expect(budget.gridImportCost).toBeGreaterThan(0);
  });

  it('books the same budget lines as the same city with ample money', () => {
    const sandbox = createSimState(9, SIZE);
    sandbox.sandbox = true;
    pinSandboxTreasury(sandbox);
    const normal = createSimState(9, SIZE, BALANCE.sandbox.treasury);
    buildCity(sandbox);
    buildCity(normal);
    for (let i = 0; i < 50; i++) {
      stepTick(sandbox);
      stepTick(normal);
    }
    expect(sandbox.money).toBe(BALANCE.sandbox.treasury);
    expect(normal.money).not.toBe(BALANCE.sandbox.treasury);
    expect(buildStats(sandbox).budget).toEqual(buildStats(normal).budget);
  });

  it('pays repairs at the full rate and ends the tick pinned', () => {
    const state = createSimState(3, SIZE);
    state.sandbox = true;
    pinSandboxTreasury(state);
    buildCity(state);
    for (const x of [3, 4, 5]) state.layers.damage[at(x, 9)] = 50;
    expect(repairStep(state)).toBeGreaterThan(0);
    expect(state.lastRepairCost).toBeGreaterThan(0);
    stepTick(state);
    expect(state.money).toBe(BALANCE.sandbox.treasury);
  });

  it('ends a full day pinned with one lifetime sample', () => {
    const state = createSimState(4, SIZE);
    state.sandbox = true;
    pinSandboxTreasury(state);
    buildCity(state);
    for (let i = 0; i < TICKS_PER_DAY; i++) stepTick(state);
    expect(state.money).toBe(BALANCE.sandbox.treasury);
    expect(state.lifetime.samples).toHaveLength(1);
  });
});
