import * as THREE from 'three';
import { OVERPASS_LONG_RAMP_TILES } from '../shared/constants.ts';
import { DIR_E, DIR_N, DIR_S, DIR_W, DIRECTIONS } from '../shared/grid.ts';
import type { TileDiff } from '../shared/types.ts';
import { RoadClass, Terrain, TileType } from '../shared/types.ts';
import { PALETTE } from './scene.ts';
import type { DiffLayer, RenderEnvironment } from './renderer.ts';
import type { ElevationField } from './elevationField.ts';
import { composeBoxOnGround, composePrismOnGround, createHalfTilePrism } from './decal.ts';
import { surfaceMaterial } from './materials.ts';
import { GrowingMesh } from './plants/growingMesh.ts';
import {
  KERB_WIDTH,
  kerbPieces,
  LAMP_FOOT_SIZE,
  lampModel,
  shelterGeometry,
  shelterPlacement,
  zebraPieces,
  type FlatPiece,
} from './infrastructure/roadFurniture.ts';

/** Thickness of the asphalt: the road surface stands this high above the ground. */
export const ROAD_HEIGHT = 0.05;
/** Width of a street's centre pad and arms (the roadway). */
export const CENTER_SIZE = 0.62;
/** Instances per road tile: 1 center + up to 4 arms. */
const INSTANCES_PER_TILE = 5;

/** Avenue tiles get a wider pad and arms than streets. */
export const AVENUE_CENTER_SIZE = 0.8;

/** Half the roadway width of a road tile: its pad and arms are this far either side of the centre line. */
export function roadHalfWidth(roadClass: number): number {
  return (roadClass === RoadClass.Avenue ? AVENUE_CENTER_SIZE : CENTER_SIZE) / 2;
}
/** Width of the solid centre line painted along avenue arms. */
const LINE_WIDTH = 0.022;
/** Avenue centre line: dashes per arm (centre to tile edge) and their length. */
const LINE_DASHES_PER_ARM = 2;
const LINE_DASH_LENGTH = 0.15;
const LINE_COLOR = 0xe8e2c8;
const LINE_HEIGHT = 0.012;

/** Connection bits of a track mask (the rest flag presence). */
const TRACK_SIDES = DIR_N | DIR_E | DIR_S | DIR_W;

const KERB_COLOR = 0xc9c6bd;
/** Kerbs stand this far above the asphalt. */
const KERB_RISE = 0.015;

/** Kerbs and zebra stripes lie flat: transforms span the grid, so no culling; no shadows. */
/**
 * A wedge one unit long (x), one high (y) and one wide (z), centred on
 * x and z, standing on y = 0 with its slope rising from x = −0.5 to the
 * full height at x = +0.5. Faces wound counter-clockwise seen from
 * outside; flat normals per face.
 */
