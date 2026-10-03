import { describe, expect, it } from 'vitest';
import { Zone } from '../../shared/types.ts';
import { PART_KINDS, PartKind } from './primitives.ts';
import { ACCENT } from './palette.ts';
import {
  type BuildingPart,
  FOOTPRINT_HALF,
  MAX_PARTS_PER_KIND,
  MAX_PARTS_PER_TILE,
  STREET_FACES,
  StreetFace,
  buildingHeight,
  buildingParts,
  createPicker,
  faceDepth,
  faceOffset,
  mainBody,
  streetFaceFor,
} from './recipes.ts';

const VARIANTS = 8;
const GRID = 64;
/** Zones with recipes so far — later tasks append to this list. */
const ZONES: Zone[] = [Zone.Residential];

/** Every (zone, density, variant, face) over a sample of tile indices. */
function* allRecipes(indices: Iterable<number>): Generator<{
  zone: Zone;
  density: number;
  variant: number;
  face: StreetFace;
  index: number;
  parts: BuildingPart[];
}> {
  for (const zone of ZONES) {
    for (const density of [1, 2, 3]) {
      for (let variant = 0; variant < VARIANTS; variant++) {
        for (const face of STREET_FACES) {
          for (const index of indices) {
            yield {
              zone,
              density,
              variant,
              face,
              index,
              parts: buildingParts(zone, density, variant, index, face),
            };
          }
        }
      }
    }
  }
}

const FULL_GRID = Array.from({ length: GRID * GRID }, (_, i) => i);
const SAMPLE = Array.from({ length: 64 }, (_, i) => i * 61 + 7);

function partEdge(p: BuildingPart): number {
  // A quarter turn swaps the x and z extents; tilt only lowers the top.
  const [hx, hz] = p.turn % 2 === 0 ? [p.sx / 2, p.sz / 2] : [p.sz / 2, p.sx / 2];
  return Math.max(Math.abs(p.ox) + hx, Math.abs(p.oz) + hz);
}

describe('picker', () => {
  it('is deterministic and differs between neighbouring tiles', () => {
    const a = createPicker(3, 100);
    const b = createPicker(3, 100);
    const c = createPicker(3, 101);
    const seqA = [a.pick(10), a.pick(10), a.pick(10), a.pick(10)];
    const seqB = [b.pick(10), b.pick(10), b.pick(10), b.pick(10)];
    const seqC = [c.pick(10), c.pick(10), c.pick(10), c.pick(10)];
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
  });

  it('keeps pick in range and unit in [0, 1)', () => {
    const p = createPicker(7, 4095);
    for (let i = 0; i < 1000; i++) {
      const v = p.pick(5);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(5);
      const u = p.unit();
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
    }
  });
});

describe('street face helpers', () => {
  it('rotates a south-frame offset onto each face', () => {
    expect(faceOffset(0.1, 0.3, StreetFace.South)).toEqual([0.1, 0.3]);
    expect(faceOffset(0.1, 0.3, StreetFace.East)).toEqual([0.3, -0.1]);
    expect(faceOffset(0.1, 0.3, StreetFace.North)).toEqual([-0.1, -0.3]);
    expect(faceOffset(0.1, 0.3, StreetFace.West)).toEqual([-0.3, 0.1]);
  });

  it('prefers south, then east, west, north, and defaults to south', () => {
    const size = 8;
    const centre = 3 * size + 3;
    const roads = new Set<number>();
    const isRoad = (i: number) => roads.has(i);
    expect(streetFaceFor(centre, size, isRoad)).toBe(StreetFace.South);
    roads.add(centre - size); // north
    expect(streetFaceFor(centre, size, isRoad)).toBe(StreetFace.North);
    roads.add(centre - 1); // west
    expect(streetFaceFor(centre, size, isRoad)).toBe(StreetFace.West);
    roads.add(centre + 1); // east
    expect(streetFaceFor(centre, size, isRoad)).toBe(StreetFace.East);
    roads.add(centre + size); // south
    expect(streetFaceFor(centre, size, isRoad)).toBe(StreetFace.South);
  });

  it('ignores neighbours across the grid edge', () => {
    const size = 8;
    const roads = new Set<number>([size - 1 + 1]); // "east" of tile 7 is tile 8 — a wrap, not a neighbour
    expect(streetFaceFor(size - 1, size, (i) => roads.has(i))).toBe(StreetFace.South);
  });
});

