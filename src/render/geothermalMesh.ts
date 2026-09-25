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
/** Below this delta, a night-factor change is not worth a steam rebuild. */
const NIGHT_FACTOR_EPSILON = 0.002;

/**
 * Hotspots: a vent cone per hotspot tile with a steam plume that drifts
 * upward. The plume's brightness follows the field's reservoir heat, so a
 * cooled field visibly stops steaming — the mechanic is readable from the
 * map, not only from the inspector.
 *
 * The cones never move once placed, so they only rebuild from
 * `applyDiffs`, like `forestMesh.ts`/`waterMesh.ts`'s static geometry. The
 * steam plume genuinely animates (its transform and fade depend on time),
 * so it rebuilds every frame while motion is enabled — but while reduced
 * motion is on, it rebuilds only when something it depends on (hotspot
 * set, reservoir heat, night factor) actually changed, so an idle map
 * does no per-frame GPU buffer uploads.
 */
export class GeothermalMesh implements DiffLayer {
  private readonly cones: THREE.InstancedMesh;
  private readonly steam: THREE.InstancedMesh;
  private readonly steamMaterial: THREE.MeshBasicMaterial;
  /** Tile index -> quantised reservoir heat, for every hotspot tile. */
  private readonly hotspots = new Map<number, number>();
  private readonly gridSize: number;
  private readonly matrix = new THREE.Matrix4();
  private readonly color = new THREE.Color();
  private nightFactor = 0;
  private reducedMotion = false;
  /** Set when the steam mesh must rebuild even with motion disabled. */
  private steamDirty = false;

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
    // Cones only move when a hotspot appears or disappears; heat-only
    // changes never touch them, so they are tracked separately from the
    // steam plume's dirtiness.
    let hotspotsChanged = false;
    for (const diff of diffs) {
      const previous = this.hotspots.get(diff.index);
      if (diff.geothermal === 0) {
        if (previous !== undefined) {
          this.hotspots.delete(diff.index);
          hotspotsChanged = true;
          this.steamDirty = true;
        }
        continue;
      }
      if (previous !== diff.reservoirHeat) {
        this.hotspots.set(diff.index, diff.reservoirHeat);
        if (previous === undefined) hotspotsChanged = true;
        this.steamDirty = true;
      }
    }
    if (hotspotsChanged) this.rebuildCones();
  }

  setEnvironment(environment: RenderEnvironment): void {
    if (Math.abs(environment.nightFactor - this.nightFactor) > NIGHT_FACTOR_EPSILON) {
      this.nightFactor = environment.nightFactor;
      this.steamDirty = true;
    }
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
  }

  update(_deltaSeconds: number, nowSeconds: number): void {
    if (this.hotspots.size === 0) {
      if (this.steam.count !== 0) {
        this.steam.count = 0;
        this.steam.instanceMatrix.needsUpdate = true;
      }
      this.steamDirty = false;
      return;
    }
    // Motion keeps the plume rising every frame; reduced motion freezes
    // it, so there is nothing to redraw unless something else changed.
    if (this.reducedMotion && !this.steamDirty) return;
    this.rebuildSteam(this.reducedMotion ? 0 : nowSeconds);
    this.steamDirty = false;
  }

  /** Place every vent cone. Static: only called when a hotspot appears or disappears. */
  private rebuildCones(): void {
    let count = 0;
    for (const index of this.hotspots.keys()) {
      const x = (index % this.gridSize) + 0.5;
      const z = Math.floor(index / this.gridSize) + 0.5;
      const groundY = this.elevation.centerY(index);
      this.matrix.identity();
      this.matrix.setPosition(x, groundY + CONE_HEIGHT / 2, z);
      this.cones.setMatrixAt(count, this.matrix);
      count++;
    }
    this.cones.count = count;
    this.cones.instanceMatrix.needsUpdate = true;
  }

  /** Place every steam plume; `time` drives its rise. */
  private rebuildSteam(time: number): void {
    let count = 0;
    for (const [index, heat] of this.hotspots) {
      const x = (index % this.gridSize) + 0.5;
      const z = Math.floor(index / this.gridSize) + 0.5;
      const groundY = this.elevation.centerY(index);

      // The plume loops from the vent upward and fades as it climbs.
      const phase = (time * STEAM_RISE_SPEED + index * 0.37) % 1;
      const scale = 0.6 + phase * 0.8;
      this.matrix.makeScale(scale, scale, scale);
      this.matrix.setPosition(x, groundY + CONE_HEIGHT + phase * STEAM_HEIGHT, z);
      this.steam.setMatrixAt(count, this.matrix);

      // Brightness carries both the reservoir heat and the plume's fade,
      // dimmed at night like the other environment-driven layers.
      const strength = (heat / 255) * (1 - phase * 0.6) * (1 - NIGHT_DIM * this.nightFactor);
      this.steam.setColorAt(count, this.color.copy(STEAM_COLOR).multiplyScalar(strength));
      count++;
    }
    this.steam.count = count;
    this.steam.instanceMatrix.needsUpdate = true;
    if (this.steam.instanceColor) this.steam.instanceColor.needsUpdate = true;
  }
}
