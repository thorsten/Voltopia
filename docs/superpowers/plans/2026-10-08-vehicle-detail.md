# Vehicle Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detailed vertex-coloured vehicle models (four car styles, van, bus, locomotive, four wagon types), stable per-id colours, night tail lights, and trains of three or four wagons that follow the track through curves and departures.

**Architecture:** Pure geometry builders (`src/render/vehicles/models.ts`) merge small boxes that carry vertex colours (white body tinted by the instance colour, fixed dark glass/tyres/trim); a pure selector (`src/render/vehicles/variety.ts`) maps ids to car style, paint and freight body; `vehiclesMesh.ts` keeps one `InstancedMesh` per model plus head- and tail-light meshes placed at each model's front and rear. In the sim, each train keeps a transient trail of the tile centres it reached; `trailingPoint` walks that trail and the engine emits n wagons per train.

**Tech Stack:** TypeScript strict, three.js 0.186, vitest (node, no WebGL), pnpm.

**Spec:** `docs/superpowers/specs/2026-10-08-vehicle-detail-design.md`

## Global Constraints

- Render-only except the train trail and wagon emission (`src/sim/trains.ts`, `src/sim/state.ts`, `src/sim/engine.ts`, `BALANCE.rail`); the trail is never saved (`SavedTrain` unchanged) and gameplay is unchanged.
- Every model keeps the outer dimensions in the spec's table (± 0.005) and ≤ `MAX_PARTS_PER_MODEL = 16` parts; vehicles point along +x with the bottom of the tyres at y = 0.
- Body parts are vertex colour `0xffffff` (tinted by the instance colour); details carry fixed colours from named constants.
- All new `InstancedMesh`es: `frustumCulled = false`, `surfaceMaterial({ vertexColors: true })` for lit models (from `src/render/materials.ts`); light meshes stay `MeshBasicMaterial`.
- No magic numbers: named, commented constants. `BALANCE.rail.passengerWagons = 3`, `BALANCE.rail.freightWagons = 4`.
- `stepTick` cost must not rise measurably (see the tick-cost probe in Task 3).
- Tests: vitest node environment, no WebGL; no `node:` imports in `src` tests.
- `pnpm format` after edits; pre-commit hook (`typecheck && lint && format:check && test`) must pass; never `--no-verify`. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Branch `feature/vehicle-detail` in this checkout.

---

### Task 0: Branch

- [ ] `git checkout -b feature/vehicle-detail`

---

### Task 1: Model builders and variety selection

**Files:**

- Create: `src/render/vehicles/models.ts`, `src/render/vehicles/models.test.ts`, `src/render/vehicles/variety.ts`, `src/render/vehicles/variety.test.ts`

**Interfaces:**

- Produces (models.ts): `MAX_PARTS_PER_MODEL = 16`; colour constants `BODY, GLASS, TYRE, TRIM, LENS_FRONT, LENS_REAR, PANTOGRAPH, VAN_STRIPE`; `LOCOMOTIVE_LENGTH = 0.52`, `WAGON_LENGTH = 0.5` (moved here from `vehiclesMesh.ts`); `interface VehicleModel { geometry: THREE.BufferGeometry; parts: number; length: number }`; builders `hatchbackModel(), sedanModel(), estateModel(), suvModel(), vanModel(), busModel(), locomotiveModel(), passengerWagonModel(), containerWagonModel(), hopperWagonModel(), tankWagonModel()` each returning `VehicleModel`.
- Produces (variety.ts): `type CarStyle = 'hatchback' | 'sedan' | 'estate' | 'suv'`; `CAR_STYLES: readonly CarStyle[]`; `type FreightBody = 'container' | 'hopper' | 'tank'`; `FREIGHT_BODIES`; `CAR_COLORS: readonly number[]` (10 paints); `CONTAINER_COLORS: readonly number[]`; `vehicleHash(id: number): number`; `carStyleOf(id)`, `carColorOf(id)`, `freightBodyOf(id)`, `containerColorOf(id)`.

- [ ] **Step 1: Failing tests** — `src/render/vehicles/models.test.ts`:

```ts
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
```

`src/render/vehicles/variety.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  CAR_COLORS,
  CAR_STYLES,
  carColorOf,
  carStyleOf,
  containerColorOf,
  FREIGHT_BODIES,
  freightBodyOf,
  vehicleHash,
} from './variety.ts';

describe('vehicle variety', () => {
  it('is stable per id', () => {
    for (const id of [1, 42, 99_999, 3 * 2 ** 30 + 17]) {
      expect(carStyleOf(id)).toBe(carStyleOf(id));
      expect(carColorOf(id)).toBe(carColorOf(id));
      expect(freightBodyOf(id)).toBe(freightBodyOf(id));
      expect(containerColorOf(id)).toBe(containerColorOf(id));
      expect(Number.isInteger(vehicleHash(id))).toBe(true);
      expect(vehicleHash(id)).toBeGreaterThanOrEqual(0);
    }
  });

  it('spreads styles, bodies and paints over consecutive ids', () => {
    const styles = new Map<string, number>();
    const bodies = new Map<string, number>();
    const paints = new Set<number>();
    for (let id = 1; id <= 1000; id++) {
      styles.set(carStyleOf(id), (styles.get(carStyleOf(id)) ?? 0) + 1);
      bodies.set(freightBodyOf(id), (bodies.get(freightBodyOf(id)) ?? 0) + 1);
      paints.add(carColorOf(id));
    }
    for (const s of CAR_STYLES) expect(styles.get(s) ?? 0).toBeGreaterThanOrEqual(150);
    for (const b of FREIGHT_BODIES) expect(bodies.get(b) ?? 0).toBeGreaterThanOrEqual(150);
    expect(paints.size).toBe(CAR_COLORS.length);
  });

  it('wagons of one train (ids k * 2^30 + trainId) get different bodies often', () => {
    let differing = 0;
    for (let train = 1; train <= 200; train++) {
      const set = new Set([1, 2, 3, 4].map((k) => freightBodyOf(train + k * 2 ** 30)));
      if (set.size > 1) differing++;
    }
    expect(differing).toBeGreaterThan(150);
  });
});
```

