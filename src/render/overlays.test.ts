import { describe, expect, it } from 'vitest';
import { HEATED_NONE, HEATED_SERVED, HEATED_TRUNK, TileType } from '../shared/types.ts';
import { damageColor, heatColor } from './overlays.ts';

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

describe('heatColor', () => {
  it('tints trunk roads, served buildings and unserved buildings differently', () => {
    const trunk = heatColor({ tileType: TileType.Road, density: 0, heated: HEATED_TRUNK });
    const served = heatColor({ tileType: TileType.Empty, density: 1, heated: HEATED_SERVED });
    const unserved = heatColor({ tileType: TileType.Empty, density: 1, heated: HEATED_NONE });
    expect(trunk).not.toBeNull();
    expect(served).not.toBeNull();
    expect(unserved).not.toBeNull();
    expect(new Set([trunk, served, unserved]).size).toBe(3);
  });

  it('leaves roads outside the network and empty land alone', () => {
    expect(heatColor({ tileType: TileType.Road, density: 0, heated: HEATED_NONE })).toBeNull();
    expect(heatColor({ tileType: TileType.Empty, density: 0, heated: HEATED_NONE })).toBeNull();
  });
});
