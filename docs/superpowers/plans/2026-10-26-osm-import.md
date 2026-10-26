# Import a town from OpenStreetMap — plan

Spec: `docs/superpowers/specs/2026-10-26-osm-import-design.md`.
Branch `feature/osm-import` (continues `spike/osm-import`, which holds
the probe). Every task ends with
`pnpm format && pnpm typecheck && pnpm lint && pnpm test` green and one
commit. Tasks 1, 2 and 4 are pure and can run in parallel with task 3's sim
side once the `TownLayout` type (task 2, first bullet) is committed;
task 5 needs 2–4, task 6 needs 3–5.

## Task 1 — OSM parser (`src/import/osm.ts`)

- `src/import/osm.ts`, DOM-free: `export interface OsmData { nodes:
Map<string, [lon, lat]>; ways: OsmWay[]; relations: OsmRelation[];
bounds: [w, s, e, n] | null }`, `OsmWay { id; refs: string[]; tags:
Record<string, string> }`, `OsmRelation { outer: string[]; tags }`
  (multipolygons only). `export function parseOsm(xml: string):
OsmData` — one pass each over `<node`, `<way`, `<relation` as in
  `scripts/probe-osm.mjs`, plus `unescapeXml` for `&amp; &lt; &gt;
&quot; &apos;` and numeric entities in tag values. Throws
  `OsmImportError('notOsm')` when no `<osm` root or no way is found.
- Fixture: port the spike's `/tmp/osm/make-fixture.mjs` to
  `scripts/make-osm-fixture.mjs` and commit its output as
  `src/import/fixtures/town.osm` (synthetic 3 km town: curved river,
  diagonal primary, rotated residential grid, rail, zones, forest, lake,
  40 buildings, one multipolygon lake with an island, one `place=town`
  node, a tag value with `&amp;`). Keep it under 30 KB.
- `src/import/osm.test.ts`: counts, a node's lon/lat, a way's refs and
  tags, the multipolygon's outer refs, bounds, unescaped value, garbage
  → `notOsm`, file without bounds → `bounds === null`.

## Task 2 — rasteriser (`src/import/rasterise.ts`)

