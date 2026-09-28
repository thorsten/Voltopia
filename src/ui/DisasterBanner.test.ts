import { describe, expect, it } from 'vitest';
import { TICKS_PER_DAY } from '../shared/constants.ts';
import { countdownParts } from './DisasterBanner.tsx';

describe('countdownParts', () => {
  it('turns ticks into in-game hours and minutes', () => {
    const hour = TICKS_PER_DAY / 24;
    expect(countdownParts(hour * 2)).toEqual({ hours: 2, minutes: 0 });
    expect(countdownParts(hour + hour / 2)).toEqual({ hours: 1, minutes: 30 });
  });

  it('never goes negative', () => {
    expect(countdownParts(-10)).toEqual({ hours: 0, minutes: 0 });
  });
});
