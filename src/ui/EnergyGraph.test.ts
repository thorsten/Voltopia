import { describe, expect, it } from 'vitest';
import { showsUnshifted } from './EnergyGraph.tsx';

const point = (consumption: number, unshifted: number) => ({
  generation: 0,
  consumption,
  unshifted,
  stateOfCharge: 0,
  price: 1,
});

describe('showsUnshifted', () => {
  it('hides the dashed line while nothing is shifted and shows it once something is', () => {
    expect(showsUnshifted({ history: [point(10, 10)], pending: point(12, 12) })).toBe(false);
    expect(showsUnshifted({ history: [point(10, 10)], pending: point(12, 13) })).toBe(true);
  });
});
