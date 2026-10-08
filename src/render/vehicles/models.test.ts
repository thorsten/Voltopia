import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  BODY,
  busModel,
  containerWagonModel,
  estateModel,
  GLASS,
  hatchbackModel,
  hopperWagonModel,
  LOCOMOTIVE_LENGTH,
  locomotiveModel,
  MAX_PARTS_PER_MODEL,
  passengerWagonModel,
  sedanModel,
  suvModel,
  tankWagonModel,
  vanModel,
  WAGON_LENGTH,
  type VehicleModel,
} from './models.ts';

/** [builder, length, height, width] from the spec's table. */
const TABLE: Array<[string, () => VehicleModel, number, number, number]> = [
  ['hatchback', hatchbackModel, 0.26, 0.13, 0.14],
  ['sedan', sedanModel, 0.3, 0.13, 0.14],
  ['estate', estateModel, 0.3, 0.14, 0.14],
  ['suv', suvModel, 0.3, 0.16, 0.15],
  ['van', vanModel, 0.34, 0.18, 0.15],
  ['bus', busModel, 0.4, 0.2, 0.16],
  ['locomotive', locomotiveModel, LOCOMOTIVE_LENGTH, 0.3, 0.18],
  ['passenger wagon', passengerWagonModel, WAGON_LENGTH, 0.2, 0.17],
  ['container wagon', containerWagonModel, WAGON_LENGTH, 0.22, 0.17],
  ['hopper wagon', hopperWagonModel, WAGON_LENGTH, 0.22, 0.17],
  ['tank wagon', tankWagonModel, WAGON_LENGTH, 0.22, 0.17],
];

describe('vehicle models', () => {
  for (const [name, build, length, height, width] of TABLE) {
    it(`${name}: dimensions, vertex colours, part budget, details`, () => {
      const model = build();
      const g = model.geometry;
      g.computeBoundingBox();
      const box = g.boundingBox!;
      const size = box.getSize(new THREE.Vector3());
      expect(size.x).toBeCloseTo(length, 2);
      expect(Math.abs(size.x - length)).toBeLessThanOrEqual(0.005);
      // Container/hopper/tank give a maximum height; the others an exact one.
      if (name.endsWith('wagon') && name !== 'passenger wagon') {
        expect(size.y).toBeLessThanOrEqual(height + 0.005);
      } else {
        expect(Math.abs(size.y - height)).toBeLessThanOrEqual(0.005);
      }
      expect(Math.abs(size.z - width)).toBeLessThanOrEqual(0.005);
      expect(box.min.y).toBeCloseTo(0, 3); // tyres / bogies stand on y = 0
      expect(Math.abs(box.max.x + box.min.x)).toBeLessThanOrEqual(0.005); // centred on x
      const color = g.getAttribute('color');
      expect(color).toBeDefined();
      expect(color.count).toBe(g.getAttribute('position').count);
      expect(model.parts).toBeLessThanOrEqual(MAX_PARTS_PER_MODEL);
      expect(model.length).toBe(length);
      const white = new THREE.Color(BODY);
      let details = 0;
      for (let i = 0; i < color.count; i++) {
        if (color.getX(i) !== white.r || color.getY(i) !== white.g || color.getZ(i) !== white.b)
          details++;
      }
      expect(details).toBeGreaterThan(0);
    });
  }

  /**
   * Guard against a windscreen box sitting flush with the body's end
   * face: a glass box whose outer face is coplanar with the body face
   * z-fights with it. The windscreen must poke out past the half length.
   */
  const WINDSCREEN_MODELS: Array<[string, () => VehicleModel, number]> = [
    ['van', vanModel, 0.34],
    ['bus', busModel, 0.4],
    ['locomotive', locomotiveModel, LOCOMOTIVE_LENGTH],
  ];
  for (const [name, build, length] of WINDSCREEN_MODELS) {
    it(`${name}: windscreen glass pokes out past the body's end face`, () => {
      const g = build().geometry;
      const position = g.getAttribute('position');
      const color = g.getAttribute('color');
      const glass = new THREE.Color(GLASS);
      // Colours round-trip through a Float32Array, so compare with a
      // tolerance rather than exact equality (a fresh THREE.Color's
      // double-precision channels won't bit-match a float32 round trip).
      const EPS = 1e-5;
      let maxGlassX = -Infinity;
      for (let i = 0; i < color.count; i++) {
        if (
          Math.abs(color.getX(i) - glass.r) < EPS &&
          Math.abs(color.getY(i) - glass.g) < EPS &&
          Math.abs(color.getZ(i) - glass.b) < EPS
        ) {
          maxGlassX = Math.max(maxGlassX, position.getX(i));
        }
      }
      // A strict margin past half length, not just >=: a flush windscreen
      // (outer face exactly at the body's end face) would pass a plain
      // >= check up to floating-point noise, which is exactly the bug
      // this guards against.
      expect(maxGlassX).toBeGreaterThan(length / 2 + 0.001);
    });
  }
});
