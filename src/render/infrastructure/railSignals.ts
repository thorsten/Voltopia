/**
 * Line-side signals that show block occupancy: a mast beside the track
 * on tiles next to a station, freight terminal or rail yard and at
 * junctions, its lamp red while a rail vehicle is in the block around
 * the tile, green otherwise. Decoration: trains do not obey them.
 *
 * Conventions: units are tiles; tile (tx, ty) has its centre at
 * (tx + 0.5, ty + 0.5), the same frame as the vehicles' x/y (sim/trains.ts).
 * The mast model stands on y = 0 with its lamp facing local +x.
 */
import * as THREE from 'three';
import { DIR_E, DIR_N, DIR_S, DIR_W, DIRECTIONS } from '../../shared/grid.ts';
import { PlantType, Terrain, TileType } from '../../shared/types.ts';
import type { ElevationField } from '../elevationField.ts';
import { surfaceMaterial } from '../materials.ts';
import { box, merge } from '../modelKit.ts';
import { GrowingMesh } from '../plants/growingMesh.ts';

/** A signal shows red while a rail vehicle is this close (Chebyshev, tiles) to its tile centre. */
export const SIGNAL_BLOCK_TILES = 1.5;
/** The mast stands this far beside the track's centre line. */
export const SIGNAL_OFFSET = 0.25;
export const SIGNAL_GREEN = 0x3ddc84;
export const SIGNAL_RED = 0xe0402c;
/** Lamp opacity by day; it rises to 1 at night. */
export const SIGNAL_DAY_OPACITY = 0.45;
/** Junctions (this many track connections or more) get a signal. */
const SIGNAL_MIN_CONNECTIONS = 3;

const MAST = {
  color: 0x5b6066,
  headColor: 0x2b2f33,
  foot: { size: 0.05, height: 0.02 },
  mast: { size: 0.022, height: 0.32 },
  /** The head box hangs off the mast top; the lamp sits on its front (+x) face. */
  head: { depth: 0.04, height: 0.09, width: 0.06, y: 0.3 },
  hood: { depth: 0.025, height: 0.008, width: 0.05 },
  lampRadius: 0.016,
} as const;
/** The lamp's centre, just proud of the head's front face. */
const LAMP_LOCAL = new THREE.Vector3(MAST.head.depth / 2 + MAST.lampRadius / 2, MAST.head.y, 0);
/** A small lamp needs few facets. */
const LAMP_SEGMENTS = 8;

const RAIL_PLANTS: ReadonlySet<number> = new Set([
  PlantType.TrainStation,
  PlantType.FreightTerminal,
  PlantType.RailYard,
]);

/** Yaw per connection bit, as in railMesh.ts: +x turned by +90° about +y points north (-z). */
const DIRECTION_YAW: ReadonlyArray<{ bit: number; yaw: number }> = [
  { bit: DIR_E, yaw: 0 },
  { bit: DIR_N, yaw: Math.PI / 2 },
  { bit: DIR_W, yaw: Math.PI },
  { bit: DIR_S, yaw: -Math.PI / 2 },
];

const connectionCount = (mask: number) => DIRECTIONS.filter(({ bit }) => (mask & bit) !== 0).length;

function isRailPlant(tileTypes: Uint8Array, plantTypes: Uint8Array, index: number): boolean {
  return tileTypes[index] === TileType.Plant && RAIL_PLANTS.has(plantTypes[index]);
}

/**
 * Track tiles that get a signal: not on a road (level crossings have
 * their own) or the river, and either next to (4-neighbour) a station,
 * freight terminal or rail yard tile, or a junction. Ascending order.
 */
