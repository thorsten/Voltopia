import { describe, expect, it } from 'vitest';
import { BALANCE } from '../shared/constants.ts';
import { chebyshevDistance, neighbors4 } from '../shared/grid.ts';
import { PlantType, Terrain, TileType } from '../shared/types.ts';
import {
  discoverGeothermalFields,
  fieldAt,
  generateGeothermal,
  reservoirStep,
  FULL_HEAT,
} from './geothermal.ts';
import {
  createSimState,
  deserializeState,
  serializeState,
  slopeAt,
  type SimState,
} from './state.ts';
import { generateTerrain } from './terrain.ts';
import { generateWater } from './water.ts';

function mapWithHotspots(seed: number, size = 64): SimState {
  const state = createSimState(seed, size);
  generateTerrain(state);
  generateWater(state);
  generateGeothermal(state);
  return state;
}

/** Tile indices of every hotspot tile. */
function hotspots(state: SimState): number[] {
  const tiles: number[] = [];
  for (let i = 0; i < state.layers.geothermal.length; i++) {
    if (state.layers.geothermal[i] !== 0) tiles.push(i);
  }
  return tiles;
}

describe('geothermal generation', () => {
  it('is deterministic per seed', () => {
    expect(hotspots(mapWithHotspots(99))).toEqual(hotspots(mapWithHotspots(99)));
    expect(hotspots(mapWithHotspots(99))).not.toEqual(hotspots(mapWithHotspots(100)));
  });

  it('places hotspots only on buildable land', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const state = mapWithHotspots(seed);
      for (const index of hotspots(state)) {
        expect(state.layers.terrain[index]).toBe(Terrain.Land);
        expect(slopeAt(state, index)).toBeLessThanOrEqual(BALANCE.terrain.maxBuildSlope);
      }
    }
  });

  it('gives every hotspot tile a quality of 1..3 and a full reservoir', () => {
    const state = mapWithHotspots(7);
    for (const index of hotspots(state)) {
      expect(state.layers.geothermal[index]).toBeGreaterThanOrEqual(1);
      expect(state.layers.geothermal[index]).toBeLessThanOrEqual(3);
      expect(state.layers.reservoirHeat[index]).toBe(FULL_HEAT);
    }
    // Off a hotspot the reservoir layer stays empty.
    const off = state.layers.geothermal.findIndex((q) => q === 0);
    expect(state.layers.reservoirHeat[off]).toBe(0);
  });

  it('keeps fields apart and within the configured count', () => {
    const cfg = BALANCE.geothermal;
    for (const seed of [11, 12, 13]) {
      const state = mapWithHotspots(seed);
      const fields = componentsOf(state);
      expect(fields.length).toBeGreaterThanOrEqual(1);
      expect(fields.length).toBeLessThanOrEqual(cfg.maxSpots);
      for (const field of fields) {
        expect(field.length).toBeGreaterThanOrEqual(cfg.clusterSizeRange[0]);
        expect(field.length).toBeLessThanOrEqual(cfg.clusterSizeRange[1]);
      }
      // Seeds are minSpotDistance apart, so two fields never touch.
      //
      // The generator only guarantees fields don't share a 4-neighbour
      // (componentsOf floods on neighbors4), which is weaker than the
      // Chebyshev distance > 1 asserted below — that stronger claim is
      // empirical for the current constants (measured: zero violations
      // across seeds 1..400), not true by construction. Shrinking
      // minSpotDistance or growing clusterSizeRange is what would break it.
      for (let a = 0; a < fields.length; a++) {
        for (let b = a + 1; b < fields.length; b++) {
          const nearest = Math.min(
            ...fields[a].flatMap((i) => fields[b].map((j) => chebyshevDistance(i, j, state.size))),
          );
          expect(nearest).toBeGreaterThan(1);
        }
      }
    }
  });

  it('favours the highlands without requiring them', () => {
    let highland = 0;
    let total = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const state = mapWithHotspots(seed);
      for (const index of hotspots(state)) {
        total++;
        if (state.layers.elevation[index] >= BALANCE.geothermal.highlandLevel) highland++;
      }
    }
    expect(total).toBeGreaterThan(0);
    // Highland tiles are a minority of any map, so an unbiased draw would
    // land far below this; the weight has to show.
    expect(highland / total).toBeGreaterThan(0.3);
  });

  it('still places fields on a map with no highland at all', () => {
    const state = createSimState(4, 64);
    // Flat map: no tile reaches highlandLevel.
    state.layers.elevation.fill(0);
    generateGeothermal(state);
    expect(hotspots(state).length).toBeGreaterThan(0);
  });
});

