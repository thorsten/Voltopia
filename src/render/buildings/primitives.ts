import * as THREE from 'three';

/** The instanced geometries a building is composed from. */
export const PartKind = { Box: 0, GableRoof: 1, HipRoof: 2, Cylinder: 3 } as const;
export type PartKind = (typeof PartKind)[keyof typeof PartKind];

export const PART_KINDS: readonly PartKind[] = [
  PartKind.Box,
  PartKind.GableRoof,
  PartKind.HipRoof,
  PartKind.Cylinder,
];

const CYLINDER_SEGMENTS = 8;
const H = 0.5;

/** Non-indexed triangles → computeVertexNormals yields flat per-face normals. */
function flatGeometry(triangles: number[]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(triangles, 3));
  geometry.computeVertexNormals();
  return geometry;
}

// Corners of the unit footprint at y = 0 (a = NW, b = NE, c = SE, d = SW;
// +z is south) — shared by both roofs. All faces wind counter-clockwise
// seen from outside.
const BOTTOM = [-H, 0, -H, H, 0, -H, H, 0, H, -H, 0, -H, H, 0, H, -H, 0, H];

/** Triangular prism: ridge along x at y = 1, eaves at y = 0 on z = ±0.5. */
function createGableRoof(): THREE.BufferGeometry {
  return flatGeometry([
    // south slope (+z)
    -H,
    0,
    H,
    H,
    0,
    H,
    H,
    1,
    0,
    -H,
    0,
    H,
    H,
    1,
    0,
    -H,
    1,
    0,
    // north slope (-z)
    H,
    0,
    -H,
    -H,
    0,
    -H,
    -H,
    1,
    0,
    H,
    0,
    -H,
    -H,
    1,
    0,
    H,
    1,
    0,
    // east gable (+x)
    H,
    0,
    H,
    H,
    0,
    -H,
    H,
    1,
    0,
    // west gable (-x)
    -H,
    0,
    -H,
    -H,
    0,
    H,
    -H,
    1,
    0,
    ...BOTTOM,
  ]);
}

/** Four-sided pyramid with the apex at (0, 1, 0). */
function createHipRoof(): THREE.BufferGeometry {
  return flatGeometry([
    // south
    -H,
    0,
    H,
    H,
    0,
    H,
    0,
    1,
    0,
    // east
    H,
    0,
    H,
    H,
    0,
    -H,
    0,
    1,
    0,
    // north
    H,
    0,
    -H,
    -H,
    0,
    -H,
    0,
    1,
    0,
    // west
    -H,
    0,
    -H,
    -H,
    0,
    H,
    0,
    1,
    0,
    ...BOTTOM,
  ]);
}

/**
 * Geometry for one primitive kind. Every kind shares the convention
 * "unit footprint centred on the origin, base at y = 0, height 1", so the
 * instance matrix is always scale → rotate → translate.
 */
export function createPartGeometry(kind: PartKind): THREE.BufferGeometry {
  switch (kind) {
    case PartKind.Box:
      return new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    case PartKind.GableRoof:
      return createGableRoof();
    case PartKind.HipRoof:
      return createHipRoof();
    case PartKind.Cylinder:
      return new THREE.CylinderGeometry(0.5, 0.5, 1, CYLINDER_SEGMENTS).translate(0, 0.5, 0);
  }
}
