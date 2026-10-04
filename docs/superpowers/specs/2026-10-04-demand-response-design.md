# Demand Response — Design

Date: 2026-10-04
Status: approved for planning
Backlog entry: `docs/idea.md` "Future Ideas" → **Demand response**

## Goal

When generation falls short, the city today discharges its storages,
runs biogas, imports over a capped link and finally lets buildings go
dark. Nothing on the consumption side can be asked to step back on
purpose. Demand response adds that lever: the city signs a contract
with its businesses — the commercial and retail buildings — under
which a share of their base load can be shed in a Dunkelflaute. The
contract costs a standing retainer whether or not it is ever used, and
an activation premium per energy unit actually shed; in return the
shed load replaces imports when those are dearer and averts a blackout
when the link is saturated. A goal rewards a city that has shed a
meaningful amount of load under contract.

## Decisions

Decisions made with the user during brainstorming:

- **Contract partners are the commercial and retail zones.** The game
  has no industrial zone and does not get one for this feature;
  households stay out (shedding them would be a rolling blackout, not a
  contract).
- **Automatic, economic dispatch.** The shed happens inside the deficit
  cascade without player input: when the activation premium is below
  the import price at the tick's spot factor, or when the shortfall
  exceeds the import capacity. No manual "call" button, no last-resort
  variant.
- **One switch.** The contract is on or off, like the smart-meter
  rollout: a fixed sheddable share, a retainer per contracted building
  and day, an activation premium per energy unit. No slider, no
  per-building contracts.

Underground power lines were considered first and discarded: the
connection radius already reaches every building, so they would only
have mattered as a storm-resilience upgrade.

## Architecture

### Balance (`src/shared/constants.ts`)

Frozen by the pacing probe (see Testing); the per-value measurements
are comments in `constants.ts`:

```ts
demandResponse: {
  /** Share of the commercial and retail base load the contract may shed. */
  shedShare: 0.4,
  /** Retainer per contracted business building and in-game day, paid while the contract runs. */
  retainerPerBuildingPerDay: 6,   // was 20 before the probe
  /**
   * Paid per energy unit shed. Below market.importCostPerEnergyUnit, so
   * a call beats importing whenever spot ≥ activationPrice / importCost
   * (0.5 at these values) — normal and scarce prices, not abundance
   * (spot bottoms out at market.spotMin = 0.25).
   */
  activationPricePerEnergyUnit: 0.2,  // was 0.3
  /** Hours of full-pool shedding the contract allows per in-game day. */
  maxCallHoursPerDay: 4,
  /** Cumulative shed energy the loadManager goal requires. */
  goalShedEnergy: 20_000,  // was 2_000 — one Dunkelflaute day's shedding
},
```

All values live with the mechanic, like `smartMeters`. Heating,
cooling, charging and the heat-network pumps are never part of the
pool; the pool is base load only, so it follows the business load
profile (large in office hours, small at night).

### Sim state (`src/sim/state.ts`)

```ts
demandResponse: {
  /** The contract is in force. */
  active: boolean;
  /** Ticks of full-pool shedding left today (fractions for partial calls). */
  callBudget: number;
};
/** Retainer plus activation premiums paid this tick (budget line). */
lastDemandResponseCost: number;
goalProgress.shedTotal: number; // cumulative shed energy, persisted
```

