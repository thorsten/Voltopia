import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TICK_MS } from '../shared/constants.ts';
import type { VehicleState } from '../shared/types.ts';
import { Terrain, VehicleKind } from '../shared/types.ts';
import type { RenderEnvironment } from './renderer.ts';
import type { ElevationField } from './elevationField.ts';

/** Half wheelbase, in tiles: how far ahead/behind the carriageway is
 *  sampled to pitch a vehicle along the slope it drives on. */
const PITCH_SAMPLE = 0.15;

/** Lateral offset from the street centre line to the lane a vehicle
 *  drives in, in tiles. Positive = right-hand traffic. The sim routes
 *  along tile centres; the lane is purely a rendering offset. A road pad
 *  is 0.62 tiles wide, so 0.14 keeps every vehicle body on the pad. */
export const LANE_OFFSET = 0.14;

const MAX_VEHICLES = 256;
const MAX_VANS = 64;
const MAX_BUSES = 64;
const MAX_TRAINS = 32;
const CAR_COLORS = [0xe8e6e0, 0x8fb3c9, 0xd9a066, 0x9aa88f, 0x707a86, 0xc9788f];
const VAN_COLOR = 0xf2f2ef;
const BUS_COLOR = 0x3f8fd6;
const PASSENGER_TRAIN_COLOR = 0xd84a3a;
const FREIGHT_TRAIN_COLOR = 0x4f6b3a;
const WAGON_COLOR = 0xc9ccd1;
const FREIGHT_WAGON_COLOR = 0x8a6a3f;

/** Simple low-poly car: body + cabin merged into one geometry. */
function createCarGeometry(): THREE.BufferGeometry {
  const body = new THREE.BoxGeometry(0.3, 0.07, 0.14);
  body.translate(0, 0.055, 0);
  const cabin = new THREE.BoxGeometry(0.16, 0.06, 0.12);
  cabin.translate(-0.015, 0.12, 0);
  return mergeGeometries([body, cabin]);
}

/** Boxy delivery van: tall cargo body plus a short cab. */
function createVanGeometry(): THREE.BufferGeometry {
  const cargo = new THREE.BoxGeometry(0.24, 0.16, 0.15);
  cargo.translate(-0.05, 0.1, 0);
  const cab = new THREE.BoxGeometry(0.1, 0.11, 0.15);
  cab.translate(0.12, 0.075, 0);
  return mergeGeometries([cargo, cab]);
}

/** Long single-deck bus: one body with a lighter roof strip. */
function createBusGeometry(): THREE.BufferGeometry {
  const body = new THREE.BoxGeometry(0.4, 0.17, 0.16);
  body.translate(0, 0.105, 0);
  const roof = new THREE.BoxGeometry(0.36, 0.02, 0.14);
  roof.translate(0, 0.2, 0);
  return mergeGeometries([body, roof]);
}

/** Simple low-poly locomotive: body plus a cab toward the front. */
function createLocomotiveGeometry(): THREE.BufferGeometry {
  const body = new THREE.BoxGeometry(0.52, 0.2, 0.18);
  body.translate(0, 0.12, 0);
  const cab = new THREE.BoxGeometry(0.16, 0.08, 0.16);
  cab.translate(0.12, 0.26, 0);
  return mergeGeometries([body, cab]);
}

/** Simple low-poly wagon: a flat-roofed body. */
function createWagonGeometry(): THREE.BufferGeometry {
  const body = new THREE.BoxGeometry(0.5, 0.18, 0.17);
  body.translate(0, 0.11, 0);
  return mergeGeometries([body]);
}

/**
 * Instanced electric vehicles. Positions arrive at tick rate from the
 * simulation; rendering interpolates between the last two updates for
 * smooth motion. Headlights fade in at night.
 */
