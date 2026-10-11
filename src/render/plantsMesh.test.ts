import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { TileDiff } from '../shared/types.ts';
import { PlantType, Terrain, TileType } from '../shared/types.ts';
import { ElevationField } from './elevationField.ts';
import type { RenderEnvironment } from './renderer.ts';
import { PLINTH_RISE, PlantsMesh, plantYaw, type PlantSite } from './plantsMesh.ts';
import { plantModel, turnToward } from './plants/models.ts';
import { LINE_PRESENT } from '../shared/grid.ts';

const SIZE = 8;
const at = (x: number, z: number) => z * SIZE + x;
const env = (nightFactor: number, windFactor: number): RenderEnvironment =>
  ({ nightFactor, windFactor }) as RenderEnvironment;
const NO_SITE: PlantSite = { riverAlongZ: false, lakeDx: 0, lakeDz: 0, trackDx: 0, trackDz: 0 };

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

function plant(
  index: number,
  plantType: PlantType,
  terrain: Terrain = Terrain.Land,
  island = 0,
): TileDiff {
  return {
    index,
    tileType: TileType.Plant,
    plantType,
    terrain,
    density: 0,
    elevation: 0,
    rail: 0,
    island,
  } as TileDiff;
}

function park(index: number): TileDiff {
  return plant(index, PlantType.Park);
}

function bulldozed(index: number): TileDiff {
  return { ...plant(index, PlantType.None), tileType: TileType.Empty } as TileDiff;
}

function terrainTile(index: number, terrain: Terrain): TileDiff {
  return {
    index,
    tileType: TileType.Empty,
    plantType: PlantType.None,
    terrain,
    density: 0,
    elevation: 0,
    rail: 0,
    island: 0,
  } as TileDiff;
}

interface Instance {
  p: THREE.Vector3;
  q: THREE.Quaternion;
  s: THREE.Vector3;
}

const matrix = new THREE.Matrix4();

/** Position, rotation and scale of every drawn instance. */
function instancesOf(mesh: THREE.InstancedMesh | undefined): Instance[] {
  const out: Instance[] = [];
  if (!mesh) return out;
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, matrix);
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    matrix.decompose(p, q, s);
    out.push({ p, q, s });
  }
  return out;
}

/** Yaw about +y of an instance rotation. */
function yawOf(q: THREE.Quaternion): number {
  const v = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  return Math.atan2(v.x, v.z);
}

function expectSameYaw(actual: number, expected: number): void {
  // Compare directions, so π and −π agree.
  expect(Math.sin(actual)).toBeCloseTo(Math.sin(expected), 6);
  expect(Math.cos(actual)).toBeCloseTo(Math.cos(expected), 6);
}

