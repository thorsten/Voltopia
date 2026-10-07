# Lighting and Materials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Physically based flat-colour materials, half-resolution GTAO ambient occlusion with a settings switch, no tone mapping and a shadow map that follows the view — without changing any mesh.

**Architecture:** A material factory (`src/render/materials.ts`) replaces every `MeshLambertMaterial`; a `PostChain` (`src/render/postprocessing.ts`) wraps an `EffectComposer` (multisampled target → render pass → lit-only half-resolution GTAO pass → output pass) that `Renderer` renders through; a pure `fitShadowFrustum` (`src/render/shadowFrustum.ts`) places the sun's shadow camera around the visible ground each frame, snapped to shadow texels.

**Tech Stack:** TypeScript strict, three.js 0.186 (`three/addons/postprocessing/*`), React 19, vitest (node environment, no WebGL), pnpm.

**Spec:** `docs/superpowers/specs/2026-10-07-lighting-and-materials-design.md`

## Global Constraints

- Render only: no change under `src/sim/`, `src/shared/messages.ts`, `src/storage/` or `src/agent/`.
- `src/render/` stays three.js only; `src/ui/` strings go through `src/ui/i18n.tsx` with EN **and** DE.
- No magic numbers: every tuning value is a named, commented constant (`SURFACE_ROUGHNESS = 0.9`, `AO_RESOLUTION_SCALE = 0.5`, shadow constants).
- No tone mapping: `THREE.NoToneMapping` (changed from `THREE.NeutralToneMapping` with the user on 2026-10-07 — its toe shifted dark and saturated colours; see the spec's Calibration paragraph). Never ACES.
- Ambient occlusion defaults to **on**; the setting key is `ambientOcclusion`.
- `MeshBasicMaterial` users (overlays, previews, selection, hover, icons, headlights) stay unchanged and must not cast ambient occlusion.
- Vitest runs in node: no WebGL context. Anything needing one is covered by the WebGL e2e on the Mac/CI, not by unit tests. `src/**/*.test.ts` is typechecked with `types: ["vite/client"]` — no `node:` imports in tests; use `import.meta.glob` for source scans.
- Run `pnpm format` after edits; the pre-commit hook (`typecheck && lint && format:check && test`) must pass; never `--no-verify`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Branch `feature/lighting-materials` in this checkout (no worktree: `node_modules` is shared with the Mac).

---

## File map

| File                                                                                                                                                             | Responsibility                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `src/render/materials.ts` (new)                                                                                                                                  | `SURFACE_ROUGHNESS`, `surfaceMaterial(options)`                               |
| `src/render/materials.test.ts` (new)                                                                                                                             | factory behaviour + guard: no `MeshLambertMaterial` under `src/render`        |
| 10 mesh files (`buildingsMesh`, `forestMesh`, `geothermalMesh`, `plantsMesh`, `powerLinesMesh`, `railMesh`, `roadsMesh`, `terrain`, `vehiclesMesh`, `waterMesh`) | call `surfaceMaterial` instead of `new THREE.MeshLambertMaterial`             |
| `src/render/shadowFrustum.ts` (new)                                                                                                                              | `viewGroundCorners`, `fitShadowFrustum`, shadow constants                     |
| `src/render/shadowFrustum.test.ts` (new)                                                                                                                         | fitting, texel snapping, minimum extent, finiteness                           |
| `src/render/postprocessing.ts` (new)                                                                                                                             | `isOcclusionCaster`, `aoSize`, `LitOnlyGTAOPass`, `PostChain`                 |
| `src/render/postprocessing.test.ts` (new)                                                                                                                        | `isOcclusionCaster`, `aoSize`                                                 |
| `src/render/scene.ts`                                                                                                                                            | light constants, tone-mapping exposure constant                               |
| `src/render/renderer.ts`                                                                                                                                         | tone mapping, `PostChain` wiring, `setAmbientOcclusion`, per-frame shadow fit |
| `src/ui/settings.ts`, `src/ui/settings.test.ts` (new)                                                                                                            | `ambientOcclusion` setting                                                    |
| `src/ui/SettingsPage.tsx`, `src/ui/App.tsx`, `src/ui/i18n.tsx`                                                                                                   | checkbox, wiring, strings                                                     |
| `e2e/game.spec.ts`                                                                                                                                               | the AO checkbox toggles and persists                                          |

---

### Task 0: Branch

- [x] **Step 1:** `git checkout -b feature/lighting-materials` — Expected: `Switched to a new branch 'feature/lighting-materials'`.

---

### Task 1: Material factory replaces Lambert everywhere

**Files:**

- Create: `src/render/materials.ts`, `src/render/materials.test.ts`
- Modify: `src/render/buildingsMesh.ts:119`, `src/render/forestMesh.ts:59,77,89`, `src/render/geothermalMesh.ts:57`, `src/render/plantsMesh.ts:481,493,505,517`, `src/render/powerLinesMesh.ts:43,55`, `src/render/railMesh.ts:158`, `src/render/roadsMesh.ts:75,99,110,144,170,184`, `src/render/terrain.ts:41,57`, `src/render/vehiclesMesh.ts:118,134,146,158,170,182,194`, `src/render/waterMesh.ts:54,70` (line numbers as of `fb86d8a`; grep `MeshLambertMaterial` to find them)

**Interfaces:**

- Produces: `SURFACE_ROUGHNESS: number` (0.9), `type SurfaceOptions = Omit<THREE.MeshStandardMaterialParameters, 'roughness' | 'metalness'>`, `surfaceMaterial(options?: SurfaceOptions): THREE.MeshStandardMaterial`.

- [x] **Step 1: Failing tests** — `src/render/materials.test.ts`:

```ts
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { SURFACE_ROUGHNESS, surfaceMaterial } from './materials.ts';

describe('surfaceMaterial', () => {
  it('is a rough, non-metallic standard material', () => {
    const m = surfaceMaterial({ color: 0x336699 });
    expect(m).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(m.roughness).toBe(SURFACE_ROUGHNESS);
    expect(m.metalness).toBe(0);
    expect(m.color.getHex()).toBe(0x336699);
  });

  it('passes emissive, transparency, vertex colours and side through', () => {
    const m = surfaceMaterial({
      color: 0xffffff,
      emissive: 0xffaa00,
      emissiveIntensity: 0.5,
      transparent: true,
      opacity: 0.4,
      vertexColors: true,
      side: THREE.DoubleSide,
    });
    expect(m.emissive.getHex()).toBe(0xffaa00);
    expect(m.emissiveIntensity).toBe(0.5);
    expect(m.transparent).toBe(true);
    expect(m.opacity).toBe(0.4);
    expect(m.vertexColors).toBe(true);
    expect(m.side).toBe(THREE.DoubleSide);
  });

  it('works without options (instanced colours set the colour later)', () => {
    expect(surfaceMaterial().color.getHex()).toBe(0xffffff);
  });
});

describe('render materials', () => {
  it('no render module constructs a Lambert material any more', () => {
    const sources = import.meta.glob(
      ['./*.ts', './buildings/*.ts', '!./*.test.ts', '!./buildings/*.test.ts'],
      {
        query: '?raw',
        import: 'default',
        eager: true,
      },
    ) as Record<string, string>;
    expect(Object.keys(sources).length).toBeGreaterThan(10);
    const offenders = Object.entries(sources)
      .filter(([, text]) => text.includes('MeshLambertMaterial'))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
```

- [x] **Step 2:** `pnpm vitest run src/render/materials.test.ts` — Expected: FAIL (`./materials.ts` missing).

- [x] **Step 3: Factory** — `src/render/materials.ts`:

```ts
import * as THREE from 'three';

/**
 * Roughness of every lit surface: high enough that the flat low-poly
 * colours read as matte paint, not plastic. Shared so a later tuning
 * round changes one number.
 */
export const SURFACE_ROUGHNESS = 0.9;

export type SurfaceOptions = Omit<THREE.MeshStandardMaterialParameters, 'roughness' | 'metalness'>;

/**
 * The one material for lit, opaque-or-tinted surfaces: a physically
 * based standard material with flat colour, high roughness and no
 * metal. It replaces MeshLambertMaterial so the scene responds to the
 * tone curve and the ambient-occlusion pass consistently. Unlit helpers
 * (overlays, previews, icons, headlights) keep MeshBasicMaterial.
 */
export function surfaceMaterial(options: SurfaceOptions = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    ...options,
    roughness: SURFACE_ROUGHNESS,
    metalness: 0,
  });
}
```

- [x] **Step 4: Replace every Lambert construction.** In each file listed, `new THREE.MeshLambertMaterial(X)` becomes `surfaceMaterial(X)` (and `new THREE.MeshLambertMaterial()` becomes `surfaceMaterial()`), with `import { surfaceMaterial } from './materials.ts';` added. Field and generic types change from `THREE.MeshLambertMaterial` to `THREE.MeshStandardMaterial` (`forestMesh.ts:59` `crownMaterial`, `terrain.ts:41` `ground`, `waterMesh.ts:54` `material`). Options stay exactly as they are. After the edit, `grep -rn MeshLambertMaterial src/render` prints nothing.

- [x] **Step 5:** `pnpm vitest run src/render && pnpm typecheck` — Expected: PASS. Then `pnpm test` once.

- [x] **Step 6: Commit**

```bash
pnpm format
git add src/render
git commit -m "feat(render): physically based surface material replaces Lambert

surfaceMaterial() returns a rough (0.9), non-metallic standard material;
all ten lit render modules use it, unlit helpers keep MeshBasicMaterial.
A guard test keeps Lambert out of src/render.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Shadow frustum that follows the view

**Files:**

- Create: `src/render/shadowFrustum.ts`, `src/render/shadowFrustum.test.ts`
- Modify: `src/render/scene.ts:33-44`, `src/render/renderer.ts` (environment update ~400-423, render loop ~742-758)

**Interfaces:**

- Produces: `interface Vec3 { x: number; y: number; z: number }`; `interface ShadowFit { position: Vec3; target: Vec3; halfWidth: number; halfHeight: number; far: number }`; `fitShadowFrustum(input: { points: readonly Vec3[]; sunDirection: Vec3; mapSize: number; margin: number; minHalfExtent: number; depthPadding: number }): ShadowFit`; `viewGroundCorners(camera: THREE.OrthographicCamera, minY: number, maxY: number): Vec3[]` (8 points); constants `SHADOW_MAP_SIZE = 2048`, `SHADOW_MARGIN_TILES = 4`, `SHADOW_MIN_HALF_EXTENT = 6`, `SHADOW_DEPTH_PADDING = 20`, `SHADOW_VIEW_MIN_Y = 0`, `SHADOW_VIEW_MAX_Y = 8 * LEVEL_HEIGHT + 3` (highest terrain level 7 plus a tall building, with headroom).

- [x] **Step 1: Failing tests** — `src/render/shadowFrustum.test.ts`:

```ts
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { fitShadowFrustum, viewGroundCorners, type Vec3 } from './shadowFrustum.ts';

const MAP = 2048;
const base = { mapSize: MAP, margin: 2, minHalfExtent: 4, depthPadding: 10 };
const down: Vec3 = { x: 0, y: -1, z: 0 };

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
```

- [x] **Step 2:** `pnpm vitest run src/render/shadowFrustum.test.ts` — Expected: FAIL (module missing).

- [x] **Step 3: Implementation** — `src/render/shadowFrustum.ts`:

```ts
import * as THREE from 'three';
import { LEVEL_HEIGHT } from './elevationField.ts';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface ShadowFit {
  /** Where the directional light sits (target minus the sun direction times the depth). */
  position: Vec3;
  /** What it looks at: the snapped centre of the view in light space. */
  target: Vec3;
  halfWidth: number;
  halfHeight: number;
  /** Shadow camera far plane (near is 0). */
  far: number;
}

/** Shadow map edge in texels (unchanged from before the follow-the-view change). */
export const SHADOW_MAP_SIZE = 2048;
/** Tiles around the view that still cast shadows into it. */
export const SHADOW_MARGIN_TILES = 4;
/** Smallest half extent of the shadow camera, so extreme zoom-in cannot degenerate. */
export const SHADOW_MIN_HALF_EXTENT = 6;
/** Extra depth in front of and behind the view box, so tall objects outside it still cast. */
export const SHADOW_DEPTH_PADDING = 20;
/** Height band of the visible ground: sea level to the highest terrain plus a tall building. */
export const SHADOW_VIEW_MIN_Y = 0;
export const SHADOW_VIEW_MAX_Y = 8 * LEVEL_HEIGHT + 3;
/** Extents are rounded up to whole tiles, so panning at one zoom keeps the texel size fixed. */
const EXTENT_STEP = 1;

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

/**
 * Fit an orthographic shadow camera around `points` (the visible part
 * of the map) as seen along `sunDirection` (pointing from the sun into
 * the scene). The rectangle covers every point plus `margin`, its half
 * extents are rounded up to whole tiles and never below
 * `minHalfExtent`, and its centre is snapped to whole shadow texels so
 * shadow edges do not crawl while the camera pans.
 */
export function fitShadowFrustum(input: {
  points: readonly Vec3[];
  sunDirection: Vec3;
  mapSize: number;
  margin: number;
  minHalfExtent: number;
  depthPadding: number;
}): ShadowFit {
  const f = normalize(input.sunDirection);
  const ref: Vec3 = Math.abs(f.y) > 0.99 ? { x: 0, y: 0, z: -1 } : { x: 0, y: 1, z: 0 };
  const r = normalize(cross(ref, f));
  const u = cross(f, r);
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  for (const p of input.points) {
    const px = dot(p, r),
      py = dot(p, u),
      pz = dot(p, f);
    minX = Math.min(minX, px);
    maxX = Math.max(maxX, px);
    minY = Math.min(minY, py);
    maxY = Math.max(maxY, py);
    minZ = Math.min(minZ, pz);
    maxZ = Math.max(maxZ, pz);
  }
  const roundUp = (v: number) => Math.ceil(v / EXTENT_STEP) * EXTENT_STEP;
  const halfWidth = Math.max(input.minHalfExtent, roundUp((maxX - minX) / 2 + input.margin));
  const halfHeight = Math.max(input.minHalfExtent, roundUp((maxY - minY) / 2 + input.margin));
  const texelX = (2 * halfWidth) / input.mapSize;
  const texelY = (2 * halfHeight) / input.mapSize;
  const cx = Math.round((minX + maxX) / 2 / texelX) * texelX;
  const cy = Math.round((minY + maxY) / 2 / texelY) * texelY;
  const cz = (minZ + maxZ) / 2;
  const target: Vec3 = {
    x: r.x * cx + u.x * cy + f.x * cz,
    y: r.y * cx + u.y * cy + f.y * cz,
    z: r.z * cx + u.z * cy + f.z * cz,
  };
  const depth = (maxZ - minZ) / 2 + input.depthPadding;
  return {
    target,
    position: { x: target.x - f.x * depth, y: target.y - f.y * depth, z: target.z - f.z * depth },
    halfWidth,
    halfHeight,
    far: 2 * depth,
  };
}

const ndc = new THREE.Vector3();
const near = new THREE.Vector3();
const farPoint = new THREE.Vector3();

/**
 * The eight corners of what the orthographic camera sees between the
 * heights `minY` and `maxY`: each frustum-corner ray (near to far plane)
 * intersected with both horizontal planes.
 */
export function viewGroundCorners(
  camera: THREE.OrthographicCamera,
  minY: number,
  maxY: number,
): Vec3[] {
  camera.updateMatrixWorld();
  const out: Vec3[] = [];
  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ] as const) {
    near.copy(ndc.set(sx, sy, -1)).unproject(camera);
    farPoint.copy(ndc.set(sx, sy, 1)).unproject(camera);
    const dy = farPoint.y - near.y;
    for (const y of [minY, maxY]) {
      const t = Math.abs(dy) < 1e-9 ? 0 : (y - near.y) / dy;
      out.push({ x: near.x + (farPoint.x - near.x) * t, y, z: near.z + (farPoint.z - near.z) * t });
    }
  }
  return out;
}
```

(`pnpm format` will re-flow the compact `let` and loop lines; keep the logic.) For a straight-down sun the basis is `ref = (0, 0, -1)`, `f = (0, -1, 0)`, `r = cross(ref, f) = (-1, 0, 0)`, `u = (0, 0, 1)`; the test's `inside()` compares absolute offsets in x and z, so the sign of `r` does not matter.

- [x] **Step 4:** `pnpm vitest run src/render/shadowFrustum.test.ts` — Expected: PASS.

- [x] **Step 5: Wire it into the renderer.**

`src/render/scene.ts`: replace the fixed frustum lines (`sun.shadow.camera.left = -60` … `far = 300`) with `sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);` (import from `./shadowFrustum.ts`); keep `bias`; the frustum is set per frame now.

`src/render/renderer.ts`:

- Field: `private readonly sunDirection = new THREE.Vector3(0, -1, 0);`
- In the environment update (where `this.lights.sun.position.set(...)` and `sun.target.position.set(center, 0, center)` are today): compute the same position into a local `const sunPosition = new THREE.Vector3(...)` with the unchanged formula, set `this.sunDirection.set(center, 0, center).sub(sunPosition).normalize()`, and **remove** the two `sun.position.set` / `sun.target.position.set` lines (the frame loop places the sun now).
- New method, called in `renderLoop` right before the draw call:

```ts
  /** Place the sun and its shadow camera around what the camera sees (cheap: 8 points). */
  private fitShadowToView(): void {
    const fit = fitShadowFrustum({
      points: viewGroundCorners(this.isoCamera.camera, SHADOW_VIEW_MIN_Y, SHADOW_VIEW_MAX_Y),
      sunDirection: this.sunDirection,
      mapSize: SHADOW_MAP_SIZE,
      margin: SHADOW_MARGIN_TILES,
      minHalfExtent: SHADOW_MIN_HALF_EXTENT,
      depthPadding: SHADOW_DEPTH_PADDING,
    });
    const { sun } = this.lights;
    sun.position.set(fit.position.x, fit.position.y, fit.position.z);
    sun.target.position.set(fit.target.x, fit.target.y, fit.target.z);
    sun.target.updateMatrixWorld();
    const cam = sun.shadow.camera;
    cam.left = -fit.halfWidth;
    cam.right = fit.halfWidth;
    cam.top = fit.halfHeight;
    cam.bottom = -fit.halfHeight;
    cam.near = 0;
    cam.far = fit.far;
    cam.updateProjectionMatrix();
  }
