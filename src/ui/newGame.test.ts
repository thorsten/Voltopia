import { describe, expect, it } from 'vitest';
import { DEFAULT_NEW_GAME, DISASTER_LEVELS } from './newGame.ts';

describe('disaster levels', () => {
  it('offers off, mild, normal and harsh', () => {
    expect(DISASTER_LEVELS.map((level) => level.id)).toEqual(['off', 'mild', 'normal', 'harsh']);
  });

  it('rises monotonically from off to harsh', () => {
    const scales = DISASTER_LEVELS.map((level) => level.scale);
    expect(scales[0]).toBe(0);
    for (let i = 1; i < scales.length; i++) expect(scales[i]).toBeGreaterThan(scales[i - 1]);
  });

  it('defaults a new city to normal', () => {
    expect(DEFAULT_NEW_GAME.disasterScale).toBe(1);
  });
});
