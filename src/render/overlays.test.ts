import { describe, expect, it } from 'vitest';
import { damageColor } from './overlays.ts';

describe('damageColor', () => {
  it('greens an intact tile and reds a wrecked one', () => {
    expect(damageColor(0)).not.toBe(damageColor(255));
  });

  it('is monotone in the damage', () => {
    const light = damageColor(30);
    const heavy = damageColor(200);
    expect(light).not.toBe(heavy);
  });
});
