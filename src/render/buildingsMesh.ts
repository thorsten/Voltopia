import * as THREE from 'three';
import type { TileDiff } from '../shared/types.ts';
import { HEATED_SERVED, SupplyStatus, TileType, Zone } from '../shared/types.ts';
import type { DiffLayer, RenderEnvironment } from './renderer.ts';
import type { ElevationField } from './elevationField.ts';
import { PART_KINDS, PartKind, createPartGeometry } from './buildings/primitives.ts';
import { applyAgeTint, applySupplyTint } from './buildings/palette.ts';
import { surfaceMaterial } from './materials.ts';
import {
  type BuildingPart,
  MAX_PARTS_PER_KIND,
  type StreetFace,
  buildingParts,
  faceOffset,
  streetFaceFor,
} from './buildings/recipes.ts';
import { BlockAllocator } from './buildings/blocks.ts';
import { type AccentSink, type AccentState, accentAnchors } from './buildings/accents.ts';
import { WINDOW_PROUD, windowGeometry } from './buildings/windows.ts';
import {
  WINDOWS_PER_TILE,
  WINDOW_HEIGHT,
  WINDOW_WIDTH,
  layoutWindows,
} from './buildings/windowLayout.ts';

const GROW_ANIMATION_SECONDS = 0.45;
const WINDOW_COLOR = 0xffc978;
/**
 * The night glow quad sits over the glass (2 × WINDOW_PROUD) but behind
 * the mullions (3 × WINDOW_PROUD), so the cross still reads at night.
 */
const GLOW_PROUD = 2.5 * WINDOW_PROUD;
const QUARTER_TURN = Math.PI / 2;
/** Where a foundation samples the ground under its footprint (fractions of the part size). */
const FOOTPRINT_SAMPLES = [-0.5, 0, 0.5] as const;
/** Hidden instances: a zero-scale matrix is never rasterised. */
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

function accentState(b: TileBuilding): AccentState {
  return { heated: b.heated, supplied: b.supplied, damaged: b.damaged };
}

/** Pitched roofs take the weathered patina; flat slabs are boxes and do not. */
export function isRoofKind(kind: PartKind): boolean {
  return kind === PartKind.GableRoof || kind === PartKind.HipRoof || kind === PartKind.ShedRoof;
}

interface TileBuilding {
  zone: Zone;
  density: number;
  variant: number;
  supplied: SupplyStatus;
  heated: boolean;
  damaged: boolean;
  /** TileDiff.ageStage: 0 new, 1 lived-in, 2 weathered. */
  ageStage: number;
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
  /** Framed windows (lit, visible day and night), one per laid-out window slot. */
  readonly windowFramesMesh: THREE.InstancedMesh;
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
  /** Scratch for the age tint, which feeds the supply tint. */
  private readonly agedColor = new THREE.Color();
  /** Reusable per-kind slot cursor for `writeMatrices`/`writeColors` — avoids a Map per call. */
  private readonly cursor = new Int32Array(PART_KINDS.length);
  /** Reusable set of kinds touched by one writeMatrices/writeColors call. */
  private readonly touchedKinds = new Set<PartKind>();
  /** Reusable window instance scale (z stays 1: WINDOW_PROUD is in world units). */
  private readonly frameScale = new THREE.Vector3();

