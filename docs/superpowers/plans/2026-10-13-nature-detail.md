# Nature Detail (5a) Implementation Plan

> **For agentic workers:** execute task by task; steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two tree species, bushes and rocks on free land, rippling water with foam edges and sandy shores — render-only.

**Architecture:** The model kit gains optional facet counts. A shader patch (`src/render/nature/waterShader.ts`) perturbs the water normal with summed sines; `WaterMesh` adds two foam meshes along water–land edges. `GroundMesh` tints shore corners. `ForestMesh` draws conifers and broadleaves from kit models. A new `ScatterMesh` diff layer puts bushes and rocks on free tiles.

**Tech Stack:** TypeScript, three.js (`InstancedMesh`, `onBeforeCompile`), vitest.

Spec: `docs/superpowers/specs/2026-10-11-nature-detail-design.md`.

## Global Constraints

- Render-only: no changes under `src/sim`, `src/shared`, `src/storage`, `src/agent`; no save or gameplay change.
- Every new `InstancedMesh`: `frustumCulled = false` with the usual comment (CLAUDE.md).
- Deterministic placement: per-tile hashes only (no `Math.random`); positions stable across rebuilds.
- Instance uploads bounded by `count` — reuse `uploadDrawn` from `src/render/plants/growingMesh.ts` (and `clearUpdateRanges`/`addUpdateRange` for `instanceColor`, as `GrowingMesh.commit` does).
- Reduced motion freezes ripples and the foam pulse.
- No magic numbers: named constants for every reused or tuned value.
- Run `pnpm format`; `pnpm typecheck && pnpm lint && pnpm test` must pass before every commit; never `--no-verify`.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Keep each single test under ~15 s under `pnpm coverage`.

## File Structure

- Modify `src/render/modelKit.ts` (+ test): optional `segments` on `sphere` and `dome`.
- Create `src/render/nature/waterShader.ts` (+ test): `applyRipples`.
- Modify `src/render/waterMesh.ts` (+ test): ripples, water roughness, foam.
- Modify `src/render/terrain.ts`; create `src/render/terrain.test.ts`: sandy shores.
- Rewrite `src/render/forestMesh.ts`; create `src/render/forestMesh.test.ts`: two species.
- Create `src/render/nature/hash.ts`: the per-tile hash now private in `forestMesh.ts`, shared with the scatter.
- Create `src/render/nature/scatterMesh.ts` (+ test); modify `src/render/renderer.ts` to register it after the forest.

---

### Task 0: Branch

- [x] Commit the aligned spec and this plan on `main`, then `git checkout -b feature/nature-detail`.

---

### Task 1: Kit facets and shared hash

**Files:** `src/render/modelKit.ts`, `src/render/modelKit.test.ts`, create `src/render/nature/hash.ts`, modify `src/render/forestMesh.ts` (import the hash).

- `sphere(r, x, y, z, color, segments = ROUND_SEGMENTS)` (height segments `max(2, segments / 2)`), `dome(r, squash, x, y, z, color, segments = ROUND_SEGMENTS)` — same for `dome`. Existing callers unchanged.
- `export function tileHash(index: number, salt: number): number` in `nature/hash.ts`: the exact function body of today's `hash` in `forestMesh.ts` (so existing tree spots do not move needlessly); `forestMesh.ts` imports it.
- [x] Tests: a sphere with `segments = 8` has fewer vertices than the default; a dome with `segments = 8` likewise; `tileHash` is in [0, 1), deterministic, differs across salts.
- [x] Implement; checks; commit `refactor(render): facet counts for kit spheres and domes, shared tile hash`.

---

### Task 2: Water ripples

**Files:** create `src/render/nature/waterShader.ts`, `src/render/nature/waterShader.test.ts`; modify `src/render/waterMesh.ts`, `src/render/waterMesh.test.ts`.

**Interface:**

```ts
export const WATER_ROUGHNESS = 0.35;
export interface RippleUniforms {
  time: { value: number };
}
/** Patches the material in place; sets roughness to WATER_ROUGHNESS. */
export function applyRipples(material: THREE.MeshStandardMaterial): RippleUniforms;
```

