# Building Detail (stage 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Plinths, consistent roof overhangs with ridge caps and gutters, framed windows visible by day, and one or two new silhouettes per zone and density — inside the existing recipe system.

**Architecture:** `recipes.ts` gains a 16-part budget, a `ShedRoof` primitive and shared detail helpers; every recipe chooses a silhouette with one draw after its colours. A new `windows.ts` builds a merged, vertex-coloured window; `buildingsMesh.ts` draws it as a lit `windowFrames` mesh on the existing window layout, while the night glow quads stay.

**Tech Stack:** TypeScript strict, three.js 0.186, vitest (node, no WebGL), pnpm.

**Spec:** `docs/superpowers/specs/2026-10-09-building-detail-design.md`

## Global Constraints

- Render only: no change under `src/sim/`, `src/shared/` (types), `src/storage/`, `src/agent/`.
- `MAX_PARTS_PER_TILE = 16`; `MAX_PARTS_PER_KIND = { Box: 12, GableRoof: 3, HipRoof: 2, Cylinder: 3, ShedRoof: 2 }`; `PartKind.ShedRoof = 4`.
- Every recipe/silhouette: footprint inside `FOOTPRINT_HALF` (0.43), `oy ≥ 0`, exactly one `main` Box with `turn 0` and no tilt, `buildingHeight` = tallest top, commercial d3 the tallest recipe, ≤ `MAX_PUFF_ANCHORS_PER_TILE` (2) puff anchors, roles only where stage 2 expects them (residential d1 chimney, commercial d2–d3 antenna, retail d3 two vents, industrial chimney), tagged parts never turned or tilted, residential door on the street face with `turn === face`.
- Deterministic: all randomness through the recipe's `Picker`; the silhouette is the first draw after the three colour draws.
- Named constants only (`PLINTH_HEIGHT = 0.04`, `PLINTH_OVERHANG = 0.008`, `RIDGE_CAP = { w: 0.02, h: 0.015 }`, `GUTTER = { w: 0.015, h: 0.015 }`, `WINDOW_PROUD = 0.004`, `ROOF_OVERHANG`, …). One-off part coordinates inside a recipe are geometry data.
- Every new `InstancedMesh`: `frustumCulled = false`; lit meshes use `surfaceMaterial(...)` from `src/render/materials.ts`.
- Each single test stays under ~15 s locally under `pnpm coverage` (CLAUDE.md, CI budget); split heavy grid sweeps if needed.
- `pnpm format` after edits; the pre-commit hook must pass; never `--no-verify`. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Branch `feature/building-detail` in this checkout.

---

### Task 0: Branch

- [x] `git checkout -b feature/building-detail`

---

### Task 1: Budget, ShedRoof, palette fields and shared details on the existing recipes

**Files:** `src/render/buildings/primitives.ts`, `recipes.ts`, `palette.ts`, `primitives.test.ts` (create if missing), `recipes.test.ts`, `src/render/buildingsMesh.test.ts`