export function signalTiles(
  masks: Uint8Array,
  tileTypes: Uint8Array,
  terrains: Uint8Array,
  plantTypes: Uint8Array,
  gridSize: number,
): number[] {
  const result: number[] = [];
  for (let index = 0; index < masks.length; index++) {
    const mask = masks[index];
    if (mask === 0 || tileTypes[index] === TileType.Road || terrains[index] === Terrain.River)
      continue;
    if (connectionCount(mask) >= SIGNAL_MIN_CONNECTIONS) {
      result.push(index);
      continue;
    }
    const x = index % gridSize;
    const y = Math.floor(index / gridSize);
    const nearPlant = DIRECTIONS.some(({ dx, dy }) => {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= gridSize || ny >= gridSize) return false;
      return isRailPlant(tileTypes, plantTypes, ny * gridSize + nx);
    });
    if (nearPlant) result.push(index);
  }
  return result;
}

/** Whether any vehicle (tile coordinates, centres at +0.5) is within the block around the tile's centre. */
export function blockOccupied(
  tile: number,
  gridSize: number,
  vehicles: ReadonlyArray<{ x: number; y: number }>,
): boolean {
  const cx = (tile % gridSize) + 0.5;
  const cy = Math.floor(tile / gridSize) + 0.5;
  for (const { x, y } of vehicles) {
    if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) <= SIGNAL_BLOCK_TILES) return true;
  }
  return false;
}

/**
 * Side of the track a signal mast takes (signs of its x and z offset):
 * away from a plant to the east / south, else the default +x / +z side.
 * Straight track uses one of the two, curves and junctions both.
 */
export function signalSide(plantEast: boolean, plantSouth: boolean): { sx: number; sz: number } {
  return { sx: plantEast ? -1 : 1, sz: plantSouth ? -1 : 1 };
}

/** Signal mast: a foot, a slim mast, a head box at the top and a hood over the lamp. */
function mastGeometry(): THREE.BufferGeometry {
  const { foot, mast, head, hood } = MAST;
  return merge([
    box(foot.size, foot.height, foot.size, 0, foot.height / 2, 0, MAST.color),
    box(mast.size, mast.height, mast.size, 0, mast.height / 2, 0, MAST.color),
    box(head.depth, head.height, head.width, 0, head.y, 0, MAST.headColor),
    box(
      hood.depth,
      hood.height,
      hood.width,
      head.depth / 2 + hood.depth / 2,
      head.y + MAST.lampRadius + hood.height,
      0,
      MAST.headColor,
    ),
  ]).geometry;
}

/** Masts cast shadows; transforms span the grid, so no culling. */
function setupMast(mesh: THREE.InstancedMesh): void {
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
}

/** Unlit lamps cast nothing; transforms span the grid, so no culling. */
function setupLamp(mesh: THREE.InstancedMesh): void {
  mesh.frustumCulled = false;
  mesh.castShadow = false;
}

export class RailSignals {
  readonly masts: GrowingMesh;
  readonly lamps: GrowingMesh;
  private readonly lampMaterial: THREE.MeshBasicMaterial;
  private tiles: number[] = [];
  /** Shown aspect per signal: true = red. */
  private red: boolean[] = [];
  private vehicles: ReadonlyArray<{ x: number; y: number }> = [];
  /** Whether the vehicles changed since the aspects were last evaluated. */
  private dirty = false;
  private gridSize = 0;
  private readonly matrix = new THREE.Matrix4();
  private readonly lampOffset = new THREE.Vector3();
  private readonly color = new THREE.Color();