```

It runs regardless of the shadows setting: the sun's direction drives the shading too.

- [x] **Step 6:** `pnpm vitest run src/render && pnpm typecheck`, then `pnpm test`. Commit:

```bash
pnpm format
git add src/render
git commit -m "feat(render): shadow camera follows the view, snapped to texels

fitShadowFrustum places the sun's orthographic shadow camera around the
visible ground plus a margin each frame, with whole-tile extents and a
texel-snapped centre so shadows stay sharp when zoomed in and do not
crawl while panning. Replaces the fixed ±60-tile frustum.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Post chain — multisampling, lit-only half-resolution GTAO, neutral tone mapping

**Files:**

- Create: `src/render/postprocessing.ts`, `src/render/postprocessing.test.ts`
- Modify: `src/render/renderer.ts` (constructor ~268-272, `handleResize` ~734-738, `renderLoop` draw call ~755, `dispose` ~829-836), `src/render/scene.ts`

**Interfaces:**

- Consumes: nothing from Tasks 1–2 beyond the renderer they touched.
- Produces: `AO_RESOLUTION_SCALE = 0.5`; `isOcclusionCaster(object: THREE.Object3D): boolean`; `aoSize(width: number, height: number): { width: number; height: number }`; `class PostChain { constructor(webgl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera); setSize(width: number, height: number, pixelRatio: number): void; setAmbientOcclusion(enabled: boolean): void; render(): void; dispose(): void }`; `Renderer.setAmbientOcclusion(enabled: boolean): void`; in `scene.ts` `TONE_MAPPING_EXPOSURE = 1`.

