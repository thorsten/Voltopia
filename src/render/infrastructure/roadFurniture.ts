/**
 * Street furniture laid out per road tile: kerbs along the open edges of
 * the roadway and zebra crossings on the arms of junctions.
 *
 * Conventions: units are tiles; pieces are tile-local offsets from the
 * tile centre (x east, z south), flat rectangles the caller lays on the
 * ground. The roadway is a square pad of `padSize` plus an arm of the
 * same width toward every connected neighbour (see roadsMesh.ts).
 */
import { DIRECTIONS } from '../../shared/grid.ts';

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
 */
export function kerbPieces(mask: number, padSize: number): FlatPiece[] {
  const half = padSize / 2;
  const armLength = (1 - padSize) / 2;
  const edge = half - KERB_WIDTH / 2 + KERB_OVERHANG;
  const armCentre = half + armLength / 2;
  const pieces: FlatPiece[] = [];
  for (const { dx, dy, bit } of DIRECTIONS) {
    if ((mask & bit) === 0) {
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