function createWedgeGeometry(): THREE.BufferGeometry {
  // prettier-ignore
  const positions = new Float32Array([
    // bottom (y = 0), facing down
    -0.5, 0, -0.5,   0.5, 0,  0.5,  -0.5, 0,  0.5,
    -0.5, 0, -0.5,   0.5, 0, -0.5,   0.5, 0,  0.5,
    // back (x = 0.5), facing +x
     0.5, 0, -0.5,   0.5, 1, -0.5,   0.5, 1,  0.5,
     0.5, 0, -0.5,   0.5, 1,  0.5,   0.5, 0,  0.5,
    // slope, facing up and -x
    -0.5, 0, -0.5,   0.5, 1,  0.5,   0.5, 1, -0.5,
    -0.5, 0, -0.5,  -0.5, 0,  0.5,   0.5, 1,  0.5,
    // side (z = -0.5), facing -z
    -0.5, 0, -0.5,   0.5, 1, -0.5,   0.5, 0, -0.5,
    // side (z = 0.5), facing +z
    -0.5, 0,  0.5,   0.5, 0,  0.5,   0.5, 1,  0.5,
  ]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** Railings and ramp walls stand up and cast shadows; transforms span the grid, so no culling. */
function setupRailing(mesh: THREE.InstancedMesh): void {
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
}

function setupFlat(mesh: THREE.InstancedMesh): void {
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
}

/** Streetlamps stand at this tile-local corner offset (south-east of the centre). */
const LAMP_CORNER = 0.38;
/** Room kept between the roadway's edge and the lamp's foot on wide roads. */
const LAMP_KERB_CLEARANCE = KERB_WIDTH + 0.015;

/**
 * Offset from the tile centre (along both axes) of a kerbside corner
 * post: the usual corner, or on wide roads just beyond the roadway's
 * kerb, with room for a foot of `footRadius`. Streetlamps take the
 * south-east corner, power poles the north-west one (powerLinesMesh).
 */
export function kerbsideCorner(roadClass: number, footRadius = 0): number {
  return Math.max(LAMP_CORNER, roadHalfWidth(roadClass) + LAMP_KERB_CLEARANCE + footRadius);
}
const LAMP_GLOW_RADIUS = 0.03;
/** The lamp's arm (local +x) points from its corner back to the tile centre. */
const LAMP_YAW = (3 * Math.PI) / 4;

/** Lamps cast shadows; transforms span the grid, so no culling. */
function setupLamp(mesh: THREE.InstancedMesh): void {
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
}

/** Unlit glows cast nothing; transforms span the grid, so no culling. */
function setupGlow(mesh: THREE.InstancedMesh): void {
  mesh.frustumCulled = false;
}

const DECK_COLOR = 0x8a9099;
const RAIL_COLOR = 0xd8d8d0;
export const DECK_SIZE = 0.96;
const DECK_HEIGHT = 0.04;
/**
 * Road surface of an overpass deck above the tile's ground; ramps climb
 * to it over the ramp length the sim stored on the deck. Clears a locomotive's pantograph (0.33 with the
 * vehicles' ground offset) under the deck.
 */
export const OVERPASS_LIFT = 0.36;
/**
 * A ramp tile: the unit step toward its deck, how many tiles away the
 * deck is (1 = next to it), and the ramp's length in tiles with the
 * rise per tile, pitch and slope stretch that follow from it.
 */
interface Ramp {
  dx: number;
  dz: number;
  step: number;
  length: number;
  rise: number;
  pitch: number;
  stretch: number;
}

/** Rise, pitch and stretch per ramp length (index = tiles; 0 unused). */
const RAMP_SHAPES = Array.from({ length: OVERPASS_LONG_RAMP_TILES + 1 }, (_, length) => {
  const rise = length > 0 ? OVERPASS_LIFT / length : 0;
  return { rise, pitch: Math.atan2(rise, 1), stretch: Math.hypot(1, rise) };
});
/** Thickness of a bridge railing, standing on the deck's edge. */
export const RAIL_THICKNESS = 0.06;
const RAIL_HEIGHT = 0.14;

const SHELTER_COLOR = 0x4a5560;
const SIGN_COLOR = 0xf2d16b;

/** Whether a bridge with this road mask is straight (or a dead end): only those get railings. */
function hasRailings(mask: number): boolean {
  const alongZ = (mask & (DIR_N | DIR_S)) !== 0 && (mask & (DIR_E | DIR_W)) === 0;
  const alongX = (mask & (DIR_E | DIR_W)) !== 0 && (mask & (DIR_N | DIR_S)) === 0;
  return alongX || alongZ;
}

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
  /** Kerbs along the open edges of land road tiles. */
  readonly kerbs: GrowingMesh;
  /** Zebra crossings on the arms of land junctions without track. */
  readonly stripes: GrowingMesh;
  /** Streetlamp models (pole, arm, housing). */
  readonly lampPoles: GrowingMesh;
  /** The lamps' glows, under each housing. */
  readonly lampHeads: GrowingMesh;
  private readonly lampHeadMaterial: THREE.MeshBasicMaterial;
  /** Deck slabs under river bridges and overpasses, wedges under ramps. */
  readonly decks: THREE.InstancedMesh;
  /** Railings of bridges and decks, walls of ramps. */
  readonly rails: GrowingMesh;
  /** Solid wedges under the overpass ramps. */
  readonly wedges: THREE.InstancedMesh;
  readonly shelters: THREE.InstancedMesh;
  private readonly signs: THREE.InstancedMesh;
  private readonly signMaterial: THREE.MeshBasicMaterial;
  private readonly gridSize: number;
  private readonly roadMasks: Int16Array; // -1 = no road, else mask 0..15
  private readonly roadClasses: Uint8Array;
  private readonly terrain: Uint8Array;
  private readonly busStops: Uint8Array;
  /** Track mask per tile: a road tile with track is a level crossing. */
  private readonly track: Uint8Array;
  private readonly matrix = new THREE.Matrix4();
  /** 1 where a road overpass carries the road over the track. */
  private readonly overpass: Uint8Array;
  private readonly rampEuler = new THREE.Euler();
  private readonly rampQuaternion = new THREE.Quaternion();
  private readonly rampPosition = new THREE.Vector3();
  private readonly rampScale = new THREE.Vector3();

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
    this.track = new Uint8Array(gridSize * gridSize);
    this.overpass = new Uint8Array(gridSize * gridSize);
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

    this.kerbs = new GrowingMesh(
      scene,
      geometry,
      surfaceMaterial({ color: KERB_COLOR }),
      setupFlat,
    );
    // Lit like the centre line, so the paint darkens at night too.
    this.stripes = new GrowingMesh(
      scene,
      geometry,
      surfaceMaterial({ color: LINE_COLOR }),
      setupFlat,
    );

    this.lampPoles = new GrowingMesh(
      scene,
      lampModel().geometry,
      surfaceMaterial({ vertexColors: true }),
      setupLamp,
    );
    this.lampHeadMaterial = new THREE.MeshBasicMaterial({
      color: 0xffe3a1,
      transparent: true,
      opacity: 0.25,
    });
    this.lampHeads = new GrowingMesh(
      scene,
      new THREE.SphereGeometry(LAMP_GLOW_RADIUS, 6, 4),
      this.lampHeadMaterial,
      setupGlow,
    );

    this.shelters = new THREE.InstancedMesh(
      shelterGeometry(),
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

    // River bridges are bounded by the river (roughly gridSize tiles);
    // overpasses add railings and ramp walls on demand, so the mesh grows.
    this.rails = new GrowingMesh(
      scene,
      deckGeometry,
      surfaceMaterial({ color: RAIL_COLOR }),
      setupRailing,
      gridSize * 4,
    );
    this.wedges = new THREE.InstancedMesh(
      createWedgeGeometry(),
      surfaceMaterial({ color: DECK_COLOR }),
      gridSize * gridSize,
    );
    // Instance transforms live across the whole grid; the base geometry's
    // bounds would wrongly cull the mesh, so culling is disabled.
    this.wedges.frustumCulled = false;
    this.wedges.castShadow = true;
    this.wedges.receiveShadow = true;
    this.wedges.count = 0;
    scene.add(this.wedges);
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
      if (this.track[diff.index] !== diff.rail) {
        this.track[diff.index] = diff.rail;
        if (mask >= 0) changed = true;
      }
      const overpass = diff.tileType === TileType.Road ? diff.overpass : 0;
      if (this.overpass[diff.index] !== overpass) {
        this.overpass[diff.index] = overpass;
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

      const ramp = this.rampOf(index);
      if (ramp) {
        // One pitched carriageway from the far edge up to the deck edge.
        this.rampMatrix(index, ramp, 0, 0, 1, ROAD_HEIGHT, size, 0);
        this.mesh.setMatrixAt(count++, this.matrix);
        if (isAvenue) {
          const dashes = 2 * LINE_DASHES_PER_ARM;
          const gap = (1 - dashes * LINE_DASH_LENGTH) / dashes;
          for (let dash = 0; dash < dashes; dash++) {
            const a = -0.5 + gap / 2 + LINE_DASH_LENGTH / 2 + dash * (LINE_DASH_LENGTH + gap);
            this.rampMatrix(
              index,
              ramp,
              a,
              0,
              LINE_DASH_LENGTH,
              LINE_HEIGHT,
              LINE_WIDTH,
              ROAD_HEIGHT,
            );
            this.centreLines.setMatrixAt(lineCount++, this.matrix);
          }
        }
        continue;
      }

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
    this.rebuildFurniture();
    this.rebuildLamps();
    this.rebuildShelters();
    this.rebuildBridges();
  }

  /**
   * Kerbs on every land road tile; zebra crossings on land junctions
   * except level crossings, where the rails run across the arms. Bridges
   * have railings instead.
   */
  private rebuildFurniture(): void {
    let kerbCount = 0;
    let stripeCount = 0;
    for (let index = 0; index < this.roadMasks.length; index++) {
      const mask = this.roadMasks[index];
      if (mask < 0 || this.isBridge(index) || this.rampOf(index)) continue;
      const size = roadHalfWidth(this.roadClasses[index]) * 2;
      // No kerb across the rails where the track leaves a level crossing.
      const kerbs = kerbPieces(mask, size, this.track[index] & TRACK_SIDES);
      this.kerbs.ensure(kerbCount + kerbs.length);
      for (const piece of kerbs) {
        this.layFlat(index, piece, ROAD_HEIGHT + KERB_RISE, 0);
        this.kerbs.mesh.setMatrixAt(kerbCount++, this.matrix);
      }
      if (this.track[index] !== 0) continue;
      const stripes = zebraPieces(mask, size);
      this.stripes.ensure(stripeCount + stripes.length);
      for (const piece of stripes) {
        this.layFlat(index, piece, LINE_HEIGHT, ROAD_HEIGHT);
        this.stripes.mesh.setMatrixAt(stripeCount++, this.matrix);
      }
    }
    this.kerbs.commit(kerbCount);
    this.stripes.commit(stripeCount);
  }

  /** A tile-local flat piece as a box on the ground triangle under it. */
  private layFlat(index: number, piece: FlatPiece, sizeY: number, lift: number): void {
    const x = (index % this.gridSize) + 0.5 + piece.cx;
    const z = Math.floor(index / this.gridSize) + 0.5 + piece.cz;
    composeBoxOnGround(
      this.matrix,
      this.elevation,
      index,
      x,
      z,
      piece.sizeX,
      sizeY,
      piece.sizeZ,
      lift,
    );
  }

  /**
   * One streetlamp on every other road tile, at a fixed corner beside
   * the roadway, its arm reaching over the road toward the tile centre.
   * Level crossings and straight avenue bridges go without. The bus
   * shelter keeps clear of the lamp's (south-east) corner.
   */
  private rebuildLamps(): void {
    const head = lampModel().head;
    const yaw = new THREE.Matrix4().makeRotationY(LAMP_YAW);
    const reach = new THREE.Vector3(head.x, head.y, head.z).applyMatrix4(yaw);
    let count = 0;
    for (let index = 0; index < this.roadMasks.length; index++) {
      if (this.roadMasks[index] < 0) continue;
      const x = index % this.gridSize;
      const y = Math.floor(index / this.gridSize);
      if ((x + y) % 2 !== 0) continue;
      // Level crossings carry their own barriers and signals at the corners.
      if (this.track[index] !== 0) continue;
      // No lamp on an overpass deck or its ramps.
      if (this.overpass[index] !== 0 || this.rampOf(index)) continue;
      // Avenues are wide enough to reach the usual corner: step back to the kerb.
      const offset = kerbsideCorner(this.roadClasses[index]);
      // A straight bridge has railings along its sides: an avenue's lamp
      // corner lies in them, and there is no room between the roadway and
      // the railing to step in, so such bridges go without a lamp.
      const railed = this.isBridge(index) && hasRailings(this.roadMasks[index]);
      if (railed && offset + LAMP_FOOT_SIZE / 2 > DECK_SIZE / 2 - RAIL_THICKNESS) continue;
      const corner = 0.5 + offset;
      const px = x + corner;
      const pz = y + corner;
      // Poles stand upright on the ground under their own corner.
      const lift = this.isBridge(index) ? this.flatLift(index) : this.elevation.surfaceY(px, pz);
      this.lampPoles.ensure(count + 1);
      this.lampHeads.ensure(count + 1);
      this.matrix.copy(yaw).setPosition(px, lift, pz);
      this.lampPoles.mesh.setMatrixAt(count, this.matrix);
      this.matrix.makeTranslation(px + reach.x, lift + reach.y, pz + reach.z);
      this.lampHeads.mesh.setMatrixAt(count, this.matrix);
      count++;
    }
    this.lampPoles.commit(count);
    this.lampHeads.commit(count);
  }

  /** One shelter with a lit sign beyond the kerb of every stop tile (see shelterPlacement). */
  private rebuildShelters(): void {
    let count = 0;
    for (let index = 0; index < this.busStops.length; index++) {
      const mask = this.roadMasks[index];
      if (this.busStops[index] === 0 || mask < 0) continue;
      // No shelter on an overpass deck or its ramps; the stop keeps its sign.
      if (this.overpass[index] !== 0 || this.rampOf(index)) continue;
      const railed = this.isBridge(index) && hasRailings(mask);
      const { dx, dz, yaw } = shelterPlacement(
        mask,
        this.track[index],
        railed ? DECK_SIZE / 2 - RAIL_THICKNESS : undefined,
      );
      const px = (index % this.gridSize) + 0.5 + dx;
      const pz = Math.floor(index / this.gridSize) + 0.5 + dz;
      const lift = this.isBridge(index) ? this.flatLift(index) : this.elevation.surfaceY(px, pz);
      this.matrix.makeRotationY(yaw);
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

  /** Whether the tile carries a road overpass (for the tool's cost preview). */
  hasOverpass(index: number): boolean {
    return this.overpass[index] !== 0;
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
    let wedgeCount = 0;
    const offset = DECK_SIZE / 2 - RAIL_THICKNESS / 2;
    for (let index = 0; index < this.roadMasks.length; index++) {
      const mask = this.roadMasks[index];
      if (mask < 0) continue;
      const ramp = this.rampOf(index);
      if (ramp) {
        // A solid wedge one rise high under the pitched carriageway (its
        // rising edge, local +x, turned toward the deck), on a plinth of
        // the rises already climbed, and a low wall per side.
        const cx = (index % this.gridSize) + 0.5;
        const cz = Math.floor(index / this.gridSize) + 0.5;
        const ground = this.elevation.maxCornerY(index);
        const climbed = ramp.rise * (ramp.length - ramp.step);
        if (climbed > 0) {
          this.matrix.makeScale(1, climbed, DECK_SIZE);
          if (ramp.dx === 0) this.matrix.makeScale(DECK_SIZE, climbed, 1);
          this.matrix.setPosition(cx, ground + climbed / 2, cz);
          this.decks.setMatrixAt(deckCount++, this.matrix);
        }
        this.rampPosition.set(cx, ground + climbed, cz);
        this.rampEuler.set(0, Math.atan2(-ramp.dz, ramp.dx), 0);
        this.rampQuaternion.setFromEuler(this.rampEuler);
        this.rampScale.set(1, ramp.rise, DECK_SIZE);
        this.matrix.compose(this.rampPosition, this.rampQuaternion, this.rampScale);
        this.wedges.setMatrixAt(wedgeCount++, this.matrix);
        for (const side of [-1, 1]) {
          this.rails.ensure(railCount + 1);
          this.rampMatrix(index, ramp, 0, side * offset, 1, RAIL_HEIGHT, RAIL_THICKNESS, 0);
          this.rails.mesh.setMatrixAt(railCount++, this.matrix);
        }
        continue;
      }
      if (!this.isBridge(index)) continue;
      const x = (index % this.gridSize) + 0.5;
      const z = Math.floor(index / this.gridSize) + 0.5;
      const lift = this.flatLift(index);
      this.matrix.makeScale(DECK_SIZE, DECK_HEIGHT, DECK_SIZE);
      this.matrix.setPosition(x, DECK_HEIGHT / 2 + lift, z);
      this.decks.setMatrixAt(deckCount++, this.matrix);

      if (!hasRailings(mask)) continue;
      const alongZ = (mask & (DIR_N | DIR_S)) !== 0 && (mask & (DIR_E | DIR_W)) === 0;
      for (const side of [-1, 1]) {
        if (alongZ) {
          this.matrix.makeScale(RAIL_THICKNESS, RAIL_HEIGHT, DECK_SIZE);
          this.matrix.setPosition(x + side * offset, RAIL_HEIGHT / 2 + lift, z);
        } else {
          this.matrix.makeScale(DECK_SIZE, RAIL_HEIGHT, RAIL_THICKNESS);
          this.matrix.setPosition(x, RAIL_HEIGHT / 2 + lift, z + side * offset);
        }
        this.rails.ensure(railCount + 1);
        this.rails.mesh.setMatrixAt(railCount++, this.matrix);
      }
    }
    this.decks.count = deckCount;
    this.decks.instanceMatrix.needsUpdate = true;
    this.wedges.count = wedgeCount;
    this.wedges.instanceMatrix.needsUpdate = true;
    this.rails.commit(railCount);
  }

  /**
   * Bridges (over the river) and overpass decks are flat slabs at
   * `flatLift`; everything else lies on the ground triangles.
   */
  private isBridge(index: number): boolean {
    return this.terrain[index] === Terrain.River || this.overpass[index] !== 0;
  }

  /** Height of a flat tile's road base: the bank for a river bridge, the lifted deck for an overpass. */
  private flatLift(index: number): number {
    return this.elevation.maxCornerY(index) + (this.overpass[index] !== 0 ? OVERPASS_LIFT : 0);
  }

  /**
   * The ramp a road tile belongs to, or null: within the ramp length
   * stored on an overpass deck along the deck's road, with straight road
   * (or the ramp's own end) all the way.
   */
  private rampOf(index: number): Ramp | null {
    if (this.roadMasks[index] < 0 || this.overpass[index] !== 0) return null;
    const x = index % this.gridSize;
    const z = Math.floor(index / this.gridSize);
    for (const { dx, dy, bit } of DIRECTIONS) {
      if ((this.roadMasks[index] & bit) === 0) continue;
      const back = dx > 0 ? DIR_W : dx < 0 ? DIR_E : dy > 0 ? DIR_N : DIR_S;
      for (let step = 1; step <= OVERPASS_LONG_RAMP_TILES; step++) {
        const nx = x + dx * step;
        const nz = z + dy * step;
        if (nx < 0 || nz < 0 || nx >= this.gridSize || nz >= this.gridSize) break;
        const tile = nz * this.gridSize + nx;
        if (this.roadMasks[tile] < 0 || (this.roadMasks[tile] & back) === 0) break;
        const length = Math.min(this.overpass[tile], OVERPASS_LONG_RAMP_TILES);
        if (length !== 0) {
          if (step > length) break;
          return { dx, dz: dy, step, length, ...RAMP_SHAPES[length] };
        }
        // An intermediate ramp tile must carry the road on toward the deck.
        if ((this.roadMasks[tile] & bit) === 0) break;
      }
    }
    return null;
  }

  /** Extra height of the road surface over the ground at a world point (0 off deck and ramps). */
  lift(x: number, y: number): number {
    const size = this.gridSize;
    const tx = Math.floor(x);
    const tz = Math.floor(y);
    if (tx < 0 || tz < 0 || tx >= size || tz >= size) return 0;
    const index = tz * size + tx;
    if (this.overpass[index] !== 0 && this.roadMasks[index] >= 0) return OVERPASS_LIFT;
    const ramp = this.rampOf(index);
    if (!ramp) return 0;
    const fx = x - tx;
    const fz = y - tz;
    const t = ramp.dx > 0 ? fx : ramp.dx < 0 ? 1 - fx : ramp.dz > 0 ? fz : 1 - fz;
    return ramp.rise * (ramp.length - ramp.step + t);
  }

  /**
   * A box on a ramp: centred `a` along the ramp (−0.5 far edge … +0.5 deck
   * edge) and `across` beside its centre line, its base `baseLift` above
   * the ramp surface, pitched with the ramp and stretched to its length.
   */
  private rampMatrix(
    index: number,
    ramp: Ramp,
    a: number,
    across: number,
    sizeAlong: number,
    sizeY: number,
    sizeAcross: number,
    baseLift: number,
  ): void {
    const cx = (index % this.gridSize) + 0.5;
    const cz = Math.floor(index / this.gridSize) + 0.5;
    const ground = this.elevation.maxCornerY(index) + ramp.rise * (ramp.length - ramp.step);
    const y = ground + ramp.rise * (a + 0.5) + baseLift + sizeY / 2;
    const alongX = ramp.dx !== 0;
    const px = cx + (alongX ? ramp.dx * a : across);
    const pz = cz + (alongX ? across : ramp.dz * a);
    // Rz(+θ) lifts the +x end; Rx(−θ) lifts the +z end.
    this.rampEuler.set(alongX ? 0 : -ramp.dz * ramp.pitch, 0, alongX ? ramp.dx * ramp.pitch : 0);
    this.rampQuaternion.setFromEuler(this.rampEuler);
    this.rampScale.set(
      alongX ? sizeAlong * ramp.stretch : sizeAcross,
      sizeY,
      alongX ? sizeAcross : sizeAlong * ramp.stretch,
    );
    this.rampPosition.set(px, y, pz);
    this.matrix.compose(this.rampPosition, this.rampQuaternion, this.rampScale);
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
      this.matrix.setPosition(x, ROAD_HEIGHT / 2 + this.flatLift(index), z);
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
      this.matrix.setPosition(x, ROAD_HEIGHT + LINE_HEIGHT / 2 + this.flatLift(index), z);
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
