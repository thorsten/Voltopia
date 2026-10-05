# Per-District Grids — Design

Date: 2026-10-05
Status: approved for planning
Backlog entry: `docs/idea.md` "Future Ideas" → **Per-district grids**:
separate grid islands with their own balance, coupled by substations.

## Goal

The city has one energy balance. Every intact plant feeds it, whether or
not a line ties it to anyone, and one abstract transmission link imports
and exports for the whole map. That made power lines a formality: they
only extend the supply ring to consumers. Per-district grids make the
network real. The map's connected grid components — islands — each
balance generation, storage, flexible load and demand response on their
own. A plant serves only its island. Import and export run through a
new plant, the substation, which is an island's gate to the outer grid;
an island without one is on its own. A storm that takes out a stretch of
line splits an island, and the cut-off part lives on its own balance
until the repair lands _(softened from "cuts a pylon" — planning
refinement, 2026-10-05)_. The player sees islands as a map overlay, a
district list in the energy panel and a line in the inspector.

## Decisions

Made with the user during brainstorming:

- **Strictly per island.** A plant with no path to consumers generates
  for nobody. Old saves whose park is not wired to the town get deficits
  until the player draws lines; no legacy global mode. The isolated-plant
  marker (2026-10-04) already tells the player which plants those are.
- **The substation is the gate to the outer grid.** Import and export
  capacity are per island: the number of substations on it times the
  old link's figures. Islands couple only indirectly through the market
  (one exports, another imports, at the spot price). A substation does
  not bridge islands by itself; lines merge islands outright, as they
  always did. Rejected: a capacity-limited bridge between islands (a
  second distribution path next to the market), and "both".
- **Overlay plus district list.** A Grid overlay colours islands, the
  energy panel lists them under the city total, clicking a row
  highlights that island, the inspector names a tile's district. The
  HUD keeps the city sum and adds a "districts in deficit" note.
  Rejected: inspector-only, and a panel that follows the mouse.
- **Islands derive from topology; no named districts** (YAGNI): the
  player cannot draw or name a district, and a district is exactly a
  connected grid component.
- **Approach A — island loop over the existing cascade**: the cascade
  becomes a pure function run once per island; storage state moves from
  three global numbers to a per-tile layer so islands split and merge
  without special handling. Rejected: a global balance that only counts
  connected generation (no district balances), and explicit district
  objects.

## Architecture

### Islands (`src/sim/powerGrid.ts`)

`recomputeGrid` already floods from every supply plant over 4-connected,
undamaged line tiles and stamps a Chebyshev ring of
`BALANCE.energy.lineSupplyRadius` around every reached line tile and
every supply plant. It now labels components instead of only marking
`energized`:

- `TileLayers.island: Uint16Array`, derived, never persisted (like
  `energized`); 0 = no island. `energized[i] === 1` iff
  `island[i] !== 0`, so `isTileConnected` and every consumer of
  `energized` keep their meaning.
- Two supply plants share an island when their line floods touch or
  when one stands inside the other's ring (the park rule of
  `parkOf`, now for the balance). A building, station, depot, charging
  hub or heat plant belongs to the island whose ring stamps its tile.
  Where rings of two islands overlap, the islands merge — rings are
  connections, never borders — so every tile has at most one island.
  Implementation: union-find over the stamp pass; a tile stamped twice
  unites the two labels; a final pass relabels to canonical numbers.
- Island numbers are assigned per recompute, ascending by the island's
  lowest tile index. The lowest tile index itself is the island's
  **key**: the stable identity for state that must survive a recompute
  (flex backlog, call budget). `state.islandKeys: number[]` maps number
  → key for the tick.
- A damaged line tile or plant splits an island as it does today — but
  since rings are connections, a dead stretch has to be longer than
  `2 * lineSupplyRadius` tiles (7) before the two ends stop touching; a
  single struck pylon leaves the island whole. _(Planning refinement,
  2026-10-05.)_
- `PlantType.Substation` is a supply source for the flood (it seeds and
  stamps) but generates nothing; `SUPPLY_SOURCES` in
  `src/shared/plants.ts` gains it. `isIsolatedPlant` therefore treats a
  substation like any supply plant.

Exposed helpers: `islandOf(state, index)` (number, 0 if none),
`islandKey(state, number)`, `recomputeGrid` as today.

### Per-island balance (`src/sim/energy.ts`, new `src/sim/islandBalance.ts`)

The cascade moves out of `energyStep` into a pure function:

```ts
export interface IslandInput {
  key: number;
  tiles: number;
  generation: { solar; wind; rooftop; hydro; tidal; geothermal };  // energy units this tick
  biogasCapacity: number;             // dispatchable ceiling
  demand: { buildings; heating; cooling; charging; heatPumps; stations };
  businessDemand: number;             // demand-response pools
  industrialDemand: number;
  flexible: number;                   // smart-meter pool (coverage already applied)
  unshifted: number;
  storage: { battery; pumped; hydrogen; heatStore };  // { stored, capacity, powerLimit }
  substations: number;
  spotPrice: number;
  heat: HeatTickResult;               // the island's share, see below
}
export interface IslandResult { ...every figure EnergyStats carries today, per island, plus
  importCapacity, exportCapacity, storage after the tick, flexBacklog after, callBudget after }
export function balanceIsland(input: IslandInput, pools: IslandPools, tick: number): IslandResult;
```

`IslandPools` is the island's mutable per-tick state: `flexBacklog`,
`callBudget`. The order of the cascade is unchanged: surplus charges
battery, pumped storage, heat store, hydrogen, then exports or sells
hydrogen, the rest is curtailed; a deficit discharges battery, pumped
storage, fuel cell, biogas, demand response, import, the rest is
unserved. Market trading of storage (sell above the floor, buy below
the ceiling) runs only with a substation. Hydrogen sale stays
island-independent (a product, not power). The spot price is city-wide.

`energyStep` becomes the orchestrator:

1. `recomputeGrid`; census per island (one pass over plant tiles,
   bucketed by `island`); demand per island (one pass over building
   tiles; `chargingDemandByIsland` from `vehicles.ts` buckets each
   vehicle's charging tile; heat plants' pump power and fallback by
   the plant's / building's island; stations by tile).
2. For each island: assemble `IslandInput`, call `balanceIsland`,
   write storage back to the tiles (below), keep the pools.
3. Sum the results into `state.lastEnergy` (unchanged shape), set
   `state.lastIslands: IslandStats[]` (number, key, tiles, generation,
   consumption, stored, capacity, substations, deficit, curtailment,
   gridImport, gridExport, importCost), and flag buildings: a building
   flickers under its island's deficit share with the same hash rule
   as today.

Tiles with no island (zoned land outside every ring, plants nobody
reaches) draw nothing and generate nothing; their `supplied` stays
NotConnected as today.

### Storage per tile

`TileLayers.stored: Float32Array`, persisted: the energy held on a
battery, pumped-storage, hydrogen or heat-store tile, in that plant's
units. An island's pool is the sum over its storage tiles of one kind;
charge and discharge are spread over the tiles — charge in proportion
to headroom, discharge in proportion to stored energy _(planning
refinement, 2026-10-05)_ — deterministic and order-free, so a split or
merge needs no redistribution. `state.storedEnergy`, `pumpedStorageEnergy`,
`hydrogenEnergy` and `heatStored` are removed; the stats and the battery
SoC fill in `plantsMesh.ts` read the tile (SoC per battery) and the
island sums. Pumped-storage and run-of-river bonus factors keep scaling
capacity per tile as today.

Heat stores are the one exception on the _heat_ side: the heat network
follows roads, not lines, and is already a city-wide pool, so
`heatStep` keeps discharging all heat stores together (proportional to
their levels). Only the _electricity_ that charges them is per island:
`chargeHeatStore` runs inside `balanceIsland` with the pump power left
on that island's heat plants, and the heat lands on the heat-store
tiles of that island (proportional to headroom). A heat store on an
island with no heat plant is never charged.

### Per-island pools

`state.islandPools: Map<number, { flexBacklog: number; callBudget: number }>`
keyed by island key. On a merge the surviving key (the lower one, by
construction) adds the other's backlog and takes the minimum of the two
call budgets; the other entry is dropped. On a split the surviving key
keeps everything and the new key starts at zero backlog and a full
budget. Entries whose key no longer exists are pruned each tick. The
daily budget refill runs per entry at `tick % TICKS_PER_DAY === 0`.
`demandResponse.active` and `smartMeters` stay city-wide switches.

### Save games (`src/sim/state.ts`)

`SAVE_VERSION` stays 1; everything new is optional:

- `stored: number[]` (sparse: `[index, value]` pairs) replaces the three
  global numbers in new saves. Loading a save without it distributes
  `storedEnergy` / `pumpedStorageEnergy` / `hydrogenEnergy` (and the
  heat store level) over the matching plant tiles in proportion to
  capacity; a save with both prefers `stored`.
- `islandPools: [key, flexBacklog, callBudget][]`; absent → every island
  starts at zero backlog and a full budget. The old `flexBacklog` and
  `demandResponse.callBudget` fields are read once into the largest
  island's entry on load and no longer written.
