import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { TileDiff } from '../shared/types.ts';
import { PlantType, Terrain, TileType } from '../shared/types.ts';
import type { DiffLayer, RenderEnvironment } from './renderer.ts';
import type { ElevationField } from './elevationField.ts';
import { composePrismOnGround, createHalfTilePrism } from './decal.ts';
import { surfaceMaterial } from './materials.ts';
import { GrowingMesh } from './plants/growingMesh.ts';
import { PlantLights } from './plants/lights.ts';
import type { PlantModel } from './plants/models.ts';
import {
  ROTOR_RADIUS,
  benchGeometry,
  plantModel,
  treeGeometry,
  turnToward,
} from './plants/models.ts';

/** Plinth top and model base above the tile-centre lift. */
export const PLINTH_RISE = 0.015;

const ROTOR_MAX_SPEED_RAD_PER_S = 6;
/** Wind output below which the rotors stand still (cut-in). */
const ROTOR_CUT_IN = 0.05;
/** Phase offset between neighbouring rotors, so they do not spin in lockstep. */
const ROTOR_PHASE_STEP = 0.7;
const ROTOR_BLADE = { thickness: 0.015, chord: 0.05 };
const ROTOR_COLOR = 0xe8eaec;
/** Park lawn: a near-full-tile decal, thin like a road pad. */
const PARK_PAD_SIZE = 0.94;
const PARK_PAD_HEIGHT = 0.03;
const PARK_GRASS_COLOR = 0x7cb35e;
/** Empty-battery fill bar height, so an empty battery still shows a sliver. */
const SOC_FILL_MIN_HEIGHT = 0.04;
const SOC_FILL_COLOR = 0x7be07f;

/** Where a plant stands: which neighbours are water or track (for turning the model). */
export interface PlantSite {
  /** River continues north/south of the tile (else east/west). */
  riverAlongZ: boolean;
  /** Direction to the nearest lake neighbour (0,0 when none). */
  lakeDx: number;
  lakeDz: number;
  /**
   * Direction to the track a rail plant halts at (0,0 when none): the
   * lowest-index track neighbour, as `plantTrack` in the sim picks it.
   */
  trackDx: number;
  trackDz: number;
}

/** A drawn plant with its world pose: model base at (x, y, z), turned by yaw about +y. */
export interface PlacedPlant {
  index: number;
  type: PlantType;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/**
 * Yaw that turns a plant model (drawn with its water/track side at +z,
 * see `plants/models.ts`) to its site. Exported for tests.
 */
export function plantYaw(type: PlantType, site: PlantSite): number {
  switch (type) {
    case PlantType.RunOfRiver:
      return site.riverAlongZ ? 0 : Math.PI / 2;
    case PlantType.PumpedStorage:
      return turnToward(site.lakeDx, site.lakeDz);
    case PlantType.TrainStation:
    case PlantType.FreightTerminal:
    case PlantType.RailYard:
      return turnToward(site.trackDx, site.trackDz);
    default:
      return 0;
  }
}

/** Three thin blades merged into one rotor geometry, hub at the origin. */
function createRotorGeometry(): THREE.BufferGeometry {
  const blades: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) {
    const blade = new THREE.BoxGeometry(ROTOR_BLADE.thickness, ROTOR_RADIUS, ROTOR_BLADE.chord);
    blade.translate(0, ROTOR_RADIUS / 2, 0);
    blade.rotateX((i * 2 * Math.PI) / 3);
    blades.push(blade);
  }
  const merged = mergeGeometries(blades);
  // Blades live in the yz-plane; turned to the xy-plane they spin around z.
  merged.rotateY(Math.PI / 2);
  return merged;
}

/** Unit box with its base at y = 0 (plinths, fill bars). */
function baseBox(): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  geometry.translate(0, 0.5, 0);
  return geometry;
}

/** Instance transforms span the grid; the base-geometry bounds would cull them. */
function setupSolid(mesh: THREE.InstancedMesh): void {
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
}

/**
 * Draw `count` instances and flag only those for re-upload (as
 * `GrowingMesh.commit`). The range never goes empty: three.js reads an
 * empty range list as "upload everything".
 */
