import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { SupplyStatus, Zone } from '../../shared/types.ts';
import { ACCENT, ZONE_FAMILIES, applySupplyTint } from './palette.ts';

describe('building palette', () => {
  it.each([Zone.Residential, Zone.Commercial, Zone.Retail])(
    'zone %i exposes 4 wall, 3 roof and 2 trim hues',
    (zone) => {
      const family = ZONE_FAMILIES[zone];
      expect(family.walls).toHaveLength(4);
      expect(family.roofs).toHaveLength(3);
      expect(family.trims).toHaveLength(2);
    },
  );

  it('keeps the rooftop PV navy the sim-era renderer used', () => {
    expect(ACCENT.rooftopPv.getHex()).toBe(0x2b3d66);
  });

  it('leaves supplied buildings untouched', () => {
    const wall = new THREE.Color(0xe3cfa6);
    const out = applySupplyTint(wall, SupplyStatus.Supplied, new THREE.Color());
    expect(out.getHex()).toBe(0xe3cfa6);
  });

  it('greys undersupplied buildings a little and disconnected ones more', () => {
    const wall = new THREE.Color(0xe3cfa6);
    const under = applySupplyTint(wall, SupplyStatus.Undersupplied, new THREE.Color());
    const off = applySupplyTint(wall, SupplyStatus.NotConnected, new THREE.Color());
    const saturation = (c: THREE.Color) => {
      const hsl = { h: 0, s: 0, l: 0 };
      c.getHSL(hsl);
      return hsl.s;
    };
    expect(saturation(under)).toBeLessThan(saturation(wall));
    expect(saturation(off)).toBeLessThan(saturation(under));
    const lightness = (c: THREE.Color) => {
      const hsl = { h: 0, s: 0, l: 0 };
      c.getHSL(hsl);
      return hsl.l;
    };
    expect(lightness(off)).toBeLessThan(lightness(under));
    for (const c of [under, off]) {
      for (const channel of [c.r, c.g, c.b]) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    }
  });

  it('does not mutate its input', () => {
    const wall = new THREE.Color(0xe3cfa6);
    applySupplyTint(wall, SupplyStatus.NotConnected, new THREE.Color());
    expect(wall.getHex()).toBe(0xe3cfa6);
  });
});
