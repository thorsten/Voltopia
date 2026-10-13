import * as THREE from 'three';
import { DIR_E, DIR_N, DIR_S, DIR_W } from '../shared/grid.ts';
import type { TileDiff } from '../shared/types.ts';
import { TileType, Zone } from '../shared/types.ts';
import type { DiffLayer } from './renderer.ts';
import type { ElevationField } from './elevationField.ts';
import { surfaceMaterial } from './materials.ts';
import { POLE_FOOT_RADIUS, pylonModel, type PylonKind } from './infrastructure/pylonModels.ts';
import { signalSide } from './infrastructure/railSignals.ts';
import { kerbsideCorner } from './roadsMesh.ts';
import { GrowingMesh } from './plants/growingMesh.ts';

const CABLE_COLOR = 0x2b2f33;
const CABLE_THICKNESS = 0.012;
/** Pieces each conductor is drawn in, along its sag curve: four still read as a sag. */
export const CABLE_SEGMENTS = 4;
/** Sides of a conductor's cross-section: a triangular tube, the cheapest that reads round. */
const CABLE_SIDES = 3;
/** How far a conductor hangs below the straight chord at mid-span. */
export const CABLE_SAG = 0.06;
const DIRECTION_BITS = DIR_N | DIR_E | DIR_S | DIR_W;
/** Half the width of the track's ballast bed (railMesh BALLAST_WIDTH / 2). */
const BALLAST_HALF_WIDTH = 0.15;
/**
 * On a track tile (off the road) the pole stands this far beside the
 * track's centre line: clear of the ballast with room to spare, so its
 * arms, too, mostly keep clear of the trains.
 */
export const TRACK_POLE_OFFSET = BALLAST_HALF_WIDTH + POLE_FOOT_RADIUS + 0.12;

/**
 * Offset (from the tile centre) of the pole on a track tile: on the side
 * of the track opposite the signal mast's (railSignals.ts — a mast stands
 * there on signal tiles, and the side is kept elsewhere so a station
 * built later moves the pole with its signal). Straight track along x →
 * the other z side, along z → the other x side; curves and junctions →
 * the diagonal corner opposite the mast's, which no track arm crosses.
 */
export function trackPoleOffset(
  rail: number,
  plantEast: boolean,
  plantSouth: boolean,
): { dx: number; dz: number } {
  const bits = rail & DIRECTION_BITS;
  const alongX = (bits & (DIR_N | DIR_S)) === 0;
  const alongZ = (bits & (DIR_E | DIR_W)) === 0 && bits !== 0;
  const { sx, sz } = signalSide(plantEast, plantSouth);
  return {
    dx: alongX ? 0 : -sx * TRACK_POLE_OFFSET,
    dz: alongZ ? 0 : -sz * TRACK_POLE_OFFSET,
  };
}

/**
 * Corner (signs of the x and z offset from the tile centre) of the pole
 * on a road tile. Level-crossing barriers (railMesh) take two opposite
 * corners: (−,−) and (+,+) when the track runs along x, (−,+) and (+,−)
 * along z. The pole keeps to the north-west kerb (the streetlamp has the
 * south-east one), except on a crossing with the track along x, where
 * it takes the free north-east corner (the bus shelter keeps south-west).
 */
export function roadPoleCorner(rail: number): { sx: number; sz: number } {
  const bits = rail & DIRECTION_BITS;
  const trackAlongX = (bits & (DIR_E | DIR_W)) !== 0 && (bits & (DIR_N | DIR_S)) === 0;
  return trackAlongX ? { sx: 1, sz: -1 } : { sx: -1, sz: -1 };
}
/** Yaw that puts the line (local z) along world x. */
const ALONG_X = Math.PI / 2;

/**
 * Yaw of a pylon, in [0, π): turns local z (the line) onto the line's
 * direction. Straight lines follow their axis; a corner (one N/S and one
 * E/W bit) runs along the mean of its in- and outgoing direction, so the
 * cross-arms bisect the turn; T, cross and isolated tiles run along x.
 */