function uploadDrawn(mesh: THREE.InstancedMesh, count: number): void {
  mesh.count = count;
  const attr = mesh.instanceMatrix;
  attr.clearUpdateRanges();
  attr.addUpdateRange(0, Math.max(1, count) * attr.itemSize);
  if (count > 0) attr.needsUpdate = true;
}

/**
 * All plants and service buildings: one instanced mesh per type drawing
 * its detailed model, a plinth under each, park lawns with trees and
 * benches, spinning turbine rotors (speed proportional to wind output)
 * battery state-of-charge fill bars, and window frames with night
 * glow, aviation and yard lamps on energised plants.
 */
export class PlantsMesh implements DiffLayer {
  /** Concrete or gravel slab under every non-park plant, reaching down to the ground. */
  readonly plinths: GrowingMesh;
  /** Park lawns: two prisms per park, each flush with one ground triangle. */
  readonly parkPads: THREE.InstancedMesh;
  readonly treeMesh: GrowingMesh;
  readonly benchMesh: GrowingMesh;
  readonly rotorMesh: THREE.InstancedMesh;
  /** Front bars showing each battery's state of charge. */
  readonly socFillMesh: THREE.InstancedMesh;
  /** Window frames, night glow, aviation and yard lamps. */
  readonly lights: PlantLights;
  private readonly typeMeshes = new Map<PlantType, GrowingMesh>();
  private readonly modelMaterial = surfaceMaterial({ vertexColors: true });
  private readonly gridSize: number;
  private readonly plants = new Map<number, PlantType>();
  private readonly terrain: Uint8Array;
  /** Track mask per tile, for turning the rail plants toward their halt. */
  private readonly rail: Uint8Array;
  /** 1 where the tile is on a grid island (lights on), per tile. */
  private readonly energised: Uint8Array;
  private readonly placedPlants: PlacedPlant[] = [];
  /** Rotor hubs in world space, with the turbine's yaw. */
  private readonly rotors: Array<{ hub: THREE.Vector3; yaw: number }> = [];
  private rotorAngle = 0;
  private rotorSpeedFactor = 0;
  /** Drawn fill bars, in instance order: world base, yaw and the tile it reads. */
  private readonly socFills: Array<{
    base: THREE.Vector3;
    yaw: number;
    index: number;
    fill: NonNullable<PlantModel['socFill']>;
  }> = [];
  /** Per-tile state of charge 0..1, from the tile diffs. */
  private readonly stateOfCharge = new Map<number, number>();
  private readonly matrix = new THREE.Matrix4();
  private readonly spin = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private readonly position = new THREE.Vector3();
  private readonly color = new THREE.Color();
  private static readonly UP = new THREE.Vector3(0, 1, 0);

  constructor(
    private readonly scene: THREE.Scene,
    gridSize: number,
    private readonly elevation: ElevationField,
  ) {
    this.gridSize = gridSize;
    const capacity = gridSize * gridSize;
    this.terrain = new Uint8Array(capacity);
    this.rail = new Uint8Array(capacity);
    this.energised = new Uint8Array(capacity);
    this.lights = new PlantLights(scene);

    this.plinths = new GrowingMesh(scene, baseBox(), surfaceMaterial(), setupSolid);
    this.treeMesh = new GrowingMesh(scene, treeGeometry(), this.modelMaterial, setupSolid);
    this.benchMesh = new GrowingMesh(scene, benchGeometry(), this.modelMaterial, setupSolid);

    this.parkPads = new THREE.InstancedMesh(
      createHalfTilePrism(),
      surfaceMaterial({ color: PARK_GRASS_COLOR }),
      capacity * 2,
    );
    // Instance transforms live across the whole grid; the base geometry's
    // bounds would wrongly cull the mesh, so culling is disabled.
    this.parkPads.frustumCulled = false;
    this.parkPads.receiveShadow = true;
    this.parkPads.count = 0;
    scene.add(this.parkPads);

    this.rotorMesh = new THREE.InstancedMesh(
      createRotorGeometry(),
      surfaceMaterial({ color: ROTOR_COLOR }),
      capacity,
    );
    this.rotorMesh.frustumCulled = false;
    this.rotorMesh.count = 0;
    scene.add(this.rotorMesh);

    this.socFillMesh = new THREE.InstancedMesh(
      baseBox(),
      new THREE.MeshBasicMaterial({ color: SOC_FILL_COLOR }),
      capacity,
    );
    this.socFillMesh.frustumCulled = false;
    this.socFillMesh.count = 0;
    scene.add(this.socFillMesh);
  }

