/** Geographic helpers: degrees to metres and the tile projection of a box. */
import type { Bbox, LonLat } from './osm.ts';

/** Metres per degree of latitude (and of longitude at the equator). */
export const METRES_PER_DEGREE = 111_320;

/** Metres per degree of longitude at a latitude (equirectangular). */
export function metresPerDegreeLon(lat: number): number {
  return METRES_PER_DEGREE * Math.cos((lat * Math.PI) / 180);
}

/** The smallest box around a set of points. */
export function boundsOf(points: Iterable<LonLat>): Bbox {
  const box: Bbox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [lon, lat] of points) {
    box[0] = Math.min(box[0], lon);
    box[1] = Math.min(box[1], lat);
    box[2] = Math.max(box[2], lon);
    box[3] = Math.max(box[3], lat);
  }
  return box;
}

export interface Projection {
  /** Width and height of the box in metres. */
  widthM: number;
  heightM: number;
  /** Side of the square the grid covers: the longer of the two. */
  sideM: number;
  metresPerTile: number;
  /** Fractional tile coordinates (x east, y south) of a point; tile = floor. */
  project: (point: LonLat) => [number, number];
}

/**
 * Projection of a box onto a `size` x `size` grid. The box is made
 * square in metres around its centre, so the longer side spans the grid
 * and the shorter one is centred with margins.
 */
export function createProjection(bbox: Bbox, size: number): Projection {
  const [w, s, e, n] = bbox;
  const midLat = (s + n) / 2;
  const mPerDegLon = metresPerDegreeLon(midLat);
  const widthM = (e - w) * mPerDegLon;
  const heightM = (n - s) * METRES_PER_DEGREE;
  const sideM = Math.max(widthM, heightM);
  const metresPerTile = sideM / size;
  const cx = (w + e) / 2;
  const cy = midLat;
  const half = size / 2;
  return {
    widthM,
    heightM,
    sideM,
    metresPerTile,
    project: ([lon, lat]) => [
      ((lon - cx) * mPerDegLon) / metresPerTile + half,
      ((cy - lat) * METRES_PER_DEGREE) / metresPerTile + half,
    ],
  };
}
