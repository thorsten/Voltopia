import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { DIR_E, DIR_N, DIR_S, DIR_W, DIRECTIONS } from '../shared/grid.ts';
import type { TileDiff } from '../shared/types.ts';
import { RoadClass, Terrain, TileType } from '../shared/types.ts';
import { PALETTE } from './scene.ts';
import type { DiffLayer, RenderEnvironment } from './renderer.ts';
import type { ElevationField } from './elevationField.ts';
import { composeBoxOnGround, composePrismOnGround, createHalfTilePrism } from './decal.ts';
import { surfaceMaterial } from './materials.ts';

const ROAD_HEIGHT = 0.05;
const CENTER_SIZE = 0.62;
/** Instances per road tile: 1 center + up to 4 arms. */
const INSTANCES_PER_TILE = 5;

/** Avenue tiles get a wider pad and arms than streets. */
const AVENUE_CENTER_SIZE = 0.8;
/** Width of the solid centre line painted along avenue arms. */
const LINE_WIDTH = 0.022;
/** Avenue centre line: dashes per arm (centre to tile edge) and their length. */
const LINE_DASHES_PER_ARM = 2;
const LINE_DASH_LENGTH = 0.15;
const LINE_COLOR = 0xe8e2c8;
const LINE_HEIGHT = 0.012;

const DECK_COLOR = 0x8a9099;
const RAIL_COLOR = 0xd8d8d0;
const DECK_SIZE = 0.96;
const DECK_HEIGHT = 0.04;
const RAIL_THICKNESS = 0.06;
const RAIL_HEIGHT = 0.14;

const SHELTER_COLOR = 0x4a5560;
const SIGN_COLOR = 0xf2d16b;
/** Shelter stands at the south-west kerb, clear of the lamp corner (north-east). */
const SHELTER_OFFSET_X = 0.16;
const SHELTER_OFFSET_Z = 0.84;

/**
 * Instanced road tiles. Each road tile is composed of a center pad plus an
 * arm toward every connected neighbor, so straights, curves, T-junctions,
 * crossings and dead ends emerge automatically from the connection mask.
 */
export class RoadsMesh implements DiffLayer {
  readonly mesh: THREE.InstancedMesh;
  /** Centre pads on land: two prisms per tile, each flush with one ground triangle. */
  private readonly pads: THREE.InstancedMesh;
  private readonly centreLines: THREE.InstancedMesh;
  private readonly lampPoles: THREE.InstancedMesh;
  private readonly lampHeads: THREE.InstancedMesh;
  private readonly lampHeadMaterial: THREE.MeshBasicMaterial;
  private readonly decks: THREE.InstancedMesh;
  private readonly rails: THREE.InstancedMesh;
  private readonly shelters: THREE.InstancedMesh;
  private readonly signs: THREE.InstancedMesh;
  private readonly signMaterial: THREE.MeshBasicMaterial;
  private readonly gridSize: number;
  private readonly roadMasks: Int16Array; // -1 = no road, else mask 0..15
  private readonly roadClasses: Uint8Array;
  private readonly terrain: Uint8Array;
  private readonly busStops: Uint8Array;
  private readonly matrix = new THREE.Matrix4();

