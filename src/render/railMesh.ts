import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { DIR_E, DIR_N, DIR_S, DIR_W } from '../shared/grid.ts';
import { Terrain, TileType, type TileDiff } from '../shared/types.ts';
import type { ElevationField } from './elevationField.ts';
import type { DiffLayer } from './renderer.ts';

const BALLAST_COLOR = 0x8a8075;
const RAIL_COLOR = 0x4a4d52;
const DECK_COLOR = 0x6b6f75;
/** Rails sit this far either side of the tile's centre line. */
const GAUGE = 0.09;
const RAIL_WIDTH = 0.03;
const RAIL_HEIGHT = 0.03;
const BALLAST_WIDTH = 0.3;
const BALLAST_HEIGHT = 0.04;
/** Rails on a road tile are flush with the asphalt: no ballast, a hair above the road. */
const CROSSING_LIFT = 0.012;
const DECK_HEIGHT = 0.08;

/** Half a tile of track from the centre to one edge, pointing +x. */
function segmentGeometry(withBallast: boolean): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  if (withBallast) {
    const ballast = new THREE.BoxGeometry(0.5, BALLAST_HEIGHT, BALLAST_WIDTH);
    ballast.translate(0.25, BALLAST_HEIGHT / 2, 0);
    parts.push(ballast);
  }
  const lift = withBallast ? BALLAST_HEIGHT : 0;
  for (const side of [-GAUGE, GAUGE]) {
    const rail = new THREE.BoxGeometry(0.5, RAIL_HEIGHT, RAIL_WIDTH);
    rail.translate(0.25, lift + RAIL_HEIGHT / 2, side);
    parts.push(rail);
  }
  return mergeGeometries(parts);
}

/** The junction block under a tile's centre, so curves and crossings close. */
function centreGeometry(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(BALLAST_WIDTH, BALLAST_HEIGHT, BALLAST_WIDTH);
  g.translate(0, BALLAST_HEIGHT / 2, 0);
  return g;
}

const DIRECTION_ANGLE: ReadonlyArray<{ bit: number; angle: number }> = [
  { bit: DIR_E, angle: 0 },
  { bit: DIR_N, angle: Math.PI / 2 },
  { bit: DIR_W, angle: Math.PI },
  { bit: DIR_S, angle: -Math.PI / 2 },
];

/**
 * Tracks: per track tile one half-segment per connection bit (an
 * isolated tile gets an east and a west stub), a centre block, rails
 * without ballast on road tiles (level crossing) and a deck under
 * tiles that bridge the river. Rebuilt from the diffs like the lines.
 */
export class RailMesh implements DiffLayer {
  private readonly segments: THREE.InstancedMesh;
  private readonly crossings: THREE.InstancedMesh;
  private readonly centres: THREE.InstancedMesh;
  private readonly decks: THREE.InstancedMesh;
  private readonly masks: Uint8Array;
  private readonly tileTypes: Uint8Array;
  private readonly terrains: Uint8Array;
  private readonly dummy = new THREE.Object3D();

  constructor(
    scene: THREE.Scene,
    private readonly gridSize: number,
    private readonly elevation: ElevationField,
  ) {
    const tiles = gridSize * gridSize;
    this.masks = new Uint8Array(tiles);
    this.tileTypes = new Uint8Array(tiles);
    this.terrains = new Uint8Array(tiles);
    const make = (geometry: THREE.BufferGeometry, color: number, count: number) => {
      const mesh = new THREE.InstancedMesh(
        geometry,
        new THREE.MeshLambertMaterial({ color }),
        count,
      );
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.count = 0;
      scene.add(mesh);
      return mesh;
    };
    this.segments = make(segmentGeometry(true), BALLAST_COLOR, tiles * 4);
    this.crossings = make(segmentGeometry(false), RAIL_COLOR, tiles * 4);
    this.centres = make(centreGeometry(), BALLAST_COLOR, tiles);
    this.decks = make(new THREE.BoxGeometry(1, DECK_HEIGHT, 0.5), DECK_COLOR, tiles);
  }

  hasRail(index: number): boolean {
    return this.masks[index] !== 0;
  }

  applyDiffs(diffs: TileDiff[]): void {
    let changed = false;
    for (const diff of diffs) {
      if (this.masks[diff.index] !== diff.rail) {
        this.masks[diff.index] = diff.rail;
        changed = true;
      }
      if (this.tileTypes[diff.index] !== diff.tileType) {
        this.tileTypes[diff.index] = diff.tileType;
        if (diff.rail !== 0) changed = true;
      }
      if (this.terrains[diff.index] !== diff.terrain) {
        this.terrains[diff.index] = diff.terrain;
        if (diff.rail !== 0) changed = true;
      }
    }
    if (changed) this.rebuild();
  }

  private baseY(index: number, x: number, z: number): number {
    return this.terrains[index] === Terrain.River
      ? this.elevation.maxCornerY(index) + DECK_HEIGHT
      : this.elevation.surfaceY(x, z);
  }

  private rebuild(): void {
    let segments = 0;
    let crossings = 0;
    let centres = 0;
    let decks = 0;
    for (let index = 0; index < this.masks.length; index++) {
      const mask = this.masks[index];
      if (mask === 0) continue;
      const x = (index % this.gridSize) + 0.5;
      const z = Math.floor(index / this.gridSize) + 0.5;
      const onRoad = this.tileTypes[index] === TileType.Road;
      const y = this.baseY(index, x, z) + (onRoad ? CROSSING_LIFT : 0);
      const target = onRoad ? this.crossings : this.segments;
      const bits = mask & (DIR_N | DIR_E | DIR_S | DIR_W);
      const directions =
        bits === 0
          ? [DIRECTION_ANGLE[0], DIRECTION_ANGLE[2]]
          : DIRECTION_ANGLE.filter((d) => (bits & d.bit) !== 0);
      for (const { angle } of directions) {
        this.dummy.position.set(x, y, z);
        this.dummy.rotation.set(0, angle, 0);
        this.dummy.scale.set(1, 1, 1);
        this.dummy.updateMatrix();
        target.setMatrixAt(onRoad ? crossings++ : segments++, this.dummy.matrix);
      }
      if (!onRoad) {
        this.dummy.position.set(x, y, z);
        this.dummy.rotation.set(0, 0, 0);
        this.dummy.updateMatrix();
        this.centres.setMatrixAt(centres++, this.dummy.matrix);
      }
      if (this.terrains[index] === Terrain.River) {
        const horizontal = (bits & (DIR_E | DIR_W)) !== 0 || bits === 0;
        this.dummy.position.set(x, this.elevation.maxCornerY(index) + DECK_HEIGHT / 2, z);
        this.dummy.rotation.set(0, horizontal ? 0 : Math.PI / 2, 0);
        this.dummy.updateMatrix();
        this.decks.setMatrixAt(decks++, this.dummy.matrix);
      }
    }
    this.segments.count = segments;
    this.crossings.count = crossings;
    this.centres.count = centres;
    this.decks.count = decks;
    for (const mesh of [this.segments, this.crossings, this.centres, this.decks]) {
      mesh.instanceMatrix.needsUpdate = true;
    }
  }
}
