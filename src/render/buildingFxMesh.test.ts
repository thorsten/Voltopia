import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { SupplyStatus } from '../shared/types.ts';
import type { RenderEnvironment } from './renderer.ts';
import { PartRole } from './buildings/recipes.ts';
import type { AccentAnchor, AccentState } from './buildings/accents.ts';
import { MAX_PUFF_ANCHORS_PER_TILE } from './buildings/accents.ts';
import { BuildingFxMesh, PUFFS_PER_EMITTER } from './buildingFxMesh.ts';

const SIZE = 8;
const TILE = 3 * SIZE + 3;

function environment(temperature: number, nightFactor = 0): RenderEnvironment {
  return {
    nightFactor,
    sunFactor: 1 - nightFactor,
    windFactor: 0.3,
    stateOfCharge: 0.5,
    tideLevel: 0,
    demand: { residential: 0, commercial: 0, retail: 0 },
    phase: 0.75,
    temperature,
    snowCover: 0,
    sunrise: 0.3,
    sunset: 0.7,
    solarStrength: 0.5,
  };
}

function chimney(): AccentAnchor[] {
  return [{ role: PartRole.Chimney, x: 3.5, y: 0.5, z: 3.5 }];
}

function vents(): AccentAnchor[] {
  return [
    { role: PartRole.Vent, x: 3.3, y: 1.0, z: 3.5 },
    { role: PartRole.Vent, x: 3.7, y: 1.0, z: 3.5 },
  ];
}

function state(overrides: Partial<AccentState> = {}): AccentState {
  return { heated: false, supplied: SupplyStatus.Supplied, damaged: false, ...overrides };
}

function setup(): { scene: THREE.Scene; fx: BuildingFxMesh } {
  const scene = new THREE.Scene();
  const fx = new BuildingFxMesh(scene, SIZE);
  return { scene, fx };
}

