import * as THREE from 'three';
import { BALANCE, TICK_MS } from '../shared/constants.ts';
import type { VehicleState } from '../shared/types.ts';
import { Terrain, VehicleKind, WAGON_ID_OFFSET } from '../shared/types.ts';
import type { RenderEnvironment } from './renderer.ts';
import type { ElevationField } from './elevationField.ts';
import { surfaceMaterial } from './materials.ts';
import {
  busModel,
  containerWagonModel,
  estateModel,
  hatchbackModel,
  hopperWagonModel,
  locomotiveModel,
  passengerWagonModel,
  sedanModel,
  suvModel,
  tankWagonModel,
  vanModel,
  type VehicleModel,
} from './vehicles/models.ts';
import {
  type CarStyle,
  type FreightBody,
  carColorOf,
  carStyleOf,
  containerColorOf,
  freightBodyOf,
} from './vehicles/variety.ts';

export { LOCOMOTIVE_LENGTH, WAGON_LENGTH } from './vehicles/models.ts';

/** Half wheelbase, in tiles: how far ahead/behind the carriageway is
 *  sampled to pitch a vehicle along the slope it drives on. */
const PITCH_SAMPLE = 0.15;

/** Lateral offset from the street centre line to the lane a vehicle
 *  drives in, in tiles. Positive = right-hand traffic. The sim routes
 *  along tile centres; the lane is purely a rendering offset. A road pad
 *  is 0.62 tiles wide, so 0.14 keeps every vehicle body on the pad. */
export const LANE_OFFSET = 0.14;

/** Which mesh an id/kind combination draws into. */
export type ModelKey = CarStyle | 'van' | 'bus' | 'locomotive' | 'passengerWagon' | FreightBody;

// The sim caps cars at 220, so one style's mesh can hold all of them.
const MAX_CARS_PER_STYLE = 256;
const MAX_VANS = 64;
const MAX_BUSES = 64;
const MAX_TRAINS = 64;
const MAX_WAGONS = MAX_TRAINS * 4;

// Fixed instance colours for vehicles that don't vary by id; cars and
// freight containers pick theirs per id (see ./vehicles/variety.ts).
const VAN_COLOR = 0xf2f2ef;
const BUS_COLOR = 0x3f8fd6;
const PASSENGER_TRAIN_COLOR = 0xd84a3a;
const FREIGHT_TRAIN_COLOR = 0x4f6b3a;
const WAGON_COLOR = 0xc9ccd1;
const HOPPER_COLOR = 0x8a6a3f;
const TANK_COLOR = 0x9aa0a8;

/** How far in front of / behind the body the light quads sit, in tiles,
 *  so they don't sit coplanar with the body's end face (z-fighting). */
const LIGHT_PROUD = 0.002;
/** Height of the headlight quad above the ground, in tiles. */
const HEADLIGHT_HEIGHT = 0.06;

const MODELS: Record<ModelKey, { build: () => VehicleModel; capacity: number }> = {
  hatchback: { build: hatchbackModel, capacity: MAX_CARS_PER_STYLE },
  sedan: { build: sedanModel, capacity: MAX_CARS_PER_STYLE },
  estate: { build: estateModel, capacity: MAX_CARS_PER_STYLE },
  suv: { build: suvModel, capacity: MAX_CARS_PER_STYLE },
  van: { build: vanModel, capacity: MAX_VANS },
  bus: { build: busModel, capacity: MAX_BUSES },
  locomotive: { build: locomotiveModel, capacity: MAX_TRAINS },
  passengerWagon: { build: passengerWagonModel, capacity: MAX_WAGONS },
  container: { build: containerWagonModel, capacity: MAX_WAGONS },
  hopper: { build: hopperWagonModel, capacity: MAX_WAGONS },
  tank: { build: tankWagonModel, capacity: MAX_WAGONS },
};

/** Wagons drawn behind a train, by the locomotive's or wagon's kind. */
function wagonsPerTrain(kind: VehicleKind): number {
  return kind === VehicleKind.FreightLocomotive || kind === VehicleKind.FreightWagon
    ? BALANCE.rail.freightWagons
    : BALANCE.rail.passengerWagons;
}

function modelKeyOf(v: VehicleState): ModelKey {
  switch (v.kind) {
    case VehicleKind.Car:
      return carStyleOf(v.id);
    case VehicleKind.Van:
      return 'van';
    case VehicleKind.Bus:
      return 'bus';
    case VehicleKind.Locomotive:
    case VehicleKind.FreightLocomotive:
      return 'locomotive';
    case VehicleKind.Wagon:
      return 'passengerWagon';
    default:
      return freightBodyOf(v.id);
  }
}

