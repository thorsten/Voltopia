import * as THREE from 'three';
import type { PlantType, TileDiff } from '../shared/types.ts';
import { SupplyStatus, TileType } from '../shared/types.ts';
import { isSupplySource } from '../shared/plants.ts';
import type { DiffLayer } from './renderer.ts';
import type { ElevationField } from './elevationField.ts';

const MAX_ICONS = 512;
const ICON_SIZE = 0.55;
const ICON_HEIGHT = 2.15;
/** Undersupply flickers tick to tick; keep the icon up briefly instead. */
const LINGER_SECONDS = 2;

const COLOR_NOT_CONNECTED = new THREE.Color(0xe05263);
const COLOR_UNDERSUPPLIED = new THREE.Color(0xffb347);
/** Isolated supply plant: information, not an outage, so blue-grey. */
const COLOR_ISOLATED_PLANT = new THREE.Color(0x7fa7c9);

/** White lightning bolt on transparent ground, tinted per instance. */
function createBoltTexture(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 6;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(76, 8);
  ctx.lineTo(38, 72);
  ctx.lineTo(62, 72);
  ctx.lineTo(50, 120);
  ctx.lineTo(94, 52);
  ctx.lineTo(68, 52);
  ctx.closePath();
  ctx.stroke();
  ctx.fill();
  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 2;
  return texture;
}

interface IconEntry {
  status: SupplyStatus;
  /** Renderer clock time after which the icon disappears. */
  expiresAt: number;
  plant: boolean;
}

/**
 * Feedback in the world: a bobbing warning bolt floats above every
 * building with supply trouble (red = not connected, orange =
 * undersupplied). Icons billboard toward the camera.
 */
export class IconsMesh implements DiffLayer {
  private readonly mesh: THREE.InstancedMesh;
  private readonly camera: THREE.Camera;
  private readonly gridSize: number;
  private readonly icons = new Map<number, IconEntry>();
  private nowSeconds = 0;
  private reducedMotion = false;
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3(ICON_SIZE, ICON_SIZE, ICON_SIZE);

  constructor(
    scene: THREE.Scene,
    gridSize: number,
    camera: THREE.Camera,
    private readonly elevation: ElevationField,
  ) {
    this.gridSize = gridSize;
    this.camera = camera;
    const material = new THREE.MeshBasicMaterial({
      map: createBoltTexture(),
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), material, MAX_ICONS);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.count = 0;
    scene.add(this.mesh);
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
  }

  applyDiffs(diffs: TileDiff[]): void {
    for (const diff of diffs) {
      const isBuilding = diff.tileType === TileType.Empty && diff.density > 0;
      const isSupplyPlant =
        diff.tileType === TileType.Plant && isSupplySource(diff.plantType as PlantType);
      if (isSupplyPlant) {
        // A plant that serves nothing (no line, no building in its ring)
        // keeps a permanent marker; it clears the moment it serves again.
        if (diff.supplied === SupplyStatus.NotConnected) {
          this.icons.set(diff.index, {
            status: diff.supplied,
            expiresAt: Number.POSITIVE_INFINITY,
            plant: true,
          });
        } else {
          this.icons.delete(diff.index);
        }
        continue;
      }
      if (isBuilding && diff.supplied !== SupplyStatus.Supplied) {
        this.icons.set(diff.index, {
          status: diff.supplied,
          // Not-connected is a stable status; undersupply lingers so the
          // tick-level flicker does not strobe the icon.
          expiresAt:
            diff.supplied === SupplyStatus.NotConnected
              ? Number.POSITIVE_INFINITY
              : this.nowSeconds + LINGER_SECONDS,
          plant: false,
        });
      } else if (!isBuilding) {
        this.icons.delete(diff.index);
      } else if (this.icons.get(diff.index)?.status === SupplyStatus.NotConnected) {
        // Building became supplied/undersupplied again: drop stale
        // permanent icons, keep lingering ones until they expire.
        this.icons.delete(diff.index);
        if (diff.supplied === SupplyStatus.Undersupplied) {
          this.icons.set(diff.index, {
            status: diff.supplied,
            expiresAt: this.nowSeconds + LINGER_SECONDS,
            plant: false,
          });
        }
      }
    }
  }

  update(_deltaSeconds: number, nowSeconds: number): void {
    this.nowSeconds = nowSeconds;
    let slot = 0;
    for (const [index, entry] of this.icons) {
      if (entry.expiresAt < nowSeconds) {
        this.icons.delete(index);
        continue;
      }
      if (slot >= MAX_ICONS) break;
      const bob = this.reducedMotion ? 0 : Math.sin(nowSeconds * 3 + index * 0.7) * 0.07;
      this.position.set(
        (index % this.gridSize) + 0.5,
        ICON_HEIGHT + bob + this.elevation.centerY(index),
        Math.floor(index / this.gridSize) + 0.5,
      );
      this.matrix.compose(this.position, this.camera.quaternion, this.scale);
      this.mesh.setMatrixAt(slot, this.matrix);
      this.mesh.setColorAt(
        slot,
        entry.plant
          ? COLOR_ISOLATED_PLANT
          : entry.status === SupplyStatus.NotConnected
            ? COLOR_NOT_CONNECTED
            : COLOR_UNDERSUPPLIED,
      );
      slot++;
    }
    this.mesh.count = slot;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
