import * as THREE from 'three';
import { BALANCE } from '../shared/constants.ts';
import type { TileDiff } from '../shared/types.ts';
import type { ElevationField } from './elevationField.ts';
import type { DiffLayer, RenderEnvironment } from './renderer.ts';
import { surfaceMaterial } from './materials.ts';
import { cone, cylinder, merge, sphere, type Model } from './modelKit.ts';
import { tileHash } from './nature/hash.ts';
import { uploadDrawn } from './plants/growingMesh.ts';

/** Trees drawn per tile at growth stage 1..maxStage. */
const TREES_BY_STAGE = [0, 2, 3, 5];
const MAX_TREES_PER_TILE = TREES_BY_STAGE[TREES_BY_STAGE.length - 1];
/** Facets of trunks and crowns: trees are many, so rounder than a box but cheap. */
const TREE_SEGMENTS = 8;
/** Broadleaf crown spheres are coarser still: two per tree, the costliest part. */
const BROADLEAF_SEGMENTS = 6;
/** Per-tree size variation around the stage size (±). */
const SIZE_JITTER = 0.15;
/** Share of conifers on the lowest and on the highest elevation level. */
const CONIFER_SHARE_LOW = 0.3;
const CONIFER_SHARE_HIGH = 0.85;
/** Evergreen needles: dark, only whitened by snow. */
export const CONIFER_COLOR = 0x2f5e3c;
const TRUNK_COLOR = 0x6e4f36;
/** Crown geometry is white; the instance colour paints the foliage. */
const CROWN_WHITE = 0xffffff;

/**
 * A fully grown tree (scale 1) is ~0.48 high with its base at y = 0.
 * Crowns stay within 0.17 of the trunk axis so that even at the largest
 * jitter (× 1.15) a tree placed 0.2 from the tile edge stays inside it.
 */
const TRUNK_RADIUS = 0.025;
/** Conifer: a short trunk under two stacked cones, the lower one wider. */
const CONIFER_TRUNK_HEIGHT = 0.1;
const CONIFER_LOWER_RADIUS = 0.15;
const CONIFER_LOWER_HEIGHT = 0.24;
const CONIFER_LOWER_BASE = 0.08;
const CONIFER_UPPER_RADIUS = 0.11;
const CONIFER_UPPER_HEIGHT = 0.2;
const CONIFER_UPPER_BASE = 0.28;
/** Broadleaf: a taller trunk under two overlapping round crowns. */
const BROADLEAF_TRUNK_HEIGHT = 0.2;
const BROADLEAF_CROWN_RADIUS = 0.14;
const BROADLEAF_CROWN_Y = 0.3;
const BROADLEAF_TOP_RADIUS = 0.1;
const BROADLEAF_TOP_OFFSET = 0.04;
const BROADLEAF_TOP_Y = 0.38;

/** Foliage through the year; winter is the bare, greyed-out canopy. */
const FOLIAGE_KEYS = [
  new THREE.Color(0x5aa84f), // spring
  new THREE.Color(0x3f7d46), // summer
  new THREE.Color(0xb57a34), // autumn
  new THREE.Color(0x6b6a55), // winter
];
const FOLIAGE_SNOW = new THREE.Color(0xd8e0e4);
/** How far full snow cover whitens a crown. */
const FOLIAGE_SNOW_MIX = 0.7;
/** Each key colour sits in the middle of its season (see terrain.ts). */
const KEY_OFFSET = 0.125;

/** Cyclic blend of the four seasonal foliage colours, then toward snow. */
export function foliageColor(target: THREE.Color, phase: number, snowCover: number): THREE.Color {
  const cyclic = (((phase - KEY_OFFSET) % 1) + 1) % 1;
  const x = cyclic * FOLIAGE_KEYS.length;
  const i = Math.floor(x) % FOLIAGE_KEYS.length;
  const next = (i + 1) % FOLIAGE_KEYS.length;
  return target
    .copy(FOLIAGE_KEYS[i])
    .lerp(FOLIAGE_KEYS[next], x - Math.floor(x))
    .lerp(FOLIAGE_SNOW, THREE.MathUtils.clamp(snowCover, 0, 1) * FOLIAGE_SNOW_MIX);
}