function instanceColorOf(v: VehicleState, key: ModelKey): number {
  switch (key) {
    case 'van':
      return VAN_COLOR;
    case 'bus':
      return BUS_COLOR;
    case 'locomotive':
      return v.kind === VehicleKind.FreightLocomotive ? FREIGHT_TRAIN_COLOR : PASSENGER_TRAIN_COLOR;
    case 'passengerWagon':
      return WAGON_COLOR;
    case 'container':
      return containerColorOf(v.id);
    case 'hopper':
      return HOPPER_COLOR;
    case 'tank':
      return TANK_COLOR;
    default:
      return carColorOf(v.id);
  }
}

interface ModelEntry {
  mesh: THREE.InstancedMesh;
  length: number;
  count: number;
}

/**
 * Instanced electric vehicles. Positions arrive at tick rate from the
 * simulation; rendering interpolates between the last two updates for
 * smooth motion. Each model (car style, van, bus, locomotive, wagon
 * body) is its own instanced mesh, so a vehicle's id picks both its
 * model and, for cars and freight wagons, its colour. Head and tail
 * lights fade in at night.
 */
export class VehiclesMesh {
  private readonly models = new Map<ModelKey, ModelEntry>();
  private readonly headlights: THREE.InstancedMesh;
  private readonly tailLights: THREE.InstancedMesh;
  private readonly headlightMaterial: THREE.MeshBasicMaterial;
  private readonly tailLightMaterial: THREE.MeshBasicMaterial;
  private previous = new Map<number, VehicleState>();
  private current: VehicleState[] = [];
  private lastUpdateSeconds = 0;
  /** Expected seconds between sim updates (changes with game speed). */
  private updateInterval = TICK_MS / 1000;
  private readonly matrix = new THREE.Matrix4();
  private readonly lightMatrix = new THREE.Matrix4();
  private readonly offset = new THREE.Matrix4();
  private readonly color = new THREE.Color();
  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly pitchQuaternion = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly pitchAxis = new THREE.Vector3(0, 0, 1);
  private readonly unitScale = new THREE.Vector3(1, 1, 1);

  constructor(
    scene: THREE.Scene,
    private readonly elevation: ElevationField,
    private readonly terrainAt: (index: number) => Terrain,
  ) {
    let lightCapacity = 0;
    for (const key of Object.keys(MODELS) as ModelKey[]) {
      const { build, capacity } = MODELS[key];
      const built = build();
      const mesh = new THREE.InstancedMesh(
        built.geometry,
        surfaceMaterial({ vertexColors: true }),
        capacity,
      );
      // Instance transforms live across the whole grid; the base
      // geometry's bounds would wrongly cull the mesh, so culling is
      // disabled.
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.count = 0;
      mesh.name = key;
      scene.add(mesh);
      this.models.set(key, { mesh, length: built.length, count: 0 });
      lightCapacity += capacity;
    }

    const lightGeometry = new THREE.BoxGeometry(0.004, 0.02, 0.1);
    this.headlightMaterial = new THREE.MeshBasicMaterial({
      color: 0xfff4c9,
      transparent: true,
      opacity: 0,
    });
    this.headlights = new THREE.InstancedMesh(lightGeometry, this.headlightMaterial, lightCapacity);
    this.headlights.frustumCulled = false;
    this.headlights.count = 0;
    this.headlights.name = 'headlights';
    scene.add(this.headlights);

    this.tailLightMaterial = new THREE.MeshBasicMaterial({
      color: 0xe0403a,
      transparent: true,
      opacity: 0,
    });
    this.tailLights = new THREE.InstancedMesh(
      lightGeometry.clone(),
      this.tailLightMaterial,
      lightCapacity,
    );
    this.tailLights.frustumCulled = false;
    this.tailLights.count = 0;
    this.tailLights.name = 'tailLights';
    scene.add(this.tailLights);
  }

  /** Read-only accessor for tests: the instanced mesh drawing a model. */
  modelMeshes(): ReadonlyMap<ModelKey, THREE.InstancedMesh> {
    const out = new Map<ModelKey, THREE.InstancedMesh>();
    for (const [key, entry] of this.models) out.set(key, entry.mesh);
    return out;
  }

  /** New authoritative vehicle states from the simulation. */
  setVehicles(vehicles: VehicleState[], nowSeconds: number): void {
    this.previous = new Map(this.current.map((v) => [v.id, v]));
    this.current = vehicles;
    if (this.lastUpdateSeconds > 0) {
      const measured = nowSeconds - this.lastUpdateSeconds;
      if (measured > 0.01 && measured < 2) {
        this.updateInterval = this.updateInterval * 0.8 + measured * 0.2;
      }
    }
    this.lastUpdateSeconds = nowSeconds;
  }

  setEnvironment(environment: RenderEnvironment): void {
    const opacity = Math.max(0, (environment.nightFactor - 0.3) / 0.7);
    this.headlightMaterial.opacity = opacity;
    this.tailLightMaterial.opacity = opacity;
  }