- Old cities have no substation, so no link, and unwired parks feed
  nothing: the deliberate break from the first decision, explained in
  the help page and pointed at by the `districtGrid` goal.

### Worker protocol (`src/shared/types.ts`)

`TileDiff.island` (number; the renderer colours the Grid overlay and the
inspector names it). `GlobalStats.islands: IslandStats[]`;
`GlobalStats.energy` keeps its shape as the city sum. `stored` travels
in the diff only for storage plant tiles as `stored` (0..1 share of
capacity) so the battery SoC fill is per tile.

### Rendering (`src/render/`)

- `OverlayMode.Grid = 9`: tile colour from a palette of eight hues by
  `island % 8` (island 0 untouched); an island in deficit this tick is
  overblended red; an island without a substation is dimmed _(changed
  from a dashed border — planning refinement, 2026-10-05)_. The
  overlay menu's legend lists the three cues.
- Selection: the UI passes `selectedIsland` (number or 0) to the
  overlay; other islands are drawn at half saturation while one is
  selected.
- `plantsMesh.ts`: substation recipe — a fenced yard (thin posts on
  four corners, rails), a transformer box with two insulator cylinders
  on top, a small night lamp (emissive quad, lit by the existing
  night-window logic); foundation by the slope rule like every plant.

### UI (`src/ui/`)

- Build bar: substation tool, hotkey `n`, beside the power-line tool;
  tooltip with cost and the one-sentence rule.
- Energy panel: after the city figures, a "Districts" section — one row
  per island sorted by tile count: number, tiles, generation,
  consumption, stored-energy bar (share of capacity), substation count,
  status (ok / deficit / curtailing). Click toggles selection, which
  switches the overlay to Grid and highlights the island; selection
  state lives in the panel's React state and reaches the renderer
  through the existing overlay prop path.
- Inspector: every tile with an island shows "District n" and its three
  figures; a substation shows its island's import, export and link
  capacity this tick.
- HUD: next to the energy balance, "n districts in deficit" whenever at
  least one island is in deficit (hidden at 0).
- Help page: a paragraph on district grids and substations, including
  the note for old cities. Tutorial: a step "build a substation" after
  the first power line.
- i18n: all of the above in EN and DE.

### Agent (`src/agent/`)

- `overview`: `islands` (count) and `islandsInDeficit`.
- `energy_report`: after the city total, one entry per island with the
  panel's fields plus `key`.
- `inspect_tile`: `island: { number, key }` on any tile with one; on a
  substation also `gridImport`, `gridExport`, `importCapacity`,
  `exportCapacity`.
- `find_tiles`: kinds `substation` and `island_without_substation` (one
  representative tile per island, nearest first); `plant` includes the
  new type.
- `place_plant` accepts `substation`; the ASCII map uses `N`.
- Tool descriptions and `docs/agent-tools.md` updated; the
  `supply`/`connected` wording names the island.

## Balance (`src/shared/constants.ts`)

Starting values, all four frozen unchanged by the probe (see Testing):

```ts
costs.plant[PlantType.Substation]: 3_000,      // between heat plant 2_800 and wind 4_500
upkeepPerTick.plant[PlantType.Substation]: 0.05,
market.importCapacity: 60,                     // now per substation
market.exportCapacity: 80,                     // now per substation
goals.districtGrid: { minBuildings: 20 },      // islands this size need a substation
```

Goal `districtGrid`: reached at a day boundary when every island with
at least `minBuildings` buildings has a substation and no island had a
deficit tick that day. Title and description in both languages.

The tutorial's starting money stays; the probe confirms the starter
town can afford its first substation after the first plant.

## Testing

Unit tests, colocated:

- `powerGrid.test.ts`: island numbers for two separate networks; merge
  through a line, through overlapping rings, through a plant in a
  ring; split by a damaged line tile; keys stable across a recompute
  that changes nothing; a substation seeds the flood.
- `islandBalance.test.ts`: the cascade cases that `energy.test.ts`
  covers today, against the pure function; no import without a
  substation; two substations double the link; trading only with a
  substation.
- `energy.test.ts`: two islands, one in surplus and one in deficit, the
  deficit island gets no help without a substation and imports with
  one; storage charged proportionally across tiles; a building flickers
  under its own island's deficit, not the other's; backlog and budget
  on merge and split; the city sums equal the island sums.
- `state.test.ts` / `serialization.test.ts`: `stored` and `islandPools`
  round-trip; a save without them distributes the globals and starts
  pools fresh.