  /** The mesh drawing a plant type; undefined for types without geometry or none placed yet. */
  meshOf(type: PlantType): THREE.InstancedMesh | undefined {
    return this.typeMeshes.get(type)?.mesh;
  }

  /** Placed plants in rebuild order with their world pose (for the lights). */
  get placed(): ReadonlyArray<Readonly<PlacedPlant>> {
    return this.placedPlants;
  }

  applyDiffs(diffs: TileDiff[]): void {
    let changed = false;
    let socChanged = false;
    let lightsChanged = false;
    for (const diff of diffs) {
      // Only whether the tile is energised matters, not which island.
      const energised = (diff.island ?? 0) > 0 ? 1 : 0;
      if (this.energised[diff.index] !== energised) {
        this.energised[diff.index] = energised;
        // Lights hang on plants; a new plant rebuilds anyway.
        if (diff.tileType === TileType.Plant) lightsChanged = true;
      }
      if (this.terrain[diff.index] !== diff.terrain) {
        this.terrain[diff.index] = diff.terrain;
        changed = true;
      }
      // Track laid or lifted beside a station turns the station.
      if (this.rail[diff.index] !== diff.rail) {
        this.rail[diff.index] = diff.rail;
        changed = true;
      }
      const plant = diff.tileType === TileType.Plant ? diff.plantType : PlantType.None;
      const existing = this.plants.get(diff.index) ?? PlantType.None;
      if (plant !== existing) {
        if (plant === PlantType.None) this.plants.delete(diff.index);
        else this.plants.set(diff.index, plant);
        changed = true;
      }
      // Every storage plant carries its own level; only batteries draw one.
      if (plant === PlantType.Battery) {
        const soc = diff.stored ?? 0;
        if (this.stateOfCharge.get(diff.index) !== soc) {
          this.stateOfCharge.set(diff.index, soc);
          socChanged = true;
        }
      } else {
        this.stateOfCharge.delete(diff.index);
      }
    }
    if (changed) {
      this.rebuild();
      return;
    }
    if (socChanged) this.writeSocFills();
    // Power on or off only switches the lights; the models stay.
    if (lightsChanged) this.rebuildLights();
  }

  setEnvironment(environment: RenderEnvironment): void {
    this.rotorSpeedFactor = environment.windFactor;
    this.lights.setNight(environment.nightFactor);
  }

  update(deltaSeconds: number): void {
    this.lights.update(deltaSeconds);
    if (this.rotors.length === 0) return;
    // Rotor speed is proportional to wind output (still below cut-in).
    const speed =
      this.rotorSpeedFactor > ROTOR_CUT_IN ? ROTOR_MAX_SPEED_RAD_PER_S * this.rotorSpeedFactor : 0;
    if (speed === 0) return;
    this.rotorAngle = (this.rotorAngle + speed * deltaSeconds) % (2 * Math.PI);
    this.writeRotors();
  }

  /** The growing mesh for a type with geometry, created on first use. */
  private typeMesh(type: PlantType): GrowingMesh | undefined {
    let holder = this.typeMeshes.get(type);
    if (!holder) {
      const geometry = plantModel(type).geometry;
      if (!geometry) return undefined;
      holder = new GrowingMesh(this.scene, geometry, this.modelMaterial, setupSolid);
      this.typeMeshes.set(type, holder);
    }
    return holder;
  }