- [x] **Step 1: Failing tests** — `src/render/postprocessing.test.ts` (import only the pure helpers; `GTAOPass` is imported by the module but not instantiated, which is fine headless):

```ts
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { AO_RESOLUTION_SCALE, aoSize, isOcclusionCaster } from './postprocessing.ts';

describe('isOcclusionCaster', () => {
  const box = new THREE.BoxGeometry();
  it('counts lit opaque meshes and instanced meshes', () => {
    expect(isOcclusionCaster(new THREE.Mesh(box, new THREE.MeshStandardMaterial()))).toBe(true);
    expect(
      isOcclusionCaster(new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial(), 3)),
    ).toBe(true);
  });
  it('skips unlit helpers and transparent surfaces', () => {
    expect(isOcclusionCaster(new THREE.Mesh(box, new THREE.MeshBasicMaterial()))).toBe(false);
    expect(
      isOcclusionCaster(
        new THREE.Mesh(box, new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.5 })),
      ),
    ).toBe(false);
    expect(isOcclusionCaster(new THREE.Group())).toBe(false);
  });
  it('a mesh with several materials casts if any is lit and opaque', () => {
    const mixed = new THREE.Mesh(box, [
      new THREE.MeshBasicMaterial(),
      new THREE.MeshStandardMaterial(),
    ]);
    expect(isOcclusionCaster(mixed)).toBe(true);
  });
});

describe('aoSize', () => {
  it('scales the drawing buffer by AO_RESOLUTION_SCALE and never drops below one pixel', () => {
    expect(aoSize(1600, 900)).toEqual({
      width: Math.round(1600 * AO_RESOLUTION_SCALE),
      height: Math.round(900 * AO_RESOLUTION_SCALE),
    });
    expect(aoSize(1, 1)).toEqual({ width: 1, height: 1 });
  });
});
```

