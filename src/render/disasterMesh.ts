import * as THREE from 'three';
import type { TileDiff } from '../shared/types.ts';
import { DisasterKind } from '../shared/types.ts';
import type { ElevationField } from './elevationField.ts';
import type { DiffLayer } from './renderer.ts';
import { composePrismOnGround, createHalfTilePrism } from './decal.ts';

/**
 * Wreckage decal: a dark scar on a damaged tile, one prism pair per tile
 * (see decal.ts) so it covers the whole tile square. Lifted above the
 * opaque road pad (0.05, see roadsMesh.ts) so debris reads on a wrecked
 * road instead of being buried under it, and below the overlay layer
 * (0.07, renderOrder 2 in overlays.ts) so the Damage overlay still wins
 * when the player toggles it on.
 */
const DECAL_SIZE = 0.9;
const DECAL_THICKNESS = 0.02;
const DECAL_LIFT = 0.058;
/**
 * An InstancedMesh's built-in material has one opacity for the whole
 * mesh — there is no per-instance alpha, only a per-instance colour. So
 * "more damage -> more opaque" is faked the same way GeothermalMesh fakes
 * the steam plume's fade: by lerping the instance colour from a pale tone
 * that all but disappears into the ground (a scuff, easy to miss) toward
 * near-black soot (unmistakable wreckage) as damage climbs toward 255.
 */
const DECAL_LOW = new THREE.Color(0x9c9280);
const DECAL_HIGH = new THREE.Color(0x1c1a18);

/** Fire: a small ember bobbing near the ground, plus a smoke puff above it. */
const EMBER_SIZE = 0.14;
const EMBER_BOB_HEIGHT = 0.1;
const EMBER_BOB_SPEED = 4;
const EMBER_LIFT = 0.05;
const EMBER_COLOR = new THREE.Color(0xff7a33);

const SMOKE_SIZE = 0.34;
const SMOKE_BASE_LIFT = 0.22;
const SMOKE_RISE_HEIGHT = 0.55;
const SMOKE_RISE_SPEED = 0.22;
const SMOKE_COLOR = new THREE.Color(0x8a8a86);

/**
 * Flood film: a translucent prism pair per submerged tile, lifted above
 * the wreckage decal — a flood covers debris rather than leaving it in
 * view — and given an explicit renderOrder (like overlays.ts does for the
 * same reason) so it always draws after the ground/road/decal layers and
 * before the overlay, regardless of which way the camera happens to sort
 * near-coplanar transparent tiles.
 */
const FLOOD_SIZE = 1;
const FLOOD_THICKNESS = 0.02;
const FLOOD_LIFT = 0.066;
const FLOOD_RENDER_ORDER = 1;
const FLOOD_COLOR = 0x3d6f96;
const FLOOD_OPACITY = 0.42;

/** True when two tile-index lists cover the same set, order ignored. */
function sameTiles(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  for (const index of b) if (!set.has(index)) return false;
  return true;
}

/**
 * Renders the three visible faces of a disaster: a wreckage decal on
 * every damaged tile (storm, fire or flood alike — damage is damage),
 * embers and smoke on the tiles a fire is actually burning right now, and
 * a translucent flood film over the tiles a flood currently covers. A
 * storm has no shape of its own beyond the damage it leaves, so its
 * entries in the active-kinds map simply never match Fire or Flood here.
 *
 * The decal only tracks `TileDiff.damage`, which is already part of every
 * tile diff burst, so it rebuilds from `applyDiffs` like the other static
 * ground decals (`zoneTilesMesh.ts`, `waterMesh.ts`). Which tiles are
 * burning or flooded is not on the tile diff channel — the renderer reads
 * it from `GlobalStats.disasters.active[].tiles` and feeds it through
 * `setActiveKinds`. The flood film is static once placed, so it only
 * rebuilds when the flooded set actually changes. The fire visuals
 * genuinely animate (ember bob, smoke drift), so — exactly like
 * `GeothermalMesh`'s steam plume — they rebuild every frame while motion
 * is enabled, and while reduced motion is on they rebuild only when
 * something they depend on (which tiles are burning) actually changed.
 */
