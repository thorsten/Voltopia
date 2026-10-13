# Nature Detail (5a) — Design

Date: 2026-10-11
Status: approved for planning
Part 5a of the visual-detail programme (2026-10-07): (1) lighting and
materials, (2) vehicles, (3) buildings stage 4, (4) plants and service
buildings — all merged; (5) infrastructure and nature, split with the
user into **5a nature** (this spec) and **5b infrastructure** (power
pylons with cross-arms and sagging cables, road crossings and kerbs,
rail signal lights at night). Style: detailed low-poly, no textures.

## Goal

Woods are a box trunk and a box crown, one species everywhere, one to
three per tile. Free land is bare: no bushes or rocks. Water is a flat
tinted slab with a brightness wobble and the sea's tide; shores have no
edge and the ground under and beside water has the same colour as
anywhere else. Part 5a gives woods two recognisable species, scatters
bushes and rocks over free land, and brings water to life with animated
ripples, foam edges and sandy shores.

## Decisions

Made with the user during brainstorming:

- **Split part 5 into 5a nature and 5b infrastructure, nature first**
  (rejected: infrastructure first; one lean part covering both).
- **Water: shore edges plus ripples in the material** (rejected: shore
  edges only; per-vertex geometric waves — CPU and upload cost per frame
  on large maps). The water geometry has only a few vertices per tile,
  so a geometric heave would rock whole tiles; ripples are therefore
  procedural normals in the shader (moving highlights), not displaced
  vertices. The tide stays as today.
- **Forest and scatter details** proposed by the controller and approved
  with the design.

## Architecture

### Water ripples (`src/render/nature/waterShader.ts` new, `src/render/waterMesh.ts`)

- `applyRipples(material: THREE.MeshStandardMaterial): RippleUniforms`
  patches the shared water material via `onBeforeCompile`: a world-space
  position varying and a fragment-shader normal perturbation from two or
  three summed sine waves over world x/z and time (`RIPPLE_SCALE`,
  `RIPPLE_SPEED`, `RIPPLE_STRENGTH` named constants), so specular
  highlights move across lake, river and sea. Returns `{ time: { value } }`;
  `customProgramCacheKey` set so the program is not shared with plain
  `surfaceMaterial` users.
- The water material gets its own `WATER_ROUGHNESS = 0.35`: at the
  shared `SURFACE_ROUGHNESS` (0.9) the moving highlights would not show.
- `WaterMesh.update` advances `time` unless reduced motion is on (then
  frozen). The brightness wobble stays; the tide stays.

### Foam edges (`src/render/waterMesh.ts`)

- Two foam `InstancedMesh`es, inland (lake, river) and sea (thin quad, `MeshBasicMaterial`, white,
  transparent, `depthWrite: false`, `frustumCulled = false`, no shadows):
  one instance per water tile edge that borders a land tile (N/E/S/W),
  laid on the water surface along that edge, `FOAM_WIDTH = 0.06` into
  the water. Sea foam rides the tide (its mesh y follows the sea
  surface, like the sea column).
  Opacity pulses gently (`FOAM_PULSE`) unless reduced motion; dimmed at
  night like the water. Rebuilt only when terrain diffs arrive.

### Sandy shores (`src/render/terrain.ts`)

- `GroundMesh.applyDiffs(diffs)` records terrain per tile. Ground vertex
  colours (which multiply the seasonal ground colour) get
  `SAND_TINT` (a warm multiplier) on every corner that touches a water
  tile and a land tile. Snow still whitens through the seasonal colour.
- No bed tint: the water is opaque and covers every corner surrounded
  only by water, so a darker bed would never be seen (dropped while
  planning, 2026-10-13).

### Forest (`src/render/forestMesh.ts`)

- Two species built with `modelKit`: **conifer** (two stacked `cone`s
  over a short trunk) and **broadleaf** (crown of two `dome`s/`sphere`s
  over a trunk). Per species two `InstancedMesh`: trunk (vertex colour,
  fixed brown) and crown (white geometry, instance colour = foliage).
  8 round segments for trees (`TREE_SEGMENTS = 8`).
- Species per tree by hash; the conifer share rises with elevation
  (`CONIFER_SHARE_LOW = 0.3` at level 0 to `CONIFER_SHARE_HIGH = 0.85`
  at the top level).
- Broadleaf crowns follow `foliageColor` as today; conifers are
  evergreen (`CONIFER_COLOR`, lerped toward snow by snow cover only).
- Trees per stage `TREES_BY_STAGE = [0, 2, 3, 5]`, size jitter
  `±15 %` by hash; positions stay deterministic per tile and tree.
- `frustumCulled = false`, cast and receive shadows, bounded uploads.

### Scatter (`src/render/nature/scatterMesh.ts` new, registered in `renderer.ts`)

- A `DiffLayer` that keeps per tile: tile type, zone, power line,
  forest stage, terrain, track, geothermal hotspot. A tile is **free**
  when it is `TileType.Empty`, `Terrain.Land`, `zone === None`, no power
  line, no track, no geothermal hotspot (its vents are drawn there),
  forest 0.
- Deterministic per free tile: `SCATTER_SHARE = 0.33` of free tiles get
  1–3 props; each prop is a **bush** (merged dome cluster, vertex
  colour) or a **rock** (low faceted `sphere`/`cone` cluster, grey);
  rocks become more likely with slope and elevation. Props stand at
  `surfaceY` of their own spot, scale and yaw by hash.
- Two `InstancedMesh` (bush, rock), `surfaceMaterial({ vertexColors:
true })`, cast and receive shadows, `frustumCulled = false`, bounded
  uploads. A change to any tile's free-ness rebuilds the props (cost
  proportional to free tiles with props, which are already cached per
  tile).
- Bushes follow the season lightly (instance colour from
  `foliageColor`, mixed toward a fixed green).

## Testing

- `waterShader.test.ts`: `applyRipples` sets `onBeforeCompile` and a
  cache key; running the hook on a stub shader injects the uniform and
  the ripple normal code; `time` advances in `WaterMesh.update` and
  stays put with reduced motion.
- `waterMesh.test.ts`: foam count equals water–land edges (a lake with
  a known outline, a river through land, a sea coast); no foam between
  two water tiles; foam sits on the water surface; sea foam follows the
  tide; existing tests stay green.
- `terrain.test.ts` (new): corners next to water and land carry the
  sand tint; corners inside water and inland corners do not.
- `forestMesh.test.ts` (new): tree count per stage; both species occur;
  on high ground conifers are the majority; conifer crowns keep their
  colour through autumn and winter (snow aside); positions stable across
  rebuilds; every tree stands on its ground point.
- `scatterMesh.test.ts`: props only on free tiles; none on roads,
  plants, zones, power lines, tracks, hotspots, woods or water; props vanish when the tile
  is built on; deterministic; every prop on its ground point; share of
  tiles with props within ±0.05 of `SCATTER_SHARE` on a large free map.
- Render-only: nothing under `src/sim`, `src/shared`, `src/storage`,
  `src/agent` changes.

Acceptance on the Mac (the user): woods read as mixed conifer and
broadleaf, darker on the hills; free land has bushes and rocks that
vanish when building; water shows moving highlights, foam at the shores
and sandy edges; frame time unchanged.

## Out of scope

Power pylons, roads, rail lights (part 5b); grass, fields, wave
geometry, textures, gameplay or save changes.
