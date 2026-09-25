import * as THREE from 'three';
import type { TileDiff } from '../shared/types.ts';
import type { ElevationField } from './elevationField.ts';
import type { DiffLayer, RenderEnvironment } from './renderer.ts';

/** Fumarole cone: a small vent cone sitting on the ground. */
const CONE_RADIUS = 0.16;
const CONE_HEIGHT = 0.12;
const CONE_COLOR = 0x8c5a3c;
/** Steam plume above the vent. */
const STEAM_SIZE = 0.3;
const STEAM_HEIGHT = 0.45;
const STEAM_COLOR = new THREE.Color(0xe8eef0);
const STEAM_RISE_SPEED = 0.35;
const NIGHT_DIM = 0.45;

/**
 * Hotspots: a vent cone per hotspot tile with a steam plume that drifts
 * upward. The plume's brightness follows the field's reservoir heat, so a
 * cooled field visibly stops steaming — the mechanic is readable from the
 * map, not only from the inspector.
 */
export class GeothermalMesh implements DiffLayer {
  private readonly cones: THREE.InstancedMesh;
  private readonly steam: THREE.InstancedMesh;
  private readonly steamMaterial: THREE.MeshBasicMaterial;
  /** Tile index -> quantised reservoir heat, for every hotspot tile. */
  private readonly hotspots = new Map<number, number>();
  private readonly gridSize: number;
  private readonly matrix = new THREE.Matrix4();
  private nightFactor = 0;
  private reducedMotion = false;

  constructor(
    scene: THREE.Scene,
    gridSize: number,
    private readonly elevation: ElevationField,
  ) {
    this.gridSize = gridSize;
    const tiles = gridSize * gridSize;

    this.cones = new THREE.InstancedMesh(
      new THREE.ConeGeometry(CONE_RADIUS, CONE_HEIGHT, 6),
      new THREE.MeshLambertMaterial({ color: CONE_COLOR }),
      tiles,
    );
    // Instance transforms span the whole grid; the base geometry's bounds
    // would wrongly cull the mesh, so culling is disabled.
    this.cones.frustumCulled = false;
    this.cones.count = 0;
    scene.add(this.cones);

    this.steamMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    this.steam = new THREE.InstancedMesh(
      new THREE.SphereGeometry(STEAM_SIZE / 2, 8, 6),
      this.steamMaterial,
      tiles,
    );
    this.steam.frustumCulled = false;
    this.steam.count = 0;
    scene.add(this.steam);
  }

  applyDiffs(diffs: TileDiff[]): void {
    let changed = false;
    for (const diff of diffs) {
      const previous = this.hotspots.get(diff.index);
      if (diff.geothermal === 0) {
        if (previous !== undefined) {
          this.hotspots.delete(diff.index);
          changed = true;
        }
        continue;
      }
      if (previous !== diff.reservoirHeat) {
        this.hotspots.set(diff.index, diff.reservoirHeat);
        changed = true;
      }
    }
    if (changed) this.rebuild(0);
  }

  setEnvironment(environment: RenderEnvironment): void {
    this.nightFactor = environment.nightFactor;
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
  }

  update(_deltaSeconds: number, nowSeconds: number): void {
    this.rebuild(this.reducedMotion ? 0 : nowSeconds);
  }

  /** Place every vent and its plume; `time` drives the plume's rise. */
  private rebuild(time: number): void {
    const color = new THREE.Color();
    let count = 0;
    for (const [index, heat] of this.hotspots) {
      const x = (index % this.gridSize) + 0.5;
      const z = Math.floor(index / this.gridSize) + 0.5;
      const groundY = this.elevation.centerY(index);

      this.matrix.makeScale(1, 1, 1);
      this.matrix.setPosition(x, groundY + CONE_HEIGHT / 2, z);
      this.cones.setMatrixAt(count, this.matrix);

      // The plume loops from the vent upward and fades as it climbs.
      const phase = (time * STEAM_RISE_SPEED + index * 0.37) % 1;
      const scale = 0.6 + phase * 0.8;
      this.matrix.makeScale(scale, scale, scale);
      this.matrix.setPosition(x, groundY + CONE_HEIGHT + phase * STEAM_HEIGHT, z);
      this.steam.setMatrixAt(count, this.matrix);

      // Brightness carries both the reservoir heat and the plume's fade,
      // dimmed at night like the other environment-driven layers.
      const strength = (heat / 255) * (1 - phase * 0.6) * (1 - NIGHT_DIM * this.nightFactor);
      this.steam.setColorAt(count, color.copy(STEAM_COLOR).multiplyScalar(strength));
      count++;
    }
    this.cones.count = count;
    this.cones.instanceMatrix.needsUpdate = true;
    this.steam.count = count;
    this.steam.instanceMatrix.needsUpdate = true;
    if (this.steam.instanceColor) this.steam.instanceColor.needsUpdate = true;
  }
}
