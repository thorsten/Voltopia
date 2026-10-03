# Heat Sector — Design

Date: 2026-10-03
Status: approved for planning
Backlog entry: "Heat sector" in `docs/idea.md`

## Goal

Half of the backlog entry already exists: since the seasons feature the
city has a full year (`src/sim/seasons.ts`), and every building draws a
heating load in the cold and a cooling load in the heat
(`heatingConsumption` / `coolingConsumption` in `src/sim/energy.ts`,
halved by the one-off insulation upgrade). What is missing is the
_choice_ of how that heat gets made. Today it is a flat electric load
the player can only insulate against — it has no efficiency, no
network, and no storage, so the winter peak lands on the grid exactly
when solar is weakest.

The heat sector turns heat into the game's best **flexible load**. A
district-heating plant is a large heat pump: the colder it gets, the
worse its coefficient of performance (COP), so winter stays hard, but
every unit of electricity still buys more than one unit of heat. A heat
store is a hot-water tank that the surplus cascade can fill through
that pump and that covers the night's heat demand later. Heat never
turns back into electricity, so the store is a one-way sink: it eats
surplus that would otherwise be curtailed and shifts the heating peak
off the evening — a genuinely different tool from batteries, pumped
storage and hydrogen, which all give electricity back.

The player decision is spatial: the network follows the roads out from
the plant, so where you place it, and how your streets run, decides who
is served.

## Scope

In scope:

- Two new plant types: `HeatPlant` (large heat pump feeding the
  network) and `HeatStore` (hot-water tank).
- A `heated` tile layer derived each tick: which road tiles carry the
  network and which buildings it serves.
- A heat balance per tick: store first, then pumps at the current COP,
  then fallback to the building's own electric heating.
- Store charging as a step in the surplus cascade, placed after battery
  and pumped storage and before export.
- Stats, energy panel, a Heat overlay, inspector lines, help page,
  i18n (EN + DE), hotkeys, plant meshes, minimap colours, agent tools
  and `docs/agent-tools.md`, one city goal, save compatibility, tests,
  balancing.

Out of scope (not built now):