- [ ] **Step 2:** `pnpm vitest run src/render/vehicles` — Expected: FAIL (modules missing).

- [ ] **Step 3: `src/render/vehicles/variety.ts`**

```ts
export type CarStyle = 'hatchback' | 'sedan' | 'estate' | 'suv';
export const CAR_STYLES: readonly CarStyle[] = ['hatchback', 'sedan', 'estate', 'suv'];
export type FreightBody = 'container' | 'hopper' | 'tank';
export const FREIGHT_BODIES: readonly FreightBody[] = ['container', 'hopper', 'tank'];

/** Paints, muted to sit with the city palette: whites, greys, blues, a red, a green, a sand. */
export const CAR_COLORS: readonly number[] = [
  0xe8e6e0, 0xc9ccd1, 0x707a86, 0x3a4048, 0x8fb3c9, 0x3f6f9e, 0xc9584a, 0x9aa88f, 0xd9a066,
  0xc9788f,
];
export const CONTAINER_COLORS: readonly number[] = [0xc9584a, 0x3f6f9e, 0x5f8f5a, 0xd9a441];

/**
 * Deterministic 32-bit integer hash (a murmur3 finaliser). Works on ids
 * above 2^32 (wagon ids are train id + k · 2^30) by folding the high part.
 */
export function vehicleHash(id: number): number {
  let h = (id >>> 0) ^ Math.floor(id / 4294967296);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Different bits for each choice, so style and paint are independent. */
const pick = <T>(list: readonly T[], id: number, salt: number): T =>
  list[vehicleHash(id ^ salt) % list.length];

export const carStyleOf = (id: number): CarStyle => pick(CAR_STYLES, id, 0x51);
export const carColorOf = (id: number): number => pick(CAR_COLORS, id, 0xa3);
export const freightBodyOf = (id: number): FreightBody => pick(FREIGHT_BODIES, id, 0x5c);
export const containerColorOf = (id: number): number => pick(CONTAINER_COLORS, id, 0x2e);
```

(`id ^ salt` on ids above 2^31 loses the high part: use `vehicleHash(id) ^ salt` hashed again instead if the distribution test fails — i.e. `vehicleHash(vehicleHash(id) ^ salt)`. Keep whichever passes; both are deterministic.)

- [ ] **Step 4: `src/render/vehicles/models.ts`**

