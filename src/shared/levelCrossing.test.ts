import { describe, expect, it } from 'vitest';
import { BALANCE } from './constants.ts';
import { crossingIsClosed } from './levelCrossing.ts';

describe('crossingIsClosed', () => {
  const { crossingApproachTiles: approach, crossingLateralTiles: lateral } = BALANCE.rail;

  it('closes for a train approaching along the track', () => {
    expect(crossingIsClosed([{ x: 3.5 + approach, y: 2.5 }], 3.5, 2.5, true)).toBe(true);
    expect(crossingIsClosed([{ x: 3.5 - approach, y: 2.5 }], 3.5, 2.5, true)).toBe(true);
  });

  it('stays open for a train beyond the approach distance', () => {
    expect(crossingIsClosed([{ x: 3.5 + approach + 0.01, y: 2.5 }], 3.5, 2.5, true)).toBe(false);
  });

  it('ignores a train off the track centre line', () => {
    expect(crossingIsClosed([{ x: 4, y: 2.5 + lateral + 0.01 }], 3.5, 2.5, true)).toBe(false);
  });

  it('reads the other axis for a track running along y', () => {
    expect(crossingIsClosed([{ x: 3.5, y: 2.5 + approach }], 3.5, 2.5, false)).toBe(true);
    expect(crossingIsClosed([{ x: 3.5 + approach, y: 2.5 }], 3.5, 2.5, false)).toBe(false);
  });

  it('is open without trains', () => {
    expect(crossingIsClosed([], 3.5, 2.5, true)).toBe(false);
  });
});
