# Building Visuals Stage 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the one-to-three flat boxes per zone building with a
procedural low-poly kit (boxes, gable roofs, hip roofs, cylinders) drawn
from per-zone colour families, with street-facing doors and awnings, a
gentle supply tint on the body, and incremental instance slots.

**Architecture:** Render-only. `src/render/buildingsMesh.ts` is split
into a pure recipe module (`src/render/buildings/recipes.ts`: a seeded
picker turns zone, density, variant, tile index and street face into a
list of typed parts), a palette module (`palette.ts`: colour families
and the supply tint), a primitive geometry module (`primitives.ts`: the
four `InstancedMesh` geometries, all unit footprint with base at y = 0)
and a block allocator (`blocks.ts`: fixed-size slot blocks per tile and
kind with a free list). `BuildingsMesh` keeps the `DiffLayer` role, owns
one `InstancedMesh` per primitive kind plus the window mesh, tracks road
presence for the street face, and animates growth. The sim, the worker
protocol and the save format do not change.

**Tech Stack:** TypeScript (strict), three.js, Vitest, pnpm, oxlint,
oxfmt.

**Spec:** `docs/superpowers/specs/2026-10-03-building-visuals-design.md`

## Global Constraints

- No sim, protocol (`src/shared/types.ts`, `src/shared/messages.ts`) or
  save-format changes. `BUILDING_VARIANTS` stays 8.
- Every `InstancedMesh` sets `frustumCulled = false` (instance transforms
  span the grid; the base-geometry bounds would cull them).
- Recipes are deterministic in `(zone, density, variant, index,
streetFace)`; no `Math.random`.
- At most 8 parts per tile; per-kind maxima `Box 7, GableRoof 2,
HipRoof 1, Cylinder 2` (`MAX_PARTS_PER_KIND`), proven by test over all
  zones, densities, variants, faces and tile indices 0..4095.
- No part leaves the 0.86 footprint (|offset| + half-size ≤ 0.43 in x
  and z) or sinks below y = 0.
- Rooftop PV appears from density 2 only (mirrors the sim's rooftop
  feed-in); its colour stays `0x2b3d66`.
- Supply tint: Supplied unchanged; Undersupplied 35 % toward `0x8a8a8a`;
  NotConnected 60 % toward `0x8a8a8a` then ×0.9. Accents (doors, PV,
  tanks, chimneys, AC units, antennas) are never tinted.
- Run `pnpm format` after edits; the pre-commit hook runs
  `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`.
  Never use `--no-verify`.
- All new code under `src/render/buildings/`; render code is outside
  the coverage gate but every pure module gets a colocated test.
- Window quads: cap 24 per tile (street face + opposite face), window
  colour `0xffc978`, one-in-three deterministic dark skip, night fade
  unchanged.