/** Connected components of the hotspot layer, as tile-index lists. */
function componentsOf(state: SimState): number[][] {
  const { geothermal } = state.layers;
  const seen = new Set<number>();
  const out: number[][] = [];
  for (let i = 0; i < geothermal.length; i++) {
    if (geothermal[i] === 0 || seen.has(i)) continue;
    const tiles: number[] = [];
    const stack = [i];
    seen.add(i);
    while (stack.length > 0) {
      const index = stack.pop()!;
      tiles.push(index);
      for (const n of neighbors4(index, state.size)) {
        if (geothermal[n] !== 0 && !seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
    out.push(tiles);
  }
  return out;
}

/** A 16×16 flat map with one 4-tile field and nothing else. */
function fieldMap(): SimState {
  const state = createSimState(3, 16);
  for (const index of [34, 35, 50, 51]) {
    state.layers.geothermal[index] = 2;
    state.layers.reservoirHeat[index] = FULL_HEAT;
  }
  discoverGeothermalFields(state);
  return state;
}

function drill(state: SimState, index: number): void {
  state.layers.tileType[index] = TileType.Plant;
  state.layers.plantType[index] = PlantType.GeothermalPlant;
}

describe('geothermal fields', () => {
  it('finds one field per connected hotspot cluster', () => {
    const state = fieldMap();
    expect(state.geothermalFields).toHaveLength(1);
    expect(state.geothermalFields[0].tiles.sort((a, b) => a - b)).toEqual([34, 35, 50, 51]);
    expect(state.geothermalFields[0].quality).toBe(2);
    // 4 tiles × sustainablePerTile 0.5 × qualityFactor 1.0 = 2 wells.
    expect(state.geothermalFields[0].capacity).toBe(2);
    expect(fieldAt(state, 35)).toBe(state.geothermalFields[0]);
    expect(fieldAt(state, 0)).toBeUndefined();
  });

  it('separates two distinct fields', () => {
    const state = createSimState(5, 16);
    // Quality-2 cluster at rows 2-3, cols 2-3 (same as fieldMap()).
    for (const index of [34, 35, 50, 51]) {
      state.layers.geothermal[index] = 2;
      state.layers.reservoirHeat[index] = FULL_HEAT;
    }
    // Quality-1 cluster far away at row 10, cols 10-11.
    for (const index of [170, 171]) {
      state.layers.geothermal[index] = 1;
      state.layers.reservoirHeat[index] = FULL_HEAT;
    }
    discoverGeothermalFields(state);
    expect(state.geothermalFields).toHaveLength(2);
    const byQuality = (quality: number) =>
      state.geothermalFields.find((field) => field.quality === quality)!;
    const bigField = byQuality(2);
    expect(bigField.tiles.sort((a, b) => a - b)).toEqual([34, 35, 50, 51]);
    // 4 tiles × sustainablePerTile 0.5 × qualityFactor 1.0 = 2 wells.
    expect(bigField.capacity).toBe(2);
    const smallField = byQuality(1);
    expect(smallField.tiles.sort((a, b) => a - b)).toEqual([170, 171]);
    // 2 tiles × sustainablePerTile 0.5 × qualityFactor 0.7 = 0.7, rounds to 1.
    expect(smallField.capacity).toBe(1);
  });

  it('holds a full reservoir at or below capacity', () => {
    const state = fieldMap();
    drill(state, 34);
    drill(state, 35);
    for (let i = 0; i < 5000; i++) reservoirStep(state);
    expect(state.geothermalFields[0].heat).toBeCloseTo(1, 6);
    expect(state.layers.reservoirHeat[34]).toBe(FULL_HEAT);
  });

  it('cools toward the predicted equilibrium when overdrilled', () => {
    const state = fieldMap();
    for (const index of [34, 35, 50]) drill(state, index); // one well over capacity
    const { recharge, drain } = BALANCE.geothermal;
    const expected = recharge / (recharge + drain);
    for (let i = 0; i < 20_000; i++) reservoirStep(state);
    expect(state.geothermalFields[0].heat).toBeCloseTo(expected, 3);
    // Every tile of the field carries the same quantised value.
    expect(state.layers.reservoirHeat[51]).toBe(state.layers.reservoirHeat[34]);
    expect(state.layers.reservoirHeat[34]).toBe(Math.round(expected * FULL_HEAT));
  });

  it('recovers once the excess wells are gone', () => {
    const state = fieldMap();
    for (const index of [34, 35, 50]) drill(state, index);
    for (let i = 0; i < 20_000; i++) reservoirStep(state);
    expect(state.geothermalFields[0].heat).toBeLessThan(0.9);
    state.layers.tileType[50] = TileType.Empty;
    state.layers.plantType[50] = PlantType.None;
    for (let i = 0; i < 20_000; i++) reservoirStep(state);
    expect(state.geothermalFields[0].heat).toBeCloseTo(1, 3);
  });

  it('stays within 0..1 under the heaviest possible load', () => {
    const state = fieldMap();
    for (const index of [34, 35, 50, 51]) drill(state, index);
    for (let i = 0; i < 100_000; i++) reservoirStep(state);
    expect(state.geothermalFields[0].heat).toBeGreaterThan(0);
    expect(state.geothermalFields[0].heat).toBeLessThanOrEqual(1);
  });

  it('marks tiles dirty only when the quantised value changes', () => {
    const state = fieldMap();
    for (const index of [34, 35, 50]) drill(state, index);
    state.dirty.clear();
    reservoirStep(state);
    // One tick of drift is far below one 1/255 step.
    expect(state.dirty.size).toBe(0);
    for (let i = 0; i < 200; i++) reservoirStep(state);
    expect(state.dirty.size).toBeGreaterThan(0);
  });
});

describe('geothermal save compatibility', () => {
  it('restores fields and heat from a save', () => {
    const state = fieldMap();
    state.geothermalFields[0].heat = 0.5;
    state.layers.reservoirHeat.fill(0);
    for (const index of state.geothermalFields[0].tiles) {
      state.layers.reservoirHeat[index] = Math.round(0.5 * FULL_HEAT);
    }
    const restored = deserializeState(serializeState(state));
    expect(restored.geothermalFields).toHaveLength(1);
    expect(restored.geothermalFields[0].heat).toBeCloseTo(0.5, 2);
    expect(restored.geothermalFields[0].capacity).toBe(2);
  });

  it('regenerates hotspots for a save written before the feature', () => {
    const fresh = mapWithHotspots(21);
    const save = serializeState(fresh);
    delete save.layers.geothermal;
    delete save.layers.reservoirHeat;
    const restored = deserializeState(save);
    expect([...restored.layers.geothermal]).toEqual([...fresh.layers.geothermal]);
    expect(restored.geothermalFields.every((field) => field.heat === 1)).toBe(true);
  });
});