**Interfaces — produces:** `PartKind.ShedRoof = 4` (in `PART_KINDS`); the budget constants above; `ZoneFamily.plinth: THREE.Color`; `ACCENT.gutter`; `recipes.ts` helpers `plinth(body, family): BuildingPart`, `ridgeCap(roof, color): BuildingPart`, `gutters(roof): BuildingPart[]` (both eaves of a gable, honouring the roof's `turn`), named constants above; `isDetailPart(part)` exported for tests: true for plinths, ridge caps and gutters (mark them with a new optional `BuildingPart.detail?: 'plinth' | 'ridge' | 'gutter'` field so tests and heuristics can skip them).

- [x] **Step 1: Tests first.**
  - `primitives.test.ts`: `createPartGeometry(PartKind.ShedRoof)` bounding box is x,z ∈ [−0.5, 0.5], y ∈ [0, 1]; the vertices at y = 1 all have z = −0.5 and those at y = 0 on the top surface have z = +0.5; normals are unit length.
  - `recipes.test.ts`: update the budget test to the new constants and run it over all four faces (not South only) — if the full-grid × faces sweep exceeds ~15 s locally, split it per zone into separate `it`s; add: "every main body of every recipe has exactly one plinth below it" (a `detail === 'plinth'` part whose footprint covers the main body plus `2 × PLINTH_OVERHANG` and whose `oy === main.oy`, `sy === PLINTH_HEIGHT`); "every residential d1–d2 and retail d2 main gable has a ridge cap and two gutters" (`detail` tags, lengths equal to the gable's ridge/eave length within 1e-6); "pitched roofs overhang the body by `ROOF_OVERHANG` on each side".
  - Existing heuristic tests that pick "the wing" or "awnings" or "PV" by size/colour/flags must ignore `detail` parts — update their filters with `!p.detail`, keeping what they assert.
  - `buildingsMesh.test.ts`: one mesh per `PART_KINDS` entry (now five) with capacity `SIZE² × MAX_PARTS_PER_KIND[kind]`.
- [x] **Step 2:** run them — FAIL.
- [x] **Step 3: Implement.**
  - ShedRoof geometry: non-indexed, six faces like the gable builder: top slope from (±0.5, 1, −0.5) to (±0.5, 0, +0.5), back wall at z = −0.5 (height 1), two triangular sides, bottom; `computeVertexNormals` on non-indexed triangles for flat normals.
  - `palette.ts`: `plinth` per zone (residential `0x8c7d6b`, commercial `0x5e646b`, retail `0x7a6a5e`, industrial `0x5b5f66`); `ACCENT.gutter = 0x8a9099`.
  - `buildingsMesh.ts` needs no code change for the new kind beyond what `PART_KINDS` drives; age tint treats `ShedRoof` as a roof kind (`isRoofKind`); plinths get age/supply tint like walls (not `accent`); ridge caps take the roof colour darkened by `RIDGE_DARKEN = 0.85` (not accent, so they age with the roof); gutters are `accent`.
  - Add a plinth to every recipe's main body, apply `ROOF_OVERHANG` to every pitched roof footprint (named margins `MARKET_HALL_ROOF_MARGIN`, `PARAPET_MARGIN` for the existing exceptions), ridge cap + gutters on residential d1–d2 and retail d2 main gables. Keep the existing draw order (no new draws in this task) so cities do not re-roll yet.
- [x] **Step 4:** `pnpm vitest run src/render/buildings src/render/buildingsMesh.test.ts && pnpm typecheck` — PASS; `pnpm test`.
- [x] **Step 5:** commit `feat(render): 16-part building budget, shed-roof primitive, plinths, ridge caps and gutters`.

---

### Task 2: Framed windows visible by day

**Files:** create `src/render/buildings/windows.ts`, `windows.test.ts`; modify `src/render/buildingsMesh.ts`, `buildingsMesh.test.ts`

**Interfaces — produces:** `windowGeometry(): THREE.BufferGeometry` (unit window 1 × 1 in its plane facing +z, base of the glass at y = 0 … 1, centred on x), constants `WINDOW_PROUD = 0.004`, `WINDOW_FRAME_SCALE = 1.18`, `WINDOW_MAX_VERTICES = 48`, colours `FRAME = 0xf2efe8`, `GLASS = 0x2b3440`, `SILL = 0xd8d4cc`; `BuildingsMesh` gains `windowFramesMesh` (readonly, for tests).

- [x] **Step 1: Tests first.**
  - `windows.test.ts`: `windowGeometry()` has a `color` attribute matching `position.count`, ≤ `WINDOW_MAX_VERTICES` vertices; the frame plane's bounds are `WINDOW_FRAME_SCALE` × the glass; every vertex has z ≥ `WINDOW_PROUD - 1e-9` except the sill's back face, which may touch z = 0 (the sill sits on the wall); the glass plane lies in front of the frame plane (greater z) and the mullion planes in front of the glass; the sill spans the frame width below y = 0.
  - `buildingsMesh.test.ts`: after placing a supplied building with windows, `windowFramesMesh.count` equals the number of laid-out window slots _including dark windows_ (compute the expected count with the same layout rules: cols × rows minus door clearance; a dark window still gets a frame); `windowFramesMesh.visible` is true at `nightFactor` 0 and 1; the glow mesh is still hidden by day; an unsupplied building gets frames but no glow; a retail d1 shopfront gets one frame scaled to the shopfront; `windowFramesMesh.frustumCulled === false`.
- [x] **Step 2:** FAIL.
- [x] **Step 3: Implement.**
  - `windows.ts`: merge four planes and one box with vertex colours: frame `PlaneGeometry(WINDOW_FRAME_SCALE, WINDOW_FRAME_SCALE)` at z = `WINDOW_PROUD`, glass `PlaneGeometry(1, 1)` at z = `2 × WINDOW_PROUD`, mullions `PlaneGeometry(MULLION, 1)` and `PlaneGeometry(1, MULLION)` (`MULLION = 0.08`) at z = `3 × WINDOW_PROUD`, sill `BoxGeometry(WINDOW_FRAME_SCALE, SILL_HEIGHT = 0.08, SILL_DEPTH = 0.12)` with its back at z = 0 and its top just below the frame; translate the planes so the glass spans y ∈ [0, 1] and x ∈ [−0.5, 0.5]. Strip `uv`/`normal` mismatches so `mergeGeometries` accepts planes and the box (all four attributes `position`, `normal`, `uv`, `color`, all indexed).
  - `buildingsMesh.ts`: a `windowFrames` `InstancedMesh` (`windowGeometry()`, `surfaceMaterial({ vertexColors: true })`, capacity = the glow mesh's, `frustumCulled = false`, `receiveShadow = true`, `castShadow = false`), filled in `rebuildWindows` for every laid-out window slot (lit or dark) and the retail shopfront, using the window's world transform (same position and facing as the glow quad, scaled to `WINDOW_WIDTH × WINDOW_HEIGHT`, the glass bottom at the window's lower edge). The glow quad moves `3.5 × WINDOW_PROUD` in front of the façade so it sits over the glass. Dark windows: frame instance only. Unsupplied buildings: frames only (today they get no windows at all — they now get frames, no glow).
- [x] **Step 4:** `pnpm vitest run src/render && pnpm typecheck` — PASS; `pnpm test`.
- [x] **Step 5:** commit `feat(render): framed windows with sills and mullions, visible by day`.

---

### Task 3: New silhouettes — residential and retail

**Files:** `src/render/buildings/recipes.ts`, `recipes.test.ts`

**Interfaces — produces:** `Silhouette` names exported for tests: `type ResidentialSilhouette = 'detached' | 'lHouse' | 'semiDetached' | 'townHouse' | 'bayWindow' | 'cornerHouse' | 'apartment' | 'steppedBlock'`, `type RetailSilhouette = 'shop' | 'canopyShop' | 'wideShop' | 'shopWithFlat' | 'marketHall' | 'supermarket'`; `silhouetteOf(zone, density, variant, index): string` (pure, same picker draws as `buildingParts`, for tests and debugging).

- [x] **Step 1: Tests first** (`recipes.test.ts`): for residential and retail, every silhouette of the density occurs in the `VARIANTS × SAMPLE` set; each silhouette satisfies every Global-Constraints rule (the existing rule tests already iterate all recipes — make sure they run over all faces); silhouette-specific checks:
  - `lHouse`: two GableRoof parts whose `turn` differs by one quarter; the wing's footprint touches the main body's side (shared edge within 1e-6) and stays off the door side.
  - `semiDetached`: two houses mirrored about the tile centre line along the facade, one main body only (the left half), the right half a non-main Box of equal size; one shared ridge (one gable over both, or two gables with equal `oy + sy`).
  - `bayWindow`: a Box + ShedRoof on the street face, the box protruding `BAY_DEPTH` beyond the facade, below the eaves.
  - `cornerHouse`: HipRoof over the main body; the door at a corner of the street face (`|lx| ≥ 0.3 × width`).
  - `steppedBlock`: a top storey narrower than the main body by `SETBACK` on the street side with a railing (thin accent Box) along its front.
  - `canopyShop`: a ShedRoof canopy in front of the shop, lower edge ≥ the door height, within the footprint.
  - `shopWithFlat`: a residential-tone upper Box above the shop body with a GableRoof; windows still go on the shop body (main).
  - `supermarket`: footprint ≥ 0.8 × 0.7, height ≤ market hall's, a glass-tone entrance Box on the street face, a flat canopy (Box, `sy ≤ 0.05`) over the entrance, two Vent cylinders.
- [x] **Step 2:** FAIL.
- [x] **Step 3: Implement** each silhouette as its own function (`detachedHouse`, `lHouse`, …) called from `residential`/`retail` after `const silhouette = p.pick(n)` (first draw after the three colours). Each uses `plinth`, roof overhang, ridge caps and gutters where the budget allows (budget test is the guard). Proportions: follow the spec table and keep within the existing height bands per density (residential d1 0.30–0.38 body, d2 0.55–0.65, d3 1.0–1.2; retail d1 0.30–0.35, d2 0.45–0.50, d3 0.80–0.88; the supermarket is d3 but low: 0.40–0.48).
- [x] **Step 4:** `pnpm vitest run src/render/buildings && pnpm typecheck`; `pnpm test`.
- [x] **Step 5:** commit `feat(render): new residential and retail silhouettes`.

---

### Task 4: New silhouettes — commercial and industrial

**Files:** `src/render/buildings/recipes.ts`, `recipes.test.ts`

**Interfaces — produces:** `type CommercialSilhouette = 'lowOffice' | 'pavilion' | 'officeBlock' | 'atriumOffice' | 'tower' | 'twinTowers'`, `type IndustrialSilhouette = 'workshop' | 'leanToHall' | 'plant' | 'loadingDock' | 'works' | 'conveyorWorks'`; `silhouetteOf` covers all zones.

- [x] **Step 1: Tests first:** every silhouette occurs; Global-Constraints rules for all; specific checks:
  - `pavilion`: a ShedRoof over the main body, a glass-tone front slab on the street face.
  - `atriumOffice`: two wing Boxes with a lower glass-tone Box between them; main = the street-side wing; antenna on the taller wing.
  - `twinTowers`: a podium Box (main, low) plus two tower Boxes of equal height; exactly one antenna; tallest top within the existing tower band (1.6–1.9) so commercial d3 stays the tallest.
  - `leanToHall`: hall + ShedRoof lean-to + a ramp (tilted Box, tilt > 0) on the street face; one chimney.
  - `loadingDock`: a raised dock slab on the street face, two roll-up door slabs, an office annex Box; one chimney.
  - `conveyorWorks`: hall, a silo Cylinder, an inclined conveyor Box (tilt between 0.2 and 0.6 rad) from the hall roof to the silo top; one chimney; nothing tagged is tilted.
  - Industrial gable-count test: the saw-tooth rule applies to `workshop`, `plant`, `works` only; new silhouettes use ShedRoof instead.
- [x] **Step 2:** FAIL.
- [x] **Step 3: Implement** as in Task 3.
- [x] **Step 4:** `pnpm vitest run src/render/buildings && pnpm typecheck`; `pnpm test`.
- [x] **Step 5:** commit `feat(render): new commercial and industrial silhouettes`.

---

### Task 5: Full checks and the Mac hand-off

- [x] `pnpm format && pnpm typecheck && pnpm lint && pnpm format:check && pnpm coverage && pnpm build` — PASS; record the slowest test under coverage (must be < ~15 s).
- [x] Record startup slot counts per kind at 64×64 and 96×96 in the spec's Testing section.
- [x] Mac checklist: a street of each zone and density by day and night — new silhouettes recognisable, plinths, ridge caps, gutters visible at city zoom, window frames/sills/mullions by day, glow at night aligned with the glass, no z-fighting on façades; frame time at 96×96 dense city vs main; existing save re-rolled but nothing broken.