- [x] **Step 2:** `pnpm vitest run src/render/postprocessing.test.ts` — Expected: FAIL (module missing).

- [x] **Step 3: Implementation** — `src/render/postprocessing.ts`:

```ts
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';

/** Ambient occlusion renders at this share of the drawing buffer, then blends at full size. */
export const AO_RESOLUTION_SCALE = 0.5;
/** Multisampling of the composer's target: replaces the WebGLRenderer antialias flag. */
const MSAA_SAMPLES = 4;
/** GTAO tuning (world units are tiles): starting values, tuned on the Mac. */
const AO_RADIUS = 0.6;
const AO_DISTANCE_EXPONENT = 1;
const AO_THICKNESS = 0.6;
const AO_SCALE = 1;
const AO_SAMPLES = 16;
const AO_BLEND_INTENSITY = 1;

/**
 * Whether a scene object should darken its surroundings: a mesh with at
 * least one lit (non-basic), opaque material. Overlays, previews, the
 * selection cage, icons and headlights use MeshBasicMaterial and water
 * may be transparent — none of them should leave a shadow in the
 * ambient-occlusion pass.
 */
export function isOcclusionCaster(object: THREE.Object3D): boolean {
  const mesh = object as THREE.Mesh;
  if (!mesh.isMesh) return false;
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  return materials.some(
    (m) => m !== undefined && !(m as THREE.MeshBasicMaterial).isMeshBasicMaterial && !m.transparent,
  );
}

/** Size of the ambient-occlusion buffers for a drawing buffer of width × height. */
export function aoSize(width: number, height: number): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(width * AO_RESOLUTION_SCALE)),
    height: Math.max(1, Math.round(height * AO_RESOLUTION_SCALE)),
  };
}

/**
 * GTAOPass that (a) renders its buffers at AO_RESOLUTION_SCALE, (b) hides
 * every non-caster while it renders its normal/depth buffer, and (c)
 * refreshes the camera projection each frame — the isometric camera
 * zooms by changing its projection, which GTAOPass otherwise only picks
 * up on resize.
 */
class LitOnlyGTAOPass extends GTAOPass {
  override setSize(width: number, height: number): void {
    const size = aoSize(width, height);
    super.setSize(size.width, size.height);
  }

  override render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
    deltaTime: number,
    maskActive: boolean,
  ): void {
    const projection = this.camera.projectionMatrix;
    const inverse = this.camera.projectionMatrixInverse;
    this.gtaoMaterial.uniforms.cameraProjectionMatrix.value.copy(projection);
    this.gtaoMaterial.uniforms.cameraProjectionMatrixInverse.value.copy(inverse);
    this.pdMaterial.uniforms.cameraProjectionMatrixInverse.value.copy(inverse);
    const hidden: THREE.Object3D[] = [];
    this.scene.traverse((object) => {
      if (object.visible && (object as THREE.Mesh).isMesh && !isOcclusionCaster(object)) {
        object.visible = false;
        hidden.push(object);
      }
    });
    try {
      super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
    } finally {
      for (const object of hidden) object.visible = true;
    }
  }
}
```

