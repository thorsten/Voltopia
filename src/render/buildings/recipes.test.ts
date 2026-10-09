import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Zone } from '../../shared/types.ts';
import { PART_KINDS, PartKind } from './primitives.ts';
import { ACCENT, ZONE_FAMILIES } from './palette.ts';
import { MAX_PUFF_ANCHORS_PER_TILE } from './accents.ts';
import {
  type BuildingPart,
  FOOTPRINT_HALF,
  GUTTER,
  MAX_PARTS_PER_KIND,
  MAX_PARTS_PER_TILE,
  PLINTH_HEIGHT,
  PLINTH_OVERHANG,
  PartRole,
  RIDGE_CAP,
  RIDGE_DARKEN,
  ROOF_OVERHANG,
  STREET_FACES,
  StreetFace,
  buildingHeight,
  buildingParts,
  createPicker,
  faceDepth,
  faceOffset,
  isDetailPart,
  mainBody,
  streetFaceFor,
} from './recipes.ts';

const VARIANTS = 8;
const GRID = 64;
/** Zones with recipes so far — later tasks append to this list. */
const ZONES: Zone[] = [Zone.Residential, Zone.Commercial, Zone.Retail, Zone.Industrial];

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
  it('pin the stage 4 budget: 16 parts per tile, five kinds', () => {
    expect(MAX_PARTS_PER_TILE).toBe(16);
    expect(MAX_PARTS_PER_KIND).toEqual({
      [PartKind.Box]: 12,
      [PartKind.GableRoof]: 3,
      [PartKind.HipRoof]: 2,
      [PartKind.Cylinder]: 3,
      [PartKind.ShedRoof]: 2,
    });
  });

  // One `it` per zone keeps each sweep well inside the CI per-test budget.
  it.each(ZONES)(
    'zone %i respects the per-tile and per-kind part budgets over the whole grid and every face',
    (zone) => {
      // Assertions are accumulated and checked once after the loops (rather
      // than inside the hot loop) to keep this test fast with ~400k part lists.
      const violations: string[] = [];
      const counts = PART_KINDS.map(() => 0);
      for (const density of [1, 2, 3]) {
        for (let variant = 0; variant < VARIANTS; variant++) {
          for (const face of STREET_FACES) {
            for (const index of FULL_GRID) {
              const parts = buildingParts(zone, density, variant, index, face);
              const tag = `${zone}/${density}/${variant}/${face}/${index}`;
              if (parts.length > MAX_PARTS_PER_TILE) {
                violations.push(`${tag}: ${parts.length} parts > ${MAX_PARTS_PER_TILE}`);
              }
              counts.fill(0);
              for (const p of parts) counts[p.kind]++;
              for (const kind of PART_KINDS) {
                if (counts[kind] > MAX_PARTS_PER_KIND[kind]) {
                  violations.push(
                    `${tag}: ${counts[kind]} parts of kind ${kind} > ${MAX_PARTS_PER_KIND[kind]}`,
                  );
                }
              }
            }
          }
        }
      }
      expect(violations).toEqual([]);
    },
  );

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
      const pv = parts.some((p) => !p.detail && p.color.getHex() === ACCENT.rooftopPv.getHex());
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
              !p.detail &&
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
          const wing = parts.find(
            (p) => p.kind === PartKind.Box && !p.main && !p.accent && !p.detail,
          );
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

  it('lies the rooftop PV slab flush on the gable roof slope (residential d2, retail d3)', () => {
    const violations: string[] = [];
    const cases: ReadonlyArray<{ zone: Zone; density: number }> = [
      { zone: Zone.Residential, density: 2 },
      { zone: Zone.Retail, density: 3 },
    ];
    for (const { zone, density } of cases) {
      for (const face of STREET_FACES) {
        for (let variant = 0; variant < VARIANTS; variant++) {
          for (const index of SAMPLE) {
            const parts = buildingParts(zone, density, variant, index, face);
            const tag = `${zone}/${density}/${variant}/${face}/${index}`;
            const pv = parts.find(
              (p) =>
                !p.detail && p.color.getHex() === ACCENT.rooftopPv.getHex() && p.tilt !== undefined,
            );
            if (!pv) {
              violations.push(`${tag}: no tilted rooftop PV part found`);
              continue;
            }
            const main = mainBody(parts)!;
            // The PV sits on the main (largest footprint) gable; a density-2
            // dormer adds a second, much smaller, gable it never sits on.
            const roofPart = parts
              .filter((p) => p.kind === PartKind.GableRoof)
              .reduce((a, b) => (a.sx * a.sz >= b.sx * b.sz ? a : b));
            const roofHeight = roofPart.sy;
            const roofDepth = roofPart.sz;
            const expectedTilt = Math.atan2(roofHeight, roofDepth / 2);
            if (Math.abs(pv.tilt! - expectedTilt) > 1e-9) {
              violations.push(`${tag}: tilt ${pv.tilt} != expected ${expectedTilt}`);
            }
            const eaveHeight = main.oy + main.sy; // top of the walls
            const [ex, ez] = faceOffset(0, 1, face); // unit vector toward the street
            const euler = new THREE.Euler(pv.tilt, pv.turn * (Math.PI / 2), 0, 'YXZ');
            for (const half of [pv.sz / 2, -pv.sz / 2]) {
              const corner = new THREE.Vector3(0, 0, half).applyEuler(euler);
              const worldX = pv.ox + corner.x;
              const worldY = pv.oy + corner.y;
              const worldZ = pv.oz + corner.z;
              const alongStreet = (worldX - main.ox) * ex + (worldZ - main.oz) * ez;
              const run = roofDepth / 2;
              const planeHeight = eaveHeight + roofHeight * (1 - alongStreet / run);
              if (Math.abs(worldY - planeHeight) > 0.02) {
                violations.push(
                  `${tag}: base corner y ${worldY} off roof plane ${planeHeight} ` +
                    `(alongStreet=${alongStreet})`,
                );
              }
            }
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
            !p.detail &&
            p.kind === PartKind.Box &&
            p.sy <= 0.05 &&
            (p.ox - main.ox) * ex + (p.oz - main.oz) * ez > faceDepth(main, face) / 2,
        );
        expect(awnings.length).toBe(density === 3 ? 2 : 1);
      }
    }
  });

  it('never lets a factory cylinder pass through a roof it stands beside', () => {
    // Footprints compared as squares (sx × sz). A cylinder standing on the
    // roof plane (a chimney: base at the roof's eave) rises through it by
    // design; anything based lower (silo, tank) must clear the roof or sit
    // at or above its top.
    const violations: string[] = [];
    const isRoof = (p: BuildingPart) =>
      p.kind === PartKind.GableRoof || p.kind === PartKind.HipRoof || p.kind === PartKind.ShedRoof;
    for (const { zone, density, variant, face, index, parts } of allRecipes(SAMPLE)) {
      if (zone !== Zone.Industrial) continue;
      const tag = `${zone}/${density}/${variant}/${face}/${index}`;
      for (const c of parts.filter((p) => p.kind === PartKind.Cylinder)) {
        for (const r of parts.filter(isRoof)) {
          // At or above the eave covers "at or above the roof's top" too.
          if (c.oy >= r.oy - 1e-9) continue;
          const [rx, rz] = r.turn % 2 === 0 ? [r.sx / 2, r.sz / 2] : [r.sz / 2, r.sx / 2];
          const overlapX = Math.abs(c.ox - r.ox) < c.sx / 2 + rx - 1e-9;
          const overlapZ = Math.abs(c.oz - r.oz) < c.sz / 2 + rz - 1e-9;
          if (overlapX && overlapZ) {
            violations.push(`${tag}: cylinder at (${c.ox}, ${c.oz}) passes through a roof`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('gives factories a saw-tooth roof: two gable parts side by side on the hall', () => {
    for (const { zone, parts } of allRecipes(SAMPLE)) {
      if (zone !== Zone.Industrial) continue;
      const gables = parts.filter((p) => p.kind === PartKind.GableRoof);
      expect(gables).toHaveLength(2);
      expect(gables[0].oy).toBeCloseTo(gables[1].oy, 9);
      expect(gables[0].ox).not.toBeCloseTo(gables[1].ox, 9);
    }
  });

  describe('shared details (stage 4)', () => {
    const EPS = 1e-9;
    const isPitched = (p: BuildingPart) =>
      p.kind === PartKind.GableRoof || p.kind === PartKind.HipRoof || p.kind === PartKind.ShedRoof;

    /** World-space xz bounds of a part (a quarter turn swaps its extents). */
    function bounds(p: BuildingPart): { minX: number; maxX: number; minZ: number; maxZ: number } {
      const [hx, hz] = p.turn % 2 === 0 ? [p.sx / 2, p.sz / 2] : [p.sz / 2, p.sx / 2];
      return { minX: p.ox - hx, maxX: p.ox + hx, minZ: p.oz - hz, maxZ: p.oz + hz };
    }

    /** The main gable: the largest gable sitting on top of the main body, if any. */
    function mainGable(parts: readonly BuildingPart[]): BuildingPart | undefined {
      const main = mainBody(parts)!;
      return parts
        .filter((p) => p.kind === PartKind.GableRoof && Math.abs(p.oy - (main.oy + main.sy)) < EPS)
        .reduce<BuildingPart | undefined>(
          (a, b) => (a && a.sx * a.sz >= b.sx * b.sz ? a : b),
          undefined,
        );
    }

    it('tags only plinths, ridge caps and gutters as detail parts', () => {
      // Batched like the footprint test above to stay fast.
      const violations: string[] = [];
      const allowed = new Set(['plinth', 'ridge', 'gutter']);
      for (const { parts, zone, density, variant, face, index } of allRecipes(SAMPLE)) {
        const tag = `${zone}/${density}/${variant}/${face}/${index}`;
        for (const p of parts) {
          if (isDetailPart(p) !== (p.detail !== undefined)) {
            violations.push(`${tag}: isDetailPart disagrees with the detail tag`);
          }
          if (p.detail === undefined) continue;
          if (!allowed.has(p.detail)) violations.push(`${tag}: unknown detail ${p.detail}`);
          if (p.main || p.role !== undefined) violations.push(`${tag}: detail is main or tagged`);
        }
      }
      expect(violations).toEqual([]);
    });

    it('put exactly one plinth below every main body', () => {
      const violations: string[] = [];
      for (const { parts, zone, density, variant, face, index } of allRecipes(SAMPLE)) {
        const tag = `${zone}/${density}/${variant}/${face}/${index}`;
        const main = mainBody(parts)!;
        const plinths = parts.filter((p) => p.detail === 'plinth');
        if (plinths.length !== 1) {
          violations.push(`${tag}: ${plinths.length} plinths, expected 1`);
          continue;
        }
        const [pl] = plinths;
        const ok =
          pl.kind === PartKind.Box &&
          pl.turn === 0 &&
          pl.tilt === undefined &&
          !pl.accent &&
          pl.oy === main.oy &&
          pl.sy === PLINTH_HEIGHT &&
          Math.abs(pl.sx - (main.sx + 2 * PLINTH_OVERHANG)) < EPS &&
          Math.abs(pl.sz - (main.sz + 2 * PLINTH_OVERHANG)) < EPS &&
          Math.abs(pl.ox - main.ox) < EPS &&
          Math.abs(pl.oz - main.oz) < EPS &&
          pl.color.getHex() === ZONE_FAMILIES[zone].plinth.getHex();
        if (!ok) violations.push(`${tag}: plinth ${JSON.stringify(pl)} does not hug the main body`);
      }
      expect(violations).toEqual([]);
    });

    it('put a ridge cap and two gutters on the main gable of residential d1-d2 and retail d2', () => {
      const violations: string[] = [];
      const cases: ReadonlyArray<{ zone: Zone; density: number }> = [
        { zone: Zone.Residential, density: 1 },
        { zone: Zone.Residential, density: 2 },
        { zone: Zone.Retail, density: 2 },
      ];
      let gabled = 0;
      let hipped = 0;
      for (const { zone, density } of cases) {
        for (const face of STREET_FACES) {
          for (let variant = 0; variant < VARIANTS; variant++) {
            for (const index of SAMPLE) {
              const parts = buildingParts(zone, density, variant, index, face);
              const tag = `${zone}/${density}/${variant}/${face}/${index}`;
              const gable = mainGable(parts);
              const ridges = parts.filter((p) => p.detail === 'ridge');
              const gutters = parts.filter((p) => p.detail === 'gutter');
              if (!gable) {
                // A hip roof: four eaves would cost four parts, so none.
                hipped++;
                if (ridges.length + gutters.length !== 0) {
                  violations.push(`${tag}: ridge/gutters without a main gable`);
                }
                continue;
              }
              gabled++;
              if (ridges.length !== 1 || gutters.length !== 2) {
                violations.push(`${tag}: ${ridges.length} ridges, ${gutters.length} gutters`);
                continue;
              }
              const [ridge] = ridges;
              const ridgeColor = gable.color.clone().multiplyScalar(RIDGE_DARKEN);
              if (
                ridge.kind !== PartKind.Box ||
                Math.abs(ridge.sx - gable.sx) > 1e-6 ||
                ridge.sz !== RIDGE_CAP.w ||
                ridge.sy !== RIDGE_CAP.h ||
                ridge.turn !== gable.turn ||
                Math.abs(ridge.ox - gable.ox) > EPS ||
                Math.abs(ridge.oz - gable.oz) > EPS ||
                Math.abs(ridge.oy + ridge.sy / 2 - (gable.oy + gable.sy)) > EPS ||
                ridge.accent ||
                ridge.color.getHex() !== ridgeColor.getHex()
              ) {
                violations.push(`${tag}: ridge cap off the ridge`);
              }
              // Gutters run along both eaves: the gable's local ±z edges.
              const [ex, ez] = faceOffset(0, 1, gable.turn as StreetFace);
              const offsets = gutters
                .map((g) => (g.ox - gable.ox) * ex + (g.oz - gable.oz) * ez)
                .sort((a, b) => a - b);
              const eave = gable.sz / 2 - GUTTER.w / 2;
              if (Math.abs(offsets[0] + eave) > EPS || Math.abs(offsets[1] - eave) > EPS) {
                violations.push(`${tag}: gutters at ${offsets.join(', ')}, expected ±${eave}`);
              }
              for (const g of gutters) {
                const sideways = (g.ox - gable.ox) * ez - (g.oz - gable.oz) * ex;
                if (
                  g.kind !== PartKind.Box ||
                  Math.abs(g.sx - gable.sx) > 1e-6 ||
                  g.sz !== GUTTER.w ||
                  g.sy !== GUTTER.h ||
                  g.turn !== gable.turn ||
                  Math.abs(sideways) > EPS ||
                  Math.abs(g.oy + g.sy - gable.oy) > EPS ||
                  !g.accent ||
                  g.color.getHex() !== ACCENT.gutter.getHex()
                ) {
                  violations.push(`${tag}: gutter off the eave`);
                }
              }
            }
          }
        }
      }
      expect(violations).toEqual([]);
      expect(gabled).toBeGreaterThan(0);
      expect(hipped).toBeGreaterThan(0);
    });

    it('put no ridge caps or gutters on any other recipe', () => {
      for (const { zone, density, parts } of allRecipes(SAMPLE)) {
        const expected =
          (zone === Zone.Residential && density <= 2) || (zone === Zone.Retail && density === 2);
        if (!expected) {
          expect(parts.filter((p) => p.detail === 'ridge' || p.detail === 'gutter')).toEqual([]);
        }
      }
    });

    it('let pitched roofs overhang their supporting body by ROOF_OVERHANG on each side', () => {
      // The market hall keeps its own MARKET_HALL_ROOF_MARGIN. Several roofs
      // on one body (saw-tooth halves) are checked as their union; a roof edge
      // that ends over the body (the retail d2 back-half roof) has no eave there.
      const violations: string[] = [];
      let checked = 0;
      for (const { parts, zone, density, variant, face, index } of allRecipes(SAMPLE)) {
        if (zone === Zone.Retail && density === 3) continue;
        const tag = `${zone}/${density}/${variant}/${face}/${index}`;
        const groups = new Map<BuildingPart, BuildingPart[]>();
        for (const roof of parts.filter(isPitched)) {
          const support = parts.find((b) => {
            if (b.kind !== PartKind.Box || b.detail || Math.abs(b.oy + b.sy - roof.oy) > EPS) {
              return false;
            }
            const bb = bounds(b);
            return roof.ox > bb.minX && roof.ox < bb.maxX && roof.oz > bb.minZ && roof.oz < bb.maxZ;
          });
          if (!support) {
            violations.push(`${tag}: roof without a supporting body`);
            continue;
          }
          groups.set(support, [...(groups.get(support) ?? []), roof]);
        }
        for (const [body, roofs] of groups) {
          const b = bounds(body);
          const r = roofs.map(bounds).reduce((a, c) => ({
            minX: Math.min(a.minX, c.minX),
            maxX: Math.max(a.maxX, c.maxX),
            minZ: Math.min(a.minZ, c.minZ),
            maxZ: Math.max(a.maxZ, c.maxZ),
          }));
          const overhangs = [b.minX - r.minX, r.maxX - b.maxX, b.minZ - r.minZ, r.maxZ - b.maxZ];
          const eaves = overhangs.filter((o) => o > -EPS);
          if (eaves.length < 3) violations.push(`${tag}: only ${eaves.length} overhanging sides`);
          for (const o of eaves) {
            if (Math.abs(o - ROOF_OVERHANG) > EPS) {
              violations.push(`${tag}: overhang ${o} != ${ROOF_OVERHANG}`);
            }
          }
          checked++;
        }
      }
      expect(violations).toEqual([]);
      expect(checked).toBeGreaterThan(0);
    });
  });

  describe('part roles (stage 2 accents)', () => {
    function roles(parts: readonly BuildingPart[], role: PartRole): BuildingPart[] {
      return parts.filter((p) => p.role === role);
    }

    it('tags exactly one chimney on every detached house', () => {
      for (const index of SAMPLE) {
        for (let variant = 0; variant < VARIANTS; variant++) {
          for (const face of STREET_FACES) {
            const parts = buildingParts(Zone.Residential, 1, variant, index, face);
            const chimneys = roles(parts, PartRole.Chimney);
            expect(chimneys).toHaveLength(1);
            expect(chimneys[0].color.getHex()).toBe(ACCENT.chimney.getHex());
          }
        }
      }
    });

    it('tags exactly one chimney on every factory', () => {
      for (const { zone, parts } of allRecipes(SAMPLE)) {
        if (zone !== Zone.Industrial) continue;
        expect(parts.filter((p) => p.role === PartRole.Chimney)).toHaveLength(1);
      }
    });

    it('tags one antenna on the office block and the tower', () => {
      for (const index of SAMPLE) {
        for (let variant = 0; variant < VARIANTS; variant++) {
          for (const density of [2, 3]) {
            const parts = buildingParts(Zone.Commercial, density, variant, index, StreetFace.South);
            const antennas = roles(parts, PartRole.Antenna);
            expect(antennas).toHaveLength(1);
            expect(antennas[0].kind).toBe(PartKind.Cylinder);
          }
        }
      }
    });

    it('tags two vents on the market hall', () => {
      for (const index of SAMPLE) {
        for (let variant = 0; variant < VARIANTS; variant++) {
          for (const face of STREET_FACES) {
            const parts = buildingParts(Zone.Retail, 3, variant, index, face);
            expect(roles(parts, PartRole.Vent)).toHaveLength(2);
          }
        }
      }
    });

    it('never tags more puff-emitting (chimney or vent) parts than BuildingFxMesh has room for', () => {
      for (const { parts } of allRecipes(SAMPLE)) {
        const puffAnchors = parts.filter(
          (p) => p.role === PartRole.Chimney || p.role === PartRole.Vent,
        );
        expect(puffAnchors.length).toBeLessThanOrEqual(MAX_PUFF_ANCHORS_PER_TILE);
      }
    });

    it('tags nothing on any other recipe and never rotates a tagged part', () => {
      for (const { zone, density, parts } of allRecipes(SAMPLE)) {
        const tagged = parts.filter((p) => p.role !== undefined);
        const expected =
          (zone === Zone.Residential && density === 1) ||
          (zone === Zone.Commercial && density >= 2) ||
          (zone === Zone.Retail && density === 3) ||
          zone === Zone.Industrial;
        if (!expected) expect(tagged).toHaveLength(0);
        for (const p of tagged) {
          expect(p.turn).toBe(0);
          expect(p.tilt).toBeUndefined();
        }
      }
    });
  });
});
