import { describe, expect, it } from 'vitest';
import { BALANCE } from '../shared/constants.ts';
import { chebyshevDistance, neighbors4 } from '../shared/grid.ts';
import { Terrain } from '../shared/types.ts';
import { generateGeothermal, FULL_HEAT } from './geothermal.ts';
import { createSimState, slopeAt, type SimState } from './state.ts';
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
