import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { box, cone, cylinder, dome, gable, merge, sphere, tilted, tube } from './modelKit.ts';

function bounds(g: THREE.BufferGeometry): THREE.Box3 {
  g.computeBoundingBox();
  return g.boundingBox!;
}
const near = (a: THREE.Vector3, b: [number, number, number]) => {
  expect(a.x).toBeCloseTo(b[0], 5);
  expect(a.y).toBeCloseTo(b[1], 5);
  expect(a.z).toBeCloseTo(b[2], 5);
};

describe('model kit', () => {
  const cases: Array<
    [string, THREE.BufferGeometry, [number, number, number], [number, number, number]]
  > = [
    ['box', box(0.2, 0.3, 0.4, 0.1, 0.5, -0.1, 0xff0000), [0, 0.35, -0.3], [0.2, 0.65, 0.1]],
    ['cylinder', cylinder(0.1, 0.4, 0, 0.2, 0, 0xff0000), [-0.1, 0, -0.1], [0.1, 0.4, 0.1]],
    ['cone', cone(0.1, 0.05, 0.4, 0, 0.2, 0, 0xff0000), [-0.1, 0, -0.1], [0.1, 0.4, 0.1]],
    ['tube x', tube(0.05, 0.4, 0, 0.1, 0, 0xff0000), [-0.2, 0.05, -0.05], [0.2, 0.15, 0.05]],
    ['tube z', tube(0.05, 0.4, 0, 0.1, 0, 0xff0000, 'z'), [-0.05, 0.05, -0.2], [0.05, 0.15, 0.2]],
    ['sphere', sphere(0.1, 0, 0.1, 0, 0xff0000), [-0.1, 0, -0.1], [0.1, 0.2, 0.1]],
    ['dome', dome(0.2, 0.5, 0, 0.05, 0, 0xff0000), [-0.2, 0, -0.2], [0.2, 0.1, 0.2]],
    ['gable', gable(0.4, 0.1, 0.3, 0, 0.05, 0, 0xff0000), [-0.2, 0, -0.15], [0.2, 0.1, 0.15]],
  ];
  it.each(cases)('%s: bounding box centred on its arguments', (_name, g, min, max) => {
    const b = bounds(g);
    // Round primitives are polygons: allow the facet inset on x/z.
    expect(b.min.y).toBeCloseTo(min[1], 5);
    expect(b.max.y).toBeCloseTo(max[1], 5);
    for (const axis of ['x', 'z'] as const) {
      expect(b.min[axis]).toBeGreaterThanOrEqual(min[axis === 'x' ? 0 : 2] - 1e-6);
      expect(b.max[axis]).toBeLessThanOrEqual(max[axis === 'x' ? 0 : 2] + 1e-6);
      expect(b.max[axis] - b.min[axis]).toBeGreaterThan(
        0.9 * (max[axis === 'x' ? 0 : 2] - min[axis === 'x' ? 0 : 2]),
      );
    }
  });
  it.each(cases)('%s: non-indexed with position, normal and a colour per vertex', (_name, g) => {
    expect(g.index).toBeNull();
    const n = g.getAttribute('position').count;
    expect(g.getAttribute('normal').count).toBe(n);
    expect(g.getAttribute('color').count).toBe(n);
    expect(g.getAttribute('uv')).toBeUndefined();
    const c = g.getAttribute('color');
    expect([c.getX(0), c.getY(0), c.getZ(0)]).toEqual([1, 0, 0]);
  });
  it('gable: ridge on top, along x by default, along z on request', () => {
    const along = bounds(gable(0.4, 0.1, 0.3, 0, 0.05, 0, 0x00ff00));
    near(along.min, [-0.2, 0, -0.15]);
    near(along.max, [0.2, 0.1, 0.15]);
    const across = bounds(gable(0.4, 0.1, 0.3, 0, 0.05, 0, 0x00ff00, 'z'));
    near(across.min, [-0.2, 0, -0.15]);
    near(across.max, [0.2, 0.1, 0.15]);
    // Top vertices lie on the ridge line: x = 0 for a z ridge, z = 0 for an x ridge.
    const pos = gable(0.4, 0.1, 0.3, 0, 0.05, 0, 0x00ff00).getAttribute('position');
    for (let i = 0; i < pos.count; i++)
      if (pos.getY(i) > 0.0999) expect(Math.abs(pos.getZ(i))).toBeLessThan(1e-6);
  });
  it('tilted: rotates about the part centre around x', () => {
    const g = tilted(box(0.2, 0.02, 0.4, 0, 0.3, 0, 0xffffff), Math.PI / 2);
    const b = bounds(g);
    near(b.min, [-0.1, 0.1, -0.01]);
    near(b.max, [0.1, 0.5, 0.01]);
  });
  it('merge: counts parts and keeps every vertex colour', () => {
    const m = merge([
      box(0.1, 0.1, 0.1, 0, 0, 0, 0xff0000),
      cylinder(0.05, 0.1, 0.2, 0, 0, 0x0000ff),
    ]);
    expect(m.parts).toBe(2);
    expect(m.geometry.getAttribute('color').count).toBe(m.geometry.getAttribute('position').count);
  });
  it('merge: rejects an empty part list', () => {
    expect(() => merge([])).toThrow();
  });
});
