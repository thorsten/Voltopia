import { describe, expect, it } from 'vitest';
import { BALANCE } from '../shared/constants.ts';
import { Rng } from '../shared/rng.ts';
import {
  PlantType,
  RoadClass,
  RoadLane,
  SupplyStatus,
  Terrain,
  TileType,
  Zone,
} from '../shared/types.ts';
import { SAVE_LAYERS } from '../storage/serialization.ts';
import { SimEngine } from './engine.ts';
import { createSimState, deserializeState, serializeState } from './state.ts';

const SIZE = 16;
const TICKS = 200;
const KNOWN_PLANTS = new Set<number>(Object.values(PlantType));

/** Layer bytes from a share link or a hand-edited export: anything goes. */
function randomLayer(rng: Rng): ArrayBuffer {
  const bytes = new Uint8Array(SIZE * SIZE);
  for (let i = 0; i < bytes.length; i++) {
    // Half small values (plausible enums), half the full byte range.
    bytes[i] = rng.next() < 0.5 ? rng.nextInt(6) : rng.nextInt(256);
  }
  return bytes.buffer;
}

describe('loading untrusted layer bytes', () => {
  it.each([1, 2, 3, 4])('survives random layers (seed %i)', (seed) => {
    const rng = new Rng(seed);
    const save = serializeState(createSimState(seed, SIZE));
    for (const name of SAVE_LAYERS) save.layers[name] = randomLayer(rng);
    const engine = new SimEngine(seed, SIZE);
    engine.state = deserializeState(save);
    const { tileType, plantType } = engine.state.layers;
    for (let t = 0; t < TICKS; t++) {
      engine.tick();
      expect(Number.isFinite(engine.state.money)).toBe(true);
    }
    for (let i = 0; i < tileType.length; i++) {
      expect(tileType[i]).toBeLessThanOrEqual(TileType.Plant);
      if (tileType[i] === TileType.Plant) expect(KNOWN_PLANTS.has(plantType[i])).toBe(true);
    }
  });

  it('keeps valid layers byte-identical, top of every range included', () => {
    const state = createSimState(5, SIZE);
    const { layers } = state;
    layers.tileType[0] = TileType.Plant;
    layers.plantType[0] = PlantType.RailYard;
    layers.zone[1] = Zone.Industrial;
    layers.density[1] = BALANCE.growth.populationByDensity.length - 1;
    layers.supplied[1] = SupplyStatus.Supplied;
    layers.terrain[2] = Terrain.Sea;
    layers.elevation[3] = BALANCE.terrain.maxLevel;
    layers.forest[4] = BALANCE.forest.maxStage;
    layers.tileType[5] = TileType.Road;
    layers.roadClass[5] = RoadClass.Avenue;
    layers.roadLane[5] = RoadLane.Pedestrian;
    layers.geothermal[6] = BALANCE.geothermal.qualityFactor.length - 1;
    layers.damage[7] = 255;
    layers.reservoirHeat[8] = 255;
    const save = serializeState(state);
    const loaded = serializeState(deserializeState(save));
    for (const name of SAVE_LAYERS) {
      expect(new Uint8Array(loaded.layers[name]!), name).toEqual(
        new Uint8Array(save.layers[name]!),
      );
    }
  });
});