export class VehiclesMesh {
  private readonly mesh: THREE.InstancedMesh;
  private readonly vans: THREE.InstancedMesh;
  private readonly buses: THREE.InstancedMesh;
  private readonly locomotives: THREE.InstancedMesh;
  private readonly wagons: THREE.InstancedMesh;
  private readonly freightLocomotives: THREE.InstancedMesh;
  private readonly freightWagons: THREE.InstancedMesh;
  private readonly headlights: THREE.InstancedMesh;
  private readonly headlightMaterial: THREE.MeshBasicMaterial;
  private previous = new Map<number, VehicleState>();
  private current: VehicleState[] = [];
  private lastUpdateSeconds = 0;
  /** Expected seconds between sim updates (changes with game speed). */
  private updateInterval = TICK_MS / 1000;
  private readonly matrix = new THREE.Matrix4();
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
    this.mesh = new THREE.InstancedMesh(
      createCarGeometry(),
      new THREE.MeshLambertMaterial(),
      MAX_VEHICLES,
    );
    // Instance transforms live across the whole grid; the base geometry's
    // bounds would wrongly cull the mesh, so culling is disabled.
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.count = 0;
    const color = new THREE.Color();
    for (let i = 0; i < MAX_VEHICLES; i++) {
      this.mesh.setColorAt(i, color.setHex(CAR_COLORS[i % CAR_COLORS.length]));
    }
    scene.add(this.mesh);

    this.vans = new THREE.InstancedMesh(
      createVanGeometry(),
      new THREE.MeshLambertMaterial({ color: VAN_COLOR }),
      MAX_VANS,
    );
    // Instance transforms live across the whole grid; the base geometry's
    // bounds would wrongly cull the mesh, so culling is disabled.
    this.vans.frustumCulled = false;
    this.vans.castShadow = true;
    this.vans.count = 0;
    scene.add(this.vans);

    this.buses = new THREE.InstancedMesh(
      createBusGeometry(),
      new THREE.MeshLambertMaterial({ color: BUS_COLOR }),
      MAX_BUSES,
    );
    // Instance transforms live across the whole grid; the base geometry's
    // bounds would wrongly cull the mesh, so culling is disabled.
    this.buses.frustumCulled = false;
    this.buses.castShadow = true;
    this.buses.count = 0;
    scene.add(this.buses);

    this.locomotives = new THREE.InstancedMesh(
      createLocomotiveGeometry(),
      new THREE.MeshLambertMaterial({ color: PASSENGER_TRAIN_COLOR }),
      MAX_TRAINS,
    );
    // Instance transforms live across the whole grid; the base geometry's
    // bounds would wrongly cull the mesh, so culling is disabled.
    this.locomotives.frustumCulled = false;
    this.locomotives.castShadow = true;
    this.locomotives.count = 0;
    scene.add(this.locomotives);

    this.wagons = new THREE.InstancedMesh(
      createWagonGeometry(),
      new THREE.MeshLambertMaterial({ color: WAGON_COLOR }),
      MAX_TRAINS,
    );
    // Instance transforms live across the whole grid; the base geometry's
    // bounds would wrongly cull the mesh, so culling is disabled.
    this.wagons.frustumCulled = false;
    this.wagons.castShadow = true;
    this.wagons.count = 0;
    scene.add(this.wagons);

    this.freightLocomotives = new THREE.InstancedMesh(
      createLocomotiveGeometry(),
      new THREE.MeshLambertMaterial({ color: FREIGHT_TRAIN_COLOR }),
      MAX_TRAINS,
    );
    // Instance transforms live across the whole grid; the base geometry's
    // bounds would wrongly cull the mesh, so culling is disabled.
    this.freightLocomotives.frustumCulled = false;
    this.freightLocomotives.castShadow = true;
    this.freightLocomotives.count = 0;
    scene.add(this.freightLocomotives);

    this.freightWagons = new THREE.InstancedMesh(
      createWagonGeometry(),
      new THREE.MeshLambertMaterial({ color: FREIGHT_WAGON_COLOR }),
      MAX_TRAINS,
    );
    // Instance transforms live across the whole grid; the base geometry's
    // bounds would wrongly cull the mesh, so culling is disabled.
    this.freightWagons.frustumCulled = false;
    this.freightWagons.castShadow = true;
    this.freightWagons.count = 0;
    scene.add(this.freightWagons);

