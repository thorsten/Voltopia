import * as THREE from 'three';

/** The instanced geometries a building is composed from. */
export const PartKind = { Box: 0, GableRoof: 1, HipRoof: 2, Cylinder: 3, ShedRoof: 4 } as const;
export type PartKind = (typeof PartKind)[keyof typeof PartKind];

export const PART_KINDS: readonly PartKind[] = [
  PartKind.Box,
  PartKind.GableRoof,
  PartKind.HipRoof,
  PartKind.Cylinder,
  PartKind.ShedRoof,
];

const CYLINDER_SEGMENTS = 8;
const H = 0.5;

type Vec3 = readonly [number, number, number];

/** Non-indexed triangles → computeVertexNormals yields flat per-face normals. */
function flatGeometry(triangles: number[]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(triangles, 3));
  geometry.computeVertexNormals();
  return geometry;
}

// Corners of the unit footprint at y = 0 (+z is south).
// All faces wind counter-clockwise seen from outside.
const NW: Vec3 = [-H, 0, -H];
const NE: Vec3 = [H, 0, -H];
const SE: Vec3 = [H, 0, H];
const SW: Vec3 = [-H, 0, H];

const BOTTOM: Vec3[] = [NW, NE, SE, NW, SE, SW];

/** Triangular prism: ridge along x at y = 1, eaves at y = 0 on z = ±0.5. */
function createGableRoof(): THREE.BufferGeometry {
  const ridgeE: Vec3 = [H, 1, 0];
  const ridgeW: Vec3 = [-H, 1, 0];

  const faces: Vec3[] = [
    // south slope (+z)
    SW,
    SE,
    ridgeE,
    SW,
    ridgeE,
    ridgeW,
    // north slope (-z)
    NE,
    NW,
    ridgeW,
    NE,
    ridgeW,
    ridgeE,
    // east gable (+x)
    SE,
    NE,
    ridgeE,
    // west gable (-x)
    NW,
    SW,
    ridgeW,
    // bottom
    ...BOTTOM,
  ];

  return flatGeometry(faces.flat().map(Number));
}

/** Four-sided pyramid with the apex at (0, 1, 0). */
function createHipRoof(): THREE.BufferGeometry {
  const apex: Vec3 = [0, 1, 0];

  const faces: Vec3[] = [
    // south
    SW,
    SE,
    apex,
    // east
    SE,
    NE,
    apex,
    // north
    NE,
    NW,
    apex,
    // west
    NW,
    SW,
    apex,
    // bottom
    ...BOTTOM,
  ];

  return flatGeometry(faces.flat().map(Number));
}

/** Mono-pitch wedge: high edge along x at y = 1, z = -0.5; low edge at y = 0, z = +0.5. */
function createShedRoof(): THREE.BufferGeometry {
  const highE: Vec3 = [H, 1, -H];
  const highW: Vec3 = [-H, 1, -H];

  const faces: Vec3[] = [
    // slope, falling toward +z
    SW,
    SE,
    highE,
    SW,
    highE,
    highW,
    // back wall (-z)
    NE,
    NW,
    highW,
    NE,
    highW,
    highE,
    // east side (+x)
    SE,
    NE,
    highE,
    // west side (-x)
    NW,
    SW,
    highW,
    // bottom
    ...BOTTOM,
  ];

  return flatGeometry(faces.flat().map(Number));
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
    case PartKind.ShedRoof:
      return createShedRoof();
  }
}