`callBudget` resets to `maxCallHoursPerDay × TICKS_PER_DAY / 24` at the
start of every in-game day (`tick % TICKS_PER_DAY === 0`), inside the
energy step's dispatch before the budget is read, and is persisted so a
reload cannot refill the day's allowance. `SaveGame` gains optional `demandResponse?: { active:
boolean; callBudget: number }` and `shedTotal?: number`; an old save
loads with the contract off and a full budget. `SAVE_VERSION` stays 1.

### Contract step (`src/sim/demandResponse.ts`, new)

```ts
export function setDemandResponse(state: SimState, active: boolean): void;
export function demandResponseStep(state: SimState): number; // money spent this tick
export function callBudgetTicks(): number; // maxCallHoursPerDay in ticks
```

`demandResponseStep` runs once per tick from `stepTick`, right after
`smartMetersStep` and before `economyStep`, so the cost lands in that
tick's budget. It bills the retainer (`contractedBuildings × retainerPerBuildingPerDay /
TICKS_PER_DAY`, where `contractedBuildings` is the count of connected
commercial and retail buildings the energy step recorded this tick) and
the activation premium (`lastEnergy.shed × activationPricePerEnergyUnit`),
records the sum on `lastDemandResponseCost` and returns it. The
contract may push the treasury negative like any other upkeep; it does
not pause when broke (it is a contract, not a purchase). `setDemandResponse`
is the command handler for `{ type: 'setDemandResponse'; active:
boolean }` in `src/shared/messages.ts`; switching off clears nothing
else (the budget keeps counting down to the day's end).

### Dispatch (`src/sim/energy.ts`)

The building loop additionally sums `businessDemand` — the base load of
connected, undamaged commercial and retail buildings
(`buildingConsumption` only) — and counts them as `contractedBuildings`.
The spot price is computed before the cascade (it is read after it
today; moving the line changes nothing, the factor depends only on the
state). In the deficit branch, after biogas and before import:

```
pool        = active ? shedShare × businessDemand : 0
available   = pool × min(1, callBudget)                 // a partial tick when the budget runs out
importPrice = importCostPerEnergyUnit × spotPrice
economic    = importPrice ≥ activationPrice ? min(shortfall, available) : 0
secure      = min(max(0, shortfall − importCapacity), available)
shed        = max(economic, secure)
shortfall  -= shed
callBudget -= pool > 0 ? shed / pool : 0
gridImport  = min(shortfall, importCapacity)            // unchanged from here
```

The two rules are deliberately `max`, not a sum: the economic rule
already covers everything the pool can give when a call pays; the
security rule only adds a call at abundance prices when the link alone
cannot carry the shortfall. Shed energy is gone, not deferred: it is
subtracted from the tick's consumption (reported on the `buildings`
line, which is what the businesses drew), so `unshifted − consumption`
grows by it and the energy graph's dashed line shows the shed as a gap
without any new series. The result gains `shed`, `shedPool = pool` and
`contractedBuildings`. With the contract off every new term is 0 and
the step is numerically identical to today. No randomness is added.

### Economy (`src/sim/economy.ts`)

`economy.ts` is unchanged: the step deducts the money itself, as the
smart-meter step does, and records `lastDemandResponseCost`. `buildBudget`
(`src/sim/tick.ts`) flattens that into `GlobalStats.budget.demandResponse`
and subtracts it in `net`, the same way `smartMeters` is handled.

### Stats (`src/shared/types.ts`, `src/sim/tick.ts`)

- `EnergyStats.consumption` gains `shed` (energy shed this tick).
- `GlobalStats` gains `demandResponse: { active: boolean; pool: number;
shed: number; callHoursLeft: number; contractedBuildings: number;
retainerPerBuildingPerDay: number; activationPrice: number }`.
- `GlobalStats.budget` gains `demandResponse`.

### Goal (`src/sim/goals.ts`)

`loadManager`: `goalProgress.shedTotal += lastEnergy.shed`; achieved at
`goalShedEnergy`. Cumulative, so persisted (same reasoning as
`flexTicks`). Added to `GOAL_IDS` after `flexibleCity`.

### UI (`src/ui/`)

- `HudConsole.tsx`: a contract toggle under the smart-meter control,
  same markup pattern (`data-testid="demand-response"`), label
  "Demand-response contract", figure "{pool} sheddable · {hours} h
  left", tooltip with the retainer, the activation premium and the two
  dispatch rules. `App.tsx` sends `setDemandResponse`.
- `EnergyPanel.tsx`: row "Load shed" (`consumption.shed`) shown when the
  contract is active or `shed > 0`, next to the smart-meter rows.
- `BudgetPanel.tsx`: "Demand response" expense row.
- `GoalsPanel` strings for `loadManager`.
- `i18n.tsx`: all new strings in English and German; the help page's
  energy section gets a sentence on the contract if it describes the
  smart meters, otherwise the tooltip carries the explanation.

### Agent tools (`src/agent/tools.ts`, `docs/agent-tools.md`)

`set_demand_response { active }` next to `set_smart_meter_rollout`;
`get_game_overview` gains a `demandResponse` block (active, pool, shed,
callHoursLeft, contractedBuildings); `get_energy_report` includes `shed`
in the consumption figures. Docs table updated; the tool-name list test
updated.

## Determinism and performance

Per tick: two extra sums in the existing building loop, a handful of
scalar operations in the cascade, one multiplication in the economy. No
RNG, no extra grid scan.

## Testing

- `src/sim/demandResponse.test.ts`: budget reset on a new day; retainer
  billed per contracted building and day (exactly
  `retainerPerBuildingPerDay × buildings` over one day); activation
  premium equals `shed × activationPrice`; nothing billed with the
  contract off; round-trip of the save fields; old save loads with the
  contract off and a full budget.
- `src/sim/energy.test.ts`: contract off → results byte-identical to a
  run without the feature over a day; at a scarce spot price a
  shortfall is shed up to the pool before import; at an abundance price
  nothing is shed unless the shortfall exceeds the import capacity, and
  then only the excess; the pool is `shedShare` of the commercial and
  retail base load (a residential-only city sheds nothing); after
  `maxCallHoursPerDay` of calls the budget is exhausted and the
  shortfall falls through to import and deficit; the last call before
  exhaustion is partial; `consumption.buildings` drops by exactly the
  shed; shed never exceeds the shortfall.
- `src/sim/demandResponse.test.ts`: the `demandResponse` line reaches
  the stats and the budget line; `src/sim/energy.test.ts`'s `stepTick`
  integration test guards the wiring into the tick itself.
- `src/sim/goals.test.ts`: `loadManager` unlocks at the cumulative
  target and survives a save round-trip.
- `src/sim/engine.test.ts` determinism tests keep passing;
  `serialization.test.ts` covers the new optional fields.
- `src/ui/*`: existing UI tests pass; the HUD renders the contract
  figure; the energy panel row appears when active.
- `src/agent/tools.test.ts`: tool list, `set_demand_response`
  validation and effect, overview block.
- Pacing probe (temporary, deleted after): the 298-building probe city
  from the smart-meter work, run a full 20-day year with the contract
  on and off on two weather seeds; print per day the shed energy, the
  hours used, the import cost, the deficit ticks and the net money.
  Targets: the contract averts a visible share of blackout ticks in
  the winter weeks (≥ 50 % fewer deficit ticks), replaces imports at
  scarce prices, and ends the year roughly break-even to modestly ahead
  of the uncontracted city — the retainer must make it a decision for a
  well-supplied city, not a free upgrade. Adjust `shedShare`,
  `retainerPerBuildingPerDay`, `activationPricePerEnergyUnit` and
  `maxCallHoursPerDay`; record the measurements as comments next to
  the values.

  **Done.** The probe city: 288 density-3 buildings in six banded rows
  (24 per side), 96 of them commercial and retail, smart meters on, on
  a flat 64×64 map with the treasury unconstrained. Two plant parks
  were measured: a _well-supplied_ one (158 plants — 36 wind, 36 solar,
  64 batteries, 16 biogas, 6 hydrogen; generation 3_723 / 3_735 EU/tick
  mean against 2_106 EU of load) and a _stretched_ one (122 plants —
  30 wind, 30 solar, 48 batteries, 10 biogas, 4 hydrogen; generation
  3_202 / 3_135). The brief's original 24-plant park against 480
  buildings was in permanent blackout (18_200 of 19_200 ticks in
  deficit), which is no basis for tuning a scarcity mechanic, so the
  park was sized up until the city only ran dry in the dark, calm
  hours: the well-supplied city needs no call at all on 13-14 of its 20
  days.

  Final values (`shedShare` 0.4, `retainerPerBuildingPerDay` 6,
  `activationPricePerEnergyUnit` 0.2, `maxCallHoursPerDay` 4,
  `goalShedEnergy` 20_000), per 20-day year:

  | city          | seed | shed    | call h | import OFF → ON           | deficit ticks OFF → ON  | net money OFF → ON         | contract cost |
  | ------------- | ---- | ------- | ------ | ------------------------- | ----------------------- | -------------------------- | ------------- |
  | well-supplied | 7    | 76_482  | 9.5    | 35_288 → 31_677 (−10.2 %) | 790 → 711 (−10.0 %)     | 482_157 → 458_952 (−4.8 %) | 26_816        |
  | well-supplied | 11   | 110_489 | 18.5   | 65_700 → 59_977 (−8.7 %)  | 1_505 → 1_382 (−8.2 %)  | 322_693 → 294_798 (−8.6 %) | 33_618        |
  | stretched     | 7    | 77_134  | 22.6   | 60_225 → 61_137 (+1.5 %)  | 1_484 → 1_556 (+4.9 %)  | 431_118 → 411_963 (−4.4 %) | 26_947        |
  | stretched     | 11   | 197_158 | 29.8   | 103_306 → 93_247 (−9.7 %) | 2_460 → 2_212 (−10.1 %) | 281_040 → 267_195 (−4.9 %) | 50_952        |

  Unserved energy fell by the same order: 475_459 → 404_188 and
  1_028_471 → 925_478 on the well-supplied city, 2_607_871 → 2_098_217
  on the stretched city at seed 11.

  Against the three targets: imports are clearly below the uncontracted
  city (−8.7 to −10.2 %) and the year ends 4.4-8.6 % behind it, so the
  contract reads as insurance with a price rather than a free upgrade —
  the net-money target is met on three of the four runs and missed by
  3.6 points on the fourth. **The ≥ 50 % blackout-tick target is not
  reachable and the spec was wrong to expect it**: the pool is 212
  EU/tick (a tenth of the city's load) while the mean depth of the
  deficits it is called into is 568-683 EU, because a dark, calm night
  takes the whole city off its generation, not a tenth of it. The
  contract therefore thins blackouts by 8-10 % of their ticks and
  10-20 % of their energy. Raising `shedShare` does not fix the shape:
  0.6 reaches only 14-17 % fewer ticks (660 and 1_291) for 27-29 % more
  contract money, 0.2 falls to 4-6 % (745 and 1_445).
  `maxCallHoursPerDay` 6 nearly doubled the aversion on one seed
  (711 → 648) and changed nothing on the other (1_382 either way), so
  the allowance stayed at 4 — it is also the design's only comfort
  rule. The spec's original retainer 20 / premium 0.3 left the
  well-supplied city 12.0 % and the stretched city 12.5-21.5 % behind,
  with the retainer alone 63 % of the bill.

  One probe caveat worth keeping: the two runs of a seed share the Rng,
  but `growthStep`'s abandonment roll only draws for a _chronically_
  troubled building, so as soon as a day blacks out hard enough to
  abandon buildings the draw counts diverge and the weather streams part
  company (visible as the stretched city's seed-7 row above, which
  parted on day 16 and is the one row where ON looks worse). The
  well-supplied city never diverged — identical generation and
  curtailment totals ON and OFF — and is what the values are tuned on.

- `node scripts/smoke.mjs`; `pnpm coverage` gate; e2e HUD test extended
  by one click on the new toggle.
- Mac visual pass: the HUD label fits the console width in both
  languages.

## Out of scope

An industrial zone; manual calls or a Dunkelflaute warning tied to
them; a grid-frequency minigame; per-building contracts or an overlay;
a happiness or growth penalty for shed businesses (the daily call limit
is the only comfort rule); household demand response; changes to
storage, market trading or heat-network dispatch.
