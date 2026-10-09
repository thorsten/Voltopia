import * as THREE from 'three';
import type { TileDiff } from '../shared/types.ts';
import { HEATED_SERVED, SupplyStatus, TileType, Zone } from '../shared/types.ts';
import type { DiffLayer, RenderEnvironment } from './renderer.ts';
import type { ElevationField } from './elevationField.ts';
import { PART_KINDS, PartKind, createPartGeometry } from './buildings/primitives.ts';
import { ACCENT, applyAgeTint, applySupplyTint } from './buildings/palette.ts';
import { surfaceMaterial } from './materials.ts';
import {
  DOOR,
  PLINTH_HEIGHT,
  type BuildingPart,
  MAX_PARTS_PER_KIND,
  type StreetFace,
  buildingParts,
  faceDepth,
  faceOffset,
  faceWidth,
  mainBody,
  streetFaceFor,
} from './buildings/recipes.ts';
import { BlockAllocator } from './buildings/blocks.ts';
import { type AccentSink, type AccentState, accentAnchors } from './buildings/accents.ts';
import {
  WINDOW_FRAME_SCALE,
  WINDOW_PROUD,
  WINDOW_SILL_DROP,
  windowGeometry,
} from './buildings/windows.ts';

const GROW_ANIMATION_SECONDS = 0.45;
/**
 * Max window slots (framed windows, lit or dark) per building: 3 columns ×
 * 4 rows on two faces. Glow quads are a subset, so both meshes share it.
 */
const WINDOWS_PER_TILE = 24;
const WINDOW_COLOR = 0xffc978;
const WINDOW_WIDTH = 0.09;
const WINDOW_HEIGHT = 0.11;
/**
 * The night glow quad sits over the glass (2 × WINDOW_PROUD) but behind
 * the mullions (3 × WINDOW_PROUD), so the cross still reads at night.
 */
