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
import { DIRECTIONS } from '../../shared/grid.ts';
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

const LAMP = {
  color: 0x3a4048,
  housingColor: 0x565d66,
  footSize: 0.04,
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
