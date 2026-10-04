import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { TileDiff } from '../shared/types.ts';
import { PlantType, Terrain, TileType } from '../shared/types.ts';
import { ElevationField } from './elevationField.ts';
import { PlantsMesh } from './plantsMesh.ts';

const SIZE = 8;

function field(levelOf: (x: number, z: number) => number): ElevationField {
  const f = new ElevationField(SIZE);
  const diffs: TileDiff[] = [];
  for (let z = 0; z < SIZE; z++) {
    for (let x = 0; x < SIZE; x++) {
      diffs.push({ index: z * SIZE + x, elevation: levelOf(x, z) } as TileDiff);
    }
  }
  f.applyDiffs(diffs);
  return f;
}

function plant(index: number, plantType: PlantType): TileDiff {
  return {
    index,
    tileType: TileType.Plant,
    plantType,
    terrain: Terrain.Land,
    density: 0,
    elevation: 0,
  } as TileDiff;
}

function park(index: number): TileDiff {
  return plant(index, PlantType.Park);
}

const scale = new THREE.Vector3();
const quaternion = new THREE.Quaternion();

/** Position (base) and scale of every drawn instance. */
function instancesOf(mesh: THREE.InstancedMesh): Array<{ p: THREE.Vector3; s: THREE.Vector3 }> {
  const out: Array<{ p: THREE.Vector3; s: THREE.Vector3 }> = [];
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, matrix);
    matrix.decompose(position, quaternion, scale);
    out.push({ p: position.clone(), s: scale.clone() });
  }
  return out;
}

const position = new THREE.Vector3();
const matrix = new THREE.Matrix4();

function positionsOf(mesh: THREE.InstancedMesh): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, matrix);
    out.push(position.setFromMatrixPosition(matrix).clone());
  }
  return out;
}

describe('parks on sloped ground', () => {
  // A ramp rising one level per tile along +x: a flat slab at the tile
  // centre would float over the downhill corners (the "flying park").
  const ramp = field((x) => x);
  const TILE = 3 * SIZE + 3;

  it('lays the grass pad as two prisms, each flush with its ground triangle', () => {
    const mesh = new PlantsMesh(new THREE.Scene(), SIZE, ramp);
    mesh.applyDiffs([park(TILE)]);
    expect(mesh.parkPads.frustumCulled).toBe(false);
    expect(mesh.parkPads.count).toBe(2);
    const pads = positionsOf(mesh.parkPads);
    for (const p of pads) {
      // Each prism starts at its own corner and sits on the ground there.
      expect(p.y).toBeCloseTo(ramp.surfaceY(p.x, p.z), 6);
    }
    expect(Math.abs(pads[0].y - pads[1].y)).toBeGreaterThan(0.1);
  });

  it('stands every tree on the ground at its own spot, not at the tile centre', () => {
    const mesh = new PlantsMesh(new THREE.Scene(), SIZE, ramp);
    mesh.applyDiffs([park(TILE)]);
    const parts = positionsOf(mesh.boxMesh);
    expect(parts.length).toBe(6); // three trunks + three foliage cubes, no flat slab
    const centre = ramp.centerY(TILE);
    let offCentre = 0;
    for (const p of parts) {
      const ground = ramp.surfaceY(p.x, p.z);
      // Trunks sit 0.03 above the ground (the old pad thickness), foliage on top of them.
      expect(p.y).toBeGreaterThanOrEqual(ground + 0.03 - 1e-6);
      expect(p.y).toBeLessThan(ground + 0.3);
      if (Math.abs(ground - centre) > 1e-6) offCentre++;
    }
    expect(offCentre).toBeGreaterThan(0);
  });

  it('keeps a park on flat ground where it was', () => {
    const flat = field(() => 2);
    const mesh = new PlantsMesh(new THREE.Scene(), SIZE, flat);
    mesh.applyDiffs([park(TILE)]);
    for (const p of positionsOf(mesh.parkPads)) expect(p.y).toBeCloseTo(flat.centerY(TILE), 6);
    for (const p of positionsOf(mesh.boxMesh)) {
      expect(p.y).toBeGreaterThanOrEqual(flat.centerY(TILE) + 0.03 - 1e-6);
    }
  });

  it('frees the pads when the park is bulldozed', () => {
    const mesh = new PlantsMesh(new THREE.Scene(), SIZE, ramp);
    mesh.applyDiffs([park(TILE)]);
    mesh.applyDiffs([
      { ...park(TILE), tileType: TileType.Empty, plantType: PlantType.None } as TileDiff,
    ]);
    expect(mesh.parkPads.count).toBe(0);
    expect(mesh.boxMesh.count).toBe(0);
  });
});

describe('plant foundations on sloped ground', () => {
  const ramp = field((x) => x);
  const TILE = 3 * SIZE + 3;

  it('drops a ground-standing part to the lowest ground under its footprint and keeps its top', () => {
    const mesh = new PlantsMesh(new THREE.Scene(), SIZE, ramp);
    mesh.applyDiffs([plant(TILE, PlantType.Battery)]);
    const [cabinet, frame] = instancesOf(mesh.boxMesh);
    const lift = ramp.centerY(TILE);
    // The cabinet (0.55 x 0.5 x 0.4 at base 0): its downhill corner is at x = 3.5 - 0.275.
    const downhill = ramp.surfaceY(3.5 - 0.275, 3.5 - 0.2);
    expect(downhill).toBeLessThan(lift);
    expect(cabinet.p.y).toBeCloseTo(downhill, 6);
    expect(cabinet.p.y + cabinet.s.y).toBeCloseTo(lift + 0.5, 6);
    // The frame sits on top of the cabinet (base 0.5): untouched.
    expect(frame.p.y).toBeCloseTo(lift + 0.5, 6);
    expect(frame.s.y).toBeCloseTo(0.06, 6);
  });

  it('leaves tilted panels alone and extends only their pedestals', () => {
    const mesh = new PlantsMesh(new THREE.Scene(), SIZE, ramp);
    mesh.applyDiffs([plant(TILE, PlantType.SolarFarm)]);
    const parts = instancesOf(mesh.boxMesh);
    const lift = ramp.centerY(TILE);
    const panels = parts.filter((i) => Math.abs(i.s.y - 0.02) < 1e-6);
    const pedestals = parts.filter((i) => i.s.y > 0.1 - 1e-6 && i.s.y < 0.5);
    expect(panels).toHaveLength(3);
    expect(pedestals).toHaveLength(3);
    for (const panel of panels) expect(panel.p.y).toBeCloseTo(lift + 0.14, 6);
    for (const pedestal of pedestals) {
      // A 0.8-wide pedestal on a one-level-per-tile ramp reaches 0.4 levels
      // downhill; a strict "< lift" alone would pass on float noise.
      expect(pedestal.p.y).toBeLessThan(lift - 0.05);
      expect(pedestal.p.y + pedestal.s.y).toBeCloseTo(lift + 0.1, 6);
    }
  });

  it('changes nothing on flat ground', () => {
    const flat = field(() => 2);
    const mesh = new PlantsMesh(new THREE.Scene(), SIZE, flat);
    mesh.applyDiffs([plant(TILE, PlantType.FireStation)]);
    const lift = flat.centerY(TILE);
    for (const { p, s } of instancesOf(mesh.boxMesh)) {
      expect(p.y).toBeGreaterThanOrEqual(lift - 1e-6);
      if (Math.abs(p.y - lift) < 1e-6) expect(s.y).toBeLessThanOrEqual(0.62 + 1e-6);
    }
  });
});
