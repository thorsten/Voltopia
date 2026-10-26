# Import a town from OpenStreetMap — design

Date: 2026-10-26 · Status: draft, awaiting approval

## Goal

Rebuild a real town from an OpenStreetMap export and play it: the
player picks a map excerpt on openstreetmap.org, drops the `.osm` file
into Voltopia and gets the town's roads, rail, river, lakes, woods,
zones and settled buildings on the tile grid. The game is then the
usual one — supply the town with renewables — on a map the player knows.

Spike result (2026-10-26, Schwabmünchen, 3.5 km, 96 tiles at 37 m per
tile): B17, Singold, the Augsburg–Buchloe line, the industrial north
and the old town are recognisable; the road network is one component;
23 % of road tiles are corners; 78 % of zone tiles touch a road.
Probe: `scripts/probe-osm.mjs` (branch `spike/osm-import`).

## Scope

- **Input**: one `.osm` XML file (OSM API `map` call or the Overpass
  export from openstreetmap.org), chosen on the new-game page. No
  network access from the app: the player downloads the file, the app
  stays offline-first and the Tauri CSP stays `connect-src 'self'`.
- **Output**: a free-play (or sandbox) city whose map comes from the
  file instead of the seeded generators. Everything after tick 0 is the
  normal sim.
- **Attribution**: "© OpenStreetMap contributors" (ODbL) is shown for
  the lifetime of an imported city (HUD) and explained on the imprint.

## Parsing and rasterising (`src/import/`, DOM-free)

A new top-level `src/import/` holds pure, DOM-free code (string in,
layout out), unit-tested in node and reused by the probe script.

`parseOsm(xml: string): OsmData` — nodes (id → lon/lat), ways (node
refs + tags), multipolygon relations (outer way refs + tags), `bounds`.
Regex-based like the probe: the OSM API output is machine-written XML,
no entity or namespace handling is needed beyond `&amp;`-style escapes
in tag values. The parser never throws on unknown elements; a file
without a single way is an import error ("not an OSM file").

`rasteriseTown(data, size): TownLayout` with
`size ∈ MAP_SIZES` (48/64/96/128):

- **Projection**: bounding box from `<bounds>` (else from the nodes),
  made square in metres around its centre (equirectangular, metres per
  degree at the centre latitude). The report carries metres per tile.
- **Mapping** (OSM tag → layer), see table. Everything else is ignored;
  `highway=service|footway|path|track|steps|cycleway` on purpose — they
  would turn the map into one road surface.

| OSM                                                              | Tile                                            |
| ---------------------------------------------------------------- | ----------------------------------------------- |
| `highway=motorway/trunk/primary/secondary/tertiary` and `*_link` | road, avenue                                    |
| `highway=residential/unclassified/living_street`                 | road, street                                    |
| `highway=pedestrian`                                             | road, street with the pedestrian lane           |
| `railway=rail` without `service=*`                               | rail                                            |
| `waterway=river/canal/stream`                                    | terrain river (1 tile wide)                     |
| `natural=water`, `water=*`, `landuse=reservoir/basin`            | terrain lake (filled polygon)                   |
| `landuse=forest`, `natural=wood`                                 | forest, mature stage                            |
| `landuse=residential/commercial/retail/industrial`               | zone                                            |
| `building=*`                                                     | not rasterised; counted per tile (see settling) |
| `place=city/town/village` node                                   | town name (largest place inside the box)        |

- **Lines** are drawn 4-connected (Bresenham variant that never steps
  diagonally) so the sim's N/E/S/W adjacency sees one connected road.
  No simplification: the spike's Manhattan variant split parallel ways
  and boxed rivers.
- **Areas** are scanline-filled (even-odd), largest first, so a retail
  block inside a residential area wins its tiles. Multipolygon
  relations fill their outer rings.
- **Layer priority** on a tile, low to high: zone < forest < lake <
  river < rail < street < avenue. Terrain is a separate layer: a road
  on a river tile stays a river tile (bridge, as in the sim); a road on
  a lake tile turns the tile into land (the sim cannot pave water);
  zones and forest are cleared on water.
- **Thinning**: dual carriageways and double-track lines land two tiles
  wide. Any 2×2 block of road tiles (or of rail tiles) loses one tile,
  unless removing it would split the network (component count checked
  before and after; on a split the tile stays).
- **Unserved zones**: zone tiles without a road neighbour are dropped —
  the sim would never grow them and they would look like a bug.