```ts
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** Upper bound on boxes per model, so 220 cars stay cheap. */
export const MAX_PARTS_PER_MODEL = 16;

/** Vertex colours. BODY is white so the instance colour paints it; the rest are fixed. */
export const BODY = 0xffffff;
export const GLASS = 0x2b3440;
export const TYRE = 0x1f2224;
export const TRIM = 0x5a5f66;
export const LENS_FRONT = 0xf4f0d8;
export const LENS_REAR = 0xb03030;
export const PANTOGRAPH = 0x2b2f33;
/** Livery band on delivery vans (the van body itself is white). */
export const VAN_STRIPE = 0x3f8fd6;

/**
 * Drawn body lengths in tiles. BALANCE.rail.wagonGap (sim) is measured
 * centre to centre; vehiclesMesh.test.ts holds the two in step.
 */
export const LOCOMOTIVE_LENGTH = 0.52;
export const WAGON_LENGTH = 0.5;

export interface VehicleModel {
  geometry: THREE.BufferGeometry;
  /** Number of merged parts (≤ MAX_PARTS_PER_MODEL). */
  parts: number;
  /** Length along +x in tiles: places head and tail lights. */
  length: number;
}

const scratch = new THREE.Color();

/** A box of size (w along x, h, d along z) centred at (x, y, z) with one vertex colour. */
function part(
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  color: number,
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  scratch.setHex(color);
  const n = g.getAttribute('position').count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) colors.set([scratch.r, scratch.g, scratch.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

/** A cylinder along x (radius r, length l) centred at (x, y, z), for tank wagons. */
function tube(
  r: number,
  l: number,
  x: number,
  y: number,
  z: number,
  color: number,
): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, l, TUBE_SEGMENTS);
  g.rotateZ(Math.PI / 2);
  g.translate(x, y, z);
  scratch.setHex(color);
  const n = g.getAttribute('position').count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) colors.set([scratch.r, scratch.g, scratch.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}
const TUBE_SEGMENTS = 8;

function model(parts: THREE.BufferGeometry[], length: number): VehicleModel {
  const geometry = mergeGeometries(parts);
  if (!geometry) throw new Error('vehicle model: parts do not merge');
  return { geometry, parts: parts.length, length };
}

/** Tyre size and ride height shared by road vehicles. */
const TYRE_LENGTH = 0.06;
const TYRE_HEIGHT = 0.05;
const TYRE_DEPTH = 0.02;
const SILL = 0.03; // body bottom: the tyres stick out below it
const LENS = { w: 0.004, h: 0.012, d: 0.025 } as const;

function tyres(length: number, width: number, axleInset: number): THREE.BufferGeometry[] {
  const ax = length / 2 - axleInset;
  const z = width / 2 - TYRE_DEPTH / 2;
  const out: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1])
    for (const sz of [-1, 1])
      out.push(part(TYRE_LENGTH, TYRE_HEIGHT, TYRE_DEPTH, sx * ax, TYRE_HEIGHT / 2, sz * z, TYRE));
  return out;
}

function lenses(length: number, width: number, y: number): THREE.BufferGeometry[] {
  const x = length / 2 - LENS.w / 2;
  const z = width / 2 - 0.03;
  return [
    part(LENS.w, LENS.h, LENS.d, x, y, z, LENS_FRONT),
    part(LENS.w, LENS.h, LENS.d, x, y, -z, LENS_FRONT),
    part(LENS.w, LENS.h, LENS.d, -x, y, z, LENS_REAR),
    part(LENS.w, LENS.h, LENS.d, -x, y, -z, LENS_REAR),
  ];
}

/** One parametric car: lower body, cabin with a glass band, tyres, bumpers, lenses, optional roof rails. */
function car(p: {
  length: number;
  width: number;
  bodyH: number;
  cabinH: number;
  cabinL: number;
  cabinX: number;
  rails?: boolean;
}): VehicleModel {
  const bodyW = p.width - 0.01;
  const bodyY = SILL + p.bodyH / 2;
  const cabinBottom = SILL + p.bodyH;
  const cabinY = cabinBottom + p.cabinH / 2;
  const railH = p.rails ? 0.005 : 0;
  const parts = [
    part(p.length - 0.02, p.bodyH, bodyW, 0, bodyY, 0, BODY),
    part(
      p.cabinL,
      p.cabinH - railH,
      bodyW - 0.01,
      p.cabinX,
      cabinBottom + (p.cabinH - railH) / 2,
      0,
      BODY,
    ),
    part(
      p.cabinL + 0.002,
      (p.cabinH - railH) * 0.6,
      bodyW - 0.008,
      p.cabinX,
      cabinY - railH / 2,
      0,
      GLASS,
    ),
    ...tyres(p.length, p.width, 0.06),
    part(0.01, 0.02, bodyW, p.length / 2 - 0.005, SILL + 0.01, 0, TRIM),
    part(0.01, 0.02, bodyW, -p.length / 2 + 0.005, SILL + 0.01, 0, TRIM),
    ...lenses(p.length, bodyW, bodyY),
  ];
  if (p.rails) {
    for (const s of [-1, 1])
      parts.push(
        part(
          p.cabinL * 0.9,
          railH,
          0.005,
          p.cabinX,
          SILL + p.bodyH + p.cabinH - railH / 2,
          s * (bodyW / 2 - 0.02),
          TRIM,
        ),
      );
  }
  return model(parts, p.length);
}

export const hatchbackModel = (): VehicleModel =>
  car({ length: 0.26, width: 0.14, bodyH: 0.05, cabinH: 0.05, cabinL: 0.14, cabinX: -0.03 });
export const sedanModel = (): VehicleModel =>
  car({ length: 0.3, width: 0.14, bodyH: 0.05, cabinH: 0.05, cabinL: 0.15, cabinX: -0.01 });
export const estateModel = (): VehicleModel =>
  car({ length: 0.3, width: 0.14, bodyH: 0.05, cabinH: 0.06, cabinL: 0.2, cabinX: -0.04 });
export const suvModel = (): VehicleModel =>
  car({
    length: 0.3,
    width: 0.15,
    bodyH: 0.07,
    cabinH: 0.06,
    cabinL: 0.19,
    cabinX: -0.04,
    rails: true,
  });
```

Note the bumpers sit inside the body length (`length - 0.02` body plus 0.01 bumpers at each end), so the bounding box is exactly `length`. Continue with the van, bus and rail models in the same file, keeping the table's dimensions:

```ts
export function vanModel(): VehicleModel {
  const L = 0.34,
    W = 0.15,
    H = 0.18;
  const bodyW = W - 0.004;
  return model(
    [
      // Box body from the rear to just behind the cab, full height.
      part(0.23, H - SILL, bodyW, -L / 2 + 0.115, SILL + (H - SILL) / 2, 0, BODY),
      // Lip around the top edge of the box.
      part(0.232, 0.01, W, -L / 2 + 0.115, H - 0.005, 0, TRIM),
      // Livery stripe along both sides.
      part(0.232, 0.02, W, -L / 2 + 0.115, SILL + 0.06, 0, VAN_STRIPE),
      // Cab at the front, lower than the box, with a windscreen.
      part(0.11, 0.11, bodyW, L / 2 - 0.055, SILL + 0.055, 0, BODY),
      part(0.004, 0.04, bodyW - 0.02, L / 2 - 0.002, SILL + 0.085, 0, GLASS),
      ...tyres(L, W, 0.07),
      ...lenses(L, bodyW, SILL + 0.03),
    ],
    L,
  );
}

export function busModel(): VehicleModel {
  const L = 0.4,
    W = 0.16,
    top = 0.18;
  const bodyW = W - 0.008;
  return model(
    [
      part(L, top - SILL, bodyW, 0, SILL + (top - SILL) / 2, 0, BODY),
      // Window band along both sides, slightly proud of the body.
      part(L - 0.04, 0.05, W, 0, top - 0.05, 0, GLASS),
      // Windscreen.
      part(0.004, 0.07, bodyW - 0.02, L / 2 - 0.002 + 0.002, top - 0.06, 0, GLASS),
      // Two door marks below the window band, on the right-hand side and mirrored.
      part(0.04, 0.065, W, 0.12, SILL + 0.0425, 0, TRIM),
      part(0.04, 0.065, W, -0.03, SILL + 0.0425, 0, TRIM),
      // Battery packs on the roof.
      part(0.12, 0.02, 0.1, 0.08, top + 0.01, 0, TRIM),
      part(0.12, 0.02, 0.1, -0.08, top + 0.01, 0, TRIM),
      ...tyres(L, W, 0.07),
      ...lenses(L, bodyW, SILL + 0.03),
    ],
    L,
  );
}

const BOGIE = { l: 0.14, h: 0.04, d: 0.14 } as const;
function bogies(length: number): THREE.BufferGeometry[] {
  const x = length / 2 - 0.11;
  return [
    part(BOGIE.l, BOGIE.h, BOGIE.d, x, BOGIE.h / 2, 0, TYRE),
    part(BOGIE.l, BOGIE.h, BOGIE.d, -x, BOGIE.h / 2, 0, TYRE),
  ];
}

export function locomotiveModel(): VehicleModel {
  const L = LOCOMOTIVE_LENGTH,
    W = 0.18,
    bodyTop = 0.21;
  const bodyW = W - 0.01;
  return model(
    [
      ...bogies(L),
      part(L, bodyTop - BOGIE.h, bodyW, 0, BOGIE.h + (bodyTop - BOGIE.h) / 2, 0, BODY),
      // Cab windows: windscreens at both ends, a side band at the front cab.
      part(0.004, 0.05, bodyW - 0.02, L / 2 - 0.002, 0.17, 0, GLASS),
      part(0.004, 0.05, bodyW - 0.02, -L / 2 + 0.002, 0.17, 0, GLASS),
      part(0.08, 0.04, W, L / 2 - 0.06, 0.17, 0, GLASS),
      // Roof and pantograph (base, mast, contact bar).
      part(L - 0.04, 0.02, 0.15, 0, bodyTop + 0.01, 0, TRIM),
      part(0.06, 0.01, 0.06, 0, bodyTop + 0.025, 0, PANTOGRAPH),
      part(0.01, 0.055, 0.01, 0, bodyTop + 0.0575, 0, PANTOGRAPH),
      part(0.01, 0.01, 0.14, 0, 0.295, 0, PANTOGRAPH),
      ...lenses(L, bodyW, 0.09),
    ],
    L,
  );
}

const DECK_TOP = 0.07;
function deck(): THREE.BufferGeometry {
  return part(
    WAGON_LENGTH,
    DECK_TOP - BOGIE.h,
    0.16,
    0,
    BOGIE.h + (DECK_TOP - BOGIE.h) / 2,
    0,
    TRIM,
  );
}

export function passengerWagonModel(): VehicleModel {
  const L = WAGON_LENGTH,
    W = 0.17;
  return model(
    [
      ...bogies(L),
      part(L, 0.15, W - 0.004, 0, BOGIE.h + 0.075, 0, BODY),
      part(L - 0.06, 0.045, W, 0, 0.14, 0, GLASS),
      part(L - 0.02, 0.01, 0.15, 0, 0.195, 0, TRIM),
    ],
    L,
  );
}

export function containerWagonModel(): VehicleModel {
  return model(
    [...bogies(WAGON_LENGTH), deck(), part(0.44, 0.14, 0.15, 0, DECK_TOP + 0.07, 0, BODY)],
    WAGON_LENGTH,
  );
}

export function hopperWagonModel(): VehicleModel {
  return model(
    [
      ...bogies(WAGON_LENGTH),
      deck(),
      part(0.44, 0.13, 0.16, 0, DECK_TOP + 0.065, 0, BODY),
      part(0.4, 0.01, 0.14, 0, DECK_TOP + 0.135, 0, TRIM),
    ],
    WAGON_LENGTH,
  );
}

export function tankWagonModel(): VehicleModel {
  return model(
    [
      ...bogies(WAGON_LENGTH),
      deck(),
      tube(0.07, 0.44, 0, DECK_TOP + 0.07, 0, BODY),
      part(0.04, 0.01, 0.04, 0, DECK_TOP + 0.145, 0, TRIM),
    ],
    WAGON_LENGTH,
  );
}
```

`mergeGeometries` needs identical attribute sets: `BoxGeometry` and `CylinderGeometry` both have `position`, `normal`, `uv` and an index, plus our `color` — they merge. If the bus windscreen line `L / 2 - 0.002 + 0.002` pushes past the body length check, use `L / 2 - 0.002`. After `pnpm format` the compact literals will re-flow; keep the numbers. Any builder whose test fails on a dimension: adjust that part's size/offset (not the test's table) so the bounding box matches the spec.

- [ ] **Step 5:** `pnpm vitest run src/render/vehicles` — Expected: PASS. `pnpm typecheck`.

