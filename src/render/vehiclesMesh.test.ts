import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { TileDiff, VehicleState } from '../shared/types.ts';
import { Terrain, VehicleKind, WAGON_ID_OFFSET } from '../shared/types.ts';
import { ElevationField, LEVEL_HEIGHT } from './elevationField.ts';
import { BALANCE } from '../shared/constants.ts';
import { LANE_OFFSET, LOCOMOTIVE_LENGTH, VehiclesMesh, WAGON_LENGTH } from './vehiclesMesh.ts';
import { CAR_STYLES, carColorOf, carStyleOf } from './vehicles/variety.ts';

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
  const cars = mesh.modelMeshes().get(carStyleOf(vehicle.id))!;
  expect(cars.count).toBe(1);
  const matrix = new THREE.Matrix4();
  cars.getMatrixAt(0, matrix);
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
    // Passenger and freight locomotives share one mesh (coloured per instance).
    const locomotives = mesh.modelMeshes().get('locomotive')!;
    const wagons = mesh.modelMeshes().get('passengerWagon')!;
    expect(locomotives.count).toBe(2);
    expect(wagons.count).toBe(1);
    const headlights = scene.children.find(
      (c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh && c.name === 'headlights',
    )!;
    expect(headlights.count).toBe(2); // one per locomotive; the wagon carries none
    for (const [m, count] of [
      [locomotives, 2],
      [wagons, 1],
    ] as const) {
      for (let i = 0; i < count; i++) {
        const matrix = new THREE.Matrix4();
        m.getMatrixAt(i, matrix);
        const position = new THREE.Vector3().setFromMatrixPosition(matrix);
        expect(position.z).toBeCloseTo(2.5, 5); // trains sit on the centre line, cars at ±LANE_OFFSET
        expect(Math.abs(position.z - 2.5)).toBeLessThan(LANE_OFFSET / 2);
      }
    }
  });
});

describe('train coupling', () => {
  it('trails the wagon a coupler behind the locomotive, not a tile', () => {
    // The sim spaces the two centre to centre; anything much beyond the
    // two half-bodies reads as a gap between the carriages.
    const bodies = (LOCOMOTIVE_LENGTH + WAGON_LENGTH) / 2;
    expect(BALANCE.rail.wagonGap).toBeGreaterThanOrEqual(bodies);
    expect(BALANCE.rail.wagonGap - bodies).toBeLessThanOrEqual(0.08);
  });
});

describe('vehicle models and colours', () => {
  function meshFor(): { scene: THREE.Scene; mesh: VehiclesMesh } {
    const scene = new THREE.Scene();
    return {
      scene,
      mesh: new VehiclesMesh(
        scene,
        field(() => 0),
        () => Terrain.Land,
      ),
    };
  }
  const car = (id: number, x = 2.5): VehicleState => ({
    id,
    x,
    y: 2.5,
    angle: 0,
    kind: VehicleKind.Car,
  });

  it('draws each car in the mesh its id selects', () => {
    const { mesh } = meshFor();
    const cars = [1, 2, 3, 4, 5, 6, 7, 8].map((id) => car(id, 1 + id * 0.5));
    mesh.setVehicles(cars, 1);
    mesh.update(10);
    const counts = new Map<string, number>();
    for (const c of cars) counts.set(carStyleOf(c.id), (counts.get(carStyleOf(c.id)) ?? 0) + 1);
    for (const style of CAR_STYLES) {
      expect(mesh.modelMeshes().get(style)!.count).toBe(counts.get(style) ?? 0);
    }
  });

  it('keeps a car its colour when other cars appear or disappear', () => {
    const { mesh } = meshFor();
    const colorOf = (id: number): number => {
      const m = mesh.modelMeshes().get(carStyleOf(id))!;
      const c = new THREE.Color();
      for (let i = 0; i < m.count; i++) {
        m.getColorAt(i, c);
        if (c.getHex() === carColorOf(id)) return c.getHex();
      }
      return -1;
    };
    mesh.setVehicles([car(7)], 1);
    mesh.update(10);
    expect(colorOf(7)).toBe(carColorOf(7));
    mesh.setVehicles([car(3, 1.5), car(5, 4.5), car(7)], 2);
    mesh.update(11);
    expect(colorOf(7)).toBe(carColorOf(7));
  });

  it('puts tail lights on road vehicles and on the last wagon only, fading with night', () => {
    const { scene, mesh } = meshFor();
    const train = 9;
    const vehicles: VehicleState[] = [
      car(1),
      { id: 2, x: 4.5, y: 2.5, angle: 0, kind: VehicleKind.Bus },
      { id: train, x: 6.5, y: 5.5, angle: 0, kind: VehicleKind.Locomotive },
      ...[1, 2, 3].map((k) => ({
        id: train + k * WAGON_ID_OFFSET,
        x: 6.5 - 0.55 * k,
        y: 5.5,
        angle: 0,
        kind: VehicleKind.Wagon,
      })),
    ];
    mesh.setVehicles(vehicles, 1);
    mesh.update(10);
    const tail = scene.children.find(
      (c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh && c.name === 'tailLights',
    )!;
    expect(tail.count).toBe(3); // car, bus, last wagon
    const material = tail.material as THREE.MeshBasicMaterial;
    mesh.setEnvironment({ nightFactor: 0 } as never);
    expect(material.opacity).toBe(0);
    mesh.setEnvironment({ nightFactor: 1 } as never);
    expect(material.opacity).toBeCloseTo(1, 6);
  });
});
