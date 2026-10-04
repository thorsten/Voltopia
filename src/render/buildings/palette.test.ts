import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { SupplyStatus, Zone } from '../../shared/types.ts';
import { ACCENT, ZONE_FAMILIES, applySupplyTint, AgeStage, applyAgeTint } from './palette.ts';

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

describe('age tint (building visuals stage 3)', () => {
  const hsl = (c: THREE.Color) => {
    const out = { h: 0, s: 0, l: 0 };
    c.getHSL(out);
    return out;
  };
  const wall = new THREE.Color(0xe3cfa6);
  const roof = new THREE.Color(0xb85c45);

  it('leaves a new building untouched', () => {
    expect(applyAgeTint(wall, AgeStage.New, false, new THREE.Color()).getHex()).toBe(0xe3cfa6);
    expect(applyAgeTint(roof, AgeStage.New, true, new THREE.Color()).getHex()).toBe(0xb85c45);
  });

  it('loses saturation and lightness with every stage, keeping the hue', () => {
    const livedIn = applyAgeTint(wall, AgeStage.LivedIn, false, new THREE.Color());
    const weathered = applyAgeTint(wall, AgeStage.Weathered, false, new THREE.Color());
    expect(hsl(livedIn).s).toBeLessThan(hsl(wall).s);
    expect(hsl(weathered).s).toBeLessThan(hsl(livedIn).s);
    expect(hsl(livedIn).l).toBeLessThan(hsl(wall).l);
    expect(hsl(weathered).l).toBeLessThan(hsl(livedIn).l);
    expect(hsl(livedIn).h).toBeCloseTo(hsl(wall).h, 2);
  });

  it('gives weathered pitched roofs a patina that walls and lived-in roofs do not get', () => {
    const weatheredRoof = applyAgeTint(roof, AgeStage.Weathered, true, new THREE.Color());
    const weatheredAsWall = applyAgeTint(roof, AgeStage.Weathered, false, new THREE.Color());
    const livedInRoof = applyAgeTint(roof, AgeStage.LivedIn, true, new THREE.Color());
    const livedInAsWall = applyAgeTint(roof, AgeStage.LivedIn, false, new THREE.Color());
    expect(weatheredRoof.getHex()).not.toBe(weatheredAsWall.getHex());
    expect(livedInRoof.getHex()).toBe(livedInAsWall.getHex());
  });

  it('treats a stage beyond weathered as weathered', () => {
    const a = applyAgeTint(wall, AgeStage.Weathered, false, new THREE.Color());
    const b = applyAgeTint(wall, 7, false, new THREE.Color());
    expect(b.getHex()).toBe(a.getHex());
  });

  it('keeps every channel in range for every family hue at every stage', () => {
    for (const family of Object.values(ZONE_FAMILIES)) {
      for (const list of [family.walls, family.roofs, family.trims]) {
        for (const c of list) {
          for (const stage of [AgeStage.New, AgeStage.LivedIn, AgeStage.Weathered]) {
            for (const isRoof of [false, true]) {
              const out = applyAgeTint(c, stage, isRoof, new THREE.Color());
              for (const channel of [out.r, out.g, out.b]) {
                expect(channel).toBeGreaterThanOrEqual(0);
                expect(channel).toBeLessThanOrEqual(1);
              }
            }
          }
        }
      }
    }
  });

  it('does not mutate its input', () => {
    applyAgeTint(wall, AgeStage.Weathered, true, new THREE.Color());
    expect(wall.getHex()).toBe(0xe3cfa6);
  });
});