describe('parks on sloped ground', () => {
  // A ramp rising one level per tile along +x: a flat slab at the tile
  // centre would float over the downhill corners (the "flying park").
  const ramp = field((x) => x);
  const TILE = at(3, 3);
  const props = plantModel(PlantType.Park).groundProps!;
  const trees = props.filter((p) => p.kind === 'tree');
  const benches = props.filter((p) => p.kind === 'bench');

  it('lays the grass pad as two prisms, each flush with its ground triangle', () => {
    const mesh = new PlantsMesh(new THREE.Scene(), SIZE, ramp);
    mesh.applyDiffs([park(TILE)]);
    expect(mesh.parkPads.frustumCulled).toBe(false);
    expect(mesh.parkPads.count).toBe(2);
    const pads = instancesOf(mesh.parkPads).map((i) => i.p);
    for (const p of pads) {
      // Each prism starts at its own corner and sits on the ground there.
      expect(p.y).toBeCloseTo(ramp.surfaceY(p.x, p.z), 6);
    }
    expect(Math.abs(pads[0].y - pads[1].y)).toBeGreaterThan(0.1);
  });

  it('stands every tree on the ground at its own spot, not at the tile centre', () => {
    const mesh = new PlantsMesh(new THREE.Scene(), SIZE, ramp);
    mesh.applyDiffs([park(TILE)]);
    const drawn = instancesOf(mesh.treeMesh.mesh);
    expect(drawn).toHaveLength(trees.length);
    const centre = ramp.centerY(TILE);
    let offCentre = 0;
    drawn.forEach(({ p, s, q }, i) => {
      expect(p.x).toBeCloseTo(3.5 + trees[i].x, 6);
      expect(p.z).toBeCloseTo(3.5 + trees[i].z, 6);
      expect(p.y).toBeCloseTo(ramp.surfaceY(p.x, p.z), 6);
      expect(s.y).toBeCloseTo(trees[i].scale, 6);
      expectSameYaw(yawOf(q), trees[i].turn);
      if (Math.abs(p.y - centre) > 1e-6) offCentre++;
    });
    expect(offCentre).toBeGreaterThan(0);
  });

  it('puts benches on the ground', () => {
    const mesh = new PlantsMesh(new THREE.Scene(), SIZE, ramp);
    mesh.applyDiffs([park(TILE)]);
    const drawn = instancesOf(mesh.benchMesh.mesh);
    expect(drawn).toHaveLength(benches.length);
    drawn.forEach(({ p, q }, i) => {
      expect(p.x).toBeCloseTo(3.5 + benches[i].x, 6);
      expect(p.z).toBeCloseTo(3.5 + benches[i].z, 6);
      expect(p.y).toBeCloseTo(ramp.surfaceY(p.x, p.z), 6);
      expectSameYaw(yawOf(q), benches[i].turn);
    });
  });

  it('draws no plinth and no model under a park', () => {
    const mesh = new PlantsMesh(new THREE.Scene(), SIZE, ramp);
    mesh.applyDiffs([park(TILE)]);
    expect(mesh.plinths.mesh.count).toBe(0);
    expect(mesh.meshOf(PlantType.Park)).toBeUndefined();
  });

  it('keeps a park on flat ground where it was', () => {
    const flat = field(() => 2);
    const mesh = new PlantsMesh(new THREE.Scene(), SIZE, flat);
    mesh.applyDiffs([park(TILE)]);
    const lift = flat.centerY(TILE);
    for (const { p } of instancesOf(mesh.parkPads)) expect(p.y).toBeCloseTo(lift, 6);
    for (const { p } of instancesOf(mesh.treeMesh.mesh)) expect(p.y).toBeCloseTo(lift, 6);
    for (const { p } of instancesOf(mesh.benchMesh.mesh)) expect(p.y).toBeCloseTo(lift, 6);
  });

  it('frees the pads, trees and benches when the park is bulldozed', () => {
    const mesh = new PlantsMesh(new THREE.Scene(), SIZE, ramp);
    mesh.applyDiffs([park(TILE)]);
    mesh.applyDiffs([bulldozed(TILE)]);
    expect(mesh.parkPads.count).toBe(0);
    expect(mesh.treeMesh.mesh.count).toBe(0);
    expect(mesh.benchMesh.mesh.count).toBe(0);
  });
});

