import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { BALANCE } from '../shared/constants.ts';
import {
  RoadClass,
  RoadLane,
  Terrain,
  TileType,
  type TownLayout,
  TownRoad,
  Zone,
} from '../shared/types.ts';
import type { SaveGame } from '../shared/types.ts';
import { parseOsm } from '../import/osm.ts';
import { rasteriseTown } from '../import/rasterise.ts';
import { SimEngine } from './engine.ts';
import { hasRoadAccess } from './growth.ts';
import { applyTownLayout, validateTownLayout } from './importTown.ts';
import { createSimState, serializeState } from './state.ts';
import { stepTick } from './tick.ts';
import { ScenarioSetupError } from './scenarios/stamp.ts';

const SIZE = 96;
const SEED = 1;
const DETERMINISM_TICKS = 200;

/** The fixture town at 96, rasterised once: the engine tests share it. */
let layout: TownLayout;
beforeAll(() => {
  const xml = readFileSync(new URL('../import/fixtures/town.osm', import.meta.url), 'utf8');
  layout = rasteriseTown(parseOsm(xml), SIZE).layout;
});

function startImported(seed = SEED, size = SIZE, town = layout): SimEngine {
  const engine = new SimEngine(seed, size);
  const events = engine.applyCommand({ type: 'init', seed, size, layout: town });
  expect(events).toEqual([]);
  return engine;
}

/** A layout copy with one layer replaced (or dropped) for the validator tests. */
function withLayer(key: keyof TownLayout, value: unknown): Record<string, unknown> {
  return { ...layout, [key]: value };
}

/** Byte-level fingerprint of a save; JSON.stringify alone would skip the ArrayBuffers. */
function fingerprint(save: SaveGame): string {
  return JSON.stringify(save, (_key, value: unknown) =>
    value instanceof ArrayBuffer ? Array.from(new Uint8Array(value)) : value,
  );
}

describe('validateTownLayout', () => {
  it('accepts the rasterised fixture at its own size', () => {
    expect(validateTownLayout(layout, SIZE)).toBe(true);
  });

  it('rejects non-objects and a size the game does not offer', () => {
    expect(validateTownLayout(null, SIZE)).toBe(false);
    expect(validateTownLayout('town', SIZE)).toBe(false);
    expect(validateTownLayout(layout, 64)).toBe(false);
    expect(validateTownLayout({ ...layout, size: 80 }, 80)).toBe(false);
  });

  it('rejects a layer of the wrong length or type', () => {
    expect(validateTownLayout(withLayer('road', new Uint8Array(SIZE * SIZE - 1)), SIZE)).toBe(
      false,
    );
    expect(validateTownLayout(withLayer('zone', Array.from(layout.zone)), SIZE)).toBe(false);
    expect(validateTownLayout(withLayer('rail', undefined), SIZE)).toBe(false);
  });

  it.each([
    ['terrain', Terrain.Sea + 1],
    ['forest', BALANCE.forest.maxStage + 1],
    ['road', TownRoad.Avenue + 1],
    ['pedestrian', 2],
    ['rail', 2],
    ['zone', Zone.Industrial + 1],
    ['density', BALANCE.growth.populationByDensity.length],
  ] as const)('rejects an out-of-range %s value', (key, value) => {
    const bytes = new Uint8Array(layout[key]);
    bytes[5] = value;
    expect(validateTownLayout(withLayer(key, bytes), SIZE)).toBe(false);
  });

  it('rejects a bad name or bbox', () => {
    expect(validateTownLayout({ ...layout, name: 3 }, SIZE)).toBe(false);
    expect(validateTownLayout({ ...layout, name: null }, SIZE)).toBe(true);
    expect(validateTownLayout({ ...layout, bbox: [1, 2, 3] }, SIZE)).toBe(false);
    expect(validateTownLayout({ ...layout, bbox: [1, 2, 3, Number.NaN] }, SIZE)).toBe(false);
    expect(validateTownLayout({ ...layout, bbox: 'everywhere' }, SIZE)).toBe(false);
  });
});

