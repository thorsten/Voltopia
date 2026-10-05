# Industrial Zone — Design

Date: 2026-10-05
Status: approved for planning
Backlog entry: `docs/idea.md` "Future Ideas" → **Demand response** names
"a bigger pool or an industrial zone" as the next lever; this is that
zone, built as an economy layer rather than a pure load.

## Goal

The city has three zones: homes, offices and shops. Shops are kept
stocked by logistics depots whose vans visit them, but the goods come
from nowhere. The industrial zone gives them an origin. Factories grow
where the retail sector needs them, employ people, pay taxes, run a
shift-work load that finally puts something on the grid at night, and
hand their goods to the delivery vans before those set off for the
shops. A depot with no factory in reach still works — it imports the
goods and pays for it every tour. Factories are unwelcome neighbours:
homes within a few tiles of one are less happy. A goal rewards a city
whose shops are stocked entirely from local industry for a whole day.

## Decisions

Decisions made with the user during brainstorming:

- **Economy layer first, energy lever second.** The zone exists to
  close the goods loop with the delivery feature. The large, flat load
  and the bigger demand-response pool come with it but did not drive
  the design.
- **Pickup leg, no stock quantity.** A van tour starts with a loading
  stop at a powered factory in reach of the depot. There is no goods
  counter anywhere; "loaded locally or imported" is the only state. A
  depot without a factory in reach imports and pays a fee per tour.
  Industry replacing the depot as the fleet's home was rejected: it
  would rebuild the delivery feature that just shipped.
- **Demand follows retail.** Target industrial jobs are proportional to
  the retail jobs in the city. An own population share and "grow
  whenever zoned and powered" were rejected as unrelated to the goods
  loop.
- **Nuisance penalty.** The share of homes within an industry radius
  lowers city happiness, modelled on the park bonus with the sign
  flipped. Without it there would be no reason not to drop a factory
  into the town centre.

## Architecture

### Zone (`src/shared/types.ts`)

`Zone` gains `Industrial: 4`. `DemandStats` gains `industrial`. Zones
are stored one byte per tile, so no `SAVE_VERSION` bump: old saves
never contain the value, new saves with it simply carry a fourth zone.

### Balance (`src/shared/constants.ts`)

Starting values; the probe (see Testing) freezes them and the frozen
values get the usual measurement comments.

```ts
growth: {
  jobsByZoneAndDensity: {
    // ...existing
    [Zone.Industrial]: [0, 3, 8, 18],   // fewer jobs per tile than offices
  },
  /** Industrial jobs the city wants per retail job. */
  industrialPerRetailJob: 1.0,
}
energy: {
  consumptionByZoneAndDensity: {
    // ...existing
    [Zone.Industrial]: [0, 4, 9, 16],   // heavier than commercial (3/6.5/11)
  },
  loadProfileByZone: {
    // ...existing
    // 24 hourly factors: 0.7 through the night (22-5 h), 0.85 at 5 and
    // 22 h as ramps, 1.0 from 6 to 21 h — a two-shift plant.
    [Zone.Industrial]: [0.7, 0.7, 0.7, 0.7, 0.7, 0.85, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0.85, 0.7],
  },
}
seasons: {
  heating: { weightByZone: { [Zone.Industrial]: 0.3 } },
  cooling: { weightByZone: { [Zone.Industrial]: 0.3 } },
}
demandResponse: {
  /** Share of the industrial base load the contract may shed (process load is more flexible than offices). */
  industrialShedShare: 0.6,
}
deliveries: {
  /** Ticks a van loads at a factory before the shop leg. */
  loadTicks: 8,
  /** Paid per tour that starts without a factory in reach (goods imported). */
  importFeePerTour: 12,
  /** Shops that must be supplied before localGoods can be reached. */
  goalLocalMinShops: 10,
  /** Factories the localGoods goal requires. */
  goalLocalMinFactories: 3,
}
happiness: {
  /** Homes within this Chebyshev radius of a factory count as disturbed. */
  industryRadius: 4,
  /** Max happiness penalty when every home has a factory nearby. */
  industryPenaltyWeight: 0.1,
}
```

All five `Record<Zone, …>` tables get the Industrial entry; `?? 0`
fallbacks stay as a safety net but are not relied on.

### Growth (`src/sim/growth.ts`, `src/sim/state.ts`)

- `countPopulationAndJobs` counts industrial jobs into `jobs`. That
  figure feeds residential demand, tax income, the vehicle count and
  the commuter destinations (`vehicles.ts` adds Industrial to the work
  roads).
