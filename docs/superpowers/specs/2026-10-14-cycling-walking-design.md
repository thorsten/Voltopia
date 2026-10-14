# Cycling and walking — Design

Date: 2026-10-14
Status: approved for planning

## Goal

Short car trips are the grid's most avoidable load: a commuter who
lives a few blocks from work still drives an electric car and plugs it
in at dusk. Bike lanes and pedestrian streets give the player a way to
take those trips off the road. A commuter who can walk or cycle to work
leaves the car at home, so the evening charging peak falls — the same
lever the railway and the bus network already pull, now for the short
distances neither of them serves.

## Decisions (with the user, 2026-10-14)

- **Energy lever first** (rejected: happiness and liveability as the
  main effect; both equally). No happiness term in this version.
- **Built as a road upgrade** (rejected: a separate path network with
  its own routing; a city-wide policy toggle without map objects).
  Drag over existing roads, like upgrading a street to an avenue.
- **Trip rule: home-to-work distance over the bike network** (rejected:
  plain grid distance regardless of infrastructure; a coverage share
  that removes a slice of the fleet city-wide). Lanes decide.
- **Pedestrian streets block motor traffic** (rejected: bike lanes
  only; a cosmetic pedestrian street). Cars, vans and buses route
  around them.
- **Decision by bounded Dijkstra** (rejected: network component ids
  plus Chebyshev distance, which counts a loop around a lake as short;
  lane share along the car route, which avoids pedestrian streets and
  so punishes the tiles built for it).

## Scope

In: one new road attribute with two values, one build command, build
rules, two commuter modes, the routing change for motor traffic, the
rendering of lanes and pedestrian streets, two UI tools, the inspector,
a goal, an agent tool, save compatibility, a balancing probe.

Out: cyclist or pedestrian movers on the map, a happiness effect, bike
parking or e-bike charging load, lanes on bridges or overpass ramps,
pedestrian streets with a bus stop, a dedicated charging-peak metric
(the peak is visible in the charging row of the energy graph today and
falls on its own when fewer cars drive).

## Simulation

### State

`layers.roadLane: Uint8Array` with the values of a new `RoadLane` enum
in `src/shared/types.ts`: `None = 0`, `Bike = 1`, `Pedestrian = 2`.
Meaningful only on road tiles; bulldozing a road resets it to `None`
alongside `roadClass` and `overpass`. Part of the undo snapshot, the
save (optional field, no `SAVE_VERSION` bump; absent means all
`None`), and the tile diff (`TileDiff.roadLane`).

### Building

New module `src/sim/lanes.ts`, command `{ type: 'buildLanes'; tiles:
number[]; kind: RoadLane }` dispatched in `engine.ts`.

- Every tile must be a road. Tiles that already carry the requested
  kind are skipped and not charged; the whole batch is rejected when
  nothing is left to build. Changing `Bike` to `Pedestrian` or back is
  an ordinary build at the full price of the new kind.
- Price per tile: `BALANCE.costs.bikeLanePerTile` (15) and
  `BALANCE.costs.pedestrianPerTile` (40). Upkeep per tile:
  `BALANCE.upkeep.bikeLanePerTile` and `pedestrianPerTile` (small).
  Rejected with `insufficientFunds` when the treasury cannot pay the
  batch, like roads.
- A bike lane goes on streets and avenues alike; `roadClass` is kept.
- A pedestrian street is rejected on a tile with a bus stop, an
  overpass deck or ramp, a level crossing, or a bridge
  (`rejectedPedestrian` with a reason the UI can name). It keeps
  `roadClass` so undoing is a plain restore.
- Building a bus stop or an overpass on a pedestrian tile is rejected
  with the existing "needs a road" style reason.
- `removeLanes` is not a separate command: build `None` over the tiles
  (free, no upkeep afterwards). Undo restores the previous lane values
  and refunds.

### Motor traffic

`isRoad` in `routing.ts` gains a sibling `isMotorRoad`: a road tile
whose lane is not `Pedestrian`. `findRoadPath` and `roadDistances` use
it, so cars, delivery vans and buses never enter a pedestrian street
and route around it, or find no route and stay parked, exactly as they
do for a cut road today. `depotReach` thereby never lists a pedestrian
tile as a van stop; a shop beside a pedestrian street is still stocked
when any motor road tile that touches it lies in reach, because shop
stops are addressed by the road tile beside the shop, not the shop.

`roadTilesNextToZones` (home and work roads for new vehicles) skips
pedestrian tiles. An existing vehicle whose home or work tile becomes
pedestrian finds no path, parks, and is replaced through the normal
fleet resize, no special handling.

