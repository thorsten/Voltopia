import { describe, expect, it } from 'vitest';
import { TICK_MS, tickIntervalMs } from './constants.ts';

describe('tickIntervalMs', () => {
  it('is null while paused', () => {
    expect(tickIntervalMs(0)).toBeNull();
  });

  it('divides the 1x tick interval by the speed', () => {
    expect(tickIntervalMs(1)).toBe(TICK_MS);
    expect(tickIntervalMs(3)).toBeCloseTo(TICK_MS / 3);
    expect(tickIntervalMs(6)).toBeCloseTo(41.67, 2);
  });
});
