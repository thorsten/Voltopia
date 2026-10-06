import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { TileDiff, VehicleState } from '../shared/types.ts';
import { Terrain, VehicleKind, WAGON_ID_OFFSET } from '../shared/types.ts';
import { ElevationField, LEVEL_HEIGHT } from './elevationField.ts';
import { LANE_OFFSET, VehiclesMesh } from './vehiclesMesh.ts';

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

function car(x: number, y: number, angle = 0): VehicleState {
  return { id: 1, x, y, angle, kind: VehicleKind.Car };
}

/** The car mesh's world matrix after one sim update at that position. */
function carMatrix(
  f: ElevationField,
  vehicle: VehicleState,
  terrainAt: (index: number) => Terrain = () => Terrain.Land,
): THREE.Matrix4 {
  const scene = new THREE.Scene();
  const mesh = new VehiclesMesh(scene, f, terrainAt);
  mesh.setVehicles([vehicle], 1);
  mesh.update(10); // far past the interpolation window → at the target
  const cars = scene.children.find(
    (c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh && c.count === 1,
  );
  expect(cars).toBeDefined();
  const matrix = new THREE.Matrix4();
  cars!.getMatrixAt(0, matrix);
  return matrix;
}

const position = new THREE.Vector3();
const quaternion = new THREE.Quaternion();
const scale = new THREE.Vector3();

describe('right-hand traffic', () => {
  it('keeps to the right of the street centre line heading +x', () => {
    const m = carMatrix(
      field(() => 0),
      car(3.5, 3.5, 0),
    );
    m.decompose(position, quaternion, scale);
    // World +z is the right-hand side of a car heading +x.
    expect(position.x).toBeCloseTo(3.5, 6);
    expect(position.z).toBeCloseTo(3.5 + LANE_OFFSET, 6);
  });

  it('uses the opposite lane heading -x, so oncoming cars do not meet', () => {
    const m = carMatrix(
      field(() => 0),
      car(3.5, 3.5, Math.PI),
    );
    m.decompose(position, quaternion, scale);
    expect(position.x).toBeCloseTo(3.5, 6);
    expect(position.z).toBeCloseTo(3.5 - LANE_OFFSET, 6);
  });

  it('keeps right on a north-south street too', () => {
    // Heading +z (angle π/2): the right-hand side is world -x.
    const m = carMatrix(
      field(() => 0),
      car(3.5, 3.5, Math.PI / 2),
    );
    m.decompose(position, quaternion, scale);
    expect(position.x).toBeCloseTo(3.5 - LANE_OFFSET, 6);
    expect(position.z).toBeCloseTo(3.5, 6);
  });

  it('stays inside the carriageway', () => {
    // Road pads are 0.62 tiles wide (roadsMesh CENTER_SIZE); the widest
    // vehicle body is 0.16, so its outer edge must stay within 0.31.
    expect(LANE_OFFSET + 0.08).toBeLessThan(0.31);
  });
});

describe('vehicles on terrain', () => {
  it('sits level on flat ground at the ground height', () => {
    const f = field(() => 2);
    const m = carMatrix(f, car(3.5, 3.5));
    m.decompose(position, quaternion, scale);
    expect(position.y).toBeCloseTo(0.03 + 2 * LEVEL_HEIGHT, 6);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion);
    expect(up.y).toBeCloseTo(1, 6);
  });

  it('pitches nose-up to match an uphill road', () => {
    // A uniform ramp rising along +x; the car heads along +x (angle 0).
    const f = field((x) => x);
    const m = carMatrix(f, car(3.5, 3.5));
    m.decompose(position, quaternion, scale);
    // Forward axis follows the slope: dy/dx equals the ramp's gradient.
    const forward = new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion);
    expect(forward.y / forward.x).toBeCloseTo(LEVEL_HEIGHT, 3);
    // And the car still touches the ground instead of floating.
    expect(position.y).toBeCloseTo(0.03 + f.surfaceY(3.5, 3.5), 6);
  });

  it('pitches nose-down heading downhill on the same ramp', () => {
    const f = field((x) => x);
    const m = carMatrix(f, car(3.5, 3.5, Math.PI));
    m.decompose(position, quaternion, scale);
    const forward = new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion);
    // Heading -x on an +x ramp: the nose points down along world -x. The
    // forward line still follows the road's gradient dh/dx = LEVEL_HEIGHT.
    expect(forward.x).toBeLessThan(0);
    expect(forward.y).toBeLessThan(0);
    expect(forward.y / forward.x).toBeCloseTo(LEVEL_HEIGHT, 3);
  });

  it('drives across a bridge at deck height instead of diving into the channel', () => {
    // A carved channel two tiles wide, two levels below its banks (a
    // one-tile channel would be corner-averaged flat and prove nothing).
    const f = field((x) => (x === 4 || x === 5 ? 0 : 2));
    const river = (index: number) => {
      const x = index % SIZE;
      return x === 4 || x === 5 ? Terrain.River : Terrain.Land;
    };
    const m = carMatrix(f, car(4.5, 3.5), river);
    m.decompose(position, quaternion, scale);
    const index = 3 * SIZE + 4;
    expect(position.y).toBeCloseTo(0.03 + f.maxCornerY(index), 6);
    expect(position.y).toBeGreaterThan(0.03 + f.surfaceY(4.5, 3.5));
    // Bridge decks are flat: no pitch.
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion);
    expect(up.y).toBeCloseTo(1, 3);
  });
});

describe('trains', () => {
  it('draws locomotives and wagons on their own meshes, headlights on locomotives only, no lane offset', () => {
    const scene = new THREE.Scene();
    const mesh = new VehiclesMesh(
      scene,
      field(() => 0),
      () => Terrain.Land,
    );
    mesh.setVehicles(
      [
        { id: 1, x: 2.5, y: 2.5, angle: 0, kind: VehicleKind.Locomotive },
        { id: 1 + WAGON_ID_OFFSET, x: 1.5, y: 2.5, angle: 0, kind: VehicleKind.Wagon },
        { id: 2, x: 4.5, y: 2.5, angle: 0, kind: VehicleKind.FreightLocomotive },
      ],
      1,
    );
    mesh.update(10);
    const used = scene.children.filter(
      (c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh && c.count > 0,
    );
    // passenger locomotive, passenger wagon, freight locomotive: one each; headlights: two.
    expect(used.map((m) => m.count).sort()).toEqual([1, 1, 1, 2]);
    for (const m of used.filter((m) => m.count === 1)) {
      const matrix = new THREE.Matrix4();
      m.getMatrixAt(0, matrix);
      const position = new THREE.Vector3().setFromMatrixPosition(matrix);
      expect(position.z).toBeCloseTo(2.5, 5); // trains sit on the centre line, cars at ±LANE_OFFSET
      expect(Math.abs(position.z - 2.5)).toBeLessThan(LANE_OFFSET / 2);
    }
  });
});