/** Evergreen conifer needles, whitened by snow only. */
function coniferColor(target: THREE.Color, snowCover: number): THREE.Color {
  return target
    .setHex(CONIFER_COLOR)
    .lerp(FOLIAGE_SNOW, THREE.MathUtils.clamp(snowCover, 0, 1) * FOLIAGE_SNOW_MIX);
}

function coniferModels(): { trunk: Model; crown: Model } {
  const s = TREE_SEGMENTS;
  return {
    trunk: merge([
      cylinder(TRUNK_RADIUS, CONIFER_TRUNK_HEIGHT, 0, CONIFER_TRUNK_HEIGHT / 2, 0, TRUNK_COLOR, s),
    ]),
    crown: merge([
      cone(
        CONIFER_LOWER_RADIUS,
        0,
        CONIFER_LOWER_HEIGHT,
        0,
        CONIFER_LOWER_BASE + CONIFER_LOWER_HEIGHT / 2,
        0,
        CROWN_WHITE,
        s,
      ),
      cone(
        CONIFER_UPPER_RADIUS,
        0,
        CONIFER_UPPER_HEIGHT,
        0,
        CONIFER_UPPER_BASE + CONIFER_UPPER_HEIGHT / 2,
        0,
        CROWN_WHITE,
        s,
      ),
    ]),
  };
}

function broadleafModels(): { trunk: Model; crown: Model } {
  const s = TREE_SEGMENTS;
  return {
    trunk: merge([
      cylinder(
        TRUNK_RADIUS,
        BROADLEAF_TRUNK_HEIGHT,
        0,
        BROADLEAF_TRUNK_HEIGHT / 2,
        0,
        TRUNK_COLOR,
        s,
      ),
    ]),
    crown: merge([
      sphere(BROADLEAF_CROWN_RADIUS, 0, BROADLEAF_CROWN_Y, 0, CROWN_WHITE, BROADLEAF_SEGMENTS),
      sphere(
        BROADLEAF_TOP_RADIUS,
        BROADLEAF_TOP_OFFSET,
        BROADLEAF_TOP_Y,
        0,
        CROWN_WHITE,
        BROADLEAF_SEGMENTS,
      ),
    ]),
  };
}

/** Trunk and crown meshes of one species, plus the crowns' current colour. */
interface Species {
  trunks: THREE.InstancedMesh;
  crowns: THREE.InstancedMesh;
  color: THREE.Color;
  count: number;
}

/**
 * Woods: instanced conifers and broadleaves, a few per wooded tile,
 * scattered deterministically inside it. Saplings are small and grow
 * with the tile's stage; conifers take over on high ground. Broadleaf
 * crowns follow the season like the ground does, conifers stay green.
 */