describe('BuildingFxMesh puffs', () => {
  it('creates culling-free puff and beacon meshes sized for the whole grid', () => {
    const { scene, fx } = setup();
    expect(fx.puffs.frustumCulled).toBe(false);
    expect(fx.beacons.frustumCulled).toBe(false);
    expect(fx.puffs.instanceMatrix.count).toBe(
      SIZE * SIZE * MAX_PUFF_ANCHORS_PER_TILE * PUFFS_PER_EMITTER,
    );
    expect(fx.beacons.instanceMatrix.count).toBe(SIZE * SIZE);
    expect(scene.children).toContain(fx.puffs);
    expect(scene.children).toContain(fx.beacons);
    expect(fx.puffs.count).toBe(0);
  });

  it('smokes a cold, self-heated, powered, intact chimney with three puffs', () => {
    const { fx } = setup();
    fx.set(TILE, chimney(), state());
    fx.setEnvironment(environment(0));
    fx.update(0.016, 1);
    expect(fx.puffs.count).toBe(PUFFS_PER_EMITTER);
  });

  it.each([
    ['on district heat', state({ heated: true }), 0, 0],
    ['not connected', state({ supplied: SupplyStatus.NotConnected }), 0, 0],
    ['damaged', state({ damaged: true }), 0, 0],
    ['warm (comfort temperature)', state(), 16, 0],
    [
      'undersupplied (still smokes)',
      state({ supplied: SupplyStatus.Undersupplied }),
      0,
      PUFFS_PER_EMITTER,
    ],
  ])('%s', (_label, s, temperature, expected) => {
    const { fx } = setup();
    fx.set(TILE, chimney(), s);
    fx.setEnvironment(environment(temperature));
    fx.update(0.016, 1);
    expect(fx.puffs.count).toBe(expected);
  });

  it('smokes harder in a deep freeze than on a cool day', () => {
    const cold = setup();
    cold.fx.set(TILE, chimney(), state());
    cold.fx.setEnvironment(environment(-4));
    cold.fx.update(0.016, 1);
    const cool = setup();
    cool.fx.set(TILE, chimney(), state());
    cool.fx.setEnvironment(environment(10));
    cool.fx.update(0.016, 1);
    const a = new THREE.Color();
    const b = new THREE.Color();
    cold.fx.puffs.getColorAt(0, a);
    cool.fx.puffs.getColorAt(0, b);
    expect(a.r).toBeGreaterThan(b.r);
  });

  it('puffs from both vent stacks of a fully supplied hall, in any season', () => {
    const { fx } = setup();
    fx.set(TILE, vents(), state());
    fx.setEnvironment(environment(28));
    fx.update(0.016, 1);
    expect(fx.puffs.count).toBe(2 * PUFFS_PER_EMITTER);
    fx.setState(TILE, state({ supplied: SupplyStatus.Undersupplied }));
    fx.update(0.016, 2);
    expect(fx.puffs.count).toBe(0);
  });

  it('rises between frames with motion on', () => {
    const { fx } = setup();
    fx.set(TILE, chimney(), state());
    fx.setEnvironment(environment(0));
    fx.update(0.016, 0);
    const before = new THREE.Matrix4();
    fx.puffs.getMatrixAt(0, before);
    fx.update(0.016, 0.4);
    const after = new THREE.Matrix4();
    fx.puffs.getMatrixAt(0, after);
    expect(after.equals(before)).toBe(false);
    // Every puff stays above its anchor and inside its rise.
    const p = new THREE.Vector3();
    for (let i = 0; i < fx.puffs.count; i++) {
      fx.puffs.getMatrixAt(i, after);
      p.setFromMatrixPosition(after);
      expect(p.y).toBeGreaterThanOrEqual(0.5);
      expect(p.y).toBeLessThanOrEqual(0.5 + 0.35 + 1e-9);
    }
  });

  it('freezes with reduced motion and skips redundant rebuilds, but rebuilds on a real change', () => {
    const { fx } = setup();
    fx.setReducedMotion(true);
    fx.set(TILE, chimney(), state());
    fx.setEnvironment(environment(0));
    fx.update(0.016, 0);
    const before = new THREE.Matrix4();
    fx.puffs.getMatrixAt(0, before);
    const setMatrixAt = vi.spyOn(fx.puffs, 'setMatrixAt');
    fx.update(0.016, 5);
    expect(setMatrixAt).not.toHaveBeenCalled();
    const after = new THREE.Matrix4();
    fx.puffs.getMatrixAt(0, after);
    expect(after.equals(before)).toBe(true);
    // A heat-network connection is a real change.
    fx.setState(TILE, state({ heated: true }));
    fx.update(0.016, 5);
    expect(fx.puffs.count).toBe(0);
    // So is a temperature move beyond the epsilon, but not a tiny one.
    fx.setState(TILE, state());
    fx.update(0.016, 6);
    setMatrixAt.mockClear();
    fx.setEnvironment(environment(0.1));
    fx.update(0.016, 7);
    expect(setMatrixAt).not.toHaveBeenCalled();
    fx.setEnvironment(environment(-5));
    fx.update(0.016, 8);
    expect(setMatrixAt).toHaveBeenCalled();
  });

  it('frees puffs when a tile is removed', () => {
    const { fx } = setup();
    fx.set(TILE, chimney(), state());
    fx.set(TILE + 1, chimney(), state());
    fx.setEnvironment(environment(0));
    fx.update(0.016, 1);
    expect(fx.puffs.count).toBe(2 * PUFFS_PER_EMITTER);
    fx.remove(TILE);
    fx.update(0.016, 2);
    expect(fx.puffs.count).toBe(PUFFS_PER_EMITTER);
    fx.remove(TILE + 1);
    fx.update(0.016, 3);
    expect(fx.puffs.count).toBe(0);
  });

  it('uploads only the live puff range, and ranges do not accumulate across frames', () => {
    const { fx } = setup();
    fx.set(TILE, chimney(), state());
    fx.setEnvironment(environment(0));
    fx.update(0.016, 1);
    const matrixAttr = fx.puffs.instanceMatrix;
    const colorAttr = fx.puffs.instanceColor!;
    expect(matrixAttr.updateRanges).toEqual([{ start: 0, count: fx.puffs.count * 16 }]);
    expect(colorAttr.updateRanges).toEqual([{ start: 0, count: fx.puffs.count * 3 }]);
    fx.update(0.016, 1.1);
    expect(matrixAttr.updateRanges).toHaveLength(1);
    expect(colorAttr.updateRanges).toHaveLength(1);
  });

  it('clamps puff writes at capacity instead of overflowing the buffer', () => {
    const { fx } = setup();
    // One anchor per tile, but more tiles than the buffer has room for
    // under MAX_PUFF_ANCHORS_PER_TILE anchors per tile.
    const overCapacity = SIZE * SIZE * MAX_PUFF_ANCHORS_PER_TILE + 1;
    for (let i = 0; i < overCapacity; i++) {
      fx.set(i, chimney(), state());
    }
    fx.setEnvironment(environment(0));
    fx.update(0.016, 1);
    expect(fx.puffs.count).toBeLessThanOrEqual(fx.puffs.instanceMatrix.count);
    expect(fx.puffs.count).toBe(fx.puffs.instanceMatrix.count);
  });
});

