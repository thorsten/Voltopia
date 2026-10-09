import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { PART_KINDS, PartKind, createPartGeometry } from './primitives.ts';

describe('building primitives', () => {
  it('lists the five kinds in enum order', () => {
    expect(PART_KINDS).toEqual([
      PartKind.Box,
      PartKind.GableRoof,
      PartKind.HipRoof,
      PartKind.Cylinder,
      PartKind.ShedRoof,
    ]);
    expect(PartKind.ShedRoof).toBe(4);
  });

  it.each(PART_KINDS)('kind %i spans a unit footprint with its base at y = 0', (kind) => {
    const geometry = createPartGeometry(kind);
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    expect(box.min.x).toBeCloseTo(-0.5, 5);
    expect(box.max.x).toBeCloseTo(0.5, 5);
    expect(box.min.z).toBeCloseTo(-0.5, 5);
    expect(box.max.z).toBeCloseTo(0.5, 5);
    expect(box.min.y).toBeCloseTo(0, 5);
    expect(box.max.y).toBeCloseTo(1, 5);
  });

  it.each(PART_KINDS)('kind %i carries normals for Lambert shading', (kind) => {
    const geometry = createPartGeometry(kind);
    expect(geometry.getAttribute('normal')).toBeDefined();
    expect(geometry.getAttribute('normal').count).toBe(geometry.getAttribute('position').count);
  });

  // The centre each kind's faces must point away from: the volume's centroid.
  it.each([
    [PartKind.GableRoof, new THREE.Vector3(0, 0.5, 0)],
    [PartKind.HipRoof, new THREE.Vector3(0, 0.5, 0)],
    [PartKind.ShedRoof, new THREE.Vector3(0, 1 / 3, -1 / 6)],
  ])('kind %i has outward-facing faces', (kind, centre) => {
    const geometry = createPartGeometry(kind);
    const normal = geometry.getAttribute('normal') as THREE.BufferAttribute;
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < position.count; i++) {
      const p = new THREE.Vector3().fromBufferAttribute(position, i).sub(centre);
      const n = new THREE.Vector3().fromBufferAttribute(normal, i);
      expect(p.dot(n)).toBeGreaterThan(0);
    }
  });

  describe('shed roof', () => {
    const geometry = createPartGeometry(PartKind.ShedRoof);
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    const normal = geometry.getAttribute('normal') as THREE.BufferAttribute;

    it('is non-indexed so every face keeps a flat normal', () => {
      expect(geometry.index).toBeNull();
      // Six faces: slope, back wall and bottom (two triangles each), two sides.
      expect(position.count).toBe(8 * 3);
    });

    it('rises to its high edge at z = -0.5 and drops to its low edge at z = +0.5', () => {
      const v = new THREE.Vector3();
      const n = new THREE.Vector3();
      let slopeLow = 0;
      for (let i = 0; i < position.count; i++) {
        v.fromBufferAttribute(position, i);
        n.fromBufferAttribute(normal, i);
        if (Math.abs(v.y - 1) < 1e-6) expect(v.z).toBeCloseTo(-0.5, 6);
        const onSlope = n.y > 1e-6 && n.z > 1e-6;
        if (onSlope && Math.abs(v.y) < 1e-6) {
          expect(v.z).toBeCloseTo(0.5, 6);
          slopeLow++;
        }
      }
      expect(slopeLow).toBeGreaterThan(0);
    });

    it('has unit-length normals', () => {
      const n = new THREE.Vector3();
      for (let i = 0; i < normal.count; i++) {
        expect(n.fromBufferAttribute(normal, i).length()).toBeCloseTo(1, 6);
      }
    });
  });
});