describe('plant plinths on sloped ground', () => {
  // One plinth per non-park plant: top at lift + PLINTH_RISE, bottom at the lowest ground under its footprint.
  const ramp = field((x) => x);
  const TILE = at(3, 3);

  it('reaches down to the lowest ground under the footprint and keeps its top', () => {
    const mesh = new PlantsMesh(new THREE.Scene(), SIZE, ramp);
    mesh.applyDiffs([plant(TILE, PlantType.Battery)]);
    expect(mesh.plinths.mesh.count).toBe(1);
    const [plinth] = instancesOf(mesh.plinths.mesh);
    const { sx, sz } = plantModel(PlantType.Battery).plinth!;
    const lift = ramp.centerY(TILE);
    // The ramp falls toward −x: the downhill edge of the footprint is lowest.
    const lowest = Math.min(
      ramp.surfaceY(3.5 - sx / 2, 3.5 - sz / 2),
      ramp.surfaceY(3.5 - sx / 2, 3.5),
      ramp.surfaceY(3.5 - sx / 2, 3.5 + sz / 2),
    );
    expect(lowest).toBeLessThan(lift - 0.1);
    expect(plinth.p.y).toBeCloseTo(lowest, 6);
    expect(plinth.p.y + plinth.s.y).toBeCloseTo(lift + PLINTH_RISE, 6);
    expect(plinth.p.x).toBeCloseTo(3.5, 6);
    expect(plinth.p.z).toBeCloseTo(3.5, 6);
    expect(plinth.s.x).toBeCloseTo(sx, 6);
    expect(plinth.s.z).toBeCloseTo(sz, 6);
  });

  it('stands the model on the plinth top, never floating', () => {
    const mesh = new PlantsMesh(new THREE.Scene(), SIZE, ramp);
    mesh.applyDiffs([plant(TILE, PlantType.Battery)]);
    const [plinth] = instancesOf(mesh.plinths.mesh);
    const [model] = instancesOf(mesh.meshOf(PlantType.Battery));
    expect(model.p.y).toBeCloseTo(plinth.p.y + plinth.s.y, 6);
    expect(model.p.y).toBeCloseTo(ramp.centerY(TILE) + PLINTH_RISE, 6);
    expect(model.s.toArray().map((v) => +v.toFixed(6))).toEqual([1, 1, 1]);
  });

  it('colours the plinth from the model', () => {
    const mesh = new PlantsMesh(new THREE.Scene(), SIZE, ramp);
    mesh.applyDiffs([plant(TILE, PlantType.SolarFarm)]);
    const c = new THREE.Color();
    mesh.plinths.mesh.getColorAt(0, c);
    expect(c.getHex()).toBe(plantModel(PlantType.SolarFarm).plinth!.color);
  });

  it('changes nothing between two flat tiles except x/z', () => {
    const flat = field(() => 2);
    const mesh = new PlantsMesh(new THREE.Scene(), SIZE, flat);
    mesh.applyDiffs([plant(at(1, 1), PlantType.Battery), plant(at(5, 4), PlantType.Battery)]);
    const [a, b] = instancesOf(mesh.meshOf(PlantType.Battery));
    expect(a.p.y).toBeCloseTo(b.p.y, 6);
    expect(a.p.y).toBeCloseTo(flat.centerY(at(1, 1)) + PLINTH_RISE, 6);
    expect([a.p.x, a.p.z]).toEqual([1.5, 1.5]);
    expect([b.p.x, b.p.z]).toEqual([5.5, 4.5]);
    const [pa, pb] = instancesOf(mesh.plinths.mesh);
    // Flat ground: the plinth is just the PLINTH_RISE step from the ground.
    expect(pa.p.y).toBeCloseTo(flat.centerY(at(1, 1)), 6);
    expect(pa.s.y).toBeCloseTo(PLINTH_RISE, 6);
    expect(pb.p.y).toBeCloseTo(pa.p.y, 6);
    expect(pb.s.y).toBeCloseTo(pa.s.y, 6);
  });

  it('swaps the plinth footprint when the model is turned a quarter', () => {
    const flat = field(() => 0);
    const mesh = new PlantsMesh(new THREE.Scene(), SIZE, flat);
    // River east and west: the weir is turned to span z.
    mesh.applyDiffs([
      terrainTile(at(2, 3), Terrain.River),
      terrainTile(at(4, 3), Terrain.River),
      plant(at(3, 3), PlantType.RunOfRiver, Terrain.River),
    ]);
    const { sx, sz } = plantModel(PlantType.RunOfRiver).plinth!;
    expect(sx).not.toBeCloseTo(sz, 2);
    const [plinth] = instancesOf(mesh.plinths.mesh);
    expect(plinth.s.x).toBeCloseTo(sz, 6);
    expect(plinth.s.z).toBeCloseTo(sx, 6);
  });
});

