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
const ZONES: Zone[] = [Zone.Residential, Zone.Commercial, Zone.Retail];

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
    // tiles is the full proof. Assertions are accumulated and checked once
    // after the loops (rather than inside the hot loop) to keep this test
    // fast even with ~500k part lists across all zones.
    const violations: string[] = [];
    for (const zone of ZONES) {
      for (const density of [1, 2, 3]) {
        for (let variant = 0; variant < VARIANTS; variant++) {
          for (const index of FULL_GRID) {
            const parts = buildingParts(zone, density, variant, index, StreetFace.South);
            if (parts.length > MAX_PARTS_PER_TILE) {
              violations.push(
                `${zone}/${density}/${variant}/${index}: ${parts.length} parts > ${MAX_PARTS_PER_TILE}`,
              );
            }
            for (const kind of PART_KINDS) {
              let n = 0;
              for (const p of parts) if (p.kind === kind) n++;
              const max = MAX_PARTS_PER_KIND[kind];
              if (n > max) {
                violations.push(
                  `${zone}/${density}/${variant}/${index}: ${n} parts of kind ${kind} > ${max}`,
                );
              }
            }
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('stay inside the footprint and above the ground', () => {
    // Assertions are accumulated as violations and checked once after the
    // loop (rather than inside it) to keep this test fast even with tens of
    // thousands of part lists across all zones, densities and faces.
    const violations: string[] = [];
    for (const { parts, zone, density, variant, face, index } of allRecipes(SAMPLE)) {
      const tag = `${zone}/${density}/${variant}/${face}/${index}`;
      for (const p of parts) {
        const edge = partEdge(p);
        if (edge > FOOTPRINT_HALF + 1e-9)
          violations.push(`${tag}: edge ${edge} > ${FOOTPRINT_HALF}`);
        if (p.oy < -1e-9) violations.push(`${tag}: oy ${p.oy} < 0`);
        if (!(p.sx > 0)) violations.push(`${tag}: sx ${p.sx} <= 0`);
        if (!(p.sy > 0)) violations.push(`${tag}: sy ${p.sy} <= 0`);
        if (!(p.sz > 0)) violations.push(`${tag}: sz ${p.sz} <= 0`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('have exactly one main body and buildingHeight equals the tallest top', () => {
    // See the footprint test above for why violations are batched.
    const violations: string[] = [];
    for (const { parts, zone, density, variant, index } of allRecipes(SAMPLE)) {
      const tag = `${zone}/${density}/${variant}/${index}`;
      const mains = parts.filter((p) => p.main);
      if (mains.length !== 1) violations.push(`${tag}: ${mains.length} main parts, expected 1`);
      if (mainBody(parts) !== parts.find((p) => p.main)) {
        violations.push(`${tag}: mainBody() does not match parts.find(main)`);
      }
      const top = Math.max(...parts.map((p) => p.oy + p.sy));
      const height = buildingHeight(zone, density, variant, index);
      if (Math.abs(height - top) > 1e-9) {
        violations.push(`${tag}: buildingHeight ${height} != tallest top ${top}`);
      }
    }
    expect(violations).toEqual([]);
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
    // See the footprint test above for why violations are batched.
    const violations: string[] = [];
    for (const { parts, zone, density, variant, face, index } of allRecipes(SAMPLE)) {
      const main = mainBody(parts)!;
      const tag = `${zone}/${density}/${variant}/${face}/${index}`;
      if (main.turn !== 0) violations.push(`${tag}: main.turn ${main.turn} != 0`);
      if ((main.tilt ?? 0) !== 0) violations.push(`${tag}: main.tilt ${main.tilt} != 0`);
      if (main.kind !== PartKind.Box) violations.push(`${tag}: main.kind ${main.kind} != Box`);
    }
    expect(violations).toEqual([]);
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

  it('give every commercial tower an antenna cylinder for the stage 2 light', () => {
    for (const index of SAMPLE) {
      for (let variant = 0; variant < VARIANTS; variant++) {
        const parts = buildingParts(Zone.Commercial, 3, variant, index, StreetFace.South);
        const antennas = parts.filter(
          (p) => p.kind === PartKind.Cylinder && p.color.getHex() === ACCENT.antenna.getHex(),
        );
        expect(antennas).toHaveLength(1);
        const main = mainBody(parts)!;
        // The antenna stands on top of the setback, above the main body.
        expect(antennas[0].oy).toBeGreaterThan(main.oy + main.sy);
      }
    }
  });

  it('make commercial towers the tallest buildings', () => {
    for (const index of SAMPLE) {
      const tower = buildingHeight(Zone.Commercial, 3, index % VARIANTS, index);
      const flat = buildingHeight(Zone.Residential, 3, index % VARIANTS, index);
      expect(tower).toBeGreaterThan(flat);
    }
  });

  it('centres the dormer gable on its dormer box (residential density 2)', () => {
    const violations: string[] = [];
    for (const face of STREET_FACES) {
      for (let variant = 0; variant < VARIANTS; variant++) {
        for (const index of SAMPLE) {
          const parts = buildingParts(Zone.Residential, 2, variant, index, face);
          const gables = parts.filter((p) => p.kind === PartKind.GableRoof);
          if (gables.length < 2) continue; // no dormer on this variant/tile
          const dormerRoof = gables.reduce((a, b) => (a.sx * a.sz <= b.sx * b.sz ? a : b));
          const dormerBox = parts.find(
            (p) =>
              p.kind === PartKind.Box &&
              !p.main &&
              Math.abs(p.oy - (dormerRoof.oy - 0.1)) < 1e-6 &&
              (Math.abs(p.sx - 0.14) < 1e-9 || Math.abs(p.sz - 0.14) < 1e-9),
          );
          if (!dormerBox) {
            violations.push(`${face}/${variant}/${index}: no dormer box found for dormer roof`);
            continue;
          }
          if (
            Math.abs(dormerBox.ox - dormerRoof.ox) > 1e-9 ||
            Math.abs(dormerBox.oz - dormerRoof.oz) > 1e-9
          ) {
            violations.push(
              `${face}/${variant}/${index}: dormer roof (${dormerRoof.ox},${dormerRoof.oz}) ` +
                `off dormer box (${dormerBox.ox},${dormerBox.oz})`,
            );
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps the density-1 side wing off the door side on east/west faces', () => {
    const violations: string[] = [];
    for (const face of [StreetFace.East, StreetFace.West] as const) {
      for (let variant = 0; variant < VARIANTS; variant++) {
        for (const index of SAMPLE) {
          const parts = buildingParts(Zone.Residential, 1, variant, index, face);
          const main = mainBody(parts)!;
          const wing = parts.find((p) => p.kind === PartKind.Box && !p.main && !p.accent);
          if (!wing) continue; // no side extension on this roll
          const wingSign = Math.sign(wing.ox - main.ox);
          const doorSign = face === StreetFace.East ? 1 : -1;
          if (wingSign === doorSign) {
            violations.push(
              `${face}/${variant}/${index}: wing lands on the door side ` +
                `(wing.ox=${wing.ox}, main.ox=${main.ox})`,
            );
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('hang retail awnings on the street face', () => {
    for (const face of STREET_FACES) {
      for (const density of [1, 2, 3]) {
        const parts = buildingParts(Zone.Retail, density, 1, 2048, face);
        const main = mainBody(parts)!;
        const [ex, ez] = faceOffset(0, 1, face);
        // Thin accent slabs whose offset along the face normal lies beyond
        // the body: awnings (signs are taller, PV sits on the roof inside it).
        const awnings = parts.filter(
          (p) =>
            p.accent &&
            p.kind === PartKind.Box &&
            p.sy <= 0.05 &&
            (p.ox - main.ox) * ex + (p.oz - main.oz) * ez > faceDepth(main, face) / 2,
        );
        expect(awnings.length).toBe(density === 3 ? 2 : 1);
      }
    }
  });
});
