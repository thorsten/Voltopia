import * as THREE from 'three';
import type { TileDiff } from '../shared/types.ts';
import { SupplyStatus, TileType, type Zone } from '../shared/types.ts';
import type { DiffLayer, RenderEnvironment } from './renderer.ts';
import type { ElevationField } from './elevationField.ts';
import { PART_KINDS, type PartKind, createPartGeometry } from './buildings/primitives.ts';
import { applySupplyTint } from './buildings/palette.ts';
import {
  type BuildingPart,
  MAX_PARTS_PER_KIND,
  type StreetFace,
  buildingParts,
  mainBody,
  streetFaceFor,
} from './buildings/recipes.ts';
import { BlockAllocator } from './buildings/blocks.ts';

const GROW_ANIMATION_SECONDS = 0.45;
/** Max lit window quads per building. */
const WINDOWS_PER_TILE = 24;
const WINDOW_COLOR = 0xffc978;
const WINDOW_WIDTH = 0.09;
const WINDOW_HEIGHT = 0.11;
const WINDOW_GAP = 0.012;
const QUARTER_TURN = Math.PI / 2;
/** Hidden instances: a zero-scale matrix is never rasterised. */
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

interface TileBuilding {
  zone: Zone;
  density: number;
  variant: number;
  supplied: SupplyStatus;
  face: StreetFace;
  parts: BuildingPart[];
  /** Block per primitive kind (index = PartKind). */
  blocks: number[];
}

interface KindLayer {
  mesh: THREE.InstancedMesh;
  blockSize: number;
  blocks: BlockAllocator;
}

/**
 * All zone buildings as one InstancedMesh per primitive kind with
 * per-instance colours. Each tile owns one fixed-size block of slots per
 * kind, so a change touches only that tile. New/densified buildings scale
 * in with a short animation; doors and awnings face the nearest road.
 */
export class BuildingsMesh implements DiffLayer {
  readonly kindMeshes: readonly THREE.InstancedMesh[];
  private readonly layers: readonly KindLayer[];
  private readonly windowsMesh: THREE.InstancedMesh;
  private readonly windowsMaterial: THREE.MeshBasicMaterial;
  private readonly gridSize: number;
  private readonly roads: Uint8Array;
  private readonly buildings = new Map<number, TileBuilding>();
  private readonly animations = new Map<number, number>(); // tile -> elapsed seconds
  private reducedMotion = false;
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly scale = new THREE.Vector3();
  private readonly color = new THREE.Color();

