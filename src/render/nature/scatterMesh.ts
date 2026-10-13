import * as THREE from 'three';
import { BALANCE } from '../../shared/constants.ts';
import type { TileDiff } from '../../shared/types.ts';
import { Terrain, TileType, Zone } from '../../shared/types.ts';
import type { ElevationField } from '../elevationField.ts';
import { foliageColor } from '../forestMesh.ts';
import { surfaceMaterial } from '../materials.ts';
import { dome, merge, type Model } from '../modelKit.ts';
import type { DiffLayer, RenderEnvironment } from '../renderer.ts';
import { GrowingMesh } from '../plants/growingMesh.ts';
import { tileHash } from './hash.ts';

/** Share of free tiles that carry props. */
export const SCATTER_SHARE = 0.33;
const MAX_PROPS_PER_TILE = 3;
/** Share of rocks among props on flat lowland and on steep or high ground. */
const ROCK_SHARE_FLAT = 0.25;
const ROCK_SHARE_STEEP = 0.75;
/** Slope (in levels) at which a tile counts as fully steep. */
const STEEP_SLOPE = 2;
/** Per-prop size range. */
const PROP_SCALE_MIN = 0.7;
const PROP_SCALE_MAX = 1.3;
/** Bushes follow the season halfway, the rest stays this green. */
const BUSH_GREEN = new THREE.Color(0x4f8a3e);
const BUSH_SEASON_MIX = 0.5;
const ROCK_COLOR = 0x8a8a84;
/** Bush geometry is white; the instance colour paints the leaves. */
const BUSH_WHITE = 0xffffff;
/** Gap between a prop's footprint and the tile edge. */
const PROP_MARGIN = 0.12;
/** Both models stay within this distance of their axis (at scale 1). */
const PROP_RADIUS = 0.12;
/** Prop centres keep this far from the edges, so props stay inside their tile. */
const PROP_INSET = PROP_MARGIN + PROP_RADIUS * PROP_SCALE_MAX;

/** Facets: props are many and small, so coarse (rocks read as chiselled). */
const PROP_SEGMENTS = 6;

/** Bush (~0.09 high): a round main dome with two smaller ones leaning on it. */
const BUSH_RADIUS = 0.08;
const BUSH_SQUASH = 1.1;
const BUSH_SIDE_RADIUS = 0.055;
const BUSH_SIDES: [number, number][] = [
  [0.06, 0.02],
  [-0.05, -0.035],
];
/** Rock (~0.06 high): a low boulder with a smaller stone beside it. */
const ROCK_RADIUS = 0.07;
const ROCK_SQUASH = 0.85;
const ROCK_SIDE_RADIUS = 0.04;
const ROCK_SIDE_SQUASH = 0.8;
const ROCK_SIDE: [number, number] = [0.07, 0.03];

/** Hash salts (above the forest's) per prop attribute; the prop number is added. */
const SALT_HAS_PROPS = 501;
const SALT_PROP_COUNT = 503;
const SALT_X = 601;
const SALT_Z = 611;
const SALT_SCALE = 621;
const SALT_YAW = 631;
const SALT_KIND = 641;

/** A dome standing on y = 0 (the kit centres primitives on their bounds). */
const groundDome = (
  r: number,
  squash: number,
  x: number,
  z: number,
  color: number,
  segments: number,
) => dome(r, squash, x, (r * squash) / 2, z, color, segments);

function bushModel(): Model {
  return merge([
    groundDome(BUSH_RADIUS, BUSH_SQUASH, 0, 0, BUSH_WHITE, PROP_SEGMENTS),
    ...BUSH_SIDES.map(([x, z]) => groundDome(BUSH_SIDE_RADIUS, 1, x, z, BUSH_WHITE, PROP_SEGMENTS)),
  ]);
}

function rockModel(): Model {
  const [x, z] = ROCK_SIDE;
  return merge([
    groundDome(ROCK_RADIUS, ROCK_SQUASH, 0, 0, ROCK_COLOR, PROP_SEGMENTS),
    groundDome(ROCK_SIDE_RADIUS, ROCK_SIDE_SQUASH, x, z, ROCK_COLOR, PROP_SEGMENTS),
  ]);
}

/** Bush leaves: the seasonal foliage, held halfway toward a steady green. */
function bushColor(target: THREE.Color, phase: number, snowCover: number): THREE.Color {
  return foliageColor(target, phase, snowCover).lerp(BUSH_GREEN, BUSH_SEASON_MIX);
}

/** Whether a free tile carries props at all. */
function hasProps(index: number): boolean {
  return tileHash(index, SALT_HAS_PROPS) < SCATTER_SHARE;
}

/** A tile nothing is built, zoned, wired, laid or grown on. */
function isFree(diff: TileDiff): boolean {
  return (
    diff.tileType === TileType.Empty &&
    diff.terrain === Terrain.Land &&
    diff.zone === Zone.None &&
    diff.powerLine === 0 &&
    diff.rail === 0 &&
    diff.geothermal === 0 &&
    diff.forest === 0
  );
}

/**
 * Bushes and rocks: one to three props on a third of the free land
 * tiles, placed deterministically per tile. Rocks take over on slopes
 * and high ground; bushes follow the season lightly. Building on a tile
 * clears its props.
 */