Traffic load, congestion and the `avenueShare` statistic ignore
pedestrian tiles (no car ever drives them).

### Commuter decision

In `vehicles.ts`, at the morning departure, before the bus and rail
checks (a walker never takes the bus):

1. **Walk** when the motor-or-pedestrian road distance from home to
   work is at most `BALANCE.cycling.walkTiles` (4). Walking needs no
   lane; any road is a pavement.
2. **Cycle** when a route over _bike-friendly_ tiles only (lane `Bike`
   or `Pedestrian`) from home to work is at most
   `BALANCE.cycling.bikeTiles` (20) tiles, where the home and work
   tiles themselves need no lane (the first and last tile of the trip).

Both use the existing `distances` helper with its `maxCost` bound and
a unit cost per tile (traffic and road class are irrelevant to a bike),
so the search stops early and never explores the whole map. Order: walk,
bike, bus, rail. The vehicle records `riderMode: 'walk' | 'bike'`,
`riderDay`, and stays parked; its battery does not drain, so it does
not charge in the evening. That is the whole energy effect, identical
to how a train rider lowers the charging load today.

`TransitStats` gains `walkRiders` and `bikeRiders`; `riderShare`
counts them. Existing goals that use `riderShare` (`modalShift`)
therefore also count walkers and cyclists, which is intended: the goal
rewards cars left at home.

### Goal

`activeCity`: population at least `BALANCE.goals.activeCity.population`
and walk-plus-bike share of commuters at least
`BALANCE.goals.activeCity.share` (0.25) through a full in-game day.
Counter `activeTicks` in `goalProgress`, persisted like `railTicks`.
Modelled on `railCity`.

### Balance

New `BALANCE.cycling = { walkTiles: 4, bikeTiles: 20 }`. A headless
probe (temporary script, deleted after) runs a mid-size mixed city with
and without bike lanes over 20 in-game days and prints rider share,
EV count on the road, and the charging consumption at 18:00–22:00. The
numbers go into `docs/idea.md` next to the railway's probe; the values
above move if the probe shows cycling either worthless or free.

## Rendering

`roadsMesh.ts` reads `roadLane` from the tile diff.

- **Bike lane:** two narrow coloured strips (a muted red-brown) along
  both kerbs of the roadway, following the road mask through bends and
  junctions like the kerbs do. Streetlamps, zebras and kerbs unchanged.
- **Pedestrian street:** the roadway surface uses a lighter paved
  colour instead of asphalt, no centre line, no zebra crossing, and a
  row of bollards across each end where it meets a motor road tile.
  Streetlamps stay.

No new mover meshes. Both variants are instanced like the existing road
kinds; new `InstancedMesh` instances set `frustumCulled = false`.

## UI

- `BuildBar.tsx` / `useTools.ts`: two drag tools, `bikeLane` and
  `pedestrian`, in the roads group next to the avenue, with the drag
  cost preview counting only road tiles that change. Message
  `buildLanes` with the kind.
- `TileInspector.tsx`: a line naming the lane kind on a road tile.
- `CityVitals.tsx`: the rider stat keeps one number (share of commuters
  not driving) and its tooltip lists walk, bike, bus and rail.
- Help text for the road tools explains the two kinds, the distance
  rule and that pedestrian streets block cars, vans and buses.
- All strings in `i18n.tsx`, English and German.

## Agent

`build_lanes` tool in `src/agent/tools.ts` with `tiles` and `kind`
(`'bike' | 'pedestrian' | 'none'`), the same rejection reasons as the
UI, `tileMirror` carrying `roadLane`, the tool description and the
table in `docs/agent-tools.md`.

## Save compatibility

`SaveGame.roadLane?: ArrayBuffer`. Loading an older save leaves every
tile at `None`. No `SAVE_VERSION` bump.

## Testing

- `lanes.test.ts`: build on roads, skip existing, reject off-road,
  reject pedestrian on bus stop / overpass / crossing / bridge, pricing
  and insufficient funds, undo refund and restore, bulldoze reset.
- `routing` / `vehicles` tests: pedestrian tiles impassable for cars,
  vans and buses; a shop beside a pedestrian street still stocked via a
  neighbouring motor road; walk decision at and above `walkTiles`;
  bike decision needs lanes on every inner tile and respects
  `bikeTiles`; walk before bus; riders do not charge; stats count
  modes; determinism (same seed, same hash).
- `goals.test.ts`: `activeCity` achieved after a day above the share.
- `serialization.test.ts`: round trip with and without the field.
- `roadsMesh.test.ts`: instance counts for lane strips and bollards.
- `tools.test.ts`: `build_lanes` success and rejections.
- e2e unchanged (the existing road drag test stays green).
