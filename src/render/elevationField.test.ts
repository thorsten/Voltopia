import { describe, expect, it } from 'vitest';
import type { TileDiff } from '../shared/types.ts';
import { Terrain } from '../shared/types.ts';
import { ElevationField, LEVEL_HEIGHT } from './elevationField.ts';

const SIZE = 6;

/** A field where every tile's level comes from `levelOf(x, z)`. */
function field(levelOf: (x: number, z: number) => number): ElevationField {
  const f = new ElevationField(SIZE);
  const diffs: TileDiff[] = [];
  for (let z = 0; z < SIZE; z++) {
    for (let x = 0; x < SIZE; x++) {
      diffs.push({ index: z * SIZE + x, elevation: levelOf(x, z) } as TileDiff);
    }
  }
  f.applyDiffs(diffs);
  return f;
}

/** A field where levels and terrain both come from callbacks. */
function shoreField(
  levelOf: (x: number, z: number) => number,
  terrainOf: (x: number, z: number) => Terrain,
): ElevationField {
  const f = new ElevationField(SIZE);
  const diffs: TileDiff[] = [];
  for (let z = 0; z < SIZE; z++) {
    for (let x = 0; x < SIZE; x++) {
      diffs.push({
        index: z * SIZE + x,
        elevation: levelOf(x, z),
        terrain: terrainOf(x, z),
      } as TileDiff);
    }
  }
  f.applyDiffs(diffs);
  return f;
}

const at = (x: number, z: number) => z * SIZE + x;

describe('ElevationField ground triangles', () => {
  it('is flat with zero slopes on level ground', () => {
    const f = field(() => 2);
    expect(f.trianglePlane(at(2, 2), false)).toEqual({ gx: 0, gz: 0 });
    expect(f.trianglePlane(at(2, 2), true)).toEqual({ gx: 0, gz: 0 });
    expect(f.surfaceY(2.5, 2.5)).toBeCloseTo(2 * LEVEL_HEIGHT, 9);
  });

  it('both triangles share the plane of a uniform ramp', () => {
    const f = field((x) => x);
    const low = f.trianglePlane(at(2, 2), false);
    const high = f.trianglePlane(at(2, 2), true);
    expect(low.gx).toBeCloseTo(LEVEL_HEIGHT, 9);
    expect(low.gz).toBeCloseTo(0, 9);
    expect(high).toEqual(low);
    expect(f.surfaceY(2.5, 2.5)).toBeCloseTo(2 * LEVEL_HEIGHT, 9);
  });

  it('surfaceY interpolates each triangle exactly through its three corners', () => {
    // A saddle: two diagonal neighbours are hills, so the tile between
    // them has one high corner and the two triangles are different planes.
    const f = field((x, z) => ((x === 2 && z === 2) || (x === 3 && z === 3) ? 3 : 0));
    const index = at(2, 2);
    const c00 = f.cornerY(2, 2);
    const c10 = f.cornerY(3, 2);
    const c01 = f.cornerY(2, 3);
    const c11 = f.cornerY(3, 3);
    expect(c00 + c11).not.toBeCloseTo(c10 + c01, 6); // genuinely non-planar
    expect(f.surfaceY(2, 2)).toBeCloseTo(c00, 9);
    expect(f.surfaceY(3 - 1e-9, 2)).toBeCloseTo(c10, 6);
    expect(f.surfaceY(2, 3 - 1e-9)).toBeCloseTo(c01, 6);
    expect(f.surfaceY(3 - 1e-9, 3 - 1e-9)).toBeCloseTo(c11, 6);
    // The crease from (2,3) to (3,2) is shared by both triangles.
    const low = f.trianglePlane(index, false);
    const high = f.trianglePlane(index, true);
    const onCreaseLow = c00 + low.gx * 0.5 + low.gz * 0.5;
    const onCreaseHigh = c11 - high.gx * 0.5 - high.gz * 0.5;
    expect(onCreaseLow).toBeCloseTo(onCreaseHigh, 9);
    expect(f.surfaceY(2.5, 2.5)).toBeCloseTo(onCreaseLow, 9);
  });

  it('a rectangle inside one triangle lies flush when fitted to that plane', () => {
    const f = field((x, z) => ((x === 2 && z === 2) || (x === 3 && z === 3) ? 3 : 0));
    const index = at(2, 2);
    // East road arm: x in [2.81, 3], z in [2.19, 2.81] — inside the high triangle.
    const { gx, gz } = f.trianglePlane(index, true);
    const cx = 2.905;
    const cz = 2.5;
    const centre = f.surfaceY(cx, cz);
    for (const [dx, dz] of [
      [-0.095, -0.31],
      [0.095, -0.31],
      [-0.095, 0.31],
      [0.095, 0.31],
    ]) {
      expect(centre + gx * dx + gz * dz).toBeCloseTo(f.surfaceY(cx + dx, cz + dz), 9);
    }
  });

  it('classifies points against the crease', () => {
    expect(ElevationField.inHighTriangle(0.2, 0.2)).toBe(false);
    expect(ElevationField.inHighTriangle(0.8, 0.8)).toBe(true);
    expect(ElevationField.inHighTriangle(0.5, 0.5)).toBe(false); // on the crease counts as low
  });
});

