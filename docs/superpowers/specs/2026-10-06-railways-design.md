# Railways — Design

Date: 2026-10-06
Status: approved for planning
Backlog entry: `docs/idea.md` "Future Ideas" → **Railways**: trains
connecting villages/districts on large maps; built after per-district
grids so regions mean something.

## Goal

Buses cover a neighbourhood: a commuter rides when a served stop lies
within `stopRadius` 4 of both home and work, so a bus network only ever
shifts short commutes. A town with a residential district and a
business district 40 tiles apart has nothing against the cars crossing
the map twice a day, nor against the evening charging peak and the
congestion they bring. Deliveries have the same shape: a depot in the
centre with no factory within `maxRouteTiles` imports every tour and a
factory park at the edge sells to nobody.

Railways are the long-distance layer on top of both. Tracks are a new
line layer like power lines; stations, freight terminals and a rail yard
are plants beside them. Passenger trains connect stations: a commuter
whose home and work each have a different served station in one rail
network leaves the car at home. Freight trains connect factories to
logistics depots: a depot supplied by rail no longer imports and its
vans skip the factory leg. Trains draw traction power from the grid
island the yard stands on, so a district grid in deficit slows or stops
its trains — the first feature that pays the player for putting the
right infrastructure on the right island.

## Decisions

Made with the user during brainstorming:

- **Passengers and freight in one spec.** Freight stays thin: it bridges
  factories and depots, no stock quantities, no shops served directly,
  no rail export. Rejected: passengers only (freight later), shops
  served by freight terminals.
- **Automatic tours, no line editor.** A rail yard fields trains that
  visit the stations with the longest wait, the way the bus depot does.
  Rejected: player-drawn lines.
- **Separate passenger station and freight terminal.** Two plants, two
  meshes, two inspector paths; placement states intent. Rejected: one
  station type whose surroundings decide what it does.
- **Freight bridges factory and depot.** A depot reached by a freight
  train within the delivery window is locally supplied: its vans skip
  the pickup leg and the import fee, and their tours count as local for
  `localGoods`.
- **Catenary fed by the yard.** Running trains are live load on the
  yard's island; a deficit there stalls them with the same per-tick
  hash rule that flickers buildings. Rejected: battery trains charging
  at the yard (no new gameplay).
- **Tracks are a bitmask layer, not a tile type**, so a track can cross
  a road (level crossing) and share a tile with a power line.
- **Trains do not block each other** (no lane occupancy on rails) and
  do not interact with road traffic. YAGNI.
- **No regenerative braking**, no stations for buses-to-rail transfers,
  no noise penalty.

## Architecture

### Tracks (`src/sim/rail.ts`, `src/sim/state.ts`)

- New persisted layer `rail: Uint8Array` holding a 4-neighbour bitmask
  (`DIR_N/E/S/W`), the encoding of `roadMask` and `powerLine`.
  `recomputeRailMask(state, index)` refreshes a tile and its four
  neighbours; a tile with `rail !== 0` is a track tile. A track with no
  track neighbour keeps the mask 0 but is still a track: the layer
  therefore stores `mask | RAIL_PRESENT` (bit 4, value 16) so an
  isolated track tile is distinguishable from no track. Helper
  `hasRail(state, index)`.
- New `BuildIntent.Rail = 4`. `buildRejection` for it: `damaged` as for
  everything; `needsRailSite` when `density !== 0` or `tileType ===
Plant`; `cannotBuildOnWater` on lake and sea; river tiles are allowed
  as a rail bridge; `tooSteep` above `BALANCE.terrain.maxBuildSlope`.
  Roads and power lines may share the tile. Woods pay the felling fee
  through the existing forest hook, the slope surcharge applies as for
  roads.
- Zones and plants may not be built on a track tile; roads may (the
  reverse of the crossing). `buildRejection` for `Zone` and `Plant`
  returns `tileOccupied` when `rail !== 0`.