Caveat for the implementer: hiding non-casters for the whole `super.render` also hides them in its final blend only if the blend re-renders the scene — it does not (it composites `readBuffer`, which the RenderPass already drew with everything visible), so overlays still appear on screen. Verify this by reading `GTAOPass.render` in `node_modules/three/examples/jsm/postprocessing/GTAOPass.js` (`_renderOverride` for the G-buffer, `_renderPass` full-screen quads afterwards). If the types for `render`'s parameters differ in `@types/three` 0.186, match them.

Continue the file:

```ts
/**
 * The frame pipeline: scene into a multisampled target, ambient
 * occlusion (optional), then tone mapping and sRGB conversion. The
 * renderer's toneMapping/exposure settings apply in the OutputPass.
 */
export class PostChain {
  private readonly composer: EffectComposer;
  private readonly ao: LitOnlyGTAOPass;

  constructor(webgl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    const size = webgl.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(Math.max(1, size.x), Math.max(1, size.y), {
      type: THREE.HalfFloatType,
      samples: MSAA_SAMPLES,
    });
    this.composer = new EffectComposer(webgl, target);
    this.composer.addPass(new RenderPass(scene, camera));
    const ao = aoSize(size.x, size.y);
    this.ao = new LitOnlyGTAOPass(scene, camera, ao.width, ao.height);
    this.ao.updateGtaoMaterial({
      radius: AO_RADIUS,
      distanceExponent: AO_DISTANCE_EXPONENT,
      thickness: AO_THICKNESS,
      scale: AO_SCALE,
      samples: AO_SAMPLES,
    });
    this.ao.blendIntensity = AO_BLEND_INTENSITY;
    this.composer.addPass(this.ao);
    this.composer.addPass(new OutputPass());
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
  }

  setAmbientOcclusion(enabled: boolean): void {
    this.ao.enabled = enabled;
  }

  render(): void {
    this.composer.render();
  }

  dispose(): void {
    this.ao.dispose();
    this.composer.dispose();
  }
}
```