- `src/shared/types.ts`: `export interface TownLayout` per spec
  (typed arrays, `name`, `bbox`) and `export interface TownOrigin
{ source: 'osm'; name: string | null; bbox: [number, number, number,
number] }`.
- `src/import/config.ts`: `OSM_IMPORT` — the tag tables (avenue,
  street, pedestrian sets; landuse → zone map; water / forest tag
  sets), `maxBoxKm: 20`, `riverWidthTiles: 1`. Rasteriser tuning is
  import config, not `BALANCE`; the settling thresholds are sim
  pacing and live in `BALANCE.osmImport = { buildingsPerDensity:
[1, 3, 6] }` (initial guess, tuned in task 6).
- `src/import/rasterise.ts`: `export function rasteriseTown(data:
OsmData, size: number): { layout: TownLayout; report: ImportReport }`
  with `ImportReport { metresPerTile; widthM; heightM; counts:
Record<'street'|'avenue'|'pedestrian'|'rail'|'river'|'lake'|'forest'|
'residential'|'commercial'|'retail'|'industrial'|'buildings', number>;
roadComponents; droppedZones; thinned; skippedHighways:
Record<string, number> }`. Steps in order: projection (square box,
  throw `OsmImportError('boxTooLarge')` over `maxBoxKm`) → areas
  largest-first (scanline, even-odd; `area=no` skipped) → river lines →
  rail lines → roads (streets then avenues, pedestrian flag) → terrain
  fix-up (road on lake → land; zone/forest cleared on water) → 2×2
  thinning for road and for rail with the component guard (flood fill
  before/after; keep the tile when the count would rise) → drop
  unserved zones → settling: count building centroids per tile
  (centroid of the way's nodes), density by `buildingsPerDensity`
  thresholds on zoned, land, road-served, non-road tiles → town name
  (`place` node with the highest rank city > town > village inside
  the box, else null) → report. 4-connected Bresenham and the flood
  fill shared in `src/import/grid.ts`.
- `src/import/rasterise.test.ts`: one test per mapping row on tiny
  hand-built `OsmData` objects (helper `osm({ nodes, ways })`), largest-
  first areas, diagonal way is 4-connected (every tile has an N/E/S/W
  road neighbour), road over river keeps river, road over lake makes
  land, zone on water cleared, 2×2 thinning removes exactly one tile of
  a 2-wide band and keeps one component, the split guard, unserved zone
  dropped, settling thresholds, `boxTooLarge`, bounds from nodes, all
  four `MAP_SIZES`; and the fixture through `parseOsm` + `rasteriseTown`
  at 96: report sanity (one road component, metres per tile ≈ 31).
- Rewire `scripts/probe-osm.mjs`: import `parseOsm` and `rasteriseTown`
  from `src/import/*.ts`, keep only the ASCII printer and the stats
  line (drop the duplicated parsing/rasterising and the `--manhattan`
  mode). Update the header comment and `docs/idea.md`'s probe note.

## Task 3 — sim: layout init, stamps, origin

- `src/shared/messages.ts`: `init` gets `layout?: TownLayout`
  (doc: free city built from an imported layout; ignored with `save`,
  exclusive with `scenario`).
- `src/sim/scenarios/stamp.ts`: `stampRail(state, tiles)` (via
  `buildRail`, verify `layers.rail !== 0`) and `stampLanes(state,
tiles, kind)` (via `buildLanes`, verify `roadLane`).
- `src/sim/importTown.ts`: `export function validateTownLayout(layout:
unknown, size: number): layout is TownLayout` (size in `MAP_SIZES`,
  every array a `Uint8Array` of `size²`, road ≤ 2, zone ≤ 4, density ≤
  3, terrain ≤ 3, forest ≤ `BALANCE.forest.maxStage`) and
  `applyTownLayout(state, layout)`: copy terrain and forest, elevation
  stays 0, mark every tile dirty; `withFreeBuild`: `stampRoads`
  streets, `stampRoads` avenues (`avenue = true`), `stampLanes`
  pedestrian tiles with `RoadLane.Pedestrian`, `stampRail`, `stampZone`
  per zone, `stampBuildings` per density; then `state.undoStack = []`,
  `state.origin = { source: 'osm', name, bbox }`, `gridVersion++`,
  `statsDirty = true`.
- `src/sim/engine.ts` init: new branch `else if (command.layout)`
  after `scenario`: if `validateTownLayout` fails → fall through to the
  seeded free city and return `[{ type: 'rejected', reason:
'invalidLayout' }]`; else `createSimState(seed, layout.size,
startingMoney)`, `disasterScale`, `sandbox` as for free play,
  `generateGeothermal` + `discoverGeothermalFields`, `applyTownLayout`.
  (No `generateTerrain`/`generateWater`/`generateForest`.)
- `src/sim/state.ts`: `origin?: TownOrigin` on `SimState`; serialise
  as optional `SaveGame.origin` (`src/shared/types.ts`), deserialise
  when present. No `SAVE_VERSION` bump.
- `src/sim/tick.ts` `buildStats`: `origin?: TownOrigin` on
  `GlobalStats` (copy, not the same object).
- `src/shared/constants.ts`: `BALANCE.osmImport` (see task 2) with a
  doc comment.
- Tests `src/sim/importTown.test.ts`: fixture → `rasteriseTown(96)` →
  `SimEngine.applyCommand({ type: 'init', seed: 1, size: 96, layout })`:
  road/avenue/rail/zone/terrain/forest layers equal the layout, every
  building sits on a zoned, road-served land tile with the layout's
  density, elevation all 0, origin set and in `buildStats`, undo empty,
  money equals starting money; determinism: two engines, 400 ticks,
  identical serialised saves; save → new engine `init` with `save` →
  origin kept; `validateTownLayout` rejects wrong size, wrong length,
  out-of-range values; engine with an invalid layout emits
  `rejected: 'invalidLayout'` and still has a playable seeded map.
  Keep the 96² test under the 15 s budget (one layout shared via
  `beforeAll`); `loadFuzz.test.ts` gets an origin case if it lists
  optional save fields.

## Task 4 — fetching (`src/import/fetch.ts`)

- `src/import/config.ts` gains `nominatimUrl`, `overpassEndpoints`
  (`https://overpass-api.de/api/interpreter`,
  `https://overpass.kumi.systems/api/interpreter`), `sideKm: [2.5,
3.5, 5]`, `overpassTimeoutS: 60`, `searchMinIntervalMs: 1000`.
- `src/import/fetch.ts`, DOM-free, every function takes `{ fetch }`
  (defaults to `globalThis.fetch`):
  - `buildOverpassQuery(bbox): string` — `[out:xml][timeout:60]
[bbox:S,W,N,E];` then a union built from the same tag tables the
    rasteriser uses (`OSM_IMPORT`): highway regex, `railway=rail`,
    waterway regex, `natural` water/wood, `water`, landuse regex,
    `building`, multipolygon relations for water / wood / forest /
    the zone landuses, `place` nodes; `out body; >; out skel qt;`.
    One source of truth: a test asserts every mapping tag appears.
  - `searchPlaces(query, locale, deps): Promise<PlaceHit[]>` —
    `GET nominatim/search?q=&format=jsonv2&limit=8&accept-language=`,
    hits mapped to `{ name, displayName, type, lat, lon }` (`name` =
    first part of `display_name`), HTTP error → `OsmImportError
('searchFailed')`, empty → `[]`. A module-level gate delays a call
    that comes within `searchMinIntervalMs` of the previous one.
  - `fetchTown(bbox, deps, signal): Promise<string>` — POST
    `data=<query>` to each endpoint in turn; retry on network error,
    HTTP 429/503/504 or timeout (AbortSignal.timeout combined with the
    caller's signal); last failure → `OsmImportError('fetchFailed')`,
    abort → `('aborted')`.
  - `squareBbox(lat, lon, sideKm): [w, s, e, n]` shared with the
    rasteriser's projection helpers (`src/import/geo.ts`).
- `src-tauri/tauri.conf.json`: `connect-src` gains the three hosts.
- `src/import/fetch.test.ts`: query text (tags, bbox order), Nominatim
  URL/params and mapping, errors, the rate gate (fake timers),
  endpoint fallback order and the retry conditions, abort.

## Task 5 — UI: import on the new-game page, preview, attribution

- `src/ui/newGame.ts`: `NewGameOptions.layout?: TownLayout`; pending
  storage encodes typed arrays with `toBase64Url`/`fromBase64Url`
  (`src/storage/shareCode.ts`) under a `layoutCode` field; reading
  validates with `validateTownLayout` and drops a bad one (falls back
  to a seeded city, logs a warning). Export `encodePendingLayout` /
  `decodePendingLayout` for tests.
- `src/ui/importTown.ts` (main thread, DOM-free except `File`):
  `readTownFile(file): Promise<OsmData>` (`file.text()`, `parseOsm`),
  `loadTown(place, sideKm, signal): Promise<{ data: OsmData; bbox }>`
  (`fetchTown` + `parseOsm`), and the map of `OsmImportError` codes to
  i18n keys. A small reducer `importTownReducer` holds the flow state
  (`idle | searching | results | loading | parsed | error`, with the
  chosen place, side, size, data, bbox, layout, report) so the page
  logic is unit-testable without React.
- `src/ui/NewGamePage.tsx`: section "Import a town" below the map-size
  control, as the spec lists: search field + button (testids
  `import-town-query`, `import-town-search`), result list
  (`import-town-result`), chosen-place chip, side buttons
  (`import-town-side`), metres-per-tile line, "Load town" button
  (`import-town-load`, shows a spinner and a Cancel while loading,
  aborts on unmount), the collapsed file row (file input
  `accept=".osm,.xml,application/xml"`, testid `import-town-file`),
  status line (testid `import-town-status`), `TownPreview` (canvas,
  `size`×`size` pixels scaled by CSS, colours from a shared
  `src/ui/townColors.ts` that `minimapLayer.ts` also imports — move
  its `COLORS` there) and the report line (testid
  `import-town-report`). Map-size buttons re-rasterise the parsed
  `OsmData`; a new side or place clears data and preview. Start stores
  options with the layout. While a layout is loaded the seed field is
  hidden (the seed still seeds geothermal and building variants; take
  a random one).
- `src/ui/HudConsole.tsx` (or wherever the HUD footer lives — check
  `App.tsx` bottom bar): `OsmAttribution` when `stats.origin?.source
=== 'osm'`: "© OpenStreetMap contributors", link to
  `https://www.openstreetmap.org/copyright`, testid `osm-attribution`;
  in the native app the link goes through `platform.ts` (opener
  plugin), as other external links do.
- `src/ui/ImprintPage.tsx`: ODbL paragraph and the Nominatim/Overpass
  data-flow paragraph; the import section links to the imprint.
- `src/ui/SavesPage.tsx`: default name of a new slot = `stats.origin
?.name` when set.
- `src/ui/useSimBridge.ts`: pass `options.layout` into `init`.
- i18n EN + DE: `newGame.import.*` (title, search placeholder and
  button, no results, service note, side labels, load/cancel, file
  row, reading, errors `searchFailed`, `fetchFailed`, `aborted`,
  `notOsm`, `boxTooLarge`, `empty`, report template with named
  placeholders), `hud.osmAttribution`, `imprint.osm*`.
- Tests: `newGame.test.ts` pending layout round trip and invalid code
  dropped; `importTown.test.ts` reducer transitions and error mapping;
  a small render test of the attribution if the HUD has component
  tests (grep `HudConsole` tests).

## Task 6 — agent tools, docs, e2e

- `src/agent/tools.ts`: `AgentContext.fetch?: typeof fetch` (webmcp
  passes the browser's; tests stub it). New tools `search_places`
  (`query`, returns the hits) and `import_town` (`query` or `lat` +
  `lon`, `sideKm` ∈ `OSM_IMPORT.sideKm`, `size`, and the
  `start_new_city` options; searches when no coordinates, fetches,
  parses, rasterises, then `ctx.startNewCity({ ..., layout })`;
  `NewCityOptions.layout?`). `get_game_overview` adds `origin`;
  `get_build_catalog` adds `osmImport` (mapping table, sides,
  `buildingsPerDensity`). `docs/agent-tools.md`: table rows, a short
  "Imported towns" note with the usage-policy sentence. Tests in
  `tools.test.ts` with a stubbed fetch returning the fixture.
- e2e `e2e/game.spec.ts`: (a) file path — open the new-game page,
  `setInputFiles` with `src/import/fixtures/town.osm`, expect the
  report line, start, expect `osm-attribution` visible and the
  population counter > 0 within the usual wait; (b) search path —
  `page.route` stubs Nominatim (one hit) and the Overpass endpoint
  (fixture body), search, pick, load, same assertions. Run in the
  sandbox with the temporary Playwright config (memory) if possible,
  otherwise note it for the Mac.
- `docs/idea.md`: "Import a town from OpenStreetMap" entry under Next
  ideas (done, with the spike figures and the probe command);
  `docs/plan.md` Post-MVP checkbox; `CLAUDE.md` architecture list gets
  `src/import/` (DOM-free parser, rasteriser and fetch wrappers, tested
  in node; the only network code in the app) and the CSP note.

## Task 7 — settling probe and tuning

- `scripts/probe-osm.mjs --sim [days]` (or a sibling
  `scripts/probe-osm-sim.mjs`): rasterise, init a headless `SimEngine`
  with the layout, run N days and print population, supplied share,
  treasury and deficit ticks per day — on the fixture and on a real
  export (`*.osm` in the repo root is gitignored; Thorsten drops one
  in). Tune `BALANCE.osmImport.buildingsPerDensity` so a real small
  town starts with a population in the range of the old-town scenario
  after its first day and does not bankrupt the player before a first
  plant can be built; record the figures in `docs/idea.md`. Delete the
  sim probe afterwards (the ASCII probe stays).
- Mac check: load Schwabmünchen at 96, look at the isometric view
  (bridges over the Singold, level crossings, the rail line, forest
  edges), and note anything the rasteriser should fix.