describe('one mesh per plant type', () => {
  const flat = field(() => 0);

  it('draws each type in its own mesh with one instance per plant', () => {
    const mesh = new PlantsMesh(new THREE.Scene(), SIZE, flat);
    mesh.applyDiffs([
      plant(at(1, 1), PlantType.FireStation),
      plant(at(3, 1), PlantType.FireStation),
      plant(at(5, 5), PlantType.Battery),
    ]);
    const fire = mesh.meshOf(PlantType.FireStation)!;
    const battery = mesh.meshOf(PlantType.Battery)!;
    expect(fire.count).toBe(2);
    expect(battery.count).toBe(1);
    expect(fire.geometry).toBe(plantModel(PlantType.FireStation).geometry);
    expect(battery.geometry).toBe(plantModel(PlantType.Battery).geometry);
    expect(mesh.meshOf(PlantType.PoliceStation)).toBeUndefined();
    for (const m of [fire, battery]) {
      expect(m.frustumCulled).toBe(false);
      expect(m.castShadow).toBe(true);
      expect(m.receiveShadow).toBe(true);
      expect((m.material as THREE.MeshStandardMaterial).vertexColors).toBe(true);
    }
    expect(mesh.plinths.mesh.count).toBe(3);
  });

  it('grows past the starting capacity without losing plants', () => {
    const scene = new THREE.Scene();
    const mesh = new PlantsMesh(scene, SIZE, flat);
    const diffs: TileDiff[] = [];
    for (let i = 0; i < 20; i++) diffs.push(plant(i, PlantType.Substation));
    mesh.applyDiffs(diffs);
    const substations = mesh.meshOf(PlantType.Substation)!;
    expect(substations.count).toBe(20);
    expect(substations.instanceMatrix.count).toBeGreaterThanOrEqual(20);
    expect(mesh.plinths.mesh.count).toBe(20);
    // The grown meshes replaced the old ones in the scene.
    expect(scene.children).toContain(substations);
    expect(scene.children).toContain(mesh.plinths.mesh);
    const drawn = instancesOf(substations);
    for (let i = 0; i < 20; i++) {
      expect(
        drawn.some(({ p }) => p.x === (i % SIZE) + 0.5 && p.z === Math.floor(i / SIZE) + 0.5),
      ).toBe(true);
    }
    expect(mesh.placed).toHaveLength(20);
  });

  it('frees instances when a plant is bulldozed', () => {
    const mesh = new PlantsMesh(new THREE.Scene(), SIZE, flat);
    mesh.applyDiffs([
      plant(at(1, 1), PlantType.FireStation),
      plant(at(2, 2), PlantType.FireStation),
    ]);
    mesh.applyDiffs([bulldozed(at(1, 1))]);
    const fire = mesh.meshOf(PlantType.FireStation)!;
    expect(fire.count).toBe(1);
    expect(instancesOf(fire)[0].p.x).toBe(2.5);
    expect(mesh.plinths.mesh.count).toBe(1);
    mesh.applyDiffs([bulldozed(at(2, 2))]);
    expect(fire.count).toBe(0);
    expect(mesh.plinths.mesh.count).toBe(0);
    expect(mesh.placed).toHaveLength(0);
  });

  it('records every placed plant with its world pose', () => {
    const mesh = new PlantsMesh(new THREE.Scene(), SIZE, flat);
    mesh.applyDiffs([plant(at(4, 2), PlantType.PoliceStation)]);
    expect(mesh.placed).toEqual([
      { index: at(4, 2), type: PlantType.PoliceStation, x: 4.5, y: PLINTH_RISE, z: 2.5, yaw: 0 },
    ]);
  });
});