(`updateGtaoMaterial`'s accepted keys in 0.186: check `GTAOPass.js` lines ~374-426 and drop any key it does not read.)

- [x] **Step 4:** `pnpm vitest run src/render/postprocessing.test.ts` — Expected: PASS.

- [x] **Step 5: Wire the renderer and the tone curve.**

`src/render/scene.ts`: add

```ts
/** Exposure for NeutralToneMapping; 1 keeps the palette's brightness (tuned on the Mac). */
export const TONE_MAPPING_EXPOSURE = 1;
```

and move today's light numbers in `renderer.ts` into named exports beside it without changing their values:

```ts
/** Sun intensity = (SUN_BASE + SUN_GAIN * sunFactor) * cloud dimming. */
export const SUN_INTENSITY_BASE = 0.15;
export const SUN_INTENSITY_GAIN = 1.6;
/** Hemisphere intensity = AMBIENT_BASE + AMBIENT_GAIN * sunFactor. */
export const AMBIENT_INTENSITY_BASE = 0.35;
export const AMBIENT_INTENSITY_GAIN = 0.65;
```

`src/render/renderer.ts`:

- Constructor, after the `WebGLRenderer` is created: `this.webgl.toneMapping = THREE.NeutralToneMapping; this.webgl.toneMappingExposure = TONE_MAPPING_EXPOSURE;`. Keep `antialias: true` on the renderer (harmless; the composer's MSAA target does the work).
- After `this.isoCamera` and the renderer exist: `this.postChain = new PostChain(this.webgl, this.scene, this.isoCamera.camera);` with a `private readonly postChain: PostChain;` field.
- `handleResize`: after `this.webgl.setSize(width, height);` add `this.postChain.setSize(width, height, this.webgl.getPixelRatio());`. Make sure `handleResize` is called once after construction (it is today; confirm) so the composer gets the real size.
- `renderLoop`: replace `this.webgl.render(this.scene, this.isoCamera.camera);` with `this.postChain.render();` (after `this.fitShadowToView()` from Task 2).
- `dispose`: `this.postChain.dispose();` before `this.webgl.dispose();`.
- New public method:

```ts
  /** Toggle the ambient-occlusion pass (quality setting). */
  setAmbientOcclusion(enabled: boolean): void {
    this.postChain.setAmbientOcclusion(enabled);
  }
```

- The light update uses the new constants: `(SUN_INTENSITY_BASE + SUN_INTENSITY_GAIN * sunFactor) * cloudDimming` and `AMBIENT_INTENSITY_BASE + AMBIENT_INTENSITY_GAIN * sunFactor`.

- [x] **Step 6:** `pnpm vitest run src/render && pnpm typecheck && pnpm build` — Expected: PASS (the build proves the `three/addons` imports resolve). Then `pnpm test`. Commit:

```bash
pnpm format
git add src/render
git commit -m "feat(render): post chain with half-resolution ambient occlusion and neutral tone mapping

PostChain renders the scene into a 4x multisampled target, adds GTAO at
half resolution (lit, opaque meshes only, camera projection refreshed
per frame for the zoom) and finishes with NeutralToneMapping and sRGB
output. Light intensities move into named constants in scene.ts.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The "Ambient occlusion" setting

**Files:**

- Create: `src/ui/settings.test.ts`
- Modify: `src/ui/settings.ts`, `src/ui/SettingsPage.tsx:107-116`, `src/ui/App.tsx:236`, `src/ui/i18n.tsx` (EN ~416, DE ~1072), `e2e/game.spec.ts:62-72`

**Interfaces:**

- Consumes: `Renderer.setAmbientOcclusion(enabled: boolean)` (Task 3).
- Produces: `AppSettings.ambientOcclusion: boolean`, `DEFAULT_SETTINGS.ambientOcclusion === true`; i18n keys `settings.ambientOcclusion`, `settings.ambientOcclusion.hint`; test id `setting-ambient-occlusion`.

- [x] **Step 1: Failing tests** — `src/ui/settings.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, loadSettings, persistSettings } from './settings.ts';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

describe('settings', () => {
  beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
  afterEach(() => vi.unstubAllGlobals());

  it('ambient occlusion is on by default', () => {
    expect(DEFAULT_SETTINGS.ambientOcclusion).toBe(true);
    expect(loadSettings().ambientOcclusion).toBe(true);
  });

  it('round-trips the ambient occlusion switch', () => {
    persistSettings({ ...DEFAULT_SETTINGS, ambientOcclusion: false });
    expect(loadSettings().ambientOcclusion).toBe(false);
  });

  it('settings stored before the switch existed load with the default', () => {
    localStorage.setItem('voltopia.settings', JSON.stringify({ shadows: false, theme: 'light' }));
    const loaded = loadSettings();
    expect(loaded.ambientOcclusion).toBe(true);
    expect(loaded.shadows).toBe(false);
  });
});
```

- [x] **Step 2:** `pnpm vitest run src/ui/settings.test.ts` — Expected: FAIL (`ambientOcclusion` undefined).

- [x] **Step 3: Implementation.**

`src/ui/settings.ts`: add `ambientOcclusion: boolean;` after `shadows` in `AppSettings`, `ambientOcclusion: true,` in `DEFAULT_SETTINGS`, and `ambientOcclusion: parsed.ambientOcclusion ?? DEFAULT_SETTINGS.ambientOcclusion,` in `loadSettings`.

`src/ui/SettingsPage.tsx`, directly after the shadows label:

```tsx
<label className="settings-row" title={t('settings.ambientOcclusion.hint')}>
  <input
    type="checkbox"
    data-testid="setting-ambient-occlusion"
    checked={settings.ambientOcclusion}
    onChange={(e) => update({ ambientOcclusion: e.target.checked })}
  />
  <span>{t('settings.ambientOcclusion')}</span>
</label>
```

`src/ui/App.tsx`, after `rendererRef.current?.setShadows(settings.shadows);`:

```ts
rendererRef.current?.setAmbientOcclusion(settings.ambientOcclusion);
```

`src/ui/i18n.tsx` EN after `'settings.shadows': 'Shadows',`:

```ts
  'settings.ambientOcclusion': 'Ambient occlusion',
  'settings.ambientOcclusion.hint': 'Soft shading in corners and under objects. Turn off if the game stutters.',
```

DE after `'settings.shadows': 'Schatten',`:

```ts
  'settings.ambientOcclusion': 'Umgebungsverdeckung',
  'settings.ambientOcclusion.hint': 'Weiche Schatten in Ecken und unter Objekten. Ausschalten, wenn das Spiel ruckelt.',
```

`e2e/game.spec.ts`, in `settings page toggles persist`: click `setting-ambient-occlusion` next to the shadows click and, after the reload, `await expect(page.getByTestId('setting-ambient-occlusion')).not.toBeChecked();` (the sandbox cannot run Playwright; the Mac and CI do).

- [x] **Step 4:** `pnpm vitest run src/ui && pnpm typecheck` — Expected: PASS; then `pnpm test`. Commit:

```bash
pnpm format
git add src/ui e2e
git commit -m "feat(ui): ambient occlusion setting, on by default

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Full checks and the Mac acceptance hand-off

- [x] **Step 1:** `pnpm format && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm coverage && pnpm build` — Expected: all PASS; coverage ≥ 90 % on `src/sim` + `src/shared` (untouched).
- [x] **Step 2: Tick-cost guard (see the CI incident of 2026-10-06):** this change is render-only, so `stepTick` cost is unchanged by construction; confirm with `git diff --stat main -- src/sim` → empty.
- [x] **Step 3: Hand-off checklist for the user (Mac):**
  1. `pnpm e2e` (WebGL test, settings toggles) and `node scripts/smoke.mjs`.
  2. Same save, screenshots before (main) and after at noon, dusk and night; AO on and off.
  3. Brightness and colours match the old palette; if the scene is darker or washed out, report it — the knobs are `TONE_MAPPING_EXPOSURE`, `SUN_INTENSITY_*`, `AMBIENT_INTENSITY_*` in `src/render/scene.ts`.
  4. AO strength and radius look right on buildings, trees and under vehicles; knobs `AO_*` in `src/render/postprocessing.ts`. No grey halos around overlays, the hover marker or icons.
  5. Shadows sharp when zoomed in, no crawling edges while panning, nothing missing at the screen border; at sunrise/sunset long shadows still reach in from just outside the view (knob `SHADOW_MARGIN_TILES`).
  6. Frame time (browser performance panel or the HUD's FPS if present) at 64×64 and 96×96, AO on and off. Target: 96×96 with AO under 16.7 ms; if not, set `AO_RESOLUTION_SCALE` to 1/3 first.
- [x] **Step 4:** Record the measured frame times and the final constants in the spec's Testing section once the user reports them (a follow-up commit after the Mac round).