- `computeDemand`:
  - `residential` and `retail` use `jobs` as today, now including
    industry.
  - `commercial` compares `population × jobsPerResident × headroom`
    against commercial plus retail jobs only. A factory must not lower
    office demand; `countJobsByZone` replaces `countRetailJobs` and
    returns all four.
  - `industrial = normalize(targetIndustrial − industrialJobs, max(…))`
    with `targetIndustrial = retailJobs × industrialPerRetailJob ×
demandHeadroom`.
- `demandFor` returns `demand.industrial` for the zone. Spawn,
  densify, decay and the happiness gate apply unchanged. There is no
  delivery gate for factories (`isShopSupplied` stays retail-only).

### Energy and demand response (`src/sim/energy.ts`, `src/sim/demandResponse.ts`)

- `buildingConsumption`, `heatingConsumption`, `coolingConsumption`
  work through the tables and need no code change.
- The balance loop keeps `businessDemand` for Commercial + Retail and
  adds `industrialDemand`. `contractedBuildings` counts all three.
- `shedPool = shedShare × businessDemand + industrialShedShare ×
industrialDemand`. Dispatch, call budget, billing and stats are
  untouched; the pool is simply bigger at night.
- The smart-meter flexible pool is built from total `buildingDemand`
  and takes industry along automatically. No special case.

### Deliveries (`src/sim/deliveries.ts`, `src/sim/state.ts`)

- `isFactory(state, i)`: Empty tile, `zone === Industrial`,
  `density > 0`, `supplied === Supplied`. A factory without power is not
  a loading point.
- `planTour` gains the pickup leg. From the depot's bounded distance
  map it picks the nearest road tile with a factory beside it (ties:
  lower index). If one exists it becomes `stops[0]` and `van.pickup`
  records the tile; the shop legs follow nearest-neighbour from the
  pickup instead of from the depot. If none exists, `van.pickup = -1`
  and the tour is planned as today.
- Dispatch (`deliveriesStep`, phase `AtDepot`): when a tour with
  `pickup === -1` starts, the depot pays `importFeePerTour` into the new
  budget line `lastGoodsImportCost` and increments
  `goods.importedToursToday`; a tour with a pickup increments
  `goods.localToursToday`.
- `VanPhase` gains `Loading`. `arrive` enters `Loading` with
  `dwellTicks = loadTicks` when the reached stop is `van.pickup`,
  `Unloading` otherwise. Leaving `Loading` does not call `deliver`.
  A pickup that becomes unreachable before loading is dropped like any
  stop and the tour is recounted as imported (no fee: no goods were
  bought); once the van has loaded, the pickup is cleared and later
  detours cannot relabel the tour.
- Vans are not persisted, so `pickup` needs no save handling.
- `SimState.goods = { localToursToday, importedToursToday, partialDay,
lastDay }`. At the day boundary `deliveriesStep` copies the day's two
  counters and `partialDay` into `goods.lastDay` (as `lastDay.partial`)
  and zeros them; `goalsStep` reads `lastDay` on the same tick and
  requires `!lastDay.partial`. `deserializeState` sets `partialDay` from
  the saved tick's parity, so a reload mid-day forfeits that day's
  `localGoods` attempt. Transient, like the other single-day goal
  counters (the `goalProgress` rule in `state.ts`).
- `DeliveryStats` gains `factories` (count) and `localShare`
  (`localToursToday / (local + imported)`; before the first tour of the
  day it shows yesterday's share, and 1 only when both days had no
  tour).
  `DepotInfo` gains `factoriesInReach` and `nearestFactoryTiles`
  (route cost, −1 when none).

### Happiness (`src/sim/happiness.ts`)

- `industryCoverage(state)`: share of residential buildings that have
  a factory (any density, powered or not) within `industryRadius`
  Chebyshev. Same loop shape as `parkCoverage`, but only Residential
  tiles count in the denominator.
- `happinessStep` subtracts `industryCoverage × industryPenaltyWeight`
  alongside the other penalties.

### Goal (`src/sim/goals.ts`)

`localGoods`: reached at a day boundary when the finished day had
`importedToursToday === 0`, `localToursToday > 0`, at least
`goalLocalMinShops` supplied shops and at least `goalLocalMinFactories`
factories. The day boundary check reads `goods.lastDay`. Title
and description in both languages.

### UI (`src/ui/`)

- `BuildBar`: fourth zone tool `zone-industrial`; `useTools` maps it.
- `DemandBars`: fourth bar (I) with its own CSS class.
- `TileInspector`: factory shows zone, density, jobs, load, grid status
  and "supplies goods to depots in reach" / "no power — depots import";
  depot shows factories in reach and the nearest factory's distance, or
  "imports goods".
- Budget panel: line "Goods import".
- Delivery stats row: factories and local share.
- Help and demand-response copy: "commercial, retail and industrial".
- All strings in `i18n.tsx`, English and German.