  constructor(
    scene: THREE.Scene,
    gridSize: number,
    private readonly elevation: ElevationField,
    /** Optional receiver of effect anchors (stage 2 accents). */
    private readonly accents?: AccentSink,
  ) {
    this.gridSize = gridSize;
    this.roads = new Uint8Array(gridSize * gridSize);
    this.layers = PART_KINDS.map((kind) => {
      const blockSize = MAX_PARTS_PER_KIND[kind];
      const mesh = new THREE.InstancedMesh(
        createPartGeometry(kind),
        surfaceMaterial(),
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

    const glowGeometry = new THREE.PlaneGeometry(WINDOW_WIDTH, WINDOW_HEIGHT);
    this.windowsMaterial = new THREE.MeshBasicMaterial({
      color: WINDOW_COLOR,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.windowsMesh = new THREE.InstancedMesh(
      glowGeometry,
      this.windowsMaterial,
      gridSize * gridSize * WINDOWS_PER_TILE,
    );
    this.windowsMesh.frustumCulled = false;
    this.windowsMesh.count = 0;
    this.windowsMesh.visible = false;
    scene.add(this.windowsMesh);

    this.windowFramesMesh = new THREE.InstancedMesh(
      windowGeometry(),
      surfaceMaterial({ vertexColors: true }),
      gridSize * gridSize * WINDOWS_PER_TILE,
    );
    // Same as the kind meshes: instances span the grid, so never cull.
    this.windowFramesMesh.frustumCulled = false;
    this.windowFramesMesh.castShadow = false;
    this.windowFramesMesh.receiveShadow = true;
    this.windowFramesMesh.count = 0;
    scene.add(this.windowFramesMesh);
  }

  /** Street face of the building on `index`, for tests and debugging. */
  streetFaceAt(index: number): StreetFace | undefined {
    return this.buildings.get(index)?.face;
  }

  /** Recipe parts of the building on `index`, for tests and debugging. */
  partsAt(index: number): readonly BuildingPart[] | undefined {
    return this.buildings.get(index)?.parts;
  }

  /** Number of lit window quads currently laid out, for tests. */
  windowCount(): number {
    return this.windowsMesh.count;
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
    if (reduced && this.animations.size > 0) {
      for (const index of this.animations.keys()) this.writeMatrices(index, 1);
      this.animations.clear();
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
    for (const diff of diffs) {
      const isRoad = diff.tileType === TileType.Road ? 1 : 0;
      if (this.roads[diff.index] !== isRoad) {
        this.roads[diff.index] = isRoad;
        for (const n of this.neighbours(diff.index)) if (this.buildings.has(n)) reissue.add(n);
      }
      const hasBuilding = diff.tileType === TileType.Empty && diff.density > 0;
      const existing = this.buildings.get(diff.index);
      // Diffs built in tests may omit these fields; normalise to booleans.
      // `diff.heated` is HEATED_NONE/HEATED_TRUNK/HEATED_SERVED (see
      // shared/types.ts); only a served building counts as heated here.
      const heated = diff.heated === HEATED_SERVED;
      const damaged = (diff.damage ?? 0) > 0;
      const ageStage = diff.ageStage ?? 0;
      if (hasBuilding) {
        if (
          !existing ||
          existing.density !== diff.density ||
          existing.zone !== diff.zone ||
          existing.variant !== diff.variant
        ) {
          this.place(
            diff.index,
            diff.zone,
            diff.density,
            diff.variant,
            diff.supplied,
            heated,
            damaged,
            ageStage,
            true,
          );
          reissue.delete(diff.index);
          windowsDirty = true;
        } else {
          const supplyFlip = existing.supplied !== diff.supplied;
          const ageFlip = existing.ageStage !== ageStage;
          existing.supplied = diff.supplied;
          existing.ageStage = ageStage;
          // Supply and age flips are colour-only; a supply flip also dims the windows.
          if (supplyFlip || ageFlip) this.writeColors(diff.index);
          if (supplyFlip) windowsDirty = true;
          if (supplyFlip || existing.heated !== heated || existing.damaged !== damaged) {
            existing.heated = heated;
            existing.damaged = damaged;
            this.accents?.setState(diff.index, accentState(existing));
          }
        }
      } else if (existing) {
        this.remove(diff.index);
        reissue.delete(diff.index);
        windowsDirty = true;
      }
    }
    for (const index of reissue) {
      const b = this.buildings.get(index)!;
      if (this.streetFace(index) !== b.face) {
        this.place(
          index,
          b.zone,
          b.density,
          b.variant,
          b.supplied,
          b.heated,
          b.damaged,
          b.ageStage,
          false,
        );
        windowsDirty = true;
      }
    }
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
        this.writeMatrices(index, this.growthAt(next));
      }
    }
  }

  /** Ease-out cubic scale-in, shared by `update()` and `place()`. */
  private growthAt(elapsedSeconds: number): number {
    const t = elapsedSeconds / GROW_ANIMATION_SECONDS;
    return 1 - Math.pow(1 - t, 3);
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
    heated: boolean,
    damaged: boolean,
    ageStage: number,
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
        heated,
        damaged,
        ageStage,
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
      building.heated = heated;
      building.damaged = damaged;
      building.ageStage = ageStage;
      building.face = face;
      building.parts = parts;
    }
    this.hideUnusedSlots(building);
    if (animate && !this.reducedMotion) {
      this.animations.set(index, 0);
      this.writeMatrices(index, 0.01);
    } else {
      // A re-issue (e.g. a road laid beside a still-growing building, or a
      // road arriving in the same diff batch as the building) must not
      // snap an in-progress grow animation to full size: keep the existing
      // animation entry and resume at its current progress.
      const elapsed = this.animations.get(index);
      if (elapsed === undefined) {
        this.writeMatrices(index, 1);
      } else {
        this.writeMatrices(index, Math.max(0.01, this.growthAt(elapsed)));
      }
    }
    this.writeColors(index);
    this.publishAnchors(index, building);
  }

  /** Hand the role-tagged parts' world anchors to the effects sink. */
  private publishAnchors(index: number, building: TileBuilding): void {
    if (!this.accents) return;
    const cx = (index % this.gridSize) + 0.5;
    const cz = Math.floor(index / this.gridSize) + 0.5;
    const anchors = accentAnchors(building.parts, cx, cz, this.elevation.centerY(index));
    if (anchors.length > 0) this.accents.set(index, anchors, accentState(building));
    else this.accents.remove(index);
  }

  private remove(index: number): void {
    const building = this.buildings.get(index);
    if (!building) return;
    for (const kind of PART_KINDS) {
      const layer = this.layers[kind];
      const start = building.blocks[kind] * layer.blockSize;
      for (let i = 0; i < layer.blockSize; i++) layer.mesh.setMatrixAt(start + i, HIDDEN);
      this.touchMatrixRange(kind, building.blocks[kind]);
      layer.blocks.release(building.blocks[kind]);
    }
    this.buildings.delete(index);
    this.animations.delete(index);
    this.accents?.remove(index);
    this.syncCounts();
  }

  /** Draw exactly up to the highest block in use per kind. */
  private syncCounts(): void {
    for (const layer of this.layers) layer.mesh.count = layer.blocks.highWater * layer.blockSize;
  }

  /**
   * Flag only `block`'s own slots (not the whole buffer) for re-upload.
   * three.js clears `updateRanges` once it has uploaded them.
   */
  private touchMatrixRange(kind: PartKind, block: number): void {
    const layer = this.layers[kind];
    const itemSize = layer.mesh.instanceMatrix.itemSize;
    layer.mesh.instanceMatrix.addUpdateRange(
      block * layer.blockSize * itemSize,
      layer.blockSize * itemSize,
    );
    layer.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Same as `touchMatrixRange`, for the per-instance colour attribute. */
  private touchColorRange(kind: PartKind, block: number): void {
    const layer = this.layers[kind];
    const colorAttr = layer.mesh.instanceColor;
    if (!colorAttr) return;
    const itemSize = colorAttr.itemSize;
    colorAttr.addUpdateRange(block * layer.blockSize * itemSize, layer.blockSize * itemSize);
    colorAttr.needsUpdate = true;
  }

  /**
   * Hide a block's unused tail slots per kind (a re-issued recipe may have
   * fewer parts than the block holds). Slots are stable across growth, so
   * this runs once per `place()` rather than on every matrix write.
   */
  private hideUnusedSlots(building: TileBuilding): void {
    this.cursor.fill(0);
    for (const p of building.parts) this.cursor[p.kind]++;
    for (const kind of PART_KINDS) {
      const layer = this.layers[kind];
      const start = building.blocks[kind] * layer.blockSize;
      const end = start + layer.blockSize;
      for (let slot = start + this.cursor[kind]; slot < end; slot++) {
        layer.mesh.setMatrixAt(slot, HIDDEN);
      }
      this.touchMatrixRange(kind, building.blocks[kind]);
    }
  }

  /** Reset the reusable per-kind slot cursor to the start of the tile's blocks. */
  private resetCursor(building: TileBuilding): void {
    for (const kind of PART_KINDS) {
      this.cursor[kind] = building.blocks[kind] * this.layers[kind].blockSize;
    }
  }

  private writeMatrices(index: number, growth: number): void {
    const building = this.buildings.get(index);
    if (!building) return;
    const cx = (index % this.gridSize) + 0.5;
    const cz = Math.floor(index / this.gridSize) + 0.5;
    const lift = this.elevation.centerY(index);
    this.resetCursor(building);
    this.touchedKinds.clear();
    for (const p of building.parts) {
      const slot = this.cursor[p.kind]++;
      let baseY = p.oy;
      let sizeY = p.sy;
      if (p.oy === 0 && p.tilt === undefined) {
        // Foundation: a part that stands on the ground keeps its top but
        // drops its bottom to the lowest ground under its footprint, so
        // nothing floats on the downhill side of a sloped tile (the uphill
        // side simply sinks in). Same rule as plantsMesh.ts.
        baseY = Math.min(0, this.lowestGroundUnder(cx + p.ox, cz + p.oz, p) - lift);
        sizeY = p.sy - baseY;
      }
      this.position.set(cx + p.ox * growth, lift + baseY * growth, cz + p.oz * growth);
      this.euler.set(p.tilt ?? 0, p.turn * QUARTER_TURN, 0, 'YXZ');
      this.quaternion.setFromEuler(this.euler);
      this.scale.set(p.sx * growth, sizeY * growth, p.sz * growth);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.layers[p.kind].mesh.setMatrixAt(slot, this.matrix);
      this.touchedKinds.add(p.kind);
    }
    for (const kind of this.touchedKinds) this.touchMatrixRange(kind, building.blocks[kind]);
  }

  /** Lowest ground height under a part's (turned) footprint, sampled on a 3x3 lattice. */
  private lowestGroundUnder(x: number, z: number, p: BuildingPart): number {
    const [fx, fz] = p.turn % 2 === 0 ? [p.sx, p.sz] : [p.sz, p.sx];
    const max = this.gridSize - 1e-6;
    let lowest = Infinity;
    for (const ax of FOOTPRINT_SAMPLES) {
      for (const az of FOOTPRINT_SAMPLES) {
        const px = Math.min(max, Math.max(0, x + ax * fx));
        const pz = Math.min(max, Math.max(0, z + az * fz));
        lowest = Math.min(lowest, this.elevation.surfaceY(px, pz));
      }
    }
    return lowest;
  }

  private writeColors(index: number): void {
    const building = this.buildings.get(index);
    if (!building) return;
    this.resetCursor(building);
    this.touchedKinds.clear();
    for (const p of building.parts) {
      const slot = this.cursor[p.kind]++;
      const color = p.accent
        ? p.color
        : applySupplyTint(
            applyAgeTint(
              p.color,
              building.ageStage,
              // A ridge cap is a box but weathers with the roof it sits on.
              isRoofKind(p.kind) || p.detail === 'ridge',
              this.agedColor,
            ),
            building.supplied,
            this.color,
          );
      this.layers[p.kind].mesh.setColorAt(slot, color);
      this.touchedKinds.add(p.kind);
    }
    for (const kind of this.touchedKinds) this.touchColorRange(kind, building.blocks[kind]);
  }

  /**
   * Framed windows from `layoutWindows` (street face and its opposite of
   * the main body and any window-carrying secondary bodies); shops get one
   * wide framed shopfront on the street face. Supplied buildings add a
   * night glow quad over the glass of each lit window; a deterministic
   * pattern keeps ~1/3 dark.
   */
  private rebuildWindows(): void {
    const matrix = new THREE.Matrix4();
    const rotation = new THREE.Matrix4();
    let slot = 0;
    let glowSlot = 0;
    const capacity = this.windowFramesMesh.instanceMatrix.count;
    for (const [index, building] of this.buildings) {
      // Buildings without (enough) power keep their frames but stay dark —
      // undersupply flips tick to tick, which reads as flickering at night.
      const lit = building.supplied === SupplyStatus.Supplied;
      const cx = (index % this.gridSize) + 0.5;
      const cz = Math.floor(index / this.gridSize) + 0.5;
      const lift = this.elevation.centerY(index);
      // layoutWindows caps each building at WINDOWS_PER_TILE, the slots
      // reserved per tile, so the capacity check is only a safety net.
      for (const w of layoutWindows(
        building.parts,
        building.face,
        building.zone,
        building.density,
      )) {
        if (slot >= capacity) break;
        // Deterministically leave ~1/3 of windows dark (framed, no glow).
        const dark = !w.shopfront && (index * 7 + w.id * 13 + building.variant) % 3 === 0;
        rotation.makeRotationY(w.face * QUARTER_TURN);
        matrix.copy(rotation);
        matrix.scale(this.frameScale.set(w.width, w.height, 1));
        matrix.setPosition(cx + w.x, lift + w.y - w.height / 2, cz + w.z);
        this.windowFramesMesh.setMatrixAt(slot++, matrix);
        if (lit && !dark) {
          const [gx, gz] = faceOffset(0, GLOW_PROUD, w.face);
          matrix.copy(rotation);
          matrix.scale(this.frameScale.set(w.width / WINDOW_WIDTH, w.height / WINDOW_HEIGHT, 1));
          matrix.setPosition(cx + w.x + gx, lift + w.y, cz + w.z + gz);
          this.windowsMesh.setMatrixAt(glowSlot++, matrix);
        }
      }
    }
    this.windowFramesMesh.count = slot;
    this.windowFramesMesh.instanceMatrix.needsUpdate = true;
    this.windowsMesh.count = glowSlot;
    this.windowsMesh.instanceMatrix.needsUpdate = true;
  }
}