- `vehicles.test.ts`: `chargingDemandByIsland` buckets by charging
  tile.
- `goals.test.ts`: `districtGrid`.
- `tools.test.ts`: overview fields, `energy_report` islands,
  `find_tiles` kinds, `place_plant substation`, ASCII `N`.
- UI tests: panel district list and selection; inspector line; HUD
  note. e2e: the substation tool is on the build bar; the Grid overlay
  toggles.

**Pacing probe (2026-10-05, `src/sim/_districtProbe.test.ts`, deleted
after use).** The 560-building probe town laid as two islands. Band
roads at y = 6, 11, 16, 21 (island A: 320 dense homes) and y = 30, 35,
40, 45 (island B: 160 shops and offices plus 80 homes), each group with
its own connector line down x = 3, its own trunk line down x = 45 and
its own half of the park (45 wind, 45 solar, 80 batteries, 20 biogas,
7-8 hydrogen). Nothing at all between y = 23 and y = 28: rings are
connections, so with `lineSupplyRadius` 3 two line ends or two plants
merge into one island unless they are at least 7 tiles apart — the
earlier 5-tile band spacing of the industrial probe cannot be split at
all. `islandCount` was asserted per variant. Variant 1 bridges both
gaps and is the pre-feature city: one island, one 60/80 link.

One in-game year (20 days), seeds 7 and 11, market trading off:

| seed | variant               | deficit ticks (A / B) | unserved | import | export  | net     |
| ---- | --------------------- | --------------------- | -------- | ------ | ------- | ------- |
| 7    | one island, no link   | 793                   | 994_886  | 0      | 0       | 527_451 |
| 7    | one island, 1 sub     | 579                   | 707_891  | 24_852 | 25_741  | 443_614 |
| 7    | two islands, no link  | 1_095 / 75            | 784_865  | 0      | 0       | 690_325 |
| 7    | two islands, 1 sub ea | 1_009 / 56            | 717_546  | 45_663 | 51_696  | 692_662 |
| 7    | two islands, 2 sub ea | 941 / 44              | 656_221  | 87_835 | 102_916 | 698_050 |
| 11   | one island, no link   | 95                    | 26_516   | 0      | 0       | 942_958 |
| 11   | one island, 1 sub     | 85                    | 21_092   | 3_770  | 29_173  | 966_746 |
| 11   | two islands, no link  | 803 / 0               | 356_570  | 0      | 0       | 930_473 |
| 11   | two islands, 1 sub ea | 674 / 0               | 312_256  | 31_094 | 58_773  | 954_771 |
| 11   | two islands, 2 sub ea | 592 / 0               | 274_301  | 58_427 | 117_198 | 982_488 |

Splitting the town costs **net money nothing** — seed 11 lands 1.2 %
under the single-balance baseline with one substation each, seed 7
lands above it — but it does move the deficit, which is the point: the
home island can no longer borrow the business island's midday surplus,
so its deficit ticks go 85 → 674 (seed 11) and 579 → 1_009 (seed 7)
while the business island, holding half the park for 44 % of the load
(1_837 of 4_195 EU/tick), never goes short at all on seed 11 and keeps
only 44-75 deficit ticks on seed 7, curtailing 32-38 million EU beside
it.
A relative deficit target of 10 % is unreachable against a baseline
that near zero, and should be: the island's own balance has to bite.
Both islands' figures sum to the city's, as the unit tests require.

The two directions of the link price the substation from opposite ends,
and 3_000 sits inside both — the export payback on the surplus island,
the reliability cost on the short one; the measurements are recorded on
`costs.plant[Substation]`, `upkeepPerTick.plant[Substation]` and
`market.importCapacity`/`exportCapacity` (now per substation). Stacked
eight deep on the one-island town the export rate stayed linear
(203_767-231_188 a year), and it stays under the hydrogen plant's rate
per money invested, so a substation never becomes the best way to sell
surplus. All four values frozen unchanged.

One negative result worth keeping: run at **half** that park, the town
cannot carry its own winter (gen 5_103 against 4_165 EU/tick of load
but 18 % of ticks in deficit) and the link then makes things _worse_ —
seed 7 went from −136_679 without a link to −156_884 with one, and to
−631_473 as two islands with a substation each, because importing at
0.4 x spot is dearer than blacking out, which costs no money at all. A
substation is not a fix for an undersized park, and the probe says so
in numbers.

## Out of scope

- Transfer limits inside an island (a line's capacity).
- Named or player-drawn districts; a per-island history graph; minimap
  colouring.
- Bridging two islands without the market.
- Railways (next backlog item; districts give them regions to connect).