- District cooling. Cooling stays an individual electric load.
- A pipe build tool. Heat rides the road graph; there is nothing to
  trench. (Considered: the planning puzzle is real, but it is a whole
  extra layer, mesh, bulldozer path and undo path, and a lot of winter
  clicking. The road graph already encodes the player's layout.)
- A "cold" building state. When the network cannot deliver, the
  building falls back to its own electric heating — the game exactly as
  it is today. No new undersupply status, happiness term or overlay.
- A resistive power-to-heat boiler as a third plant type, per-building
  heat-pump retrofits, and a per-road-tile connection fee. The plant's
  price and reach carry the cost.
- Per-network accounting. All plants and stores pool city-wide; the map
  only decides which buildings are on the network. (Per-district grids
  remain deferred; when they come, the heat pool can split the same
  way.)

## Data model

### The heated layer

`layers.heated: Uint8Array`, one byte per tile, rederived every tick and
never persisted:

- `HEATED_NONE = 0`
- `HEATED_TRUNK = 1` — a road tile the network reaches
- `HEATED_SERVED = 2` — a building tile the network heats

It travels in `TileDiff.heated` exactly like `services`, so the overlay
and the inspector follow it with no extra message.

### State

- `state.heatStored: number` — heat units in the pooled tank. Clamped
  to the installed capacity every tick, like `storedEnergy`.
- `SaveGame.heatStored?: number` — optional; absent reads as 0. No
  `SAVE_VERSION` bump.
- `SaveGame.warmWinterTicks?: number` — optional; the goal's streak counter.
- `PlantType.HeatPlant = 16`, `PlantType.HeatStore = 17`.
- `PlantCensus` gains `heatPlants` and `heatStores` (damaged ones are
  skipped, as for every other plant).
- `GoalId` gains `warmWinter`; `state.goalProgress.warmWinterTicks`.

### Stats

`state.lastEnergy` and `EnergyStats` gain:

- `consumption.heatPumps` — electricity the pumps drew this tick
  (serving demand plus charging the store).
- `consumption.heating` keeps its meaning, _electricity for individual
  heating_, and now includes the fallback share.
- `networkHeat` — heat units delivered to served buildings this tick
  (store plus pumps).
- `heatFallback` — heat units the network could not deliver and the
  buildings heated themselves.
- `heatStoreCharge` — electricity absorbed into the store this tick.
- `heatStored`, `heatCapacity` — the pool and its installed capacity.
- `heatCop` — the COP in force this tick.

The lifetime `heating` day sum adds `heatPumps`, so the stats page's
"electricity for heat" line visibly drops when the network goes live.

### Balance

A new `BALANCE.heat` block. The headless probe (Task 14) confirmed every
one of these starting values and moved none of them; the measurements
behind them now sit in `constants.ts` next to each row:

| key                   | value  | meaning                                                                    |
| --------------------- | ------ | -------------------------------------------------------------------------- |
| `reachHops`           | 12     | road tiles (4-neighbour hops) the network extends from a plant             |
| `copWarmTemperature`  | 10     | °C at or above which the COP is `copWarm`                                  |
| `copWarm`             | 3.5    | heat units per electricity unit in mild weather                            |
| `copColdTemperature`  | −10    | °C at or below which the COP is `copCold`                                  |
| `copCold`             | 1.8    | COP in deep cold                                                           |
| `pumpPowerLimit`      | 60     | electricity one plant can draw per tick                                    |
| `storeCapacity`       | 6 000  | heat units one store holds                                                 |
| `storeDischargeLimit` | 150    | heat units one store releases per tick                                     |
| `storeLossPerTick`    | 0.0005 | share of the stored heat lost per tick (~38 % left after two in-game days) |

Costs and upkeep join the existing tables: `costs.plant` 2 800
(plant) / 1 600 (store), `upkeepPerTick.plant` 0.06 / 0.03. For scale:
a battery holds 3 000 electricity units at 120 per tick; the store
holds twice that in heat, which at COP 3 is the same electricity.

## Tick

`heatStep(state)` runs after `reservoirStep` and before `energyStep`;
`energyStep` takes its result as input next to `chargingDemand`.

```
heatStep(state): HeatTickResult
  recomputeHeated(state)                      // the layer
  demand   = Σ heatingConsumption(served buildings)
  cop      = copAt(state.season.temperature)
  fromStore = min(demand, stores × storeDischargeLimit, heatStored)
  heatStored -= fromStore
  pumpHeat  = min(demand − fromStore, plants × pumpPowerLimit × cop)
  pumpPower = pumpHeat / cop
  fallback  = demand − fromStore − pumpHeat
  heatStored *= (1 − storeLossPerTick)
  return { pumpPower, fallback, pumpPowerLeft: plants × pumpPowerLimit − pumpPower,
           cop, headroom: capacity − heatStored, networkHeat: fromStore + pumpHeat }
```

Inside `energyStep`:

- `heatingDemand` counts only buildings _not_ served, plus the fallback
  heat (1 heat unit = 1 electricity unit, as today).
- `totalDemand` adds `pumpPower`.
- In the surplus branch, after pumped storage and before export:
  `chargePool(heatStored, capacity, pumpPowerLeft, cop, remaining)`, but
  only while `heatingDegree(temperature − diurnalAmplitude) > 0` — the
  tank fills only while the coming night will need heat, so a summer
  surplus is exported, not boiled away. The pool's "efficiency" is the
  COP: one electricity unit stores `cop` heat units.
- The deficit branch is unchanged: heat never comes back.

Order matters and is pinned by tests: the store serves the current tick's
demand before the cascade refills it, so a tick can both drain and
charge the tank (night demand covered, then a gust tops it up).

## The network

`recomputeHeated` mirrors `recomputeServices`:

1. Clear a fresh `next` layer.
2. For every `HeatPlant` tile that is energised and undamaged, seed a
   breadth-first search with every road tile 4-adjacent to the plant.
3. Walk 4-neighbour road tiles up to `reachHops` hops, marking
   `HEATED_TRUNK`. Plain hops, deliberately not `roadDistances`: that
   prices avenues and traffic, and membership must not flicker with the
   rush hour. Several plants simply union their reach.
4. Every building tile (`TileType.Empty` with `density > 0`) 4-adjacent
   to a trunk tile is `HEATED_SERVED`. Damaged buildings draw nothing
   anyway (energy.ts skips them) so they need no special case here.
5. Diff `next` against `layers.heated`, copy and `markDirty` changed
   tiles.

A plant with no adjacent road reaches nothing; the inspector says so.
A plant cut off from the grid (not energised) reaches nothing either —
the pumps need power — and its buildings fall back without a gap.

Cost: plants × reach² plus one pass over the grid, same order as the
services layer.

## Effects on existing systems

- **Energy balance**: described above. The pumps are ordinary demand,
  so a grid deficit flags served buildings as undersupplied by the same
  share as everyone else; no heat-specific failure.
- **Economy**: build cost, upkeep and the felling fee apply through the
  common `placePlant` path. Both plants go on empty land that is not
  too steep; no hotspot, water or road requirement is enforced at
  placement (consistency with every other plant).
- **Disasters**: a damaged plant leaves the census, so its reach and
  pump power vanish until repaired; a damaged store shrinks capacity and
  the pool is clamped. Nothing new to write — `damage` already gates
  the census.
- **Insulation**: halves a served building's heat demand too, since the
  demand is the same `heatingConsumption` value.
- **Market trading**: the heat store does not trade. It cannot sell
  (heat is not electricity) and buying cheap import to heat is left out
  deliberately — the tank's job is to absorb the city's own surplus.
- **Goals**: `warmWinter` — a counter of consecutive ticks in `winter`
  during which the city had heat demand at all (so an empty city cannot
  unlock it) and the network delivered at least half of it with no
  fallback. With `total` = network heat + fallback + individual heating,
  a tick counts when `total > 0`, `networkHeat >= 0.5 * total` and
  `heatFallback === 0`; achieved at `TICKS_PER_DAY`. Any tick that fails
  resets the counter.

## Rendering, UI, agent tools

- **Meshes** (`plantsMesh.ts`): the heat plant is a low hall with one
  tall slim stack; the heat store is a wide cylinder on a plinth. Static
  geometry, no per-frame work. Minimap colours for both.
- **Overlay** `OverlayMode.Heat = 8`: trunk roads tinted warm, served
  buildings warm, buildings with heat demand that are _not_ served
  tinted cool, so the gap between reach and need is readable at a
  glance. Toggle next to the existing overlays.
- **Energy panel**: a heat store bar (stored / capacity) beside the
  hydrogen tank, a "heat pumps" consumption row, and the COP in the row
  label. The history graph gains no new line; pump electricity is
  consumption like any other.
- **Inspector**: a served building shows "district heating"; an unserved
  one with heating demand shows "own heating"; a plant shows reach,
  buildings served and the COP now; a store shows the pooled state of
  charge; a plant with no adjacent road shows a hint.
- **Build bar**: two tools, hotkeys `r` (heat plant) and `o` (heat
  store, the round tank). Both are free today: not a tool hotkey, not a
  camera key (`q`/`e` rotate, `w a s d` and the arrows pan — `s` was
  rejected for that reason). Costs shown as for every plant.
- **Help page**: one section — the COP curve, the road rule, the "fills
  only while the nights are cold" rule.
- **i18n**: every new string in EN and DE.
- **Agent tools**: plant names `heat_plant` and `heat_store` for
  `build_plant`, map glyphs, `get_energy` carries the new stats,
  `inspect_tile` reports `heated`, and the table in `docs/agent-tools.md`
  lists both.

## Testing

`src/sim/heat.test.ts`:

- Reach: a plant on a straight road serves buildings within
  `reachHops` and not the next one; two plants union; a plant with no
  adjacent road serves nothing; an unenergised plant serves nothing; a
  damaged plant drops out and returns after repair.
- COP: clamped at both ends, linear between, monotone in temperature.
- Balance order: store before pumps before fallback; pump power shared
  between serving and charging; discharge limit and loss honoured; the
  night-ahead charging gate opens and closes with temperature.
- Determinism: same seed and commands, identical `heatStored` and
  `heated` after N ticks.
- Save round trip: `heatStored` survives; a save without it loads as 0;
  `heated` is rebuilt on the first tick.

Elsewhere: `energy.test.ts` pins the cascade position (store charges
before export, after pumped) and that served buildings leave
`heatingDemand`; `goals.test.ts` covers `warmWinter` including the
reset; `serialization.test.ts` the optional field; `tools.test.ts` both
plant names and the stats; coverage stays ≥ 90 %.

## Balancing

A throwaway headless probe (`SimEngine`, deleted after): one scripted
city run through a full year with and without the heat sector. Checks:

- Pump electricity over a winter day lands near individual heating ÷
  COP, i.e. the network pays for itself in energy within one season.
- One store plus one plant absorbs a windy night's curtailment visibly
  (tank filled by morning) and covers the evening peak.
- Costs sit beside the other storages per shifted energy unit: a store
  should not out-compete batteries on electricity-for-electricity, only
  on heat.
- `reachHops` serves a typical starter village from one well-placed
  plant and leaves a large map wanting two or three.

## Save compatibility

`heatStored` and the goal's `warmWinterTicks` streak are added, both
optional (every other streak goal persists its counter the same way). Old
saves load with an empty tank and no heat plants, which is the game as it
was. No version bump.