describe('SimEngine init with a layout', () => {
  it('reproduces the layout on the grid and leaves the ground flat', () => {
    const { layers } = startImported().state;
    for (let i = 0; i < SIZE * SIZE; i++) {
      expect(layers.elevation[i]).toBe(0);
      expect(layers.terrain[i]).toBe(layout.terrain[i]);
      expect(layers.forest[i]).toBe(layout.forest[i]);
      expect(layers.zone[i]).toBe(layout.zone[i]);
      expect(layers.rail[i] !== 0).toBe(layout.rail[i] !== 0);
      expect(layers.tileType[i] === TileType.Road).toBe(layout.road[i] !== TownRoad.None);
      if (layout.road[i] !== TownRoad.None) {
        expect(layers.roadClass[i]).toBe(
          layout.road[i] === TownRoad.Avenue ? RoadClass.Avenue : RoadClass.Street,
        );
        expect(layers.roadLane[i]).toBe(
          layout.pedestrian[i] !== 0 ? RoadLane.Pedestrian : RoadLane.None,
        );
      }
    }
  });

  it('settles buildings only on zoned, road-served land at the layout density', () => {
    const state = startImported().state;
    const { layers } = state;
    let buildings = 0;
    for (let i = 0; i < SIZE * SIZE; i++) {
      expect(layers.density[i]).toBe(layout.density[i]);
      if (layers.density[i] === 0) continue;
      buildings++;
      expect(layers.terrain[i]).toBe(Terrain.Land);
      expect(layers.zone[i]).not.toBe(Zone.None);
      expect(layers.tileType[i]).toBe(TileType.Empty);
      expect(hasRoadAccess(state, i)).toBe(true);
      expect(layers.buildingAge[i]).toBe(BALANCE.growth.ageStageTicks[0]);
    }
    expect(buildings).toBeGreaterThan(0);
  });

  it('sets the origin, costs nothing and cannot be undone', () => {
    const engine = startImported();
    const { state } = engine;
    expect(state.origin).toEqual({ source: 'osm', name: layout.name, bbox: layout.bbox });
    expect(state.origin?.bbox).not.toBe(layout.bbox);
    expect(state.money).toBe(BALANCE.startingMoney);
    expect(state.undoStack).toEqual([]);
    expect(state.statsDirty).toBe(true);
    expect(state.gridVersion).toBeGreaterThan(0);
    expect(engine.applyCommand({ type: 'undo' })).toEqual([
      { type: 'rejected', reason: 'nothingToUndo' },
    ]);
    const stats = engine.snapshot();
    if (stats.type !== 'tick') throw new Error('expected a tick');
    expect(stats.stats.origin).toEqual(state.origin);
    expect(stats.stats.origin).not.toBe(state.origin);
  });

  it('takes starting money, disasters and sandbox from the command', () => {
    const engine = new SimEngine(SEED, SIZE);
    engine.applyCommand({
      type: 'init',
      seed: SEED,
      size: SIZE,
      layout,
      startingMoney: 12_345,
      disasterScale: 0.5,
      sandbox: false,
    });
    expect(engine.state.money).toBe(12_345);
    expect(engine.state.disasterScale).toBe(0.5);
    expect(engine.state.sandbox).toBe(false);
    const sandbox = new SimEngine(SEED, SIZE);
    sandbox.applyCommand({ type: 'init', seed: SEED, size: SIZE, layout, sandbox: true });
    expect(sandbox.state.sandbox).toBe(true);
    expect(sandbox.state.disasterScale).toBe(1);
  });

  it(`is deterministic: same seed and layout, same save after ${DETERMINISM_TICKS} ticks`, async () => {
    const run = (): string => {
      const { state } = startImported();
      for (let t = 0; t < DETERMINISM_TICKS; t++) stepTick(state);
      expect(state.lastBuildingCount).toBeGreaterThan(0);
      return fingerprint(serializeState(state));
    };
    const first = run();
    // Two long synchronous runs in one test would trip the vitest worker
    // RPC timeout on a slow CI runner; let the event loop breathe between them.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(run()).toBe(first);
  });

  it('keeps the origin through a save and a load', () => {
    const engine = startImported();
    const [event] = engine.applyCommand({ type: 'requestSave' });
    if (event.type !== 'saveData') throw new Error('expected save data');
    expect(event.save.origin).toEqual(engine.state.origin);
    const restored = new SimEngine(SEED, SIZE);
    restored.applyCommand({ type: 'init', seed: SEED, size: SIZE, save: event.save });
    expect(restored.state.origin).toEqual(engine.state.origin);
    expect(restored.state.origin).not.toBe(event.save.origin);
    // A save of a generated city has no origin, and a torn one is dropped.
    const plain = serializeState(createSimState(SEED, 16));
    expect(plain.origin).toBeUndefined();
    const good = { source: 'osm', name: null, bbox: [1, 2, 3, 4] };
    for (const bad of [
      { ...good, source: 'map' },
      { ...good, name: 4 },
      { ...good, bbox: 'everywhere' },
      { ...good, bbox: [1, 2, 3] },
      { ...good, bbox: [1, 2, 3, 'n'] },
    ]) {
      const torn = new SimEngine(SEED, 16);
      const save = { ...plain, origin: bad as unknown as SaveGame['origin'] };
      torn.applyCommand({ type: 'init', seed: SEED, size: 16, save });
      expect(torn.state.origin).toBeUndefined();
    }
  });

  it('falls back to a seeded free city and reports an invalid layout', () => {
    const engine = new SimEngine(SEED, SIZE);
    const events = engine.applyCommand({
      type: 'init',
      seed: SEED,
      size: SIZE,
      layout: { ...layout, size: 64 },
    });
    expect(events).toEqual([{ type: 'rejected', reason: 'invalidLayout' }]);
    expect(engine.state.origin).toBeUndefined();
    expect(engine.state.size).toBe(SIZE);
    // The seeded map, not a blank one: it has water and woods of its own.
    expect(engine.state.layers.terrain.some((t) => t !== Terrain.Land)).toBe(true);
    expect(engine.state.layers.forest.some((f) => f !== 0)).toBe(true);
    expect(engine.applyCommand({ type: 'buildRoad', tiles: [SIZE * 2 + 2] })).toEqual([]);
  });
});

describe('applyTownLayout', () => {
  it('throws when the layout asks for something the sim refuses', () => {
    const size = 48;
    const tiles = size * size;
    const empty = (): Uint8Array => new Uint8Array(tiles);
    const broken: TownLayout = {
      size,
      terrain: empty(),
      forest: empty(),
      road: empty(),
      pedestrian: empty(),
      rail: empty(),
      zone: empty(),
      density: empty(),
      name: null,
      bbox: [0, 0, 1, 1],
    };
    // A building on an unzoned tile without a road.
    broken.density[5] = 1;
    expect(() => applyTownLayout(createSimState(SEED, size), broken)).toThrow(ScenarioSetupError);
  });
});
