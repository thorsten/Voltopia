/**
 * Street furniture laid out per road tile: kerbs along the open edges of
 * the roadway and zebra crossings on the arms of junctions.
 *
 * Conventions: units are tiles; pieces are tile-local offsets from the
 * tile centre (x east, z south), flat rectangles the caller lays on the
 * ground. The lamp model stands on y = 0 with its arm along local +x.
 * The roadway is a square pad of `padSize` plus an arm of the
 * same width toward every connected neighbour (see roadsMesh.ts).
 */
import * as THREE from 'three';
import { DIR_E, DIR_N, DIR_S, DIR_W, DIRECTIONS } from '../../shared/grid.ts';
import { box, cylinder, merge } from '../modelKit.ts';

export interface FlatPiece {
  cx: number;
  cz: number;
  sizeX: number;
  sizeZ: number;
}

/** Width of a kerb strip, laid along the inside of the roadway's edge. */
export const KERB_WIDTH = 0.03;
/**
 * Kerbs stand this far proud of the roadway's edge, so their outer face
 * is not coplanar with the road slab's side (which would z-fight).
 */
export const KERB_OVERHANG = 0.003;
/** Zebra crossing: bars per arm, their width across and length along the traffic. */
export const ZEBRA_STRIPES = 4;
export const ZEBRA_STRIPE_WIDTH = 0.04;
export const ZEBRA_LENGTH = 0.12;
/** Junctions (this many connections or more) get zebra crossings. */
const ZEBRA_MIN_CONNECTIONS = 3;

const connections = (mask: number) => DIRECTIONS.filter(({ bit }) => (mask & bit) !== 0).length;

/**
 * Kerbs along every open edge of the roadway: each pad side without an
 * arm and both long sides of every arm.
 *
 * Every piece stays inside one ground triangle except the pad sides,
 * whose ends overlap the tile's crease by half a kerb width; laid on the
 * triangle of their centre, that end sits a hair off the ground on
 * slopes, which the kerb's rise hides.
 *
 * Pad sides in `openSides` (direction bits) stay open: at a level
 * crossing that is where the track leaves the tile.
 */
export function kerbPieces(mask: number, padSize: number, openSides = 0): FlatPiece[] {
  const half = padSize / 2;
  const armLength = (1 - padSize) / 2;
  const edge = half - KERB_WIDTH / 2 + KERB_OVERHANG;
  const armCentre = half + armLength / 2;
  const pieces: FlatPiece[] = [];
  for (const { dx, dy, bit } of DIRECTIONS) {
    if ((mask & bit) === 0) {
      if ((openSides & bit) !== 0) continue;
      pieces.push(
        dx !== 0
          ? { cx: dx * edge, cz: 0, sizeX: KERB_WIDTH, sizeZ: padSize }
          : { cx: 0, cz: dy * edge, sizeX: padSize, sizeZ: KERB_WIDTH },
      );
      continue;
    }
    for (const side of [-1, 1]) {
      pieces.push(
        dx !== 0
          ? { cx: dx * armCentre, cz: side * edge, sizeX: armLength, sizeZ: KERB_WIDTH }
          : { cx: side * edge, cz: dy * armCentre, sizeX: KERB_WIDTH, sizeZ: armLength },
      );
    }
  }
  return pieces;
}

/**
 * Zebra crossings on every arm of a junction: bars parallel to the
 * traffic, spread across the road width with equal gaps (also at both
 * kerbs), centred in the arm. Where the arm is shorter than a bar
 * (avenues), the bar ends at the tile edge and reaches into the pad.
 */
export function zebraPieces(mask: number, padSize: number): FlatPiece[] {
  if (connections(mask) < ZEBRA_MIN_CONNECTIONS) return [];
  const half = padSize / 2;
  const armLength = (1 - padSize) / 2;
  const along = Math.min(half + armLength / 2, 0.5 - ZEBRA_LENGTH / 2);
  const gap = (padSize - ZEBRA_STRIPES * ZEBRA_STRIPE_WIDTH) / (ZEBRA_STRIPES + 1);
  const pieces: FlatPiece[] = [];
  for (const { dx, dy, bit } of DIRECTIONS) {
    if ((mask & bit) === 0) continue;
    for (let k = 0; k < ZEBRA_STRIPES; k++) {
      const across = -half + gap * (k + 1) + ZEBRA_STRIPE_WIDTH * (k + 0.5);
      pieces.push(
        dx !== 0
          ? { cx: dx * along, cz: across, sizeX: ZEBRA_LENGTH, sizeZ: ZEBRA_STRIPE_WIDTH }
          : { cx: across, cz: dy * along, sizeX: ZEBRA_STRIPE_WIDTH, sizeZ: ZEBRA_LENGTH },
      );
    }
  }
  return pieces;
}

/** How far the lamp's arm reaches out from the pole (local +x). */
export const LAMP_REACH = 0.18;
export const MAX_PARTS_PER_LAMP = 6;
/** Side of the lamp's square foot. */
export const LAMP_FOOT_SIZE = 0.04;

const LAMP = {
  color: 0x3a4048,
  housingColor: 0x565d66,
  footSize: LAMP_FOOT_SIZE,
  footHeight: 0.03,
  poleRadius: 0.013,
  poleHeight: 0.3,
  /** A slim pole needs few facets. */
  poleSegments: 6,
  arm: 0.014,
  /** The arm rises from the pole top, then runs level out to the housing. */
  riserLength: 0.08,
  riserAngle: Math.PI / 7,
  /** The housing hangs over the arm's tip, slightly past it. */
  housing: { length: 0.06, height: 0.022, depth: 0.045, overhang: 0.015 },
} as const;

