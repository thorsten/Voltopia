import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DIR_E, DIR_N, DIR_S, DIR_W, LINE_PRESENT } from '../shared/grid.ts';
import { RoadClass, Terrain, TileType, Zone, type TileDiff } from '../shared/types.ts';
import { ElevationField } from './elevationField.ts';
import { POLE_FOOT_RADIUS } from './infrastructure/pylonModels.ts';
import { RailMesh } from './railMesh.ts';
import {
  CABLE_SAG,
  CABLE_SEGMENTS,
  conductorPoints,
  PowerLinesMesh,
  pylonYaw,
} from './powerLinesMesh.ts';

const SIZE = 6;
const at = (x: number, y: number) => y * SIZE + x;

function baseTiles(): TileDiff[] {
  return Array.from({ length: SIZE * SIZE }, (_, index) => ({
    index,
    tileType: TileType.Empty,
    roadMask: 0,
    roadClass: 0,
    trafficLoad: 0,
    powerLine: 0,
    zone: 0,
    density: 0,
    variant: 0,
    supplied: 0,
    services: 0,
    heated: 0,
    island: 0,
    plantType: 0,
    terrain: Terrain.Land,
    elevation: 0,
    forest: 0,
    geothermal: 0,
    reservoirHeat: 0,
    damage: 0,
    stored: 0,
    ageStage: 0,
    deliveryState: 0,
    busStop: 0,
    stopState: 0,
    transitCover: 0,
    rail: 0,
    railCover: 0,
    stationState: 0,
  })) as TileDiff[];
}

function layerWith(tiles: TileDiff[]) {
  const scene = new THREE.Scene();
  const field = new ElevationField(SIZE);
  field.applyDiffs(tiles);
  const layer = new PowerLinesMesh(scene, SIZE, field);
  layer.applyDiffs(tiles);
  return { layer, field };
}

/** Start and end point of one conductor segment instance. */
function segmentEnds(mesh: THREE.InstancedMesh, slot: number) {
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(slot, matrix);
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(position, quaternion, scale);
  const half = new THREE.Vector3(scale.x / 2, 0, 0).applyQuaternion(quaternion);
  return { start: position.clone().sub(half), end: position.clone().add(half) };
}

/** Start of a conductor's first segment and end of its last. */
function conductorEnds(mesh: THREE.InstancedMesh, conductor: number) {
  const first = conductor * CABLE_SEGMENTS;
  return {
    start: segmentEnds(mesh, first).start,
    end: segmentEnds(mesh, first + CABLE_SEGMENTS - 1).end,
  };
}

/** Straight line along x on row 1, tiles x0..x1. */
function lineAlongX(tiles: TileDiff[], x0: number, x1: number): void {
  for (let x = x0; x <= x1; x++) {
    tiles[at(x, 1)].powerLine = LINE_PRESENT | (x > x0 ? DIR_W : 0) | (x < x1 ? DIR_E : 0);
  }
}

/** Foot position of one pylon instance. */
function footOf(mesh: THREE.InstancedMesh, slot: number): THREE.Vector3 {
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(slot, matrix);
  return new THREE.Vector3().setFromMatrixPosition(matrix);
}

