import { describe, expect, it, vi } from 'vitest';
import type { TileDiff } from '../shared/types.ts';
import { Terrain } from '../shared/types.ts';
import { ElevationField } from './elevationField.ts';
import { GroundMesh } from './terrain.ts';

const SIZE = 6;
/** A 2×2 lake in the middle of the map. */
const LAKE = new Set([2 * SIZE + 2, 2 * SIZE + 3, 3 * SIZE + 2, 3 * SIZE + 3]);

function lakeDiffs(): TileDiff[] {
  const diffs: TileDiff[] = [];
  for (let index = 0; index < SIZE * SIZE; index++) {
    const terrain = LAKE.has(index) ? Terrain.Lake : Terrain.Land;
    diffs.push({ index, elevation: 0, terrain } as TileDiff);
  }
  return diffs;
}

/** Vertex colour of the ground corner at (vx, vz). */
function cornerColor(ground: GroundMesh, vx: number, vz: number): [number, number, number] {
  const geometry = ground.ground.geometry;
  const position = geometry.attributes.position;
  const color = geometry.attributes.color;
  for (let i = 0; i < position.count; i++) {
    if (Math.round(position.getX(i)) === vx && Math.round(position.getZ(i)) === vz) {
      return [color.getX(i), color.getY(i), color.getZ(i)];
    }
  }
  throw new Error(`no vertex at ${vx}/${vz}`);
}

function lakeGround(): GroundMesh {
  const field = new ElevationField(SIZE);
  const ground = new GroundMesh(SIZE, field);
  const diffs = lakeDiffs();
  field.applyDiffs(diffs);
  ground.applyDiffs(diffs);
  return ground;
}

describe('sandy shores', () => {
  it('tints corners touching water and land', () => {
    const [r, , b] = cornerColor(lakeGround(), 2, 2);
    expect(r).not.toBeCloseTo(b, 5);
  });

  it('keeps corners inside the water grey', () => {
    const [r, g, b] = cornerColor(lakeGround(), 3, 3);
    expect(r).toBe(g);
    expect(g).toBe(b);
  });

  it('keeps inland corners grey', () => {
    const [r, g, b] = cornerColor(lakeGround(), 0, 0);
    expect(r).toBe(g);
    expect(g).toBe(b);
  });

  it('does not rebuild for an identical diff batch', () => {
    const ground = lakeGround();
    const spy = vi.spyOn(ground.ground.geometry, 'computeVertexNormals');
    ground.applyDiffs(lakeDiffs());
    expect(spy).not.toHaveBeenCalled();
  });

  it('tints regardless of whether the field updates before or after', () => {
    const field = new ElevationField(SIZE);
    const ground = new GroundMesh(SIZE, field);
    const diffs = lakeDiffs();
    ground.applyDiffs(diffs);
    field.applyDiffs(diffs);
    ground.applyDiffs([]);
    const [r, , b] = cornerColor(ground, 2, 2);
    expect(r).not.toBeCloseTo(b, 5);
    const [ir, ig, ib] = cornerColor(ground, 3, 3);
    expect(ir).toBe(ig);
    expect(ig).toBe(ib);
  });
});
