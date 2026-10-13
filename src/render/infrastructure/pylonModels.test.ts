import { describe, expect, it } from 'vitest';
import {
  FOUNDATION_DEPTH,
  MAX_PARTS_PER_PYLON,
  pylonModel,
  type PylonKind,
} from './pylonModels.ts';

/** Kind, footprint reach, visible height (above y = 0) and buried depth (below it). */
const cases: Array<[PylonKind, number, number, number]> = [
  // The lattice legs reach into the ground, so a slope never shows them floating.
  ['lattice', 0.2, 0.55, FOUNDATION_DEPTH],
  ['pole', 0.12, 0.42, 0],
];

describe('pylon models', () => {
  it.each(cases)(
    '%s stays within the part budget and the footprint',
    (kind, reach, height, depth) => {
      const model = pylonModel(kind);
      expect(model.parts).toBeLessThanOrEqual(MAX_PARTS_PER_PYLON);
      model.geometry.computeBoundingBox();
      const b = model.geometry.boundingBox!;
      expect(b.min.y).toBeCloseTo(-depth, 5);
      expect(Math.abs(b.max.y - height)).toBeLessThanOrEqual(0.03);
      for (const v of [b.min.x, b.max.x, b.min.z, b.max.z]) {
        expect(Math.abs(v)).toBeLessThanOrEqual(reach + 1e-6);
      }
      expect(model.geometry.getAttribute('color')).toBeDefined();
    },
  );

  it.each(cases)('%s carries three attachments spread across the line', (kind) => {
    const { attachments } = pylonModel(kind);
    expect(attachments).toHaveLength(3);
    for (const a of attachments) {
      expect(a.y).toBeGreaterThan(0.3);
      expect(Math.abs(a.z)).toBeLessThan(0.02);
    }
    expect(attachments[0].x).toBeLessThan(attachments[1].x);
    expect(attachments[1].x).toBeLessThan(attachments[2].x);
  });

  it('is cached per kind', () => {
    expect(pylonModel('lattice')).toBe(pylonModel('lattice'));
    expect(pylonModel('pole')).toBe(pylonModel('pole'));
    expect(pylonModel('pole')).not.toBe(pylonModel('lattice'));
  });
});
