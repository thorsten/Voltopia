import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { fitShadowFrustum, viewGroundCorners, type Vec3 } from './shadowFrustum.ts';

const MAP = 2048;
const base = { mapSize: MAP, margin: 2, minHalfExtent: 4, depthPadding: 10 };
const down: Vec3 = { x: 0, y: -1, z: 0 };

/** A square of ground points centred on (cx, cz) with half-size h, at heights 0 and 3. */
function box(cx: number, cz: number, h: number): Vec3[] {
  const pts: Vec3[] = [];
  for (const y of [0, 3]) {
    for (const dx of [-h, h]) for (const dz of [-h, h]) pts.push({ x: cx + dx, y, z: cz + dz });
  }
  return pts;
}

/** Light-space coordinates of a point for a straight-down sun (basis from fitShadowFrustum). */
function inside(fit: ReturnType<typeof fitShadowFrustum>, p: Vec3, margin: number): boolean {
  return (
    Math.abs(p.x - fit.target.x) <= fit.halfWidth - margin + 1e-6 &&
    Math.abs(p.z - fit.target.z) <= fit.halfHeight - margin + 1e-6
  );
}

describe('fitShadowFrustum', () => {
  it('contains every view point plus the margin', () => {
    const pts = box(30, 30, 10);
    const fit = fitShadowFrustum({ ...base, points: pts, sunDirection: down });
    for (const p of pts) expect(inside(fit, p, base.margin)).toBe(true);
    // The light looks along the sun direction at the target.
    expect(fit.position.y).toBeGreaterThan(fit.target.y);
    expect(fit.far).toBeGreaterThan(0);
  });

  it('snaps the centre to shadow texels: sub-texel pans do not move it, one texel does', () => {
    const fit0 = fitShadowFrustum({ ...base, points: box(0, 0, 10), sunDirection: down });
    const texel = (2 * fit0.halfWidth) / MAP;
    const fitSmall = fitShadowFrustum({
      ...base,
      points: box(0.3 * texel, 0, 10),
      sunDirection: down,
    });
    const fitOne = fitShadowFrustum({ ...base, points: box(texel, 0, 10), sunDirection: down });
    expect(fitSmall.halfWidth).toBe(fit0.halfWidth);
    expect(fitSmall.target.x).toBeCloseTo(fit0.target.x, 9);
    expect(fitSmall.target.z).toBeCloseTo(fit0.target.z, 9);
    expect(
      Math.abs(fitOne.target.x - fit0.target.x) + Math.abs(fitOne.target.z - fit0.target.z),
    ).toBeCloseTo(texel, 9);
  });

  it('never shrinks below the minimum half extent', () => {
    const fit = fitShadowFrustum({ ...base, points: box(5, 5, 0.1), sunDirection: down });
    expect(fit.halfWidth).toBe(base.minHalfExtent);
    expect(fit.halfHeight).toBe(base.minHalfExtent);
  });

  it('stays finite for low and slanted suns', () => {
    for (const dir of [
      { x: 1, y: -0.05, z: 0 },
      { x: -0.7, y: -0.7, z: 0.2 },
      { x: 0.3, y: -1, z: -0.5 },
    ]) {
      const fit = fitShadowFrustum({ ...base, points: box(20, 10, 15), sunDirection: dir });
      for (const v of [
        fit.position.x,
        fit.position.y,
        fit.position.z,
        fit.target.x,
        fit.halfWidth,
        fit.halfHeight,
        fit.far,
      ]) {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });
});

describe('viewGroundCorners', () => {
  it('returns the 8 corners of the view box between two heights', () => {
    const cam = new THREE.OrthographicCamera(-10, 10, 5, -5, 0.1, 1000);
    cam.position.set(50, 60, 50);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    const corners = viewGroundCorners(cam, 0, 4);
    expect(corners).toHaveLength(8);
    expect(corners.filter((c) => Math.abs(c.y) < 1e-6)).toHaveLength(4);
    expect(corners.filter((c) => Math.abs(c.y - 4) < 1e-6)).toHaveLength(4);
    // The view centre (the look-at point) lies inside the ground quad's bounding box.
    const ground = corners.filter((c) => Math.abs(c.y) < 1e-6);
    expect(Math.min(...ground.map((c) => c.x))).toBeLessThan(0);
    expect(Math.max(...ground.map((c) => c.x))).toBeGreaterThan(0);
  });
});