- `onBeforeCompile(shader)`: `shader.uniforms.rippleTime = uniforms.time`;
  - vertex: declare `varying vec3 vRippleWorld;`; after `#include <begin_vertex>` add
    `vec4 rippleWorld = vec4(transformed, 1.0);` `#ifdef USE_INSTANCING rippleWorld = instanceMatrix * rippleWorld; #endif` `vRippleWorld = (modelMatrix * rippleWorld).xyz;`
  - fragment: declare `uniform float rippleTime; varying vec3 vRippleWorld;`; after `#include <normal_fragment_begin>` compute the slope of 2–3 summed sines over `vRippleWorld.xz` (`RIPPLE_SCALE`, `RIPPLE_SPEED`, `RIPPLE_STRENGTH`, wave directions as named `vec2` constants), build `vec3 rippleN = normalize(vec3(-dx, 1.0, -dz))`, transform to view space with `viewMatrix`, and apply it only to upward faces: `float up = step(0.5, dot(normal, normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz)));` `normal = normalize(mix(normal, rippleView, up));`.
- `material.customProgramCacheKey = () => 'voltopia-water-ripples'`.
- `WaterMesh`: call `applyRipples(this.material)` in the constructor, keep the uniforms; `update(dt)` adds `dt` to `time` unless reduced motion; expose `get rippleTime(): number` for tests.
- [x] Tests (`waterShader.test.ts`): `applyRipples` sets `onBeforeCompile`, the cache key and the roughness; running the hook on a stub `{ uniforms: {}, vertexShader: '#include <begin_vertex>', fragmentShader: '#include <normal_fragment_begin>' }` keeps both includes, adds `vRippleWorld` to both shaders, `rippleTime` to the fragment shader and the uniform object (same reference as the returned `time`). (`waterMesh.test.ts`): `rippleTime` grows with `update(0.5, …)`; stays put with reduced motion; existing tests green.
- [x] Implement; checks; commit `feat(render): rippling water highlights`.

---

### Task 3: Foam edges

**Files:** `src/render/waterMesh.ts`, `src/render/waterMesh.test.ts`.

- Constants: `FOAM_WIDTH = 0.06`, `FOAM_LIFT = 0.002` (above the water surface), `FOAM_OPACITY = 0.55`, `FOAM_PULSE = 0.15` (opacity amplitude), `FOAM_PULSE_SPEED = 0.8`, `FOAM_COLOR = 0xffffff`.
- Geometry: `PlaneGeometry(1, FOAM_WIDTH)` rotated flat (`rotateX(-π/2)`), long side along x; an E/W edge rotates it by π/2 about y.
- One shared `MeshBasicMaterial({ color: FOAM_COLOR, transparent: true, opacity: FOAM_OPACITY, depthWrite: false })`; two meshes: `inlandFoam` (lake and river edges) and `seaFoam` (sea edges). Both `frustumCulled = false`, no shadows. Capacity: rebuilt to the exact edge count on each terrain rebuild (water changes only on new game/load) — dispose and recreate the mesh when the count exceeds its capacity.
- An edge counts when the water tile's 4-neighbour (N/E/S/W) exists and is `Terrain.Land`. The instance sits on the edge line moved `FOAM_WIDTH / 2` into the water tile.
  - Lake: y = `centerY + WATER_HEIGHT + WATER_THICKNESS + FOAM_LIFT`.
  - River: y = `elevation.surfaceY(fx, fz) + WATER_HEIGHT + WATER_THICKNESS + FOAM_LIFT` at the foam centre.
  - Sea: instance y = 0; `seaFoam.position.y` = current sea surface + `FOAM_LIFT`, set in `setSeaSurface`.
- `update`: opacity = `(FOAM_OPACITY + (reducedMotion ? 0 : FOAM_PULSE * sin(now * FOAM_PULSE_SPEED))) * (1 - NIGHT_DIM * nightFactor)`.
- Expose `get foamCount(): { inland: number; sea: number }` for tests.
- [x] Tests: a 6×6 land map with a 2×2 lake in the middle → 8 inland edges; a straight river column across an 8×8 map → 2 edges per river tile, none between river tiles; a sea row at z = 0 on an 8×8 map → 8 sea edges, none at the map border, none between sea tiles; a lake tile next to a river tile → no foam on that shared edge; every inland foam instance y is above that tile's water surface; `seaFoam` world y rises with the tide (tide −1 vs 1) and stays put with reduced motion; foam opacity at night is lower than by day.
- [x] Implement; checks; commit `feat(render): foam along the shores`.