  /** Interpolate between the last two sim updates. */
  update(nowSeconds: number): void {
    const blend = THREE.MathUtils.clamp(
      (nowSeconds - this.lastUpdateSeconds) / this.updateInterval,
      0,
      1,
    );
    for (const entry of this.models.values()) entry.count = 0;
    let headlightCount = 0;
    let tailLightCount = 0;
    for (const target of this.current) {
      const key = modelKeyOf(target);
      const entry = this.models.get(key)!;
      if (entry.count >= MODELS[key].capacity) continue;
      const color = instanceColorOf(target, key);
      // Trains run on the track's centre line; cars, vans and buses keep
      // to the right-hand lane of the road's centre line.
      const isTrain = target.kind >= VehicleKind.Locomotive;
      const laneOffset = isTrain ? 0 : LANE_OFFSET;
      // Match by stable id: vehicles enter/leave the visible set when
      // they start or finish trips, so indices don't line up.
      const source = this.previous.get(target.id) ?? target;
      // Teleports (respawns) should not slide across the map.
      const jump = Math.hypot(target.x - source.x, target.y - source.y) > 2;
      const angle = jump ? target.angle : lerpAngle(source.angle, target.angle, blend);
      const dirX = Math.cos(angle);
      const dirY = Math.sin(angle);
      // Keep right: the sim drives the centre line, so shift the drawn
      // vehicle sideways into its lane. With the heading (dirX, dirY) in
      // the ground plane and y up, the right-hand side is (-dirY, dirX).
      const x = (jump ? target.x : source.x + (target.x - source.x) * blend) - dirY * laneOffset;
      const y = (jump ? target.y : source.y + (target.y - source.y) * blend) + dirX * laneOffset;
      this.position.set(x, 0.03 + this.roadY(x, y), y);
      this.quaternion.setFromAxisAngle(this.up, -angle);
      // Pitch along the heading so the vehicle hugs a sloped carriageway
      // instead of floating at one end and clipping at the other.
      const ahead = this.roadY(x + dirX * PITCH_SAMPLE, y + dirY * PITCH_SAMPLE);
      const behind = this.roadY(x - dirX * PITCH_SAMPLE, y - dirY * PITCH_SAMPLE);
      const pitch = Math.atan2(ahead - behind, 2 * PITCH_SAMPLE);
      this.pitchQuaternion.setFromAxisAngle(this.pitchAxis, pitch);
      this.quaternion.multiply(this.pitchQuaternion);
      this.matrix.compose(this.position, this.quaternion, this.unitScale);
      entry.mesh.setMatrixAt(entry.count, this.matrix);
      entry.mesh.setColorAt(entry.count, this.color.setHex(color));
      entry.count++;

      // Headlights shine from the front of road vehicles and locomotives;
      // wagons are unpowered and carry none at the front.
      const isLocomotiveKind =
        target.kind === VehicleKind.Locomotive || target.kind === VehicleKind.FreightLocomotive;
      if (!isTrain || isLocomotiveKind) {
        this.lightMatrix.multiplyMatrices(
          this.matrix,
          this.offset.makeTranslation(entry.length / 2 + LIGHT_PROUD, HEADLIGHT_HEIGHT, 0),
        );
        this.headlights.setMatrixAt(headlightCount++, this.lightMatrix);
      }

      // Tail lights: road vehicles always carry one; a train only on its
      // last wagon.
      const isLastWagon =
        (target.kind === VehicleKind.Wagon || target.kind === VehicleKind.FreightWagon) &&
        Math.floor(target.id / WAGON_ID_OFFSET) === wagonsPerTrain(target.kind);
      if (!isTrain || isLastWagon) {
        this.lightMatrix.multiplyMatrices(
          this.matrix,
          this.offset.makeTranslation(-(entry.length / 2 + LIGHT_PROUD), HEADLIGHT_HEIGHT, 0),
        );
        this.tailLights.setMatrixAt(tailLightCount++, this.lightMatrix);
      }
    }
    for (const entry of this.models.values()) {
      entry.mesh.count = entry.count;
      entry.mesh.instanceMatrix.needsUpdate = true;
      if (entry.mesh.instanceColor) entry.mesh.instanceColor.needsUpdate = true;
    }
    this.headlights.count = headlightCount;
    this.headlights.instanceMatrix.needsUpdate = true;
    this.tailLights.count = tailLightCount;
    this.tailLights.instanceMatrix.needsUpdate = true;
  }

  /**
   * Height of the carriageway at a continuous tile position: the ground
   * surface on land, but the flat bridge deck (the bank-level top corner)
   * over a river — vehicles must not dive into the carved channel.
   */
  private roadY(x: number, y: number): number {
    const size = this.elevation.gridSize;
    const tx = Math.min(size - 1, Math.max(0, Math.floor(x)));
    const tz = Math.min(size - 1, Math.max(0, Math.floor(y)));
    const index = tz * size + tx;
    if (this.terrainAt(index) === Terrain.River) return this.elevation.maxCornerY(index);
    return this.elevation.surfaceY(x, y);
  }
}

function lerpAngle(a: number, b: number, t: number): number {
  let delta = b - a;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  return a + delta * t;
}