  constructor(
    scene: THREE.Scene,
    gridSize: number,
    private readonly elevation: ElevationField,
  ) {
    this.gridSize = gridSize;
    this.roads = new Uint8Array(gridSize * gridSize);
    this.layers = PART_KINDS.map((kind) => {
      const blockSize = MAX_PARTS_PER_KIND[kind];
      const mesh = new THREE.InstancedMesh(
        createPartGeometry(kind),
        new THREE.MeshLambertMaterial(),
        gridSize * gridSize * blockSize,
      );
      // Instance transforms live across the whole grid; the base geometry's
      // bounds would wrongly cull the mesh, so culling is disabled.
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.count = 0;
      scene.add(mesh);
      return { mesh, blockSize, blocks: new BlockAllocator(gridSize * gridSize) };
    });
    this.kindMeshes = this.layers.map((layer) => layer.mesh);

    const windowGeometry = new THREE.PlaneGeometry(WINDOW_WIDTH, WINDOW_HEIGHT);
    this.windowsMaterial = new THREE.MeshBasicMaterial({
      color: WINDOW_COLOR,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.windowsMesh = new THREE.InstancedMesh(
      windowGeometry,
      this.windowsMaterial,
      gridSize * gridSize * WINDOWS_PER_TILE,
    );
    this.windowsMesh.frustumCulled = false;
    this.windowsMesh.count = 0;
    this.windowsMesh.visible = false;
    scene.add(this.windowsMesh);
  }

  /** Street face of the building on `index`, for tests and debugging. */
  streetFaceAt(index: number): StreetFace | undefined {
    return this.buildings.get(index)?.face;
  }

  /** Recipe parts of the building on `index`, for tests and debugging. */
  partsAt(index: number): readonly BuildingPart[] | undefined {
    return this.buildings.get(index)?.parts;
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
    if (reduced && this.animations.size > 0) {
      for (const index of this.animations.keys()) this.writeMatrices(index, 1);
      this.animations.clear();
      this.markMatricesDirty();
    }
  }

  /** Warm window lights fade in with the night. */
  setEnvironment(environment: RenderEnvironment): void {
    const opacity = Math.max(0, environment.nightFactor - 0.25) / 0.75;
    this.windowsMaterial.opacity = opacity * 0.95;
    this.windowsMesh.visible = opacity > 0.02;
  }

  applyDiffs(diffs: TileDiff[]): void {
    const reissue = new Set<number>();
    let windowsDirty = false;
    let matricesDirty = false;
    let colorsDirty = false;
    for (const diff of diffs) {
      const isRoad = diff.tileType === TileType.Road ? 1 : 0;
      if (this.roads[diff.index] !== isRoad) {
        this.roads[diff.index] = isRoad;
        for (const n of this.neighbours(diff.index)) if (this.buildings.has(n)) reissue.add(n);
      }
      const hasBuilding = diff.tileType === TileType.Empty && diff.density > 0;
      const existing = this.buildings.get(diff.index);
      if (hasBuilding) {
        if (
          !existing ||
          existing.density !== diff.density ||
          existing.zone !== diff.zone ||
          existing.variant !== diff.variant
        ) {
          this.place(diff.index, diff.zone, diff.density, diff.variant, diff.supplied, true);
          reissue.delete(diff.index);
          windowsDirty = matricesDirty = colorsDirty = true;
        } else if (existing.supplied !== diff.supplied) {
          // Supply flips tint the body and dim the windows; no grow animation.
          existing.supplied = diff.supplied;
          this.writeColors(diff.index);
          windowsDirty = colorsDirty = true;
        }
      } else if (existing) {
        this.remove(diff.index);
        reissue.delete(diff.index);
        windowsDirty = matricesDirty = true;
      }
    }
    for (const index of reissue) {
      const b = this.buildings.get(index)!;
      if (this.streetFace(index) !== b.face) {
        this.place(index, b.zone, b.density, b.variant, b.supplied, false);
        windowsDirty = matricesDirty = colorsDirty = true;
      }
    }
    if (matricesDirty) this.markMatricesDirty();
    if (colorsDirty) this.markColorsDirty();
    if (windowsDirty) this.rebuildWindows();
  }

  update(deltaSeconds: number): void {
    if (this.animations.size === 0) return;
    for (const [index, elapsed] of this.animations) {
      const next = elapsed + deltaSeconds;
      if (next >= GROW_ANIMATION_SECONDS) {
        this.animations.delete(index);
        this.writeMatrices(index, 1);
      } else {
        this.animations.set(index, next);
        // Ease-out cubic for a satisfying pop-in.
        const t = next / GROW_ANIMATION_SECONDS;
        this.writeMatrices(index, 1 - Math.pow(1 - t, 3));
      }
    }
    this.markMatricesDirty();
  }

  private *neighbours(index: number): Generator<number> {
    const x = index % this.gridSize;
    const z = Math.floor(index / this.gridSize);
    if (z + 1 < this.gridSize) yield index + this.gridSize;
    if (x + 1 < this.gridSize) yield index + 1;
    if (x > 0) yield index - 1;
    if (z > 0) yield index - this.gridSize;
  }

  private streetFace(index: number): StreetFace {
    return streetFaceFor(index, this.gridSize, (i) => this.roads[i] === 1);
  }

  /** Create or re-issue the building on `index`; `animate` starts the grow-in. */
  private place(
    index: number,
    zone: Zone,
    density: number,
    variant: number,
    supplied: SupplyStatus,
    animate: boolean,
  ): void {
    const face = this.streetFace(index);
    const parts = buildingParts(zone, density, variant, index, face);
    let building = this.buildings.get(index);
    if (!building) {
      building = {
        zone,
        density,
        variant,
        supplied,
        face,
        parts,
        blocks: this.layers.map((layer) => layer.blocks.alloc()),
      };
      this.buildings.set(index, building);
      this.syncCounts();
    } else {
      building.zone = zone;
      building.density = density;
      building.variant = variant;
      building.supplied = supplied;
      building.face = face;
      building.parts = parts;
    }
    if (animate && !this.reducedMotion) {
      this.animations.set(index, 0);
      this.writeMatrices(index, 0.01);
    } else {
      this.animations.delete(index);
      this.writeMatrices(index, 1);
    }
    this.writeColors(index);
  }

  private remove(index: number): void {
    const building = this.buildings.get(index);
    if (!building) return;
    for (const kind of PART_KINDS) {
      const layer = this.layers[kind];
      const start = building.blocks[kind] * layer.blockSize;
      for (let i = 0; i < layer.blockSize; i++) layer.mesh.setMatrixAt(start + i, HIDDEN);
      layer.blocks.release(building.blocks[kind]);
    }
    this.buildings.delete(index);
    this.animations.delete(index);
    this.syncCounts();
  }

  /** Draw exactly up to the highest block in use per kind. */
  private syncCounts(): void {
    for (const layer of this.layers) layer.mesh.count = layer.blocks.highWater * layer.blockSize;
  }

  private markMatricesDirty(): void {
    for (const layer of this.layers) layer.mesh.instanceMatrix.needsUpdate = true;
  }

  private markColorsDirty(): void {
    for (const layer of this.layers) {
      if (layer.mesh.instanceColor) layer.mesh.instanceColor.needsUpdate = true;
    }
  }

  /** Slot of the i-th part of `kind` within the tile's block for that kind. */
  private slotsOf(building: TileBuilding): Map<PartKind, number> {
    const next = new Map<PartKind, number>();
    for (const kind of PART_KINDS) {
      next.set(kind, building.blocks[kind] * this.layers[kind].blockSize);
    }
    return next;
  }

  private writeMatrices(index: number, growth: number): void {
    const building = this.buildings.get(index);
    if (!building) return;
    const cx = (index % this.gridSize) + 0.5;
    const cz = Math.floor(index / this.gridSize) + 0.5;
    const lift = this.elevation.centerY(index);
    const next = this.slotsOf(building);
    for (const p of building.parts) {
      const slot = next.get(p.kind)!;
      next.set(p.kind, slot + 1);
      this.position.set(cx + p.ox * growth, lift + p.oy * growth, cz + p.oz * growth);
      this.euler.set(p.tilt ?? 0, p.turn * QUARTER_TURN, 0, 'YXZ');
      this.quaternion.setFromEuler(this.euler);
      this.scale.set(p.sx * growth, p.sy * growth, p.sz * growth);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.layers[p.kind].mesh.setMatrixAt(slot, this.matrix);
    }
    // Hide the block's unused slots (a re-issued recipe may have fewer parts).
    for (const kind of PART_KINDS) {
      const layer = this.layers[kind];
      const end = (building.blocks[kind] + 1) * layer.blockSize;
      for (let slot = next.get(kind)!; slot < end; slot++) layer.mesh.setMatrixAt(slot, HIDDEN);
    }
  }

  private writeColors(index: number): void {
    const building = this.buildings.get(index);
    if (!building) return;
    const next = this.slotsOf(building);
    for (const p of building.parts) {
      const slot = next.get(p.kind)!;
      next.set(p.kind, slot + 1);
      const color = p.accent ? p.color : applySupplyTint(p.color, building.supplied, this.color);
      this.layers[p.kind].mesh.setColorAt(slot, color);
    }
  }

  /**
   * Lit window quads on the ±z faces of each building's main body. A
   * deterministic pattern keeps some windows dark for variety. (Task 8
   * moves these onto the street face and its opposite.)
   */
  private rebuildWindows(): void {
    const matrix = new THREE.Matrix4();
    const rotationBack = new THREE.Matrix4().makeRotationY(Math.PI);
    let slot = 0;
    for (const [index, building] of this.buildings) {
      // Buildings without (enough) power stay dark — undersupply flips
      // tick to tick, which reads as flickering at night.
      if (building.supplied !== SupplyStatus.Supplied) continue;
      const main = mainBody(building.parts);
      if (!main) continue;
      const cx = (index % this.gridSize) + 0.5 + main.ox;
      const cz = Math.floor(index / this.gridSize) + 0.5 + main.oz;
      const lift = this.elevation.centerY(index);
      const cols = Math.min(3, Math.max(1, Math.round(main.sx / 0.24)));
      const rows = Math.min(4, Math.max(1, Math.round(main.sy / 0.28)));
      let windowId = 0;
      for (const face of [1, -1]) {
        for (let col = 0; col < cols; col++) {
          for (let row = 0; row < rows; row++) {
            windowId++;
            // Deterministically leave ~1/3 of windows dark.
            if ((index * 7 + windowId * 13 + building.variant) % 3 === 0) continue;
            if (slot >= this.windowsMesh.instanceMatrix.count) break;
            const x = cx + ((col + 0.5) / cols - 0.5) * main.sx * 0.8;
            const y = main.oy + ((row + 0.55) / rows) * main.sy * 0.82 + lift;
            const z = cz + face * (main.sz / 2 + WINDOW_GAP);
            if (face === 1) matrix.identity();
            else matrix.copy(rotationBack);
            matrix.setPosition(x, y, z);
            this.windowsMesh.setMatrixAt(slot++, matrix);
          }
        }
      }
    }
    this.windowsMesh.count = slot;
    this.windowsMesh.instanceMatrix.needsUpdate = true;
  }
}