- **Settling**: tiles that are zoned, on land, empty and road-served and
  that hold at least `BALANCE.osmImport.buildingsPerDensity[0]`
  building centroids get a stamped building; more centroids raise the
  density (thresholds for density 1/2/3 in `BALANCE.osmImport`, tuned by
  a headless probe so an imported small town starts with a population
  comparable to the old-town scenario's pacing). The town therefore
  starts inhabited and unpowered.
- **Report** (shown in the preview, returned by the API): metres per
  tile, tile counts per layer, road components, dropped zone tiles,
  settled buildings, skipped highway classes.

`TownLayout` (in `src/shared/types.ts`, plain typed arrays so it
crosses the worker boundary by structured clone):
`{ size, terrain: Uint8Array, forest: Uint8Array, road: Uint8Array
(0 none, 1 street, 2 avenue), pedestrian: Uint8Array, rail: Uint8Array,
zone: Uint8Array, density: Uint8Array, name: string | null,
bbox: [w, s, e, n] }`.

Out of the mapping, deliberately: the sea (`natural=coastline` is a
ring around the planet, not a polygon; tidal plants stay for generated
maps), elevation (flat map, level 0 everywhere — no slope surcharges,
no flood basins beyond the river tiles), power lines, bus stops and
plants (the player builds the energy system; that is the game).

## Sim (`src/sim/importTown.ts`)

- `init` gets an optional `layout: TownLayout` (plus `startingMoney`,
  `disasterScale`, `sandbox` as for a free city; `scenario` and
  `layout` are mutually exclusive, `save` wins over both).
- The worker validates the layout before use: size in `MAP_SIZES`,
  every array `size²` long, values in range; otherwise it falls back to
  a seeded free city and posts `rejected` ("invalidLayout").
- `applyTownLayout(state, layout)`: elevation stays 0; terrain and
  forest are copied; `generateGeothermal` + `discoverGeothermalFields`
  still run (seeded by the city seed); then inside `withFreeBuild`:
  `stampRoads` (streets, then avenues), `stampLanes` for pedestrian
  streets, new `stampRail`, `stampZone`, `stampBuildings` with the
  layout's density. The stamp helpers throw on anything the sim rejects;
  the rasteriser's rules are built to never trigger that, and a test
  runs the real fixture through both to prove it.
- `state.origin?: { source: 'osm'; name: string | null; bbox }` is set,
  serialised as an optional `SaveGame.origin` (backward compatible, no
  `SAVE_VERSION` bump) and reported in `GlobalStats.origin` and the
  JSON export, so the attribution follows the city through saves and
  share links.
- Deterministic: same layout + seed ⇒ same state hash after N ticks
  (stamped building variants come from the state RNG).
- Undo stack is cleared after the stamp; the treasury is untouched.

## UI

- **New-game page**: a section "Import a town" with a file input
  (`.osm`, `.xml`), the size choice (64/96/128; 48 allowed but it loses
  the quarters), and the existing difficulty / disasters / sandbox
  controls. Choosing a file parses and rasterises on the main thread
  (a 12 MB export takes about a second; the button shows "Reading…"),
  then shows a **preview**: a canvas minimap in the minimap colours
  (road, avenue, rail, water, forest, zones, buildings) and the report
  as one line of figures (metres per tile, roads, zones, buildings,
  dropped zone tiles). Changing the size re-rasterises the already
  parsed data. "Start" stores the layout with the pending new-game
  options (base64url-encoded typed arrays, ~100 KB at 128², under the
  localStorage budget) and reloads like every new city.
- Errors (not an OSM file, box larger than 20 km, nothing rasterised)
  show inline under the file input; the Start button stays disabled.
- **HUD**: an attribution line "© OpenStreetMap contributors" (links to
  openstreetmap.org/copyright) at the bottom of the HUD whenever
  `stats.origin?.source === 'osm'`. Small, permanent.
- **Imprint**: a paragraph on OSM data and the ODbL.
- **Saves page**: the default name of the first save of an imported
  city is the town name.
- All strings EN + DE in `i18n.tsx`.

## Agent tools

`get_game_overview` reports `origin` (source, name, bbox) when set;
`get_build_catalog` lists the import mapping table under `osmImport`.
No tool starts an import: the input is a multi-megabyte file, far
beyond a tool call. An agent that wants a real town opens a shared
link of one (`open_shared_city`). Documented in `docs/agent-tools.md`.

## Testing

- `src/import/osm.test.ts`: parser on a small hand-made fixture
  (`src/import/fixtures/town.osm`, generated by the probe's fixture
  script, about 25 KB): nodes, ways, tags, a multipolygon, `bounds`,
  escaped tag values, garbage input.
- `src/import/rasterise.test.ts`: every mapping row, largest-first
  areas, 4-connectivity of a diagonal way, bridge vs lake rules, 2×2
  thinning (and the split guard), unserved zones dropped, settling
  thresholds, report figures, size handling (48–128), bbox from nodes.
- `src/sim/importTown.test.ts`: fixture layout → `SimEngine` init:
  tile layers match, buildings only on zoned road-served land, flat
  elevation, origin set, determinism (hash after 400 ticks), save →
  load round trip keeps origin, worker rejects an invalid layout.
- `src/ui/newGame.test.ts`: pending options with a layout round-trip
  through storage; oversize layout rejected.
- e2e: upload the fixture with `setInputFiles`, see the preview, start,
  the HUD shows the attribution and the population counter rises.
- Probe: `scripts/probe-osm.mjs` is rewired onto `src/import/*.ts`
  (node imports the TS directly, see memory) and keeps the ASCII
  output; used to tune `BALANCE.osmImport` and documented in idea.md.

## Out of scope

Fetching from Overpass inside the app; sea and coastline; elevation
from a DEM; editing the excerpt in the app (choose it on
openstreetmap.org); goals or a scenario frame for imported towns (free
play goals apply; an "electrify your town" scenario over an import is a
follow-up once the first towns have been played); OSM buildings as
building shapes; importing power lines (`power=line`) or plants — the
energy system is the player's job.