- [ ] **Step 6: Commit**

```bash
pnpm format
git add src/render/vehicles
git commit -m "feat(render): detailed vertex-coloured vehicle models and id-based variety

Eleven merged low-poly models (four car styles, van, bus, locomotive with
pantograph, passenger, container, hopper and tank wagons) with fixed
colours for glass, tyres, trim and lenses and a white body for the
instance colour, plus a deterministic id hash choosing car style, paint
and freight body.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Renderer — one mesh per model, stable colours, head and tail lights

**Files:**

- Modify: `src/render/vehiclesMesh.ts`, `src/render/vehiclesMesh.test.ts`

**Interfaces:**

- Consumes: everything Task 1 produces. This task also **adds** `BALANCE.rail.passengerWagons = 3` and `BALANCE.rail.freightWagons = 4` (Task 3 uses them too); the renderer reads them through a small helper `wagonsPerTrain(kind: VehicleKind): number` in `vehiclesMesh.ts` to find the last wagon.
- Produces: `VehiclesMesh.modelMeshes(): ReadonlyMap<ModelKey, THREE.InstancedMesh>` (read-only accessor for tests), `type ModelKey = CarStyle | 'van' | 'bus' | 'locomotive' | 'passengerWagon' | FreightBody`; `LOCOMOTIVE_LENGTH`/`WAGON_LENGTH` re-exported from `vehiclesMesh.ts` (existing test imports them from there).

- [ ] **Step 1: Failing tests** — append to `src/render/vehiclesMesh.test.ts` (the file has `field(levelOf)`, `SIZE = 8`, imports `VehicleKind`, `Terrain`, `WAGON_ID_OFFSET`):

```ts
describe('vehicle models and colours', () => {
  function meshFor(): { scene: THREE.Scene; mesh: VehiclesMesh } {
    const scene = new THREE.Scene();
    return {
      scene,
      mesh: new VehiclesMesh(
        scene,
        field(() => 0),
        () => Terrain.Land,
      ),
    };
  }
  const car = (id: number, x = 2.5): VehicleState => ({
    id,
    x,
    y: 2.5,
    angle: 0,
    kind: VehicleKind.Car,
  });

  it('draws each car in the mesh its id selects', () => {
    const { mesh } = meshFor();
    const cars = [1, 2, 3, 4, 5, 6, 7, 8].map((id) => car(id, 1 + id * 0.5));
    mesh.setVehicles(cars, 1);
    mesh.update(10);
    const counts = new Map<string, number>();
    for (const c of cars) counts.set(carStyleOf(c.id), (counts.get(carStyleOf(c.id)) ?? 0) + 1);
    for (const style of CAR_STYLES) {
      expect(mesh.modelMeshes().get(style)!.count).toBe(counts.get(style) ?? 0);
    }
  });

  it('keeps a car its colour when other cars appear or disappear', () => {
    const { mesh } = meshFor();
    const colorOf = (id: number): number => {
      const m = mesh.modelMeshes().get(carStyleOf(id))!;
      const c = new THREE.Color();
      for (let i = 0; i < m.count; i++) {
        m.getColorAt(i, c);
        if (c.getHex() === carColorOf(id)) return c.getHex();
      }
      return -1;
    };
    mesh.setVehicles([car(7)], 1);
    mesh.update(10);
    expect(colorOf(7)).toBe(carColorOf(7));
    mesh.setVehicles([car(3, 1.5), car(5, 4.5), car(7)], 2);
    mesh.update(11);
    expect(colorOf(7)).toBe(carColorOf(7));
  });

  it('puts tail lights on road vehicles and on the last wagon only, fading with night', () => {
    const { scene, mesh } = meshFor();
    const train = 9;
    const vehicles: VehicleState[] = [
      car(1),
      { id: 2, x: 4.5, y: 2.5, angle: 0, kind: VehicleKind.Bus },
      { id: train, x: 6.5, y: 5.5, angle: 0, kind: VehicleKind.Locomotive },
      ...[1, 2, 3].map((k) => ({
        id: train + k * WAGON_ID_OFFSET,
        x: 6.5 - 0.55 * k,
        y: 5.5,
        angle: 0,
        kind: VehicleKind.Wagon,
      })),
    ];
    mesh.setVehicles(vehicles, 1);
    mesh.update(10);
    const tail = scene.children.find(
      (c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh && c.name === 'tailLights',
    )!;
    expect(tail.count).toBe(3); // car, bus, last wagon
    const material = tail.material as THREE.MeshBasicMaterial;
    mesh.setEnvironment({ nightFactor: 0 } as never);
    expect(material.opacity).toBe(0);
    mesh.setEnvironment({ nightFactor: 1 } as never);
    expect(material.opacity).toBeCloseTo(1, 6);
  });
});
```

Imports to add: `CAR_STYLES, carColorOf, carStyleOf` from `./vehicles/variety.ts`, `type VehicleState` from `../shared/types.ts`. Existing tests that find "the car mesh" via `count === 1` or check headlight counts: update them to the new layout (headlights: road vehicles + locomotives; use `name === 'headlights'`).

- [ ] **Step 2:** `pnpm vitest run src/render/vehiclesMesh.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implementation** in `src/render/vehiclesMesh.ts`:

- Delete `createCarGeometry`, `createVanGeometry`, `createBusGeometry`, `createLocomotiveGeometry`, `createWagonGeometry`, the old colour constants and `LOCOMOTIVE_LENGTH`/`WAGON_LENGTH` definitions; `export { LOCOMOTIVE_LENGTH, WAGON_LENGTH } from './vehicles/models.ts';`.
- Constants: `MAX_CARS_PER_STYLE = 256` (the sim caps cars at 220, so one style can hold them all), `MAX_VANS = 64`, `MAX_BUSES = 64`, `MAX_TRAINS = 64`, `MAX_WAGONS = MAX_TRAINS * 4`; fixed instance colours `VAN_COLOR = 0xf2f2ef`, `BUS_COLOR = 0x3f8fd6`, `PASSENGER_TRAIN_COLOR = 0xd84a3a`, `FREIGHT_TRAIN_COLOR = 0x4f6b3a`, `WAGON_COLOR = 0xc9ccd1`, `HOPPER_COLOR = 0x8a6a3f`, `TANK_COLOR = 0x9aa0a8`; light offsets `LIGHT_PROUD = 0.002` (how far in front of / behind the body the light quads sit).
- Build the meshes from a table:

```ts
const MODELS: Record<ModelKey, { build: () => VehicleModel; capacity: number }> = {
  hatchback: { build: hatchbackModel, capacity: MAX_CARS_PER_STYLE },
  sedan: { build: sedanModel, capacity: MAX_CARS_PER_STYLE },
  estate: { build: estateModel, capacity: MAX_CARS_PER_STYLE },
  suv: { build: suvModel, capacity: MAX_CARS_PER_STYLE },
  van: { build: vanModel, capacity: MAX_VANS },
  bus: { build: busModel, capacity: MAX_BUSES },
  locomotive: { build: locomotiveModel, capacity: MAX_TRAINS },
  passengerWagon: { build: passengerWagonModel, capacity: MAX_WAGONS },
  container: { build: containerWagonModel, capacity: MAX_WAGONS },
  hopper: { build: hopperWagonModel, capacity: MAX_WAGONS },
  tank: { build: tankWagonModel, capacity: MAX_WAGONS },
};
```

In the constructor, for each key: `new THREE.InstancedMesh(model.geometry, surfaceMaterial({ vertexColors: true }), capacity)`, `frustumCulled = false`, `castShadow = true`, `count = 0`, `name = key`, `scene.add`; store `{ mesh, length: model.length }` in `private readonly models = new Map<ModelKey, { mesh: THREE.InstancedMesh; length: number; count: number }>()`. `modelMeshes()` returns a map of key → mesh.

- Light meshes: `headlights` (`name = 'headlights'`, colour `0xfff4c9`) and `tailLights` (`name = 'tailLights'`, colour `0xe0403a`), each a `BoxGeometry(0.004, 0.02, 0.1)` centred at the origin, `MeshBasicMaterial({ transparent: true, opacity: 0 })`, capacity = sum of all model capacities, `frustumCulled = false`. `setEnvironment` sets both opacities with the existing formula `Math.max(0, (nightFactor - 0.3) / 0.7)`.
- In `update`, per target: `const key = modelKeyOf(target)` and `const color = instanceColorOf(target)`:

```ts
function modelKeyOf(v: VehicleState): ModelKey {
  switch (v.kind) {
    case VehicleKind.Car:
      return carStyleOf(v.id);
    case VehicleKind.Van:
      return 'van';
    case VehicleKind.Bus:
      return 'bus';
    case VehicleKind.Locomotive:
    case VehicleKind.FreightLocomotive:
      return 'locomotive';
    case VehicleKind.Wagon:
      return 'passengerWagon';
    default:
      return freightBodyOf(v.id);
  }
}
function instanceColorOf(v: VehicleState, key: ModelKey): number {
  switch (key) {
    case 'van':
      return VAN_COLOR;
    case 'bus':
      return BUS_COLOR;
    case 'locomotive':
      return v.kind === VehicleKind.FreightLocomotive ? FREIGHT_TRAIN_COLOR : PASSENGER_TRAIN_COLOR;
    case 'passengerWagon':
      return WAGON_COLOR;
    case 'container':
      return containerColorOf(v.id);
    case 'hopper':
      return HOPPER_COLOR;
    case 'tank':
      return TANK_COLOR;
    default:
      return carColorOf(v.id);
  }
}
```

Skip the target when its model's `count >= capacity` (before touching `previous`). Compose the vehicle matrix exactly as today (lane offset for non-trains, pitch, deck height), then `entry.mesh.setMatrixAt(entry.count, this.matrix)` and `entry.mesh.setColorAt(entry.count, this.color.setHex(color))`; `entry.count++`.

- Head light: road vehicles and locomotives — `this.lightMatrix.multiplyMatrices(this.matrix, this.offset.makeTranslation(entry.length / 2 + LIGHT_PROUD, HEADLIGHT_HEIGHT, 0))`, `HEADLIGHT_HEIGHT = 0.06`.
- Tail light: road vehicles, and a wagon whose index `k = Math.floor(v.id / WAGON_ID_OFFSET)` equals `wagonsPerTrain(v.kind)` (the last wagon) — translation `-(entry.length / 2 + LIGHT_PROUD)`.
- After the loop: set every model mesh's `count`, `instanceMatrix.needsUpdate = true`, and `instanceColor.needsUpdate = true` (guard: `instanceColor` exists after the first `setColorAt`); reset the per-model counters at the start of `update`.

`BALANCE.rail` in `src/shared/constants.ts`, after `wagonGap`:

```ts
    /** Wagons behind a passenger locomotive (drawn; the sim trails them along the track). */
    passengerWagons: 3,
    /** Wagons behind a freight locomotive. */
    freightWagons: 4,
```

- [ ] **Step 4:** `pnpm vitest run src/render && pnpm typecheck` — PASS; `pnpm test`.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add src/render src/shared/constants.ts
git commit -m "feat(render): one instanced mesh per vehicle model, stable id colours, tail lights

Cars are drawn in the mesh and paint their id selects, so a car keeps
its colour when others come and go; vans, buses, locomotives and wagons
use the detailed models; head and tail lights sit at each model's front
and rear and fade in at night.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Train trails and longer trains

**Files:**

- Modify: `src/sim/state.ts` (`Train`, `deserializeState`), `src/sim/trains.ts` (`createTrain`, `advanceTrain`, `parkAtYard`, `trailingPoint`), `src/sim/engine.ts` (`collectVehicles`), `src/sim/trains.test.ts`, `src/sim/engine.test.ts`

**Interfaces:**

- Consumes: `BALANCE.rail.passengerWagons`, `freightWagons`, `wagonGap` (Task 2 added the first two).
- Produces: `Train.trail: number[]` (transient); `TRAIL_TILES` (derived, exported from `trains.ts`); `trailingPoint(state, train, gap)` walks the trail; `wagonsOf(train): number`.

- [ ] **Step 1: Failing tests** — in `src/sim/trains.test.ts` replace the `describe('trailingPoint', …)` block with:

```ts
describe('trailingPoint', () => {
  function onTrack(): { state: SimState; train: Train } {
    const state = railTown();
    syncTrainFleet(state);
    return { state, train: state.trains[0] };
  }

  it('walks back through the trail of reached tile centres', () => {
    const { state, train } = onTrack();
    train.trail = [at(4, 10), at(5, 10), at(6, 10)];
    train.x = 6.5;
    train.y = 10.5;
    expect(trailingPoint(state, train, 1)).toMatchObject({ x: 5.5, y: 10.5 });
    expect(trailingPoint(state, train, 1.5).x).toBeCloseTo(5.0, 9);
  });

  it('follows a corner: points behind a turn lie on the earlier leg', () => {
    const { state, train } = onTrack();
    // Came east along y = 10, turned north at x = 6 (tiles exist only as indices here).
    train.trail = [at(4, 10), at(5, 10), at(6, 10), at(6, 9)];
    train.x = 6.5;
    train.y = 9.0; // half way from (6, 9) toward (6, 8)
    // 0.5 back to (6,9)'s centre, 1 down to (6,10)'s centre, 0.5 west along y = 10.5.
    const p = trailingPoint(state, train, 2);
    expect(p.y).toBeCloseTo(10.5, 9); // back round the corner
    expect(p.x).toBeCloseTo(6.0, 9);
  });

  it('clamps at the oldest trail point', () => {
    const { state, train } = onTrack();
    train.trail = [at(5, 10)];
    train.x = 5.9;
    train.y = 10.5;
    expect(trailingPoint(state, train, 5).x).toBeCloseTo(5.5, 9);
  });
});

describe('train trail', () => {
  it('records reached tile centres while running and stays within TRAIL_TILES', () => {
    const state = railTown();
    setHour(state, BALANCE.rail.windowStartHour);
    runTicks(state, 60);
    const running = runningTrains(state);
    expect(running.length).toBeGreaterThan(0);
    for (const t of running) {
      expect(t.trail.length).toBeGreaterThan(0);
      expect(t.trail.length).toBeLessThanOrEqual(TRAIL_TILES);
      for (const tile of t.trail) expect(state.layers.rail[tile]).not.toBe(0);
    }
  });

  it('keeps wagons behind the locomotive right after departing a halt', () => {
    const state = railTown();
    setHour(state, BALANCE.rail.windowStartHour);
    // Run until some train dwells, then until it runs again.
    let train: Train | undefined;
    for (let i = 0; i < 400 && !train; i++) {
      runTicks(state, 1);
      train = state.trains.find((t) => t.phase === TrainPhase.Dwelling);
    }
    expect(train).toBeDefined();
    for (let i = 0; i < 100 && train!.phase !== TrainPhase.Running; i++) runTicks(state, 1);
    runTicks(state, 1);
    const head = { x: train!.x, y: train!.y };
    const wagon = trailingPoint(state, train!, BALANCE.rail.wagonGap);
    expect(Math.hypot(wagon.x - head.x, wagon.y - head.y)).toBeGreaterThan(
      BALANCE.rail.wagonGap * 0.9,
    );
  });

  it('clears on parking and is not saved', () => {
    const state = railTown();
    setHour(state, BALANCE.rail.windowStartHour);
    runTicks(state, 60);
    const loaded = deserializeState(serializeState(state));
    for (const t of loaded.trains) expect(t.trail).toEqual([]);
    expect(JSON.stringify(serializeState(state).trains ?? [])).not.toContain('trail');
  });
});
```

(Use the file's existing `railTown`, `setHour`, `runTicks`, `at`; import `TRAIL_TILES`, `deserializeState`, `serializeState`, `TrainPhase`, `type Train` as needed. If `railTown`'s geometry makes the corner test's coordinates meaningless, keep it anyway — `trailingPoint` only reads tile indices and the train position.)

In `src/sim/engine.test.ts`, update the train-mapping test (it asserts one wagon at `train.id + WAGON_ID_OFFSET`): for every running train expect `1 + n` entries where `n = BALANCE.rail.freightWagons` for freight and `passengerWagons` otherwise, wagon `k` (1..n) with id `train.id + k * WAGON_ID_OFFSET`, kind `Wagon`/`FreightWagon`, and position `trailingPoint(state, train, k * BALANCE.rail.wagonGap)`.

- [ ] **Step 2:** `pnpm vitest run src/sim/trains.test.ts src/sim/engine.test.ts` — FAIL.

- [ ] **Step 3: Implementation**

`src/sim/state.ts` `Train`: add

```ts
  /**
   * Track tile centres the train last reached, newest last (at most
   * TRAIL_TILES). Wagons are drawn along it. Transient: not saved, empty
   * after a load or when parked.
   */
  trail: number[];
```

and `trail: []` wherever a `Train` is built (`deserializeState`, test fixtures the compiler flags).

`src/sim/trains.ts`:

```ts
/** Wagons behind this train's locomotive. */
export function wagonsOf(train: Train): number {
  return train.kind === TrainKind.Freight
    ? BALANCE.rail.freightWagons
    : BALANCE.rail.passengerWagons;
}

/** Trail length that covers the longest train plus a tile of slack each way. */
export const TRAIL_TILES =
  Math.ceil(
    Math.max(BALANCE.rail.passengerWagons, BALANCE.rail.freightWagons) * BALANCE.rail.wagonGap,
  ) + 2;
```

- `createTrain`: `trail: []`.
- `advanceTrain`: where the train snaps onto a tile centre (`train.x = targetX; train.y = targetY;`), append: `train.trail.push(target); if (train.trail.length > TRAIL_TILES) train.trail.shift();`.
- `parkAtYard`: `train.trail = [];`.
- `trailingPoint` walks `train.trail` from newest to oldest instead of `train.path`:

```ts
export function trailingPoint(
  state: SimState,
  train: Train,
  gap: number,
): { x: number; y: number; angle: number } {
  let x = train.x;
  let y = train.y;
  let remaining = gap;
  let angle = train.angle;
  for (let i = train.trail.length - 1; i >= 0 && remaining > TRAIL_EPSILON; i--) {
    const px = tileX(train.trail[i], state.size) + 0.5;
    const py = tileY(train.trail[i], state.size) + 0.5;
    const dx = px - x;
    const dy = py - y;
    const d = Math.hypot(dx, dy);
    if (d <= TRAIL_EPSILON) continue;
    angle = Math.atan2(-dy, -dx);
    if (d >= remaining) {
      x += (dx / d) * remaining;
      y += (dy / d) * remaining;
      remaining = 0;
    } else {
      x = px;
      y = py;
      remaining -= d;
    }
  }
  return { x, y, angle };
}
const TRAIL_EPSILON = 1e-9;
```

Update its doc comment: the trail survives a new leg at a halt, so wagons stay behind; a fresh train leaving the yard has an empty trail and its wagons unfold over the first tiles.

`src/sim/engine.ts` `collectVehicles`: replace the single wagon with

```ts
for (let k = 1; k <= wagonsOf(t); k++) {
  const wagon = trailingPoint(this.state, t, k * BALANCE.rail.wagonGap);
  trains.push({
    id: t.id + k * WAGON_ID_OFFSET,
    x: wagon.x,
    y: wagon.y,
    angle: wagon.angle,
    kind: freight ? VehicleKind.FreightWagon : VehicleKind.Wagon,
  });
}
```

- [ ] **Step 4:** `pnpm vitest run src/sim && pnpm typecheck` — PASS; `pnpm test`.

- [ ] **Step 5: Tick-cost probe** (memory: CI budget). Write `/tmp/probe-tick.mjs` that imports `createSimState` and `stepTick` from this checkout's `src/sim/*.ts` (absolute paths), steps 300 ticks on 64 and 32 maps, prints ms/tick; run it here and against a `main` worktree (`git worktree add /tmp/vd-base main`, symlink `node_modules`), report both, then `git worktree remove --force /tmp/vd-base` and delete the probe. Expected: within noise (< 3 %).

- [ ] **Step 6: Commit**

```bash
pnpm format
git add src/sim src/shared
git commit -m "feat(sim): trains keep a short track trail and run with three or four wagons

Each train records the tile centres it reached (transient, never saved);
trailingPoint walks that trail, so wagons stay behind the locomotive
through curves and when a new leg starts at a halt. The engine emits
BALANCE.rail.passengerWagons / freightWagons wagons per running train.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Full checks and the Mac hand-off

- [ ] `pnpm format && pnpm typecheck && pnpm lint && pnpm format:check && pnpm coverage && pnpm build` — all PASS, coverage ≥ 90 % on `src/sim` + `src/shared`.
- [ ] Hand-off checklist for the user (Mac): `pnpm e2e`; a street at day and night (four car shapes, varied paints, a car keeps its colour, tail lights red at night); a bus and a van read at city zoom; a train of 3 and of 4 wagons turning a corner and departing a station without wagons jumping or overlapping; locomotive pantograph under the catenary; tank, hopper and container wagons mixed in freight trains; frame time unchanged at 96×96 with many cars.
