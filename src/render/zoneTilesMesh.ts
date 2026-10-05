import * as THREE from 'three';
import type { TileDiff } from '../shared/types.ts';
import { TileType, Zone } from '../shared/types.ts';
import type { DiffLayer } from './renderer.ts';
import type { ElevationField } from './elevationField.ts';
import { composePrismOnGround, createHalfTilePrism } from './decal.ts';

/** Footprint of the tint within its tile, its slab thickness and lift above the ground. */
const ZONE_SIZE = 0.92;
const ZONE_THICKNESS = 0.01;
const ZONE_LIFT = 0.04;

const ZONE_TINTS: Record<number, THREE.Color> = {
  [Zone.Residential]: new THREE.Color(0x67c26b),
  [Zone.Commercial]: new THREE.Color(0x5b8fd6),
  [Zone.Retail]: new THREE.Color(0xd6815b),
  [Zone.Industrial]: new THREE.Color(0xb3a06a),
};

/**
 * Translucent tint on zoned-but-unbuilt tiles so painted zones are
 * visible before buildings appear.
 */
export class ZoneTilesMesh implements DiffLayer {
  readonly mesh: THREE.InstancedMesh;
  private readonly zones = new Map<number, Zone>();
  private readonly matrix = new THREE.Matrix4();

  constructor(
    scene: THREE.Scene,
    gridSize: number,
    private readonly elevation: ElevationField,
  ) {
    // Two prisms per tile, each flush with one ground triangle (see decal.ts).
    const geometry = createHalfTilePrism();
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
    });
    this.mesh = new THREE.InstancedMesh(geometry, material, gridSize * gridSize * 2);
    // Instance transforms live across the whole grid; the base geometry's
    // bounds would wrongly cull the mesh, so culling is disabled.
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    scene.add(this.mesh);
  }

  applyDiffs(diffs: TileDiff[]): void {
    let changed = false;
    for (const diff of diffs) {
      const showTint =
        diff.tileType === TileType.Empty && diff.zone !== Zone.None && diff.density === 0;
      if (showTint) {
        if (this.zones.get(diff.index) !== diff.zone) {
          this.zones.set(diff.index, diff.zone);
          changed = true;
        }
      } else if (this.zones.has(diff.index)) {
        this.zones.delete(diff.index);
        changed = true;
      }
    }
    if (changed) this.rebuild();
  }

  private rebuild(): void {
    let slot = 0;
    for (const [index, zone] of this.zones) {
      for (const high of [false, true]) {
        composePrismOnGround(
          this.matrix,
          this.elevation,
          index,
          high,
          ZONE_SIZE,
          ZONE_THICKNESS,
          ZONE_LIFT,
        );
        this.mesh.setMatrixAt(slot, this.matrix);
        this.mesh.setColorAt(slot, ZONE_TINTS[zone] ?? new THREE.Color(0xffffff));
        slot++;
      }
    }
    this.mesh.count = slot;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