export function pylonYaw(mask: number): number {
  const bits = mask & DIRECTION_BITS;
  const ns = bits & (DIR_N | DIR_S);
  const ew = bits & (DIR_E | DIR_W);
  if (ns === 0) return ALONG_X;
  if (ew === 0) return 0;
  if (ns === (DIR_N | DIR_S) || ew === (DIR_E | DIR_W)) return ALONG_X;
  // Arm vectors in (x, z): N = (0, −1), S = (0, 1), E = (1, 0), W = (−1, 0).
  // The line runs from one arm to the other: direction = ewArm − nsArm.
  const dx = ew === DIR_E ? 1 : -1;
  const dz = ns === DIR_N ? 1 : -1;
  const yaw = Math.atan2(dx, dz);
  return yaw < 0 ? yaw + Math.PI : yaw;
}

/**
 * CABLE_SEGMENTS + 1 points of a conductor from `a` to `b`, hanging on a
 * parabola CABLE_SAG below the chord at mid-span.
 */
export function conductorPoints(a: THREE.Vector3, b: THREE.Vector3): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  for (let k = 0; k <= CABLE_SEGMENTS; k++) {
    const t = k / CABLE_SEGMENTS;
    const p = new THREE.Vector3().lerpVectors(a, b, t);
    p.y -= 4 * CABLE_SAG * t * (1 - t);
    points.push(p);
  }
  return points;
}

/**
 * A conductor piece: a unit-length tube along x (centred on the origin)
 * with a CABLE_SIDES-sided cross-section about CABLE_THICKNESS across,
 * open ends (neighbouring pieces close the gaps) and smooth radial
 * normals — 2 triangles per side.
 */
