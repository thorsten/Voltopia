# Import a town from OpenStreetMap — design

Date: 2026-10-26 · Status: draft, awaiting approval

## Goal

Rebuild a real town from OpenStreetMap data and play it: the player
searches a place by name on the new-game page, picks the excerpt size,
Voltopia fetches the data and puts the town's roads, rail, river,
lakes, woods, zones and settled buildings on the tile grid. A `.osm`
file can be dropped in instead (offline, own excerpt). The game is then the
usual one — supply the town with renewables — on a map the player knows.

Spike result (2026-10-26, Schwabmünchen, 3.5 km, 96 tiles at 37 m per
tile): B17, Singold, the Augsburg–Buchloe line, the industrial north
and the old town are recognisable; the road network is one component;
23 % of road tiles are corners; 78 % of zone tiles touch a road.
Probe: `scripts/probe-osm.mjs` (branch `spike/osm-import`).

## Scope

- **Input, default**: place search (Nominatim) plus a direct download
  of the excerpt from the Overpass API, both public OSM services,
  called from the browser without keys. This is the only network use
  of the app besides loading itself; the game stays offline-first and
  the import page says so when the fetch fails.
- **Input, fallback**: one `.osm` XML file (OSM API `map` call or the
  Overpass export from openstreetmap.org) chosen on the same page — for
  offline play, the native app without network, or a hand-picked box.
  Both inputs feed the same parser and rasteriser.
- **Output**: a free-play (or sandbox) city whose map comes from the
  file instead of the seeded generators. Everything after tick 0 is the
  normal sim.
- **Attribution**: "© OpenStreetMap contributors" (ODbL) is shown for
  the lifetime of an imported city (HUD) and explained on the imprint.

## Parsing and rasterising (`src/import/`, DOM-free)

A new top-level `src/import/` holds pure, DOM-free code (string in,
layout out), unit-tested in node and reused by the probe script.

`parseOsm(xml: string): OsmData` — nodes (id → lon/lat), ways (node
refs + tags), multipolygon relations (outer way refs + tags), `bounds`
when present. Regex-based like the probe: the OSM API and Overpass
output is machine-written XML, no entity or namespace handling is
needed beyond `&amp;`-style escapes in tag values. The parser never
throws on unknown elements; a document without a single way is an
import error ("not an OSM file"). The Overpass query asks for the
classic node + way output (`out body; >; out skel qt;`), so one
parser serves both inputs.

`rasteriseTown(data, size, bbox?): TownLayout` with
`size ∈ MAP_SIZES` (48/64/96/128):

- **Projection**: bounding box from the argument (search flow), else
  `<bounds>` (file flow), else the nodes; made square in metres around
  its centre (equirectangular, metres per degree at the centre
  latitude). The report carries metres per tile.
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

## Fetching (`src/import/fetch.ts`)

Thin, DOM-free wrappers over `fetch` (injected for tests):

- `searchPlaces(query, locale): Promise<PlaceHit[]>` — Nominatim
  `search` (`format=jsonv2`, `limit=8`, `accept-language` from the UI
  locale, `featureType` unset so villages and districts count). A hit
  is `{ name, displayName, type, lat, lon }`. Nominatim's usage policy:
  at most one request per second and **no autocomplete** — the search
  runs on Enter / button only, and a second search within a second
  waits. The browser's `Referer` identifies the app; no key.
- `fetchTown(center, sideKm, signal): Promise<string>` — Overpass QL
  with `[bbox:S,W,N,E]`, `[timeout:60]`, the union of exactly the tags
  in the mapping table (ways and multipolygon relations, `place` nodes,
  `building` ways) and `out body; >; out skel qt;`. POSTed to the first
  endpoint in `OSM_IMPORT.overpassEndpoints`
  (`overpass-api.de`, then `overpass.kumi.systems`); on a network error,
  HTTP 429/504 or a timeout the next endpoint is tried once, then the
  error surfaces. A 3.5 km small-town excerpt is 1–3 MB this way, not
  the 12 MB of a full `map` call.
- The excerpt side is one of `OSM_IMPORT.sideKm = [2.5, 3.5, 5]`; the
  bbox is the square of that side around the chosen place. Metres per
  tile follow from side and map size and are shown before fetching.
- **CSP**: the Tauri `connect-src` gains the Nominatim host and the
  Overpass endpoints (`src-tauri/tauri.conf.json`), nothing else. The
  web build has no CSP header to change. The native app can fetch the
  same way; without network it shows the error and the file input.