export class DisasterMesh implements DiffLayer {
  private readonly decals: THREE.InstancedMesh;
  private readonly embers: THREE.InstancedMesh;
  private readonly smoke: THREE.InstancedMesh;
  private readonly flood: THREE.InstancedMesh;

  /** Tile index -> damage 0..255, for every currently damaged tile. */
  private readonly damaged = new Map<number, number>();
  private fireTiles: number[] = [];
  private floodTiles: number[] = [];

  private readonly gridSize: number;
  private readonly matrix = new THREE.Matrix4();
  private readonly color = new THREE.Color();
  private reducedMotion = false;
  /** Set when the fire mesh must rebuild even with motion disabled. */
  private fireDirty = false;

  constructor(
    scene: THREE.Scene,
    gridSize: number,
    private readonly elevation: ElevationField,
  ) {
    this.gridSize = gridSize;
    const tiles = gridSize * gridSize;

    this.decals = new THREE.InstancedMesh(
      createHalfTilePrism(),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.75,
        depthWrite: false,
      }),
      tiles * 2,
    );
    // Instance transforms span the whole grid; the base geometry's bounds
    // would wrongly cull the mesh, so culling is disabled.
    this.decals.frustumCulled = false;
    this.decals.count = 0;
    scene.add(this.decals);

    this.embers = new THREE.InstancedMesh(
      new THREE.SphereGeometry(EMBER_SIZE / 2, 6, 4),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      }),
      tiles,
    );
    this.embers.frustumCulled = false;
    this.embers.count = 0;
    scene.add(this.embers);

    this.smoke = new THREE.InstancedMesh(
      new THREE.SphereGeometry(SMOKE_SIZE / 2, 8, 6),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
      }),
      tiles,
    );
    this.smoke.frustumCulled = false;
    this.smoke.count = 0;
    scene.add(this.smoke);

    this.flood = new THREE.InstancedMesh(
      createHalfTilePrism(),
      new THREE.MeshBasicMaterial({
        color: FLOOD_COLOR,
        transparent: true,
        opacity: FLOOD_OPACITY,
        depthWrite: false,
      }),
      tiles * 2,
    );
    this.flood.frustumCulled = false;
    this.flood.count = 0;
    this.flood.renderOrder = FLOOD_RENDER_ORDER;
    scene.add(this.flood);
  }

  applyDiffs(diffs: TileDiff[]): void {
    let changed = false;
    for (const diff of diffs) {
      if (diff.damage > 0) {
        if (this.damaged.get(diff.index) !== diff.damage) {
          this.damaged.set(diff.index, diff.damage);
          changed = true;
        }
      } else if (this.damaged.delete(diff.index)) {
        changed = true;
      }
    }
    if (changed) this.rebuildDecals();
  }

  /**
   * Which tiles are inside which active event. The tile diff channel only
   * carries the damage, not the kind, so the renderer reads this straight
   * off the stats (`DisasterInfo.tiles`) every time it updates.
   */
  setActiveKinds(kinds: Map<number, DisasterKind>): void {
    const fire: number[] = [];
    const flood: number[] = [];
    for (const [index, kind] of kinds) {
      if (kind === DisasterKind.Fire) fire.push(index);
      else if (kind === DisasterKind.Flood) flood.push(index);
    }
    this.fireTiles = fire;
    // The fire set rarely changes tick-to-tick, but the check is cheap and
    // update() needs to know a real change happened even under reduced
    // motion, so it is simplest to just always mark it dirty here.
    this.fireDirty = true;
    if (!sameTiles(this.floodTiles, flood)) {
      this.floodTiles = flood;
      this.rebuildFlood();
    }
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
  }

  update(_deltaSeconds: number, nowSeconds: number): void {
    if (this.fireTiles.length === 0) {
      if (this.embers.count !== 0) {
        this.embers.count = 0;
        this.smoke.count = 0;
        this.embers.instanceMatrix.needsUpdate = true;
        this.smoke.instanceMatrix.needsUpdate = true;
      }
      this.fireDirty = false;
      return;
    }
    // Motion keeps embers bobbing and smoke rising every frame; reduced
    // motion freezes them, so there is nothing to redraw unless the set of
    // burning tiles itself changed.
    if (this.reducedMotion && !this.fireDirty) return;
    this.rebuildFire(this.reducedMotion ? 0 : nowSeconds);
    this.fireDirty = false;
  }

  /** Damaged tiles currently carrying a wreckage decal. */
  get decalCount(): number {
    return this.damaged.size;
  }

  /** Tiles a fire is actively burning right now. */
  get fireCount(): number {
    return this.embers.count;
  }

  /** Tiles currently under the flood film. */
  get floodCount(): number {
    return this.floodTiles.length;
  }

  /** Place every wreckage decal. Static: only called when damage changes. */
  private rebuildDecals(): void {
    let slot = 0;
    for (const [index, damage] of this.damaged) {
      this.color.copy(DECAL_LOW).lerp(DECAL_HIGH, damage / 255);
      for (const high of [false, true]) {
        composePrismOnGround(
          this.matrix,
          this.elevation,
          index,
          high,
          DECAL_SIZE,
          DECAL_THICKNESS,
          DECAL_LIFT,
        );
        this.decals.setMatrixAt(slot, this.matrix);
        this.decals.setColorAt(slot, this.color);
        slot++;
      }
    }
    this.decals.count = slot;
    this.decals.instanceMatrix.needsUpdate = true;
    if (this.decals.instanceColor) this.decals.instanceColor.needsUpdate = true;
  }

  /** Place every ember and its smoke; `time` drives their motion. */
  private rebuildFire(time: number): void {
    let count = 0;
    for (const index of this.fireTiles) {
      const x = (index % this.gridSize) + 0.5;
      const z = Math.floor(index / this.gridSize) + 0.5;
      const groundY = this.elevation.centerY(index);

      // Embers flicker in place near the ground; the phase is offset by
      // the tile index so a whole burning block does not pulse in lockstep.
      const bob = 0.5 + 0.5 * Math.sin(time * EMBER_BOB_SPEED + index * 1.7);
      this.matrix.identity();
      this.matrix.setPosition(x, groundY + EMBER_LIFT + bob * EMBER_BOB_HEIGHT, z);
      this.embers.setMatrixAt(count, this.matrix);
      this.color.copy(EMBER_COLOR).multiplyScalar(0.7 + 0.3 * bob);
      this.embers.setColorAt(count, this.color);

      // Smoke loops upward and fades, exactly like the geothermal plume.
      const phase = (time * SMOKE_RISE_SPEED + index * 0.53) % 1;
      const scale = 0.6 + phase * 0.8;
      this.matrix.makeScale(scale, scale, scale);
      this.matrix.setPosition(x, groundY + SMOKE_BASE_LIFT + phase * SMOKE_RISE_HEIGHT, z);
      this.smoke.setMatrixAt(count, this.matrix);
      this.color.copy(SMOKE_COLOR).multiplyScalar(1 - phase * 0.6);
      this.smoke.setColorAt(count, this.color);

      count++;
    }
    this.embers.count = count;
    this.smoke.count = count;
    this.embers.instanceMatrix.needsUpdate = true;
    this.smoke.instanceMatrix.needsUpdate = true;
    if (this.embers.instanceColor) this.embers.instanceColor.needsUpdate = true;
    if (this.smoke.instanceColor) this.smoke.instanceColor.needsUpdate = true;
  }

  /** Place every flood tile's film. Static: only called when the flooded set changes. */
  private rebuildFlood(): void {
    let slot = 0;
    for (const index of this.floodTiles) {
      for (const high of [false, true]) {
        composePrismOnGround(
          this.matrix,
          this.elevation,
          index,
          high,
          FLOOD_SIZE,
          FLOOD_THICKNESS,
          FLOOD_LIFT,
        );
        this.flood.setMatrixAt(slot, this.matrix);
        slot++;
      }
    }
    this.flood.count = slot;
    this.flood.instanceMatrix.needsUpdate = true;
  }
}