---

### Task 4: Sandy shores

**Files:** `src/render/terrain.ts`, create `src/render/terrain.test.ts`.

- `SAND_TINT = new THREE.Color(1.38, 1.05, 1.15)` with a comment: summer ground (`PALETTE.groundSummer`) × tint ≈ sand `0xdbcd91`; values > 1 are fine in a float vertex colour.
- `GroundMesh` keeps `terrain: Uint8Array(size²)`; `applyDiffs(diffs)` records `diff.terrain` and rebuilds when terrain changed or the field version changed (one rebuild per call at most).
- In `rebuildHeights`, per vertex (vx, vz): look at the up to four adjacent tiles; when at least one is water (`!== Terrain.Land`) and at least one is land, multiply the shade by `SAND_TINT` per channel; otherwise grey shade as today.
- Expose nothing new; tests read `ground.geometry.attributes.color` and find a vertex by its rounded x/z.
- [x] Tests: 6×6 map, lake at tiles (2,2),(3,2),(2,3),(3,3): corner (3,3) (inside the lake, all four tiles water) is grey (r = g = b); corner (2,2) (one lake tile, three land) is tinted (r ≠ b); corner (0,0) inland is grey; a second identical diff batch does not rebuild (`computeVertexNormals` spy not called again); diffs arriving before the elevation field changes still tint (order independence).
- [x] Implement; checks; commit `feat(render): sandy shores`.

---

### Task 5: Two tree species

**Files:** rewrite `src/render/forestMesh.ts`, create `src/render/forestMesh.test.ts`.

- Constants: `TREES_BY_STAGE = [0, 2, 3, 5]`, `TREE_SEGMENTS = 8`, `SIZE_JITTER = 0.15`, `CONIFER_SHARE_LOW = 0.3`, `CONIFER_SHARE_HIGH = 0.85`, `CONIFER_COLOR = 0x2f5e3c`, `TRUNK_COLOR` (kept). Keep `foliageColor` and `FOLIAGE_*` exported/behaving as today.
- Models from the kit, base at y = 0, height ≈ today's tree (trunk 0.18 + crown 0.3): **conifer** = short trunk `cylinder` + two stacked `cone`s (lower wider); **broadleaf** = trunk `cylinder` + two overlapping `sphere`/`dome`s. Split per species into a trunk model (vertex colour `TRUNK_COLOR`, `surfaceMaterial({ vertexColors: true })`) and a crown model (white vertex colour, `surfaceMaterial({ vertexColors: true })`, colour via `setColorAt`). All with `TREE_SEGMENTS`.
- Four `InstancedMesh` (conifer trunk/crown, broadleaf trunk/crown), capacity `gridSize² × 5`, `frustumCulled = false`, cast + receive shadows.
- Per tree: positions as today (`tileHash(index, tree*2+1/2)`), scale `stageSize × (1 ± SIZE_JITTER)` from `tileHash(index, tree + 97)`, yaw from `tileHash(index, tree + 211) × 2π`, species conifer when `tileHash(index, tree + 307) < lerp(LOW, HIGH, level / BALANCE.terrain.maxLevel)`.
- Colours: broadleaf crowns `foliageColor(phase, snow)`; conifer crowns `CONIFER_COLOR` lerped to `FOLIAGE_SNOW` by `snowCover × 0.7`. `setEnvironment` writes the instance colours of both crown meshes only when the colour changed (compare hex), and the rebuild writes them too.
- Uploads bounded by count.
- Expose `get counts(): { conifer: number; broadleaf: number }` for tests.
- [x] Tests: stage 1/2/3 tiles give 2/3/5 trees; a 20×20 woods map at level 0 has both species; the same at level 7 has a conifer majority; at phase 0.6 (autumn) and snow 0 a conifer crown colour equals `CONIFER_COLOR`, a broadleaf crown does not; with snow 1 the conifer is lighter; positions identical after a second rebuild (diff off/on); every trunk instance y equals `elevation.surfaceY(x, z)` at its x/z; removing the forest from a tile drops its trees.
- [x] Implement; checks; commit `feat(render): conifers and broadleaves`.

