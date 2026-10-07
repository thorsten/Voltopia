import * as THREE from 'three';
import { BALANCE } from '../shared/constants.ts';
import type { TileDiff } from '../shared/types.ts';
import type { ElevationField } from './elevationField.ts';
import type { DiffLayer, RenderEnvironment } from './renderer.ts';
import { surfaceMaterial } from './materials.ts';

/** Trees drawn per tile at growth stage 1..maxStage. */
const TREES_BY_STAGE = [0, 1, 2, 3];
const MAX_TREES_PER_TILE = TREES_BY_STAGE[TREES_BY_STAGE.length - 1];
/** Trunk and crown size of a fully grown tree, scaled down for saplings. */
const TRUNK_WIDTH = 0.05;
const TRUNK_HEIGHT = 0.18;
const CROWN_SIZE = 0.24;
const CROWN_HEIGHT = 0.3;
const TRUNK_COLOR = 0x6e4f36;

/** Foliage through the year; winter is the bare, greyed-out canopy. */
const FOLIAGE_KEYS = [
  new THREE.Color(0x5aa84f), // spring
  new THREE.Color(0x3f7d46), // summer
  new THREE.Color(0xb57a34), // autumn
  new THREE.Color(0x6b6a55), // winter
];
const FOLIAGE_SNOW = new THREE.Color(0xd8e0e4);
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
    .lerp(FOLIAGE_SNOW, THREE.MathUtils.clamp(snowCover, 0, 1) * 0.7);
}

/**
 * Deterministic pseudo-random value 0..1 from a tile index and a salt, so
 * every tree keeps its spot across rebuilds (and matches on reload).
 */
function hash(index: number, salt: number): number {
  let h = (index * 2654435761 + salt * 40503) >>> 0;
  h ^= h >>> 13;
  h = (h * 0x5bd1e995) >>> 0;
  return (h >>> 8) / 16777216;
}

/**
 * Woods: instanced trunks and crowns, a few per wooded tile, scattered
 * deterministically inside it. Saplings are small and grow with the
 * tile's stage; the canopy follows the season like the ground does.
 */
export class ForestMesh implements DiffLayer {
  private readonly trunks: THREE.InstancedMesh;
  private readonly crowns: THREE.InstancedMesh;
  private readonly crownMaterial: THREE.MeshStandardMaterial;
  /** Tile index -> growth stage, for every wooded tile. */
  private readonly stages = new Map<number, number>();
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly noRotation = new THREE.Quaternion();

  constructor(
    scene: THREE.Scene,
    gridSize: number,
    private readonly elevation: ElevationField,
  ) {
    const capacity = gridSize * gridSize * MAX_TREES_PER_TILE;
    const trunkGeometry = new THREE.BoxGeometry(TRUNK_WIDTH, TRUNK_HEIGHT, TRUNK_WIDTH);
    trunkGeometry.translate(0, TRUNK_HEIGHT / 2, 0);
    this.trunks = new THREE.InstancedMesh(
      trunkGeometry,
      surfaceMaterial({ color: TRUNK_COLOR }),
      capacity,
    );
    // Instance transforms live across the whole grid; the base geometry's
    // bounds would wrongly cull the mesh, so culling is disabled.
    this.trunks.frustumCulled = false;
    this.trunks.castShadow = true;
    this.trunks.count = 0;
    scene.add(this.trunks);

    const crownGeometry = new THREE.BoxGeometry(CROWN_SIZE, CROWN_HEIGHT, CROWN_SIZE);
    crownGeometry.translate(0, TRUNK_HEIGHT + CROWN_HEIGHT / 2 - 0.04, 0);
    this.crownMaterial = surfaceMaterial({ color: FOLIAGE_KEYS[1] });
    this.crowns = new THREE.InstancedMesh(crownGeometry, this.crownMaterial, capacity);
    // Instance transforms live across the whole grid; the base geometry's
    // bounds would wrongly cull the mesh, so culling is disabled.
    this.crowns.frustumCulled = false;
    this.crowns.castShadow = true;
    this.crowns.count = 0;
    scene.add(this.crowns);
  }

  setEnvironment(environment: RenderEnvironment): void {
    foliageColor(this.crownMaterial.color, environment.phase, environment.snowCover);
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

  private rebuild(): void {
    let slot = 0;
    for (const [index, stage] of this.stages) {
      const trees = TREES_BY_STAGE[Math.min(stage, MAX_TREES_PER_TILE)];
      // Saplings are a third the height of mature trees and grow in.
      const size = 0.4 + 0.6 * (stage / BALANCE.forest.maxStage);
      const tx = index % this.elevation.gridSize;
      const tz = Math.floor(index / this.elevation.gridSize);
      for (let tree = 0; tree < trees; tree++) {
        // Scattered inside the tile, clear of its edges.
        const x = tx + 0.2 + 0.6 * hash(index, tree * 2 + 1);
        const z = tz + 0.2 + 0.6 * hash(index, tree * 2 + 2);
        const wobble = 0.85 + 0.3 * hash(index, tree + 97);
        this.position.set(x, this.elevation.surfaceY(x, z), z);
        this.scale.setScalar(size * wobble);
        this.matrix.compose(this.position, this.noRotation, this.scale);
        this.trunks.setMatrixAt(slot, this.matrix);
        this.crowns.setMatrixAt(slot, this.matrix);
        slot++;
      }
    }
    this.trunks.count = slot;
    this.crowns.count = slot;
    this.trunks.instanceMatrix.needsUpdate = true;
    this.crowns.instanceMatrix.needsUpdate = true;
  }
}