export class ForestMesh implements DiffLayer {
  private readonly conifer: Species;
  private readonly broadleaf: Species;
  /** Tile index -> growth stage, for every wooded tile. */
  private readonly stages = new Map<number, number>();
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
    const capacity = gridSize * gridSize * MAX_TREES_PER_TILE;
    const conifer = coniferModels();
    const broadleaf = broadleafModels();
    this.conifer = {
      trunks: this.instanced(scene, conifer.trunk, capacity, 'forest-conifer-trunks', false),
      crowns: this.instanced(scene, conifer.crown, capacity, 'forest-conifer-crowns', true),
      color: coniferColor(new THREE.Color(), 0),
      count: 0,
    };
    this.broadleaf = {
      trunks: this.instanced(scene, broadleaf.trunk, capacity, 'forest-broadleaf-trunks', false),
      crowns: this.instanced(scene, broadleaf.crown, capacity, 'forest-broadleaf-crowns', true),
      color: FOLIAGE_KEYS[1].clone(),
      count: 0,
    };
  }

  /** Trees currently drawn per species. */
  get counts(): { conifer: number; broadleaf: number } {
    return { conifer: this.conifer.count, broadleaf: this.broadleaf.count };
  }

  setEnvironment(environment: RenderEnvironment): void {
    foliageColor(this.scratch, environment.phase, environment.snowCover);
    this.recolor(this.broadleaf, this.scratch);
    coniferColor(this.scratch, environment.snowCover);
    this.recolor(this.conifer, this.scratch);
  }

  applyDiffs(diffs: TileDiff[]): void {
    let changed = false;
    for (const diff of diffs) {
      const stage = diff.forest;
      if (stage > 0) {
        if (this.stages.get(diff.index) !== stage) {
          this.stages.set(diff.index, stage);
          changed = true;
        }
      } else if (this.stages.delete(diff.index)) {
        changed = true;
      }
    }
    if (changed) this.rebuild();
  }

  private instanced(
    scene: THREE.Scene,
    model: Model,
    capacity: number,
    name: string,
    castShadow: boolean,
  ): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(
      model.geometry,
      surfaceMaterial({ vertexColors: true }),
      capacity,
    );
    mesh.name = name;
    // Instance transforms live across the whole grid; the base geometry's
    // bounds would wrongly cull the mesh, so culling is disabled.
    mesh.frustumCulled = false;
    // Thin trunks hide under their crown's shadow; only crowns cast one.
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    mesh.count = 0;
    scene.add(mesh);
    return mesh;
  }

  /** Paint a species' crowns when its foliage colour changed. */
  private recolor(species: Species, color: THREE.Color): void {
    if (color.getHex() === species.color.getHex()) return;
    species.color.copy(color);
    this.paint(species);
  }

  /** Write the species colour to every drawn crown and upload just those. */
  private paint(species: Species): void {
    const { crowns, color, count } = species;
    for (let i = 0; i < count; i++) crowns.setColorAt(i, color);
    const colors = crowns.instanceColor;
    if (!colors) return;
    colors.clearUpdateRanges();
    // Never an empty range: three.js reads that as "upload everything".
    colors.addUpdateRange(0, Math.max(1, count) * colors.itemSize);
    if (count > 0) colors.needsUpdate = true;
  }

  private rebuild(): void {
    const conifer = this.conifer;
    const broadleaf = this.broadleaf;
    conifer.count = 0;
    broadleaf.count = 0;
    for (const [index, stage] of this.stages) {
      const trees = TREES_BY_STAGE[Math.min(stage, TREES_BY_STAGE.length - 1)];
      // Saplings are 40 % of the height of mature trees and grow in.
      const size = 0.4 + 0.6 * (stage / BALANCE.forest.maxStage);
      const coniferShare = THREE.MathUtils.lerp(
        CONIFER_SHARE_LOW,
        CONIFER_SHARE_HIGH,
        this.elevation.levelAt(index) / BALANCE.terrain.maxLevel,
      );
      const tx = index % this.elevation.gridSize;
      const tz = Math.floor(index / this.elevation.gridSize);
      for (let tree = 0; tree < trees; tree++) {
        // Scattered inside the tile, clear of its edges.
        const x = tx + 0.2 + 0.6 * tileHash(index, tree * 2 + 1);
        const z = tz + 0.2 + 0.6 * tileHash(index, tree * 2 + 2);
        const jitter = 1 + SIZE_JITTER * (2 * tileHash(index, tree + 97) - 1);
        const yaw = tileHash(index, tree + 211) * Math.PI * 2;
        this.position.set(x, this.elevation.surfaceY(x, z), z);
        this.rotation.setFromAxisAngle(this.up, yaw);
        this.scale.setScalar(size * jitter);
        this.matrix.compose(this.position, this.rotation, this.scale);
        const species = tileHash(index, tree + 307) < coniferShare ? conifer : broadleaf;
        species.trunks.setMatrixAt(species.count, this.matrix);
        species.crowns.setMatrixAt(species.count, this.matrix);
        species.count++;
      }
    }
    for (const species of [conifer, broadleaf]) {
      uploadDrawn(species.trunks, species.count);
      uploadDrawn(species.crowns, species.count);
      this.paint(species);
    }
  }
}
