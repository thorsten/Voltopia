# Infrastructure Detail (5b) Implementation Plan

> **For agentic workers:** execute task by task; steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lattice pylons and concrete poles with three sagging conductors; kerbs, zebra crossings and new lamps on roads; sleepers and occupancy signals on the railway — render-only.

**Architecture:** Model builders in `src/render/infrastructure/` (pure, testable); the existing layers `powerLinesMesh.ts`, `roadsMesh.ts`, `railMesh.ts` draw them with `GrowingMesh` and bounded uploads.

**Tech Stack:** TypeScript, three.js, vitest.

Spec: `docs/superpowers/specs/2026-10-13-infrastructure-detail-design.md`.

## Global Constraints

- Render-only: no changes under `src/sim`, `src/shared`, `src/storage`, `src/agent`.
- Every new `InstancedMesh`: `frustumCulled = false` with the usual comment.
- New meshes grow on demand via `GrowingMesh` (`src/render/plants/growingMesh.ts`) — no worst-case `gridSize²` allocations for new meshes; bounded uploads (`uploadDrawn`, colour ranges as `GrowingMesh.commit`).
- Models via `src/render/modelKit.ts`, `surfaceMaterial({ vertexColors: true })`; unlit glows stay `MeshBasicMaterial`.
- Shadows: pylons, lamps, signal masts cast; conductors, kerbs, stripes, glows do not.
- Named constants for every reused or tuned value.
- `pnpm format`; `pnpm typecheck && pnpm lint && pnpm test` before every commit; never `--no-verify`.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Keep each test well under 1 s; small maps.

---

### Task 0: Branch

- [x] Commit spec and plan on `main`, then `git checkout -b feature/infrastructure-detail`.

### Task 1: Pylon models

**Files:** create `src/render/infrastructure/pylonModels.ts` + test.

```ts
export type PylonKind = 'lattice' | 'pole';
export const MAX_PARTS_PER_PYLON = 20;
export interface PylonModel {
  geometry: THREE.BufferGeometry; // base y = 0, origin at the foot, arms along local x
  parts: number;
  /** Conductor attachment points (insulator tips), sorted by x ascending. */
  attachments: ReadonlyArray<{ x: number; y: number; z: number }>;
}
export function pylonModel(kind: PylonKind): PylonModel; // cached
```

- [x] Tests: parts ≤ budget; bounding box |x|,|z| ≤ 0.2 (lattice) / 0.12 (pole), height ≈ 0.55 / 0.42 (±0.03); exactly 3 attachments, all y > 0.3, spread along x (distinct x), |z| < 0.02; cached instance.
- [x] Implement; checks; commit `feat(render): lattice pylon and concrete pole models`.

### Task 2: Power lines with three sagging conductors

**Files:** rewrite `src/render/powerLinesMesh.ts`; create `src/render/powerLinesMesh.test.ts`.

- Track `masks`, `tileTypes`, `zones`, `plantTypes` from diffs; rebuild when a line tile's mask, type or zone changes (as today for type).
- Kind: `pole` when tileType is Road or Plant or zone ≠ None, else `lattice`. Position: kerb on roads (`KERB_OFFSET`), centre elsewhere; y = `surfaceY`.
- Yaw (line direction → local z): E/W only → line along x; N/S only → along z; exactly one N/S + one E/W bit → bisector; else along x. Export `pylonYaw(mask): number` for tests.
- Conductors: for E and S bits; world attachment points of both pylons (rotated by yaw). Pair by lateral offset across the span direction (sort each side's three points by their dot product with the span's horizontal normal). For each pair: `CABLE_SEGMENTS = 6` segments along `p(t) = lerp(a, b, t) − (0, 4·CABLE_SAG·t(1−t), 0)`, each a unit box (`CABLE_THICKNESS`) placed at the segment midpoint, yawed and pitched along the segment, scaled to its length. Export `conductorPoints(a, b): Vector3[]` (7 points) for tests.
- Three meshes via `GrowingMesh`: lattice, pole, conductors (no shadow).
- [x] Tests (`powerLinesMesh.test.ts`): kinds per tile type/zone; yaw values; 3-tile straight line → 2 spans × 3 × 6 = 36 segments; each segment's end point equals the next one's start (decompose matrices, ±1e-5); conductor midpoint sag = `CABLE_SAG` below the chord (±1e-6); on a slope (levels 0→2) the conductor end heights differ by the ground rise; at a corner the three conductors' horizontal projections do not intersect; conductors `castShadow === false`; changing a line tile's zone switches lattice ↔ pole.
- [x] Implement; checks; commit `feat(render): pylons with three sagging conductors`.

### Task 3: Kerbs and zebra crossings

**Files:** create `src/render/infrastructure/roadFurniture.ts` + test; modify `src/render/roadsMesh.ts`.

```ts
export interface FlatPiece {
  cx: number;
  cz: number;
  sizeX: number;
  sizeZ: number;
} // tile-local offsets from the tile centre
export function kerbPieces(mask: number, padSize: number): FlatPiece[];
export function zebraPieces(mask: number, padSize: number): FlatPiece[]; // [] unless 3+ bits
```

