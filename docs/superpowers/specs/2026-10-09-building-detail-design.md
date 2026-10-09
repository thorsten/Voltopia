# Building Detail (stage 4) — Design

Date: 2026-10-09
Status: approved for planning
Part 3 of 5 of the visual-detail programme (2026-10-07): (1) lighting
and materials — merged and accepted, (2) vehicles — merged, (3)
buildings, (4) plants and service buildings, (5) infrastructure and
nature. Builds on building stages 1–3 (2026-10-03/04: recipes, animated
accents, age). Style: detailed low-poly, no textures.

## Goal

Zone buildings come from per-zone recipes of at most eight parts per
tile in four primitive kinds; three recipes already use all eight.
Every recipe has one silhouette with random variations. Windows are
flat glowing quads that exist only at night. Stage 4 gives every
building plinths, consistent roof overhangs with ridge caps and
gutters, and windows with frames, a mullion cross, a sill and dark
glass that are visible by day and glow at night as before; and it adds
one or two new silhouettes per zone and density so streets look varied,
not just richer.

## Decisions

Made with the user during brainstorming:

- **Detail through geometry in the recipe system** (rejected: procedural
  shader facades — flatter, off-style, hard to test headless; both).
- **Details plus one or two new silhouettes per zone and density**
  (rejected: details only; three to four new silhouettes each).
- **Windows as a lean merged geometry** (decided by the controller for
  the vertex budget: about 40 vertices per window, more than 200 000
  windows on a dense 96×96 map stay comfortable).
- **Existing cities re-roll** (accepted with the user): the picker is a
  single stream, so new draws change every later roll; buildings in
  existing saves get new colours and shapes. Render only — nothing in
  the save changes.

## Architecture

### Budget and primitives (`src/render/buildings/recipes.ts`, `primitives.ts`)

- `MAX_PARTS_PER_TILE = 16`.
- `MAX_PARTS_PER_KIND = { Box: 12, GableRoof: 3, HipRoof: 2, Cylinder: 3, ShedRoof: 2 }`.
- New `PartKind.ShedRoof = 4`: a mono-pitch wedge on the shared unit
  convention (unit footprint centred on the origin, base y = 0, high
  edge y = 1 at z = −0.5, low edge y = 0 at z = +0.5, flat normals,
  bottom face). `buildingsMesh` gets its fifth `InstancedMesh`
  automatically from `PART_KINDS`.
- Capacity stays `gridSize² × MAX_PARTS_PER_KIND[kind]` (64×64: Box
  49 152 slots).

### Shared details (`recipes.ts`)

Helpers every recipe uses, each a named function with named constants:

- `plinth(body, family)` — Box `PLINTH_HEIGHT = 0.04` high, footprint
  `+ 2 × PLINTH_OVERHANG (0.008)`, colour `family.plinth` (new
  `ZoneFamily` field: a darker stone tone), not `main`, not `accent`.
- `ROOF_OVERHANG` applied the same way on every pitched roof (the market
  hall and parapets keep their own margins, now named).
- `ridgeCap(roof)` — thin Box along a gable's ridge
  (`RIDGE_CAP = { w: 0.02, h: 0.015 }`), roof colour darkened.
- `gutters(roof)` — thin Box along each eave of a gable
  (`GUTTER = { w: 0.015, h: 0.015 }`), `ACCENT.gutter` (new, grey).
  Hip roofs get none (four eaves would cost four parts).

Recipes add these where the budget allows: plinth on every main body;
ridge cap and gutters on the main gable of residential d1–d2 and retail
d2. The budget test proves no recipe exceeds 16.

### New silhouettes (`recipes.ts`)

Each recipe picks its silhouette with its first draw after the colours
(`p.pick(n)`), then builds it; the existing silhouette stays one of the
choices.

| Zone        | Density 1                                                                                                                                                            | Density 2                                                                                                                                 | Density 3                                                                                               |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Residential | detached (existing); **L-house**: body + perpendicular wing, two gables meeting at right angles; **semi-detached**: two mirrored narrow houses with one shared ridge | town house (existing); **bay window**: town house with a street-face bay (Box + ShedRoof); **corner house**: hip roof, door on the corner | apartment (existing); **stepped block**: setback top floor with a roof-terrace railing                  |
| Commercial  | low office (existing); **pavilion**: ShedRoof over a glass-tone front                                                                                                | office block (existing); **atrium office**: two wings with a glass-tone box between them                                                  | tower (existing); **twin towers**: two slim towers on a podium                                          |
| Retail      | shop (existing); **canopy shop**: flat roof with a wide ShedRoof canopy over the forecourt                                                                           | wider shop (existing); **shop with flat above**: shop ground floor, residential storey with a gable                                       | market hall (existing); **supermarket**: low wide box, glass entrance box, large flat canopy            |
| Industrial  | workshop (existing); **lean-to hall**: hall with a ShedRoof lean-to and a loading ramp                                                                               | plant (existing); **loading dock**: hall, raised dock slab, two roll-up doors, office annex                                               | works (existing); **conveyor works**: hall, silo, an inclined conveyor bridge (tilted Box) between them |