export class ScatterMesh implements DiffLayer {
  private readonly bushes: GrowingMesh;
  private readonly rocks: GrowingMesh;
  /** 1 for every free tile (see `isFree`). */
  private readonly free: Uint8Array;
  private bushCount = 0;
  private rockCount = 0;
  private built = false;
  private readonly bushTint = BUSH_GREEN.clone();
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly scratch = new THREE.Color();

  constructor(
    scene: THREE.Scene,
    gridSize: number,
    private readonly elevation: ElevationField,
  ) {
    this.free = new Uint8Array(gridSize * gridSize);
    this.bushes = this.instanced(scene, bushModel(), 'scatter-bushes');
    this.rocks = this.instanced(scene, rockModel(), 'scatter-rocks');
  }

  /** Props currently drawn per kind. */
  get counts(): { bushes: number; rocks: number } {
    return { bushes: this.bushCount, rocks: this.rockCount };
  }

  /** Tiles that currently carry props. */
  propTiles(): Set<number> {
    const tiles = new Set<number>();
    for (let index = 0; index < this.free.length; index++) {
      if (this.free[index] && hasProps(index)) tiles.add(index);
    }
    return tiles;
  }

  setEnvironment(environment: RenderEnvironment): void {
    bushColor(this.scratch, environment.phase, environment.snowCover);
    if (this.scratch.getHex() === this.bushTint.getHex()) return;
    this.bushTint.copy(this.scratch);
    this.paint();
  }

  applyDiffs(diffs: TileDiff[]): void {
    let changed = !this.built;
    for (const diff of diffs) {
      const free = isFree(diff) ? 1 : 0;
      if (this.free[diff.index] === free) continue;
      this.free[diff.index] = free;
      changed = true;
    }
    if (!changed) return;
    this.built = true;
    this.rebuild();
  }

  /** A mesh that grows with the props (a full-map capacity would waste memory). */
  private instanced(scene: THREE.Scene, model: Model, name: string): GrowingMesh {
    return new GrowingMesh(
      scene,
      model.geometry,
      surfaceMaterial({ vertexColors: true }),
      (mesh) => {
        mesh.name = name;
        // Instance transforms live across the whole grid; the base geometry's
        // bounds would wrongly cull the mesh, so culling is disabled.
        mesh.frustumCulled = false;
        // Props are small and many: their shadows would cost more than they show.
        mesh.castShadow = false;
        mesh.receiveShadow = true;
      },
    );
  }

  /** Write the bush colour to every drawn bush and upload just those. */
  private paint(): void {
    const count = this.bushCount;
    const bushes = this.bushes.mesh;
    for (let i = 0; i < count; i++) bushes.setColorAt(i, this.bushTint);
    const colors = bushes.instanceColor;
    if (!colors) return;
    colors.clearUpdateRanges();
    // Never an empty range: three.js reads that as "upload everything".
    colors.addUpdateRange(0, Math.max(1, count) * colors.itemSize);
    if (count > 0) colors.needsUpdate = true;
  }

  private rebuild(): void {
    const size = this.elevation.gridSize;
    const span = 1 - 2 * PROP_INSET;
    this.bushCount = 0;
    this.rockCount = 0;
    for (let index = 0; index < this.free.length; index++) {
      if (!this.free[index] || !hasProps(index)) continue;
      const steepness = Math.min(
        1,
        Math.max(
          this.elevation.slopeAt(index) / STEEP_SLOPE,
          this.elevation.levelAt(index) / BALANCE.terrain.maxLevel,
        ),
      );
      const rockShare = THREE.MathUtils.lerp(ROCK_SHARE_FLAT, ROCK_SHARE_STEEP, steepness);
      const props = 1 + Math.floor(tileHash(index, SALT_PROP_COUNT) * MAX_PROPS_PER_TILE);
      const tx = index % size;
      const tz = Math.floor(index / size);
      for (let prop = 0; prop < props; prop++) {
        const x = tx + PROP_INSET + span * tileHash(index, SALT_X + prop);
        const z = tz + PROP_INSET + span * tileHash(index, SALT_Z + prop);
        const scale = THREE.MathUtils.lerp(
          PROP_SCALE_MIN,
          PROP_SCALE_MAX,
          tileHash(index, SALT_SCALE + prop),
        );
        this.position.set(x, this.elevation.surfaceY(x, z), z);
        this.rotation.setFromAxisAngle(this.up, tileHash(index, SALT_YAW + prop) * Math.PI * 2);
        this.scale.setScalar(scale);
        this.matrix.compose(this.position, this.rotation, this.scale);
        if (tileHash(index, SALT_KIND + prop) < rockShare) {
          this.rocks.ensure(this.rockCount + 1);
          this.rocks.mesh.setMatrixAt(this.rockCount++, this.matrix);
        } else {
          this.bushes.ensure(this.bushCount + 1);
          this.bushes.mesh.setMatrixAt(this.bushCount++, this.matrix);
        }
      }
    }
    this.rocks.commit(this.rockCount);
    this.paint();
    this.bushes.commit(this.bushCount);
  }
}