const GLOW_PROUD = 2.5 * WINDOW_PROUD;
/** Visible window width: the frame, not the glass. */
const FRAME_WIDTH = WINDOW_FRAME_SCALE * WINDOW_WIDTH;
/** Top of the retail shopfront glass as a fraction of body height; below the 0.6h awning. */
const SHOPFRONT_TOP_FRACTION = 0.55;
/** Preferred bottom of the shopfront glass; raised when its sill would sink into the plinth. */
const SHOPFRONT_BOTTOM_FRACTION = 0.12;
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
  /** Reusable scale vector for the per-shopfront window quad in `rebuildWindows`. */
  private readonly shopfrontScale = new THREE.Vector3();
  /** Scale of a regular window frame instance (z stays 1: WINDOW_PROUD is in world units). */
  private readonly frameScale = new THREE.Vector3(WINDOW_WIDTH, WINDOW_HEIGHT, 1);

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
   * Framed windows on the street face and its opposite of each building's
   * main body, mounted on the facade; shops get one wide framed shopfront
   * on the street face. Supplied buildings add a night glow quad over the
   * glass of each lit window; a deterministic pattern keeps ~1/3 dark.
   */
  private rebuildWindows(): void {
    const matrix = new THREE.Matrix4();
    const rotation = new THREE.Matrix4();
    let slot = 0;
    let glowSlot = 0;
    const capacity = this.windowFramesMesh.instanceMatrix.count;
    for (const [index, building] of this.buildings) {
      const main = mainBody(building.parts);
      if (!main) continue;
      // Buildings without (enough) power keep their frames but stay dark —
      // undersupply flips tick to tick, which reads as flickering at night.
      const lit = building.supplied === SupplyStatus.Supplied;
      const cx = (index % this.gridSize) + 0.5 + main.ox;
      const cz = Math.floor(index / this.gridSize) + 0.5 + main.oz;
      const lift = this.elevation.centerY(index);
      const shopfront = building.zone === Zone.Retail && building.density < 3;
      // Only a real door part (residential densities 1-2) ever needs a
      // window nudge; density 3 (and every non-residential zone) has none,
      // so `doorLx` stays undefined and the street face keeps its grid as
      // is. `doorLx` is the door's sideways offset in the body's own
      // south-facing frame — the inverse of the face rotation `facePart`
      // applied when placing it (inverting `face` by `(4 - face) % 4` and
      // re-running `faceOffset` undoes that rotation).
      const doorPart = building.parts.find(
        (p) => p.accent && p.color.getHex() === ACCENT.door.getHex(),
      );
      let doorLx: number | undefined;
      if (doorPart) {
        const inverseFace = ((4 - building.face) % 4) as StreetFace;
        [doorLx] = faceOffset(doorPart.ox - main.ox, doorPart.oz - main.oz, inverseFace);
      }
      // Glow quads are a subset of the frames, so one budget bounds both.
      const budgetEnd = Math.min(slot + WINDOWS_PER_TILE, capacity);
      let windowId = 0;
      for (const [face, isStreet] of [
        [building.face, true],
        [((building.face + 2) % 4) as StreetFace, false],
      ] as const) {
        const width = faceWidth(main, face);
        const depth = faceDepth(main, face);
        rotation.makeRotationY(face * QUARTER_TURN);
        if (isStreet && shopfront) {
          // Always within budget here: WINDOWS_PER_TILE is reserved per
          // tile up front, and at most gridSize² buildings ever run through
          // this loop, so slot never reaches budgetEnd before this check.
          const shopWidth = width * 0.8;
          // Keep the top fixed below the awning; lift the bottom so the
          // sill (WINDOW_SILL_DROP × height below the glass) clears the
          // plinth: bottom - DROP × (top - bottom) >= PLINTH_HEIGHT.
          const top = main.sy * SHOPFRONT_TOP_FRACTION;
          const bottom = Math.max(
            main.sy * SHOPFRONT_BOTTOM_FRACTION,
            (PLINTH_HEIGHT + WINDOW_SILL_DROP * top) / (1 + WINDOW_SILL_DROP),
          );
          const shopHeight = top - bottom;
          const centreY = lift + main.oy + (top + bottom) / 2;
          const [fx, fz] = faceOffset(0, depth / 2, face);
          matrix.copy(rotation);
          matrix.scale(this.shopfrontScale.set(shopWidth, shopHeight, 1));
          matrix.setPosition(cx + fx, centreY - shopHeight / 2, cz + fz);
          this.windowFramesMesh.setMatrixAt(slot++, matrix);
          if (lit) {
            const [gx, gz] = faceOffset(0, depth / 2 + GLOW_PROUD, face);
            matrix.copy(rotation);
            matrix.scale(
              this.shopfrontScale.set(shopWidth / WINDOW_WIDTH, shopHeight / WINDOW_HEIGHT, 1),
            );
            matrix.setPosition(cx + gx, centreY, cz + gz);
            this.windowsMesh.setMatrixAt(glowSlot++, matrix);
          }
          continue;
        }
        const cols = Math.min(3, Math.max(1, Math.round(width / 0.24)));
        const rows = Math.min(4, Math.max(1, Math.round(main.sy / 0.28)));
        const colLx = Array.from(
          { length: cols },
          (_, c) => ((c + 0.5) / cols - 0.5) * width * 0.8,
        );
        for (let col = 0; col < cols; col++) {
          for (let row = 0; row < rows; row++) {
            windowId++;
            // Deterministically leave ~1/3 of windows dark (framed, no glow).
            const dark = (index * 7 + windowId * 13 + building.variant) % 3 === 0;
            const localY = main.oy + ((row + 0.55) / rows) * main.sy * 0.82;
            let lx = colLx[col];
            if (isStreet && doorLx !== undefined) {
              // A quad overlapping the real door rectangle is nudged to
              // whichever side keeps it on the facade and clear of the
              // other columns; if neither side manages that, the quad is
              // dropped instead of sinking behind the door or doubling up
              // on a neighbour.
              const doorLeft = doorLx - DOOR.width / 2;
              const doorRight = doorLx + DOOR.width / 2;
              const quadLeft = lx - WINDOW_WIDTH / 2;
              const quadRight = lx + WINDOW_WIDTH / 2;
              const quadBottom = localY - WINDOW_HEIGHT / 2;
              const quadTop = localY + WINDOW_HEIGHT / 2;
              const doorBottom = main.oy;
              const doorTop = main.oy + DOOR.height;
              const intersectsDoor =
                quadLeft < doorRight &&
                quadRight > doorLeft &&
                quadBottom < doorTop &&
                quadTop > doorBottom;
              if (intersectsDoor) {
                // Nudge to the nearer side of the door that still fits the
                // facade; drop the quad if neither side fits, or if the
                // chosen side lands within a frame width of another column
                // (which would overlap a neighbour's frame instead).
                const nudge = DOOR.width / 2 + WINDOW_WIDTH / 2 + 0.01;
                const rightLx = doorLx + nudge;
                const leftLx = doorLx - nudge;
                const rightFits = Math.abs(rightLx) + FRAME_WIDTH / 2 < width / 2;
                const leftFits = Math.abs(leftLx) + FRAME_WIDTH / 2 < width / 2;
                let nudgedLx: number | undefined;
                if (rightFits && leftFits) {
                  nudgedLx = Math.abs(rightLx - lx) <= Math.abs(leftLx - lx) ? rightLx : leftLx;
                } else if (rightFits) {
                  nudgedLx = rightLx;
                } else if (leftFits) {
                  nudgedLx = leftLx;
                }
                if (nudgedLx === undefined) continue;
                if (
                  colLx.some((other, i) => i !== col && Math.abs(nudgedLx! - other) < FRAME_WIDTH)
                )
                  continue;
                lx = nudgedLx;
              }
            }
            if (slot >= budgetEnd) break;
            const [fx, fz] = faceOffset(lx, depth / 2, face);
            matrix.copy(rotation);
            matrix.scale(this.frameScale);
            matrix.setPosition(cx + fx, lift + localY - WINDOW_HEIGHT / 2, cz + fz);
            this.windowFramesMesh.setMatrixAt(slot++, matrix);
            if (lit && !dark) {
              const [gx, gz] = faceOffset(lx, depth / 2 + GLOW_PROUD, face);
              matrix.copy(rotation);
              matrix.setPosition(cx + gx, lift + localY, cz + gz);
              this.windowsMesh.setMatrixAt(glowSlot++, matrix);
            }
          }
        }
      }
    }
    this.windowFramesMesh.count = slot;
    this.windowFramesMesh.instanceMatrix.needsUpdate = true;
    this.windowsMesh.count = glowSlot;
    this.windowsMesh.instanceMatrix.needsUpdate = true;
  }
}