  constructor(scene: THREE.Scene) {
    this.masts = new GrowingMesh(
      scene,
      mastGeometry(),
      surfaceMaterial({ vertexColors: true }),
      setupMast,
    );
    // White base colour: each lamp's aspect is its instance colour.
    this.lampMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: SIGNAL_DAY_OPACITY,
    });
    this.lamps = new GrowingMesh(
      scene,
      new THREE.SphereGeometry(MAST.lampRadius, LAMP_SEGMENTS, LAMP_SEGMENTS / 2),
      this.lampMaterial,
      setupLamp,
    );
  }

  /**
   * Place a signal on every signal tile. The mast stands beside the
   * track, on the side away from a neighbouring plant where it can:
   * straight along x → ±z, along z → ±x, otherwise in a diagonal corner
   * between the arms. Its lamp faces along the track.
   */
  rebuild(
    masks: Uint8Array,
    tileTypes: Uint8Array,
    terrains: Uint8Array,
    plantTypes: Uint8Array,
    gridSize: number,
    elevation: ElevationField,
  ): void {
    this.gridSize = gridSize;
    this.tiles = signalTiles(masks, tileTypes, terrains, plantTypes, gridSize);
    this.red = [];
    const count = this.tiles.length;
    this.masts.ensure(count);
    this.lamps.ensure(count);
    const plantAt = (x: number, y: number) =>
      x >= 0 && y >= 0 && x < gridSize && y < gridSize && plantTypes[y * gridSize + x] !== 0;
    for (let slot = 0; slot < count; slot++) {
      const index = this.tiles[slot];
      const tx = index % gridSize;
      const ty = Math.floor(index / gridSize);
      const bits = masks[index] & (DIR_N | DIR_E | DIR_S | DIR_W);
      const alongX = (bits & (DIR_N | DIR_S)) === 0;
      const alongZ = (bits & (DIR_E | DIR_W)) === 0 && bits !== 0;
      const { sx, sz } = signalSide(plantAt(tx + 1, ty), plantAt(tx, ty + 1));
      const px = tx + 0.5 + (alongX ? 0 : sx * SIGNAL_OFFSET);
      const pz = ty + 0.5 + (alongZ ? 0 : sz * SIGNAL_OFFSET);
      const yaw = (DIRECTION_YAW.find(({ bit }) => (bits & bit) !== 0) ?? DIRECTION_YAW[0]).yaw;
      const ground = elevation.surfaceY(px, pz);
      this.matrix.makeRotationY(yaw).setPosition(px, ground, pz);
      this.masts.mesh.setMatrixAt(slot, this.matrix);
      this.lampOffset.copy(LAMP_LOCAL).applyAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
      this.matrix.makeTranslation(
        px + this.lampOffset.x,
        ground + this.lampOffset.y,
        pz + this.lampOffset.z,
      );
      this.lamps.mesh.setMatrixAt(slot, this.matrix);
      const red = blockOccupied(index, gridSize, this.vehicles);
      this.red.push(red);
      this.writeAspect(slot, red);
    }
    this.masts.commit(count);
    this.lamps.commit(count);
    // Every aspect was just evaluated against the current vehicles.
    this.dirty = false;
  }

  /**
   * Rail vehicle positions of the last tick (tile coordinates). Call it
   * again after changing the list in place: the next update evaluates
   * the aspects only then.
   */
  setVehicles(vehicles: ReadonlyArray<{ x: number; y: number }>): void {
    this.vehicles = vehicles;
    this.dirty = true;
  }

  setNight(nightFactor: number): void {
    this.lampMaterial.opacity = SIGNAL_DAY_OPACITY + (1 - SIGNAL_DAY_OPACITY) * nightFactor;
  }

  /**
   * Re-evaluate every aspect once new vehicles have arrived (vehicles
   * move once per sim tick, frames come far more often); upload the
   * colours only when one changed.
   */
  update(): void {
    if (!this.dirty) return;
    this.dirty = false;
    let changed = false;
    for (let slot = 0; slot < this.tiles.length; slot++) {
      const red = blockOccupied(this.tiles[slot], this.gridSize, this.vehicles);
      if (red === this.red[slot]) continue;
      this.red[slot] = red;
      this.writeAspect(slot, red);
      changed = true;
    }
    if (changed) this.lamps.commitColors(this.tiles.length);
  }

  private writeAspect(slot: number, red: boolean): void {
    this.color.setHex(red ? SIGNAL_RED : SIGNAL_GREEN);
    this.lamps.mesh.setColorAt(slot, this.color);
  }
}