- Kerbs: pad sides without an arm (length `padSize`), both long sides of every arm (length `armLength = (1 − padSize)/2`), each `KERB_WIDTH = 0.03` wide, centred on the edge line inset by `KERB_WIDTH/2`. Zebra: per connected arm, `ZEBRA_STRIPES = 4` stripes `ZEBRA_STRIPE_WIDTH = 0.04` across the arm width with equal gaps, length `ZEBRA_LENGTH = 0.12` along the traffic, centred in the arm.
- `RoadsMesh`: two new `GrowingMesh` meshes (kerbs `KERB_COLOR = 0xc9c6bd` surface material, height `ROAD_HEIGHT + KERB_RISE` from the ground; stripes `LINE_COLOR` at `LINE_HEIGHT` on the road like the centre line); `composeBoxOnGround` for land tiles; nothing on bridge tiles. No shadows.
- [x] Tests: straight E–W street: kerbs only along north/south sides (pieces on both long sides of both arms + pad N/S sides), none crossing x-edges; dead end (E only): the pad's W, N, S sides; T-junction: 3 × 4 zebra stripes, straight: none; every piece inside the tile (|cx| + sizeX/2 ≤ 0.5); avenue pad size widens the pieces; `RoadsMesh` counts kerbs/stripes for a small map and draws none on a bridge tile.
- [x] Implement; checks; commit `feat(render): kerbs and zebra crossings`.

### Task 4: New streetlamps

**Files:** `src/render/infrastructure/roadFurniture.ts` (+ test), `src/render/roadsMesh.ts`.

- `lampModel(): { geometry; parts; head: {x, y, z} }` — pole (≈ 0.3 high), arm of two boxes reaching `LAMP_REACH = 0.18` along local +x, housing at the tip, `head` = glow position under the housing. Base y = 0.
- `RoadsMesh.rebuildLamps`: same tiles/corner as today; yaw so local +x points from the lamp foot to the tile centre; poles mesh uses the model (vertex colours, casts shadow); the glow head instance at the rotated `head`. Night behaviour unchanged.
- [x] Tests: lamp model base y = 0, head above 0.25 and at x ≥ LAMP_REACH − 0.02; in `RoadsMesh` a lamp head lies closer to the tile centre than its pole foot.
- [x] Implement; checks; commit `feat(render): streetlamps with an arm over the road`.

### Task 5: Sleepers

**Files:** `src/render/railMesh.ts`, `src/render/railMesh.test.ts`.

- Build the ballasted half segment from `modelKit` boxes (ballast `BALLAST_COLOR`, rails `RAIL_COLOR`, `SLEEPERS_PER_HALF = 3` sleepers `SLEEPER_COLOR = 0x5a4632`, `SLEEPER_LENGTH = 0.26`, `SLEEPER_WIDTH = 0.05`, `SLEEPER_HEIGHT = 0.015`, spaced evenly over the half, on the ballast under the rails), material with `vertexColors: true` and white colour. Same footprint and rail height as today (rails raised by `SLEEPER_HEIGHT` only if needed so rails rest on sleepers — keep train height unchanged: lift the ballast-to-rail stack within today's total height).
- Road-crossing segments unchanged.
- [x] Tests: the ballasted segment has a color attribute and its vertex colours include `SLEEPER_COLOR`; total height of the segment geometry unchanged vs. today (pin the value); existing rail tests green.
- [x] Implement; checks; commit `feat(render): sleepers under the rails`.

### Task 6: Occupancy signals

**Files:** create `src/render/infrastructure/railSignals.ts` + test; modify `src/render/railMesh.ts`.

```ts
export const SIGNAL_BLOCK_TILES = 1.5;
export function signalTiles(masks: Uint8Array, tileTypes: Uint8Array, terrains: Uint8Array, plantTypes: Uint8Array, gridSize: number): number[];
export function blockOccupied(tile: number, gridSize: number, vehicles: ReadonlyArray<{ x: number; y: number }>): boolean;
export class RailSignals { constructor(scene: THREE.Scene); rebuild(...); setVehicles(...); setNight(nightFactor: number); update(): void; }
```

- `signalTiles`: track tiles not on a road or river that 4-border a TrainStation, FreightTerminal or RailYard plant tile, or have 3+ connection bits.
- Mast model (`modelKit`: mast ≈ 0.32, head box, hood) in a `GrowingMesh`, placed `SIGNAL_OFFSET = 0.25` beside the track (straight along x → +z side; along z → +x side; other → (+x, +z) diagonal), yawed to face along the track; lamp spheres (`MeshBasicMaterial`, transparent) in a `GrowingMesh` with instance colours `SIGNAL_GREEN = 0x3ddc84`, `SIGNAL_RED = 0xe0402c`; opacity `SIGNAL_DAY_OPACITY = 0.45 + (1 − 0.45)·night`.
- `blockOccupied`: any vehicle with max(|x − (tx+0.5)|, |y − (ty+0.5)|) ≤ SIGNAL_BLOCK_TILES. Check vehicle coordinates convention in `RailMesh.setTrains`/`crossingIsClosed` (tile centres) and match it.
- `RailMesh`: record `plantType` per tile; `setTrains` also stores all rail vehicles (Locomotive, Wagon, FreightLocomotive, FreightWagon) for `signals.setVehicles`; `rebuild` calls `signals.rebuild`; `setEnvironment` → `setNight`; `update` → `signals.update()` which recomputes aspects and uploads colours only when one changed.
- [ ] Tests: signal at a station neighbour and at a junction; none on a plain straight, a road crossing or a bridge; wagon within the block → red, leaves → green; second `update` without change does not bump the colour attribute version; day opacity 0.45, night 1; masts cast shadow, lamps do not.
- [ ] Implement; checks; commit `feat(render): line-side signals that show occupancy`.

### Task 7: Review, full checks, Mac hand-off

- [ ] Independent review of the branch; fix findings (one commit each).
- [ ] `pnpm format:check && pnpm lint && pnpm coverage && pnpm build` — PASS; record the slowest test; temporary probe for instance/triangle counts on a generated 128² city (deleted afterwards).
- [ ] "Results (2026-10-13)" in the spec; tick the plan; commit `docs: record infrastructure-detail checks`.
- [ ] Mac checklist (see spec "Acceptance").
