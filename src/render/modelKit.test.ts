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
    // Checked for both calls, since a square footprint (w === d here) makes
    // the bounding-box assertions above identical for either orientation.
    const xRidgePos = gable(0.4, 0.1, 0.3, 0, 0.05, 0, 0x00ff00).getAttribute('position');
    for (let i = 0; i < xRidgePos.count; i++)
      if (xRidgePos.getY(i) > 0.0999) expect(Math.abs(xRidgePos.getZ(i))).toBeLessThan(1e-6);
    const zRidgePos = gable(0.4, 0.1, 0.3, 0, 0.05, 0, 0x00ff00, 'z').getAttribute('position');
    for (let i = 0; i < zRidgePos.count; i++)
      if (zRidgePos.getY(i) > 0.0999) expect(Math.abs(zRidgePos.getX(i))).toBeLessThan(1e-6);
  });
  it('gable: ridge direction follows ridgeAlong with a non-square footprint', () => {
    // w != d: the base footprint is w (x) by d (z) regardless of
    // ridgeAlong, so a bounding-box check can't distinguish orientation
    // even with asymmetric dimensions. Pin the apex's span along each
    // axis instead: a mutant that ignores ridgeAlong and always builds
    // the x-ridge orientation gives the z-ridge call an apex spanning
    // w/2 on x (not d/2 on z), which this catches.
    const w = 0.4,
      d = 0.2;
    const xRidge = gable(w, 0.1, d, 0, 0.05, 0, 0x00ff00, 'x').getAttribute('position');
    let xApexSpan = 0;
    for (let i = 0; i < xRidge.count; i++)
      if (xRidge.getY(i) > 0.0999) xApexSpan = Math.max(xApexSpan, Math.abs(xRidge.getX(i)));
    expect(xApexSpan).toBeCloseTo(w / 2, 5);

    const zRidge = gable(w, 0.1, d, 0, 0.05, 0, 0x00ff00, 'z').getAttribute('position');
    let zApexSpan = 0;
    for (let i = 0; i < zRidge.count; i++)
      if (zRidge.getY(i) > 0.0999) zApexSpan = Math.max(zApexSpan, Math.abs(zRidge.getZ(i)));
    expect(zApexSpan).toBeCloseTo(d / 2, 5);
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
