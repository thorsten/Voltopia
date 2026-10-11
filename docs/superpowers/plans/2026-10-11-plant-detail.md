# Plant and Service Building Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Give all 21 `PlantType`s a detailed, recognisable vertex-coloured model and night lights (lit windows, blinking aviation lights, yard lamps), render-only.

**Architecture:** A shared model kit (`src/render/modelKit.ts`) builds merged, vertex-coloured geometry from primitives; the vehicles move onto it. `src/render/plants/` holds one model per plant type with anchors (windows, lamps, rotor hub, state-of-charge fill, park props). `plantsMesh.ts` draws one growing `InstancedMesh` per type, a plinth per plant for slopes, and turns models toward river, lake or track; a lights module adds window frames/glow and lamps.

**Tech Stack:** TypeScript, three.js (`InstancedMesh`, `mergeGeometries`), vitest.

Spec: `docs/superpowers/specs/2026-10-11-plant-detail-design.md`.

## Global Constraints

- Render-only: no changes under `src/sim`, `src/shared`, `src/storage`, `src/agent`; no save or gameplay change.
- Every new `InstancedMesh`: `frustumCulled = false` (CLAUDE.md).
- `MAX_PARTS_PER_PLANT_MODEL = 24`; every model inside its tile (|x|, |z| ≤ 0.5 after any quarter turn).
- Heights within ±0.05 of today's `plantHeight` (table in Task 2).
- Models use `surfaceMaterial({ vertexColors: true })`, `castShadow`, `receiveShadow`; light meshes cast no shadows.
- Plant mesh capacity grows on demand: `PLANT_CAPACITY_START = 16`, doubling.
- Window glow and lamps only when the tile's `island > 0`; glow uses the zone buildings' opacity curve; aviation lamps blink in sync at `AVIATION_BLINK_HZ = 0.5`.
- Upload ranges bounded by `count` (`clearUpdateRanges` + `addUpdateRange(0, count * 16)`), as `buildingsMesh.ts` does.
- No magic numbers: named constants for every dimension that is reused or tuned.
- Run `pnpm format`; `pnpm typecheck && pnpm lint && pnpm test` must pass before every commit; never `--no-verify`.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File Structure

- Create `src/render/modelKit.ts` (+ test): primitives with vertex colours, `merge`.
- Modify `src/render/vehicles/models.ts`: use the kit (no visual change).
- Create `src/render/plants/models.ts` (+ test): `PlantModel` type, anchors, `plantModel(type)` cache, `plantHeight`, `turnToward`.
- Create `src/render/plants/energyModels.ts`: solar, wind, battery, biogas, run-of-river, pumped storage, hydrogen, tidal, geothermal, heat plant, heat store.
- Create `src/render/plants/serviceModels.ts`: charging hub, park, fire, police, logistics depot, bus depot, substation, train station, freight terminal, rail yard.
- Create `src/render/plants/growingMesh.ts` (+ test): an `InstancedMesh` holder that doubles capacity.
- Rewrite `src/render/plantsMesh.ts` (+ test): per-type meshes, plinths, turns, anchors, lights.
- Modify `src/render/buildings/windows.ts`, `src/render/buildingsMesh.ts`: share `WINDOW_COLOR` and `windowGlowOpacity`.
- Modify `src/render/renderer.ts`: import `plantHeight` from `plants/models.ts`.

---

### Task 0: Branch

- [x] `git checkout -b feature/plant-detail` from `main` (spec 55f3c5b and this plan committed on `main` first).

---

### Task 1: Model kit, vehicles on the kit

**Files:**

- Create: `src/render/modelKit.ts`, `src/render/modelKit.test.ts`
- Modify: `src/render/vehicles/models.ts` (remove its private `part`, `tube`, `model` helpers; import from the kit)

**Interfaces:**

- Produces (used by Tasks 2–3 and vehicles):

```ts
export interface Model {
  geometry: THREE.BufferGeometry;
  parts: number;
}
/** Every primitive's bounding box is centred on (x, y, z). Non-indexed, attributes: position, normal, color. */
export function box(
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  color: number,
): THREE.BufferGeometry;
export function cylinder(
  r: number,
  h: number,
  x: number,
  y: number,
  z: number,
  color: number,
  segments?: number,
): THREE.BufferGeometry; // upright
export function cone(
  rBottom: number,
  rTop: number,
  h: number,
  x: number,
  y: number,
  z: number,
  color: number,
  segments?: number,
): THREE.BufferGeometry; // upright, tapered
export function tube(
  r: number,
  l: number,
  x: number,
  y: number,
  z: number,
  color: number,
  axis?: 'x' | 'z',
): THREE.BufferGeometry; // lying, default 'x'
export function sphere(
  r: number,
  x: number,
  y: number,
  z: number,
  color: number,
): THREE.BufferGeometry;
export function dome(
  r: number,
  squash: number,
  x: number,
  y: number,
  z: number,
  color: number,
): THREE.BufferGeometry; // upper hemisphere, height r*squash
export function gable(
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  color: number,
  ridgeAlong?: 'x' | 'z',
): THREE.BufferGeometry; // prism roof, ridge on top, default 'x'
export function tilted(g: THREE.BufferGeometry, angleX: number): THREE.BufferGeometry; // rotate about its own bbox centre around x
export function merge(parts: THREE.BufferGeometry[]): Model;
export const ROUND_SEGMENTS = 12;
```