  constructor(
    scene: THREE.Scene,
    gridSize: number,
    private readonly elevation: ElevationField,
  ) {
    this.gridSize = gridSize;
    this.roadMasks = new Int16Array(gridSize * gridSize).fill(-1);
    this.roadClasses = new Uint8Array(gridSize * gridSize);
    this.terrain = new Uint8Array(gridSize * gridSize);
    this.busStops = new Uint8Array(gridSize * gridSize);
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = surfaceMaterial({ color: PALETTE.road });
    this.mesh = new THREE.InstancedMesh(
      geometry,
      material,
      gridSize * gridSize * INSTANCES_PER_TILE,
    );
    // Instance transforms live across the whole grid; the base geometry's
    // bounds would wrongly cull the mesh, so culling is disabled.
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.count = 0;
    scene.add(this.mesh);

    this.pads = new THREE.InstancedMesh(createHalfTilePrism(), material, gridSize * gridSize * 2);
    // Instance transforms live across the whole grid; the base geometry's
    // bounds would wrongly cull the mesh, so culling is disabled.
    this.pads.frustumCulled = false;
    this.pads.receiveShadow = true;
    this.pads.count = 0;
    scene.add(this.pads);

    // Lit like the road so the paint darkens at night instead of glowing.
    this.centreLines = new THREE.InstancedMesh(
      geometry,
      surfaceMaterial({ color: LINE_COLOR }),
      gridSize * gridSize * 4 * LINE_DASHES_PER_ARM,
    );
    // Instance transforms live across the whole grid; the base geometry's
    // bounds would wrongly cull the mesh, so culling is disabled.
    this.centreLines.frustumCulled = false;
    this.centreLines.count = 0;
    scene.add(this.centreLines);

    const poleGeometry = new THREE.BoxGeometry(0.035, 0.3, 0.035);
    poleGeometry.translate(0, 0.15, 0);
    const poleMaterial = surfaceMaterial({ color: 0x3a4048 });
    this.lampPoles = new THREE.InstancedMesh(poleGeometry, poleMaterial, gridSize * gridSize);
    // Instance transforms live across the whole grid; the base geometry's
    // bounds would wrongly cull the mesh, so culling is disabled.
    this.lampPoles.frustumCulled = false;
    this.lampPoles.count = 0;
    scene.add(this.lampPoles);

    const headGeometry = new THREE.SphereGeometry(0.045, 6, 4);
    this.lampHeadMaterial = new THREE.MeshBasicMaterial({
      color: 0xffe3a1,
      transparent: true,
      opacity: 0.25,
    });
    this.lampHeads = new THREE.InstancedMesh(
      headGeometry,
      this.lampHeadMaterial,
      gridSize * gridSize,
    );
    // Instance transforms live across the whole grid; the base geometry's
    // bounds would wrongly cull the mesh, so culling is disabled.
    this.lampHeads.frustumCulled = false;
    this.lampHeads.count = 0;
    scene.add(this.lampHeads);

    const post1 = new THREE.BoxGeometry(0.03, 0.22, 0.03);
    post1.translate(-0.09, 0.11, 0);
    const post2 = new THREE.BoxGeometry(0.03, 0.22, 0.03);
    post2.translate(0.09, 0.11, 0);
    const roof = new THREE.BoxGeometry(0.26, 0.03, 0.14);
    roof.translate(0, 0.23, 0);
    const shelterGeometry = mergeGeometries([post1, post2, roof]);
    this.shelters = new THREE.InstancedMesh(
      shelterGeometry,
      surfaceMaterial({ color: SHELTER_COLOR }),
      gridSize * gridSize,
    );
    // Instance transforms live across the whole grid; the base geometry's
    // bounds would wrongly cull the mesh, so culling is disabled.
    this.shelters.frustumCulled = false;
    this.shelters.count = 0;
    scene.add(this.shelters);

    const signGeometry = new THREE.BoxGeometry(0.06, 0.08, 0.01);
    signGeometry.translate(0.12, 0.3, 0);
    this.signMaterial = new THREE.MeshBasicMaterial({
      color: SIGN_COLOR,
      transparent: true,
      opacity: 0.6,
    });
    this.signs = new THREE.InstancedMesh(signGeometry, this.signMaterial, gridSize * gridSize);
    // Instance transforms live across the whole grid; the base geometry's
    // bounds would wrongly cull the mesh, so culling is disabled.
    this.signs.frustumCulled = false;
    this.signs.count = 0;
    scene.add(this.signs);

    const deckGeometry = new THREE.BoxGeometry(1, 1, 1);
    this.decks = new THREE.InstancedMesh(
      deckGeometry,
      surfaceMaterial({ color: DECK_COLOR }),
      gridSize * gridSize,
    );
    // Instance transforms live across the whole grid; the base geometry's
    // bounds would wrongly cull the mesh, so culling is disabled.
    this.decks.frustumCulled = false;
    this.decks.count = 0;
    scene.add(this.decks);

    // Bridges are bounded by the river, not the grid: the river is one
    // tile wide and crosses the map once (roughly gridSize tiles, with
    // margin for width/meanders), at most 2 rails per tile.
    this.rails = new THREE.InstancedMesh(
      deckGeometry,
      surfaceMaterial({ color: RAIL_COLOR }),
      gridSize * 4,
    );
    // Instance transforms live across the whole grid; the base geometry's
    // bounds would wrongly cull the mesh, so culling is disabled.
    this.rails.frustumCulled = false;
    this.rails.count = 0;
    scene.add(this.rails);
  }

  /** Streetlamps and stop signs glow warmly at night. */
  setEnvironment(environment: RenderEnvironment): void {
    this.lampHeadMaterial.opacity = 0.25 + 0.75 * environment.nightFactor;
    this.lampHeadMaterial.color.setHex(environment.nightFactor > 0.4 ? 0xffcf6e : 0xffe3a1);
    this.signMaterial.opacity = 0.6 + 0.4 * environment.nightFactor;
  }

