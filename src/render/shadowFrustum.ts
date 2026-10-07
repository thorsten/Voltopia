import * as THREE from 'three';
import { LEVEL_HEIGHT } from './elevationField.ts';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface ShadowFit {
  /** Where the directional light sits (target minus the sun direction times the near-side depth). */
  position: Vec3;
  /** What it looks at: the snapped centre of the view in light space. */
  target: Vec3;
  halfWidth: number;
  halfHeight: number;
  /** Shadow camera far plane (near is 0). */
  far: number;
  /**
   * The world-up reference used to build the light-space basis (r, u, f).
   * The renderer must set `sun.shadow.camera.up` to this before the next
   * render, or three's internal `lookAt` (which uses the camera's own
   * `up`, defaulting to +Y) would build a basis that disagrees with the
   * one used here to snap the centre to texels, undoing the snap.
   */
  up: Vec3;
}

/** Shadow map edge in texels (unchanged from before the follow-the-view change). */
export const SHADOW_MAP_SIZE = 2048;
/** Tiles around the view that still cast shadows into it. */
export const SHADOW_MARGIN_TILES = 4;
/** Smallest half extent of the shadow camera, so extreme zoom-in cannot degenerate. */
export const SHADOW_MIN_HALF_EXTENT = 6;
/** Extra depth beyond the view box, on the side away from the sun. */
export const SHADOW_DEPTH_PADDING = 20;
/** Height band of the visible ground: sea level to the highest terrain plus a tall building. */
export const SHADOW_VIEW_MIN_Y = 0;
export const SHADOW_VIEW_MAX_Y = 8 * LEVEL_HEIGHT + 3;
/** Extents are rounded up to whole tiles, so panning at one zoom keeps the texel size fixed. */
const EXTENT_STEP = 1;
/**
 * Floor for |sunDirection.y| when sizing the sun-side depth padding, so a
 * sun sitting exactly on the horizon cannot divide by (near) zero and
 * blow the padding up to infinity.
 */
const MIN_SUN_HEIGHT_COMPONENT = 0.05;
/**
 * Above this |f.y| the sun is treated as (near enough) straight down or
 * up: the usual "world up" reference is nearly parallel to the sun
 * direction and cross(ref, f) would be unstable, so a different
 * reference axis is used instead.
 */
const NEAR_VERTICAL_SUN_Y = 0.99;

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

export interface ShadowBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

/**
 * Light-space (r, u, f) axis-aligned bounding box of the eight corners of
 * `bounds`. Any point inside the (axis-aligned, world-space) box is a
 * convex combination of its corners, so its light-space coordinates are
 * bounded by this box's light-space corners too — which is what lets
 * `fitShadowFrustum` intersect it with the view's own light-space range
 * per axis below, rather than clamping individual points (clamping
 * world x/z independently distorts a rotated view footprint: its
 * corners land on the map's edge midpoints instead of its corners).
 */
function boundsExtentInBasis(
  bounds: ShadowBounds,
  r: Vec3,
  u: Vec3,
  f: Vec3,
): { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number } {
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  for (const x of [bounds.minX, bounds.maxX]) {
    for (const y of [bounds.minY, bounds.maxY]) {
      for (const z of [bounds.minZ, bounds.maxZ]) {
        const corner: Vec3 = { x, y, z };
        const cx = dot(corner, r),
          cy = dot(corner, u),
          cz = dot(corner, f);
        minX = Math.min(minX, cx);
        maxX = Math.max(maxX, cx);
        minY = Math.min(minY, cy);
        maxY = Math.max(maxY, cy);
        minZ = Math.min(minZ, cz);
        maxZ = Math.max(maxZ, cz);
      }
    }
  }
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

/** Intersect [viewMin, viewMax] with [boundsMin, boundsMax]; fall back to the view range if empty. */
function intersectRange(
  viewMin: number,
  viewMax: number,
  boundsMin: number,
  boundsMax: number,
): [number, number] {
  const lo = Math.max(viewMin, boundsMin);
  const hi = Math.min(viewMax, boundsMax);
  return lo <= hi ? [lo, hi] : [viewMin, viewMax];
}

/**
 * Fit an orthographic shadow camera around `points` (the visible part
 * of the map) as seen along `sunDirection` (pointing from the sun into
 * the scene). The rectangle covers every point plus `margin`, its half
 * extents are rounded up to whole tiles and never below
 * `minHalfExtent`, and its centre is snapped to whole shadow texels so
 * shadow edges do not crawl while the camera pans.
 *
 * `casterHeight` is the tallest object the view can contain; for a low
 * sun its shadow can reach `casterHeight / |sunDirection.y|` across the
 * ground, so the depth padding on the sun's side of the frustum grows
 * with it, or a caster standing just outside the margin would be
 * clipped out of the shadow camera before it ever reaches the near
 * plane. The far side (away from the sun) keeps the fixed `depthPadding`
 * — nothing needs to cast a shadow backwards into the view from there.
 *
 * `bounds`, if given, is intersected (per light-space axis, after
 * projection) with the view's own range, so a camera zoomed out past
 * the edge of the map does not inflate the frustum (and blur every
 * shadow) with empty space that is never actually visible ground. The
 * intersection — rather than clamping each point's world x/z into
 * `bounds` — keeps a rotated (isometric) view footprint intact: that
 * footprint is a diamond in world x/z, and clamping its corners
 * independently per axis would snap them to the map's edge midpoints
 * instead of its corners, pulling the fitted rectangle in from the
 * map's actual corners.
 */
export function fitShadowFrustum(input: {
  points: readonly Vec3[];
  sunDirection: Vec3;
  mapSize: number;
  margin: number;
  minHalfExtent: number;
  depthPadding: number;
  casterHeight: number;
  bounds?: ShadowBounds;
}): ShadowFit {
  const f = normalize(input.sunDirection);
  const ref: Vec3 =
    Math.abs(f.y) > NEAR_VERTICAL_SUN_Y ? { x: 0, y: 0, z: -1 } : { x: 0, y: 1, z: 0 };
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
  if (input.bounds) {
    const box = boundsExtentInBasis(input.bounds, r, u, f);
    [minX, maxX] = intersectRange(minX, maxX, box.minX, box.maxX);
    [minY, maxY] = intersectRange(minY, maxY, box.minY, box.maxY);
    [minZ, maxZ] = intersectRange(minZ, maxZ, box.minZ, box.maxZ);
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
  const halfSpanZ = (maxZ - minZ) / 2;
  const sunSideDepth = Math.max(
    input.depthPadding,
    input.casterHeight / Math.max(Math.abs(f.y), MIN_SUN_HEIGHT_COMPONENT),
  );
  const depthNear = halfSpanZ + sunSideDepth;
  const depthFar = halfSpanZ + input.depthPadding;
  return {
    target,
    position: {
      x: target.x - f.x * depthNear,
      y: target.y - f.y * depthNear,
      z: target.z - f.z * depthNear,
    },
    halfWidth,
    halfHeight,
    far: depthNear + depthFar,
    up: ref,
  };
}

const ndc = new THREE.Vector3();
const near = new THREE.Vector3();
const farPoint = new THREE.Vector3();
/** Below this, a frustum-corner ray is treated as parallel to the ground (no safe intersection). */
const PARALLEL_RAY_EPSILON = 1e-9;

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
      const t = Math.abs(dy) < PARALLEL_RAY_EPSILON ? 0 : (y - near.y) / dy;
      out.push({ x: near.x + (farPoint.x - near.x) * t, y, z: near.z + (farPoint.z - near.z) * t });
    }
  }
  return out;
}