- [x] **Step 1: Write the failing tests** (`src/render/modelKit.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { box, cone, cylinder, dome, gable, merge, sphere, tilted, tube } from './modelKit.ts';

function bounds(g: THREE.BufferGeometry): THREE.Box3 {
  g.computeBoundingBox();
  return g.boundingBox!;
}
const near = (a: THREE.Vector3, b: [number, number, number]) => {
  expect(a.x).toBeCloseTo(b[0], 5);
  expect(a.y).toBeCloseTo(b[1], 5);
  expect(a.z).toBeCloseTo(b[2], 5);
};

describe('model kit', () => {
  const cases: Array<
    [string, THREE.BufferGeometry, [number, number, number], [number, number, number]]
  > = [
    ['box', box(0.2, 0.3, 0.4, 0.1, 0.5, -0.1, 0xff0000), [0, 0.35, -0.3], [0.2, 0.65, 0.1]],
    ['cylinder', cylinder(0.1, 0.4, 0, 0.2, 0, 0xff0000), [-0.1, 0, -0.1], [0.1, 0.4, 0.1]],
    ['cone', cone(0.1, 0.05, 0.4, 0, 0.2, 0, 0xff0000), [-0.1, 0, -0.1], [0.1, 0.4, 0.1]],
    ['tube x', tube(0.05, 0.4, 0, 0.1, 0, 0xff0000), [-0.2, 0.05, -0.05], [0.2, 0.15, 0.05]],
    ['tube z', tube(0.05, 0.4, 0, 0.1, 0, 0xff0000, 'z'), [-0.05, 0.05, -0.2], [0.05, 0.15, 0.2]],
    ['sphere', sphere(0.1, 0, 0.1, 0, 0xff0000), [-0.1, 0, -0.1], [0.1, 0.2, 0.1]],
    ['dome', dome(0.2, 0.5, 0, 0.05, 0, 0xff0000), [-0.2, 0, -0.2], [0.2, 0.1, 0.2]],
    ['gable', gable(0.4, 0.1, 0.3, 0, 0.05, 0, 0xff0000), [-0.2, 0, -0.15], [0.2, 0.1, 0.15]],
  ];
  it.each(cases)('%s: bounding box centred on its arguments', (_name, g, min, max) => {
    const b = bounds(g);
    // Round primitives are polygons: allow the facet inset on x/z.
    expect(b.min.y).toBeCloseTo(min[1], 5);
    expect(b.max.y).toBeCloseTo(max[1], 5);
    for (const axis of ['x', 'z'] as const) {
      expect(b.min[axis]).toBeGreaterThanOrEqual(min[axis === 'x' ? 0 : 2] - 1e-6);
      expect(b.max[axis]).toBeLessThanOrEqual(max[axis === 'x' ? 0 : 2] + 1e-6);
      expect(b.max[axis] - b.min[axis]).toBeGreaterThan(
        0.9 * (max[axis === 'x' ? 0 : 2] - min[axis === 'x' ? 0 : 2]),
      );
    }
  });
  it.each(cases)('%s: non-indexed with position, normal and a colour per vertex', (_name, g) => {
    expect(g.index).toBeNull();
    const n = g.getAttribute('position').count;
    expect(g.getAttribute('normal').count).toBe(n);
    expect(g.getAttribute('color').count).toBe(n);
    expect(g.getAttribute('uv')).toBeUndefined();
    const c = g.getAttribute('color');
    expect([c.getX(0), c.getY(0), c.getZ(0)]).toEqual([1, 0, 0]);
  });
  it('gable: ridge on top, along x by default, along z on request', () => {
    const along = bounds(gable(0.4, 0.1, 0.3, 0, 0.05, 0, 0x00ff00));
    near(along.min, [-0.2, 0, -0.15]);
    near(along.max, [0.2, 0.1, 0.15]);
    const across = bounds(gable(0.4, 0.1, 0.3, 0, 0.05, 0, 0x00ff00, 'z'));
    near(across.min, [-0.2, 0, -0.15]);
    near(across.max, [0.2, 0.1, 0.15]);
    // Top vertices lie on the ridge line: x = 0 for a z ridge, z = 0 for an x ridge.
    const pos = gable(0.4, 0.1, 0.3, 0, 0.05, 0, 0x00ff00).getAttribute('position');
    for (let i = 0; i < pos.count; i++)
      if (pos.getY(i) > 0.0999) expect(Math.abs(pos.getZ(i))).toBeLessThan(1e-6);
  });
  it('tilted: rotates about the part centre around x', () => {
    const g = tilted(box(0.2, 0.02, 0.4, 0, 0.3, 0, 0xffffff), Math.PI / 2);
    const b = bounds(g);
    near(b.min, [-0.1, 0.1, -0.01]);
    near(b.max, [0.1, 0.5, 0.01]);
  });
  it('merge: counts parts and keeps every vertex colour', () => {
    const m = merge([
      box(0.1, 0.1, 0.1, 0, 0, 0, 0xff0000),
      cylinder(0.05, 0.1, 0.2, 0, 0, 0x0000ff),
    ]);
    expect(m.parts).toBe(2);
    expect(m.geometry.getAttribute('color').count).toBe(m.geometry.getAttribute('position').count);
  });
  it('merge: rejects an empty part list', () => {
    expect(() => merge([])).toThrow();
  });
});
```

- [x] **Step 2:** Run `./node_modules/.bin/vitest run src/render/modelKit.test.ts` — FAIL (module missing).

- [x] **Step 3: Implement `src/render/modelKit.ts`**

```ts
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** Facets of round primitives (cylinders, cones, tubes, spheres, domes). */
export const ROUND_SEGMENTS = 12;

export interface Model {
  geometry: THREE.BufferGeometry;
  /** Number of merged primitives. */
  parts: number;
}

const scratch = new THREE.Color();

/**
 * Normalise a primitive for merging: non-indexed, no uv, one colour per
 * vertex, bounding box centred on (x, y, z).
 */
function finish(
  g: THREE.BufferGeometry,
  x: number,
  y: number,
  z: number,
  color: number,
): THREE.BufferGeometry {
  const flat = g.index ? g.toNonIndexed() : g;
  flat.deleteAttribute('uv');
  flat.computeBoundingBox();
  const centre = flat.boundingBox!.getCenter(new THREE.Vector3());
  flat.translate(x - centre.x, y - centre.y, z - centre.z);
  scratch.setHex(color);
  const n = flat.getAttribute('position').count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) colors.set([scratch.r, scratch.g, scratch.b], i * 3);
  flat.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return flat;
}

export const box = (
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  color: number,
) => finish(new THREE.BoxGeometry(w, h, d), x, y, z, color);

export const cylinder = (
  r: number,
  h: number,
  x: number,
  y: number,
  z: number,
  color: number,
  segments = ROUND_SEGMENTS,
) => finish(new THREE.CylinderGeometry(r, r, h, segments), x, y, z, color);

export const cone = (
  rBottom: number,
  rTop: number,
  h: number,
  x: number,
  y: number,
  z: number,
  color: number,
  segments = ROUND_SEGMENTS,
) => finish(new THREE.CylinderGeometry(rTop, rBottom, h, segments), x, y, z, color);

export function tube(
  r: number,
  l: number,
  x: number,
  y: number,
  z: number,
  color: number,
  axis: 'x' | 'z' = 'x',
) {
  const g = new THREE.CylinderGeometry(r, r, l, ROUND_SEGMENTS);
  if (axis === 'x') g.rotateZ(Math.PI / 2);
  else g.rotateX(Math.PI / 2);
  return finish(g, x, y, z, color);
}

export const sphere = (r: number, x: number, y: number, z: number, color: number) =>
  finish(new THREE.SphereGeometry(r, ROUND_SEGMENTS, ROUND_SEGMENTS / 2), x, y, z, color);

export function dome(r: number, squash: number, x: number, y: number, z: number, color: number) {
  const g = new THREE.SphereGeometry(
    r,
    ROUND_SEGMENTS,
    ROUND_SEGMENTS / 2,
    0,
    Math.PI * 2,
    0,
    Math.PI / 2,
  );
  g.scale(1, squash, 1);
  return finish(g, x, y, z, color);
}

/** Prism roof: rectangular base w × d, ridge of height h along x (default) or z. */
export function gable(
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  color: number,
  ridgeAlong: 'x' | 'z' = 'x',
) {
  // Triangle profile across the ridge, extruded along it.
  const across = ridgeAlong === 'x' ? d : w;
  const along = ridgeAlong === 'x' ? w : d;
  const shape = new THREE.Shape();
  shape.moveTo(-across / 2, 0);
  shape.lineTo(across / 2, 0);
  shape.lineTo(0, h);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: along, bevelEnabled: false });
  // Profile lies in x/y and extrudes along z: an x ridge needs the profile across z.
  if (ridgeAlong === 'x') g.rotateY(Math.PI / 2);
  g.computeVertexNormals();
  return finish(g, x, y, z, color);
}

/** Rotate a finished primitive about its own bounding-box centre around x. */
export function tilted(g: THREE.BufferGeometry, angleX: number): THREE.BufferGeometry {
  g.computeBoundingBox();
  const c = g.boundingBox!.getCenter(new THREE.Vector3());
  g.translate(-c.x, -c.y, -c.z);
  g.rotateX(angleX);
  g.translate(c.x, c.y, c.z);
  return g;
}

export function merge(parts: THREE.BufferGeometry[]): Model {
  if (parts.length === 0) throw new Error('model kit: no parts to merge');
  const geometry = mergeGeometries(parts);
  if (!geometry) throw new Error('model kit: parts do not merge');
  return { geometry, parts: parts.length };
}
```

Note: `ExtrudeGeometry` is non-indexed and has a `uv` attribute; `finish` deletes it. Its flat-shaded normals come from `computeVertexNormals` on non-indexed data (per-face). If the test for `gable` bounds fails on orientation, fix the rotation, not the test.

- [x] **Step 4:** Run the kit test — PASS.
- [x] **Step 5: Move vehicles onto the kit.** In `src/render/vehicles/models.ts` delete `part`, `tube`, `model`, `scratch`, `TUBE_SEGMENTS`; `import { box as part, tube, merge } from '../modelKit.ts'`; replace `model(parts, length)` with `({ ...merge(parts), length })`. Keep `MAX_PARTS_PER_MODEL` and the exported colours. Tank wagon tubes keep 8 segments if their test pins the vertex count — otherwise `ROUND_SEGMENTS` is fine. Run `./node_modules/.bin/vitest run src/render/vehicles src/render/vehiclesMesh.test.ts` — all PASS unchanged.
- [x] **Step 6:** `pnpm format && pnpm typecheck && pnpm lint && pnpm test`; commit `refactor(render): shared model kit with round primitives; vehicles use it`.

---

### Task 2: Plant model registry and energy models

**Files:**

- Create: `src/render/plants/models.ts`, `src/render/plants/energyModels.ts`, `src/render/plants/models.test.ts`
- Create: `src/render/plants/serviceModels.ts` as a stub exporting `serviceModels: Partial<Record<PlantType, () => PlantModel>> = {}` (filled in Task 3)

**Interfaces:**

- Consumes: the Task 1 kit.
- Produces:

```ts
export const MAX_PARTS_PER_PLANT_MODEL = 24;
/** Model face direction as quarter turns: 0 = +z, 1 = +x, 2 = −z, 3 = −x (yaw = face · π/2). */
export type Face = 0 | 1 | 2 | 3;
export interface WindowAnchor {
  x: number;
  y: number;
  z: number;
  face: Face;
  w: number;
  h: number;
} // glass bottom-centre on the wall surface
export interface LampAnchor {
  x: number;
  y: number;
  z: number;
  kind: 'aviation' | 'yard';
}
export interface GroundProp {
  kind: 'tree' | 'bench';
  x: number;
  z: number;
  scale: number;
  turn: number;
}
export interface PlantModel {
  /** Merged vertex-coloured geometry, base at y = 0, origin at the tile centre; null when the type draws only ground props (park). */
  geometry: THREE.BufferGeometry | null;
  parts: number;
  /** Plinth under the model (absent for the park). */
  plinth?: { sx: number; sz: number; color: number };
  windows: WindowAnchor[];
  lamps: LampAnchor[];
  rotorHub?: { x: number; y: number; z: number }; // wind turbine
  socFill?: { x: number; y: number; z: number; w: number; d: number; maxH: number }; // battery: bar base, grows by maxH * soc
  groundProps?: GroundProp[]; // park
}
export function plantModel(type: PlantType): PlantModel; // cached per type; throws for PlantType.None
export function plantHeight(type: PlantType): number; // geometry top, rotor tip, or tallest ground prop
export function turnToward(dx: number, dz: number): number; // yaw so model +z points to (dx, dz); (0,0) → 0
export const ROTOR_RADIUS = 0.42;
export const TREE_HEIGHT = 0.26; // tree prop height at scale 1
export const BENCH_HEIGHT = 0.04;
```

Model conventions (write them as the module doc comment):

- Units are tiles; origin at the tile centre; base at y = 0; every vertex within |x|, |z| ≤ 0.5.
- Where a site matters the model is drawn with the water/track side at **+z** (`plantsMesh` turns it): run-of-river drawn with the river flowing along z (weir spanning x); pumped storage with the lake at +z; train station, freight terminal and rail yard with the track at +z.
- Windows: `y` is the glass bottom, `(x, z)` on the wall surface (the frame mesh adds its own proud offset), `face` the wall's outward normal. Size `w × h` matches the zone buildings (`WINDOW_WIDTH 0.09 × WINDOW_HEIGHT 0.11` from `buildings/windowLayout.ts`) unless a model has a reason (e.g. a tall station window).

Heights today (the ±0.05 target):

| Type        | Height | Type           | Height | Type            | Height |
| ----------- | ------ | -------------- | ------ | --------------- | ------ |
| SolarFarm   | 0.160  | PumpedStorage  | 0.500  | GeothermalPlant | 0.500  |
| WindTurbine | 1.270  | FireStation    | 0.660  | HeatPlant       | 0.620  |
| Battery     | 0.560  | PoliceStation  | 0.530  | HeatStore       | 0.510  |
| BiogasPlant | 0.345  | LogisticsDepot | 0.340  | Substation      | 0.470  |
| ChargingHub | 0.500  | BusDepot       | 0.360  | TrainStation    | 0.420  |
| Park        | 0.520  | HydrogenPlant  | 0.560  | FreightTerminal | 0.610  |
| RunOfRiver  | 0.340  | TidalPlant     | 0.620  | RailYard        | 0.400  |

Plinth: model base sits on the plinth top; `plantsMesh` places the plinth top at tile lift + `PLINTH_RISE` (Task 4) and the model at the same height, so model heights stay measured from y = 0.

- [x] **Step 1: Write the failing tests** (`src/render/plants/models.test.ts`) — table-driven over the types implemented so far; Task 3 widens `TYPES` to all 21:

```ts
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { PlantType } from '../../shared/types.ts';
import { MAX_PARTS_PER_PLANT_MODEL, plantHeight, plantModel, turnToward } from './models.ts';

const HEIGHT: Record<number, number> = {
  [PlantType.SolarFarm]: 0.16,
  [PlantType.WindTurbine]: 1.27,
  [PlantType.Battery]: 0.56,
  [PlantType.BiogasPlant]: 0.345,
  [PlantType.ChargingHub]: 0.5,
  [PlantType.Park]: 0.52,
  [PlantType.RunOfRiver]: 0.34,
  [PlantType.PumpedStorage]: 0.5,
  [PlantType.FireStation]: 0.66,
  [PlantType.PoliceStation]: 0.53,
  [PlantType.LogisticsDepot]: 0.34,
  [PlantType.BusDepot]: 0.36,
  [PlantType.HydrogenPlant]: 0.56,
  [PlantType.TidalPlant]: 0.62,
  [PlantType.GeothermalPlant]: 0.5,
  [PlantType.HeatPlant]: 0.62,
  [PlantType.HeatStore]: 0.51,
  [PlantType.Substation]: 0.47,
  [PlantType.TrainStation]: 0.42,
  [PlantType.FreightTerminal]: 0.61,
  [PlantType.RailYard]: 0.4,
};
const ENERGY = [
  PlantType.SolarFarm,
  PlantType.WindTurbine,
  PlantType.Battery,
  PlantType.BiogasPlant,
  PlantType.RunOfRiver,
  PlantType.PumpedStorage,
  PlantType.HydrogenPlant,
  PlantType.TidalPlant,
  PlantType.GeothermalPlant,
  PlantType.HeatPlant,
  PlantType.HeatStore,
];
const TYPES = ENERGY; // Task 3: all 21 types
const STAFFED = [PlantType.HydrogenPlant, PlantType.GeothermalPlant, PlantType.HeatPlant]; // Task 3 adds the services
const AVIATION = [PlantType.WindTurbine, PlantType.HeatStore];

function distinctColours(g: THREE.BufferGeometry): number {
  const c = g.getAttribute('color');
  const seen = new Set<string>();
  for (let i = 0; i < c.count; i++)
    seen.add(`${c.getX(i).toFixed(3)},${c.getY(i).toFixed(3)},${c.getZ(i).toFixed(3)}`);
  return seen.size;
}

describe('plant models', () => {
  it.each(TYPES)('type %i: vertex-coloured, within the part budget and the tile', (type) => {
    const m = plantModel(type);
    expect(m.parts).toBeLessThanOrEqual(MAX_PARTS_PER_PLANT_MODEL);
    if (m.geometry) {
      expect(m.geometry.getAttribute('color').count).toBe(
        m.geometry.getAttribute('position').count,
      );
      m.geometry.computeBoundingBox();
      const b = m.geometry.boundingBox!;
      for (const v of [b.min.x, b.max.x, b.min.z, b.max.z])
        expect(Math.abs(v)).toBeLessThanOrEqual(0.5 + 1e-6);
      expect(b.min.y).toBeGreaterThanOrEqual(-1e-6);
      expect(distinctColours(m.geometry)).toBeGreaterThanOrEqual(3);
    }
    if (m.plinth) {
      expect(m.plinth.sx).toBeLessThanOrEqual(1);
      expect(m.plinth.sz).toBeLessThanOrEqual(1);
    }
  });
  it.each(TYPES)('type %i: as tall as before (±0.05)', (type) => {
    expect(Math.abs(plantHeight(type) - HEIGHT[type])).toBeLessThanOrEqual(0.05);
  });
  it.each(TYPES)('type %i: window anchors sit on a wall and face out of it', (type) => {
    const m = plantModel(type);
    for (const w of m.windows) {
      expect(Math.abs(w.x)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(w.z)).toBeLessThanOrEqual(0.5);
      // A ray from just in front of the glass centre back into the wall hits the model within 0.01.
      const yaw = (w.face * Math.PI) / 2;
      const normal = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
      const origin = new THREE.Vector3(w.x, w.y + w.h / 2, w.z).addScaledVector(normal, 0.05);
      const ray = new THREE.Raycaster(origin, normal.clone().negate(), 0, 0.06);
      const mesh = new THREE.Mesh(
        m.geometry!,
        new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
      );
      const hit = ray.intersectObject(mesh)[0];
      expect(hit, `window at ${w.x},${w.y},${w.z} face ${w.face}`).toBeDefined();
      expect(hit.distance).toBeGreaterThan(0.04);
    }
  });
  it.each(STAFFED)('type %i: staffed buildings have at least two windows', (type) => {
    expect(plantModel(type).windows.length).toBeGreaterThanOrEqual(2);
  });
  it.each(AVIATION)('type %i: carries an aviation lamp at its top', (type) => {
    const lamps = plantModel(type).lamps.filter((l) => l.kind === 'aviation');
    expect(lamps.length).toBeGreaterThanOrEqual(1);
    const g = plantModel(type).geometry!;
    g.computeBoundingBox();
    // On the structure's top (for the turbine: the nacelle, below the rotor tip).
    for (const l of lamps) expect(l.y).toBeGreaterThanOrEqual(g.boundingBox!.max.y - 0.1);
  });
  it('wind turbine: rotor hub on the nacelle front, rotor tip sets the height', () => {
    const m = plantModel(PlantType.WindTurbine);
    expect(m.rotorHub).toBeDefined();
    expect(m.rotorHub!.y).toBeCloseTo(0.85, 2);
  });
  it('battery: a state-of-charge bar anchor on the cabinet front', () => {
    const fill = plantModel(PlantType.Battery).socFill!;
    expect(fill).toBeDefined();
    expect(fill.y + 0.04 + fill.maxH).toBeLessThanOrEqual(plantHeight(PlantType.Battery));
  });
  it('turnToward points model +z at the given neighbour', () => {
    expect(turnToward(0, 1)).toBeCloseTo(0);
    expect(turnToward(1, 0)).toBeCloseTo(Math.PI / 2);
    expect(Math.abs(turnToward(0, -1))).toBeCloseTo(Math.PI);
    expect(turnToward(-1, 0)).toBeCloseTo(-Math.PI / 2);
    expect(turnToward(0, 0)).toBe(0);
    const v = new THREE.Vector3(0, 0, 1).applyAxisAngle(
      new THREE.Vector3(0, 1, 0),
      turnToward(1, 0),
    );
    expect(v.x).toBeCloseTo(1);
  });
  it('caches one model per type', () => {
    expect(plantModel(PlantType.Battery)).toBe(plantModel(PlantType.Battery));
  });
});
```

- [x] **Step 2:** Run `./node_modules/.bin/vitest run src/render/plants` — FAIL.

- [x] **Step 3: Implement `models.ts`** (registry, `turnToward = (dx, dz) => (dx === 0 && dz === 0 ? 0 : Math.atan2(dx, dz))`, cache in a `Map`, `plantHeight` = max of geometry bbox top, `rotorHub.y + ROTOR_RADIUS`, and `max(prop.scale × TREE_HEIGHT)` over ground props). Registry merges `energyModels` and `serviceModels`; a missing type throws `plant model missing for type N`.

- [x] **Step 4: Implement the energy models** in `energyModels.ts` as `export const energyModels: Partial<Record<PlantType, () => PlantModel>>`. Shared colours in a `const C = {...}` block reusing today's palette in `plantsMesh.ts` `COLORS` (copy the values you use), plus `CONCRETE 0x9a9da3`, `GRAVEL 0x8a8478`, `STEEL 0x6f7a86`, `ROOF_DARK 0x4b5563`, `GLASS 0x2b3440`. Content per type (≤ 24 parts, heights per the table):

| Type            | Parts (guide)                                                                                                                            | Anchors                                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| SolarFarm       | 3 module rows: tilted panel (`tilted(box)`, ~0.25 rad, dark blue) + thin frame strip + two posts each; inverter box; two low fence rails | plinth gravel 0.96²                                                                                                              |
| WindTurbine     | foundation ring (cylinder), tapered tower (`cone` 0.06→0.035, to y 0.8), nacelle box at 0.85, hub sphere at the nacelle front (+z)       | `rotorHub {0, 0.85, 0.09}`; aviation lamp on the nacelle top; plinth concrete 0.3²                                               |
| Battery         | 3 container cabinets (green, 0.5 high) with dark vent grilles, transformer box, cable tray                                               | `socFill` on the front cabinet face (`maxH 0.42`, base 0.03 above y 0, w 0.1, d 0.03, z on the face); yard lamp; plinth concrete |
| BiogasPlant     | digester cylinder + `dome` (squash 0.75, top 0.345), second smaller tank, silo clamp box, pipe tubes, thin flare stack                   | plinth concrete                                                                                                                  |
| RunOfRiver      | weir box spanning x (0.96 × 0.2 × 0.3), 3 gate piers, water-light sill, powerhouse at +x with `gable` roof, trash-rack bars              | 2 windows on the powerhouse; plinth concrete 0.96 × 0.3                                                                          |
| PumpedStorage   | powerhouse (0.6 × 0.45 × 0.5) with roof slab, valve house, two penstock `tube`s along z toward +z (lake)                                 | 2 windows; plinth concrete                                                                                                       |
| HydrogenPlant   | electrolyser hall with roof, 2 horizontal tanks (`tube` x) + 1 `sphere` tank, pipe bridge, vent stack                                    | ≥ 2 windows; yard lamp; plinth concrete                                                                                          |
| TidalPlant      | barrage box spanning x, 3 turbine houses, gates, buoy                                                                                    | aviation lamp optional; plinth concrete                                                                                          |
| GeothermalPlant | control house, drill tower (4 thin posts + top box), 2 cooling cells, pipe runs, wellhead                                                | ≥ 2 windows; plinth gravel                                                                                                       |
| HeatPlant       | heat-pump hall with roof, 3 fan units (`cylinder`) on the roof, pipe outlet, small stack                                                 | ≥ 2 windows; plinth concrete                                                                                                     |
| HeatStore       | tall insulated tank (`cylinder`, top ≈ 0.49) with 3 ring bands, cap, stair (thin tilted box)                                             | aviation lamp at the top; plinth concrete                                                                                        |

Write one builder per type (`function windTurbine(): PlantModel`), named constants for dimensions shared with anchors (e.g. `HUB_HEIGHT = 0.85`, `NACELLE`), and assert nothing in the builders — the tests do that.

- [x] **Step 5:** Run the plant model tests — PASS. Inspect the part count printout: add `console.table` temporarily if helpful, then remove it.
- [x] **Step 6:** `pnpm format && pnpm typecheck && pnpm lint && pnpm test`; commit `feat(render): plant model registry and detailed energy plant models`.

---

### Task 3: Service, grid and rail models

**Files:**

- Modify: `src/render/plants/serviceModels.ts`, `src/render/plants/models.test.ts`

**Interfaces:**

- Consumes: Task 2's `PlantModel`, anchors, kit, `TREE_HEIGHT`, `BENCH_HEIGHT`.
- Produces: `serviceModels` entries for ChargingHub, Park, FireStation, PoliceStation, LogisticsDepot, BusDepot, Substation, TrainStation, FreightTerminal, RailYard.

- [x] **Step 1: Widen the tests:** `TYPES` = all 21 types (`Object.values(PlantType).filter((t) => t !== PlantType.None)`); `STAFFED` adds FireStation, PoliceStation, LogisticsDepot, BusDepot, TrainStation, FreightTerminal, RailYard; add:

```ts
const YARD = [
  PlantType.Substation,
  PlantType.TrainStation,
  PlantType.FreightTerminal,
  PlantType.RailYard,
  PlantType.LogisticsDepot,
];
it.each(YARD)('type %i: has yard lamps', (type) => {
  expect(plantModel(type).lamps.some((l) => l.kind === 'yard')).toBe(true);
});
it('park: ground props only — trees in three sizes and benches, no plinth', () => {
  const m = plantModel(PlantType.Park);
  expect(m.geometry).toBeNull();
  expect(m.plinth).toBeUndefined();
  const trees = m.groundProps!.filter((p) => p.kind === 'tree');
  expect(new Set(trees.map((t) => t.scale)).size).toBe(3);
  expect(m.groundProps!.some((p) => p.kind === 'bench')).toBe(true);
  for (const p of m.groundProps!) {
    expect(Math.abs(p.x)).toBeLessThanOrEqual(0.42);
    expect(Math.abs(p.z)).toBeLessThanOrEqual(0.42);
  }
});
it.each([PlantType.TrainStation, PlantType.FreightTerminal, PlantType.RailYard])(
  'type %i: drawn with the track side at +z (platform/loading edge at z > 0.25)',
  (type) => {
    const g = plantModel(type).geometry!;
    g.computeBoundingBox();
    expect(g.boundingBox!.max.z).toBeGreaterThan(0.25);
  },
);
```

Also export from `models.ts` the two prop geometries Task 4 instances: `treeGeometry(): THREE.BufferGeometry` (trunk + foliage `cone` and a second smaller cone, height `TREE_HEIGHT` at scale 1, base y = 0) and `benchGeometry()` (seat + 2 legs, height `BENCH_HEIGHT`), both via the kit; test that both carry colours and have the stated heights.

- [x] **Step 2:** Run — FAIL.
- [x] **Step 3: Implement** (≤ 24 parts, heights per the table):

| Type            | Parts (guide)                                                                                                                           | Anchors                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| ChargingHub     | canopy slab on 4 columns, 3 charger pillars with screens, cabinet, 2 parking-mark strips                                                | yard lamp under the canopy; plinth asphalt `0x5a5f66`                                                      |
| Park            | — (geometry null)                                                                                                                       | `groundProps`: 5 trees at scales 0.8/1.0/1.25 spread over the tile, 2 benches; the tallest tree top ≈ 0.52 |
| FireStation     | hall (red) with 3 dark doors on the +z face, roof slab with overhang, hose tower (to 0.66) with cap, flagpole                           | ≥ 3 windows (side/back and tower); plinth concrete                                                         |
| PoliceStation   | blue station body, entrance canopy, radio mast (to 0.53), car port slab on posts, light bar                                             | ≥ 3 windows; plinth concrete                                                                               |
| LogisticsDepot  | hall with 2 roll-up doors, loading dock slab, yard markings, office box                                                                 | ≥ 2 windows on the office; yard lamp; plinth concrete                                                      |
| BusDepot        | shed with 2 arched entrances (door box + `cylinder` half? keep boxes), washing bay frame, office                                        | ≥ 2 windows; plinth concrete                                                                               |
| Substation      | gravel yard (plinth), 2 transformers with radiator fins, 3 insulators (`cylinder`), 2 gantries (posts + beam), control hut, fence rails | 2 yard lamps; plinth gravel 0.96²                                                                          |
| TrainStation    | platform along +z edge with canopy on columns, station building with `gable` roof, clock post                                           | ≥ 3 windows; yard lamps on the platform; plinth concrete                                                   |
| FreightTerminal | container stacks (3 colours), gantry crane (2 legs + beam to 0.61) spanning toward +z, office                                           | ≥ 2 windows; yard lamp; plinth gravel                                                                      |
| RailYard        | engine shed with `gable` roof and 2 doors on +z, sand tower, inspection pit strip                                                       | ≥ 2 windows; yard lamp; plinth gravel                                                                      |

- [x] **Step 4:** Run the plant model tests — PASS.
- [x] **Step 5:** `pnpm format && pnpm typecheck && pnpm lint && pnpm test`; commit `feat(render): detailed service, grid and rail plant models`.

---

### Task 4: Render the models

**Files:**

- Create: `src/render/plants/growingMesh.ts`, `src/render/plants/growingMesh.test.ts`
- Rewrite: `src/render/plantsMesh.ts`; adapt `src/render/plantsMesh.test.ts`
- Modify: `src/render/renderer.ts` (import `plantHeight` from `./plants/models.ts`)

**Interfaces:**

- Consumes: `plantModel`, `plantHeight`, `turnToward`, `treeGeometry`, `benchGeometry`, `ROTOR_RADIUS`.
- Produces (Task 5 uses):

```ts
export class GrowingMesh {
  constructor(
    scene: THREE.Scene,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    setup: (mesh: THREE.InstancedMesh) => void,
    start?: number,
  );
  get mesh(): THREE.InstancedMesh; // current mesh (replaced on growth)
  ensure(count: number): void; // grow capacity by doubling to ≥ count, replacing the mesh in the scene, disposing the old one (not the shared geometry/material)
  commit(count: number): void; // set count, bounded upload ranges for matrix and colour, needsUpdate
}
export const PLANT_CAPACITY_START = 16;
// plantsMesh.ts
export const PLINTH_RISE = 0.015; // plinth top and model base above the tile-centre lift
export function plantYaw(type: PlantType, site: PlantSite): number; // exported for tests
export interface PlantSite {
  riverAlongZ: boolean;
  lakeDx: number;
  lakeDz: number;
  trackDx: number;
  trackDz: number;
}
class PlantsMesh {
  meshOf(type: PlantType): THREE.InstancedMesh | undefined; // undefined for types without geometry or none placed yet
  readonly plinths: GrowingMesh;
  readonly parkPads: THREE.InstancedMesh;
  readonly socFillMesh: THREE.InstancedMesh;
  readonly treeMesh: GrowingMesh;
  readonly benchMesh: GrowingMesh;
  /** Placed plants in rebuild order with their world pose, for the lights (Task 5). */
  protected readonly placed: Array<{
    index: number;
    type: PlantType;
    x: number;
    y: number;
    z: number;
    yaw: number;
  }>;
}
```

`plantYaw`: RunOfRiver → `riverAlongZ ? 0 : Math.PI / 2`; PumpedStorage → `turnToward(lakeDx, lakeDz)`; TrainStation, FreightTerminal, RailYard → `turnToward(trackDx, trackDz)`; others → 0.

- [x] **Step 1: GrowingMesh test + implementation.** Test: starting capacity 16; `ensure(17)` gives capacity 32 and the scene contains exactly one mesh of this holder; `frustumCulled` false after growth (set by `setup`); `commit(3)` sets `count` 3 and the matrix update range to `{ start: 0, count: 48 }`. Implement with `new THREE.InstancedMesh(geometry, material, capacity)`, `setup(mesh)`, `mesh.count = 0`, `scene.add`; on growth `scene.remove(old)`, `old.dispose()`.
- [x] **Step 2: Adapt `plantsMesh.test.ts` first** (failing): keep the park, battery and rail-facing describes and rewrite their assertions to the new structure; replace the "foundations" describe:

```ts
describe('plant plinths on sloped ground', () => {
  // One plinth per non-park plant: top at lift + PLINTH_RISE, bottom at the lowest ground under its footprint.
  it('reaches down to the lowest ground under the footprint and keeps its top', () => {
    /* slope field like today; read plinths.mesh matrix 0; assert top ≈ centerY + PLINTH_RISE and bottom ≈ lowest corner sample */
  });
  it('stands the model on the plinth top, never floating', () => {
    /* model instance y === plinth top */
  });
  it('changes nothing between two flat tiles except x/z', () => {
    /* two batteries on flat ground: identical y */
  });
});
describe('one mesh per plant type', () => {
  it('draws each type in its own mesh with one instance per plant', () => {
    /* 2 fire stations + 1 battery → meshOf(Fire).count 2, meshOf(Battery).count 1 */
  });
  it('grows past the starting capacity without losing plants', () => {
    /* 20 substations on a 8×8 grid → count 20, capacity ≥ 20 */
  });
  it('frees instances when a plant is bulldozed', () => {});
});
describe('model orientation', () => {
  it('turns a run-of-river plant across an east–west river', () => {
    /* plantYaw(...) === π/2 and the instance quaternion matches */
  });
  it('turns pumped storage toward its lake', () => {});
  it('puts the station platform on the side of the track, whichever side that is', () => {
    /* for track N/E/S/W: instance yaw === turnToward(dx, dz) */
  });
  it('turns an existing station when track is laid beside it later', () => {});
});
```

Write each body concretely in the test file (use the existing `field`, `plant`, `park`, `at` helpers and today's slope fields). Park tests: pads unchanged; "stands every tree on the ground at its own spot" now reads `treeMesh.mesh` matrices (each tree y = `surfaceY(x, z)`); add "puts benches on the ground". Battery fill tests unchanged in intent (fill follows `stored`; bar sits at the model's `socFill` anchor). Substation test: one `Substation` instance and one plinth. Delete the `orientToTrack` unit test (function removed; `turnToward` is covered in Task 2).

- [x] **Step 3: Rewrite `plantsMesh.ts`.** Keep: `applyDiffs` bookkeeping (terrain, rail, plants, state of charge), `siteOf`, `lowestGroundUnder`, park pads, rotor mesh and `update` rotor spin, battery fill mesh. Remove: `BoxPart`, `COLORS` (only `parkGrass` and the rotor colour stay as constants), `plantBoxParts`, `orientToTrack`, the shared box mesh, `domeMesh`, `plantHeight` (re-export from `./plants/models.ts` for compatibility is NOT needed — update `renderer.ts`). Per type with geometry: a `GrowingMesh` created lazily with `surfaceMaterial({ vertexColors: true })`, setup `frustumCulled = false; castShadow = true; receiveShadow = true`. `rebuild()`:
  1. Count plants per type; `ensure` each mesh, the plinths, trees and benches.
  2. For each plant: `lift = elevation.centerY(index)`, `yaw = plantYaw(type, site)`, `base = lift + PLINTH_RISE`. If the model has a plinth: footprint `sx, sz` swapped when `|sin yaw| ≈ 1`; bottom `min(lift, lowestGroundUnder(cx, cz, sx', sz'))`; plinth matrix = position `(cx, bottom, cz)`, scale `(sx', base - bottom, sz')` on a unit box translated to base y = 0, instance colour `plinth.color`. Model matrix = `compose((cx, base, cz), quaternion(yaw about y), (1,1,1))`. Record `placed`.
  3. Rotor: hub anchor rotated by yaw, `+ (cx, base, cz)`. Battery fill: `socFill` anchor rotated by yaw; scale `(w, 0.04 + maxH × soc, d)`.
  4. Park: pads as today; each ground prop at `(cx + p.x, surfaceY(cx + p.x, cz + p.z), cz + p.z)`, scale `p.scale`, yaw `p.turn`, into `treeMesh`/`benchMesh` (both `surfaceMaterial({ vertexColors: true })`, cast shadow).
  5. `commit` every mesh (types with no plants → count 0).
- [x] **Step 4:** Run `./node_modules/.bin/vitest run src/render/plantsMesh.test.ts src/render/plants` — PASS. Run `node scripts/smoke.mjs` — the app boots headless.
- [x] **Step 5:** `pnpm format && pnpm typecheck && pnpm lint && pnpm test`; commit `feat(render): draw plants from their detailed models with plinths and turns`.

---

### Task 5: Night lights

**Files:**

- Create: `src/render/plants/lights.ts`, `src/render/plants/lights.test.ts`
- Modify: `src/render/buildings/windows.ts` (export `WINDOW_COLOR = 0xffc978` and `windowGlowOpacity(nightFactor) = Math.max(0, nightFactor - 0.25) / 0.75`), `src/render/buildingsMesh.ts` (import both instead of its local copies; behaviour unchanged), `src/render/plantsMesh.ts`, `src/render/plantsMesh.test.ts`

**Interfaces:**

- Consumes: `PlantModel.windows`, `PlantModel.lamps`, `PlantsMesh.placed`, `GrowingMesh`, `windowGeometry()`, `WINDOW_PROUD`.
- Produces:

```ts
export const AVIATION_BLINK_HZ = 0.5;
export const LAMP_SIZE = 0.03;
export const GLOW_PROUD = 2.5 * WINDOW_PROUD;
export class PlantLights {
  constructor(scene: THREE.Scene);
  readonly frames: GrowingMesh; // lit, windowGeometry(), visible day and night, receiveShadow, no castShadow
  readonly glow: GrowingMesh; // MeshBasic WINDOW_COLOR, transparent, depthWrite false, night only
  readonly aviation: GrowingMesh; // MeshBasic red 0xff3b30, small sphere/box LAMP_SIZE
  readonly yard: GrowingMesh; // MeshBasic warm white 0xffe2b0
  rebuild(
    placed: ReadonlyArray<{
      index: number;
      type: PlantType;
      x: number;
      y: number;
      z: number;
      yaw: number;
    }>,
    powered: (index: number) => boolean,
  ): void;
  setNight(nightFactor: number): void; // glow + yard opacity = windowGlowOpacity; aviation follows with the blink
  update(deltaSeconds: number): void; // advances the blink clock; aviation opacity = night opacity × (phase < 0.5 ? 1 : 0)
}
```

Frames are written for every placed window (powered or not); glow, aviation and yard lamps only for plants where `powered(index)` (tile `island > 0`). Window world pose: anchor rotated by the plant yaw, face yaw = plant yaw + `face × π/2`; frame matrix = position on the wall, rotation face yaw, scale `(w, h, 1)` on `windowGeometry()`; glow = `PlaneGeometry(1, 1)` translated to base y = 0, same pose pushed `GLOW_PROUD` along the face normal, scale `(w, h, 1)`. Meshes invisible when their opacity is 0.

- [x] **Step 1: Tests** (`lights.test.ts` with a stub `placed` list; `plantsMesh.test.ts` end-to-end):
  - frames count = Σ windows of placed plants, including an unpowered one; glow count = Σ windows of powered plants only;
  - a frame of a turned station faces the turned direction (normal of the matrix ≈ rotated face normal);
  - `setNight(0)`: glow, yard and aviation meshes invisible; `setNight(1)`: visible, glow opacity 1;
  - aviation blink: with `setNight(1)`, after `update(0.5)` opacity 1, after another `update(1.0)` (phase 0.75) opacity 0; every aviation lamp shares the phase;
  - `PlantsMesh`: a diff that only changes `island` from 1 to 0 removes the plant's glow and lamps without rebuilding the models (spy on `GrowingMesh.prototype.ensure` for the type mesh or compare matrices);
  - `buildingsMesh.test.ts` stays green (shared opacity helper).
- [x] **Step 2:** Run — FAIL.
- [x] **Step 3: Implement** `lights.ts`; in `PlantsMesh` track `island` per plant tile in `applyDiffs` (a change of `island > 0` only → `lights.rebuild` without `rebuild()`), call `lights.rebuild(this.placed, …)` at the end of `rebuild()`, forward `setEnvironment` (`lights.setNight(environment.nightFactor)`) and `update` (`lights.update(dt)` before the rotor early-return).
- [x] **Step 4:** Run the tests — PASS.
- [x] **Step 5:** `pnpm format && pnpm typecheck && pnpm lint && pnpm test`; commit `feat(render): plant window frames, night glow, aviation and yard lamps`.

---

### Task 6: Full checks and the Mac hand-off

- [x] `pnpm format && pnpm typecheck && pnpm lint && pnpm format:check && pnpm coverage && pnpm build` — PASS; record the slowest test under coverage (< ~15 s).
- [x] `node scripts/smoke.mjs` — PASS.
- [x] Add "Results (2026-10-11)" to the spec's Testing section: part count and vertex count per model (table), slowest test; commit `docs: record plant-detail checks`.
- [x] Mac checklist for the user: every plant and service type by day and night at city zoom — recognisable; window frames by day, glow at night, dark without grid; aviation lights blink in sync on turbines and heat stores; yard lamps; plinths on slopes, nothing floating; stations face their track, hydro faces the water; frame time unchanged vs `main`.
