import { describe, expect, it } from 'vitest';
import {
  CAR_COLORS,
  CAR_STYLES,
  carColorOf,
  carStyleOf,
  containerColorOf,
  FREIGHT_BODIES,
  freightBodyOf,
  vehicleHash,
} from './variety.ts';

describe('vehicle variety', () => {
  it('is stable per id', () => {
    for (const id of [1, 42, 99_999, 3 * 2 ** 30 + 17]) {
      expect(carStyleOf(id)).toBe(carStyleOf(id));
      expect(carColorOf(id)).toBe(carColorOf(id));
      expect(freightBodyOf(id)).toBe(freightBodyOf(id));
      expect(containerColorOf(id)).toBe(containerColorOf(id));
      expect(Number.isInteger(vehicleHash(id))).toBe(true);
      expect(vehicleHash(id)).toBeGreaterThanOrEqual(0);
    }
  });

  it('spreads styles, bodies and paints over consecutive ids', () => {
    const styles = new Map<string, number>();
    const bodies = new Map<string, number>();
    const paints = new Set<number>();
    for (let id = 1; id <= 1000; id++) {
      styles.set(carStyleOf(id), (styles.get(carStyleOf(id)) ?? 0) + 1);
      bodies.set(freightBodyOf(id), (bodies.get(freightBodyOf(id)) ?? 0) + 1);
      paints.add(carColorOf(id));
    }
    for (const s of CAR_STYLES) expect(styles.get(s) ?? 0).toBeGreaterThanOrEqual(150);
    for (const b of FREIGHT_BODIES) expect(bodies.get(b) ?? 0).toBeGreaterThanOrEqual(150);
    expect(paints.size).toBe(CAR_COLORS.length);
  });

  it('wagons of one train (ids k * 2^30 + trainId) get different bodies often', () => {
    let differing = 0;
    for (let train = 1; train <= 200; train++) {
      const set = new Set([1, 2, 3, 4].map((k) => freightBodyOf(train + k * 2 ** 30)));
      if (set.size > 1) differing++;
    }
    expect(differing).toBeGreaterThan(150);
  });
});
