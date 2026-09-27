import { describe, expect, it } from 'vitest';
import { tileIndex } from '../shared/grid.ts';
import { createSimState, deserializeState, serializeState, type SimState } from './state.ts';
import { BALANCE } from '../shared/constants.ts';
import { DisasterKind, PlantType, SupplyStatus, TileType, Zone } from '../shared/types.ts';
import {
  addDamage,
  clearDamage,
  damagedTileCount,
  disasterStats,
  disastersStep,
  repairStep,
  type DisasterSpec,
} from './disasters.ts';
import { censusPlants, placePlant } from './energy.ts';
import { happinessStep } from './happiness.ts';
import { recomputeGrid } from './powerGrid.ts';
import { buildPowerLines } from './powerLines.ts';
import { bulldozeTiles, buildRoads } from './roads.ts';
import { recomputeServices, SERVICE_FIRE } from './services.ts';
import { buildRejection, BuildIntent, bumpGridVersion } from './state.ts';
import { stepTick } from './tick.ts';
import { SimEngine } from './engine.ts';

const SIZE = 32;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);

describe('the damage layer', () => {
  it('starts out intact on every tile', () => {
    const state = createSimState(1, SIZE);
    expect(state.layers.damage).toHaveLength(SIZE * SIZE);
    expect([...state.layers.damage].every((value) => value === 0)).toBe(true);
  });

  it('survives a save/load round trip', () => {
    const state = createSimState(1, SIZE);
    state.layers.damage[at(4, 5)] = 120;
    const loaded = deserializeState(serializeState(state));
    expect(loaded.layers.damage[at(4, 5)]).toBe(120);
  });

  it('starts a city with no events in flight and no repair bill', () => {
    const state = createSimState(1, SIZE);
    expect(state.disasters).toEqual({
      pending: [],
      active: [],
      nextId: 1,
      cooldownTicks: 0,
    });
    expect(state.lastRepairCost).toBe(0);
  });
});

describe('disaster intensity', () => {
  it('defaults to normal for a new city', () => {
    expect(createSimState(1, SIZE).disasterScale).toBe(1);
  });

  it('is zero for a save from before disasters', () => {
    const save = serializeState(createSimState(1, SIZE));
    delete save.disasterScale;
    expect(deserializeState(save).disasterScale).toBe(0);
  });

  it('round-trips a chosen intensity', () => {
    const state = createSimState(1, SIZE);
    state.disasterScale = 1.6;
    expect(deserializeState(serializeState(state)).disasterScale).toBe(1.6);
  });
});

describe('damage takes a tile out of service', () => {
  it('drops a damaged turbine out of the plant census', () => {
    const state = createSimState(1, SIZE);
    placePlant(state, at(5, 5), PlantType.WindTurbine);
    expect(censusPlants(state).windTurbines).toBe(1);
    state.layers.damage[at(5, 5)] = 50;
    expect(censusPlants(state).windTurbines).toBe(0);
    expect(censusPlants(state).windCapacity).toBe(0);
  });

  it('stops a damaged line from conducting', () => {
    const state = createSimState(1, SIZE);
    placePlant(state, at(2, 2), PlantType.WindTurbine);
    // The far tile must sit beyond lineSupplyRadius of the last surviving
    // line tile (3,2), or its own coverage stamp would still light it up.
    buildPowerLines(state, [at(3, 2), at(4, 2), at(5, 2), at(6, 2), at(7, 2)]);
    recomputeGrid(state);
    expect(state.layers.energized[at(7, 2)]).toBe(1);
    state.layers.damage[at(4, 2)] = 90;
    bumpGridVersion(state);
    recomputeGrid(state);
    expect(state.layers.energized[at(7, 2)]).toBe(0);
  });

  it('marks a damaged building as not connected and drops its consumption', () => {
    const state = createSimState(1, SIZE);
    placePlant(state, at(5, 5), PlantType.WindTurbine);
    state.layers.zone[at(5, 6)] = Zone.Residential;
    state.layers.density[at(5, 6)] = 2;
    stepTick(state);
    const withBuilding = state.lastEnergy.buildingConsumption;
    expect(withBuilding).toBeGreaterThan(0);
    state.layers.damage[at(5, 6)] = 30;
    stepTick(state);
    expect(state.lastEnergy.buildingConsumption).toBeLessThan(withBuilding);
    expect(state.layers.supplied[at(5, 6)]).toBe(SupplyStatus.NotConnected);
  });

  it('stops a damaged fire station from covering its ring', () => {
    const state = createSimState(1, SIZE);
    buildRoads(state, [at(4, 5)]);
    placePlant(state, at(4, 4), PlantType.FireStation);
    placePlant(state, at(5, 4), PlantType.WindTurbine);
    recomputeServices(state);
    expect(state.layers.services[at(4, 4)] & SERVICE_FIRE).toBe(SERVICE_FIRE);
    state.layers.damage[at(4, 4)] = 60;
    recomputeServices(state);
    expect(state.layers.services[at(4, 4)] & SERVICE_FIRE).toBe(0);
  });

  it('refuses to build on a damaged tile and clears damage when bulldozing', () => {
    const state = createSimState(1, SIZE);
    placePlant(state, at(7, 7), PlantType.WindTurbine);
    state.layers.damage[at(7, 7)] = 40;
    expect(buildRejection(state, at(7, 7), BuildIntent.Road)).toBe('damaged');
    bulldozeTiles(state, [at(7, 7)]);
    expect(state.layers.damage[at(7, 7)]).toBe(0);
    expect(buildRejection(state, at(7, 7), BuildIntent.Road)).toBe(null);
  });

  it('never damages the road under a damaged power line', () => {
    const state = createSimState(1, SIZE);
    buildRoads(state, [at(3, 3), at(4, 3)]);
    buildPowerLines(state, [at(3, 3)]);
    state.layers.damage[at(3, 3)] = 90;
    // The road is still a road: routing and vehicles ignore damage entirely.
    expect(state.layers.tileType[at(3, 3)]).toBe(TileType.Road);
  });
});