---

### Task 6: Bushes and rocks

**Files:** create `src/render/nature/scatterMesh.ts`, `src/render/nature/scatterMesh.test.ts`; modify `src/render/renderer.ts`.

- Constants: `SCATTER_SHARE = 0.33`, `MAX_PROPS_PER_TILE = 3`, `ROCK_SHARE_FLAT = 0.25`, `ROCK_SHARE_STEEP = 0.75` (lerp by `max(slope / 2, level / maxLevel)` clamped to 1), `PROP_SCALE_MIN = 0.7`, `PROP_SCALE_MAX = 1.3`, `BUSH_GREEN = 0x4f8a3e`, `BUSH_SEASON_MIX = 0.5`, `ROCK_COLOR = 0x8a8a84`, `PROP_MARGIN = 0.12` (keep props off tile edges).
- Models: bush = 2–3 overlapping `dome`s (vertex colour white, coloured per instance), ~0.09 high; rock = 1–2 low `sphere(…, segments 6)` squashed or a `cone`, grey vertex colour, ~0.06 high.
- Free tile: `tileType === TileType.Empty && terrain === Terrain.Land && zone === Zone.None && powerLine === 0 && rail === 0 && geothermal === 0 && forest === 0`. Keep `free: Uint8Array(size²)`; `applyDiffs` updates it and rebuilds once when any tile's free-ness changed (first diff batch builds everything).
- Per free tile: has props when `tileHash(index, 501) < SCATTER_SHARE`; prop count `1 + floor(tileHash(index, 503) × MAX_PROPS_PER_TILE)`; per prop position, scale, yaw and kind by hash (salts > 600). y = `elevation.surfaceY(x, z)`.
- Two `InstancedMesh` (bush, rock), capacity `gridSize² × MAX_PROPS_PER_TILE`, `surfaceMaterial({ vertexColors: true })`, cast + receive shadows, `frustumCulled = false`, bounded uploads. Bush instance colour = `foliageColor(phase, snow)` lerped to `BUSH_GREEN` by `BUSH_SEASON_MIX`, rewritten in `setEnvironment` only when it changed.
- Expose `get counts(): { bushes: number; rocks: number }` and `propTiles(): Set<number>` (tiles that carry props) for tests.
- Register in `renderer.ts` with `this.addDiffLayer(new ScatterMesh(scene, gridSize, this.elevation))` right after the `ForestMesh`.
- [x] Tests: on a 64×64 free flat map the share of prop tiles is within ±0.05 of `SCATTER_SHARE`; a road, plant, zoned, power-line, track, hotspot, wooded and water tile never carries props (build each on a prop tile found from the free map); building a road on a prop tile removes its props; two layers fed the same diffs give identical matrices; every prop y equals `surfaceY` at its x/z; on a map at level 7 rocks outnumber bushes, on flat level 0 bushes outnumber rocks.
- [x] Implement; checks; commit `feat(render): bushes and rocks on free land`.

---

### Task 7: Full checks and the Mac hand-off

- [x] `pnpm format && pnpm typecheck && pnpm lint && pnpm format:check && pnpm coverage && pnpm build` — PASS; record the slowest test under coverage.
- [x] Add "Results (2026-10-13)" to the spec's Testing section (instance counts on a generated 128² map: trees per species, bushes, rocks, foam edges; slowest test); tick this plan; commit `docs: record nature-detail checks`.
- [ ] Mac checklist for the user: mixed woods, darker on the hills; bushes and rocks on free land that vanish when building; moving highlights on lake, river and sea (and frozen with reduced motion); foam along shores, rising with the tide; sandy edges incl. in winter/snow; `node scripts/smoke.mjs`; frame time unchanged vs `main` at 128².