### Render (`src/render/`)

- `buildings/palette.ts`: `ZONE_FAMILIES[Industrial]` — corrugated
  greys, rust, safety yellow trim.
- `buildings/recipes.ts`: `industrial(density, picker, face, family)`:
  density 1 a flat hall with a saw-tooth roof; density 2 two halls and
  a chimney or tank; density 3 a long hall, a silo and a chimney.
  Wired into the zone switch; `buildingHeight` works from the parts.
- `zoneTilesMesh`, `minimapLayer`, `overlays.demandFor`: Industrial
  colour and demand mapping.

### Agent (`src/agent/`)

- `ZONE_NAMES` gains `industrial`; `paint_zone` and `find_tiles`
  accept it; the ASCII map uses `i`/`I`.
- `overview` reports factories, the local share and the goods import
  cost.
- Tool descriptions and the `docs/agent-tools.md` table are updated.
- `tools.test.ts` swaps its "invalid zone" example from `industrial` to
  `farmland`.

### Backlog (`docs/idea.md`)

Add an **Industrial zone (done)** entry after the probe, with the
frozen numbers and what the probe found.

## Determinism and performance

Everything runs inside the sim tick on the seeded state. The pickup
search reuses the depot's existing bounded Dijkstra map; the factory
scan over that map is linear in its size. `industryCoverage` is one
pass over the tiles times the factory count, like `parkCoverage`, and
runs inside `happinessStep` once per tick. No new per-tick allocations
beyond the factory list.

## Testing

Unit tests, colocated:

- `growth.test.ts`: industrial demand rises with retail jobs and falls
  as factories appear; a factory does not reduce commercial demand;
  industrial jobs count into population-and-jobs and tax income; a zoned
  industrial tile spawns and densifies under the normal rules without a
  delivery gate.
- `energy.test.ts`: the industrial profile has non-zero night load;
  `shedPool` grows by `industrialShedShare × industrialDemand` and
  `contractedBuildings` counts factories.
- `deliveries.test.ts`: with a powered factory in reach the tour's
  first stop is its road tile, the van passes through `Loading`, no fee
  is charged, `localToursToday` increments; without a factory the fee
  is charged and `importedToursToday` increments; an unpowered factory
  is ignored; a pickup that becomes unreachable is skipped and the shops
  are still served.
- `happiness.test.ts`: a home within the radius lowers the target by
  the weight, an office does not; two factories do not double-count.
- `goals.test.ts`: `localGoods` after a fully local day with enough
  shops and factories; not after a day with one imported tour.
- `recipes.test.ts`, `palette.test.ts`: parts for every density and
  variant, family present.
- `tools.test.ts`: `paint_zone industrial`, overview fields, ASCII
  letter.

e2e: pick the industrial tool, paint next to a road, a building
appears (mirrors the existing zone tests).

Headless probe (temporary test file, deleted after): the
demand-response probe town plus one industrial band and a depot within
reach of band and shops. 20 in-game days, two weather seeds. Measured:
deficit ticks and grid import cost with and without the band; goods
import fee avoided against tax from industrial jobs; happiness with the
band at the town edge versus beside the homes; shop supplied share.
Frozen into `BALANCE` with comments: jobs per density, consumption,
`industrialShedShare`, `importFeePerTour`, `industryRadius`,
`industryPenaltyWeight`.

**Done.** The probe town had to be resized before it measured
anything: the demand-response town's 24-plant park left the 560-
building town in deficit on 18_460 of 19_200 ticks, and one depot kept
only 15-30 % of the 80 shops supplied. The measured town: 560
density-3 buildings along eight roads (five residential bands, two
with offices on one side and 80 shops in all on the other, the last
home band at 2 and 4 tiles from the factories, so a fifth of the homes
is in reach), 40 density-2 factories along the seventh road, eight depots on the connector road beside the shop and
factory bands, and a 405-plant park (90 wind, 90 solar, 160
batteries, 40 biogas, 15 hydrogen), smart meters on, treasury
unconstrained. Each seed ran four variants (band off/on × contract
off/on). Seed 11's weather is identical in all four; on seed 7 the
industrial runs' weather diverges from day 16 (chronically troubled
buildings draw from the `Rng`), so its 20-day totals after the
Dunkelflaute of day 16 compare different weather — days 0-15 are the
clean window there.

Totals per 20-day year, contract on, band off → on:

| seed | deficit ticks | grid import     | goods fee | tax                   | tours local/imported | mean happiness  | net money         |
| ---- | ------------- | --------------- | --------- | --------------------- | -------------------- | --------------- | ----------------- |
| 7    | 390 → 894     | 16_701 → 38_252 | 6_480 → 0 | 1_696_666 → 1_748_275 | 0/540 → 490/0        | 0.5996 → 0.5752 | 695_650 → 210_947 |
| 11   | 210 → 306     | 10_502 → 15_053 | 6_516 → 0 | 1_696_666 → 1_748_275 | 0/543 → 494/0        | 0.5945 → 0.5768 | 938_815 → 760_516 |

Contract off → on, deficit ticks: without the band 422 → 390 and
311 → 210; with it 1_163 → 894 and 452 → 306 (seed 7 days 0-15:
120 → 88 without, 250 → 127 with). With the band the contract sheds
192_000-235_000 against 77_000-88_000, saves 146 deficit ticks instead
of 101 on seed 11 and halves seed 7's clean-window deficits where the
business pool alone takes 27 % off. Shops stayed 99-100 % supplied
throughout; with the band not one tour imported.

What the probe found against its targets: the goods loop works, the
night pool bites (the contract's share of deficits saved holds or
doubles with 40 factories' extra load in it), and the nuisance costs
0.018-0.024 mean happiness. Two targets were mis-set. A band never
lowers deficits against the town without it: the contract sheds at most
60 % of the load it adds, four hours a day, so the band's load is only
trimmed one notch. And the 200 money of zoning 40 tiles is repaid within
hours by 2_580 tax a day, so no fee gives a 10-20-day payback; what
decides whether the band pays is its night shift's energy bill — 171_000
extra biogas and import on seed 11, 3.3 times its tax, in a park sized
without it.

Frozen values: industrial consumption `[0, 3.5, 8, 14]` (was
`[0, 4, 9, 16]`), `industryPenaltyWeight` 0.12 (was 0.1); unchanged:
industrial jobs `[0, 3, 8, 18]`, `industrialShedShare` 0.6,
`importFeePerTour` 12, `industryRadius` 4. `goalLocalMinShops` and
`goalLocalMinFactories` stay at 10 and 3.

**Second probe (2026-10-05).** The "3.3 times its tax" finding asked
for a second look at whether a band can ever pay. Reproduced on the
same town (seed 7 off: 390 deficit ticks, 16_697 import, 1_696_666
tax — the first probe's figures) with two more variants: the band in
the same park, and the band with 40 batteries bought for it (60_000).
Per unit of energy a factory draws, its tax at the job rate was the
worst in the city — 75 energy units per money of tax against 61 for a
dense home, 37 for a shop and 30 for an office — so wherever the night
shift met biogas (0.15 per unit) the band lost; and in that park every
zone loses at the margin at night, a dense home 9 times its tax, a
factory 11 times. Two levers, both frozen: a **trade tax rate** for
industrial jobs, `tax.incomePerIndustrialJob` 0.24 (twice
`incomePerJob`; `countPopulationAndJobs` reports `industrialJobs` and
`economyStep` taxes them at that rate, growth untouched), and
**consumption one notch lower**, `[0, 3, 6, 11]` (density 3 still tops
the offices' 11 over the day because of the night shift). A factory
now earns like a shop per unit of energy (28 per money).

Band against the town without it, 20 days, after capex:

| seed | variant               | tax      | biogas   | deficit ticks | net      |
| ---- | --------------------- | -------- | -------- | ------------- | -------- |
| 7    | same park, old values | +51_610  | +508_731 | +767          | −557_720 |
| 7    | same park, tuned      | +103_219 | +399_915 | +448          | −363_612 |
| 7    | +40 batteries, tuned  | +103_219 | +319_380 | +149          | −261_522 |
| 11   | same park, old values | +51_610  | +167_447 | +96           | −179_350 |
| 11   | same park, tuned      | +103_219 | +123_009 | +58           | −66_268  |
| 11   | +40 batteries, tuned  | +103_219 | +45_072  | +40           | −10_961  |

Seed 11 with storage bought for the band breaks even in its first year
and keeps the 103_000 of tax every year after; seed 7's park burns
biogas every night regardless, so the band stays a loss there — the
park decides, as intended, but a well-stored city can now say yes. The
contract still sheds 164_000-190_000 with the band against
77_000-88_000 without: the night pool keeps its bite. Happiness
−0.011…−0.013 (seed 7) and −0.005 (seed 11), the first probe's range.
The probe also surfaced a `planTour` hang (a pickup leg whose
cost-bounded road map reached no remaining stop), fixed separately.

## Out of scope

- A goods quantity, warehouses or stock levels.
- Freight to or from factories beyond the pickup leg; railways.
- Pollution as a map layer, smoke effects or an air-quality overlay.
- Per-zone demand-response contracts or a separate industrial tariff.
- A fourth growth gate (e.g. factories needing a depot to grow).
