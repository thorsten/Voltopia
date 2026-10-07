import * as THREE from 'three';
import { LEVEL_HEIGHT } from './elevationField.ts';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface ShadowFit {
  /** Where the directional light sits (target minus the sun direction times the depth). */
  position: Vec3;
  /** What it looks at: the snapped centre of the view in light space. */
  target: Vec3;
  halfWidth: number;
  halfHeight: number;
  /** Shadow camera far plane (near is 0). */
  far: number;
}

/** Shadow map edge in texels (unchanged from before the follow-the-view change). */
export const SHADOW_MAP_SIZE = 2048;
/** Tiles around the view that still cast shadows into it. */
export const SHADOW_MARGIN_TILES = 4;
/** Smallest half extent of the shadow camera, so extreme zoom-in cannot degenerate. */
export const SHADOW_MIN_HALF_EXTENT = 6;
/** Extra depth in front of and behind the view box, so tall objects outside it still cast. */
export const SHADOW_DEPTH_PADDING = 20;
/** Height band of the visible ground: sea level to the highest terrain plus a tall building. */
export const SHADOW_VIEW_MIN_Y = 0;
export const SHADOW_VIEW_MAX_Y = 8 * LEVEL_HEIGHT + 3;
/** Extents are rounded up to whole tiles, so panning at one zoom keeps the texel size fixed. */
const EXTENT_STEP = 1;

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(a.x, a.y, a.z) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
}

/**
 * Fit an orthographic shadow camera around `points` (the visible part
 * of the map) as seen along `sunDirection` (pointing from the sun into
 * the scene). The rectangle covers every point plus `margin`, its half
 * extents are rounded up to whole tiles and never below
 * `minHalfExtent`, and its centre is snapped to whole shadow texels so
 * shadow edges do not crawl while the camera pans.
 */
export function fitShadowFrustum(input: {
  points: readonly Vec3[];
  sunDirection: Vec3;
  mapSize: number;
  margin: number;
  minHalfExtent: number;
  depthPadding: number;
}): ShadowFit {
  const f = normalize(input.sunDirection);
  const ref: Vec3 = Math.abs(f.y) > 0.99 ? { x: 0, y: 0, z: -1 } : { x: 0, y: 1, z: 0 };
  const r = normalize(cross(ref, f));
  const u = cross(f, r);
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  for (const p of input.points) {
    const px = dot(p, r),
      py = dot(p, u),
      pz = dot(p, f);
    minX = Math.min(minX, px);
    maxX = Math.max(maxX, px);
    minY = Math.min(minY, py);
    maxY = Math.max(maxY, py);
    minZ = Math.min(minZ, pz);
    maxZ = Math.max(maxZ, pz);
  }
  const roundUp = (v: number) => Math.ceil(v / EXTENT_STEP) * EXTENT_STEP;
  const halfWidth = Math.max(input.minHalfExtent, roundUp((maxX - minX) / 2 + input.margin));
  const halfHeight = Math.max(input.minHalfExtent, roundUp((maxY - minY) / 2 + input.margin));
  const texelX = (2 * halfWidth) / input.mapSize;
  const texelY = (2 * halfHeight) / input.mapSize;
  const cx = Math.round((minX + maxX) / 2 / texelX) * texelX;
  const cy = Math.round((minY + maxY) / 2 / texelY) * texelY;
  const cz = (minZ + maxZ) / 2;
  const target: Vec3 = {
    x: r.x * cx + u.x * cy + f.x * cz,
    y: r.y * cx + u.y * cy + f.y * cz,
    z: r.z * cx + u.z * cy + f.z * cz,
  };
  const depth = (maxZ - minZ) / 2 + input.depthPadding;
  return {
    target,
    position: { x: target.x - f.x * depth, y: target.y - f.y * depth, z: target.z - f.z * depth },
    halfWidth,
    halfHeight,
    far: 2 * depth,
  };
}

const ndc = new THREE.Vector3();
const near = new THREE.Vector3();
const farPoint = new THREE.Vector3();

/**
 * The eight corners of what the orthographic camera sees between the
 * heights `minY` and `maxY`: each frustum-corner ray (near to far plane)
 * intersected with both horizontal planes.
 */
export function viewGroundCorners(
  camera: THREE.OrthographicCamera,
  minY: number,
  maxY: number,
): Vec3[] {
  camera.updateMatrixWorld();
  const out: Vec3[] = [];
  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ] as const) {
    near.copy(ndc.set(sx, sy, -1)).unproject(camera);
    farPoint.copy(ndc.set(sx, sy, 1)).unproject(camera);
    const dy = farPoint.y - near.y;
    for (const y of [minY, maxY]) {
      const t = Math.abs(dy) < 1e-9 ? 0 : (y - near.y) / dy;
      out.push({ x: near.x + (farPoint.x - near.x) * t, y, z: near.z + (farPoint.z - near.z) * t });
    }
  }
  return out;
}