export function conductorGeometry(): THREE.BufferGeometry {
  const radius = CABLE_THICKNESS / 2;
  const positions: number[] = [];
  const normals: number[] = [];
  for (const x of [-0.5, 0.5]) {
    for (let k = 0; k < CABLE_SIDES; k++) {
      const a = (2 * Math.PI * k) / CABLE_SIDES;
      const y = Math.cos(a);
      const z = Math.sin(a);
      positions.push(x, radius * y, radius * z);
      normals.push(0, y, z);
    }
  }
  const index: number[] = [];
  for (let k = 0; k < CABLE_SIDES; k++) {
    const next = (k + 1) % CABLE_SIDES;
    // Counter-clockwise seen from outside: start ring k, next; end ring k, next.
    const [a, b, c, d] = [k, next, CABLE_SIDES + k, CABLE_SIDES + next];
    index.push(a, b, d, a, d, c);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(index);
  return geometry;
}

/** Instance transforms span the grid; the base-geometry bounds would cull them. */
function setupPylon(mesh: THREE.InstancedMesh): void {
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
}

/** Instance transforms span the grid; the base-geometry bounds would cull them. */
function setupConductor(mesh: THREE.InstancedMesh): void {
  mesh.frustumCulled = false;
  mesh.castShadow = false;
}

interface Pylon {
  kind: PylonKind;
  foot: THREE.Vector3;
  yaw: number;
}

/**
 * Instanced power lines: a lattice pylon on open land or a concrete pole
 * in town or beside a track on every line tile, and three sagging conductors per
 * connection. Conductors are drawn for the east and south bits only, so
 * every span is drawn exactly once. Dead lines look like live ones; the
 * supply overlay shows whether they carry power.
 */
export class PowerLinesMesh implements DiffLayer {
  readonly lattice: GrowingMesh;
  readonly poles: GrowingMesh;
  readonly conductors: GrowingMesh;
  private readonly gridSize: number;
  private readonly masks: Uint8Array;
  private readonly tileTypes: Uint8Array;
  private readonly zones: Uint8Array;
  private readonly levels: Uint8Array;
  /** Road class per tile: an avenue's wider roadway moves the pole back to its kerb. */
  private readonly roadClasses: Uint8Array;
  /** Track mask per tile: a level crossing moves the road pole off its barriers. */
  private readonly rails: Uint8Array;
  private readonly dummy = new THREE.Object3D();

  constructor(
    scene: THREE.Scene,
    gridSize: number,
    private readonly elevation: ElevationField,
  ) {
    this.gridSize = gridSize;
    const n = gridSize * gridSize;
    this.masks = new Uint8Array(n);
    this.tileTypes = new Uint8Array(n);
    this.zones = new Uint8Array(n);
    this.levels = new Uint8Array(n);
    this.rails = new Uint8Array(n);
    this.roadClasses = new Uint8Array(n);

    const pylonMaterial = surfaceMaterial({ vertexColors: true });
    this.lattice = new GrowingMesh(
      scene,
      pylonModel('lattice').geometry,
      pylonMaterial,
      setupPylon,
    );
    this.poles = new GrowingMesh(scene, pylonModel('pole').geometry, pylonMaterial, setupPylon);
    this.conductors = new GrowingMesh(
      scene,
      conductorGeometry(),
      surfaceMaterial({ color: CABLE_COLOR }),
      setupConductor,
    );
  }

  applyDiffs(diffs: TileDiff[]): void {
    let changed = false;
    let lifted = false;
    for (const diff of diffs) {
      const i = diff.index;
      const hadLine = this.masks[i] !== 0;
      if (this.masks[i] !== diff.powerLine) {
        this.masks[i] = diff.powerLine;
        changed = true;
      }
      // Tile type and zone pick the pylon kind and its spot: they matter
      // when the tile carries a line before or after the change.
      const hasLine = hadLine || this.masks[i] !== 0;
      if (this.tileTypes[i] !== diff.tileType || this.zones[i] !== diff.zone) {
        this.tileTypes[i] = diff.tileType;
        this.zones[i] = diff.zone;
        // A plant east or south of a line on track moves that pole.
        if (hasLine || this.lineWestOrNorth(i)) changed = true;
      }
      if (this.roadClasses[i] !== diff.roadClass) {
        this.roadClasses[i] = diff.roadClass;
        if (hasLine) changed = true;
      }
      if (this.rails[i] !== diff.rail) {
        this.rails[i] = diff.rail;
        if (hasLine) changed = true;
      }
      if (this.levels[i] !== diff.elevation) {
        this.levels[i] = diff.elevation;
        lifted = true;
      }
    }
    // A level change moves the ground under nearby feet; terraforming is
    // rare, so any change rebuilds when the map has lines at all.
    if (changed || (lifted && this.masks.some((mask) => mask !== 0))) this.rebuild();
  }

  /** Whether the tile's west or north neighbour carries a line. */
  private lineWestOrNorth(index: number): boolean {
    const west = index % this.gridSize > 0 && this.masks[index - 1] !== 0;
    const north = index >= this.gridSize && this.masks[index - this.gridSize] !== 0;
    return west || north;
  }

  /** Whether a tile in the grid holds a plant. */
  private plantAt(tx: number, tz: number): boolean {
    if (tx < 0 || tz < 0 || tx >= this.gridSize || tz >= this.gridSize) return false;
    return this.tileTypes[tz * this.gridSize + tx] === TileType.Plant;
  }

  /** Kind, foot position (kerb on roads, beside the track on tracks, centre elsewhere) and yaw of a tile's pylon. */
  private pylonAt(index: number): Pylon {
    const tx = index % this.gridSize;
    const tz = Math.floor(index / this.gridSize);
    const type = this.tileTypes[index];
    const rail = this.rails[index];
    // Lines never share a tile with a plant (sim buildRejection).
    const town = type === TileType.Road || rail !== 0 || this.zones[index] !== Zone.None;
    let x = tx + 0.5;
    let z = tz + 0.5;
    if (type === TileType.Road) {
      const { sx, sz } = roadPoleCorner(this.rails[index]);
      // Beyond the kerb, like the streetlamp in the opposite corner, so cars pass.
      const corner = kerbsideCorner(this.roadClasses[index], POLE_FOOT_RADIUS);
      x += sx * corner;
      z += sz * corner;
    } else if (rail !== 0) {
      const { dx, dz } = trackPoleOffset(rail, this.plantAt(tx + 1, tz), this.plantAt(tx, tz + 1));
      x += dx;
      z += dz;
    }
    // The foot stands on the ground under it: on a slope the kerb corner
    // sits well above or below the tile's nominal level.
    return {
      kind: town ? 'pole' : 'lattice',
      foot: new THREE.Vector3(x, this.elevation.surfaceY(x, z), z),
      yaw: pylonYaw(this.masks[index]),
    };
  }

  /** World attachment points of a pylon. */
  private attachments(pylon: Pylon): THREE.Vector3[] {
    const cos = Math.cos(pylon.yaw);
    const sin = Math.sin(pylon.yaw);
    return pylonModel(pylon.kind).attachments.map(
      (a) =>
        // Rotation about y by yaw: x' = x cos + z sin, z' = −x sin + z cos.
        new THREE.Vector3(
          pylon.foot.x + a.x * cos + a.z * sin,
          pylon.foot.y + a.y,
          pylon.foot.z - a.x * sin + a.z * cos,
        ),
    );
  }

  private rebuild(): void {
    let latticeCount = 0;
    let poleCount = 0;
    let segmentCount = 0;
    const dummy = this.dummy;
    for (let index = 0; index < this.masks.length; index++) {
      const mask = this.masks[index];
      if (mask === 0) continue;
      const here = this.pylonAt(index);
      dummy.position.copy(here.foot);
      dummy.rotation.set(0, here.yaw, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      const holder = here.kind === 'lattice' ? this.lattice : this.poles;
      const slot = here.kind === 'lattice' ? latticeCount++ : poleCount++;
      holder.ensure(slot + 1);
      holder.mesh.setMatrixAt(slot, dummy.matrix);

      const east = (mask & DIR_E) !== 0 ? index + 1 : -1;
      const south = (mask & DIR_S) !== 0 ? index + this.gridSize : -1;
      for (const neighbor of [east, south]) {
        if (neighbor < 0 || neighbor >= this.masks.length) continue;
        const there = this.pylonAt(neighbor);
        // Pair the attachments by their lateral offset across the span so
        // conductors never cross, whatever the two pylons' yaws.
        const nx = -(there.foot.z - here.foot.z);
        const nz = there.foot.x - here.foot.x;
        const lateral = (p: THREE.Vector3) => p.x * nx + p.z * nz;
        const byOffset = (a: THREE.Vector3, b: THREE.Vector3) => lateral(a) - lateral(b);
        const from = this.attachments(here).sort(byOffset);
        const to = this.attachments(there).sort(byOffset);
        for (let c = 0; c < from.length; c++) {
          const points = conductorPoints(from[c], to[c]);
          this.conductors.ensure(segmentCount + CABLE_SEGMENTS);
          for (let k = 0; k < CABLE_SEGMENTS; k++) {
            this.placeSegment(points[k], points[k + 1]);
            this.conductors.mesh.setMatrixAt(segmentCount++, dummy.matrix);
          }
        }
      }
    }
    this.lattice.commit(latticeCount);
    this.poles.commit(poleCount);
    this.conductors.commit(segmentCount);
  }

  /** Set the dummy to a unit conductor piece stretched from `a` to `b`. */
  private placeSegment(a: THREE.Vector3, b: THREE.Vector3): void {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const dummy = this.dummy;
    dummy.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    // Euler XYZ applies the pitch (about z) first, then the yaw (about y).
    dummy.rotation.set(0, -Math.atan2(dz, dx), Math.atan2(dy, Math.hypot(dx, dz)));
    dummy.scale.set(Math.hypot(dx, dy, dz), 1, 1);
    dummy.updateMatrix();
  }
}
