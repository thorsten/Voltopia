import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { fitShadowFrustum, viewGroundCorners, type Vec3 } from './shadowFrustum.ts';

const MAP = 2048;
// casterHeight stays at or below depthPadding so straight-down-sun cases above are unaffected
// by the sun-side padding fix (max(depthPadding, casterHeight / |f.y|) === depthPadding there).
const base = { mapSize: MAP, margin: 2, minHalfExtent: 4, depthPadding: 10, casterHeight: 6 };
const down: Vec3 = { x: 0, y: -1, z: 0 };

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(a.x, a.y, a.z) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
}

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

  it('contains every view point plus the margin for a slanted sun, with the light on the sun side', () => {
    const dir: Vec3 = { x: -0.7, y: -0.3, z: 0.2 };
    const pts = box(20, 10, 15);
    const fit = fitShadowFrustum({ ...base, points: pts, sunDirection: dir });
    // Rebuild the fit's own basis (it hands back `up`, the reference it used) rather than
    // assuming the world axes line up with the shadow camera's, as the straight-down tests do.
    const f = normalize(dir);
    const r = normalize(cross(fit.up, f));
    const u = cross(f, r);
    const targetX = dot(fit.target, r);
    const targetY = dot(fit.target, u);
    for (const p of pts) {
      expect(Math.abs(dot(p, r) - targetX)).toBeLessThanOrEqual(fit.halfWidth - base.margin + 1e-6);
      expect(Math.abs(dot(p, u) - targetY)).toBeLessThanOrEqual(
        fit.halfHeight - base.margin + 1e-6,
      );
    }
    const toLight = {
      x: fit.position.x - fit.target.x,
      y: fit.position.y - fit.target.y,
      z: fit.position.z - fit.target.z,
    };
    expect(dot(toLight, dir)).toBeLessThan(0);
  });

  it('keeps a tall caster just outside the view, at casterHeight, within [0, far] for a low sun', () => {
    // Flat view, nothing tall actually inside it.
    const dir: Vec3 = { x: 1, y: -0.1, z: 0 };
    const casterHeight = 8;
    const viewPts = box(0, 0, 5);
    const fit = fitShadowFrustum({ ...base, points: viewPts, sunDirection: dir, casterHeight });
    const f = normalize(dir);
    // A caster this far upstream, at casterHeight, still has to reach the near plane: its
    // shadow can travel casterHeight / |f.y| along the ground before running out of height.
    const maxCastDistance = casterHeight / Math.abs(f.y);
    const caster: Vec3 = {
      x: -5 - 0.5 * maxCastDistance * f.x,
      y: casterHeight,
      z: -0.5 * maxCastDistance * f.z,
    };
    const casterPz = dot(caster, f);
    const positionPz = dot(fit.position, f);
    expect(casterPz).toBeGreaterThanOrEqual(positionPz - 1e-6);
    expect(casterPz).toBeLessThanOrEqual(positionPz + fit.far + 1e-6);
  });

  it('clamps the fitted extent to the map bounds plus margin, not the full (zoomed-out) view', () => {
    const farOutPts = box(32, 32, 300); // far larger than any real view of a real map
    const unbounded = fitShadowFrustum({ ...base, points: farOutPts, sunDirection: down });
    const bounds = { minX: 0, maxX: 64, minZ: 0, maxZ: 64 };
    const bounded = fitShadowFrustum({ ...base, points: farOutPts, sunDirection: down, bounds });
    expect(bounded.halfWidth).toBeLessThan(unbounded.halfWidth);
    expect(bounded.halfHeight).toBeLessThan(unbounded.halfHeight);
    // Clamped to [minX - margin, maxX + margin], then the margin is added again when sizing
    // the half extent, so the ceiling is the map's half-extent plus twice the margin.
    expect(bounded.halfWidth).toBeLessThanOrEqual(64 / 2 + 2 * base.margin);
    expect(bounded.halfHeight).toBeLessThanOrEqual(64 / 2 + 2 * base.margin);
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