function antenna(): AccentAnchor[] {
  return [{ role: PartRole.Antenna, x: 3.5, y: 1.4, z: 3.5 }];
}

/** True when the instance at `slot` is drawn (non-zero scale). */
function lit(mesh: THREE.InstancedMesh, slot: number): boolean {
  const m = new THREE.Matrix4();
  const s = new THREE.Vector3();
  mesh.getMatrixAt(slot, m);
  s.setFromMatrixScale(m);
  return s.x > 0;
}

describe('BuildingFxMesh beacons', () => {
  it('draws one beacon per powered antenna, hidden by day and shown at night', () => {
    const { fx } = setup();
    fx.set(TILE, antenna(), state());
    fx.setEnvironment(environment(20, 0));
    fx.update(0.016, 1);
    expect(fx.beacons.count).toBe(1);
    expect(fx.beacons.visible).toBe(false);
    fx.setEnvironment(environment(20, 1));
    fx.update(0.016, 2);
    expect(fx.beacons.visible).toBe(true);
    expect((fx.beacons.material as THREE.MeshBasicMaterial).opacity).toBeCloseTo(1, 6);
    fx.setState(TILE, state({ supplied: SupplyStatus.NotConnected }));
    fx.update(0.016, 3);
    expect(fx.beacons.count).toBe(0);
  });

  it('uploads only the live beacon range, and ranges do not accumulate across frames', () => {
    const { fx } = setup();
    fx.set(TILE, antenna(), state());
    fx.setEnvironment(environment(20, 1));
    fx.update(0.016, 1);
    const matrixAttr = fx.beacons.instanceMatrix;
    expect(matrixAttr.updateRanges).toEqual([{ start: 0, count: fx.beacons.count * 16 }]);
    fx.update(0.016, 1.1);
    expect(matrixAttr.updateRanges).toHaveLength(1);
  });

  it('frees the beacon slot when its tile is removed', () => {
    const { fx } = setup();
    fx.set(TILE, antenna(), state());
    fx.setEnvironment(environment(20, 1));
    fx.update(0.016, 1);
    expect(fx.beacons.count).toBe(1);
    fx.remove(TILE);
    fx.update(0.016, 2);
    expect(fx.beacons.count).toBe(0);
  });

  it('sits just above the antenna tip', () => {
    const { fx } = setup();
    fx.setReducedMotion(true);
    fx.set(TILE, antenna(), state());
    fx.setEnvironment(environment(20, 1));
    fx.update(0.016, 1);
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    fx.beacons.getMatrixAt(0, m);
    p.setFromMatrixPosition(m);
    expect(p.x).toBeCloseTo(3.5, 9);
    expect(p.z).toBeCloseTo(3.5, 9);
    expect(p.y).toBeGreaterThan(1.4);
    expect(p.y).toBeLessThan(1.5);
  });

  it('blinks with motion on and stays lit with reduced motion', () => {
    const { fx } = setup();
    fx.set(TILE, antenna(), state());
    fx.setEnvironment(environment(20, 1));
    let litFrames = 0;
    let darkFrames = 0;
    for (let t = 0; t < 2; t += 0.05) {
      fx.update(0.05, t);
      if (lit(fx.beacons, 0)) litFrames++;
      else darkFrames++;
    }
    expect(litFrames).toBeGreaterThan(0);
    expect(darkFrames).toBeGreaterThan(litFrames); // short flash, long dark
    fx.setReducedMotion(true);
    for (let t = 0; t < 2; t += 0.05) {
      fx.update(0.05, t);
      expect(lit(fx.beacons, 0)).toBe(true);
    }
  });

  it('gives neighbouring towers different blink phases', () => {
    const { fx } = setup();
    fx.set(TILE, antenna(), state());
    fx.set(TILE + 1, antenna(), state());
    fx.setEnvironment(environment(20, 1));
    let differ = false;
    for (let t = 0; t < 2 && !differ; t += 0.05) {
      fx.update(0.05, t);
      differ = lit(fx.beacons, 0) !== lit(fx.beacons, 1);
    }
    expect(differ).toBe(true);
  });
});