describe('model orientation', () => {
  const flat = field(() => 0);
  const track = (index: number): TileDiff =>
    ({
      index,
      tileType: TileType.Empty,
      plantType: PlantType.None,
      terrain: Terrain.Land,
      density: 0,
      elevation: 0,
      rail: LINE_PRESENT,
    }) as TileDiff;

  function yawOfOnly(mesh: PlantsMesh, type: PlantType): number {
    const drawn = instancesOf(mesh.meshOf(type));
    expect(drawn).toHaveLength(1);
    return yawOf(drawn[0].q);
  }

  it('turns a run-of-river plant across an east–west river', () => {
    expect(plantYaw(PlantType.RunOfRiver, { ...NO_SITE, riverAlongZ: true })).toBe(0);
    expect(plantYaw(PlantType.RunOfRiver, NO_SITE)).toBeCloseTo(Math.PI / 2, 9);
    const mesh = new PlantsMesh(new THREE.Scene(), SIZE, flat);
    mesh.applyDiffs([
      terrainTile(at(2, 3), Terrain.River),
      terrainTile(at(4, 3), Terrain.River),
      plant(at(3, 3), PlantType.RunOfRiver, Terrain.River),
    ]);
    expectSameYaw(yawOfOnly(mesh, PlantType.RunOfRiver), Math.PI / 2);
  });

  it('keeps a run-of-river plant as drawn across a north–south river', () => {
    const mesh = new PlantsMesh(new THREE.Scene(), SIZE, flat);
    mesh.applyDiffs([
      terrainTile(at(3, 2), Terrain.River),
      terrainTile(at(3, 4), Terrain.River),
      plant(at(3, 3), PlantType.RunOfRiver, Terrain.River),
    ]);
    expectSameYaw(yawOfOnly(mesh, PlantType.RunOfRiver), 0);
  });

  it('turns pumped storage toward its lake', () => {
    expect(plantYaw(PlantType.PumpedStorage, { ...NO_SITE, lakeDx: -1 })).toBeCloseTo(
      turnToward(-1, 0),
      9,
    );
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const mesh = new PlantsMesh(new THREE.Scene(), SIZE, flat);
      mesh.applyDiffs([
        terrainTile(at(3 + dx, 3 + dz), Terrain.Lake),
        plant(at(3, 3), PlantType.PumpedStorage),
      ]);
      expectSameYaw(yawOfOnly(mesh, PlantType.PumpedStorage), turnToward(dx, dz));
      // Model +z (the penstock side) now points at the lake.
      const front = new THREE.Vector3(0, 0, 1).applyAxisAngle(
        new THREE.Vector3(0, 1, 0),
        yawOfOnly(mesh, PlantType.PumpedStorage),
      );
      expect(front.x).toBeCloseTo(dx, 6);
      expect(front.z).toBeCloseTo(dz, 6);
    }
  });

  it('puts the station platform on the side of the track, whichever side that is', () => {
    for (const [dx, dz] of [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ] as const) {
      expectSameYaw(
        plantYaw(PlantType.TrainStation, { ...NO_SITE, trackDx: dx, trackDz: dz }),
        turnToward(dx, dz),
      );
      const mesh = new PlantsMesh(new THREE.Scene(), SIZE, flat);
      mesh.applyDiffs([plant(at(3, 3), PlantType.TrainStation), track(at(3 + dx, 3 + dz))]);
      expectSameYaw(yawOfOnly(mesh, PlantType.TrainStation), turnToward(dx, dz));
    }
  });

  it('turns the freight terminal and rail yard toward their track too', () => {
    for (const type of [PlantType.FreightTerminal, PlantType.RailYard]) {
      expectSameYaw(plantYaw(type, { ...NO_SITE, trackDx: 1 }), Math.PI / 2);
      const mesh = new PlantsMesh(new THREE.Scene(), SIZE, flat);
      mesh.applyDiffs([plant(at(3, 3), type), track(at(4, 3))]);
      expectSameYaw(yawOfOnly(mesh, type), Math.PI / 2);
    }
  });

  it('turns an existing station when track is laid beside it later', () => {
    const mesh = new PlantsMesh(new THREE.Scene(), SIZE, flat);
    mesh.applyDiffs([plant(at(3, 3), PlantType.TrainStation)]);
    expectSameYaw(yawOfOnly(mesh, PlantType.TrainStation), 0); // default: track side +z
    mesh.applyDiffs([track(at(2, 3))]);
    expectSameYaw(yawOfOnly(mesh, PlantType.TrainStation), -Math.PI / 2); // now facing west
    expect(mesh.placed[0].yaw).toBeCloseTo(-Math.PI / 2, 9);
  });

  it('keeps every other type as drawn', () => {
    const site = { riverAlongZ: false, lakeDx: 1, lakeDz: 0, trackDx: 1, trackDz: 0 };
    for (const type of [PlantType.FireStation, PlantType.BusDepot, PlantType.WindTurbine]) {
      expect(plantYaw(type, site)).toBe(0);
    }
  });
});