  /** Rebuild every plant instance; cost proportional to the number of plants. */
  private rebuild(): void {
    // 1. Capacity: count per type, plinths and park props first.
    const perType = new Map<PlantType, number>();
    let plinthCount = 0;
    let treeCount = 0;
    let benchCount = 0;
    for (const type of this.plants.values()) {
      perType.set(type, (perType.get(type) ?? 0) + 1);
    }
    for (const [type, n] of perType) {
      const model = plantModel(type);
      this.typeMesh(type)?.ensure(n);
      if (model.plinth) plinthCount += n;
      for (const p of model.groundProps ?? []) {
        if (p.kind === 'tree') treeCount += n;
        else benchCount += n;
      }
    }
    this.plinths.ensure(plinthCount);
    this.treeMesh.ensure(treeCount);
    this.benchMesh.ensure(benchCount);

    // 2. Instances.
    const slots = new Map<PlantType, number>();
    let plinthSlot = 0;
    let treeSlot = 0;
    let benchSlot = 0;
    let padSlot = 0;
    this.placedPlants.length = 0;
    this.rotors.length = 0;
    this.socFills.length = 0;

    for (const [index, type] of this.plants) {
      const model = plantModel(type);
      const cx = (index % this.gridSize) + 0.5;
      const cz = Math.floor(index / this.gridSize) + 0.5;
      const lift = this.elevation.centerY(index);
      const yaw = plantYaw(type, this.siteOf(index));
      const base = lift + PLINTH_RISE;
      this.placedPlants.push({ index, type, x: cx, y: base, z: cz, yaw });

      if (model.plinth) {
        // Plinths are axis-aligned boxes; yaws are quarter turns.
        const quarter = Math.abs(Math.sin(yaw)) > 0.5;
        const sx = quarter ? model.plinth.sz : model.plinth.sx;
        const sz = quarter ? model.plinth.sx : model.plinth.sz;
        // Keeps its top, reaches down to the lowest ground under its
        // footprint so nothing floats on the downhill side of a slope.
        const bottom = Math.min(lift, this.lowestGroundUnder(cx, cz, sx, sz));
        this.matrix.makeScale(sx, base - bottom, sz);
        this.matrix.setPosition(cx, bottom, cz);
        this.plinths.mesh.setMatrixAt(plinthSlot, this.matrix);
        this.plinths.mesh.setColorAt(plinthSlot, this.color.setHex(model.plinth.color));
        plinthSlot++;
      }

      const holder = this.typeMesh(type);
      if (holder) {
        const slot = slots.get(type) ?? 0;
        this.quaternion.setFromAxisAngle(PlantsMesh.UP, yaw);
        this.position.set(cx, base, cz);
        this.matrix.compose(this.position, this.quaternion, this.scale.set(1, 1, 1));
        holder.mesh.setMatrixAt(slot, this.matrix);
        slots.set(type, slot + 1);
      }

      if (model.rotorHub) {
        const { x, y, z } = model.rotorHub;
        const hub = new THREE.Vector3(x, y, z).applyAxisAngle(PlantsMesh.UP, yaw);
        this.rotors.push({ hub: hub.add(this.position.set(cx, base, cz)), yaw });
      }
      if (model.socFill) {
        // The bar stands proud of the face: its back on the anchor.
        const fill = model.socFill;
        const anchor = new THREE.Vector3(fill.x, fill.y, fill.z + fill.d / 2);
        anchor.applyAxisAngle(PlantsMesh.UP, yaw).add(this.position.set(cx, base, cz));
        this.socFills.push({ base: anchor, yaw, index, fill });
      }

      if (type === PlantType.Park) {
        // Lawn flush with the ground on both triangles of the tile.
        for (const high of [false, true]) {
          composePrismOnGround(
            this.matrix,
            this.elevation,
            index,
            high,
            PARK_PAD_SIZE,
            PARK_PAD_HEIGHT,
            0,
          );
          this.parkPads.setMatrixAt(padSlot++, this.matrix);
        }
      }
      for (const p of model.groundProps ?? []) {
        // Each prop stands on the ground at its own spot.
        const x = cx + p.x;
        const z = cz + p.z;
        this.position.set(x, this.elevation.surfaceY(x, z), z);
        this.quaternion.setFromAxisAngle(PlantsMesh.UP, p.turn);
        this.matrix.compose(this.position, this.quaternion, this.scale.setScalar(p.scale));
        if (p.kind === 'tree') this.treeMesh.mesh.setMatrixAt(treeSlot++, this.matrix);
        else this.benchMesh.mesh.setMatrixAt(benchSlot++, this.matrix);
      }
    }

    // 3. Commit every mesh (types with no plants left draw nothing).
    for (const [type, holder] of this.typeMeshes) holder.commit(slots.get(type) ?? 0);
    this.plinths.commit(plinthSlot);
    this.treeMesh.commit(treeSlot);
    this.benchMesh.commit(benchSlot);
    uploadDrawn(this.parkPads, padSlot);
    this.writeRotors();
    this.writeSocFills();
    this.rebuildLights();
  }