describe('building recipes', () => {
  it('respect the per-tile and per-kind part budgets over the whole grid', () => {
    // Part counts never depend on the face, so one face over all 4096
    // tiles is the full proof (and keeps the test well under a second).
    for (const zone of ZONES) {
      for (const density of [1, 2, 3]) {
        for (let variant = 0; variant < VARIANTS; variant++) {
          for (const index of FULL_GRID) {
            const parts = buildingParts(zone, density, variant, index, StreetFace.South);
            expect(parts.length).toBeLessThanOrEqual(MAX_PARTS_PER_TILE);
            for (const kind of PART_KINDS) {
              let n = 0;
              for (const p of parts) if (p.kind === kind) n++;
              expect(n).toBeLessThanOrEqual(MAX_PARTS_PER_KIND[kind]);
            }
          }
        }
      }
    }
  });

  it('stay inside the footprint and above the ground', () => {
    for (const { parts, zone, density, variant, face, index } of allRecipes(SAMPLE)) {
      for (const p of parts) {
        expect(partEdge(p), `${zone}/${density}/${variant}/${face}/${index}`).toBeLessThanOrEqual(
          FOOTPRINT_HALF + 1e-9,
        );
        expect(p.oy).toBeGreaterThanOrEqual(-1e-9);
        expect(p.sx).toBeGreaterThan(0);
        expect(p.sy).toBeGreaterThan(0);
        expect(p.sz).toBeGreaterThan(0);
      }
    }
  });

  it('have exactly one main body and buildingHeight equals the tallest top', () => {
    for (const { parts, zone, density, variant, index } of allRecipes(SAMPLE)) {
      expect(parts.filter((p) => p.main)).toHaveLength(1);
      expect(mainBody(parts)).toBe(parts.find((p) => p.main));
      const top = Math.max(...parts.map((p) => p.oy + p.sy));
      expect(buildingHeight(zone, density, variant, index)).toBeCloseTo(top, 9);
    }
  });

  it('are deterministic and vary with the tile index for the same variant', () => {
    for (const zone of ZONES) {
      for (const density of [1, 2, 3]) {
        const a = buildingParts(zone, density, 2, 500, StreetFace.South);
        const b = buildingParts(zone, density, 2, 500, StreetFace.South);
        expect(a).toEqual(b);
        const distinct = new Set(
          Array.from({ length: 16 }, (_, i) =>
            JSON.stringify(buildingParts(zone, density, 2, 500 + i, StreetFace.South)),
          ),
        );
        expect(distinct.size).toBeGreaterThan(4);
      }
    }
  });

  it('grow rooftop PV from density 2 only', () => {
    for (const { parts, density } of allRecipes(SAMPLE)) {
      const pv = parts.some((p) => p.color.getHex() === ACCENT.rooftopPv.getHex());
      expect(pv).toBe(density >= 2);
    }
  });

  it('never tilt or rotate the main body', () => {
    for (const { parts } of allRecipes(SAMPLE)) {
      const main = mainBody(parts)!;
      expect(main.turn).toBe(0);
      expect(main.tilt ?? 0).toBe(0);
      expect(main.kind).toBe(PartKind.Box);
    }
  });

  it('give a residential house a door on the street face', () => {
    for (const face of STREET_FACES) {
      const parts = buildingParts(Zone.Residential, 1, 0, 1000, face);
      const main = mainBody(parts)!;
      const door = parts.find((p) => p.color.getHex() === ACCENT.door.getHex())!;
      expect(door).toBeDefined();
      // The door sits just outside the body on the street side: its offset
      // points along the face normal and has no sideways component.
      const dx = door.ox - main.ox;
      const dz = door.oz - main.oz;
      const [ex, ez] = faceOffset(0, 1, face);
      expect(dx * ex + dz * ez).toBeGreaterThan(faceDepth(main, face) / 2);
      expect(Math.abs(dx * ez - dz * ex)).toBeLessThan(1e-9);
      expect(door.turn).toBe(face);
    }
  });

  it('buildingHeight does not depend on the street face', () => {
    for (const zone of ZONES) {
      for (const density of [1, 2, 3]) {
        const tops = STREET_FACES.map((face) =>
          Math.max(...buildingParts(zone, density, 5, 77, face).map((p) => p.oy + p.sy)),
        );
        for (const t of tops) expect(t).toBeCloseTo(tops[0], 9);
      }
    }
  });
});