describe('ElevationField smooth normals', () => {
  const len = (n: { x: number; y: number; z: number }) => Math.hypot(n.x, n.y, n.z);

  it('points straight up on level ground', () => {
    const f = field(() => 2);
    expect(f.smoothNormal(2.3, 2.6)).toEqual({ x: 0, y: 1, z: 0 });
    expect(f.cornerNormal(0, 0)).toEqual({ x: 0, y: 1, z: 0 });
  });

  it('matches the single plane normal on a uniform ramp, everywhere', () => {
    const f = field((x) => x);
    const gx = LEVEL_HEIGHT;
    const expected = { x: -gx / Math.hypot(gx, 1), y: 1 / Math.hypot(gx, 1), z: 0 };
    for (const [x, z] of [
      [2.1, 2.1],
      [2.9, 2.9],
      [2.5, 2.5],
      [3, 3],
    ]) {
      const n = f.smoothNormal(x, z);
      expect(n.x).toBeCloseTo(expected.x, 9);
      expect(n.y).toBeCloseTo(expected.y, 9);
      expect(n.z).toBeCloseTo(expected.z, 9);
    }
  });

  it('is unit length and continuous across the crease of a saddle', () => {
    const f = field((x, z) => ((x === 2 && z === 2) || (x === 3 && z === 3) ? 3 : 0));
    const low = f.trianglePlane(at(2, 2), false);
    const high = f.trianglePlane(at(2, 2), true);
    expect(low).not.toEqual(high);
    const a = f.smoothNormal(2.5 - 1e-6, 2.5);
    const b = f.smoothNormal(2.5 + 1e-6, 2.5);
    expect(len(a)).toBeCloseTo(1, 9);
    expect(Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z)).toBeLessThan(1e-4);
  });

  it('corner normals average the surrounding triangle normals like computeVertexNormals', () => {
    const f = field((x, z) => ((x === 2 && z === 2) || (x === 3 && z === 3) ? 3 : 0));
    // Vertex (3, 3) touches six triangles: the low one of tile (3,3), both of
    // tiles (2,3) and (3,2), and the high one of tile (2,2).
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (const [index, high] of [
      [at(3, 3), false],
      [at(2, 3), false],
      [at(2, 3), true],
      [at(3, 2), false],
      [at(3, 2), true],
      [at(2, 2), true],
    ] as const) {
      const { gx, gz } = f.trianglePlane(index, high);
      sx -= gx;
      sy += 1;
      sz -= gz;
    }
    const l = Math.hypot(sx, sy, sz);
    const n = f.cornerNormal(3, 3);
    expect(n.x).toBeCloseTo(sx / l, 9);
    expect(n.y).toBeCloseTo(sy / l, 9);
    expect(n.z).toBeCloseTo(sz / l, 9);
  });
});

describe('ElevationField shorelines', () => {
  /** Sea at level 0 on the left half, land at level 2 on the right. */
  const coast = () =>
    shoreField(
      (x) => (x < 3 ? 0 : 2),
      (x) => (x < 3 ? Terrain.Sea : Terrain.Land),
    );

  it('sinks a ground corner that touches water to the water level', () => {
    // Corner (3, z) is shared by two sea tiles at 0 and two land tiles at
    // 2. Averaging lifts it to 0.5 levels — above every possible tide —
    // so the ground would render through the sea surface. The shore steps
    // down into the water instead.
    expect(coast().cornerY(3, 2)).toBeCloseTo(0, 9);
  });

  it('keeps the whole ground of a water tile at or below its own level', () => {
    // What the water slab has to cover: no corner of a sea tile may rise
    // above the tile's own level, or the ground pokes through the surface.
    const f = coast();
    for (let z = 0; z < SIZE; z++) {
      for (let x = 0; x < 3; x++) {
        expect(f.maxCornerY(at(x, z))).toBeLessThanOrEqual(0);
      }
    }
  });

  it('still averages corners that touch no water at all', () => {
    // The smooth relief inland must not change: a corner between land
    // tiles of level 1 and 3 stays at their mean.
    const f = shoreField(
      (x) => (x < 3 ? 1 : 3),
      () => Terrain.Land,
    );
    expect(f.cornerY(3, 2)).toBeCloseTo(2 * LEVEL_HEIGHT, 9);
  });

  it('treats river and lake tiles as water too', () => {
    for (const water of [Terrain.River, Terrain.Lake]) {
      const f = shoreField(
        (x, z) => (x === 3 && z === 3 ? 1 : 3),
        (x, z) => (x === 3 && z === 3 ? water : Terrain.Land),
      );
      expect(f.cornerY(3, 3)).toBeCloseTo(1 * LEVEL_HEIGHT, 9);
    }
  });
});