it('keeps the wind cut-out constant above the cut-in speed', () => {
  expect(BALANCE.energy.windCutOutSpeed).toBeGreaterThan(BALANCE.energy.windCutInSpeed);
});

describe('addDamage / clearDamage', () => {
  it('accumulates, saturates at 255 and marks the tile dirty', () => {
    const state = createSimState(1, SIZE);
    addDamage(state, at(1, 1), 200);
    addDamage(state, at(1, 1), 200);
    expect(state.layers.damage[at(1, 1)]).toBe(255);
    expect(state.dirty.has(at(1, 1))).toBe(true);
  });

  it('bumps the grid version only on the transitions that matter', () => {
    const state = createSimState(1, SIZE);
    const before = state.gridVersion;
    addDamage(state, at(1, 1), 10);
    expect(state.gridVersion).toBe(before + 1);
    addDamage(state, at(1, 1), 10);
    expect(state.gridVersion).toBe(before + 1); // still damaged: nothing changed
    clearDamage(state, at(1, 1));
    expect(state.gridVersion).toBe(before + 2);
  });
});

describe('repairStep', () => {
  it('heals damage over time and bills it', () => {
    const state = createSimState(1, SIZE);
    const { pointsPerTick, costPerPoint } = BALANCE.disasters.repair;
    addDamage(state, at(2, 2), 10);
    const money = state.money;
    const spent = repairStep(state);
    expect(state.layers.damage[at(2, 2)]).toBe(10 - pointsPerTick);
    expect(spent).toBeCloseTo(pointsPerTick * costPerPoint);
    expect(state.money).toBeCloseTo(money - spent);
    expect(state.lastRepairCost).toBeCloseTo(spent);
  });

  it('heals a tile all the way to intact', () => {
    const state = createSimState(1, SIZE);
    addDamage(state, at(2, 2), 3);
    for (let i = 0; i < 10; i++) repairStep(state);
    expect(damagedTileCount(state)).toBe(0);
  });

  it('freezes damage when the treasury is empty', () => {
    const state = createSimState(1, SIZE);
    addDamage(state, at(2, 2), 10);
    state.money = 0;
    expect(repairStep(state)).toBe(0);
    expect(state.layers.damage[at(2, 2)]).toBe(10);
    expect(state.money).toBe(0);
  });

  it('leaves tiles inside an active event alone', () => {
    const state = createSimState(1, SIZE);
    addDamage(state, at(2, 2), 10);
    state.disasters.active.push({
      id: 1,
      kind: DisasterKind.Flood,
      severity: 1,
      startTick: 0,
      endTick: state.tick + 100,
      origin: at(2, 2),
      tiles: [at(2, 2)],
      intensity: [1],
    });
    repairStep(state);
    expect(state.layers.damage[at(2, 2)]).toBe(10);
  });
});

