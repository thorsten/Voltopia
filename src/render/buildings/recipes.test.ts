import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Zone } from '../../shared/types.ts';
import { PART_KINDS, PartKind } from './primitives.ts';
import { ACCENT, ZONE_FAMILIES } from './palette.ts';
import { MAX_PUFF_ANCHORS_PER_TILE } from './accents.ts';
import {
  BAY_DEPTH,
  type BuildingPart,
  DOOR,
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
  SETBACK,
  STREET_FACES,
  StreetFace,
  buildingHeight,
  buildingParts,
  createPicker,
  faceDepth,
  faceOffset,
  faceWidth,
  isDetailPart,
  mainBody,
  silhouetteOf,
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

interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** World-space xz bounds of a part (a quarter turn swaps its extents). */
function bounds(p: BuildingPart): Rect {
  const [hx, hz] = p.turn % 2 === 0 ? [p.sx / 2, p.sz / 2] : [p.sz / 2, p.sx / 2];
  return { minX: p.ox - hx, maxX: p.ox + hx, minZ: p.oz - hz, maxZ: p.oz + hz };
}

/** A world offset seen in the south-facing frame of `face` (+z toward the street). */
function toFace(dx: number, dz: number, face: StreetFace): [number, number] {
  return faceOffset(dx, dz, ((4 - face) % 4) as StreetFace);
}

/** Bounds of a part in the street-facing frame of `face`, relative to the tile centre. */
function faceBounds(p: BuildingPart, face: StreetFace): Rect {
  const b = bounds(p);
  const [x0, z0] = toFace(b.minX, b.minZ, face);
  const [x1, z1] = toFace(b.maxX, b.maxZ, face);
  return {
    minX: Math.min(x0, x1),
    maxX: Math.max(x0, x1),
    minZ: Math.min(z0, z1),
    maxZ: Math.max(z0, z1),
  };
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

  it('give every residential house a door on the street face of its main body', () => {
    const violations: string[] = [];
    for (const { parts, zone, density, variant, face, index } of allRecipes(SAMPLE)) {
      if (zone !== Zone.Residential || density === 3) continue;
      const tag = `${density}/${variant}/${face}/${index}`;
      const main = mainBody(parts)!;
      // The first door is the main body's: buildingsMesh.ts nudges windows around it.
      const door = parts.find((p) => p.color.getHex() === ACCENT.door.getHex());
      if (!door) {
        violations.push(`${tag}: no door`);
        continue;
      }
      // Outside the body on the street side, within the main facade, turned to the face.
      const [lx, lz] = toFace(door.ox - main.ox, door.oz - main.oz, face);
      if (!(lz > faceDepth(main, face) / 2)) violations.push(`${tag}: door not on the street face`);
      if (Math.abs(lx) + DOOR.width / 2 > faceWidth(main, face) / 2 + 1e-9) {
        violations.push(`${tag}: door off the main facade (lx ${lx})`);
      }
      if (door.turn !== face) violations.push(`${tag}: door turn ${door.turn} != ${face}`);
      // The detached house keeps its door centred on the facade.
      if (silhouetteOf(zone, density, variant, index) === 'detached' && Math.abs(lx) > 1e-9) {
        violations.push(`${tag}: detached door off centre`);
      }
    }
    expect(violations).toEqual([]);
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

  it("keeps the detached house's side wing off the door side on east/west faces", () => {
    const violations: string[] = [];
    for (const face of [StreetFace.East, StreetFace.West] as const) {
      for (let variant = 0; variant < VARIANTS; variant++) {
        for (const index of SAMPLE) {
          if (silhouetteOf(Zone.Residential, 1, variant, index) !== 'detached') continue;
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

  it('lies the rooftop PV slab flush on the pitched roof slope (residential d2, retail d3)', () => {
    const violations: string[] = [];
    const cases: ReadonlyArray<{ zone: Zone; density: number }> = [
      { zone: Zone.Residential, density: 2 },
      { zone: Zone.Retail, density: 3 },
    ];
    // The supermarket keeps its PV flat on its flat roof.
    const sloped = new Set(['townHouse', 'bayWindow', 'cornerHouse', 'marketHall']);
    for (const { zone, density } of cases) {
      for (const face of STREET_FACES) {
        for (let variant = 0; variant < VARIANTS; variant++) {
          for (const index of SAMPLE) {
            if (!sloped.has(silhouetteOf(zone, density, variant, index))) continue;
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
            // The PV sits on the main (largest footprint) gable or hip roof
            // (whose front face shares the gable's plane); a density-2 dormer
            // adds a second, much smaller, gable it never sits on.
            const roofPart = parts
              .filter((p) => p.kind === PartKind.GableRoof || p.kind === PartKind.HipRoof)
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

  it('shade every shop on the street face: awnings, or a canopy on the canopy shop', () => {
    const awningsPer: Record<string, number> = {
      shop: 1,
      canopyShop: 0,
      wideShop: 1,
      shopWithFlat: 1,
      marketHall: 2,
      supermarket: 1,
    };
    const violations: string[] = [];
    for (const { parts, zone, density, variant, face, index } of allRecipes(SAMPLE)) {
      if (zone !== Zone.Retail) continue;
      const tag = `${density}/${variant}/${face}/${index}`;
      const silhouette = silhouetteOf(zone, density, variant, index);
      const main = mainBody(parts)!;
      const front = faceBounds(main, face).maxZ;
      const beyondFacade = (p: BuildingPart) => {
        const [, lz] = toFace(p.ox, p.oz, face);
        return lz > front;
      };
      // Thin accent slabs whose centre lies beyond the facade: awnings and
      // flat canopies (signs are taller, PV sits on the roof inside it).
      const awnings = parts.filter(
        (p) => p.accent && !p.detail && p.kind === PartKind.Box && p.sy <= 0.05 && beyondFacade(p),
      );
      if (awnings.length !== awningsPer[silhouette]) {
        violations.push(`${tag} ${silhouette}: ${awnings.length} awnings`);
      }
      const canopies = parts.filter((p) => p.kind === PartKind.ShedRoof && beyondFacade(p));
      if (canopies.length !== (silhouette === 'canopyShop' ? 1 : 0)) {
        violations.push(`${tag} ${silhouette}: ${canopies.length} shed canopies`);
      }
    }
    expect(violations).toEqual([]);
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

    /**
     * The main gable: the largest gable on top of the main body or of a
     * storey stacked on it (the flat above a shop), if any. A detached
     * house's wing gable sits lower; the L-house wing and a dormer are smaller.
     */
    function mainGable(parts: readonly BuildingPart[]): BuildingPart | undefined {
      const main = mainBody(parts)!;
      const mainTop = main.oy + main.sy;
      const tops = [
        mainTop,
        ...parts
          .filter((p) => p.kind === PartKind.Box && !p.detail && Math.abs(p.oy - mainTop) < EPS)
          .map((p) => p.oy + p.sy),
      ];
      return parts
        .filter((p) => p.kind === PartKind.GableRoof && tops.some((t) => Math.abs(p.oy - t) < EPS))
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

    it('put exactly one plinth below every main body and plinths only below bodies', () => {
      const violations: string[] = [];
      for (const { parts, zone, density, variant, face, index } of allRecipes(SAMPLE)) {
        const tag = `${zone}/${density}/${variant}/${face}/${index}`;
        const main = mainBody(parts)!;
        // Unturned bodies only: a plinth is always an unturned Box.
        const hugs = (pl: BuildingPart, body: BuildingPart) =>
          body.turn === 0 &&
          pl.kind === PartKind.Box &&
          pl.turn === 0 &&
          pl.tilt === undefined &&
          !pl.accent &&
          pl.oy === body.oy &&
          pl.sy === PLINTH_HEIGHT &&
          Math.abs(pl.sx - (body.sx + 2 * PLINTH_OVERHANG)) < EPS &&
          Math.abs(pl.sz - (body.sz + 2 * PLINTH_OVERHANG)) < EPS &&
          Math.abs(pl.ox - body.ox) < EPS &&
          Math.abs(pl.oz - body.oz) < EPS &&
          pl.color.getHex() === ZONE_FAMILIES[zone].plinth.getHex();
        const plinths = parts.filter((p) => p.detail === 'plinth');
        if (plinths.filter((pl) => hugs(pl, main)).length !== 1) {
          violations.push(`${tag}: no single plinth hugs the main body`);
        }
        // Further plinths (the L-house wing, the other semi-detached half)
        // each hug a ground-standing body of their own.
        const bodies = parts.filter((p) => p.kind === PartKind.Box && !p.detail && !p.accent);
        for (const pl of plinths) {
          if (!bodies.some((b) => b.oy === 0 && hugs(pl, b))) {
            violations.push(`${tag}: plinth ${JSON.stringify(pl)} hugs no body`);
          }
        }
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
        // The canopy shop's canopy hangs on the facade, not on a body top.
        const canopyShop = silhouetteOf(zone, density, variant, index) === 'canopyShop';
        // A roof is supported by every body whose top it sits on and whose
        // footprint holds its centre — two when it spans a semi-detached pair.
        const groups = new Map<string, { support: Rect; roofs: BuildingPart[] }>();
        for (const roof of parts.filter(isPitched)) {
          if (canopyShop && roof.kind === PartKind.ShedRoof) continue;
          const supports = parts.filter((b) => {
            if (b.kind !== PartKind.Box || b.detail || Math.abs(b.oy + b.sy - roof.oy) > EPS) {
              return false;
            }
            const bb = bounds(b);
            return (
              roof.ox > bb.minX - EPS &&
              roof.ox < bb.maxX + EPS &&
              roof.oz > bb.minZ - EPS &&
              roof.oz < bb.maxZ + EPS
            );
          });
          if (supports.length === 0) {
            violations.push(`${tag}: roof without a supporting body`);
            continue;
          }
          const key = supports.map((b) => parts.indexOf(b)).join(',');
          const support = supports.map(bounds).reduce((a, c) => ({
            minX: Math.min(a.minX, c.minX),
            maxX: Math.max(a.maxX, c.maxX),
            minZ: Math.min(a.minZ, c.minZ),
            maxZ: Math.max(a.maxZ, c.maxZ),
          }));
          const group = groups.get(key) ?? { support, roofs: [] };
          group.roofs.push(roof);
          groups.set(key, group);
        }
        for (const { support: b, roofs } of groups.values()) {
          const r = roofs.map(bounds).reduce((a, c) => ({
            minX: Math.min(a.minX, c.minX),
            maxX: Math.max(a.maxX, c.maxX),
            minZ: Math.min(a.minZ, c.minZ),
            maxZ: Math.max(a.maxZ, c.maxZ),
          }));
          const overhangs = [b.minX - r.minX, r.maxX - b.maxX, b.minZ - r.minZ, r.maxZ - b.maxZ];
          // A roof end that reaches over another body of the same eave height
          // runs into that body's roof (the L-house wing ridge meeting the
          // main back slope): a valley, not an eave.
          const edges = [
            { x: r.minX, z: (r.minZ + r.maxZ) / 2 },
            { x: r.maxX, z: (r.minZ + r.maxZ) / 2 },
            { x: (r.minX + r.maxX) / 2, z: r.minZ },
            { x: (r.minX + r.maxX) / 2, z: r.maxZ },
          ];
          const intoOtherRoof = edges.map(({ x, z }) =>
            parts.some((o) => {
              if (
                o.kind !== PartKind.Box ||
                o.detail ||
                Math.abs(o.oy + o.sy - roofs[0].oy) > EPS
              ) {
                return false;
              }
              const ob = bounds(o);
              const inside =
                x > ob.minX + EPS && x < ob.maxX - EPS && z > ob.minZ + EPS && z < ob.maxZ - EPS;
              const outsideSupport =
                x < b.minX - EPS || x > b.maxX + EPS || z < b.minZ - EPS || z > b.maxZ + EPS;
              return inside && outsideSupport;
            }),
          );
          const eaves = overhangs.filter((o, i) => o > -EPS && !intoOtherRoof[i]);
          if (eaves.length + intoOtherRoof.filter(Boolean).length < 3)
            violations.push(`${tag}: only ${eaves.length} overhanging sides`);
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

    it('tags exactly one chimney on every density-1 house (one per semi-detached pair)', () => {
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

    it('tags two vents on the market hall and the supermarket', () => {
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

describe('silhouettes (stage 4)', () => {
  const EPS = 1e-6;
  const SILHOUETTES: Array<{ zone: Zone; density: number; names: string[] }> = [
    { zone: Zone.Residential, density: 1, names: ['detached', 'lHouse', 'semiDetached'] },
    { zone: Zone.Residential, density: 2, names: ['townHouse', 'bayWindow', 'cornerHouse'] },
    { zone: Zone.Residential, density: 3, names: ['apartment', 'steppedBlock'] },
    { zone: Zone.Retail, density: 1, names: ['shop', 'canopyShop'] },
    { zone: Zone.Retail, density: 2, names: ['wideShop', 'shopWithFlat'] },
    { zone: Zone.Retail, density: 3, names: ['marketHall', 'supermarket'] },
  ];

  /** Every recipe of one silhouette over the variant × sample set and all faces. */
  function* recipesOf(
    zone: Zone,
    density: number,
    name: string,
  ): Generator<{ tag: string; face: StreetFace; index: number; parts: BuildingPart[] }> {
    for (let variant = 0; variant < VARIANTS; variant++) {
      for (const index of SAMPLE) {
        if (silhouetteOf(zone, density, variant, index) !== name) continue;
        for (const face of STREET_FACES) {
          yield {
            tag: `${variant}/${face}/${index}`,
            face,
            index,
            parts: buildingParts(zone, density, variant, index, face),
          };
        }
      }
    }
  }

  const isBody = (p: BuildingPart) => p.kind === PartKind.Box && !p.main && !p.accent && !p.detail;
  const top = (p: BuildingPart) => p.oy + p.sy;

  it.each(SILHOUETTES)(
    'zone $zone density $density draws every silhouette, the existing one most often',
    ({ zone, density, names }) => {
      const counts = new Map<string, number>();
      for (let variant = 0; variant < VARIANTS; variant++) {
        for (const index of SAMPLE) {
          const name = silhouetteOf(zone, density, variant, index);
          counts.set(name, (counts.get(name) ?? 0) + 1);
        }
      }
      expect([...counts.keys()].sort()).toEqual([...names].sort());
      const total = VARIANTS * SAMPLE.length;
      // The existing silhouette is the tuned default: at least a third of the street.
      expect(counts.get(names[0])!).toBeGreaterThanOrEqual(total / 3);
    },
  );

  it('replays the recipe draws: the silhouette never depends on the street face', () => {
    // A silhouette-specific part count per face would differ if a face-
    // dependent draw slipped in before the silhouette pick.
    for (const { zone, density } of SILHOUETTES) {
      for (const index of SAMPLE.slice(0, 16)) {
        const kinds = STREET_FACES.map((face) =>
          buildingParts(zone, density, 3, index, face)
            .map((p) => p.kind)
            .join(),
        );
        for (const k of kinds) expect(k).toBe(kinds[0]);
      }
    }
    expect(silhouetteOf(Zone.Commercial, 3, 0, 0)).toBe('tower');
    expect(silhouetteOf(Zone.Industrial, 1, 0, 0)).toBe('workshop');
  });

  it('builds the L-house from a body and a perpendicular wing behind or beside it', () => {
    const violations: string[] = [];
    let seen = 0;
    for (const { tag, face, parts } of recipesOf(Zone.Residential, 1, 'lHouse')) {
      seen++;
      const main = mainBody(parts)!;
      const gables = parts.filter((p) => p.kind === PartKind.GableRoof);
      const wings = parts.filter(isBody);
      if (gables.length !== 2 || wings.length !== 1) {
        violations.push(`${tag}: ${gables.length} gables, ${wings.length} wings`);
        continue;
      }
      if ((gables[0].turn - gables[1].turn + 4) % 2 !== 1) {
        violations.push(`${tag}: gables not at right angles`);
      }
      const m = faceBounds(main, face);
      const w = faceBounds(wings[0], face);
      // A shared edge with a positive overlap along it — never the street edge.
      const alongX = Math.min(m.maxX, w.maxX) - Math.max(m.minX, w.minX);
      const alongZ = Math.min(m.maxZ, w.maxZ) - Math.max(m.minZ, w.minZ);
      const back = Math.abs(w.maxZ - m.minZ) < EPS && alongX > EPS;
      const side =
        (Math.abs(w.minX - m.maxX) < EPS || Math.abs(w.maxX - m.minX) < EPS) && alongZ > EPS;
      if (!back && !side) violations.push(`${tag}: wing does not touch the body`);
      if (w.maxZ > m.maxZ + EPS) violations.push(`${tag}: wing reaches the door side`);
      // Each gable sits on its own body.
      const onWing = gables.filter((g) => Math.abs(g.oy - top(wings[0])) < EPS);
      if (onWing.length === 0) violations.push(`${tag}: no gable on the wing`);
    }
    expect(violations).toEqual([]);
    expect(seen).toBeGreaterThan(0);
  });

  it("runs the L-house wing ridge into the main roof's back slope (no exposed gable end)", () => {
    const violations: string[] = [];
    let seen = 0;
    for (const { tag, face, parts } of recipesOf(Zone.Residential, 1, 'lHouse')) {
      seen++;
      const gables = parts.filter((p) => p.kind === PartKind.GableRoof);
      const main = gables.find((g) => g.turn === face)!;
      const wing = gables.find((g) => g.turn !== face)!;
      const m = faceBounds(main, face);
      const w = faceBounds(wing, face);
      // The wing ridge runs toward the street (+z in the face frame); its
      // front end must lie on the main gable's back slope, inside its span.
      const ridgeX = (w.minX + w.maxX) / 2;
      const ridgeZ = w.maxZ;
      const ridgeY = wing.oy + wing.sy;
      const halfDepth = (m.maxZ - m.minZ) / 2;
      const centreZ = (m.minZ + m.maxZ) / 2;
      if (ridgeZ > centreZ || ridgeZ < m.minZ || ridgeX < m.minX || ridgeX > m.maxX) {
        violations.push(`${tag}: wing ridge ends off the main back slope`);
        continue;
      }
      const surfaceY = main.oy + main.sy * (1 - Math.abs(ridgeZ - centreZ) / halfDepth);
      if (Math.abs(ridgeY - surfaceY) > EPS) {
        violations.push(`${tag}: wing ridge ${ridgeY} vs main slope ${surfaceY}`);
      }
      // Equal pitch: rise over run matches, so the valleys are straight.
      const mainPitch = main.sy / halfDepth;
      const wingPitch = wing.sy / ((w.maxX - w.minX) / 2);
      if (Math.abs(mainPitch - wingPitch) > EPS) violations.push(`${tag}: pitches differ`);
    }
    expect(violations).toEqual([]);
    expect(seen).toBeGreaterThan(0);
  });

  it('mirrors the semi-detached pair about the tile centre under one ridge', () => {
    const violations: string[] = [];
    let seen = 0;
    for (const { tag, face, parts } of recipesOf(Zone.Residential, 1, 'semiDetached')) {
      seen++;
      const main = mainBody(parts)!;
      const others = parts.filter(isBody);
      const gables = parts.filter((p) => p.kind === PartKind.GableRoof);
      if (others.length !== 1 || gables.length !== 1) {
        violations.push(`${tag}: ${others.length} other halves, ${gables.length} gables`);
        continue;
      }
      const [other] = others;
      const m = faceBounds(main, face);
      const o = faceBounds(other, face);
      const mx = (m.minX + m.maxX) / 2;
      const ox = (o.minX + o.maxX) / 2;
      if (!(mx < 0)) violations.push(`${tag}: main is not the left half`);
      if (Math.abs(mx + ox) > EPS) violations.push(`${tag}: halves not mirrored (${mx}, ${ox})`);
      if (
        Math.abs(m.maxX - m.minX - (o.maxX - o.minX)) > EPS ||
        Math.abs(m.maxZ - m.minZ - (o.maxZ - o.minZ)) > EPS ||
        Math.abs(m.minZ - o.minZ) > EPS ||
        Math.abs(main.sy - other.sy) > EPS
      ) {
        violations.push(`${tag}: halves differ in size or depth`);
      }
      // One ridge along the facade over both halves.
      const g = faceBounds(gables[0], face);
      if (g.minX > m.minX || g.maxX < o.maxX) violations.push(`${tag}: gable misses a half`);
      if (gables[0].turn % 2 !== face % 2) violations.push(`${tag}: ridge not along the facade`);
    }
    expect(violations).toEqual([]);
    expect(seen).toBeGreaterThan(0);
  });

  it('puts the bay window on the street face, BAY_DEPTH proud, under a shed roof below the eaves', () => {
    const violations: string[] = [];
    let seen = 0;
    for (const { tag, face, parts } of recipesOf(Zone.Residential, 2, 'bayWindow')) {
      seen++;
      const main = mainBody(parts)!;
      const sheds = parts.filter((p) => p.kind === PartKind.ShedRoof);
      if (sheds.length !== 1) {
        violations.push(`${tag}: ${sheds.length} shed roofs`);
        continue;
      }
      const [shed] = sheds;
      const bay = parts.find(
        (p) => isBody(p) && Math.abs(top(p) - shed.oy) < EPS && Math.abs(p.oy - main.oy) < EPS,
      );
      if (!bay) {
        violations.push(`${tag}: no bay box under the shed roof`);
        continue;
      }
      const m = faceBounds(main, face);
      const b = faceBounds(bay, face);
      if (Math.abs(b.minZ - m.maxZ) > EPS || Math.abs(b.maxZ - m.maxZ - BAY_DEPTH) > EPS) {
        violations.push(`${tag}: bay not BAY_DEPTH proud of the facade`);
      }
      if (b.minX < m.minX - EPS || b.maxX > m.maxX + EPS) violations.push(`${tag}: bay off facade`);
      if (top(shed) > top(main) + EPS) violations.push(`${tag}: bay roof above the eaves`);
      const door = parts.find((p) => p.color.getHex() === ACCENT.door.getHex())!;
      const d = faceBounds(door, face);
      if (d.maxX > b.minX + EPS && d.minX < b.maxX - EPS) {
        violations.push(`${tag}: door behind the bay`);
      }
    }
    expect(violations).toEqual([]);
    expect(seen).toBeGreaterThan(0);
  });

  it('gives the corner house a hip roof and its door at a corner of the street face', () => {
    const violations: string[] = [];
    let seen = 0;
    for (const { tag, face, parts } of recipesOf(Zone.Residential, 2, 'cornerHouse')) {
      seen++;
      const main = mainBody(parts)!;
      const hips = parts.filter((p) => p.kind === PartKind.HipRoof);
      if (hips.length !== 1 || parts.some((p) => p.kind === PartKind.GableRoof)) {
        violations.push(`${tag}: not a single hip roof`);
        continue;
      }
      if (
        Math.abs(hips[0].oy - top(main)) > EPS ||
        Math.abs(hips[0].ox - main.ox) > EPS ||
        Math.abs(hips[0].oz - main.oz) > EPS
      ) {
        violations.push(`${tag}: hip roof off the main body`);
      }
      const door = parts.find((p) => p.color.getHex() === ACCENT.door.getHex())!;
      const [lx] = toFace(door.ox - main.ox, door.oz - main.oz, face);
      if (Math.abs(lx) < 0.3 * faceWidth(main, face) - 1e-9) {
        violations.push(`${tag}: door at ${lx}, not near a corner`);
      }
    }
    expect(violations).toEqual([]);
    expect(seen).toBeGreaterThan(0);
  });

  it('sets the stepped block top storey back by SETBACK behind a terrace railing', () => {
    const violations: string[] = [];
    let seen = 0;
    for (const { tag, face, parts } of recipesOf(Zone.Residential, 3, 'steppedBlock')) {
      seen++;
      const main = mainBody(parts)!;
      const m = faceBounds(main, face);
      const upper = parts.find((p) => isBody(p) && Math.abs(p.oy - top(main)) < EPS && p.sy > 0.1);
      if (!upper) {
        violations.push(`${tag}: no top storey`);
        continue;
      }
      const u = faceBounds(upper, face);
      if (
        Math.abs(u.minX - m.minX) > EPS ||
        Math.abs(u.maxX - m.maxX) > EPS ||
        Math.abs(u.minZ - m.minZ) > EPS ||
        Math.abs(u.maxZ - (m.maxZ - SETBACK)) > EPS
      ) {
        violations.push(`${tag}: top storey not set back by SETBACK on the street side`);
      }
      const railings = parts.filter((p) => {
        if (!p.accent || p.kind !== PartKind.Box || p.detail) return false;
        const r = faceBounds(p, face);
        return (
          r.maxZ - r.minZ <= 0.02 + EPS &&
          p.oy >= top(main) - EPS &&
          p.oy <= top(main) + 0.05 &&
          r.minZ >= u.maxZ - EPS &&
          r.maxZ <= m.maxZ + EPS &&
          r.maxX - r.minX >= 0.8 * (m.maxX - m.minX)
        );
      });
      if (railings.length !== 1) violations.push(`${tag}: ${railings.length} terrace railings`);
    }
    expect(violations).toEqual([]);
    expect(seen).toBeGreaterThan(0);
  });

  it('hangs the canopy shop canopy in front of the shop, above the door height', () => {
    const violations: string[] = [];
    let seen = 0;
    for (const { tag, face, parts } of recipesOf(Zone.Retail, 1, 'canopyShop')) {
      seen++;
      const main = mainBody(parts)!;
      const sheds = parts.filter((p) => p.kind === PartKind.ShedRoof);
      if (sheds.length !== 1) {
        violations.push(`${tag}: ${sheds.length} canopies`);
        continue;
      }
      const [canopy] = sheds;
      const c = faceBounds(canopy, face);
      const m = faceBounds(main, face);
      if (c.minZ < m.maxZ - EPS) violations.push(`${tag}: canopy not in front of the shop`);
      if (canopy.oy < DOOR.height - EPS) violations.push(`${tag}: canopy edge below the door`);
      if (top(canopy) > top(main) + EPS) violations.push(`${tag}: canopy above the shop`);
      // The high edge (local -z) meets the wall: the canopy turns with the face.
      if (canopy.turn !== face) violations.push(`${tag}: canopy turn ${canopy.turn}`);
    }
    expect(violations).toEqual([]);
    expect(seen).toBeGreaterThan(0);
  });

  it('puts a residential-tone flat with a gable on the shop body, windows on the shop', () => {
    const violations: string[] = [];
    const tones = new Set(ZONE_FAMILIES[Zone.Residential].walls.map((c) => c.getHex()));
    let seen = 0;
    for (const { tag, face, parts } of recipesOf(Zone.Retail, 2, 'shopWithFlat')) {
      seen++;
      const main = mainBody(parts)!;
      const flats = parts.filter((p) => isBody(p) && Math.abs(p.oy - top(main)) < EPS);
      const gables = parts.filter((p) => p.kind === PartKind.GableRoof);
      if (flats.length !== 1 || gables.length !== 1) {
        violations.push(`${tag}: ${flats.length} flats, ${gables.length} gables`);
        continue;
      }
      const [flat] = flats;
      if (!tones.has(flat.color.getHex())) violations.push(`${tag}: flat not residential-toned`);
      if (main.oy !== 0) violations.push(`${tag}: the shop (main) is not the ground floor`);
      const f = faceBounds(flat, face);
      const m = faceBounds(main, face);
      if (f.minX < m.minX - EPS || f.maxX > m.maxX + EPS || f.minZ < m.minZ - EPS) {
        violations.push(`${tag}: flat overhangs the shop`);
      }
      if (Math.abs(gables[0].oy - top(flat)) > EPS) violations.push(`${tag}: gable off the flat`);
    }
    expect(violations).toEqual([]);
    expect(seen).toBeGreaterThan(0);
  });

  it('builds the supermarket low and wide with a glass entrance under a flat canopy', () => {
    const violations: string[] = [];
    let hallTop = Infinity;
    for (const { parts } of recipesOf(Zone.Retail, 3, 'marketHall')) {
      hallTop = Math.min(hallTop, Math.max(...parts.map(top)));
    }
    let seen = 0;
    for (const { tag, face, parts } of recipesOf(Zone.Retail, 3, 'supermarket')) {
      seen++;
      const main = mainBody(parts)!;
      const m = faceBounds(main, face);
      if (m.maxX - m.minX < 0.8 - EPS || m.maxZ - m.minZ < 0.7 - EPS) {
        violations.push(`${tag}: footprint ${m.maxX - m.minX} × ${m.maxZ - m.minZ}`);
      }
      if (Math.max(...parts.map(top)) > hallTop) violations.push(`${tag}: taller than a hall`);
      const entrances = parts.filter(
        (p) => p.kind === PartKind.Box && p.color.getHex() === ACCENT.glass.getHex(),
      );
      if (entrances.length !== 1) {
        violations.push(`${tag}: ${entrances.length} glass entrances`);
        continue;
      }
      const e = faceBounds(entrances[0], face);
      if (Math.abs(e.minZ - m.maxZ) > EPS || entrances[0].oy !== 0) {
        violations.push(`${tag}: entrance not on the street face`);
      }
      const canopies = parts.filter((p) => {
        if (!p.accent || p.kind !== PartKind.Box || p.sy > 0.05) return false;
        const c = faceBounds(p, face);
        return (
          c.minZ >= m.maxZ - EPS &&
          c.minX <= e.minX + EPS &&
          c.maxX >= e.maxX - EPS &&
          p.oy >= top(entrances[0]) - EPS
        );
      });
      if (canopies.length !== 1) violations.push(`${tag}: ${canopies.length} entrance canopies`);
    }
    expect(violations).toEqual([]);
    expect(seen).toBeGreaterThan(0);
  });
});