- **Privacy**: the request carries the player's IP and the search text
  to those services; the imprint gets a paragraph (together with the
  ODbL note) and the import section links to it.

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

- **New-game page**: a section "Import a town" with, in order:
  1. **Search**: a text field with a search button (Enter works), a
     result list (name, type, region) to pick from; the chosen place
     shows as a chip with its coordinates.
  2. **Excerpt**: side 2.5 / 3.5 / 5 km and the map size (64/96/128;
     48 allowed but it loses the quarters), with the resulting metres
     per tile; "Load town" fetches with a progress state ("Loading
     from OpenStreetMap…", cancellable) and a note that this contacts
     openstreetmap.org services.
  3. **Or a file**: a file input (`.osm`, `.xml`) as the alternative,
     in a collapsed "Import a file instead" row.
  4. **Preview** (after either input): a canvas minimap in the minimap
     colours (road, avenue, rail, water, forest, zones, buildings) and
     the report as one line of figures (metres per tile, roads, zones,
     buildings, dropped zone tiles). Changing the map size
     re-rasterises the already parsed data; changing the side or the
     place requires a new load.
  5. The existing difficulty / disasters / sandbox controls, then
     "Start": stores the layout with the pending new-game options
     (base64url-encoded typed arrays, ~100 KB at 128², under the
     localStorage budget) and reloads like every new city.
     Parsing and rasterising run on the main thread (a 3 MB Overpass
     answer parses well under a second; a 12 MB file about one).
- Errors show inline under the step they belong to, the Start button
  stays disabled: no result for the search, search service unavailable,
  town download failed or timed out (with "try again" and a pointer to
  the file input), not an OSM file, box larger than 20 km, nothing
  rasterised (empty countryside).
- **HUD**: an attribution line "© OpenStreetMap contributors" (links to
  openstreetmap.org/copyright) at the bottom of the HUD whenever
  `stats.origin?.source === 'osm'`. Small, permanent.
- **Imprint**: a paragraph on OSM data and the ODbL, and one on the
  requests to Nominatim and Overpass (what is sent, that nothing is
  stored by Voltopia).
- **Saves page**: the default name of the first save of an imported
  city is the town name.
- All strings EN + DE in `i18n.tsx`.

## Agent tools

`get_game_overview` reports `origin` (source, name, bbox) when set;
`get_build_catalog` lists the import mapping table under `osmImport`.
`search_places({ query })` returns the Nominatim hits and
`import_town({ query | lat + lon, sideKm, size, difficulty, disasters,
sandbox })` runs search (first hit wins), fetch, parse and rasterise and
starts the city through `AgentContext.startNewCity` like
`start_new_city` does. Both stay in the DOM-free `tools.ts`: the
network goes through an injected `fetch` on the context, so the tool
tests stub it. Documented in `docs/agent-tools.md` with the
usage-policy note (one request per second, no search loops).

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
- `src/import/fetch.test.ts`: with an injected `fetch`: the Nominatim
  URL and parameters, hit mapping, the Overpass query text (every
  mapping tag present, bbox order S,W,N,E), endpoint fallback on 429 /
  network error / timeout, error after the last endpoint, the one-
  request-per-second gate, abort via signal.
- `src/ui/newGame.test.ts`: pending options with a layout round-trip
  through storage; oversize layout rejected.
- e2e: the file path — upload the fixture with `setInputFiles`, see the
  preview, start, the HUD shows the attribution and the population
  counter rises. The network path is covered with Playwright's
  `page.route` stubbing Nominatim and Overpass (fixture as the Overpass
  answer), so CI never calls the real services.
- Probe: `scripts/probe-osm.mjs` is rewired onto `src/import/*.ts`
  (node imports the TS directly, see memory) and keeps the ASCII
  output; used to tune `BALANCE.osmImport` and documented in idea.md.

## Out of scope

Sea and coastline; elevation from a DEM; a map to drag the excerpt
around (search + side is enough for a first version; a file covers the
rest); search-as-you-type (forbidden by Nominatim's policy); goals or a scenario frame for imported towns (free
play goals apply; an "electrify your town" scenario over an import is a
follow-up once the first towns have been played); OSM buildings as
building shapes; importing power lines (`power=line`) or plants — the
energy system is the player's job.