- `buildRail(state, tiles)` mirrors `buildPowerLines`: skips tiles that
  already carry track, charges `BALANCE.costs.rail.perTile` or
  `.bridgePerTile` on a river tile, rejects the whole drag when the
  treasury cannot pay, pushes one undo entry, marks tiles dirty. Upkeep
  `BALANCE.costs.upkeep.railPerTile` per track tile per tick, summed in
  `economyStep` next to the line upkeep.
- Bulldozer order on a shared tile: track first, road on the second
  pass (as power line before road today). Bulldozing a track under a
  running train is allowed; the train is re-routed or sent home (see
  Trains).
- **Networks.** `railNetworks(state)` labels connected components of
  track tiles by union-find over 4-neighbours, like `recomputeGrid` for
  islands, into a derived `railNetwork: Uint16Array` layer (0 = none)
  with `railNetworkKeys: number[]` (lowest tile index per network).
  Recomputed when `railVersion` changes (bumped by every track build or
  bulldoze), never per tick. A plant beside a track belongs to the
  network of that track; a plant touching tracks of two networks picks
  the lower key (they are one network as soon as the player closes the
  gap, so this is transient).

### Stations, terminals, yard (`src/sim/rail.ts`)

Three new plant types, all 1×1, appended to `PlantType`:

| Plant             | Value | Site rule                              |
| ----------------- | ----- | -------------------------------------- |
| `TrainStation`    | 19    | 4-neighbour touches a track AND a road |
| `FreightTerminal` | 20    | 4-neighbour touches a track            |
| `RailYard`        | 21    | 4-neighbour touches a track            |

`buildRejection` returns `needsRailAccess` when the track is missing
and, for the station, `needsRoadAccess` when the road is missing (the
existing rejection the bus depot uses). All three generate nothing and
appear in the energy cascade only through the traction load. They are
service plants: `plantUpkeep` entries, costs in `BALANCE.costs.plant`,
no `supplyRadius`.

- **Station.** `stationRoad(state, station)` is its lowest-index
  adjacent road tile (the halt the tour routes to is the adjacent track
  tile, `stationTrack`). A station is **served** when a passenger train
  halted at it within `serviceWindowDays`; a derived `stationAge:
Uint16Array` layer on the station tile counts ticks since the last
  halt (saturating, like `stopAge`). `updateRailCover(state)` rebuilds
  the derived `railStation: Int32Array` layer: for every road tile
  within `stationRadius` (Chebyshev) of a served station, the index of
  the nearest such station (ties: lower index), else -1. Changed tiles
  are marked dirty for the overlay.
- **Freight terminal.** Classified per tick, cheaply, from the plants
  list: it **loads** when a powered, undamaged factory tile lies within
  `freightRadius` (Chebyshev); it **unloads** when a logistics depot
  lies within that radius. Both at once is allowed. Derived
  `terminalAge` layer on the terminal tile: ticks since the last
  unloading halt (loading terminals keep it at 0).
- **Yard.** Owns the trains of its network: `syncTrainFleet(state)`
  gives every intact yard `passengerTrainsPerYard` passenger trains and
  `freightTrainsPerYard` freight trains parked at its adjacent track
  tile, drops trains whose yard is gone, and never gives trains to a
  yard that is not tied to the grid (`isTiedToGrid`). Several yards on
  one network share its stations; tours claim stations like buses claim
  stops.

### Trains (`src/sim/trains.ts`)

```ts
interface Train {
  id: number; // shares nextVehicleId
  kind: 'passenger' | 'freight';
  yard: number; // yard plant tile
  x: number;
  y: number;
  angle: number;
  path: number[]; // track tiles of the current leg
  pathIndex: number;
  stops: number[]; // halts of this tour (track tiles beside plants), closed by the yard track
  stopIndex: number;
  phase: TrainPhase; // Parked | ToStop | Dwelling | Turnaround
  dwellTicks: number;
  stalled: boolean; // stood still this tick for lack of power
}
```

- **Routing.** `src/sim/routing.ts` generalises to `findPath(state,
from, to, passable: (tile) => boolean, cost: (tile) => number)` and
  `distances(state, from, passable, cost, maxCost)`. `findRoadPath` and
  `roadDistances` become thin wrappers with the road predicate and
  `tileCost`; `findRailPath` and `railDistances` use `hasRail` and a
  flat cost of 1. Rail routing ignores traffic load.
