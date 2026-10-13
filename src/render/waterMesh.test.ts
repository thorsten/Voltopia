import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { TileDiff } from '../shared/types.ts';
import { Terrain } from '../shared/types.ts';
import { ElevationField, LEVEL_HEIGHT } from './elevationField.ts';
import { createSimState, type SimState } from '../sim/state.ts';
import { generateTerrain } from '../sim/terrain.ts';
import { generateWater } from '../sim/water.ts';
import type { RenderEnvironment } from './renderer.ts';
import { RIPPLE_PERIOD } from './nature/waterShader.ts';
import { WATER_HEIGHT, WATER_THICKNESS, WaterMesh } from './waterMesh.ts';

/** Water top above its bed beyond WATER_HEIGHT: the slab's thickness. */
const WATER_SURFACE_GAP = WATER_THICKNESS;

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

  // Only sea tiles exist, so the sole non-empty box column is the sea
  // (the foam strips along the coast are flat planes, not boxes).
  const sea = scene.children.find(
    (child): child is THREE.InstancedMesh =>
      child instanceof THREE.InstancedMesh &&
      child.geometry instanceof THREE.BoxGeometry &&
      child.count > 0,
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

describe('water ripples', () => {
  function water(reducedMotion: boolean): WaterMesh {
    const mesh = new WaterMesh(new THREE.Scene(), SIZE, new ElevationField(SIZE));
    mesh.setReducedMotion(reducedMotion);
    return mesh;
  }

  it('advance with frame time', () => {
    const mesh = water(false);
    const before = mesh.rippleTime;
    mesh.update(0.5, 0);
    expect(mesh.rippleTime).toBeCloseTo(before + 0.5, 6);
  });

  it('wrap at the common wave period', () => {
    const mesh = water(false);
    mesh.update(1e7, 0);
    expect(mesh.rippleTime).toBeGreaterThanOrEqual(0);
    expect(mesh.rippleTime).toBeLessThan(RIPPLE_PERIOD);
  });

  it('freeze when motion is reduced', () => {
    const mesh = water(true);
    const before = mesh.rippleTime;
    mesh.update(0.5, 0);
    expect(mesh.rippleTime).toBe(before);
  });
});

describe('foam edges', () => {
  /** Builds a water layer over a map whose tiles come from `terrainAt`. */
  function foamMap(
    size: number,
    terrainAt: (x: number, z: number) => Terrain,
    levelAt: (x: number, z: number) => number = () => 0,
  ): { scene: THREE.Scene; field: ElevationField; water: WaterMesh } {
    const scene = new THREE.Scene();
    const field = new ElevationField(size);
    const diffs: TileDiff[] = [];
    for (let index = 0; index < size * size; index++) {
      const x = index % size;
      const z = Math.floor(index / size);
      diffs.push({ index, elevation: levelAt(x, z), terrain: terrainAt(x, z) } as TileDiff);
    }
    field.applyDiffs(diffs);
    const water = new WaterMesh(scene, size, field);
    water.applyDiffs(diffs);
    return { scene, field, water };
  }

  function foamMesh(scene: THREE.Scene, name: string): THREE.InstancedMesh {
    const mesh = scene.getObjectByName(name);
    expect(mesh).toBeInstanceOf(THREE.InstancedMesh);
    return mesh as THREE.InstancedMesh;
  }

  it('lines a lake with one strip per shore edge', () => {
    const lake = (x: number, z: number): boolean => x >= 2 && x <= 3 && z >= 2 && z <= 3;
    const { water } = foamMap(6, (x, z) => (lake(x, z) ? Terrain.Lake : Terrain.Land));
    expect(water.foamCount).toEqual({ inland: 8, sea: 0 });
  });

  it('lines both banks of a river but not between river tiles', () => {
    const { water } = foamMap(8, (x) => (x === 3 ? Terrain.River : Terrain.Land));
    // Eight river tiles, two banks each; the map border and the river's
    // own tiles above and below carry no foam.
    expect(water.foamCount).toEqual({ inland: 16, sea: 0 });
  });

  it('lines a coast only where the sea meets land', () => {
    const { water } = foamMap(8, (_x, z) => (z === 0 ? Terrain.Sea : Terrain.Land));
    expect(water.foamCount).toEqual({ inland: 0, sea: 8 });
  });

  it('leaves the edge between a lake and a river bare', () => {
    // Lake at (2,2), river at (3,2): each has three land neighbours.
    const { water } = foamMap(6, (x, z) => {
      if (z !== 2) return Terrain.Land;
      if (x === 2) return Terrain.Lake;
      return x === 3 ? Terrain.River : Terrain.Land;
    });
    expect(water.foamCount).toEqual({ inland: 6, sea: 0 });
  });

  it('floats inland foam on the water surface', () => {
    // A river runs down a slope next to a raised lake.
    const terrainAt = (x: number, z: number): Terrain => {
      if (x === 3) return Terrain.River;
      return x === 6 && z === 6 ? Terrain.Lake : Terrain.Land;
    };
    const { scene, field } = foamMap(8, terrainAt, (_x, z) => Math.floor(z / 2));
    const inland = foamMesh(scene, 'inlandFoam');
    expect(inland.count).toBeGreaterThan(0);
    scene.updateMatrixWorld(true);
    const instance = new THREE.Matrix4();
    for (let i = 0; i < inland.count; i++) {
      inland.getMatrixAt(i, instance);
      new THREE.Matrix4()
        .multiplyMatrices(inland.matrixWorld, instance)
        .decompose(position, quaternion, scale);
      const x = Math.floor(position.x);
      const z = Math.floor(position.z);
      // Lakes share one flat level; a river follows its bed downhill.
      const bed =
        terrainAt(x, z) === Terrain.Lake
          ? field.centerY(z * 8 + x)
          : field.surfaceY(position.x, position.z);
      expect(position.y).toBeGreaterThan(bed + WATER_HEIGHT);
    }
  });

  it('lays river foam along a sloping bank, both ends on the water', () => {
    // A river running down the x = 3 column drops one level halfway.
    const size = 8;
    const { scene, field } = foamMap(
      size,
      (x) => (x === 3 ? Terrain.River : Terrain.Land),
      (_x, z) => (z < size / 2 ? 1 : 0),
    );
    const inland = foamMesh(scene, 'inlandFoam');
    expect(inland.count).toBeGreaterThan(0);
    scene.updateMatrixWorld(true);
    const instance = new THREE.Matrix4();
    const world = new THREE.Matrix4();
    const end = new THREE.Vector3();
    let steepest = 0;
    for (let i = 0; i < inland.count; i++) {
      inland.getMatrixAt(i, instance);
      world.multiplyMatrices(inland.matrixWorld, instance);
      const ends = [-0.5, 0.5].map((x) => end.set(x, 0, 0).applyMatrix4(world).clone());
      steepest = Math.max(steepest, Math.abs(ends[1].y - ends[0].y));
      for (const point of ends) {
        const surface = field.surfaceY(point.x, point.z) + WATER_HEIGHT + WATER_SURFACE_GAP;
        expect(point.y - surface).toBeGreaterThanOrEqual(0);
        expect(point.y - surface).toBeLessThanOrEqual(0.02);
      }
    }
    // The bank across the drop really is tilted.
    expect(steepest).toBeGreaterThan(LEVEL_HEIGHT / 2);
  });

  function seaFoamY(tideLevel: number, reducedMotion: boolean): number {
    const { scene, water } = foamMap(8, (_x, z) => (z === 0 ? Terrain.Sea : Terrain.Land));
    water.setReducedMotion(reducedMotion);
    water.setEnvironment({ nightFactor: 0, tideLevel } as RenderEnvironment);
    water.update(0.25, 0);
    const sea = foamMesh(scene, 'seaFoam');
    scene.updateMatrixWorld(true);
    const instance = new THREE.Matrix4();
    sea.getMatrixAt(0, instance);
    new THREE.Matrix4()
      .multiplyMatrices(sea.matrixWorld, instance)
      .decompose(position, quaternion, scale);
    return position.y;
  }

  it('lets sea foam ride the tide', () => {
    expect(seaFoamY(1, false)).toBeGreaterThan(seaFoamY(-1, false));
    // It floats on the surface: above the highest point of the sea column.
    expect(seaFoamY(1, false)).toBeGreaterThan(seaBounds(1).top);
  });

  it('holds sea foam still when motion is reduced', () => {
    expect(seaFoamY(1, true)).toBeCloseTo(seaFoamY(-1, true), 6);
  });

  it('dims foam at night', () => {
    function opacity(nightFactor: number): number {
      const { scene, water } = foamMap(6, (x, z) =>
        x === 2 && z === 2 ? Terrain.Lake : Terrain.Land,
      );
      water.setEnvironment({ nightFactor, tideLevel: 0 } as RenderEnvironment);
      water.update(0.25, 3);
      return (foamMesh(scene, 'inlandFoam').material as THREE.MeshBasicMaterial).opacity;
    }
    expect(opacity(1)).toBeLessThan(opacity(0));
  });
});
