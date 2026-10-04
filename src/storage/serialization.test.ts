import { describe, expect, it } from 'vitest';
import { LINE_PRESENT } from '../shared/grid.ts';
import { buildRoads } from '../sim/roads.ts';
import { createSimState, serializeState } from '../sim/state.ts';
import { SAVE_VERSION } from '../shared/constants.ts';
import type { SaveGame } from '../shared/types.ts';
import { saveFromJson, saveToJson } from './serialization.ts';

/** Build a minimal, valid save game for size 4 to use as a test fixture. */
function makeSave(): SaveGame {
  const size = 4;
  const bytes = size * size;
  return {
    version: SAVE_VERSION,
    seed: 1,
    size,
    tick: 0,
    money: 0,
    taxRate: 0.1,
    smartCharging: false,
    storedEnergy: 0,
    layers: {
      tileType: new Uint8Array(bytes).buffer as ArrayBuffer,
      roadMask: new Uint8Array(bytes).buffer as ArrayBuffer,
      zone: new Uint8Array(bytes).buffer as ArrayBuffer,
      density: new Uint8Array(bytes).buffer as ArrayBuffer,
      variant: new Uint8Array(bytes).buffer as ArrayBuffer,
      supplied: new Uint8Array(bytes).buffer as ArrayBuffer,
      plantType: new Uint8Array(bytes).buffer as ArrayBuffer,
    },
  };
}

