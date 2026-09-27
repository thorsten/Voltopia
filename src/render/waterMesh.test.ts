import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { TileDiff } from '../shared/types.ts';
import { Terrain } from '../shared/types.ts';
import { ElevationField, LEVEL_HEIGHT } from './elevationField.ts';
import { createSimState, type SimState } from '../sim/state.ts';
import { generateTerrain } from '../sim/terrain.ts';
import { generateWater } from '../sim/water.ts';
import type { RenderEnvironment } from './renderer.ts';
import { WATER_HEIGHT, WaterMesh } from './waterMesh.ts';

const SIZE = 8;

const position = new THREE.Vector3();
const quaternion = new THREE.Quaternion();
const scale = new THREE.Vector3();

/**
 * World-space top and bottom of a sea tile's water at one tide level.
 * The map is flat at level 0, so the seabed under the sea band is y = 0.
 */
function seaBounds(tideLevel: number, reducedMotion = false): { top: number; bottom: number } {
  const scene = new THREE.Scene();
  const field = new ElevationField(SIZE);
  const diffs: TileDiff[] = [];
  for (let index = 0; index < SIZE * SIZE; index++) {
    // The first row is sea, the rest is land at sea level.
    const terrain = index < SIZE ? Terrain.Sea : Terrain.Land;
    diffs.push({ index, elevation: 0, terrain } as TileDiff);
  }
  field.applyDiffs(diffs);

  const water = new WaterMesh(scene, SIZE, field);
  water.setReducedMotion(reducedMotion);
  water.applyDiffs(diffs);
  water.setEnvironment({ nightFactor: 0, tideLevel } as RenderEnvironment);
  water.update(0.25, 0);

  // Only sea tiles exist, so the sole non-empty instanced mesh is the sea.
  const sea = scene.children.find(
    (child): child is THREE.InstancedMesh =>
      child instanceof THREE.InstancedMesh && child.count > 0,
  );
  expect(sea).toBeDefined();
  scene.updateMatrixWorld(true);
  const instance = new THREE.Matrix4();
  sea!.getMatrixAt(0, instance);
  new THREE.Matrix4()
    .multiplyMatrices(sea!.matrixWorld, instance)
    .decompose(position, quaternion, scale);
  return { top: position.y + scale.y / 2, bottom: position.y - scale.y / 2 };
}

/** Tide levels across the full -1..1 range the tide clock produces. */
const LEVELS = Array.from({ length: 21 }, (_, i) => -1 + i * 0.1);

describe('sea surface over the tidal range', () => {
  it('stays above the seabed at every tide level', () => {
    // Regression: the sea used to be a thin slab moved bodily by the
    // tide, so below level -0.3 it sank into the opaque ground mesh and
    // the sea simply vanished for a quarter of every tidal cycle.
    for (const level of LEVELS) {
      expect(seaBounds(level).top).toBeGreaterThan(0);
    }
  });

  it('never floats above the seabed', () => {
    // The water is a column, not a hovering sheet: its underside stays
    // at or below the ground so no gap opens at high water.
    for (const level of LEVELS) {
      expect(seaBounds(level).bottom).toBeLessThanOrEqual(0);
    }
  });

  it('still rises and falls with the tide', () => {
    const low = seaBounds(-1).top;
    const high = seaBounds(1).top;
    expect(high).toBeGreaterThan(low);
    // The visible swing is the full peak-to-peak tidal range.
    expect(high - low).toBeCloseTo(0.1, 6);
  });

  it('holds the mean level when motion is reduced', () => {
    const still = seaBounds(-1, true);
    expect(still.top).toBeCloseTo(seaBounds(1, true).top, 6);
    expect(still.top).toBeGreaterThan(0);
  });
});

/**
 * The contract the ground and the water meshes share on a real generated
 * map: wherever water is drawn, the opaque ground beneath it must stay
 * below the water's own surface. Averaged corners used to lift the shore
 * halfway up the bank, so the ground rendered through the sea and lake
 * surfaces as green wedges — worst at a river mouth, where the steepest
 * bank, the river and the sea meet.
 */
describe('ground under water on generated maps', () => {
  const MAP_SIZE = 48;

  function generated(seed: number): { state: SimState; field: ElevationField } {
    const state = createSimState(seed, MAP_SIZE);
    generateTerrain(state);
    generateWater(state);
    const field = new ElevationField(MAP_SIZE);
    const diffs: TileDiff[] = [];
    for (let index = 0; index < MAP_SIZE * MAP_SIZE; index++) {
      diffs.push({
        index,
        elevation: state.layers.elevation[index],
        terrain: state.layers.terrain[index],
      } as TileDiff);
    }
    field.applyDiffs(diffs);
    return { state, field };
  }

  it('never lets the ground rise above a sea tile at any tide', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const { state, field } = generated(seed);
      for (let index = 0; index < state.layers.terrain.length; index++) {
        if (state.layers.terrain[index] !== Terrain.Sea) continue;
        // Lowest the sea surface ever gets: mean level minus the full tide.
        expect(field.maxCornerY(index)).toBeLessThan(WATER_HEIGHT);
      }
    }
  });

  it('never lets the ground rise above a lake or river surface', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const { state, field } = generated(seed);
      const { terrain, elevation } = state.layers;
      for (let index = 0; index < terrain.length; index++) {
        if (terrain[index] !== Terrain.Lake && terrain[index] !== Terrain.River) continue;
        const surface = elevation[index] * LEVEL_HEIGHT + WATER_HEIGHT;
        expect(field.maxCornerY(index)).toBeLessThan(surface);
      }
    }
  });
});