/** A flat axis-aligned footprint (x/z) in world coordinates. */
interface Footprint {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

function poleFootprint(foot: THREE.Vector3): Footprint {
  const r = POLE_FOOT_RADIUS;
  return { minX: foot.x - r, maxX: foot.x + r, minZ: foot.z - r, maxZ: foot.z + r };
}

/** World x/z footprint of one instance of an instanced mesh. */
function instanceFootprint(mesh: THREE.InstancedMesh, slot: number): Footprint {
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(slot, matrix);
  mesh.geometry.computeBoundingBox();
  const box = mesh.geometry.boundingBox!.clone().applyMatrix4(matrix);
  return { minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z };
}

const overlaps = (a: Footprint, b: Footprint) =>
  a.minX < b.maxX && b.minX < a.maxX && a.minZ < b.maxZ && b.minZ < a.maxZ;

function crosses2d(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) {
  const side = (p: THREE.Vector3, q: THREE.Vector3, r: THREE.Vector3) =>
    Math.sign((q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x));
  return side(a, b, c) !== side(a, b, d) && side(c, d, a) !== side(c, d, b);
}

describe('pylon yaw', () => {
  it('turns the line direction onto local z', () => {
    expect(pylonYaw(LINE_PRESENT | DIR_E | DIR_W)).toBeCloseTo(Math.PI / 2);
    expect(pylonYaw(LINE_PRESENT | DIR_E)).toBeCloseTo(Math.PI / 2);
    expect(pylonYaw(LINE_PRESENT | DIR_N | DIR_S)).toBeCloseTo(0);
    expect(pylonYaw(LINE_PRESENT | DIR_S)).toBeCloseTo(0);
    expect(pylonYaw(LINE_PRESENT | DIR_N | DIR_E)).toBeCloseTo(Math.PI / 4);
    expect(pylonYaw(LINE_PRESENT | DIR_S | DIR_E)).toBeCloseTo((3 * Math.PI) / 4);
    expect(pylonYaw(LINE_PRESENT | DIR_N | DIR_E | DIR_S)).toBeCloseTo(Math.PI / 2);
    expect(pylonYaw(LINE_PRESENT)).toBeCloseTo(Math.PI / 2);
  });
});

describe('conductor points', () => {
  it('hang CABLE_SAG below the chord at mid-span', () => {
    const a = new THREE.Vector3(0, 1, 0);
    const b = new THREE.Vector3(1, 1.2, 0);
    const points = conductorPoints(a, b);
    expect(points).toHaveLength(CABLE_SEGMENTS + 1);
    expect(points[0].distanceTo(a)).toBeLessThan(1e-9);
    expect(points[CABLE_SEGMENTS].distanceTo(b)).toBeLessThan(1e-9);
    const mid = points[CABLE_SEGMENTS / 2];
    expect(mid.y).toBeCloseTo(1.1 - CABLE_SAG, 6);
  });
});

describe('PowerLinesMesh', () => {
  it('puts poles on road, zone and plant tiles and lattice pylons elsewhere', () => {
    const tiles = baseTiles();
    lineAlongX(tiles, 0, 3);
    tiles[at(1, 1)].tileType = TileType.Road;
    tiles[at(2, 1)].zone = Zone.Residential;
    tiles[at(3, 1)].tileType = TileType.Plant;
    const { layer } = layerWith(tiles);
    expect(layer.lattice.mesh.count).toBe(1);
    expect(layer.poles.mesh.count).toBe(3);
  });

  it('switches lattice to pole when a line tile is zoned', () => {
    const tiles = baseTiles();
    lineAlongX(tiles, 0, 1);
    const { layer } = layerWith(tiles);
    expect(layer.lattice.mesh.count).toBe(2);
    layer.applyDiffs([{ ...tiles[at(0, 1)], zone: Zone.Commercial }]);
    expect(layer.lattice.mesh.count).toBe(1);
    expect(layer.poles.mesh.count).toBe(1);
  });

  it('strings three continuous conductors of CABLE_SEGMENTS per span', () => {
    const tiles = baseTiles();
    lineAlongX(tiles, 0, 2);
    const mesh = layerWith(tiles).layer.conductors.mesh;
    expect(mesh.count).toBe(2 * 3 * CABLE_SEGMENTS);
    for (let conductor = 0; conductor < 6; conductor++) {
      for (let k = 0; k < CABLE_SEGMENTS - 1; k++) {
        const slot = conductor * CABLE_SEGMENTS + k;
        const gap = segmentEnds(mesh, slot).end.distanceTo(segmentEnds(mesh, slot + 1).start);
        expect(gap).toBeLessThan(1e-5);
      }
    }
  });

  it('follows the ground rise on a slope', () => {
    const tiles = baseTiles();
    lineAlongX(tiles, 0, 1);
    tiles[at(1, 1)].elevation = 2;
    const { layer, field } = layerWith(tiles);
    const rise = field.surfaceY(1.5, 1.5) - field.surfaceY(0.5, 1.5);
    expect(rise).toBeGreaterThan(0.05);
    for (let conductor = 0; conductor < 3; conductor++) {
      const { start, end } = conductorEnds(layer.conductors.mesh, conductor);
      expect(end.y - start.y).toBeCloseTo(rise, 5);
    }
  });

  it('keeps conductors apart around a corner', () => {
    const tiles = baseTiles();
    tiles[at(0, 1)].powerLine = LINE_PRESENT | DIR_E;
    tiles[at(1, 1)].powerLine = LINE_PRESENT | DIR_W | DIR_S;
    tiles[at(1, 2)].powerLine = LINE_PRESENT | DIR_N;
    const mesh = layerWith(tiles).layer.conductors.mesh;
    expect(mesh.count).toBe(2 * 3 * CABLE_SEGMENTS);
    for (const span of [0, 1]) {
      const ends = [0, 1, 2].map((i) => conductorEnds(mesh, span * 3 + i));
      for (let i = 0; i < 3; i++) {
        for (let j = i + 1; j < 3; j++) {
          expect(crosses2d(ends[i].start, ends[i].end, ends[j].start, ends[j].end)).toBe(false);
        }
      }
    }
  });

  it('casts pylon shadows but no conductor shadows', () => {
    const tiles = baseTiles();
    lineAlongX(tiles, 0, 1);
    const { layer } = layerWith(tiles);
    expect(layer.conductors.mesh.castShadow).toBe(false);
    expect(layer.lattice.mesh.castShadow).toBe(true);
    expect(layer.poles.mesh.castShadow).toBe(true);
    expect(layer.conductors.mesh.frustumCulled).toBe(false);
  });

  for (const roadClass of [RoadClass.Street, RoadClass.Avenue]) {
    for (const trackAlongX of [true, false]) {
      const label = `${roadClass === RoadClass.Avenue ? 'an avenue' : 'a street'} crossing a track along ${trackAlongX ? 'x' : 'z'}`;
      it(`keeps the pole on ${label} clear of the barriers`, () => {
        const tiles = baseTiles();
        const crossing = tiles[at(2, 2)];
        crossing.tileType = TileType.Road;
        crossing.roadClass = roadClass;
        crossing.roadMask = trackAlongX ? DIR_N | DIR_S : DIR_E | DIR_W;
        crossing.rail = LINE_PRESENT | (trackAlongX ? DIR_E | DIR_W : DIR_N | DIR_S);
        crossing.powerLine = LINE_PRESENT;
        const { layer, field } = layerWith(tiles);
        const scene = new THREE.Scene();
        const rail = new RailMesh(scene, SIZE, field);
        rail.applyDiffs(tiles);
        const instanced = scene.children.filter(
          (child): child is THREE.InstancedMesh => child instanceof THREE.InstancedMesh,
        );
        const [posts, bars] = [instanced[5], instanced[6]];
        expect(posts.count).toBe(2);
        expect(layer.poles.mesh.count).toBe(1);
        const pole = poleFootprint(footOf(layer.poles.mesh, 0));
        for (const slot of [0, 1]) {
          expect(overlaps(pole, instanceFootprint(posts, slot))).toBe(false);
          // The bar stands raised on its post until a train comes.
          expect(overlaps(pole, instanceFootprint(bars, slot))).toBe(false);
        }
      });
    }
  }
});