describe('save game JSON export/import', () => {
  it('round-trips a save game', () => {
    const state = createSimState(77, 16);
    buildRoads(state, [1, 2, 3]);
    state.goalsAchieved.add('firstPower');
    const save = serializeState(state);

    const restored = saveFromJson(saveToJson(save));
    expect(restored.seed).toBe(save.seed);
    expect(restored.tick).toBe(save.tick);
    expect(restored.money).toBe(save.money);
    expect(restored.goals).toEqual(['firstPower']);
    expect(new Uint8Array(restored.layers.tileType)).toEqual(new Uint8Array(save.layers.tileType));
  });

  it('rejects malformed input', () => {
    expect(() => saveFromJson('{}')).toThrow();
    expect(() => saveFromJson('not json')).toThrow();
  });

  it('rejects saves with truncated layers', () => {
    const state = createSimState(1, 8);
    const json = JSON.parse(saveToJson(serializeState(state)));
    json.layers.zone = 'AAAA';
    expect(() => saveFromJson(JSON.stringify(json))).toThrow(/wrong size/);
  });

  it('round-trips the optional terrain layer, river flow and pumped storage', () => {
    const save = makeSave();
    save.layers.terrain = new Uint8Array(save.size * save.size).fill(1).buffer as ArrayBuffer;
    save.riverFlow = 0.6;
    save.pumpedStorageEnergy = 42;
    const restored = saveFromJson(saveToJson(save));
    expect(new Uint8Array(restored.layers.terrain!)).toEqual(new Uint8Array(save.layers.terrain));
    expect(restored.riverFlow).toBe(0.6);
    expect(restored.pumpedStorageEnergy).toBe(42);
  });

  it('round-trips the stored hydrogen', () => {
    const save = makeSave();
    save.hydrogenEnergy = 1234;
    const restored = saveFromJson(saveToJson(save));
    expect(restored.hydrogenEnergy).toBe(1234);
  });

  it('round-trips the heat store and the warm-winter streak', () => {
    const save = makeSave();
    save.heatStored = 321;
    save.warmWinterTicks = 7;
    const restored = saveFromJson(saveToJson(save));
    expect(restored.heatStored).toBe(321);
    expect(restored.warmWinterTicks).toBe(7);
  });

  it('round-trips the market trading toggle', () => {
    const save = makeSave();
    save.marketTrading = true;
    expect(saveFromJson(saveToJson(save)).marketTrading).toBe(true);
    expect(saveFromJson(saveToJson(makeSave())).marketTrading).toBeUndefined();
  });

  it('round-trips the smart-meter rollout and the flexible backlog', () => {
    const save = makeSave();
    save.smartMeters = { active: true, metered: 3 };
    save.flexBacklog = 12.5;
    const restored = saveFromJson(saveToJson(save));
    expect(restored.smartMeters).toEqual({ active: true, metered: 3 });
    expect(restored.flexBacklog).toBe(12.5);
  });

  it('accepts an old save without smartMeters or flexBacklog', () => {
    const restored = saveFromJson(saveToJson(makeSave()));
    expect(restored.smartMeters).toBeUndefined();
    expect(restored.flexBacklog).toBeUndefined();
  });

  it('round-trips the optional forest layer', () => {
    const save = makeSave();
    const forest = new Uint8Array(save.size * save.size).fill(2);
    save.layers.forest = forest.buffer as ArrayBuffer;
    const restored = saveFromJson(saveToJson(save));
    expect(new Uint8Array(restored.layers.forest!)).toEqual(forest);
    expect(saveFromJson(saveToJson(makeSave())).layers.forest).toBeUndefined();
  });

  it('round-trips the optional geothermal layers', () => {
    const save = makeSave();
    const geothermal = new Uint8Array(save.size * save.size).fill(3);
    const heat = new Uint8Array(save.size * save.size).fill(120);
    save.layers.geothermal = geothermal.buffer as ArrayBuffer;
    save.layers.reservoirHeat = heat.buffer as ArrayBuffer;
    const restored = saveFromJson(saveToJson(save));
    expect(new Uint8Array(restored.layers.geothermal!)).toEqual(geothermal);
    expect(new Uint8Array(restored.layers.reservoirHeat!)).toEqual(heat);
    expect(saveFromJson(saveToJson(makeSave())).layers.geothermal).toBeUndefined();
  });

  it('accepts exports without the terrain layer', () => {
    const save = makeSave();
    const restored = saveFromJson(saveToJson(save));
    expect(restored.layers.terrain).toBeUndefined();
  });

  it('round-trips the optional power line layer', () => {
    const save = makeSave();
    save.layers.powerLine = new Uint8Array(save.size * save.size).fill(LINE_PRESENT)
      .buffer as ArrayBuffer;
    const restored = saveFromJson(saveToJson(save));
    expect(new Uint8Array(restored.layers.powerLine!)).toEqual(
      new Uint8Array(save.layers.powerLine),
    );
  });

  it('accepts exports without the power line layer', () => {
    const restored = saveFromJson(saveToJson(makeSave()));
    expect(restored.layers.powerLine).toBeUndefined();
  });

  it('rejects a wrongly sized power line layer', () => {
    const save = makeSave();
    save.layers.powerLine = new Uint8Array(3).buffer as ArrayBuffer;
    expect(() => saveFromJson(saveToJson(save))).toThrow(/powerLine/);
  });

  it('round-trips the optional elevation layer', () => {
    const save = makeSave();
    save.layers.elevation = new Uint8Array(save.size * save.size).fill(3).buffer as ArrayBuffer;
    const restored = saveFromJson(saveToJson(save));
    expect(new Uint8Array(restored.layers.elevation!)).toEqual(
      new Uint8Array(save.layers.elevation),
    );
  });

  it('accepts exports without the elevation layer', () => {
    const restored = saveFromJson(saveToJson(makeSave()));
    expect(restored.layers.elevation).toBeUndefined();
  });

  it('round-trips the optional road class layer', () => {
    const save = makeSave();
    save.layers.roadClass = new Uint8Array(save.size * save.size).fill(1).buffer as ArrayBuffer;
    const restored = saveFromJson(saveToJson(save));
    expect(new Uint8Array(restored.layers.roadClass!)).toEqual(
      new Uint8Array(save.layers.roadClass),
    );
    expect(saveFromJson(saveToJson(makeSave())).layers.roadClass).toBeUndefined();
  });

  it('round-trips season origin, snowpack and insulation', () => {
    const save = makeSave();
    save.seasonOriginDay = 9;
    save.snowpack = 0.25;
    save.insulation = true;
    const restored = saveFromJson(saveToJson(save));
    expect(restored.seasonOriginDay).toBe(9);
    expect(restored.snowpack).toBe(0.25);
    expect(restored.insulation).toBe(true);
  });

  it('round-trips winter resilience progress', () => {
    const save = makeSave();
    save.winterTicks = 4321;
    expect(saveFromJson(saveToJson(save)).winterTicks).toBe(4321);
  });

  it('accepts exports without winter progress', () => {
    expect(saveFromJson(saveToJson(makeSave())).winterTicks).toBeUndefined();
  });

  it('round-trips summer resilience progress', () => {
    const save = makeSave();
    save.summerTicks = 1234;
    expect(saveFromJson(saveToJson(save)).summerTicks).toBe(1234);
  });

  it('accepts exports without summer progress', () => {
    expect(saveFromJson(saveToJson(makeSave())).summerTicks).toBeUndefined();
  });

  it('round-trips free-flow progress', () => {
    const save = makeSave();
    save.freeFlowTicks = 1234;
    expect(saveFromJson(saveToJson(save)).freeFlowTicks).toBe(1234);
  });

  it('accepts exports without free-flow progress', () => {
    expect(saveFromJson(saveToJson(makeSave())).freeFlowTicks).toBeUndefined();
  });

  it('round-trips wellStockedTicks and leaves it undefined when absent', () => {
    const save = makeSave();
    save.wellStockedTicks = 321;
    expect(saveFromJson(saveToJson(save)).wellStockedTicks).toBe(321);
    expect(saveFromJson(saveToJson(makeSave())).wellStockedTicks).toBeUndefined();
  });

  it('accepts exports without season fields', () => {
    const restored = saveFromJson(saveToJson(makeSave()));
    expect(restored.seasonOriginDay).toBeUndefined();
    expect(restored.snowpack).toBeUndefined();
    expect(restored.insulation).toBeUndefined();
  });

  it('round-trips transitTicks and the busStop layer, leaving both undefined when absent', () => {
    const save = makeSave();
    save.transitTicks = 44;
    save.layers.busStop = new Uint8Array(save.size * save.size).fill(1).buffer as ArrayBuffer;
    const restored = saveFromJson(saveToJson(save));
    expect(restored.transitTicks).toBe(44);
    expect(new Uint8Array(restored.layers.busStop!)).toEqual(new Uint8Array(save.layers.busStop));
    const plain = saveFromJson(saveToJson(makeSave()));
    expect(plain.transitTicks).toBeUndefined();
    expect(plain.layers.busStop).toBeUndefined();
  });

  it('round-trips the damage layer, intensity and events in flight', () => {
    const save = makeSave();
    save.disasterScale = 1.6;
    save.disasters = {
      nextId: 7,
      cooldownTicks: 42,
      events: [
        {
          id: 6,
          kind: 1,
          severity: 0.8,
          startTick: 100,
          endTick: 180,
          origin: 5,
          tiles: [5, 6],
          intensity: [24, 12],
          active: true,
        },
      ],
    };
    const damage = new Uint8Array(save.size * save.size);
    damage[0] = 9;
    save.layers.damage = damage.buffer as ArrayBuffer;
    const restored = saveFromJson(saveToJson(save));
    expect(restored.disasterScale).toBe(1.6);
    expect(restored.disasters?.events[0].intensity).toEqual([24, 12]);
    expect(new Uint8Array(restored.layers.damage!)[0]).toBe(9);
  });

  it('drops a malformed disasters block instead of loading a broken cooldown', () => {
    // A missing cooldownTicks would become undefined, where both `> 0` and
    // `=== 0` are false: the loaded city would never roll another disaster
    // again. Dropping the whole block is the safe fallback — no events in
    // flight, but future ones can still be scheduled.
    const save = makeSave();
    save.disasterScale = 1;
    const json = JSON.parse(saveToJson(save));
    json.disasters = { nextId: 7, events: [] }; // cooldownTicks missing
    const restored = saveFromJson(JSON.stringify(json));
    expect(restored.disasters).toBeUndefined();
    expect(restored.disasterScale).toBe(1);
  });
});