- **Movement.** Trains step along `path` at
  `BALANCE.rail.speedTilesPerSecond / TICK_RATE` tiles per tick with
  the same corner interpolation as `advanceAlongPath`, but without the
  lane occupancy map (the shared helper takes an optional occupancy;
  trains pass none). A train whose next path tile lost its track is
  **lost**: it is parked at the yard track and its tour is dropped.
- **Passenger tour** (`planPassengerTour`): for a parked passenger
  train in the operating window `windowStartHour..windowEndHour`, take
  the stations of the yard's network whose `stationAge >= dueTicks / 2`
  and not claimed by another train, oldest first (ties: nearer by rail
  distance from the yard, then lower index), at most `stationsPerTour`,
  ordered nearest-neighbour from the yard, closed by the yard track.
  Empty when nothing qualifies, so an idle fleet does not circle. At a
  halt the train dwells `dwellTicks`, sets that station's `stationAge`
  to 0, then continues; back at the yard it waits `turnaroundTicks`.
- **Freight tour** (`planFreightTour`): for a parked freight train in
  the window, when at least one unloading terminal of the network has
  `terminalAge >= dueTicks / 2` and is unclaimed and at least one
  loading terminal exists: nearest loading terminal (ties: lower
  index), then up to `terminalsPerTour` due unloading terminals, oldest
  first, nearest-neighbour from the loading terminal, closed by the
  yard track. Dwell `loadTicks` at the loading terminal, `unloadTicks`
  at each unloading terminal; an unloading halt sets `terminalAge` to
  0 and stamps `railGoodsAge` (below) for every depot within
  `freightRadius` of that terminal.
- **Traction.** `trainsStep(state)` runs after `transitStep` in
  `tick.ts`. Before moving a train it reads the deficit share of the
  yard's island from the previous energy step (`state.lastIslands`,
  matched by island key; 0 when the island had no result yet). The train is
  `stalled` this tick when `hashTileTick(yard, tick) < deficitShare` (the helper in
  `energy.ts` becomes exported);
  a stalled train does not advance and does not dwell down. Trains of
  a yard that is not tied to the grid never leave the yard and are
  `stalled` while parked, so the inspector can say why.
  `tractionDemandByIsland(state): Float64Array` sums
  `tractionLoadPassenger` / `tractionLoadFreight` for every train in
  phase `ToStop` that is not stalled, on the island of its yard. Only
  moving trains draw. `energyStep` takes it as `input.tractionByIsland`
  next to `chargingByIsland`, adds it to the island's consumption and
  reports it as `traction` in the island and city breakdown.

### Riders (`src/sim/vehicles.ts`)

The morning departure branch becomes:

```ts
const busRide = transitCover[home] === 1 && transitCover[work] === 1;
const railRide = ridesRail(state, home, work);
if (busRide || railRide) {
  vehicle.riderDay = day;
  vehicle.riderMode = railRide && !busRide ? 'rail' : 'bus';
  break;
}
```

