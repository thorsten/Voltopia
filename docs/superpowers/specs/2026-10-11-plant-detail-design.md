# Plant and Service Building Detail — Design

Date: 2026-10-11
Status: approved for planning
Part 4 of 5 of the visual-detail programme (2026-10-07): (1) lighting
and materials, (2) vehicles, (3) buildings stage 4 — all merged, (4)
plants and service buildings, (5) infrastructure and nature. Style:
detailed low-poly, no textures.

## Goal

All 21 `PlantType`s — energy plants, storage, the services (fire,
police, depots, charging hub, park) and the rail and grid buildings —
are drawn by `src/render/plantsMesh.ts` as at most eight axis-aligned
boxes per tile in one shared `InstancedMesh`, told apart mostly by
colour. Only wind rotors spin and the battery shows its state of charge;
nothing lights up at night. Part 4 gives every type a recognisable,
detailed model and night lights: lit windows on staffed buildings, red
aviation lights on tall structures, yard lamps at substations, rail and
depots — dark when the tile is not on a grid island.

## Decisions

Made with the user during brainstorming:

- **One fixed model per type** (rejected: extending the zone-building
  recipe system — per-tile variety buys little for single landmark
  buildings and `recipes.ts` is already 2 200 lines; two or three models
  per type — twice the modelling for variety few players notice).
- **Models plus night lights** (rejected: models only; models, lights,
  curtailment/offline states and fan/steam animations — about half as
  much work again and needs per-tile curtailment in the diffs).
- **Technique: merged geometry with baked vertex colours** (decided by
  the controller, as for vehicles): one draw call per type, details in
  fixed colours, no textures.

## Architecture

### Model kit (`src/render/modelKit.ts`, new)

The vehicle builder's primitives move here and grow:

- `box(w, h, d, x, y, z, color)`, `cylinder(r, h, x, y, z, color,
segments?)` (upright), `tube(r, l, x, y, z, color, axis)` (lying),
  `sphere(r, x, y, z, color)`, `dome(r, squash, x, y, z, color)`,
  `gable(w, h, d, x, y, z, color, ridgeAlong?)` (prism roof),
  `cone(rBottom, rTop, h, x, y, z, color)` (tapered tower).
- `merge(parts): { geometry, parts }` merges with a `color` attribute
  and returns the part count. `tilted(geometry, angleX)` rotates a
  finished primitive about its own centre; turning a whole model to its
  site is the instance matrix, not a kit helper.
- `src/render/vehicles/models.ts` imports `box`/`tube`/`merge` from the
  kit; vehicle geometry is unchanged (the existing vehicle model tests
  prove it).

### Plant models (`src/render/plants/models.ts`, new)

`plantModel(type): PlantModel` with

```ts
interface PlantModel {
  geometry: THREE.BufferGeometry | null; // vertex colours, base at y = 0, centred; null for the park
  parts: number; // ≤ MAX_PARTS_PER_PLANT_MODEL = 24
  plinth?: { sx: number; sz: number; color: number }; // absent for the park
  windows: WindowAnchor[]; // glass bottom-centre on a wall, face as quarter turn, size
  lamps: LampAnchor[]; // { x, y, z, kind: 'aviation' | 'yard' }
  rotorHub?: { x: number; y: number; z: number }; // wind only
  socFill?: { x: number; y: number; z: number; w: number; d: number; maxH: number }; // battery only
  groundProps?: GroundProp[]; // park: trees and benches, each on its own ground
}
```

