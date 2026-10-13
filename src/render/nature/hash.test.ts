import { describe, expect, it } from 'vitest';
import { tileHash } from './hash.ts';

describe('tileHash', () => {
  it('stays in [0, 1)', () => {
    for (let index = 0; index < 500; index++)
      for (let salt = 0; salt < 8; salt++) {
        const h = tileHash(index, salt);
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThan(1);
      }
  });
  it('is deterministic', () => {
    expect(tileHash(1234, 5)).toBe(tileHash(1234, 5));
  });
  it('differs across salts', () => {
    expect(tileHash(1234, 1)).not.toBe(tileHash(1234, 2));
  });
});