/** A spec that always fires, hits one tile and never ends early. */
function alwaysSpec(overrides: Partial<DisasterSpec> = {}): DisasterSpec {
  return {
    kind: DisasterKind.Storm,
    warnTicks: 10,
    durationTicks: 5,
    severityRange: [1, 1],
    risk: () => 1,
    plan: () => ({ origin: 0, tiles: [0], intensity: [0] }),
    apply: () => false,
    ...overrides,
  };
}

describe('disastersStep', () => {
  it('schedules a warning, activates it, then retires it', () => {
    const state = createSimState(1, SIZE);
    const specs = [alwaysSpec()];
    disastersStep(state, specs);
    expect(state.disasters.pending).toHaveLength(1);
    expect(state.disasters.active).toHaveLength(0);

    const event = state.disasters.pending[0];
    while (state.tick < event.startTick) {
      state.tick++;
      disastersStep(state, specs);
    }
    expect(state.disasters.active).toHaveLength(1);
    expect(state.disasters.pending).toHaveLength(0);

    while (state.tick < event.endTick) {
      state.tick++;
      disastersStep(state, specs);
    }
    expect(state.disasters.active).toHaveLength(0);
  });

  it('respects the cooldown between two events', () => {
    const state = createSimState(1, SIZE);
    const specs = [alwaysSpec()];
    disastersStep(state, specs);
    expect(state.disasters.nextId).toBe(2);
    for (let i = 0; i < BALANCE.disasters.cooldownTicks - 1; i++) {
      state.tick++;
      disastersStep(state, specs);
    }
    // The first event (10 warn + 5 duration ticks) is long since retired
    // by now; the cooldown itself is what keeps a second one from
    // appearing until it fully expires one tick from here.
    const scheduled = state.disasters.pending.length + state.disasters.active.length;
    expect(scheduled).toBe(0);
    state.tick++;
    disastersStep(state, specs);
    expect(state.disasters.nextId).toBe(3);
  });

  it('never schedules anything with the intensity off', () => {
    const state = createSimState(1, SIZE);
    state.disasterScale = 0;
    for (let i = 0; i < 1000; i++) {
      state.tick++;
      disastersStep(state, [alwaysSpec()]);
    }
    expect(state.disasters.pending).toHaveLength(0);
    expect(state.disasters.active).toHaveLength(0);
  });

  it('scales the risk with the intensity', () => {
    // The cooldown is zeroed after every step so this measures the roll
    // alone; with it in place both intensities would simply fire on
    // almost every cooldown expiry and the counts would be too close.
    const rolls = (scale: number): number => {
      const state = createSimState(7, SIZE);
      state.disasterScale = scale;
      let count = 0;
      const specs = [alwaysSpec({ risk: () => 0.02, warnTicks: 0, durationTicks: 1 })];
      for (let i = 0; i < 4000; i++) {
        state.tick++;
        const before = state.disasters.nextId;
        disastersStep(state, specs);
        if (state.disasters.nextId > before) count++;
        state.disasters.cooldownTicks = 0;
      }
      return count;
    };
    expect(rolls(1.6)).toBeGreaterThan(rolls(0.5) * 2);
  });

  it('retires an event early when its kind reports it is over', () => {
    const state = createSimState(1, SIZE);
    // Activation now happens right before the active loop runs, in the
    // same disastersStep call — for an unwarned event that is the same
    // call it was rolled in. So a kind that reports itself over on the
    // very first apply retires immediately: there is no tick where it
    // sits observably active, unlike a naive "activate, then check next
    // step" reading of "early".
    const specs = [alwaysSpec({ warnTicks: 0, durationTicks: 500, apply: () => true })];
    disastersStep(state, specs);
    expect(state.disasters.pending).toHaveLength(0);
    expect(state.disasters.active).toHaveLength(0);
  });

  it('applies a spec exactly durationTicks times, warned or not', () => {
    // Regression guard: activation must happen in one place, right before
    // the active loop, so a warned event (activated on a later tick) and
    // an unwarned one (activated the tick it is rolled) get the same
    // number of apply calls — durationTicks, no more, no less.
    const run = (warnTicks: number): number => {
      const state = createSimState(1, SIZE);
      let calls = 0;
      const specs = [
        alwaysSpec({
          warnTicks,
          durationTicks: 5,
          apply: () => {
            calls++;
            return false;
          },
        }),
      ];
      disastersStep(state, specs);
      while (state.disasters.pending.length > 0 || state.disasters.active.length > 0) {
        state.tick++;
        disastersStep(state, specs);
      }
      return calls;
    };
    expect(run(10)).toBe(5);
    expect(run(0)).toBe(5);
  });

  it('skips a kind that finds no site', () => {
    const state = createSimState(1, SIZE);
    disastersStep(state, [alwaysSpec({ plan: () => null })]);
    expect(state.disasters.pending).toHaveLength(0);
    expect(state.disasters.nextId).toBe(1);
  });

  it('reports pending and active events in the stats', () => {
    const state = createSimState(1, SIZE);
    disastersStep(state, [alwaysSpec()]);
    addDamage(state, at(3, 3), 20);
    const stats = disasterStats(state);
    expect(stats.scale).toBe(1);
    expect(stats.pending[0].ticks).toBe(10);
    expect(stats.pending[0].kind).toBe(DisasterKind.Storm);
    expect(stats.damagedTiles).toBe(1);
  });
});

