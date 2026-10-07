import * as THREE from 'three';
import { DIR_E, DIR_S } from '../shared/grid.ts';
import type { TileDiff } from '../shared/types.ts';
import { TileType } from '../shared/types.ts';
import type { DiffLayer } from './renderer.ts';
import type { ElevationField } from './elevationField.ts';
import { surfaceMaterial } from './materials.ts';

const PYLON_COLOR = 0x6b6f75;
const CABLE_COLOR = 0x2b2f33;
const PYLON_HEIGHT = 0.55;
const PYLON_THICKNESS = 0.06;
const CABLE_THICKNESS = 0.025;
/** On a road tile the pylon stands at the north-west kerb so cars pass. */
const KERB_OFFSET = 0.12;

/**
 * Instanced power lines: one pylon per line tile and one cable per
 * connection. Cables are drawn for the east and south bits only, so every
 * connection is drawn exactly once. Dead lines look like live ones; the
 * supply overlay shows whether they carry power.
 */
export class PowerLinesMesh implements DiffLayer {
  private readonly pylons: THREE.InstancedMesh;
  private readonly cables: THREE.InstancedMesh;
  private readonly gridSize: number;
  private readonly masks: Uint8Array;
  private readonly tileTypes: Uint8Array;
  private readonly dummy = new THREE.Object3D();

  constructor(
    scene: THREE.Scene,
    gridSize: number,
    private readonly elevation: ElevationField,
  ) {
    this.gridSize = gridSize;
    this.masks = new Uint8Array(gridSize * gridSize);
    this.tileTypes = new Uint8Array(gridSize * gridSize);

    const pylonGeometry = new THREE.BoxGeometry(PYLON_THICKNESS, PYLON_HEIGHT, PYLON_THICKNESS);
    pylonGeometry.translate(0, PYLON_HEIGHT / 2, 0);
    this.pylons = new THREE.InstancedMesh(
      pylonGeometry,
      surfaceMaterial({ color: PYLON_COLOR }),
      gridSize * gridSize,
    );
    // Instance transforms live across the whole grid; the base geometry's
    // bounds would wrongly cull the mesh, so culling is disabled.
    this.pylons.frustumCulled = false;
    this.pylons.count = 0;
    scene.add(this.pylons);

    const cableGeometry = new THREE.BoxGeometry(1, CABLE_THICKNESS, CABLE_THICKNESS);
    this.cables = new THREE.InstancedMesh(
      cableGeometry,
      surfaceMaterial({ color: CABLE_COLOR }),
      gridSize * gridSize * 2,
    );
    // Instance transforms live across the whole grid; the base geometry's
    // bounds would wrongly cull the mesh, so culling is disabled.
    this.cables.frustumCulled = false;
    this.cables.count = 0;
    scene.add(this.cables);
  }

  applyDiffs(diffs: TileDiff[]): void {
    let changed = false;
    for (const diff of diffs) {
      if (this.masks[diff.index] !== diff.powerLine) {
        this.masks[diff.index] = diff.powerLine;
        changed = true;
      }
      if (this.tileTypes[diff.index] !== diff.tileType) {
        // The tile type only moves a pylon (kerb vs. centre): it matters
        // when the tile carries a line before or after the change.
        const hadLine = this.masks[diff.index] !== 0;
        this.tileTypes[diff.index] = diff.tileType;
        if (hadLine) changed = true;
      }
    }
    if (changed) this.rebuild();
  }

  /** World position of a tile's pylon (kerb on roads, centre elsewhere). */
  private pylonAt(index: number): { x: number; z: number; y: number } {
    const tx = index % this.gridSize;
    const tz = Math.floor(index / this.gridSize);
    const onRoad = this.tileTypes[index] === TileType.Road;
    const offset = onRoad ? KERB_OFFSET : 0.5;
    const x = tx + offset;
    const z = tz + offset;
    // The foot stands on the ground under it: on a slope the kerb corner
    // sits well above or below the tile's nominal level.
    return { x, z, y: this.elevation.surfaceY(x, z) };
  }

  private rebuild(): void {
    let pylonCount = 0;
    let cableCount = 0;
    for (let index = 0; index < this.masks.length; index++) {
      const mask = this.masks[index];
      if (mask === 0) continue;
      const here = this.pylonAt(index);
      this.dummy.position.set(here.x, here.y, here.z);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.set(1, 1, 1);
      this.dummy.updateMatrix();
      this.pylons.setMatrixAt(pylonCount++, this.dummy.matrix);

      const east = (mask & DIR_E) !== 0 ? index + 1 : -1;
      const south = (mask & DIR_S) !== 0 ? index + this.gridSize : -1;
      for (const neighbor of [east, south]) {
        if (neighbor < 0 || neighbor >= this.masks.length) continue;
        const there = this.pylonAt(neighbor);
        const dx = there.x - here.x;
        const dz = there.z - here.z;
        const length = Math.hypot(dx, dz, there.y - here.y);
        this.dummy.position.set(
          (here.x + there.x) / 2,
          (here.y + there.y) / 2 + PYLON_HEIGHT,
          (here.z + there.z) / 2,
        );
        this.dummy.rotation.set(0, -Math.atan2(dz, dx), 0);
        this.dummy.scale.set(length, 1, 1);
        this.dummy.updateMatrix();
        this.cables.setMatrixAt(cableCount++, this.dummy.matrix);
      }
    }
    this.pylons.count = pylonCount;
    this.cables.count = cableCount;
    this.pylons.instanceMatrix.needsUpdate = true;
    this.cables.instanceMatrix.needsUpdate = true;
  }
}