  private rebuildLights(): void {
    this.lights.rebuild(this.placedPlants, (index) => this.energised[index] !== 0);
  }

  /**
   * Lowest ground height under a footprint centred on (x, z): the ground
   * is planar per triangle, so sampling the corners, edge midpoints and
   * centre finds the minimum to within the crease.
   */
  private lowestGroundUnder(x: number, z: number, sx: number, sz: number): number {
    const max = this.gridSize - 1e-6;
    let lowest = Infinity;
    for (const fx of [-0.5, 0, 0.5]) {
      for (const fz of [-0.5, 0, 0.5]) {
        const px = Math.min(max, Math.max(0, x + fx * sx));
        const pz = Math.min(max, Math.max(0, z + fz * sz));
        lowest = Math.min(lowest, this.elevation.surfaceY(px, pz));
      }
    }
    return lowest;
  }

  private siteOf(index: number): PlantSite {
    const size = this.gridSize;
    const x = index % size;
    const y = Math.floor(index / size);
    const terrainAt = (tx: number, ty: number): number =>
      tx < 0 || ty < 0 || tx >= size || ty >= size ? Terrain.Land : this.terrain[ty * size + tx];
    const riverAlongZ =
      terrainAt(x, y - 1) === Terrain.River || terrainAt(x, y + 1) === Terrain.River;
    let lakeDx = 0;
    let lakeDz = 0;
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      if (terrainAt(x + dx, y + dz) === Terrain.Lake) {
        lakeDx = dx;
        lakeDz = dz;
        break;
      }
    }
    // Lowest-index track neighbour first (north, west, east, south), the
    // order the sim's plantTrack uses, so the plant faces the halt.
    let trackDx = 0;
    let trackDz = 0;
    for (const [dx, dz] of [
      [0, -1],
      [-1, 0],
      [1, 0],
      [0, 1],
    ] as const) {
      const tx = x + dx;
      const ty = y + dz;
      if (tx < 0 || ty < 0 || tx >= size || ty >= size) continue;
      if (this.rail[ty * size + tx] !== 0) {
        trackDx = dx;
        trackDz = dz;
        break;
      }
    }
    return { riverAlongZ, lakeDx, lakeDz, trackDx, trackDz };
  }

  private writeRotors(): void {
    for (let i = 0; i < this.rotors.length; i++) {
      const { hub, yaw } = this.rotors[i];
      this.matrix.makeRotationY(yaw);
      this.spin.makeRotationZ(this.rotorAngle + i * ROTOR_PHASE_STEP);
      this.matrix.multiply(this.spin);
      this.matrix.setPosition(hub.x, hub.y, hub.z);
      this.rotorMesh.setMatrixAt(i, this.matrix);
    }
    uploadDrawn(this.rotorMesh, this.rotors.length);
  }

  /** Bar on each battery cabinet front showing that battery's state of charge. */
  private writeSocFills(): void {
    for (let i = 0; i < this.socFills.length; i++) {
      const { base, yaw, index, fill } = this.socFills[i];
      const height = SOC_FILL_MIN_HEIGHT + fill.maxH * (this.stateOfCharge.get(index) ?? 0);
      this.quaternion.setFromAxisAngle(PlantsMesh.UP, yaw);
      this.matrix.compose(base, this.quaternion, this.scale.set(fill.w, height, fill.d));
      this.socFillMesh.setMatrixAt(i, this.matrix);
    }
    uploadDrawn(this.socFillMesh, this.socFills.length);
  }
}