export interface LampModel {
  geometry: THREE.BufferGeometry;
  parts: number;
  /** Where the glow sits: under the housing at the arm's tip. */
  head: { x: number; y: number; z: number };
}

let lampCache: LampModel | null = null;

/**
 * Streetlamp: a foot, a slim pole, an arm of two boxes (a short riser
 * angled up from the pole top, then a level reach) and a flat housing
 * at the tip. Cached.
 */
export function lampModel(): LampModel {
  if (lampCache) return lampCache;
  const { poleHeight: top, arm, riserLength, riserAngle, housing } = LAMP;
  const riserRun = riserLength * Math.cos(riserAngle);
  const reachY = top + riserLength * Math.sin(riserAngle);
  const riser = box(riserLength, arm, arm, 0, 0, 0, LAMP.color);
  riser.rotateZ(riserAngle);
  riser.translate(riserRun / 2, top + (reachY - top) / 2, 0);
  const levelLength = LAMP_REACH - riserRun;
  const housingY = reachY - arm / 2 - housing.height / 2;
  const housingX = LAMP_REACH + housing.overhang - housing.length / 2;
  const parts = [
    box(LAMP.footSize, LAMP.footHeight, LAMP.footSize, 0, LAMP.footHeight / 2, 0, LAMP.color),
    cylinder(LAMP.poleRadius, top, 0, top / 2, 0, LAMP.color, LAMP.poleSegments),
    riser,
    box(levelLength, arm, arm, riserRun + levelLength / 2, reachY, 0, LAMP.color),
    box(housing.length, housing.height, housing.depth, housingX, housingY, 0, LAMP.housingColor),
  ];
  const { geometry } = merge(parts);
  lampCache = {
    geometry,
    parts: parts.length,
    head: { x: housingX, y: housingY - housing.height / 2, z: 0 },
  };
  return lampCache;
}

/**
 * Bus shelter: two posts at the back of a flat roof. Local frame: the
 * roof runs along x, the back (posts) faces +z, the road lies toward -z.
 */
export const SHELTER = {
  length: 0.26,
  depth: 0.14,
  roofHeight: 0.03,
  roofY: 0.23,
  post: 0.03,
  postHeight: 0.22,
  postX: 0.09,
} as const;
/** The shelter's back stays this far inside the tile edge. */
const SHELTER_EDGE_MARGIN = 0.01;
/** Its centre sits this far along the kerb from the tile's middle, clear of the lamp and pole corners. */
const SHELTER_ALONG = 0.34;

/** Two posts at the back edge of the roof, standing on y = 0. */
export function shelterGeometry(): THREE.BufferGeometry {
  const { length, depth, roofHeight, roofY, post, postHeight, postX } = SHELTER;
  const postZ = depth / 2 - post / 2;
  return merge([
    box(post, postHeight, post, -postX, postHeight / 2, postZ, 0xffffff),
    box(post, postHeight, post, postX, postHeight / 2, postZ, 0xffffff),
    box(length, roofHeight, depth, 0, roofY, 0, 0xffffff),
  ]).geometry;
}

/**
 * Where a road tile's bus shelter stands: tile-local centre and yaw
 * (about +y; local +z, the shelter's back, turns onto the outward side).
 *
 * It backs onto the first open pad side (no arm) of south, west, north,
 * east — south on a full crossing, where no side is open — with its back
 * SHELTER_EDGE_MARGIN inside the tile edge, or inside a straight bridge's
 * railing at `backLimit`. Its posts then stand beyond the kerb; on an
 * avenue the roof reaches over the kerb, as real shelters do. Along the
 * side it keeps to the half away from the pole (north-west) and lamp
 * (south-east) corners, and on a level crossing to the half the
 * barriers leave free (barriers stand at (−,−)/(+,+) when the track runs
 * along x, at (−,+)/(+,−) along z; railMesh).
 */
export function shelterPlacement(
  roadMask: number,
  track: number,
  backLimit = 0.5 - SHELTER_EDGE_MARGIN,
): { dx: number; dz: number; yaw: number } {
  // Outward normal (back) and the along-kerb direction of each side.
  const sides = [
    { bit: DIR_S, nx: 0, nz: 1, tx: -1, tz: 0 },
    { bit: DIR_W, nx: -1, nz: 0, tx: 0, tz: 1 },
    { bit: DIR_N, nx: 0, nz: -1, tx: 1, tz: 0 },
    { bit: DIR_E, nx: 1, nz: 0, tx: 0, tz: -1 },
  ];
  const side = sides.find(({ bit }) => (roadMask & bit) === 0) ?? sides[0];
  const out = backLimit - SHELTER.depth / 2;
  let dx = side.nx * out + side.tx * SHELTER_ALONG;
  let dz = side.nz * out + side.tz * SHELTER_ALONG;
  const bits = track & (DIR_N | DIR_E | DIR_S | DIR_W);
  const trackAlongX = (bits & (DIR_E | DIR_W)) !== 0 && (bits & (DIR_N | DIR_S)) === 0;
  const trackAlongZ = (bits & (DIR_N | DIR_S)) !== 0 && (bits & (DIR_E | DIR_W)) === 0;
  const barrierCorner = trackAlongX ? 1 : trackAlongZ ? -1 : 0;
  if (barrierCorner !== 0 && Math.sign(dx) * Math.sign(dz) === barrierCorner) {
    dx -= 2 * side.tx * SHELTER_ALONG;
    dz -= 2 * side.tz * SHELTER_ALONG;
  }
  return { dx, dz, yaw: Math.atan2(side.nx, side.nz) };
}