`ridesRail` is true when `railStation[home] >= 0`, `railStation[work]

> = 0`, the two stations differ and lie in the same rail network.
`riderMode`is a transient field on the vehicle (not persisted; a
loaded save re-decides next morning).`transitStats`gains`railRiders`and`busRiders`(today's riders by mode) next to the
existing`riders`, so `riderShare` keeps its meaning (all riders over
> commuters) and the chip can split it.

### Deliveries (`src/sim/deliveries.ts`)

- Derived `railGoodsAge: Uint16Array` on depot tiles: ticks since a
  freight train unloaded at a terminal within `freightRadius` of the
  depot (saturating). `isDepotRailSupplied(state, depot)` is `age <
supplyWindowTicks()`.
- `deliveriesStep`: when a van's depot is rail supplied, the tour is
  planned with `pickup = -1` and flagged `local = true` without the
  import fee; `importFeePerTour` is not charged. Otherwise unchanged
  (factory in reach or import). `deliveryStats` gains
  `depotsRailSupplied`.

### Economy

- Costs (`BALANCE.costs`): `rail.perTile`, `rail.bridgePerTile`,
  `plant[TrainStation|FreightTerminal|RailYard]`; upkeep
  `railPerTile` and the three plant upkeeps. The traction energy is
  paid through the island balance like every other load (it raises
  biogas burn and import on that island).
- No ticket income, no freight fee: the pay-off is fewer cars (less
  congestion, smaller evening charging peak, happier commuters), no
  import fees at rail-supplied depots and the `localGoods` and
  `railCity` goals.

### Rendering (`src/render/`)

- `railMesh.ts`: instanced track variants from the bitmask (straight,
  curve, T, cross, end, isolated) with sleepers, a level-crossing
  variant on tiles that also carry a road, and a bridge deck on river
  tiles reusing the road bridge deck geometry at the corner maximum
  height. Reacts to the `rail` diff field. `frustumCulled = false`.
- Plant meshes: station (platform with a roof), freight terminal (a
  gantry crane over a stub of track), rail yard (a shed). Added where
  the other 1×1 plants live (`plantsMesh.ts` kit).
- `trainsMesh.ts`: one `InstancedMesh` for locomotives (cap 32) and one
  for wagons (cap 32); the wagon trails one tile behind the head along
  the same path. Passenger and freight differ by colour. Positions
  arrive with the tick snapshot and are interpolated like vehicles;
  headlights at night on the locomotive. Trains are posted in the tick
  message as `trains: TrainSnapshot[]` next to `buses`.
- Minimap draws track tiles. The `transit` overlay also shades
  `stationRadius` around served stations and `freightRadius` around
  terminals, and the Grid overlay is unchanged.

### UI (`src/ui/`)

- Tools: `rail` (drag, L-path preview with cost estimate, hotkey `z`),
  `trainStation` (hotkey `m`), `freightTerminal`, `railYard` (toolbar
  only). All in the BuildBar category `services`. `PLANT_BY_TOOL`
  entries for the three plants.
- `SimCommand`: `{ type: 'buildRail'; tiles: number[] }`; the plants use
  the existing `placePlant`.
- Inspector (`inspect.ts`, `TileInspector.tsx`): a track row (network
  size in tiles, trains in the network); station (served/due,
  commuters whose home or work it covers, network); terminal (loads /
  unloads, depots in reach); yard (trains by kind, stalled count,
  district, grid tie or "no grid connection").
- CityVitals transit chip counts bus and rail riders together; its
  tooltip splits them.
- Energy panel: `traction` row in the consumption breakdown ("Rail
  traction"), city and per island.
- Help section `help.rail`; one tutorial step after the substation step
  ("Connect two districts by rail"), advancing when
  `stats.rail.stationsServed >= 2`.
- i18n: every key in English and German.

### Agent (`src/agent/`)

- `build_rail` (tiles, L-path like `build_power_line`), `place_plant`
  accepts `train_station`, `freight_terminal`, `rail_yard`. `get_map`
  layer `rail` (legend glyph) and the station/terminal/yard glyphs in
  the plant legend. `get_game_overview.rail`: `{ networks, stations,
stationsServed, terminals, yards, trainsRunning, trainsStalled,
railRiders, depotsRailSupplied }`. `find` kinds `rail_station_due`
  and `rail_yard_without_grid`. Tool descriptions and
  `docs/agent-tools.md` updated.

### Goal (`src/sim/goals.ts`)

`railCity`: population at least `goals.railCity.minPopulation`, and
for one full in-game day of consecutive ticks (counter
`goalProgress.railTicks`, reset on any failing tick) today's rail
riders over commuters at least `goals.railCity.riderShare` and at
least one depot rail supplied. i18n `goal.railCity.title/body`.

### Save (`src/sim/state.ts`, `src/storage/`)

`SaveGame.layers.rail` (optional), `SaveGame.trains` (optional, the
`Train` records without `stalled`). Derived layers (`railNetwork`,
`stationAge`, `terminalAge`, `railStation`, `railGoodsAge`) are
rebuilt: ages start at the saturation value so stations and terminals
are due on load, the first tour fixes them. `SAVE_VERSION` unchanged;
a save without the fields loads with no railway.

## Balance (`src/shared/constants.ts`)

Starting values; the probe freezes them.

```ts
rail: {
  passengerTrainsPerYard: 2,
  freightTrainsPerYard: 1,
  stationsPerTour: 4,
  terminalsPerTour: 2,
  windowStartHour: 5,
  windowEndHour: 23,
  turnaroundTicks: 16,
  dwellTicks: 8,
  loadTicks: 12,
  unloadTicks: 12,
  speedTilesPerSecond: 3.2,       // twice the car speed
  serviceWindowDays: 0.5,
  dueAfterDays: 0.35,
  stationRadius: 8,
  freightRadius: 6,
  tractionLoadPassenger: 5,       // per moving train per tick
  tractionLoadFreight: 8,
},
costs: {
  rail: { perTile: 10, bridgePerTile: 60 },
  plant: { TrainStation: 2_500, FreightTerminal: 2_000, RailYard: 3_000 },
  upkeep: { railPerTile: 0.0015, TrainStation: 0.02, FreightTerminal: 0.02, RailYard: 0.05 },
},
goals: { railCity: { minPopulation: 300, riderShare: 0.15 } },
```

**Probe** (temporary `scripts/probe-rail.mjs`, deleted after): a 96-tile
map, a residential district and a business+industrial district about
40 tiles apart, each with its own plants and substation, the logistics
depot in the residential district. Run one seed-year without rail, with
passenger rail only, and with passenger plus freight rail. Record per
variant: rider share (bus/rail), commute congestion factor, evening
charging peak, deficit ticks on the yard island, traction energy and
its cost, import fees paid by the depot, net treasury. Target: rail
shifts a clear majority of the cross-town commute, the traction bill
stays below the import fees and congestion happiness it saves on a
well-stored island, and a yard on an island that burns biogas at night
visibly stalls at dusk. Figures go into this spec.

## Testing

Unit tests colocated per module; coverage stays at or above 90 % on
`src/sim` and `src/shared`.

- `rail.test.ts`: mask for straight/curve/T/cross/end/isolated;
  rejections (building, plant, lake, sea, slope), river bridge cost,
  crossing a road and a line, zone/plant rejected on track, bulldoze
  order; network labelling (two components, closing the gap merges
  them, `railVersion` gating); station/terminal/yard site rules;
  `updateRailCover` radius and nearest-station tie-break; terminal
  classification (powered factory required, damaged factory ignored).
- `trains.test.ts`: fleet sync (yard added/removed, untied yard gets no
  trains); passenger tour planning (due filter, claims, order,
  closure); freight tour (needs a loading terminal, unloading sets
  `terminalAge` and `railGoodsAge`); movement along a path, lost train
  on bulldoze; stall rule (deficit share 0 never stalls, 1 always
  stalls, untied yard parks stalled); `tractionDemandByIsland` counts
  only moving unstalled trains on the yard's island; determinism (two
  runs, same seed, identical train positions).
- `routing.test.ts`: `findRailPath` ignores roads, `findRoadPath`
  behaves as before.
- `vehicles.test.ts`: rides rail with two served stations in one
  network; drives with one station, with two in different networks,
  with an unserved station; `railRiders` counted.
- `deliveries.test.ts`: rail-supplied depot plans without pickup and
  without the import fee, tours count local; unsupplied depot unchanged.
- `energy.test.ts`: `tractionByIsland` lands on the right island and in
  the `traction` breakdown.
- `goals.test.ts`: `railCity` counter resets on a failing tick,
  completes after a day.
- `state.test.ts`: save round-trip of `rail` and `trains`; a save
  without them loads clean.
- `tools.test.ts` (agent): `build_rail`, the three plants, overview
  block, find kinds, map layer.
- e2e: draw a track, place a station, expect the track mesh instance
  count in the smoke stats (as for roads).

## Out of scope

Line editor, timetables, stock quantities, shops served by rail, rail
export income, regenerative braking, train collisions and lane
occupancy on rails, bus-to-rail transfers, noise penalty around tracks,
level-crossing interaction with cars, tunnels, elevated track.
