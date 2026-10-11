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
  `dome(r, squash, x, y, z, color)`, `gable(w, h, d, x, y, z, color,
turn?)` (prism roof), `cone(rBottom, rTop, h, x, y, z, color)`
  (tapered tower).
- `merge(parts): { geometry, parts }` merges with a `color` attribute
  and returns the part count. Named rotation helper `turned(geometry,
quarterTurns)`.
- `src/render/vehicles/models.ts` imports `box`/`tube`/`merge` from the
  kit; vehicle geometry is unchanged (the existing vehicle model tests
  prove it).

### Plant models (`src/render/plants/models.ts`, new)

`plantModel(type): PlantModel` with

```ts
interface PlantModel {
  geometry: THREE.BufferGeometry; // vertex colours, base at y = 0, centred
  parts: number; // ≤ MAX_PARTS_PER_PLANT_MODEL = 24
  footprint: { sx: number; sz: number }; // plinth size on the ground
  windows: WindowAnchor[]; // façade slots (position, normal, scale)
  lamps: LampAnchor[]; // { x, y, z, kind: 'aviation' | 'yard' }
  socFill?: { x: number; z: number; w: number; d: number; h: number }; // battery only
  rotorHub?: { x: number; y: number; z: number }; // wind only
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
| Park            | trees in three sizes, path, benches (lawn pads stay)                       |
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
- Slopes: a `plinths` `InstancedMesh` (unit box, instance colour
  `PLINTH_COLOR`) draws one plinth per plant with the model's footprint,
  top at the tile-centre lift, bottom at the lowest ground under the
  footprint (today's foundation rule). The model sits on the plinth top.
  Parks keep their ground-hugging lawn pads and per-tree ground height.
- The old shared box mesh, `BoxPart` lists and the biogas `domeMesh` are
  removed. Rotor, state-of-charge fill and lawn pads stay, placed from
  the model's anchors.
- Upload ranges are bounded by `count` (pattern from part 3).

### Night lights (`src/render/plantsMesh.ts`, `src/render/plants/lights.ts` new)

- **Windows:** `plantWindowFrames` (lit, `windowGeometry()` from part 3,
  visible day and night) and `plantWindowGlow` (night-only, MeshBasic,
  same opacity curve as zone buildings), one instance per model window
  anchor. Glow only when the tile's `island > 0`.
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

## Out of scope

Curtailment/offline/damage states on the models, fan and steam
animations, multi-tile buildings, variants per type, gameplay or save
changes, roads and nature (part 5).
