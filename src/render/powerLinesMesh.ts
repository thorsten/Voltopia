import * as THREE from 'three';
import { DIR_E, DIR_N, DIR_S, DIR_W } from '../shared/grid.ts';
import type { TileDiff } from '../shared/types.ts';
import { TileType, Zone } from '../shared/types.ts';
import type { DiffLayer } from './renderer.ts';
import type { ElevationField } from './elevationField.ts';
import { surfaceMaterial } from './materials.ts';
import { pylonModel, type PylonKind } from './infrastructure/pylonModels.ts';
import { GrowingMesh } from './plants/growingMesh.ts';

const CABLE_COLOR = 0x2b2f33;
const CABLE_THICKNESS = 0.012;
/** Pieces each conductor is drawn in, along its sag curve. */
export const CABLE_SEGMENTS = 6;
/** How far a conductor hangs below the straight chord at mid-span. */
export const CABLE_SAG = 0.06;
/** On a road tile the pylon stands at the north-west kerb so cars pass. */
const KERB_OFFSET = 0.12;
const DIRECTION_BITS = DIR_N | DIR_E | DIR_S | DIR_W;
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
 * in town on every line tile, and three sagging conductors per
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
      new THREE.BoxGeometry(1, CABLE_THICKNESS, CABLE_THICKNESS),
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

  /** Kind, foot position (kerb on roads, centre elsewhere) and yaw of a tile's pylon. */
  private pylonAt(index: number): Pylon {
    const tx = index % this.gridSize;
    const tz = Math.floor(index / this.gridSize);
    const type = this.tileTypes[index];
    const town =
      type === TileType.Road || type === TileType.Plant || this.zones[index] !== Zone.None;
    const offset = type === TileType.Road ? KERB_OFFSET : 0.5;
    const x = tx + offset;
    const z = tz + offset;
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

  /** Set the dummy to a unit conductor box stretched from `a` to `b`. */
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
