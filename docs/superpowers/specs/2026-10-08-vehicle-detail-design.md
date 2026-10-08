# Vehicle Detail — Design

Date: 2026-10-08
Status: approved for planning
Part 2 of 5 of the visual-detail programme (2026-10-07): (1) lighting
and materials — merged, (2) vehicles, (3) buildings stage 4, (4) plants
and service buildings, (5) infrastructure and nature. Style: detailed
low-poly, no textures.

## Goal

Every vehicle is two flat-coloured boxes: cars get one of six colours by
instance slot (so a car's colour jumps when the visible set changes),
vans, buses and trains one fixed colour; there are headlights but no
windows, wheels, bumpers or tail lights, and a train is a locomotive
plus one wagon. Part 2 gives every vehicle a recognisable silhouette and
readable details at the city camera's distance, four car body styles,
night tail lights, and longer trains whose wagons follow the track.

## Decisions

Made with the user during brainstorming:

- **Details plus several models** (rejected: details only, one model per
  type; details plus animated wheels, indicators and brake lights).
  Cars come in four body styles — hatchback, sedan, estate, SUV — chosen
  with the paint colour by a hash of the vehicle id. The bus gets a
  window band and roof battery packs, the van a box body with a lip and
  a livery stripe, the locomotive a pantograph (the catenary is real
  since railways), wagons windows (passenger) or one of three freight
  bodies (container, hopper, tank) by id. Tail lights glow red at night
  under the headlights' rule.
- **Longer trains** (rejected: locomotive plus one wagon, details only):
  three passenger wagons, four freight wagons. Each train keeps a short,
  transient trail of the track tiles it last left so wagons follow
  through curves and when departing a halt instead of collapsing onto
  the locomotive. The trail is not saved; after a load a train sorts
  itself out within a few tiles. Gameplay is unchanged.
- **Technique: vertex colours baked into merged geometry** (decided by
  the controller as the only approach that keeps one draw call per
  model): body parts are white and take the instance colour; glass,
  tyres, bumpers and lenses carry fixed vertex colours, which the
  instance colour multiplies — dark parts stay dark.

## Architecture

### Models (`src/render/vehicles/models.ts`, new)

A tiny builder: `part(width, height, depth, x, y, z, color)` returns a
translated `BoxGeometry` with a `color` vertex attribute; `model(parts)`
merges them. Shared fixed colours as named constants (`BODY = 0xffffff`,
`GLASS`, `TYRE`, `TRIM`, `LENS_FRONT`, `LENS_REAR`, `PANTOGRAPH`).
Exported builders, all pointing along +x like today's geometry, with
today's outer dimensions so lane offset, pitch sampling and wagon
spacing still fit:

| Builder                                                                    | Length × height × width (tiles)   | Parts                                                               |
| -------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------- |
| `hatchbackGeometry()`                                                      | 0.26 × 0.13 × 0.14                | body, cabin, glass band, 4 tyres, bumpers, lenses                   |
| `sedanGeometry()`                                                          | 0.30 × 0.13 × 0.14                | as above, longer boot                                               |
| `estateGeometry()`                                                         | 0.30 × 0.14 × 0.14                | as above, roof to the back                                          |
| `suvGeometry()`                                                            | 0.30 × 0.16 × 0.15                | taller body, roof rails                                             |
| `vanGeometry()`                                                            | 0.34 × 0.18 × 0.15                | box body, cab, windscreen, lip, livery stripe (fixed colour), tyres |
| `busGeometry()`                                                            | 0.40 × 0.20 × 0.16                | body, window band both sides, door marks, roof battery packs, tyres |
| `locomotiveGeometry()`                                                     | `LOCOMOTIVE_LENGTH` × 0.30 × 0.18 | body, cab windows, pantograph, two bogies                           |
| `passengerWagonGeometry()`                                                 | `WAGON_LENGTH` × 0.20 × 0.17      | body, window band, roof, bogies                                     |
| `containerWagonGeometry()`, `hopperWagonGeometry()`, `tankWagonGeometry()` | `WAGON_LENGTH` × ≤ 0.22 × 0.17    | flat car + load, bogies                                             |
| `tailLightGeometry()`                                                      | small pair of quads at the rear   | for the night tail-light mesh                                       |

Each model stays within a part budget (`MAX_PARTS_PER_MODEL = 16`) so a
city at the 220-car cap stays cheap.

### Selection (`src/render/vehicles/variety.ts`, new)

`vehicleHash(id): number` (deterministic integer hash),
`carStyleOf(id): CarStyle` (`'hatchback' | 'sedan' | 'estate' | 'suv'`),
`carColorOf(id): number` from `CAR_COLORS` (about ten paints),
`freightBodyOf(id): 'container' | 'hopper' | 'tank'`. Pure, unit-tested.

### Renderer (`src/render/vehiclesMesh.ts`)

One `InstancedMesh` per model (four car styles, van, bus, locomotive,
freight locomotive, passenger wagon, three freight wagons) with
`surfaceMaterial({ vertexColors: true })` and per-instance colour set
every frame from the id (cars) or a constant per type (others), all
`frustumCulled = false`. A `tailLights` mesh mirrors `headlights`
(MeshBasic, red, opacity from the same night factor), placed at the
rear of every road vehicle and the last wagon of a train. Capacity
constants grow: cars per style `MAX_CARS_PER_STYLE = 256` (the sim caps
cars at 220, so any style can hold them all), wagons `MAX_WAGONS =
MAX_TRAINS * 4`. Lane offset, pitch and interpolation are unchanged.

### Train trails and wagons (`src/sim/trains.ts`, `src/sim/state.ts`, `src/sim/engine.ts`, `src/shared/constants.ts`, `src/shared/types.ts`)

- `Train.trail: number[]` — transient (not in `SavedTrain`), the last
  `TRAIL_TILES` track tiles the train left, newest last; appended when
  the train advances onto a new tile, trimmed from the front. A fresh or
  loaded train starts with an empty trail.
- `trailingPoint(state, train, gap)` walks back through the current
  path behind `pathIndex`, then through `trail`, so a wagon keeps its
  place when a new leg starts at a halt and through a curve.
- `BALANCE.rail.passengerWagons = 3`, `BALANCE.rail.freightWagons = 4`;
  the trail length is derived (`wagons × wagonGap + 2` tiles, rounded
  up) rather than a separate tuning value.
- `engine.collectVehicles` emits, per running train, the locomotive and
  wagons `k = 1..n` at `trailingPoint(state, train, k × wagonGap)`, with
  ids `train.id + k × WAGON_ID_OFFSET` (JS numbers; structured clone
  keeps them exact). `VehicleKind.Wagon`/`FreightWagon` stay; the
  renderer picks the freight body from the wagon id.

## Testing

- `models.test.ts`: every builder returns geometry with a `color`
  attribute the length of its positions, a bounding box equal (± 0.005)
  to its table dimensions, a part count ≤ `MAX_PARTS_PER_MODEL`, and at
  least one non-white vertex colour (details exist).
- `variety.test.ts`: style, colour and freight body are stable per id,
  and over 1 000 consecutive ids every style and body occurs at least
  15 % of the time and every paint at least once.
- `vehiclesMesh.test.ts`: cars with different ids land in the style
  meshes their ids select; a car keeps its colour when other cars
  appear or disappear; tail lights count one per road vehicle plus one
  per train and fade with the night factor; trains still sit on the
  centre line.
- `trains.test.ts`: a train that turns a corner places every wagon on a
  track tile centre line, about `wagonGap` apart along the track; right
  after departing a halt (new leg) its wagons are still behind it, not
  on it; the trail never exceeds its length; `SavedTrain` has no trail.
- `engine.test.ts`: a running passenger train emits 1 + 3 vehicles, a
  freight train 1 + 4, with distinct ids and wagon kinds.
- Render only besides the train trail; `stepTick` cost is checked
  against `main` with the tick-cost probe (memory: CI budget).

Acceptance on the Mac (the user): day and night screenshots of a street
and a rail line; the cars look varied, buses, vans and trains read at
city zoom; tail lights at night; trains turn and depart without wagons
jumping.

## Out of scope

Rotating wheels, indicators, brake lights, new vehicle types, liveries
per company, textures, sound.

## Addendum (2026-10-08): push-pull at reversals

Found in review: on a terminus reversal the trail points back the way
the train came, so for about three ticks the wagons run through the
locomotive. Decided with the user: **push-pull** (rejected: accept the
fold as a visual quirk). Render semantics only — the sim still moves
the locomotive's position, so tour timing and gameplay are unchanged.

- `Train.pushing: boolean`, transient like `trail` (false when created,
  parked or loaded).
- Reversal: when `routeToNextHalt` gives a train a new leg whose first
  step goes back to the tile it came from, `pushing` toggles. Switching
  from pushing to pulling rebuilds `trail` from the tiles the wagons
  occupied ahead of the locomotive, so they stay where they physically
  are.
- `consistAhead(state, train, length)` walks forward from the
  locomotive along the remaining path, then continues along the track
  beyond the path's end (straight on, or the single other track
  neighbour in a curve), and stops at a buffer or an ambiguous
  junction. `leadingPoint(state, train, gap)` places a wagon on it.
- Wagons are placed by `trailingPoint` while pulling and by
  `leadingPoint` while pushing, so the consist never jumps at a
  reversal.
- Lights follow the consist: `VehicleState` gains optional `lead` and
  `tail` flags (backward compatible). While pulling the locomotive leads
  and the last wagon carries the tail lights; while pushing the far
  wagon leads and the locomotive carries them. The renderer uses the
  flags for trains instead of the wagon-index rule.
- Known limit: pushing into a buffer stop compresses the consist over
  the last tiles before the locomotive stops, because the track ends.
  A yard at a dead end is the common case; parked trains are not drawn.