  applyDiffs(diffs: TileDiff[]): void {
    let changed = false;
    for (const diff of diffs) {
      const mask = diff.tileType === TileType.Road ? diff.roadMask : -1;
      const roadClass = diff.tileType === TileType.Road ? diff.roadClass : 0;
      const busStop = diff.tileType === TileType.Road ? diff.busStop : 0;
      if (this.terrain[diff.index] !== diff.terrain) {
        this.terrain[diff.index] = diff.terrain;
        changed = true;
      }
      if (this.roadMasks[diff.index] !== mask) {
        this.roadMasks[diff.index] = mask;
        changed = true;
      }
      if (this.roadClasses[diff.index] !== roadClass) {
        this.roadClasses[diff.index] = roadClass;
        changed = true;
      }
      if (this.busStops[diff.index] !== busStop) {
        this.busStops[diff.index] = busStop;
        changed = true;
      }
    }
    if (changed) this.rebuild();
  }

  private rebuild(): void {
    let count = 0;
    let padCount = 0;
    let lineCount = 0;
    for (let index = 0; index < this.roadMasks.length; index++) {
      const mask = this.roadMasks[index];
      if (mask < 0) continue;
      const x = (index % this.gridSize) + 0.5;
      const z = Math.floor(index / this.gridSize) + 0.5;
      const isAvenue = this.roadClasses[index] === RoadClass.Avenue;
      const size = isAvenue ? AVENUE_CENTER_SIZE : CENTER_SIZE;
      const armLength = (1 - size) / 2;

      if (this.isBridge(index)) {
        this.setInstance(count++, index, x, z, size, size);
      } else {
        for (const high of [false, true]) {
          composePrismOnGround(this.matrix, this.elevation, index, high, size, ROAD_HEIGHT, 0);
          this.pads.setMatrixAt(padCount++, this.matrix);
        }
      }
      for (const { dx, dy, bit } of DIRECTIONS) {
        if ((mask & bit) === 0) continue;
        const offset = size / 2 + armLength / 2;
        this.setInstance(
          count++,
          index,
          x + dx * offset,
          z + dy * offset,
          dx !== 0 ? armLength : size,
          dy !== 0 ? armLength : size,
        );
        if (isAvenue) {
          // Dashed centre line from the tile centre to the edge: each dash
          // sits between half gaps, so neighbouring tiles meet with a full
          // gap at the edge and the crossing itself stays clear.
          const along = armLength + AVENUE_CENTER_SIZE / 2;
          const gap = (along - LINE_DASHES_PER_ARM * LINE_DASH_LENGTH) / LINE_DASHES_PER_ARM;
          for (let dash = 0; dash < LINE_DASHES_PER_ARM; dash++) {
            const dashOffset = gap / 2 + LINE_DASH_LENGTH / 2 + dash * (LINE_DASH_LENGTH + gap);
            if (dx !== 0) {
              this.setLineInstance(
                lineCount++,
                index,
                x + dx * dashOffset,
                z,
                LINE_DASH_LENGTH,
                LINE_WIDTH,
              );
            } else {
              this.setLineInstance(
                lineCount++,
                index,
                x,
                z + dy * dashOffset,
                LINE_WIDTH,
                LINE_DASH_LENGTH,
              );
            }
          }
        }
      }
    }
    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.pads.count = padCount;
    this.pads.instanceMatrix.needsUpdate = true;
    this.centreLines.count = lineCount;
    this.centreLines.instanceMatrix.needsUpdate = true;
    this.rebuildLamps();
    this.rebuildShelters();
    this.rebuildBridges();
  }

  /** One streetlamp on every other road tile, at a fixed corner. */
  private rebuildLamps(): void {
    let count = 0;
    for (let index = 0; index < this.roadMasks.length; index++) {
      if (this.roadMasks[index] < 0) continue;
      const x = index % this.gridSize;
      const y = Math.floor(index / this.gridSize);
      if ((x + y) % 2 !== 0) continue;
      const px = x + 0.88;
      const pz = y + 0.88;
      // Poles stand upright on the ground under their own corner.
      const lift = this.isBridge(index)
        ? this.elevation.maxCornerY(index)
        : this.elevation.surfaceY(px, pz);
      this.matrix.identity();
      this.matrix.setPosition(px, 0 + lift, pz);
      this.lampPoles.setMatrixAt(count, this.matrix);
      this.matrix.setPosition(px, 0.33 + lift, pz);
      this.lampHeads.setMatrixAt(count, this.matrix);
      count++;
    }
    this.lampPoles.count = count;
    this.lampHeads.count = count;
    this.lampPoles.instanceMatrix.needsUpdate = true;
    this.lampHeads.instanceMatrix.needsUpdate = true;
  }