describe('wind turbine rotors', () => {
  const flat = field(() => 1);

  it('spins each rotor at the model hub on top of the plinth', () => {
    const mesh = new PlantsMesh(new THREE.Scene(), SIZE, flat);
    mesh.applyDiffs([plant(at(2, 5), PlantType.WindTurbine)]);
    const rotors = mesh.rotorMesh;
    expect(rotors.count).toBe(1);
    const hub = plantModel(PlantType.WindTurbine).rotorHub!;
    const [rotor] = instancesOf(rotors);
    expect(rotor.p.x).toBeCloseTo(2.5 + hub.x, 6);
    expect(rotor.p.y).toBeCloseTo(flat.centerY(at(2, 5)) + PLINTH_RISE + hub.y, 6);
    expect(rotor.p.z).toBeCloseTo(5.5 + hub.z, 6);
  });

  it('uploads only the drawn rotors when they turn', () => {
    const mesh = new PlantsMesh(new THREE.Scene(), SIZE, flat);
    mesh.applyDiffs([
      plant(at(2, 5), PlantType.WindTurbine),
      plant(at(4, 5), PlantType.WindTurbine),
    ]);
    mesh.setEnvironment(env(0, 1));
    const version = mesh.rotorMesh.instanceMatrix.version;
    mesh.update(0.1);
    const attr = mesh.rotorMesh.instanceMatrix;
    expect(attr.version).toBeGreaterThan(version);
    expect(attr.updateRanges).toEqual([{ start: 0, count: 2 * 16 }]);
  });
});

describe('battery state-of-charge fills', () => {
  const flat = field(() => 0);
  const A = at(2, 2);
  const B = at(5, 4);
  const fill = plantModel(PlantType.Battery).socFill!;

  /** Height of each drawn fill bar, in the batteries' instance order. */
  function fillHeights(mesh: PlantsMesh): number[] {
    return instancesOf(mesh.socFillMesh).map((i) => i.s.y);
  }

  function battery(index: number, stored: number): TileDiff {
    return { ...plant(index, PlantType.Battery), stored } as TileDiff;
  }

  it('gives each battery its own fill from the tile diff', () => {
    const mesh = new PlantsMesh(new THREE.Scene(), SIZE, flat);
    mesh.applyDiffs([battery(A, 1), battery(B, 0)]);
    expect(mesh.socFillMesh.count).toBe(2);
    const [full, empty] = fillHeights(mesh);
    expect(empty).toBeCloseTo(0.04, 6);
    expect(full).toBeCloseTo(0.04 + fill.maxH, 6);
  });

  it('sits the bar at the model anchor on the cabinet front', () => {
    const mesh = new PlantsMesh(new THREE.Scene(), SIZE, flat);
    mesh.applyDiffs([battery(A, 0.5)]);
    const [bar] = instancesOf(mesh.socFillMesh);
    expect(bar.p.x).toBeCloseTo(2.5 + fill.x, 6);
    expect(bar.p.y).toBeCloseTo(PLINTH_RISE + fill.y, 6);
    // Proud of the face: the bar's back lies on the anchor.
    expect(bar.p.z).toBeCloseTo(2.5 + fill.z + fill.d / 2, 6);
    expect(bar.s.x).toBeCloseTo(fill.w, 6);
    expect(bar.s.z).toBeCloseTo(fill.d, 6);
  });

  it('follows a later diff for one tile without touching the other', () => {
    const mesh = new PlantsMesh(new THREE.Scene(), SIZE, flat);
    mesh.applyDiffs([battery(A, 1), battery(B, 0)]);
    const before = fillHeights(mesh);
    mesh.applyDiffs([battery(B, 0.5)]);
    const after = fillHeights(mesh);
    expect(after[0]).toBeCloseTo(before[0], 6);
    expect(after[1]).toBeCloseTo(0.04 + fill.maxH * 0.5, 6);
  });

  it('moves the fill on a stored-only diff without rebuilding the model', () => {
    const mesh = new PlantsMesh(new THREE.Scene(), SIZE, flat);
    mesh.applyDiffs([battery(A, 0)]);
    const model = mesh.meshOf(PlantType.Battery)!;
    const version = model.instanceMatrix.version;
    mesh.applyDiffs([battery(A, 1)]);
    expect(model.instanceMatrix.version).toBe(version);
    expect(fillHeights(mesh)[0]).toBeCloseTo(0.04 + fill.maxH, 6);
    expect(mesh.socFillMesh.instanceMatrix.updateRanges).toEqual([{ start: 0, count: 16 }]);
  });

  it('drops the fill when the battery is bulldozed', () => {
    const mesh = new PlantsMesh(new THREE.Scene(), SIZE, flat);
    mesh.applyDiffs([battery(A, 1)]);
    expect(mesh.socFillMesh.count).toBe(1);
    mesh.applyDiffs([bulldozed(A)]);
    expect(mesh.socFillMesh.count).toBe(0);
  });
});