- Deviations from the spec, agreed in planning: (1) capacity is a tested
  constant table instead of a startup derivation, because the tile index
  feeds the picker and cannot be enumerated at startup; (2) windows go on
  the street face and its opposite with a cap of 24 instead of 20;
  (3) retail bodies are 0.70 × 0.60 (d1), 0.70 × 0.66 (d2) and 0.80 ×
  0.78 (d3) so awnings stay inside the footprint limit; (4) parts gain
  an optional `tilt` (rotation about the part's local x axis) so rooftop
  PV can lie on a roof slope.

---

### Task 1: Primitive geometries

**Files:**

- Create: `src/render/buildings/primitives.ts`
- Test: `src/render/buildings/primitives.test.ts`

**Interfaces:**

- Produces: `PartKind` const enum `{ Box: 0, GableRoof: 1, HipRoof: 2, Cylinder: 3 }`,
  `PART_KINDS: readonly PartKind[]`, `createPartGeometry(kind: PartKind): THREE.BufferGeometry`.
  Every geometry has footprint x, z ∈ [-0.5, 0.5], base y = 0, top y = 1.

- [ ] **Step 1: Write the failing test**

```ts
// src/render/buildings/primitives.test.ts
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { PART_KINDS, PartKind, createPartGeometry } from './primitives.ts';

describe('building primitives', () => {
  it('lists the four kinds in enum order', () => {
    expect(PART_KINDS).toEqual([
      PartKind.Box,
      PartKind.GableRoof,
      PartKind.HipRoof,
      PartKind.Cylinder,
    ]);
  });

  it.each(PART_KINDS)('kind %i spans a unit footprint with its base at y = 0', (kind) => {
    const geometry = createPartGeometry(kind);
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    expect(box.min.x).toBeCloseTo(-0.5, 5);
    expect(box.max.x).toBeCloseTo(0.5, 5);
    expect(box.min.z).toBeCloseTo(-0.5, 5);
    expect(box.max.z).toBeCloseTo(0.5, 5);
    expect(box.min.y).toBeCloseTo(0, 5);
    expect(box.max.y).toBeCloseTo(1, 5);
  });

  it.each(PART_KINDS)('kind %i carries normals for Lambert shading', (kind) => {
    const geometry = createPartGeometry(kind);
    expect(geometry.getAttribute('normal')).toBeDefined();
    expect(geometry.getAttribute('normal').count).toBe(geometry.getAttribute('position').count);
  });

  it('gives the gable roof outward-facing slopes', () => {
    const geometry = createPartGeometry(PartKind.GableRoof);
    const normal = geometry.getAttribute('normal') as THREE.BufferAttribute;
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    // Every face normal must point away from the roof's centre (0, 0.5, 0).
    for (let i = 0; i < position.count; i++) {
      const p = new THREE.Vector3()
        .fromBufferAttribute(position, i)
        .sub(new THREE.Vector3(0, 0.5, 0));
      const n = new THREE.Vector3().fromBufferAttribute(normal, i);
      expect(p.dot(n)).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/render/buildings/primitives.test.ts`
Expected: FAIL — cannot find module `./primitives.ts`.

- [ ] **Step 3: Write the implementation**

```ts
// src/render/buildings/primitives.ts
import * as THREE from 'three';

/** The instanced geometries a building is composed from. */
export const PartKind = { Box: 0, GableRoof: 1, HipRoof: 2, Cylinder: 3 } as const;
export type PartKind = (typeof PartKind)[keyof typeof PartKind];

export const PART_KINDS: readonly PartKind[] = [
  PartKind.Box,
  PartKind.GableRoof,
  PartKind.HipRoof,
  PartKind.Cylinder,
];

const CYLINDER_SEGMENTS = 8;
const H = 0.5;

/** Non-indexed triangles → computeVertexNormals yields flat per-face normals. */
function flatGeometry(triangles: number[]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(triangles, 3));
  geometry.computeVertexNormals();
  return geometry;
}

// Corners of the unit footprint at y = 0 (a = NW, b = NE, c = SE, d = SW;
// +z is south) — shared by both roofs. All faces wind counter-clockwise
// seen from outside.
const BOTTOM = [-H, 0, -H, H, 0, -H, H, 0, H, -H, 0, -H, H, 0, H, -H, 0, H];

/** Triangular prism: ridge along x at y = 1, eaves at y = 0 on z = ±0.5. */
function createGableRoof(): THREE.BufferGeometry {
  return flatGeometry([
    // south slope (+z)
    -H,
    0,
    H,
    H,
    0,
    H,
    H,
    1,
    0,
    -H,
    0,
    H,
    H,
    1,
    0,
    -H,
    1,
    0,
    // north slope (-z)
    H,
    0,
    -H,
    -H,
    0,
    -H,
    -H,
    1,
    0,
    H,
    0,
    -H,
    -H,
    1,
    0,
    H,
    1,
    0,
    // east gable (+x)
    H,
    0,
    H,
    H,
    0,
    -H,
    H,
    1,
    0,
    // west gable (-x)
    -H,
    0,
    -H,
    -H,
    0,
    H,
    -H,
    1,
    0,
    ...BOTTOM,
  ]);
}

/** Four-sided pyramid with the apex at (0, 1, 0). */
function createHipRoof(): THREE.BufferGeometry {
  return flatGeometry([
    // south
    -H,
    0,
    H,
    H,
    0,
    H,
    0,
    1,
    0,
    // east
    H,
    0,
    H,
    H,
    0,
    -H,
    0,
    1,
    0,
    // north
    H,
    0,
    -H,
    -H,
    0,
    -H,
    0,
    1,
    0,
    // west
    -H,
    0,
    -H,
    -H,
    0,
    H,
    0,
    1,
    0,
    ...BOTTOM,
  ]);
}

/**
 * Geometry for one primitive kind. Every kind shares the convention
 * "unit footprint centred on the origin, base at y = 0, height 1", so the
 * instance matrix is always scale → rotate → translate.
 */
export function createPartGeometry(kind: PartKind): THREE.BufferGeometry {
  switch (kind) {
    case PartKind.Box:
      return new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    case PartKind.GableRoof:
      return createGableRoof();
    case PartKind.HipRoof:
      return createHipRoof();
    case PartKind.Cylinder:
      return new THREE.CylinderGeometry(0.5, 0.5, 1, CYLINDER_SEGMENTS).translate(0, 0.5, 0);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/render/buildings/primitives.test.ts`
Expected: PASS (4 test groups, 10 tests).

- [ ] **Step 5: Format, lint and commit**

```bash
pnpm format && pnpm lint
git add src/render/buildings/primitives.ts src/render/buildings/primitives.test.ts
git commit -m "feat(render): add building primitive geometries

Box, gable roof, hip roof and cylinder share a unit footprint with the
base at y = 0 so one matrix path places every part.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Palette and supply tint

**Files:**

- Create: `src/render/buildings/palette.ts`
- Test: `src/render/buildings/palette.test.ts`

**Interfaces:**

- Produces: `ZoneFamily { walls, roofs, trims: readonly THREE.Color[] }`,
  `ZONE_FAMILIES: Record<number, ZoneFamily>` (keys `Zone.Residential|Commercial|Retail`),
  `ACCENT` (`door, rooftopPv, waterTank, chimney, acUnit, antenna`),
  `applySupplyTint(color: THREE.Color, status: SupplyStatus, out: THREE.Color): THREE.Color`.

- [ ] **Step 1: Write the failing test**

```ts
// src/render/buildings/palette.test.ts
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { SupplyStatus, Zone } from '../../shared/types.ts';
import { ACCENT, ZONE_FAMILIES, applySupplyTint } from './palette.ts';

describe('building palette', () => {
  it.each([Zone.Residential, Zone.Commercial, Zone.Retail])(
    'zone %i exposes 4 wall, 3 roof and 2 trim hues',
    (zone) => {
      const family = ZONE_FAMILIES[zone];
      expect(family.walls).toHaveLength(4);
      expect(family.roofs).toHaveLength(3);
      expect(family.trims).toHaveLength(2);
    },
  );

  it('keeps the rooftop PV navy the sim-era renderer used', () => {
    expect(ACCENT.rooftopPv.getHex()).toBe(0x2b3d66);
  });

  it('leaves supplied buildings untouched', () => {
    const wall = new THREE.Color(0xe3cfa6);
    const out = applySupplyTint(wall, SupplyStatus.Supplied, new THREE.Color());
    expect(out.getHex()).toBe(0xe3cfa6);
  });

  it('greys undersupplied buildings a little and disconnected ones more', () => {
    const wall = new THREE.Color(0xe3cfa6);
    const under = applySupplyTint(wall, SupplyStatus.Undersupplied, new THREE.Color());
    const off = applySupplyTint(wall, SupplyStatus.NotConnected, new THREE.Color());
    const saturation = (c: THREE.Color) => {
      const hsl = { h: 0, s: 0, l: 0 };
      c.getHSL(hsl);
      return hsl.s;
    };
    expect(saturation(under)).toBeLessThan(saturation(wall));
    expect(saturation(off)).toBeLessThan(saturation(under));
    const lightness = (c: THREE.Color) => {
      const hsl = { h: 0, s: 0, l: 0 };
      c.getHSL(hsl);
      return hsl.l;
    };
    expect(lightness(off)).toBeLessThan(lightness(under));
    for (const c of [under, off]) {
      for (const channel of [c.r, c.g, c.b]) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    }
  });

  it('does not mutate its input', () => {
    const wall = new THREE.Color(0xe3cfa6);
    applySupplyTint(wall, SupplyStatus.NotConnected, new THREE.Color());
    expect(wall.getHex()).toBe(0xe3cfa6);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/render/buildings/palette.test.ts`
Expected: FAIL — cannot find module `./palette.ts`.

- [ ] **Step 3: Write the implementation**

```ts
// src/render/buildings/palette.ts
import * as THREE from 'three';
import { SupplyStatus, Zone } from '../../shared/types.ts';

export interface ZoneFamily {
  walls: readonly THREE.Color[];
  roofs: readonly THREE.Color[];
  trims: readonly THREE.Color[];
}

const colors = (...hex: number[]): readonly THREE.Color[] => hex.map((h) => new THREE.Color(h));

/**
 * Per-zone colour families. Each zone keeps its identity (warm cream and
 * brick, cool grey and glass, rose and apricot) so zones still read at a
 * glance with several hues each.
 */
export const ZONE_FAMILIES: Record<number, ZoneFamily> = {
  [Zone.Residential]: {
    walls: colors(0xf1e6cf, 0xe3cfa6, 0xe8c3a6, 0xf6f2ea),
    roofs: colors(0xb85c45, 0x6b7280, 0x7d5a44),
    trims: colors(0xfbf8f1, 0x3d6b4f),
  },
  [Zone.Commercial]: {
    walls: colors(0xaab4bf, 0x8fa3b8, 0x7fb3b8, 0xb9b3a9),
    roofs: colors(0x4f565e, 0x2e3238, 0x7c8792),
    trims: colors(0xf2f4f6, 0x33383f),
  },
  [Zone.Retail]: {
    walls: colors(0xd9a39b, 0xe9b98f, 0xe9d99a, 0xd6b39c),
    roofs: colors(0x8f3b3b, 0x7a7f4a, 0x6f7378),
    trims: colors(0xc9453f, 0x3f8f8a),
  },
};

/** Shared accents; these are never supply-tinted. */
export const ACCENT = {
  door: new THREE.Color(0x4a3426),
  rooftopPv: new THREE.Color(0x2b3d66),
  waterTank: new THREE.Color(0xc8ccd0),
  chimney: new THREE.Color(0x9a4f3b),
  acUnit: new THREE.Color(0xf0f2f4),
  antenna: new THREE.Color(0x4b4f55),
} as const;

const SUPPLY_GREY = new THREE.Color(0x8a8a8a);
const UNDERSUPPLIED_BLEND = 0.35;
const NOT_CONNECTED_BLEND = 0.6;
const NOT_CONNECTED_DARKEN = 0.9;

/**
 * Gentle body tint for the supply status — the Supply overlay stays the
 * diagnostic tool, the building only hints. Writes into `out`.
 */
export function applySupplyTint(
  color: THREE.Color,
  status: SupplyStatus,
  out: THREE.Color,
): THREE.Color {
  out.copy(color);
  if (status === SupplyStatus.Undersupplied) {
    out.lerp(SUPPLY_GREY, UNDERSUPPLIED_BLEND);
  } else if (status === SupplyStatus.NotConnected) {
    out.lerp(SUPPLY_GREY, NOT_CONNECTED_BLEND).multiplyScalar(NOT_CONNECTED_DARKEN);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/render/buildings/palette.test.ts`
Expected: PASS.

- [ ] **Step 5: Format, lint and commit**

```bash
pnpm format && pnpm lint
git add src/render/buildings/palette.ts src/render/buildings/palette.test.ts
git commit -m "feat(render): add building colour families and supply tint

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Recipe foundation and residential recipes

**Files:**

- Create: `src/render/buildings/recipes.ts`
- Test: `src/render/buildings/recipes.test.ts`

**Interfaces:**

- Consumes: `PartKind`, `PART_KINDS` (Task 1); `ZONE_FAMILIES`, `ACCENT` (Task 2).
- Produces:
  - `StreetFace` const `{ South: 0, East: 1, North: 2, West: 3 }`, `STREET_FACES`.
  - `interface BuildingPart { kind: PartKind; sx; sy; sz; ox; oy; oz; turn: number; tilt?: number; color: THREE.Color; main?: boolean; accent?: boolean }`.
  - `MAX_PARTS_PER_TILE = 8`, `MAX_PARTS_PER_KIND: Record<PartKind, number>`, `FOOTPRINT_HALF = 0.43`.
  - `createPicker(variant, index): Picker` with `pick(n)`, `unit()`, `chance(p)`, `from<T>(list)`.
  - `faceOffset(lx, lz, face): [number, number]`, `faceWidth(body, face)`, `faceDepth(body, face)`.
  - `streetFaceFor(index, gridSize, isRoad: (index: number) => boolean): StreetFace`.
  - `buildingParts(zone, density, variant, index, face): BuildingPart[]`.
  - `buildingHeight(zone, density, variant, index): number`.
  - `mainBody(parts): BuildingPart | undefined`.
    Commercial and retail return `[]` until Tasks 4 and 5.

- [ ] **Step 1: Write the failing test**

```ts
// src/render/buildings/recipes.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/render/buildings/recipes.test.ts`
Expected: FAIL — cannot find module `./recipes.ts`.

- [ ] **Step 3: Write the implementation**

```ts
// src/render/buildings/recipes.ts
import * as THREE from 'three';
import { Zone } from '../../shared/types.ts';
import { PartKind } from './primitives.ts';
import { ACCENT, ZONE_FAMILIES, type ZoneFamily } from './palette.ts';

/** Which side of a building faces the street; the value is also the quarter-turn count. */
export const StreetFace = { South: 0, East: 1, North: 2, West: 3 } as const;
export type StreetFace = (typeof StreetFace)[keyof typeof StreetFace];
export const STREET_FACES: readonly StreetFace[] = [
  StreetFace.South,
  StreetFace.East,
  StreetFace.North,
  StreetFace.West,
];

export interface BuildingPart {
  kind: PartKind;
  /** Footprint (tile fractions) and height, before rotation. */
  sx: number;
  sy: number;
  sz: number;
  /** Offset from the tile centre (tile fractions) and base height. */
  ox: number;
  oy: number;
  oz: number;
  /** Rotation about Y in quarter turns (0..3), applied after `tilt`. */
  turn: number;
  /** Optional rotation about the part's local x axis in radians (rooftop PV on a slope). */
  tilt?: number;
  color: THREE.Color;
  /** The body that carries windows — exactly one per building. */
  main?: boolean;
  /** Accents keep their colour under the supply tint. */
  accent?: boolean;
}

export const MAX_PARTS_PER_TILE = 8;
/** Slots a tile owns per primitive kind; proven over the whole grid by recipes.test.ts. */
export const MAX_PARTS_PER_KIND: Record<PartKind, number> = {
  [PartKind.Box]: 7,
  [PartKind.GableRoof]: 2,
  [PartKind.HipRoof]: 1,
  [PartKind.Cylinder]: 2,
};
/** Half of the 0.86 footprint: no part may reach past this from the tile centre. */
export const FOOTPRINT_HALF = 0.43;

const ROOF_OVERHANG = 0.04;
const DOOR = { width: 0.2, height: 0.16, depth: 0.02 };
const ROOFTOP_PV_THICKNESS = 0.02;

export interface Picker {
  /** Stable integer in 0..n-1. */
  pick(n: number): number;
  /** Stable float in [0, 1). */
  unit(): number;
  chance(probability: number): boolean;
  from<T>(list: readonly T[]): T;
}

/**
 * Seeded picker over (variant, tile index): the same tile always builds
 * the same house on every client; neighbours with the same variant differ.
 * mulberry32 over a hash of both inputs.
 */
export function createPicker(variant: number, index: number): Picker {
  let state = (Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(variant + 1, 0x85ebca77)) | 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let x = Math.imul(state ^ (state >>> 15), 1 | state);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return (x ^ (x >>> 14)) >>> 0;
  };
  const unit = (): number => next() / 4294967296;
  return {
    pick: (n) => next() % n,
    unit,
    chance: (probability) => unit() < probability,
    from: (list) => list[next() % list.length],
  };
}

/** Rotate an offset given in the south-facing frame (street at +z) onto `face`. */
export function faceOffset(lx: number, lz: number, face: StreetFace): [number, number] {
  switch (face) {
    case StreetFace.South:
      return [lx, lz];
    case StreetFace.East:
      return [lz, -lx];
    case StreetFace.North:
      return [-lx, -lz];
    default:
      return [-lz, lx];
  }
}

/** Extent of `body` along the given face (its width as seen from the street). */
export function faceWidth(body: BuildingPart, face: StreetFace): number {
  return face === StreetFace.East || face === StreetFace.West ? body.sz : body.sx;
}

/** Extent of `body` perpendicular to the given face (depth away from the street). */
export function faceDepth(body: BuildingPart, face: StreetFace): number {
  return face === StreetFace.East || face === StreetFace.West ? body.sx : body.sz;
}

/** First adjacent road in the order south, east, west, north; south when none. */
export function streetFaceFor(
  index: number,
  gridSize: number,
  isRoad: (index: number) => boolean,
): StreetFace {
  const x = index % gridSize;
  const z = Math.floor(index / gridSize);
  if (z + 1 < gridSize && isRoad(index + gridSize)) return StreetFace.South;
  if (x + 1 < gridSize && isRoad(index + 1)) return StreetFace.East;
  if (x > 0 && isRoad(index - 1)) return StreetFace.West;
  if (z > 0 && isRoad(index - gridSize)) return StreetFace.North;
  return StreetFace.South;
}

interface Local {
  /** Size in the south frame: w along the face, h up, d away from the street. */
  w: number;
  h: number;
  d: number;
  /** Offset from the body centre in the south frame; +lz is toward the street. */
  lx: number;
  ly: number;
  lz: number;
  /** Extra quarter turns on top of the face rotation. */
  turn?: number;
  tilt?: number;
}

function box(
  sx: number,
  sy: number,
  sz: number,
  ox: number,
  oy: number,
  oz: number,
  color: THREE.Color,
  flags: { main?: boolean; accent?: boolean } = {},
): BuildingPart {
  return { kind: PartKind.Box, sx, sy, sz, ox, oy, oz, turn: 0, color, ...flags };
}

/**
 * A part described relative to `body` in the street-facing frame and
 * rotated onto `face`. The geometry turns with the face so `w` always runs
 * along the facade.
 */
function facePart(
  kind: PartKind,
  body: BuildingPart,
  face: StreetFace,
  local: Local,
  color: THREE.Color,
  flags: { main?: boolean; accent?: boolean } = {},
): BuildingPart {
  const [dx, dz] = faceOffset(local.lx, local.lz, face);
  const part: BuildingPart = {
    kind,
    sx: local.w,
    sy: local.h,
    sz: local.d,
    ox: body.ox + dx,
    oy: body.oy + local.ly,
    oz: body.oz + dz,
    turn: ((local.turn ?? 0) + face) % 4,
    color,
    ...flags,
  };
  if (local.tilt) part.tilt = local.tilt;
  return part;
}

/** A thin slab hugging the street face of `body`. */
function onStreetFace(
  body: BuildingPart,
  face: StreetFace,
  widthFraction: number,
  height: number,
  depth: number,
  ly: number,
  color: THREE.Color,
  along = 0,
): BuildingPart {
  const w = faceWidth(body, face) * widthFraction;
  return facePart(
    PartKind.Box,
    body,
    face,
    {
      w,
      h: height,
      d: depth,
      lx: along * (faceWidth(body, face) / 2 - w / 2),
      ly,
      lz: faceDepth(body, face) / 2 + depth / 2,
    },
    color,
    { accent: true },
  );
}

/**
 * Rooftop PV lying on the street-facing slope of a gable roof whose
 * eaves span `roofDepth` (in the face frame) and whose ridge is `roofHeight`
 * above the eaves at `ly`. The slab pivots at its base, so the pivot sits a
 * hair above the slope midpoint along the slope normal.
 */
function pvOnSlope(
  body: BuildingPart,
  face: StreetFace,
  roofWidth: number,
  roofDepth: number,
  roofHeight: number,
  ly: number,
): BuildingPart {
  const run = roofDepth / 2;
  const angle = Math.atan2(roofHeight, run);
  const slope = Math.hypot(run, roofHeight);
  const lift = 0.01;
  return facePart(
    PartKind.Box,
    body,
    face,
    {
      w: roofWidth * 0.6,
      h: ROOFTOP_PV_THICKNESS,
      d: slope * 0.6,
      lx: 0,
      ly: ly + roofHeight / 2 + lift * Math.cos(angle),
      lz: run / 2 + lift * Math.sin(angle),
      tilt: angle,
    },
    ACCENT.rooftopPv,
    { accent: true },
  );
}

function residential(
  density: number,
  p: Picker,
  face: StreetFace,
  family: ZoneFamily,
): BuildingPart[] {
  const wall = p.from(family.walls);
  const roof = p.from(family.roofs);
  const trim = p.from(family.trims);
  const parts: BuildingPart[] = [];

  if (density === 1) {
    // Detached house, off centre, gable or hip roof, chimney, door, maybe an extension.
    const w = 0.42 + p.unit() * 0.08;
    const d = 0.42 + p.unit() * 0.08;
    const h = 0.3 + p.unit() * 0.08;
    const ox = (p.unit() - 0.5) * 0.2;
    const oz = (p.unit() - 0.5) * 0.2;
    const body = box(w, h, d, ox, 0, oz, wall, { main: true });
    parts.push(body);
    const roofHeight = 0.14;
    if (p.chance(0.25)) {
      parts.push({
        kind: PartKind.HipRoof,
        sx: w + ROOF_OVERHANG,
        sy: roofHeight,
        sz: d + ROOF_OVERHANG,
        ox,
        oy: h,
        oz,
        turn: 0,
        color: roof,
      });
    } else {
      const turn = p.pick(2);
      parts.push({
        kind: PartKind.GableRoof,
        sx: turn === 0 ? w + ROOF_OVERHANG : d + ROOF_OVERHANG,
        sy: roofHeight,
        sz: turn === 0 ? d + ROOF_OVERHANG : w + ROOF_OVERHANG,
        ox,
        oy: h,
        oz,
        turn,
        color: roof,
      });
    }
    const sideX = p.chance(0.5) ? 1 : -1;
    const sideZ = p.chance(0.5) ? 1 : -1;
    parts.push(
      box(0.06, 0.18, 0.06, ox + sideX * w * 0.3, h, oz + sideZ * d * 0.25, ACCENT.chimney, {
        accent: true,
      }),
    );
    parts.push(onStreetFace(body, face, DOOR.width / w, DOOR.height, DOOR.depth, 0, ACCENT.door));
    if (p.chance(1 / 3)) {
      // Lower wing on the side with room, with its own small gable (ridge along z).
      const side = ox >= 0 ? -1 : 1;
      const ew = 0.16;
      const eh = h * 0.7;
      const ed = d * 0.7;
      const ex = ox + side * (w / 2 + ew / 2);
      parts.push(box(ew, eh, ed, ex, 0, oz, wall));
      parts.push({
        kind: PartKind.GableRoof,
        sx: ed,
        sy: 0.08,
        sz: ew,
        ox: ex,
        oy: eh,
        oz,
        turn: 1,
        color: roof,
      });
    }
  } else if (density === 2) {
    // Town house: gable roof with a dormer on half the variants, ledge band, PV on the slope.
    const w = 0.6;
    const d = 0.5;
    const h = 0.55 + p.unit() * 0.1;
    const body = box(w, h, d, 0, 0, 0, wall, { main: true });
    parts.push(body);
    const roofHeight = 0.16;
    const roofW = faceWidth(body, face) + ROOF_OVERHANG;
    const roofD = faceDepth(body, face) + ROOF_OVERHANG;
    // Ridge runs along the street face so the PV slope faces the street.
    parts.push(
      facePart(
        PartKind.GableRoof,
        body,
        face,
        { w: roofW, h: roofHeight, d: roofD, lx: 0, ly: h, lz: 0 },
        roof,
      ),
    );
    if (p.chance(0.5)) {
      // Dormer on the back slope, so it never collides with the PV slab.
      parts.push(
        facePart(
          PartKind.Box,
          body,
          face,
          { w: 0.14, h: 0.1, d: 0.12, lx: (p.unit() - 0.5) * 0.2, ly: h + 0.02, lz: -roofD / 4 },
          wall,
        ),
      );
      parts.push(
        facePart(
          PartKind.GableRoof,
          body,
          face,
          { w: 0.16, h: 0.06, d: 0.14, lx: 0, ly: h + 0.12, lz: -roofD / 4 },
          roof,
        ),
      );
    }
    parts.push(
      onStreetFace(
        body,
        face,
        DOOR.width / faceWidth(body, face),
        DOOR.height,
        DOOR.depth,
        0,
        ACCENT.door,
        p.unit() - 0.5,
      ),
    );
    parts.push(box(w + 0.02, 0.02, d + 0.02, 0, h * 0.5, 0, trim, { accent: true }));
    parts.push(pvOnSlope(body, face, roofW, roofD, roofHeight, h));
  } else {
    // Apartment block: parapet, stairwell, balconies on the street face, flat PV, maybe a water tank.
    const w = 0.7;
    const h = 1.0 + p.unit() * 0.2;
    const body = box(w, h, w, 0, 0, 0, wall, { main: true });
    parts.push(body);
    parts.push(box(w + 0.04, 0.04, w + 0.04, 0, h, 0, roof));
    parts.push(box(0.2, 0.12, 0.2, -0.18, h, -0.18, wall));
    const balconies = 2 + p.pick(2);
    for (let i = 0; i < balconies; i++) {
      parts.push(onStreetFace(body, face, 0.7, 0.03, 0.08, (h * (i + 1)) / (balconies + 1), trim));
    }
    parts.push(
      box(0.49, ROOFTOP_PV_THICKNESS, 0.38, 0.12, h + 0.04, 0.12, ACCENT.rooftopPv, {
        accent: true,
      }),
    );
    if (p.chance(1 / 3)) {
      parts.push({
        kind: PartKind.Cylinder,
        sx: 0.12,
        sy: 0.14,
        sz: 0.12,
        ox: -0.22,
        oy: h,
        oz: 0.22,
        turn: 0,
        color: ACCENT.waterTank,
        accent: true,
      });
    }
  }
  return parts;
}

/**
 * Procedural low-poly building parts for a zone/density/variant/tile
 * triple facing `face`. Deterministic in its inputs so every client
 * renders the same city.
 */
export function buildingParts(
  zone: Zone,
  density: number,
  variant: number,
  index: number,
  face: StreetFace,
): BuildingPart[] {
  const family = ZONE_FAMILIES[zone];
  if (!family) return [];
  const picker = createPicker(variant, index);
  switch (zone) {
    case Zone.Residential:
      return residential(density, picker, face, family);
    default:
      return [];
  }
}

/** Top of the tallest part — how high the building rises above the tile. */
export function buildingHeight(
  zone: Zone,
  density: number,
  variant: number,
  index: number,
): number {
  let top = 0;
  for (const p of buildingParts(zone, density, variant, index, StreetFace.South)) {
    top = Math.max(top, p.oy + p.sy);
  }
  return top;
}

/** The part that carries windows. */
export function mainBody(parts: readonly BuildingPart[]): BuildingPart | undefined {
  return parts.find((p) => p.main);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/render/buildings/recipes.test.ts`
Expected: PASS. If the footprint test fails, the failing message names
zone/density/variant/face/index — shrink that recipe's offsets, never
raise `FOOTPRINT_HALF`.

- [ ] **Step 5: Format, lint and commit**

```bash
pnpm format && pnpm lint
git add src/render/buildings/recipes.ts src/render/buildings/recipes.test.ts
git commit -m "feat(render): add building recipe kit with residential houses

Seeded picker over variant and tile index, street-face helpers, part
budgets per kind, and the three residential recipes (detached house,
town house, apartment block).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Commercial recipes

**Files:**

- Modify: `src/render/buildings/recipes.ts` (add `commercial`, wire into `buildingParts`)
- Modify: `src/render/buildings/recipes.test.ts` (`ZONES` gains `Zone.Commercial`, one new test)

**Interfaces:**

- Consumes: everything from Task 3.
- Produces: `buildingParts(Zone.Commercial, …)` returns 4–7 parts; the
  density-3 tower includes exactly one `Cylinder` part coloured
  `ACCENT.antenna` (the stage 2 light anchor).

- [ ] **Step 1: Extend the test**

In `recipes.test.ts` change `const ZONES: Zone[] = [Zone.Residential];`
to `const ZONES: Zone[] = [Zone.Residential, Zone.Commercial];` and add
inside `describe('building recipes', …)`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/render/buildings/recipes.test.ts`
Expected: FAIL — "have exactly one main body" fails for commercial
(empty parts) and the antenna test finds none.

- [ ] **Step 3: Add the commercial recipes**

Insert after `residential` in `recipes.ts`:

```ts
function commercial(
  density: number,
  p: Picker,
  face: StreetFace,
  family: ZoneFamily,
): BuildingPart[] {
  const wall = p.from(family.walls);
  const roof = p.from(family.roofs);
  const trim = p.from(family.trims);
  const parts: BuildingPart[] = [];

  if (density === 1) {
    // Low office: cornice band, entrance canopy, one AC unit.
    const w = 0.62;
    const h = 0.4 + p.unit() * 0.06;
    const body = box(w, h, w, 0, 0, 0, wall, { main: true });
    parts.push(body);
    parts.push(box(w + 0.04, 0.03, w + 0.04, 0, h - 0.03, 0, trim, { accent: true }));
    parts.push(onStreetFace(body, face, 0.5, 0.03, 0.1, h * 0.55, trim));
    parts.push(box(0.1, 0.08, 0.1, 0.15, h, -0.15, ACCENT.acUnit, { accent: true }));
  } else if (density === 2) {
    // Office block: two facade bands, two AC units, antenna, flat PV.
    const w = 0.62;
    const h = 1.0 + p.unit() * 0.1;
    const body = box(w, h, w, 0, 0, 0, wall, { main: true });
    parts.push(body);
    parts.push(box(w + 0.02, 0.025, w + 0.02, 0, h / 3, 0, trim, { accent: true }));
    parts.push(box(w + 0.02, 0.025, w + 0.02, 0, (2 * h) / 3, 0, trim, { accent: true }));
    parts.push(box(0.1, 0.08, 0.1, 0.15, h, -0.15, ACCENT.acUnit, { accent: true }));
    parts.push(box(0.1, 0.08, 0.1, -0.15, h, -0.15, ACCENT.acUnit, { accent: true }));
    parts.push({
      kind: PartKind.Cylinder,
      sx: 0.03,
      sy: 0.25,
      sz: 0.03,
      ox: 0.2,
      oy: h,
      oz: 0.2,
      turn: 0,
      color: ACCENT.antenna,
      accent: true,
    });
    parts.push(
      box(0.4, ROOFTOP_PV_THICKNESS, 0.3, -0.1, h, 0.12, ACCENT.rooftopPv, { accent: true }),
    );
  } else {
    // Tower with a setback upper third; a cylindrical core or a plant room; antenna; PV.
    const w = 0.66;
    const h = 1.6 + p.unit() * 0.3;
    const lowerH = h * 0.67;
    const upperH = h - lowerH;
    const body = box(w, lowerH, w, 0, 0, 0, wall, { main: true });
    parts.push(body);
    const setback = -0.08;
    parts.push(box(0.46, upperH, 0.46, setback, lowerH, setback, wall));
    parts.push(box(w + 0.04, 0.03, w + 0.04, 0, lowerH - 0.03, 0, trim, { accent: true }));
    if (p.chance(0.5)) {
      parts.push({
        kind: PartKind.Cylinder,
        sx: 0.16,
        sy: upperH + 0.1,
        sz: 0.16,
        ox: 0.24,
        oy: lowerH,
        oz: 0.24,
        turn: 0,
        color: roof,
      });
    } else {
      parts.push(box(0.16, 0.1, 0.16, 0.24, lowerH, 0.24, roof));
    }
    parts.push({
      kind: PartKind.Cylinder,
      sx: 0.03,
      sy: 0.3,
      sz: 0.03,
      ox: -0.25,
      oy: h,
      oz: -0.25,
      turn: 0,
      color: ACCENT.antenna,
      accent: true,
    });
    parts.push(
      box(0.3, ROOFTOP_PV_THICKNESS, 0.2, -0.02, h, -0.02, ACCENT.rooftopPv, { accent: true }),
    );
  }
  return parts;
}
```

and in `buildingParts` add the case:

```ts
    case Zone.Commercial:
      return commercial(density, picker, face, family);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/render/buildings/recipes.test.ts`
Expected: PASS.

- [ ] **Step 5: Format, lint and commit**

```bash
pnpm format && pnpm lint
git add src/render/buildings/recipes.ts src/render/buildings/recipes.test.ts
git commit -m "feat(render): add commercial building recipes

Low office, office block and setback tower; the tower's antenna cylinder
is the anchor for the stage 2 blinking light.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Retail recipes

**Files:**

- Modify: `src/render/buildings/recipes.ts` (add `retail`, wire into `buildingParts`)
- Modify: `src/render/buildings/recipes.test.ts` (`ZONES` gains `Zone.Retail`, one new test)

**Interfaces:**

- Consumes: everything from Task 3.
- Produces: `buildingParts(Zone.Retail, …)`; densities 1 and 2 have an
  awning (a trim-coloured accent slab on the street face), density 3 has
  two.

- [ ] **Step 1: Extend the test**

Change `ZONES` to `[Zone.Residential, Zone.Commercial, Zone.Retail]` and add:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/render/buildings/recipes.test.ts`
Expected: FAIL — retail recipes are empty.

- [ ] **Step 3: Add the retail recipes**

Insert after `commercial` in `recipes.ts`:

```ts
function retail(density: number, p: Picker, face: StreetFace, family: ZoneFamily): BuildingPart[] {
  const wall = p.from(family.walls);
  const roof = p.from(family.roofs);
  const trim = p.from(family.trims);
  const sign = family.trims[(family.trims.indexOf(trim) + 1) % family.trims.length];
  const parts: BuildingPart[] = [];

  if (density === 1) {
    // Shop: flat roof slab, awning and sign on the street face.
    const w = 0.7;
    const d = 0.6;
    const h = 0.3 + p.unit() * 0.05;
    const body = box(w, h, d, 0, 0, 0, wall, { main: true });
    parts.push(body);
    parts.push(box(w + 0.02, 0.03, d + 0.02, 0, h, 0, roof));
    parts.push(onStreetFace(body, face, 0.9, 0.04, 0.08, h * 0.6, trim));
    parts.push(onStreetFace(body, face, 0.6, 0.08, 0.03, h * 0.6 + 0.05, sign));
  } else if (density === 2) {
    // Wider shop: pitched roof over the back half, flat front with awning, sign and PV.
    const w = 0.7;
    const d = 0.66;
    const h = 0.45 + p.unit() * 0.05;
    const body = box(w, h, d, 0, 0, 0, wall, { main: true });
    parts.push(body);
    const fw = faceWidth(body, face);
    const fd = faceDepth(body, face);
    const roofKind = p.chance(0.5) ? PartKind.GableRoof : PartKind.HipRoof;
    parts.push(
      facePart(
        roofKind,
        body,
        face,
        { w: fw + ROOF_OVERHANG, h: 0.14, d: fd / 2 + 0.02, lx: 0, ly: h, lz: -fd / 4 },
        roof,
      ),
    );
    parts.push(
      facePart(
        PartKind.Box,
        body,
        face,
        { w: fw + 0.02, h: 0.03, d: fd / 2, lx: 0, ly: h, lz: fd / 4 },
        roof,
      ),
    );
    parts.push(onStreetFace(body, face, 0.9, 0.04, 0.08, h * 0.6, trim));
    parts.push(onStreetFace(body, face, 0.6, 0.08, 0.03, h * 0.6 + 0.05, sign));
    parts.push(
      facePart(
        PartKind.Box,
        body,
        face,
        {
          w: fw * 0.5,
          h: ROOFTOP_PV_THICKNESS,
          d: (fd / 2) * 0.6,
          lx: 0,
          ly: h + 0.03,
          lz: fd / 4,
        },
        ACCENT.rooftopPv,
        { accent: true },
      ),
    );
  } else {
    // Market hall: long gable across the full width, two awnings, two vent stacks, PV on the slope.
    const w = 0.8;
    const d = 0.78;
    const h = 0.8 + p.unit() * 0.08;
    const body = box(w, h, d, 0, 0, 0, wall, { main: true });
    parts.push(body);
    const fw = faceWidth(body, face);
    const fd = faceDepth(body, face);
    const roofHeight = 0.18;
    const roofW = fw * 1.04;
    const roofD = fd * 1.04;
    parts.push(
      facePart(
        PartKind.GableRoof,
        body,
        face,
        { w: roofW, h: roofHeight, d: roofD, lx: 0, ly: h, lz: 0 },
        roof,
      ),
    );
    parts.push(onStreetFace(body, face, 0.4, 0.04, 0.03, h * 0.6, trim, -1));
    parts.push(onStreetFace(body, face, 0.4, 0.04, 0.03, h * 0.6, trim, 1));
    for (const side of [-1, 1]) {
      parts.push({
        kind: PartKind.Cylinder,
        sx: 0.06,
        sy: 0.1,
        sz: 0.06,
        ox: side * 0.2,
        oy: h + roofHeight - 0.04,
        oz: 0,
        turn: 0,
        color: ACCENT.antenna,
        accent: true,
      });
    }
    parts.push(pvOnSlope(body, face, roofW, roofD, roofHeight, h));
  }
  return parts;
}
```

and the `buildingParts` case:

```ts
    case Zone.Retail:
      return retail(density, picker, face, family);
```

Note on the vent stacks: a gable turned by the face keeps its ridge along
the facade, so `ox = ±0.2, oz = 0` sits on the ridge only for south and
north faces; for east and west faces use `faceOffset(side * 0.2, 0, face)`
for `[ox, oz]`. Implement it that way:

```ts
for (const side of [-1, 1]) {
  const [vx, vz] = faceOffset(side * 0.2, 0, face);
  parts.push({
    kind: PartKind.Cylinder,
    sx: 0.06,
    sy: 0.1,
    sz: 0.06,
    ox: vx,
    oy: h + roofHeight - 0.04,
    oz: vz,
    turn: 0,
    color: ACCENT.antenna,
    accent: true,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/render/buildings/recipes.test.ts`
Expected: PASS, including the budget test over the full grid for all
three zones.

- [ ] **Step 5: Format, lint and commit**

```bash
pnpm format && pnpm lint
git add src/render/buildings/recipes.ts src/render/buildings/recipes.test.ts
git commit -m "feat(render): add retail building recipes

Shop, wider shop with a pitched back roof and a market hall with a long
gable; awnings and signs face the street.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Block allocator

**Files:**

- Create: `src/render/buildings/blocks.ts`
- Test: `src/render/buildings/blocks.test.ts`

**Interfaces:**

- Produces: `class BlockAllocator { constructor(capacity: number); alloc(): number; release(block: number): void; readonly highWater: number; readonly live: number }`.
  `highWater` is one past the highest block in use (what `mesh.count`
  derives from); `live` is the number of blocks in use.

- [ ] **Step 1: Write the failing test**

```ts
// src/render/buildings/blocks.test.ts
import { describe, expect, it } from 'vitest';
import { BlockAllocator } from './blocks.ts';

describe('BlockAllocator', () => {
  it('hands out distinct blocks and tracks the high-water mark', () => {
    const a = new BlockAllocator(4);
    const x = a.alloc();
    const y = a.alloc();
    expect(x).not.toBe(y);
    expect(a.live).toBe(2);
    expect(a.highWater).toBe(2);
  });

  it('reuses released blocks instead of growing', () => {
    const a = new BlockAllocator(4);
    const x = a.alloc();
    a.alloc();
    a.release(x);
    expect(a.live).toBe(1);
    expect(a.alloc()).toBe(x);
    expect(a.highWater).toBe(2);
  });

  it('lowers the high-water mark when the top blocks are released', () => {
    const a = new BlockAllocator(4);
    const x = a.alloc();
    const y = a.alloc();
    const z = a.alloc();
    a.release(z);
    expect(a.highWater).toBe(2);
    a.release(x);
    expect(a.highWater).toBe(2); // y still holds block 1
    a.release(y);
    expect(a.highWater).toBe(0);
    expect(a.live).toBe(0);
  });

  it('ignores double releases', () => {
    const a = new BlockAllocator(2);
    const x = a.alloc();
    a.release(x);
    a.release(x);
    expect(a.live).toBe(0);
    expect(a.alloc()).toBe(x);
    expect(a.alloc()).not.toBe(x);
  });

  it('never leaks over many place/remove cycles', () => {
    const a = new BlockAllocator(8);
    for (let i = 0; i < 1000; i++) {
      const b = a.alloc();
      a.release(b);
    }
    expect(a.live).toBe(0);
    expect(a.highWater).toBe(0);
  });

  it('throws when the capacity is exhausted', () => {
    const a = new BlockAllocator(1);
    a.alloc();
    expect(() => a.alloc()).toThrow(/capacity/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/render/buildings/blocks.test.ts`
Expected: FAIL — cannot find module `./blocks.ts`.

- [ ] **Step 3: Write the implementation**

```ts
// src/render/buildings/blocks.ts

/**
 * Fixed-size slot blocks for an InstancedMesh: each tile owns one block
 * per primitive kind, allocated on first build and recycled on removal.
 * `highWater` is one past the highest block in use, so a mesh draws
 * `highWater × blockSize` instances and never more than it needs.
 */
export class BlockAllocator {
  private readonly used: Uint8Array;
  private readonly free: number[] = [];
  private next = 0;
  private top = 0;

  constructor(readonly capacity: number) {
    this.used = new Uint8Array(capacity);
  }

  get highWater(): number {
    return this.top;
  }

  get live(): number {
    return this.next - this.free.length;
  }

  alloc(): number {
    const block = this.free.length > 0 ? this.free.pop()! : this.next++;
    if (block >= this.capacity) {
      throw new Error(`BlockAllocator: capacity ${this.capacity} exhausted`);
    }
    this.used[block] = 1;
    if (block + 1 > this.top) this.top = block + 1;
    return block;
  }

  release(block: number): void {
    if (block < 0 || block >= this.capacity || !this.used[block]) return;
    this.used[block] = 0;
    this.free.push(block);
    while (this.top > 0 && !this.used[this.top - 1]) this.top--;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/render/buildings/blocks.test.ts`
Expected: PASS.

- [ ] **Step 5: Format, lint and commit**

```bash
pnpm format && pnpm lint
git add src/render/buildings/blocks.ts src/render/buildings/blocks.test.ts
git commit -m "feat(render): add block allocator for instanced building slots

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Rewrite BuildingsMesh on the kit (parts, blocks, street face, tint, growth)

**Files:**

- Rewrite: `src/render/buildingsMesh.ts`
- Modify: `src/render/renderer.ts:13` (import) and `:103` (`buildingHeight` call)
- Test: `src/render/buildingsMesh.test.ts`

**Interfaces:**

- Consumes: `PART_KINDS`, `createPartGeometry` (Task 1); `applySupplyTint` (Task 2);
  `buildingParts`, `mainBody`, `streetFaceFor`, `MAX_PARTS_PER_KIND`, `StreetFace`, `BuildingPart` (Tasks 3–5);
  `BlockAllocator` (Task 6).
- Produces: `class BuildingsMesh implements DiffLayer` with
  `readonly kindMeshes: readonly THREE.InstancedMesh[]` (index = `PartKind`),
  `streetFaceAt(index): StreetFace | undefined`, `partsAt(index): readonly BuildingPart[] | undefined`,
  `applyDiffs`, `update`, `setEnvironment`, `setReducedMotion`.
  The window layout stays exactly the current algorithm on the main body
  in this task; Task 8 reworks it.
- `buildingHeight` moves to `./buildings/recipes.ts`; `renderer.ts`
  imports it from there and passes `diff.index`.

- [ ] **Step 1: Write the failing test**

```ts
// src/render/buildingsMesh.test.ts
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { TileDiff } from '../shared/types.ts';
import { SupplyStatus, TileType, Zone } from '../shared/types.ts';
import { ElevationField } from './elevationField.ts';
import { BuildingsMesh } from './buildingsMesh.ts';
import { PART_KINDS, PartKind } from './buildings/primitives.ts';
import { MAX_PARTS_PER_KIND, StreetFace } from './buildings/recipes.ts';

const SIZE = 8;

function flatField(): ElevationField {
  const field = new ElevationField(SIZE);
  field.applyDiffs(
    Array.from({ length: SIZE * SIZE }, (_, index) => ({ index, elevation: 0 }) as TileDiff),
  );
  return field;
}

function building(
  index: number,
  zone: Zone,
  density: number,
  variant = 0,
  supplied: SupplyStatus = SupplyStatus.Supplied,
): TileDiff {
  return {
    index,
    tileType: TileType.Empty,
    zone,
    density,
    variant,
    supplied,
    elevation: 0,
  } as TileDiff;
}

function empty(index: number): TileDiff {
  return {
    index,
    tileType: TileType.Empty,
    zone: Zone.None,
    density: 0,
    variant: 0,
    supplied: SupplyStatus.NotConnected,
    elevation: 0,
  } as TileDiff;
}

function road(index: number): TileDiff {
  return {
    index,
    tileType: TileType.Road,
    zone: Zone.None,
    density: 0,
    variant: 0,
    supplied: SupplyStatus.NotConnected,
    elevation: 0,
  } as TileDiff;
}

function setup(): { scene: THREE.Scene; mesh: BuildingsMesh } {
  const scene = new THREE.Scene();
  const mesh = new BuildingsMesh(scene, SIZE, flatField());
  return { scene, mesh };
}

/** Instance matrices of one kind mesh whose scale is not zero (i.e. drawn parts). */
function drawn(mesh: THREE.InstancedMesh): THREE.Matrix4[] {
  const out: THREE.Matrix4[] = [];
  const m = new THREE.Matrix4();
  const s = new THREE.Vector3();
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, m);
    s.setFromMatrixScale(m);
    if (s.x > 0) out.push(m.clone());
  }
  return out;
}

const CENTRE = 3 * SIZE + 3;

describe('BuildingsMesh', () => {
  it('creates one culling-free instanced mesh per primitive kind plus windows', () => {
    const { scene, mesh } = setup();
    expect(mesh.kindMeshes).toHaveLength(PART_KINDS.length);
    for (const kind of PART_KINDS) {
      const m = mesh.kindMeshes[kind];
      expect(m.frustumCulled).toBe(false);
      expect(m.instanceMatrix.count).toBe(SIZE * SIZE * MAX_PARTS_PER_KIND[kind]);
      expect(scene.children).toContain(m);
    }
    const instanced = scene.children.filter((c) => c instanceof THREE.InstancedMesh);
    expect(instanced).toHaveLength(PART_KINDS.length + 1);
  });

  it('draws exactly the recipe parts of a placed building, grouped by kind', () => {
    const { mesh } = setup();
    mesh.setReducedMotion(true);
    mesh.applyDiffs([building(CENTRE, Zone.Residential, 1, 2)]);
    const parts = mesh.partsAt(CENTRE)!;
    expect(parts.length).toBeGreaterThan(2);
    for (const kind of PART_KINDS) {
      const expected = parts.filter((p) => p.kind === kind).length;
      expect(drawn(mesh.kindMeshes[kind])).toHaveLength(expected);
      expect(mesh.kindMeshes[kind].count).toBe(MAX_PARTS_PER_KIND[kind]);
    }
  });

  it('places parts at full size with reduced motion and at the tile centre', () => {
    const { mesh } = setup();
    mesh.setReducedMotion(true);
    mesh.applyDiffs([building(CENTRE, Zone.Commercial, 1, 0)]);
    const main = mesh.partsAt(CENTRE)!.find((p) => p.main)!;
    const boxes = drawn(mesh.kindMeshes[PartKind.Box]);
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const found = boxes.some((m) => {
      position.setFromMatrixPosition(m);
      scale.setFromMatrixScale(m);
      return (
        Math.abs(scale.x - main.sx) < 1e-6 &&
        Math.abs(scale.y - main.sy) < 1e-6 &&
        Math.abs(position.x - (3 + 0.5 + main.ox)) < 1e-6 &&
        Math.abs(position.z - (3 + 0.5 + main.oz)) < 1e-6
      );
    });
    expect(found).toBe(true);
  });

  it('starts new buildings small and grows them to full size', () => {
    const { mesh } = setup();
    mesh.applyDiffs([building(CENTRE, Zone.Residential, 2, 1)]);
    const main = mesh.partsAt(CENTRE)!.find((p) => p.main)!;
    const scaleOfMain = () => {
      const scale = new THREE.Vector3();
      let best = 0;
      for (const m of drawn(mesh.kindMeshes[PartKind.Box])) {
        scale.setFromMatrixScale(m);
        best = Math.max(best, scale.y);
      }
      return best;
    };
    const before = scaleOfMain();
    expect(before).toBeLessThan(main.sy * 0.2);
    mesh.update(10);
    expect(scaleOfMain()).toBeCloseTo(main.sy, 6);
  });

  it('frees every slot on removal and never leaks across cycles', () => {
    const { mesh } = setup();
    mesh.setReducedMotion(true);
    for (let i = 0; i < 200; i++) {
      mesh.applyDiffs([building(CENTRE, Zone.Retail, 1 + (i % 3), i % 8)]);
      mesh.applyDiffs([empty(CENTRE)]);
    }
    for (const kind of PART_KINDS) {
      expect(mesh.kindMeshes[kind].count).toBe(0);
      expect(drawn(mesh.kindMeshes[kind])).toHaveLength(0);
    }
    expect(mesh.partsAt(CENTRE)).toBeUndefined();
  });

  it('recolours the body on a supply flip without touching matrices', () => {
    const { mesh } = setup();
    mesh.setReducedMotion(true);
    mesh.applyDiffs([building(CENTRE, Zone.Residential, 3, 4)]);
    const boxMesh = mesh.kindMeshes[PartKind.Box];
    const before = drawn(boxMesh);
    const colorBefore = new THREE.Color();
    boxMesh.getColorAt(0, colorBefore);
    mesh.applyDiffs([building(CENTRE, Zone.Residential, 3, 4, SupplyStatus.NotConnected)]);
    const after = drawn(boxMesh);
    expect(after.map((m) => m.toArray())).toEqual(before.map((m) => m.toArray()));
    const colorAfter = new THREE.Color();
    boxMesh.getColorAt(0, colorAfter);
    expect(colorAfter.getHex()).not.toBe(colorBefore.getHex());
  });

  it('turns a house toward a road laid beside it afterwards', () => {
    const { mesh } = setup();
    mesh.setReducedMotion(true);
    mesh.applyDiffs([building(CENTRE, Zone.Residential, 1, 0)]);
    expect(mesh.streetFaceAt(CENTRE)).toBe(StreetFace.South);
    const before = drawn(mesh.kindMeshes[PartKind.Box]).map((m) => m.toArray());
    mesh.applyDiffs([road(CENTRE + 1)]);
    expect(mesh.streetFaceAt(CENTRE)).toBe(StreetFace.East);
    const after = drawn(mesh.kindMeshes[PartKind.Box]).map((m) => m.toArray());
    expect(after).not.toEqual(before);
  });

  it('uses a road that arrives in the same batch as the building', () => {
    const { mesh } = setup();
    mesh.setReducedMotion(true);
    mesh.applyDiffs([building(CENTRE, Zone.Residential, 1, 0), road(CENTRE - SIZE)]);
    expect(mesh.streetFaceAt(CENTRE)).toBe(StreetFace.North);
  });

  it('keeps the window mesh hidden by day and shows it at night', () => {
    const { scene, mesh } = setup();
    mesh.setReducedMotion(true);
    mesh.applyDiffs([building(CENTRE, Zone.Residential, 2, 0)]);
    const windows = scene.children.find(
      (c): c is THREE.InstancedMesh =>
        c instanceof THREE.InstancedMesh && !mesh.kindMeshes.includes(c),
    )!;
    const env = (nightFactor: number) => ({
      nightFactor,
      sunFactor: 1 - nightFactor,
      windFactor: 0,
      stateOfCharge: 0,
      tideLevel: 0,
      demand: { residential: 0, commercial: 0, retail: 0 },
      phase: 0,
      temperature: 15,
      snowCover: 0,
      sunrise: 0.25,
      sunset: 0.75,
      solarStrength: 1,
    });
    mesh.setEnvironment(env(0));
    expect(windows.visible).toBe(false);
    mesh.setEnvironment(env(1));
    expect(windows.visible).toBe(true);
    expect(windows.count).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/render/buildingsMesh.test.ts`
Expected: FAIL — `kindMeshes`, `partsAt`, `streetFaceAt` do not exist.

- [ ] **Step 3: Rewrite `src/render/buildingsMesh.ts`**

Replace the whole file with:

```ts
import * as THREE from 'three';
import type { TileDiff } from '../shared/types.ts';
import { SupplyStatus, TileType, type Zone } from '../shared/types.ts';
import type { DiffLayer, RenderEnvironment } from './renderer.ts';
import type { ElevationField } from './elevationField.ts';
import { PART_KINDS, type PartKind, createPartGeometry } from './buildings/primitives.ts';
import { applySupplyTint } from './buildings/palette.ts';
import {
  type BuildingPart,
  MAX_PARTS_PER_KIND,
  type StreetFace,
  buildingParts,
  mainBody,
  streetFaceFor,
} from './buildings/recipes.ts';
import { BlockAllocator } from './buildings/blocks.ts';

const GROW_ANIMATION_SECONDS = 0.45;
/** Max lit window quads per building. */
const WINDOWS_PER_TILE = 24;
const WINDOW_COLOR = 0xffc978;
const WINDOW_WIDTH = 0.09;
const WINDOW_HEIGHT = 0.11;
const WINDOW_GAP = 0.012;
const QUARTER_TURN = Math.PI / 2;
/** Hidden instances: a zero-scale matrix is never rasterised. */
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

interface TileBuilding {
  zone: Zone;
  density: number;
  variant: number;
  supplied: SupplyStatus;
  face: StreetFace;
  parts: BuildingPart[];
  /** Block per primitive kind (index = PartKind). */
  blocks: number[];
}

interface KindLayer {
  mesh: THREE.InstancedMesh;
  blockSize: number;
  blocks: BlockAllocator;
}

/**
 * All zone buildings as one InstancedMesh per primitive kind with
 * per-instance colours. Each tile owns one fixed-size block of slots per
 * kind, so a change touches only that tile. New/densified buildings scale
 * in with a short animation; doors and awnings face the nearest road.
 */
export class BuildingsMesh implements DiffLayer {
  readonly kindMeshes: readonly THREE.InstancedMesh[];
  private readonly layers: readonly KindLayer[];
  private readonly windowsMesh: THREE.InstancedMesh;
  private readonly windowsMaterial: THREE.MeshBasicMaterial;
  private readonly gridSize: number;
  private readonly roads: Uint8Array;
  private readonly buildings = new Map<number, TileBuilding>();
  private readonly animations = new Map<number, number>(); // tile -> elapsed seconds
  private reducedMotion = false;
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly scale = new THREE.Vector3();
  private readonly color = new THREE.Color();

  constructor(
    scene: THREE.Scene,
    gridSize: number,
    private readonly elevation: ElevationField,
  ) {
    this.gridSize = gridSize;
    this.roads = new Uint8Array(gridSize * gridSize);
    this.layers = PART_KINDS.map((kind) => {
      const blockSize = MAX_PARTS_PER_KIND[kind];
      const mesh = new THREE.InstancedMesh(
        createPartGeometry(kind),
        new THREE.MeshLambertMaterial(),
        gridSize * gridSize * blockSize,
      );
      // Instance transforms live across the whole grid; the base geometry's
      // bounds would wrongly cull the mesh, so culling is disabled.
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.count = 0;
      scene.add(mesh);
      return { mesh, blockSize, blocks: new BlockAllocator(gridSize * gridSize) };
    });
    this.kindMeshes = this.layers.map((layer) => layer.mesh);

    const windowGeometry = new THREE.PlaneGeometry(WINDOW_WIDTH, WINDOW_HEIGHT);
    this.windowsMaterial = new THREE.MeshBasicMaterial({
      color: WINDOW_COLOR,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.windowsMesh = new THREE.InstancedMesh(
      windowGeometry,
      this.windowsMaterial,
      gridSize * gridSize * WINDOWS_PER_TILE,
    );
    this.windowsMesh.frustumCulled = false;
    this.windowsMesh.count = 0;
    this.windowsMesh.visible = false;
    scene.add(this.windowsMesh);
  }

  /** Street face of the building on `index`, for tests and debugging. */
  streetFaceAt(index: number): StreetFace | undefined {
    return this.buildings.get(index)?.face;
  }

  /** Recipe parts of the building on `index`, for tests and debugging. */
  partsAt(index: number): readonly BuildingPart[] | undefined {
    return this.buildings.get(index)?.parts;
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
    if (reduced && this.animations.size > 0) {
      for (const index of this.animations.keys()) this.writeMatrices(index, 1);
      this.animations.clear();
      this.markMatricesDirty();
    }
  }

  /** Warm window lights fade in with the night. */
  setEnvironment(environment: RenderEnvironment): void {
    const opacity = Math.max(0, environment.nightFactor - 0.25) / 0.75;
    this.windowsMaterial.opacity = opacity * 0.95;
    this.windowsMesh.visible = opacity > 0.02;
  }

  applyDiffs(diffs: TileDiff[]): void {
    const reissue = new Set<number>();
    let windowsDirty = false;
    let matricesDirty = false;
    let colorsDirty = false;
    for (const diff of diffs) {
      const isRoad = diff.tileType === TileType.Road ? 1 : 0;
      if (this.roads[diff.index] !== isRoad) {
        this.roads[diff.index] = isRoad;
        for (const n of this.neighbours(diff.index)) if (this.buildings.has(n)) reissue.add(n);
      }
      const hasBuilding = diff.tileType === TileType.Empty && diff.density > 0;
      const existing = this.buildings.get(diff.index);
      if (hasBuilding) {
        if (
          !existing ||
          existing.density !== diff.density ||
          existing.zone !== diff.zone ||
          existing.variant !== diff.variant
        ) {
          this.place(diff.index, diff.zone, diff.density, diff.variant, diff.supplied, true);
          reissue.delete(diff.index);
          windowsDirty = matricesDirty = colorsDirty = true;
        } else if (existing.supplied !== diff.supplied) {
          // Supply flips tint the body and dim the windows; no grow animation.
          existing.supplied = diff.supplied;
          this.writeColors(diff.index);
          windowsDirty = colorsDirty = true;
        }
      } else if (existing) {
        this.remove(diff.index);
        reissue.delete(diff.index);
        windowsDirty = matricesDirty = true;
      }
    }
    for (const index of reissue) {
      const b = this.buildings.get(index)!;
      if (this.streetFace(index) !== b.face) {
        this.place(index, b.zone, b.density, b.variant, b.supplied, false);
        windowsDirty = matricesDirty = colorsDirty = true;
      }
    }
    if (matricesDirty) this.markMatricesDirty();
    if (colorsDirty) this.markColorsDirty();
    if (windowsDirty) this.rebuildWindows();
  }

  update(deltaSeconds: number): void {
    if (this.animations.size === 0) return;
    for (const [index, elapsed] of this.animations) {
      const next = elapsed + deltaSeconds;
      if (next >= GROW_ANIMATION_SECONDS) {
        this.animations.delete(index);
        this.writeMatrices(index, 1);
      } else {
        this.animations.set(index, next);
        // Ease-out cubic for a satisfying pop-in.
        const t = next / GROW_ANIMATION_SECONDS;
        this.writeMatrices(index, 1 - Math.pow(1 - t, 3));
      }
    }
    this.markMatricesDirty();
  }

  private *neighbours(index: number): Generator<number> {
    const x = index % this.gridSize;
    const z = Math.floor(index / this.gridSize);
    if (z + 1 < this.gridSize) yield index + this.gridSize;
    if (x + 1 < this.gridSize) yield index + 1;
    if (x > 0) yield index - 1;
    if (z > 0) yield index - this.gridSize;
  }

  private streetFace(index: number): StreetFace {
    return streetFaceFor(index, this.gridSize, (i) => this.roads[i] === 1);
  }

  /** Create or re-issue the building on `index`; `animate` starts the grow-in. */
  private place(
    index: number,
    zone: Zone,
    density: number,
    variant: number,
    supplied: SupplyStatus,
    animate: boolean,
  ): void {
    const face = this.streetFace(index);
    const parts = buildingParts(zone, density, variant, index, face);
    let building = this.buildings.get(index);
    if (!building) {
      building = {
        zone,
        density,
        variant,
        supplied,
        face,
        parts,
        blocks: this.layers.map((layer) => layer.blocks.alloc()),
      };
      this.buildings.set(index, building);
      this.syncCounts();
    } else {
      building.zone = zone;
      building.density = density;
      building.variant = variant;
      building.supplied = supplied;
      building.face = face;
      building.parts = parts;
    }
    if (animate && !this.reducedMotion) {
      this.animations.set(index, 0);
      this.writeMatrices(index, 0.01);
    } else {
      this.animations.delete(index);
      this.writeMatrices(index, 1);
    }
    this.writeColors(index);
  }

  private remove(index: number): void {
    const building = this.buildings.get(index);
    if (!building) return;
    for (const kind of PART_KINDS) {
      const layer = this.layers[kind];
      const start = building.blocks[kind] * layer.blockSize;
      for (let i = 0; i < layer.blockSize; i++) layer.mesh.setMatrixAt(start + i, HIDDEN);
      layer.blocks.release(building.blocks[kind]);
    }
    this.buildings.delete(index);
    this.animations.delete(index);
    this.syncCounts();
  }

  /** Draw exactly up to the highest block in use per kind. */
  private syncCounts(): void {
    for (const layer of this.layers) layer.mesh.count = layer.blocks.highWater * layer.blockSize;
  }

  private markMatricesDirty(): void {
    for (const layer of this.layers) layer.mesh.instanceMatrix.needsUpdate = true;
  }

  private markColorsDirty(): void {
    for (const layer of this.layers) {
      if (layer.mesh.instanceColor) layer.mesh.instanceColor.needsUpdate = true;
    }
  }

  /** Slot of the i-th part of `kind` within the tile's block for that kind. */
  private slotsOf(building: TileBuilding): Map<PartKind, number> {
    const next = new Map<PartKind, number>();
    for (const kind of PART_KINDS) {
      next.set(kind, building.blocks[kind] * this.layers[kind].blockSize);
    }
    return next;
  }

  private writeMatrices(index: number, growth: number): void {
    const building = this.buildings.get(index);
    if (!building) return;
    const cx = (index % this.gridSize) + 0.5;
    const cz = Math.floor(index / this.gridSize) + 0.5;
    const lift = this.elevation.centerY(index);
    const next = this.slotsOf(building);
    for (const p of building.parts) {
      const slot = next.get(p.kind)!;
      next.set(p.kind, slot + 1);
      this.position.set(cx + p.ox * growth, lift + p.oy * growth, cz + p.oz * growth);
      this.euler.set(p.tilt ?? 0, p.turn * QUARTER_TURN, 0, 'YXZ');
      this.quaternion.setFromEuler(this.euler);
      this.scale.set(p.sx * growth, p.sy * growth, p.sz * growth);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.layers[p.kind].mesh.setMatrixAt(slot, this.matrix);
    }
    // Hide the block's unused slots (a re-issued recipe may have fewer parts).
    for (const kind of PART_KINDS) {
      const layer = this.layers[kind];
      const end = (building.blocks[kind] + 1) * layer.blockSize;
      for (let slot = next.get(kind)!; slot < end; slot++) layer.mesh.setMatrixAt(slot, HIDDEN);
    }
  }

  private writeColors(index: number): void {
    const building = this.buildings.get(index);
    if (!building) return;
    const next = this.slotsOf(building);
    for (const p of building.parts) {
      const slot = next.get(p.kind)!;
      next.set(p.kind, slot + 1);
      const color = p.accent ? p.color : applySupplyTint(p.color, building.supplied, this.color);
      this.layers[p.kind].mesh.setColorAt(slot, color);
    }
  }

  /**
   * Lit window quads on the ±z faces of each building's main body. A
   * deterministic pattern keeps some windows dark for variety. (Task 8
   * moves these onto the street face and its opposite.)
   */
  private rebuildWindows(): void {
    const matrix = new THREE.Matrix4();
    const rotationBack = new THREE.Matrix4().makeRotationY(Math.PI);
    let slot = 0;
    for (const [index, building] of this.buildings) {
      // Buildings without (enough) power stay dark — undersupply flips
      // tick to tick, which reads as flickering at night.
      if (building.supplied !== SupplyStatus.Supplied) continue;
      const main = mainBody(building.parts);
      if (!main) continue;
      const cx = (index % this.gridSize) + 0.5 + main.ox;
      const cz = Math.floor(index / this.gridSize) + 0.5 + main.oz;
      const lift = this.elevation.centerY(index);
      const cols = Math.min(3, Math.max(1, Math.round(main.sx / 0.24)));
      const rows = Math.min(4, Math.max(1, Math.round(main.sy / 0.28)));
      let windowId = 0;
      for (const face of [1, -1]) {
        for (let col = 0; col < cols; col++) {
          for (let row = 0; row < rows; row++) {
            windowId++;
            // Deterministically leave ~1/3 of windows dark.
            if ((index * 7 + windowId * 13 + building.variant) % 3 === 0) continue;
            if (slot >= this.windowsMesh.instanceMatrix.count) break;
            const x = cx + ((col + 0.5) / cols - 0.5) * main.sx * 0.8;
            const y = main.oy + ((row + 0.55) / rows) * main.sy * 0.82 + lift;
            const z = cz + face * (main.sz / 2 + WINDOW_GAP);
            if (face === 1) matrix.identity();
            else matrix.copy(rotationBack);
            matrix.setPosition(x, y, z);
            this.windowsMesh.setMatrixAt(slot++, matrix);
          }
        }
      }
    }
    this.windowsMesh.count = slot;
    this.windowsMesh.instanceMatrix.needsUpdate = true;
  }
}
```

Then in `src/render/renderer.ts`:

- line 13: replace `import { BuildingsMesh, buildingHeight } from './buildingsMesh.ts';` with
  ```ts
  import { BuildingsMesh } from './buildingsMesh.ts';
  import { buildingHeight } from './buildings/recipes.ts';
  ```
- line 103: replace `return buildingHeight(diff.zone, diff.density, diff.variant);` with
  `return buildingHeight(diff.zone, diff.density, diff.variant, diff.index);`

- [ ] **Step 4: Run the tests and the typecheck**

Run: `pnpm vitest run src/render && pnpm typecheck`
Expected: PASS for all render tests; typecheck clean (the old
`buildingParts(zone, density, variant)` signature has no other callers —
confirm with `grep -rn "buildingParts\|buildingHeight" src --include=*.ts`).

- [ ] **Step 5: Format, lint, full tests and commit**

```bash
pnpm format && pnpm lint && pnpm test
git add src/render/buildingsMesh.ts src/render/buildingsMesh.test.ts src/render/renderer.ts
git commit -m "feat(render): compose buildings from the primitive kit

One InstancedMesh per primitive kind, fixed slot blocks per tile and
kind with a free list, doors and awnings toward the nearest road, a
gentle supply tint on walls and roofs, and the grow animation across
all parts.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Windows on the street face and shopfronts

**Files:**

- Modify: `src/render/buildingsMesh.ts` (`rebuildWindows`)
- Modify: `src/render/buildingsMesh.test.ts` (two new tests)

**Interfaces:**

- Consumes: `faceOffset`, `faceWidth`, `faceDepth` (Task 3), `TileBuilding.face`.
- Produces: windows on the street face and its opposite; retail density
  1 and 2 get one wide shopfront quad on the street face. The window
  mesh's instance count per building is at most `WINDOWS_PER_TILE` (24).

- [ ] **Step 1: Write the failing tests**

Add to `buildingsMesh.test.ts` (inside the `describe`):

```ts
it('puts windows on the street face and its opposite, never on the side faces', () => {
  const { scene, mesh } = setup();
  mesh.setReducedMotion(true);
  mesh.applyDiffs([building(CENTRE, Zone.Residential, 3, 0), road(CENTRE + 1)]);
  expect(mesh.streetFaceAt(CENTRE)).toBe(StreetFace.East);
  const main = mesh.partsAt(CENTRE)!.find((p) => p.main)!;
  const windows = scene.children.find(
    (c): c is THREE.InstancedMesh =>
      c instanceof THREE.InstancedMesh && !mesh.kindMeshes.includes(c),
  )!;
  expect(windows.count).toBeGreaterThan(0);
  expect(windows.count).toBeLessThanOrEqual(24);
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const cx = 3 + 0.5 + main.ox;
  const cz = 3 + 0.5 + main.oz;
  for (let i = 0; i < windows.count; i++) {
    windows.getMatrixAt(i, m);
    p.setFromMatrixPosition(m);
    // East/west faces: x is pushed past the body's half width, z stays inside it.
    expect(Math.abs(p.x - cx)).toBeGreaterThan(main.sx / 2);
    expect(Math.abs(p.z - cz)).toBeLessThan(main.sz / 2);
  }
});

it('gives a shop one wide shopfront quad on the street face', () => {
  const { scene, mesh } = setup();
  mesh.setReducedMotion(true);
  mesh.applyDiffs([building(CENTRE, Zone.Retail, 1, 0), road(CENTRE + SIZE)]);
  const main = mesh.partsAt(CENTRE)!.find((p) => p.main)!;
  const windows = scene.children.find(
    (c): c is THREE.InstancedMesh =>
      c instanceof THREE.InstancedMesh && !mesh.kindMeshes.includes(c),
  )!;
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const cz = 3 + 0.5 + main.oz;
  const wide: THREE.Vector3[] = [];
  for (let i = 0; i < windows.count; i++) {
    windows.getMatrixAt(i, m);
    p.setFromMatrixPosition(m);
    s.setFromMatrixScale(m);
    if (p.z > cz) wide.push(s.clone()); // street (south) face
  }
  expect(wide).toHaveLength(1);
  // Scaled from the 0.09 × 0.11 quad to ~80 % of the facade width.
  expect(wide[0].x * 0.09).toBeCloseTo(main.sx * 0.8, 6);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/render/buildingsMesh.test.ts`
Expected: FAIL — windows still sit on ±z, and the shop has a grid.

- [ ] **Step 3: Rework `rebuildWindows`**

Add `faceDepth, faceOffset, faceWidth` to the import from
`./buildings/recipes.ts` and change the `type Zone` import from
`../shared/types.ts` into a value import (`Zone` is now compared at
runtime), then replace `rebuildWindows` with:

```ts
  /**
   * Lit window quads on the street face and its opposite of each
   * building's main body. Shops get one wide shopfront on the street
   * face. A deterministic pattern keeps ~1/3 of the windows dark.
   */
  private rebuildWindows(): void {
    const matrix = new THREE.Matrix4();
    const rotation = new THREE.Matrix4();
    let slot = 0;
    for (const [index, building] of this.buildings) {
      // Buildings without (enough) power stay dark — undersupply flips
      // tick to tick, which reads as flickering at night.
      if (building.supplied !== SupplyStatus.Supplied) continue;
      const main = mainBody(building.parts);
      if (!main) continue;
      const cx = (index % this.gridSize) + 0.5 + main.ox;
      const cz = Math.floor(index / this.gridSize) + 0.5 + main.oz;
      const lift = this.elevation.centerY(index);
      const shopfront = building.zone === Zone.Retail && building.density < 3;
      const budgetEnd = Math.min(slot + WINDOWS_PER_TILE, this.windowsMesh.instanceMatrix.count);
      let windowId = 0;
      for (const [face, isStreet] of [
        [building.face, true],
        [((building.face + 2) % 4) as StreetFace, false],
      ] as const) {
        const width = faceWidth(main, face);
        const depth = faceDepth(main, face);
        rotation.makeRotationY(face * QUARTER_TURN);
        if (isStreet && shopfront) {
          if (slot >= budgetEnd) break;
          const [dx, dz] = faceOffset(0, depth / 2 + WINDOW_GAP, face);
          matrix.copy(rotation);
          matrix.scale(new THREE.Vector3((width * 0.8) / WINDOW_WIDTH, (main.sy * 0.5) / WINDOW_HEIGHT, 1));
          matrix.setPosition(cx + dx, lift + main.oy + main.sy * 0.45, cz + dz);
          this.windowsMesh.setMatrixAt(slot++, matrix);
          continue;
        }
        const cols = Math.min(3, Math.max(1, Math.round(width / 0.24)));
        const rows = Math.min(4, Math.max(1, Math.round(main.sy / 0.28)));
        for (let col = 0; col < cols; col++) {
          for (let row = 0; row < rows; row++) {
            windowId++;
            // Deterministically leave ~1/3 of windows dark.
            if ((index * 7 + windowId * 13 + building.variant) % 3 === 0) continue;
            if (slot >= budgetEnd) break;
            const lx = ((col + 0.5) / cols - 0.5) * width * 0.8;
            const [dx, dz] = faceOffset(lx, depth / 2 + WINDOW_GAP, face);
            const y = lift + main.oy + ((row + 0.55) / rows) * main.sy * 0.82;
            matrix.copy(rotation);
            matrix.setPosition(cx + dx, y, cz + dz);
            this.windowsMesh.setMatrixAt(slot++, matrix);
          }
        }
      }
    }
    this.windowsMesh.count = slot;
    this.windowsMesh.instanceMatrix.needsUpdate = true;
  }
```

Note `matrix.scale(v)` post-multiplies by a scale matrix, so with the
rotation already in place the quad is scaled in its own (rotated) frame,
which is what a wide facade quad needs. Remove the now-unused
`rotationBack` variable and the stale "(Task 8 …)" comment.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/render`
Expected: PASS.

- [ ] **Step 5: Format, lint, full tests and commit**

```bash
pnpm format && pnpm lint && pnpm test
git add src/render/buildingsMesh.ts src/render/buildingsMesh.test.ts
git commit -m "feat(render): light windows on the street face and shopfronts

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Docs, smoke test and final verification

**Files:**

- Modify: `docs/plan.md:77` (module map entry) and `:177` (milestone note)
- Verify: `node scripts/smoke.mjs`, `pnpm build`

**Interfaces:** none new.

- [ ] **Step 1: Update the module map**

In `docs/plan.md` replace line 77

```
    buildingsMesh.ts # instanced procedural low-poly buildings
```

with

```
    buildingsMesh.ts # one InstancedMesh per primitive kind, slot blocks per tile, windows
    buildings/       # recipes (zone/density/variant/tile → parts), palette, primitives, blocks
```

and replace line 177

```
- [x] `render/buildingsMesh.ts`: procedural low-poly buildings (box compositions per zone/density/variant), scale-in animation
```

with

```
- [x] `render/buildingsMesh.ts` + `render/buildings/`: procedural low-poly buildings from a primitive kit (boxes, gable and hip roofs, cylinders) with per-zone colour families, street-facing doors and awnings, supply tint, scale-in animation
```

- [ ] **Step 2: Run the headless smoke test and the production build**

Run: `node scripts/smoke.mjs && pnpm build`
Expected: smoke passes (the app falls back without WebGL here) and the
build completes with no type errors.

- [ ] **Step 3: Run the full gate**

Run: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add docs/plan.md
git commit -m "docs(plan): describe the building primitive kit in the module map

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 5: Hand over for the Mac visual pass**

Report to the user what to look at on the Mac: three densities per zone
on a fresh city (roof variety, chimneys, dormers, balconies, awnings and
signs facing the road), the night view (windows on the street face,
shopfronts), the supply tint next to the Supply overlay on an
unconnected block, and frame time on a full 64×64 map with shadows on.
Do not push until the user confirms.