/** A scripted city that reliably faces events: dry, dense, unprotected. */
function scriptedCity(seed: number): SimEngine {
  const engine = new SimEngine(seed, 32);
  engine.applyCommand({ type: 'init', seed, size: 32 });
  const state = engine.state;
  state.disasterScale = 1.6;
  for (let y = 4; y < 14; y++) {
    for (let x = 4; x < 14; x++) {
      if (state.layers.terrain[tileIndex(x, y, 32)] !== 0) continue;
      state.layers.zone[tileIndex(x, y, 32)] = Zone.Residential;
      state.layers.density[tileIndex(x, y, 32)] = 3;
    }
  }
  return engine;
}

describe('determinism', () => {
  it('produces the same events twice for the same seed', () => {
    // 1200 ticks, not more: CI runners are 2-3× slower than a dev
    // machine, and two full runs of a scripted city have to fit inside
    // vitest's 30 s timeout with room to spare.
    const run = (): string => {
      const engine = scriptedCity(42);
      const log: string[] = [];
      for (let i = 0; i < 1200; i++) {
        engine.tick();
        for (const event of engine.state.disasters.active) {
          log.push(`${engine.state.tick}:${event.kind}:${event.id}`);
        }
      }
      return log.join(',');
    };
    expect(run()).toBe(run());
  });

  it('restores a warning and a running fire across a save/load', () => {
    const engine = scriptedCity(7);
    engine.state.disasters.pending.push({
      id: 100,
      kind: DisasterKind.Flood,
      severity: 0.8,
      startTick: engine.state.tick + 200,
      endTick: engine.state.tick + 500,
      origin: at(5, 5),
      tiles: [at(5, 5)],
      intensity: [2],
    });
    engine.state.disasters.active.push({
      id: 101,
      kind: DisasterKind.Fire,
      severity: 1,
      startTick: engine.state.tick,
      endTick: engine.state.tick + 40,
      origin: at(6, 6),
      tiles: [at(6, 6), at(6, 7)],
      intensity: [20, 12],
    });
    addDamage(engine.state, at(6, 6), 30);

    const loaded = deserializeState(serializeState(engine.state));
    expect(loaded.disasters.pending[0].id).toBe(100);
    expect(loaded.disasters.pending[0].startTick).toBe(engine.state.disasters.pending[0].startTick);
    expect(loaded.disasters.active[0].tiles).toEqual([at(6, 6), at(6, 7)]);
    expect(loaded.disasters.active[0].intensity).toEqual([20, 12]);
    expect(loaded.layers.damage[at(6, 6)]).toBe(30);
    expect(loaded.disasterScale).toBe(1.6);
  });

  it('keeps a loaded city running without throwing', () => {
    const engine = scriptedCity(9);
    for (let i = 0; i < 500; i++) engine.tick();
    const loaded = new SimEngine(9, 32);
    loaded.applyCommand({ type: 'init', seed: 9, size: 32, save: serializeState(engine.state) });
    for (let i = 0; i < 500; i++) loaded.tick();
    expect(loaded.state.tick).toBeGreaterThan(engine.state.tick);
  });
});

describe('happiness', () => {
  it('drops while buildings are damaged', () => {
    const build = (): SimState => {
      const state = createSimState(1, SIZE);
      for (let x = 2; x < 10; x++) {
        state.layers.zone[at(x, 2)] = Zone.Residential;
        state.layers.density[at(x, 2)] = 2;
      }
      return state;
    };
    const calm = build();
    const hit = build();
    for (let x = 2; x < 10; x++) addDamage(hit, at(x, 2), 40);
    for (let i = 0; i < 20; i++) {
      happinessStep(calm, 100);
      happinessStep(hit, 100);
    }
    expect(hit.happiness).toBeLessThan(calm.happiness);
  });
});