Rules all silhouettes keep (tested): footprint inside `FOOTPRINT_HALF`,
exactly one `main` Box with turn 0 and no tilt (windows go on it),
`buildingHeight` = tallest top, commercial d3 stays the tallest recipe,
puff anchors ≤ 2 per tile, roles (chimney, vent, antenna) only where
stage 2 expects them (residential d1 chimney, commercial d2–d3 antenna,
retail d3 vents — the supermarket keeps two vents —, industrial
chimney), door on the street face for residential.

### Windows (`src/render/buildingsMesh.ts`, `src/render/buildings/windows.ts` new)

- `windowGeometry()` (new module): unit window (1 × 1 in its plane,
  facing +z) merged from a frame plane `WINDOW_FRAME_SCALE` larger
  behind the glass, a dark glass plane, a mullion cross (two thin
  planes) and a sill Box below; vertex colours (`FRAME`, `GLASS`,
  `SILL`), ≤ 48 vertices; every visible element sits `WINDOW_PROUD
(0.004)` in front of the façade so nothing z-fights.
- `windowFrames` — new lit `InstancedMesh` with
  `surfaceMaterial({ vertexColors: true })`, `frustumCulled = false`,
  `receiveShadow`, no `castShadow`; visible day and night; one instance
  per laid-out window (same layout and slots as today, including dark
  windows — a dark window has frames too).
- The existing glow quads stay for the night (same opacity rule, same
  supply rule), sized to the glass and placed a hair in front of it.
- Retail shopfronts get a frame instance scaled to the shopfront.

### Palette (`src/render/buildings/palette.ts`)

`ZoneFamily.plinth: THREE.Color` per zone; `ACCENT.gutter`; window
colours `FRAME`, `GLASS`, `SILL` in `windows.ts`. Age and supply tints
apply to plinths like walls; gutters and windows are accents (untinted).

## Testing

- `recipes.test.ts`: budgets (≤ 16 per tile, per-kind maxima) over the
  whole 64×64 grid for every zone, density, variant and all four faces;
  every new silhouette occurs within the variant × index sample (each
  silhouette at least once); all rules above per silhouette; existing
  heuristic tests (door by colour, wing, awning, PV flush, industrial
  gable count) updated to the new part sets with the same intent.
- `primitives.test.ts`: ShedRoof bounds (unit footprint, y 0..1, high
  edge at z = −0.5) and flat normals.
- `windows.test.ts`: geometry bounds, vertex colours present, ≤ 48
  vertices, every element ≥ `WINDOW_PROUD` in front of z = 0.
- `buildingsMesh.test.ts`: a fifth part mesh for ShedRoof; `windowFrames`
  instance count equals the laid-out windows (incl. dark ones) and is
  visible by day; glow quads still hidden by day; door clearance and
  shopfront rules hold.
- Capacity/performance: startup slot counts recorded; a 96×96 map fully
  zoned at density 3 renders without exceeding the window capacity.

Acceptance on the Mac (the user): a mixed street per zone at day and
night — new silhouettes recognisable, frames and sills visible by day,
glow at night, plinths and gutters read at city zoom, frame time
unchanged at 96×96.

### Results (2026-10-09)

`pnpm format && pnpm typecheck && pnpm lint && pnpm format:check &&
pnpm coverage && pnpm build` all pass. Slowest test under coverage:
`src/sim/integration.test.ts > full gameplay integration > grows a
powered city and balances energy over days`, 9.3 s (well under the 15 s
budget; next slowest were two other multi-day integration tests at
6-8 s).

Main now also offers a 128×128 map size (`src/ui/newGame.ts`:
`MAP_SIZES = [48, 64, 96, 128]`). Startup `InstancedMesh` slot counts
per kind (`gridSize² × MAX_PARTS_PER_KIND[kind]`) and per window mesh
(`gridSize² × WINDOWS_PER_TILE`, `WINDOWS_PER_TILE = 24`), for the
three sizes above 48:

| Kind                     | 64×64  | 96×96   | 128×128 |
| ------------------------ | ------ | ------- | ------- |
| Box (×12)                | 49,152 | 110,592 | 196,608 |
| GableRoof (×3)           | 12,288 | 27,648  | 49,152  |
| HipRoof (×2)             | 8,192  | 18,432  | 32,768  |
| Cylinder (×3)            | 12,288 | 27,648  | 49,152  |
| ShedRoof (×2)            | 8,192  | 18,432  | 32,768  |
| Window frames/glow (×24) | 98,304 | 221,184 | 393,216 |

A new headless test (`windowLayout.test.ts`, "fits a fully zoned
density-3 128×128 map within the window capacity") takes the worst
case over every silhouette restricted to density 3 — the stepped block
at 24 windows, the per-tile budget — and checks
`gridSize² × maxPerTile ≤ gridSize² × WINDOWS_PER_TILE` at 128×128, the
same formula `buildingsMesh.ts` uses for `windowFramesMesh` and
`windowsMesh`. Runs in well under 1 s (no scene build).

Window-frame geometry is 40 vertices per window (4 planes × 4 + one
6-face box × 4, confirmed against `windowGeometry()` in
`buildings/windows.ts`). At the 128×128 capacity of 393,216 window
instances that is 15,728,640 vertices processed per frame if every slot
were drawn — worth watching on the Mac frame-time check, though real
cities only fill a fraction of that capacity (not every tile has a
building, and most silhouettes use far fewer than 24 windows).

## Out of scope

Shader façades, textures, interiors, new zones, gameplay or save
changes, plants and service buildings (part 4), roads and nature
(part 5).