describe('night lights', () => {
  const flat = field(() => 0);
  const lit = (Object.values(PlantType) as PlantType[]).find(
    (t) =>
      t !== PlantType.None && plantModel(t).windows.length > 0 && plantModel(t).lamps.length > 0,
  )!;
  const windows = plantModel(lit).windows.length;
  const lamps = plantModel(lit).lamps;

  it('frames the windows of an unpowered plant but lights nothing', () => {
    const mesh = new PlantsMesh(new THREE.Scene(), SIZE, flat);
    mesh.applyDiffs([plant(at(1, 1), lit, Terrain.Land, 0)]);
    expect(mesh.lights.frames.mesh.count).toBe(windows);
    expect(mesh.lights.glow.mesh.count).toBe(0);
    expect(mesh.lights.aviation.mesh.count + mesh.lights.yard.mesh.count).toBe(0);
  });

  it('switches glow and lamps with the island, without rebuilding the models', () => {
    const mesh = new PlantsMesh(new THREE.Scene(), SIZE, flat);
    mesh.applyDiffs([plant(at(1, 1), lit, Terrain.Land, 1)]);
    expect(mesh.lights.glow.mesh.count).toBe(windows);
    expect(mesh.lights.aviation.mesh.count + mesh.lights.yard.mesh.count).toBe(lamps.length);
    const model = mesh.meshOf(lit)!;
    const version = model.instanceMatrix.version;
    const plinths = mesh.plinths.mesh.instanceMatrix.version;

    mesh.applyDiffs([plant(at(1, 1), lit, Terrain.Land, 0)]);
    expect(mesh.lights.glow.mesh.count).toBe(0);
    expect(mesh.lights.aviation.mesh.count + mesh.lights.yard.mesh.count).toBe(0);
    expect(mesh.lights.frames.mesh.count).toBe(windows);
    expect(model.instanceMatrix.version).toBe(version);
    expect(mesh.plinths.mesh.instanceMatrix.version).toBe(plinths);

    // Another island number is still powered: nothing changes.
    mesh.applyDiffs([plant(at(1, 1), lit, Terrain.Land, 2)]);
    const glow = mesh.lights.glow.mesh.instanceMatrix.version;
    mesh.applyDiffs([plant(at(1, 1), lit, Terrain.Land, 3)]);
    expect(mesh.lights.glow.mesh.instanceMatrix.version).toBe(glow);
  });

  it('forwards the night and the blink clock', () => {
    const mesh = new PlantsMesh(new THREE.Scene(), SIZE, flat);
    mesh.applyDiffs([plant(at(1, 1), lit, Terrain.Land, 1)]);
    mesh.setEnvironment(env(0, 0));
    expect(mesh.lights.glow.mesh.visible).toBe(false);
    mesh.setEnvironment(env(1, 0));
    expect(mesh.lights.glow.mesh.visible).toBe(true);
    mesh.update(0.5);
    const aviation = mesh.lights.aviation.mesh.material as THREE.MeshBasicMaterial;
    expect(aviation.opacity).toBe(1);
    mesh.update(1.0);
    expect(aviation.opacity).toBe(0);
  });
});

describe('substation yard', () => {
  const flat = field(() => 0);

  it('draws one substation instance on one plinth', () => {
    const mesh = new PlantsMesh(new THREE.Scene(), SIZE, flat);
    mesh.applyDiffs([plant(0, PlantType.Substation)]);
    expect(mesh.meshOf(PlantType.Substation)!.count).toBe(1);
    expect(mesh.plinths.mesh.count).toBe(1);
  });
});
