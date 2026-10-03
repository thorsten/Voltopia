import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { PART_KINDS, PartKind, createPartGeometry } from './primitives.ts';

describe('building primitives', () => {
  it('lists the four kinds in enum order', () => {
    expect(PART_KINDS).toEqual([
      PartKind.Box,
      PartKind.GableRoof,
      PartKind.HipRoof,
      PartKind.Cylinder,
    ]);
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

  it('gives the gable roof outward-facing slopes', () => {
    const geometry = createPartGeometry(PartKind.GableRoof);
    const normal = geometry.getAttribute('normal') as THREE.BufferAttribute;
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    // Every face normal must point away from the roof's centre (0, 0.5, 0).
    for (let i = 0; i < position.count; i++) {
      const p = new THREE.Vector3()
        .fromBufferAttribute(position, i)
        .sub(new THREE.Vector3(0, 0.5, 0));
      const n = new THREE.Vector3().fromBufferAttribute(normal, i);
      expect(p.dot(n)).toBeGreaterThan(0);
    }
  });
});