  /** One shelter with a lit sign at the kerb of every stop tile. */
  private rebuildShelters(): void {
    let count = 0;
    for (let index = 0; index < this.busStops.length; index++) {
      if (this.busStops[index] === 0 || this.roadMasks[index] < 0) continue;
      const px = (index % this.gridSize) + SHELTER_OFFSET_X;
      const pz = Math.floor(index / this.gridSize) + SHELTER_OFFSET_Z;
      const lift = this.isBridge(index)
        ? this.elevation.maxCornerY(index)
        : this.elevation.surfaceY(px, pz);
      this.matrix.identity();
      this.matrix.setPosition(px, lift, pz);
      this.shelters.setMatrixAt(count, this.matrix);
      this.signs.setMatrixAt(count, this.matrix);
      count++;
    }
    this.shelters.count = count;
    this.signs.count = count;
    this.shelters.instanceMatrix.needsUpdate = true;
    this.signs.instanceMatrix.needsUpdate = true;
  }

  /** Whether a bus stop is marked on the tile (for the tool's cost preview). */
  hasBusStop(index: number): boolean {
    return this.busStops[index] !== 0;
  }

  /**
   * Roads on river tiles are bridges: a deck slab under the road pad and
   * a railing on each side of the carriageway. Rails only make sense
   * along a single straight axis, so only straight segments and dead
   * ends get them; tiles with connections on both axes (turns,
   * T-junctions, crossings) as well as isolated tiles get the deck only.
   */
  private rebuildBridges(): void {
    let deckCount = 0;
    let railCount = 0;
    for (let index = 0; index < this.roadMasks.length; index++) {
      const mask = this.roadMasks[index];
      if (mask < 0 || this.terrain[index] !== Terrain.River) continue;
      const x = (index % this.gridSize) + 0.5;
      const z = Math.floor(index / this.gridSize) + 0.5;
      const lift = this.elevation.maxCornerY(index);
      this.matrix.makeScale(DECK_SIZE, DECK_HEIGHT, DECK_SIZE);
      this.matrix.setPosition(x, DECK_HEIGHT / 2 + lift, z);
      this.decks.setMatrixAt(deckCount++, this.matrix);

      const alongZ = (mask & (DIR_N | DIR_S)) !== 0 && (mask & (DIR_E | DIR_W)) === 0;
      const alongX = (mask & (DIR_E | DIR_W)) !== 0 && (mask & (DIR_N | DIR_S)) === 0;
      if (!alongZ && !alongX) continue;
      const offset = DECK_SIZE / 2 - RAIL_THICKNESS / 2;
      for (const side of [-1, 1]) {
        if (alongZ) {
          this.matrix.makeScale(RAIL_THICKNESS, RAIL_HEIGHT, DECK_SIZE);
          this.matrix.setPosition(x + side * offset, RAIL_HEIGHT / 2 + lift, z);
        } else {
          this.matrix.makeScale(DECK_SIZE, RAIL_HEIGHT, RAIL_THICKNESS);
          this.matrix.setPosition(x, RAIL_HEIGHT / 2 + lift, z + side * offset);
        }
        this.rails.setMatrixAt(railCount++, this.matrix);
      }
    }
    this.decks.count = deckCount;
    this.rails.count = railCount;
    this.decks.instanceMatrix.needsUpdate = true;
    this.rails.instanceMatrix.needsUpdate = true;
  }

  /** Bridges are flat slabs at the bank's height; everything else lies on the ground triangles. */
  private isBridge(index: number): boolean {
    return this.terrain[index] === Terrain.River;
  }

  private setInstance(
    slot: number,
    index: number,
    x: number,
    z: number,
    sizeX: number,
    sizeZ: number,
  ): void {
    if (this.isBridge(index)) {
      this.matrix.makeScale(sizeX, ROAD_HEIGHT, sizeZ);
      this.matrix.setPosition(x, ROAD_HEIGHT / 2 + this.elevation.maxCornerY(index), z);
    } else {
      composeBoxOnGround(this.matrix, this.elevation, index, x, z, sizeX, ROAD_HEIGHT, sizeZ, 0);
    }
    this.mesh.setMatrixAt(slot, this.matrix);
  }

  private setLineInstance(
    slot: number,
    index: number,
    x: number,
    z: number,
    sizeX: number,
    sizeZ: number,
  ): void {
    if (this.isBridge(index)) {
      this.matrix.makeScale(sizeX, LINE_HEIGHT, sizeZ);
      this.matrix.setPosition(
        x,
        ROAD_HEIGHT + LINE_HEIGHT / 2 + this.elevation.maxCornerY(index),
        z,
      );
    } else {
      composeBoxOnGround(
        this.matrix,
        this.elevation,
        index,
        x,
        z,
        sizeX,
        LINE_HEIGHT,
        sizeZ,
        ROAD_HEIGHT,
      );
    }
    this.centreLines.setMatrixAt(slot, this.matrix);
  }

  /** RoadClass of the road tile at this index; -1 if there is no road. */
  roadClassAt(index: number): number {
    return this.roadMasks[index] < 0 ? -1 : this.roadClasses[index];
  }
}
