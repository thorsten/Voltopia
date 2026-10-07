import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { PALETTE } from './scene.ts';
import { inverseNeutralToneMap, neutralToneMap } from './toneMapping.ts';

const linear = (r: number, g: number, b: number) =>
  new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace);

describe('neutralToneMap', () => {
  it('subtracts the flat 0.04 offset in the mid tones', () => {
    const out = neutralToneMap(linear(0.5, 0.3, 0.2), 1);
    expect(out.r).toBeCloseTo(0.46, 9);
    expect(out.g).toBeCloseTo(0.26, 9);
    expect(out.b).toBeCloseTo(0.16, 9);
  });

  it('maps a dark grey onto the quadratic toe', () => {
    const out = neutralToneMap(linear(0.04, 0.04, 0.04), 1);
    expect(out.r).toBeCloseTo(6.25 * 0.04 * 0.04, 9);
  });

  it('compresses highlights below 1', () => {
    const out = neutralToneMap(linear(4, 4, 4), 1);
    expect(out.r).toBeLessThan(1);
    expect(out.r).toBeGreaterThan(0.9);
  });

  it('applies the exposure before the curve', () => {
    const a = neutralToneMap(linear(0.25, 0.15, 0.1), 2);
    const b = neutralToneMap(linear(0.5, 0.3, 0.2), 1);
    expect(a.equals(b)).toBe(true);
  });
});

describe('inverseNeutralToneMap', () => {
  const cases: [string, THREE.Color][] = [
    ['day sky (in the shoulder)', new THREE.Color(PALETTE.skyDay)],
    ['night sky (in the toe)', new THREE.Color(PALETTE.skyNight)],
    ['dusk orange', new THREE.Color(0xf2a05e)],
    ['black', linear(0, 0, 0)],
  ];
  for (const [name, color] of cases) {
    for (const exposure of [0.8, 1, 1.3]) {
      it(`round-trips the ${name} at exposure ${exposure}`, () => {
        const back = neutralToneMap(inverseNeutralToneMap(color, exposure), exposure);
        expect(back.r).toBeCloseTo(color.r, 5);
        expect(back.g).toBeCloseTo(color.g, 5);
        expect(back.b).toBeCloseTo(color.b, 5);
      });
    }
  }

  it('may write into its own input', () => {
    const color = new THREE.Color(PALETTE.skyNight);
    const expected = inverseNeutralToneMap(color, 1);
    inverseNeutralToneMap(color, 1, color);
    expect(color.equals(expected)).toBe(true);
  });
});
