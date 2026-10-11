import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** Facets of round primitives (cylinders, cones, tubes, spheres, domes). */
export const ROUND_SEGMENTS = 12;

export interface Model {
  geometry: THREE.BufferGeometry;
  /** Number of merged primitives. */
  parts: number;
}

const scratch = new THREE.Color();

/**
 * Normalise a primitive for merging: non-indexed, no uv, one colour per
 * vertex, bounding box centred on (x, y, z).
 */
function finish(
  g: THREE.BufferGeometry,
  x: number,
  y: number,
  z: number,
  color: number,
): THREE.BufferGeometry {
  const flat = g.index ? g.toNonIndexed() : g;
  flat.deleteAttribute('uv');
  flat.computeBoundingBox();
  const centre = flat.boundingBox!.getCenter(new THREE.Vector3());
  flat.translate(x - centre.x, y - centre.y, z - centre.z);
  scratch.setHex(color);
  const n = flat.getAttribute('position').count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) colors.set([scratch.r, scratch.g, scratch.b], i * 3);
  flat.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return flat;
}

export const box = (
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  color: number,
) => finish(new THREE.BoxGeometry(w, h, d), x, y, z, color);

export const cylinder = (
  r: number,
  h: number,
  x: number,
  y: number,
  z: number,
  color: number,
  segments = ROUND_SEGMENTS,
) => finish(new THREE.CylinderGeometry(r, r, h, segments), x, y, z, color);

export const cone = (
  rBottom: number,
  rTop: number,
  h: number,
  x: number,
  y: number,
  z: number,
  color: number,
  segments = ROUND_SEGMENTS,
) => finish(new THREE.CylinderGeometry(rTop, rBottom, h, segments), x, y, z, color);

export function tube(
  r: number,
  l: number,
  x: number,
  y: number,
  z: number,
  color: number,
  axis: 'x' | 'z' = 'x',
) {
  const g = new THREE.CylinderGeometry(r, r, l, ROUND_SEGMENTS);
  if (axis === 'x') g.rotateZ(Math.PI / 2);
  else g.rotateX(Math.PI / 2);
  return finish(g, x, y, z, color);
}

export const sphere = (r: number, x: number, y: number, z: number, color: number) =>
  finish(new THREE.SphereGeometry(r, ROUND_SEGMENTS, ROUND_SEGMENTS / 2), x, y, z, color);

export function dome(r: number, squash: number, x: number, y: number, z: number, color: number) {
  const g = new THREE.SphereGeometry(
    r,
    ROUND_SEGMENTS,
    ROUND_SEGMENTS / 2,
    0,
    Math.PI * 2,
    0,
    Math.PI / 2,
  );
  g.scale(1, squash, 1);
  return finish(g, x, y, z, color);
}

/** Prism roof: rectangular base w × d, ridge of height h along x (default) or z. */
export function gable(
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  color: number,
  ridgeAlong: 'x' | 'z' = 'x',
) {
  // Triangle profile across the ridge, extruded along it.
  const across = ridgeAlong === 'x' ? d : w;
  const along = ridgeAlong === 'x' ? w : d;
  const shape = new THREE.Shape();
  shape.moveTo(-across / 2, 0);
  shape.lineTo(across / 2, 0);
  shape.lineTo(0, h);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: along, bevelEnabled: false });
  // Profile lies in x/y and extrudes along z: an x ridge needs the profile across z.
  if (ridgeAlong === 'x') g.rotateY(Math.PI / 2);
  g.computeVertexNormals();
  return finish(g, x, y, z, color);
}

/** Rotate a finished primitive about its own bounding-box centre around x. */
export function tilted(g: THREE.BufferGeometry, angleX: number): THREE.BufferGeometry {
  g.computeBoundingBox();
  const c = g.boundingBox!.getCenter(new THREE.Vector3());
  g.translate(-c.x, -c.y, -c.z);
  g.rotateX(angleX);
  g.translate(c.x, c.y, c.z);
  return g;
}

export function merge(parts: THREE.BufferGeometry[]): Model {
  if (parts.length === 0) throw new Error('model kit: no parts to merge');
  const geometry = mergeGeometries(parts);
  if (!geometry) throw new Error('model kit: parts do not merge');
  return { geometry, parts: parts.length };
}