Models face +z = "toward the river/lake/track" where a site matters;
`plantsMesh` turns them by quarter turns from `PlantSite` (run-of-river
across/along the river, pumped storage toward the lake, rail buildings
via today's `orientToTrack` logic expressed as a turn). Heights match
today's `plantHeight` within ±0.05 so picking and icons stay put;
`plantHeight` reads the model.

Model contents (≤ 24 parts each):

| Type            | Model                                                                      |
| --------------- | -------------------------------------------------------------------------- |
| SolarFarm       | three tilted module rows with frames and posts, inverter box, low fence    |
| WindTurbine     | tapered tower (cone segments), foundation ring, nacelle, hub (rotor stays) |
| Battery         | container row with vent grilles, transformer, cable trays (fill bar stays) |
| BiogasPlant     | digester with dome, second tank, silo clamp, pipes, flare stack            |
| ChargingHub     | canopy on columns, chargers, cabinet, parking marks                        |
| Park            | trees in three sizes and benches as ground props (lawn pads stay)          |
| RunOfRiver      | weir with gates, powerhouse with gable, trash rack                         |
| PumpedStorage   | powerhouse, two penstocks toward the lake, valve house                     |
| FireStation     | hall with three doors, hose tower, roof overhang, flagpole                 |
| PoliceStation   | station with entrance canopy, radio mast, car port                         |
| LogisticsDepot  | hall with roll-up doors, loading dock, yard                                |
| BusDepot        | shed with arched entrances, washing bay, office                            |
| HydrogenPlant   | electrolyser hall, spherical/horizontal tanks, pipe bridge, vent stack     |
| TidalPlant      | barrage with turbine houses and gates                                      |
| GeothermalPlant | drill tower, cooling cells, pipe runs, control house                       |
| HeatPlant       | heat-pump hall with fan units on the roof, pipe outlet                     |
| HeatStore       | tall insulated cylinder tank with ring bands and stair                     |
| Substation      | transformers, insulators, gantries, fence, control hut                     |
| TrainStation    | platform with canopy on columns, station building, clock                   |
| FreightTerminal | container stacks, gantry crane, office                                     |
| RailYard        | engine shed with gable roof and doors, sand tower                          |

### Rendering (`src/render/plantsMesh.ts`)

- One `InstancedMesh` per `PlantType` with its model geometry,
  `surfaceMaterial({ vertexColors: true })`, `castShadow`,
  `receiveShadow`, `frustumCulled = false`. Capacity grows on demand
  (start `PLANT_CAPACITY_START = 16`, doubling; a grown mesh replaces
  the old one in the scene), so 21 types never preallocate a whole map.
- Slopes: a `plinths` `InstancedMesh` (unit box, instance colour from
  the model's `plinth.color`: concrete, gravel or asphalt) draws one
  plinth per plant with the model's footprint, top at the tile-centre
  lift + `PLINTH_RISE (0.015)`, bottom at the lowest ground under the
  footprint (today's foundation rule). The model sits on the plinth top.
  Parks have no plinth: lawn pads hug the ground as today, and trees and
  benches are instanced ground props, each at its own ground height (the
  planned path is dropped — a flat path cannot follow a sloped lawn).
- The old shared box mesh, `BoxPart` lists and the biogas `domeMesh` are
  removed. Rotor, state-of-charge fill and lawn pads stay, placed from
  the model's anchors.
- Upload ranges are bounded by `count` (pattern from part 3).

### Night lights (`src/render/plantsMesh.ts`, `src/render/plants/lights.ts` new)

- **Windows:** `plantWindowFrames` (lit, `windowGeometry()` from part 3,
  visible day and night) and `plantWindowGlow` (night-only, MeshBasic,
  same opacity curve as zone buildings), one instance per model window
  anchor. Glow only when the tile's `island > 0`. Plants run that curve
  at full strength and show it as soon as it is above zero (zone
  buildings dim it to 95% and hide it below 2%) — deliberately a little
  brighter, since plants and service buildings are staffed around the
  clock.
- **Lamps:** one `plantLamps` `InstancedMesh` (small emissive-look
  MeshBasic quads/spheres, instance colour red for `aviation`, warm
  white for `yard`), opacity from the night factor; aviation lamps blink
  in sync across the map (`AVIATION_BLINK_HZ = 0.5`), as real wind
  farms do. Lamps only when `island > 0`.
- All light meshes `frustumCulled = false`, no shadows.

## Testing

- `modelKit.test.ts`: every primitive carries a `color` attribute of the
  right length, bounds match its arguments, `merge` counts parts.
- `vehicles/models.test.ts` unchanged and green (kit migration).
- `plants/models.test.ts`: for every `PlantType` — geometry with colour
  attribute, parts ≤ 24, footprint and geometry inside the tile
  (|x|, |z| ≤ 0.5), height = today's `plantHeight` ± 0.05, at least three
  distinct vertex colours (details exist); window anchors on a model
  face (within 0.01 of the surface, normal pointing out); staffed types
  (fire, police, depots, stations, hydrogen, geothermal, heat plant,
  rail yard) have ≥ 2 windows; wind turbine and heat store have an
  aviation lamp; substation and rail types have yard lamps.
- `plantsMesh.test.ts`: one mesh per type with count = plants of that
  type; capacity grows past 16 without losing instances; turns follow
  river, lake and track (existing orientation tests adapted); plinth
  bottom reaches the lowest ground on a sloped tile and the model never
  floats; park, battery fill and rotor tests stay green; window and lamp
  counts equal the anchors of placed plants; glow and lamps invisible by
  day, visible at night, off when `island = 0`.
- Render-only: nothing under `src/sim`, `src/shared`, `src/storage`,
  `src/agent` changes.

Acceptance on the Mac (the user): every plant and service type by day
and night recognisable at city zoom; windows lit, aviation lights
blinking, yard lamps; nothing floating on slopes; station and hydro
plants still face their track or water; frame time unchanged.

### Results (2026-10-11)

`pnpm format && pnpm typecheck && pnpm lint && pnpm format:check &&
pnpm coverage && pnpm build` all pass (94 test files, 1616 tests;
coverage on `src/sim` and `src/shared` well above the 90% gate). The
slowest single test is `full gameplay integration > grows a powered
city and balances energy over days` (`src/sim/integration.test.ts`) at
7.79 s — under the 15 s budget, nothing to fix.

`node scripts/smoke.mjs` fails in this sandbox with `error while
loading shared libraries: libnspr4.so: cannot open shared object file`
— a missing system library for headless Chromium, not an app or test
regression; needs the Mac.

The kit migration left the tank wagon's tube at the kit's
`ROUND_SEGMENTS = 12` rather than the vehicle code's previous 8, and
kit boxes are non-indexed (36 vertices) rather than the previous
indexed `BoxGeometry` (24): the shape, colours and bounds are
unchanged (the vehicle model tests pass unmodified) but the vertex
count is slightly higher.

Part and vertex counts per `plantModel(type)` (measured with a
temporary script, deleted after), plus the tree and bench ground
props, all within `MAX_PARTS_PER_PLANT_MODEL = 24`:

| Type            | Parts | Vertices |
| --------------- | ----: | -------: |
| HydrogenPlant   |    15 |     1836 |
| BiogasPlant     |    12 |     1800 |
| HeatPlant       |    12 |     1404 |
| GeothermalPlant |    15 |     1188 |
| Substation      |    21 |     1080 |
| RailYard        |    15 |      960 |
| HeatStore       |     8 |      936 |
| WindTurbine     |     6 |      756 |
| PumpedStorage   |     9 |      756 |
| TidalPlant      |    15 |      756 |
| BusDepot        |    13 |      672 |
| PoliceStation   |    15 |      648 |
| FreightTerminal |    16 |      576 |
| SolarFarm       |    15 |      540 |
| TrainStation    |    12 |      528 |
| ChargingHub     |    14 |      504 |
| FireStation     |    10 |      468 |
| LogisticsDepot  |    13 |      468 |
| Battery         |    12 |      432 |
| RunOfRiver      |    11 |      384 |
| Tree (prop)     |     3 |      288 |
| Bench (prop)    |     3 |      108 |
| Park            |     0 |        0 |

Park has no merged geometry (`geometry: null`, as designed — it draws
only lawn pads, trees and benches as ground props). The heaviest model
is `HydrogenPlant` at 1836 vertices, 15 parts — comfortably under the
24-part cap.

## Out of scope

Curtailment/offline/damage states on the models, fan and steam
animations, multi-tile buildings, variants per type, gameplay or save
changes, roads and nature (part 5).