    const lightGeometry = new THREE.BoxGeometry(0.02, 0.03, 0.12);
    lightGeometry.translate(0.16, 0.06, 0);
    this.headlightMaterial = new THREE.MeshBasicMaterial({
      color: 0xfff4c9,
      transparent: true,
      opacity: 0,
    });
    this.headlights = new THREE.InstancedMesh(
      lightGeometry,
      this.headlightMaterial,
      MAX_VEHICLES + MAX_VANS + MAX_BUSES + 4 * MAX_TRAINS,
    );
    // Instance transforms live across the whole grid; the base geometry's
    // bounds would wrongly cull the mesh, so culling is disabled.
    this.headlights.frustumCulled = false;
    this.headlights.count = 0;
    scene.add(this.headlights);
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
    this.headlightMaterial.opacity = Math.max(0, (environment.nightFactor - 0.3) / 0.7);
  }

  /** Interpolate between the last two sim updates. */
  update(nowSeconds: number): void {
    const blend = THREE.MathUtils.clamp(
      (nowSeconds - this.lastUpdateSeconds) / this.updateInterval,
      0,
      1,
    );
    let cars = 0;
    let vans = 0;
    let buses = 0;
    let locos = 0;
    let wagons = 0;
    let freightLocos = 0;
    let freightWagons = 0;
    let lights = 0;
    for (const target of this.current) {
      if (target.kind === VehicleKind.Van && vans >= MAX_VANS) continue;
      if (target.kind === VehicleKind.Bus && buses >= MAX_BUSES) continue;
      if (target.kind === VehicleKind.Car && cars >= MAX_VEHICLES) continue;
      if (target.kind === VehicleKind.Locomotive && locos >= MAX_TRAINS) continue;
      if (target.kind === VehicleKind.Wagon && wagons >= MAX_TRAINS) continue;
      if (target.kind === VehicleKind.FreightLocomotive && freightLocos >= MAX_TRAINS) continue;
      if (target.kind === VehicleKind.FreightWagon && freightWagons >= MAX_TRAINS) continue;
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
      let isLocomotiveKind = false;
      switch (target.kind) {
        case VehicleKind.Van:
          this.vans.setMatrixAt(vans++, this.matrix);
          break;
        case VehicleKind.Bus:
          this.buses.setMatrixAt(buses++, this.matrix);
          break;
        case VehicleKind.Locomotive:
          this.locomotives.setMatrixAt(locos++, this.matrix);
          isLocomotiveKind = true;
          break;
        case VehicleKind.Wagon:
          this.wagons.setMatrixAt(wagons++, this.matrix);
          break;
        case VehicleKind.FreightLocomotive:
          this.freightLocomotives.setMatrixAt(freightLocos++, this.matrix);
          isLocomotiveKind = true;
          break;
        case VehicleKind.FreightWagon:
          this.freightWagons.setMatrixAt(freightWagons++, this.matrix);
          break;
        default:
          this.mesh.setMatrixAt(cars++, this.matrix);
          break;
      }
      // Headlights shine from the front of cars, vans, buses and
      // locomotives; wagons are unpowered and carry none.
      if (!isTrain || isLocomotiveKind) this.headlights.setMatrixAt(lights++, this.matrix);
    }
    this.mesh.count = cars;
    this.vans.count = vans;
    this.buses.count = buses;
    this.locomotives.count = locos;
    this.wagons.count = wagons;
    this.freightLocomotives.count = freightLocos;
    this.freightWagons.count = freightWagons;
    this.headlights.count = lights;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.vans.instanceMatrix.needsUpdate = true;
    this.buses.instanceMatrix.needsUpdate = true;
    this.locomotives.instanceMatrix.needsUpdate = true;
    this.wagons.instanceMatrix.needsUpdate = true;
    this.freightLocomotives.instanceMatrix.needsUpdate = true;
    this.freightWagons.instanceMatrix.needsUpdate = true;
    this.headlights.instanceMatrix.needsUpdate = true;
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
