import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  BODY,
  busModel,
  containerWagonModel,
  estateModel,
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
});
