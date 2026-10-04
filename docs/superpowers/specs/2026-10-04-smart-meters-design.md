# Smart-Meter Rollout — Design

Date: 2026-10-04
Status: approved for planning
Backlog entry: `docs/idea.md` "Future Ideas" → **Smart-meter rollout**

## Goal

Today "smart charging" is a free global switch: when on, cars, vans and
buses defer charging to hours with renewable surplus. Nothing else in
the city is flexible, and the switch costs nothing, so it is always on.

The rollout turns that switch into a mechanic with pacing and a price:
the city installs smart meters building by building, coverage grows
over weeks, and every smart effect scales with coverage. Metered
households and their electric heating become a flexible-load pool that
moves consumption out of the hours without renewable surplus and into
the hours with it — usually the midday, though a windy evening counts
too (see the probe results under Testing) — which the energy graph
shows directly. A goal rewards a highly metered city that actually
shifts load.

## Decisions

Decisions made with the user during brainstorming:

- **Gradual programme with coverage**, not a one-off purchase and not a
  running fee on the old switch. The player starts (and can pause) the
  rollout; crews install a limited number of meters per in-game day at
  a cost per meter; new buildings need meters too, so growth keeps
  costing. The free toggle goes away: smart charging is part of
  coverage.
- **One flexible-load pool with a backlog** covering a fixed share of
  household load and of on-site electric heating (heat pumps have
  thermal inertia), deferred while there is no renewable surplus and
  served when there is, bounded by a few hours of backlog; past the
  bound it is served regardless (comfort). Heating-only and
  vehicles-only variants were rejected as too small.
- **Full feedback**: a dashed "unshifted load" line in the energy graph,
  coverage and shifted-load rows in the energy panel, a rollout control
  in the HUD, and a goal.

## Architecture

### Balance (`src/shared/constants.ts`)

Final values, frozen after the pacing probe (see Testing):

```ts
smartMeters: {
  /** Money per installed meter (billed as the crews install). */
  costPerMeter: 60,
  /** Meters the crews install per in-game day while the rollout is active. */
  installsPerDay: 15,
  /** Share of a metered building's base load that can wait for surplus. */
  householdFlexShare: 0.15,
  /** Share of a metered building's on-site electric heating that can wait (thermal inertia). */
  heatingFlexShare: 0.3,
  /** Hours of flexible demand the backlog may hold before comfort wins. */
  backlogHours: 4,
  /** Cap on the backlog drained per tick (recovered + overflow) as a share of the unshifted load. */
  maxDrainShare: 0.35,
  /** Coverage the flexibleCity goal requires. */
  goalCoverage: 0.8,
},
```

`BALANCE.costs` is not used for the meter price because the price is
per unit installed, not a one-off; it lives with the mechanic's other
values.

No value moved: the probe confirmed all six it was run on. The
measurements behind each one are comments next to it in `constants.ts`;
the probe figures are summarised under Testing. `maxDrainShare` was
added in the final review (see the Flexible pool below) and is not a
pacing value: it only has to stay above the pool's own share of the
load — at most `householdFlexShare` / `heatingFlexShare` of it, so
under 0.3 — or a backlog sitting above the comfort bound could never
drain. The install carry counts crew time in whole ticks, so
`installsPerDay` needs no rounding constraint: any rate installs
exactly `installsPerDay` meters a day.

### Sim state (`src/sim/state.ts`)

```ts
smartMeters: {
  /** Crews are installing. */
  active: boolean;
  /** Buildings with a meter (never above the building count). */
  metered: number;
  /** Crew time carried between ticks, in ticks (installsPerDay per tick, TICKS_PER_DAY per meter). */
  installCarry: number;
}
/** Deferred flexible energy waiting for surplus, in energy units. */
flexBacklog: number;
```

`state.smartCharging` is removed. `SaveGame` gains optional
`smartMeters?: { active: boolean; metered: number }` and
`flexBacklog?: number`; `smartCharging` stays in `SaveGame` as an
optional legacy field. On load: if `smartMeters` is present it is
restored (metered clamped to the building count); else if the legacy
`smartCharging` is true, every current building counts as metered and
the rollout is active, so an old city keeps the effect it had; else
nothing is metered. `SAVE_VERSION` stays 1.

### Rollout step (`src/sim/smartMeters.ts`, new)

```ts
export function meteredCoverage(state: SimState): number; // metered / buildings, 0 without buildings
export function smartMetersStep(state: SimState): SmartMeterTick; // { installed: number; cost: number }
export function setSmartMeterRollout(state: SimState, active: boolean): void;
```

`smartMetersStep` runs once per tick from `stepTick`, after growth and
before the economy step so the install cost lands in that tick's
budget. It counts the buildings once — the tick's only full-grid
building scan, cached on `state.lastBuildingCount` by
`refreshBuildingCount` so `meteredCoverage` (asked once per parked
vehicle, van and bus) is a division, not a scan — and clamps `metered`
to it (demolition and abandonment lose meters). Then, if active and
`metered < buildings`, it adds `installsPerDay` to `installCarry` and
installs one meter per `TICKS_PER_DAY` of carry at `costPerMeter`, as
long as the treasury can pay (otherwise the carry waits; the rollout
does not go into debt). Integer carry: a day installs exactly
`installsPerDay` meters at any rate. The cost is returned to the
economy as a new `smartMeters` expense line. `setSmartMeterRollout` is
the command handler (`{ type: 'setSmartMeterRollout'; active: boolean }`
replaces `setSmartCharging` in `src/shared/messages.ts`).

### Vehicles (`src/sim/vehicles.ts`, `src/sim/transit.ts`)

`decideCharging` / `decideBusCharging` replace `state.smartCharging`
with `isSmartVehicle(state, id)`: `hash01(id) < meteredCoverage(state)`,
where `hash01` is the same integer hash used elsewhere in the sim
(stable per id, so a vehicle's behaviour does not flicker as coverage
grows; the set of smart vehicles only ever grows with coverage). The
rest of the gate (surplus or low battery) is unchanged, as is
`surplusAvailable`.

### Flexible pool (`src/sim/energy.ts`)

In `energyStep`, after the building loop has produced `buildingDemand`
and `heatingDemand` (on-site electric heating, which includes the heat
network's fallback share — that heat _is_ heated electrically on site,
so it is part of the pool; only the network pumps stay out) and after
`generation` is known:

```
coverage   = meteredCoverage(state)
flexible   = coverage × (householdFlexShare × buildingDemand + heatingFlexShare × heatingDemand)
inflexible = totalDemand − flexible                     // cooling, charging, pumps stay inflexible
surplus    = generation − inflexible                    // renewables only, before storage
if surplus > 0:
    servedNow = min(flexible, surplus)
    recovered = min(flexBacklog, surplus − servedNow)
    deferred  = flexible − servedNow
else:
    servedNow = 0; recovered = 0; deferred = flexible
drainCap   = maxDrainShare × unshifted                   // most the backlog may give up this tick
recovered  = min(recovered, drainCap)
capacity   = flexible × backlogHours × (TICKS_PER_DAY / 24)  // comfort bound, in energy units
overflow   = min(max(0, flexBacklog + deferred − recovered − capacity),
                 max(0, drainCap − recovered))           // served regardless, but capped
flexBacklog = max(0, flexBacklog + deferred − recovered − overflow)
if unshifted == 0: flexBacklog = 0                       // no city: nothing to drain into
consumptionThisTick = inflexible + servedNow + recovered + overflow
```

`overflow` subtracts `recovered` (as implemented): without it, energy
already served out of the backlog this tick would be counted towards the
comfort bound again and served a second time.

`drainCap` (added in the final review) is what keeps a shrinking pool
from dumping its backlog. `capacity` scales with the _current_
`flexible`, so anything that shrinks the pool at once — buying
insulation halves the heating load, a heat plant coming online taking
buildings off on-site heating, storm damage, a mass bulldoze — would
otherwise leave the whole backlog above the new bound and serve it in a
single tick: a city-wide deficit out of nowhere. Capped, the backlog
may sit above the bound for a while and empties over several ticks
instead. `maxDrainShare` above the pool's own share of the load is what
guarantees it still shrinks every tick while above the bound. The
identity `unshifted − deferred + recovered + overflow = served` holds
either way: both caps only move energy between "served now" and "still
in the backlog".

`buildingConsumption` and `heatingConsumption` are then reported as what
each line actually drew: the net shift (`−deferred + recovered +
overflow`) is split between them in proportion to what each contributed
to the pool (`householdFlexShare × buildingDemand` against
`heatingFlexShare × heatingDemand`). Charging the whole shift to the
household line printed a negative household figure on a cold night,
where heating is the larger share of the pool.

`totalDemand` is replaced by `consumptionThisTick` for everything
downstream (storage cascade, biogas, deficit, import). The result
gains `flexDeferred = deferred`, `flexRecovered = recovered`,
`flexBacklog`, `flexOverflow = overflow` (as implemented, but a sim
result rather than a panel figure: `surplusAvailable` in
`src/sim/vehicles.ts` — the EV charging gate — adds the whole shift
back to reconstruct the unshifted load, and the overflow is part of
it) and
`unshifted = inflexible + flexible` (what consumption would have been).
With coverage 0 every new term is 0 and the step is numerically
identical to today. No randomness is added.

### Stats and history (`src/shared/types.ts`, `src/sim/tick.ts`)

- `EnergyStats.consumption` gains `flexDeferred`, `flexRecovered`,
  `flexBacklog` (energy units) — `flexRecovered` is "load shifted this
  tick".
- `EnergyHistoryPoint` gains `unshifted: number`; the accumulator
  averages it like consumption. History is in-memory only.
- `GlobalStats` replaces `smartCharging: boolean` with
  `smartMeters: { active: boolean; metered: number; buildings: number;
coverage: number; costPerMeter: number }`. The old boolean was deleted
  outright when the agent tool was cut over (nothing reads it any more);
  only `SaveGame`/`SaveGameJson` keep an optional legacy
  `smartCharging?: boolean` for migrating old saves.
- `GlobalStats.budget` gains `smartMeters` (install cost per tick,
  flattened like `repair`).

### Goal (`src/sim/goals.ts`)

`flexibleCity`: `goalProgress.flexTicks` counts ticks where coverage ≥
`goalCoverage`, population ≥ 50 and `flexDeferred + flexRecovered > 0`;
achieved at `TICKS_PER_DAY / 2`. Progress is saved like the other
counters (optional field, defaults to 0).

### UI (`src/ui/`)

- `HudConsole.tsx`: the smart-charging toggle becomes the rollout
  control — a checkbox bound to `smartMeters.active` (keeps
  `data-testid="smart-charging"` on the input so the e2e test keeps
  working), label "Smart-meter rollout · 42 % (84/200)", tooltip with
  the cost per meter and what metered buildings do. `App.tsx` sends
  `setSmartMeterRollout`.
- `EnergyPanel.tsx`: rows "Smart meters" (coverage, metered/total),
  "Load shifted" (`flexRecovered`), "Deferred" (`flexBacklog`), shown
  when coverage > 0 or backlog > 0.
- `EnergyGraph.tsx`: dashed `unshifted` series in the consumption
  colour at reduced opacity, drawn under the solid consumption line,
  with a legend entry; hidden when every point's `unshifted` equals its
  `consumption` (no rollout).
- `BudgetPanel.tsx`: "Smart meters" expense row.
- `i18n.tsx`: all new strings in English and German; the old
  `smartCharging.*` keys are replaced; help text for the grid/energy
  section explains the rollout, the flexible share and the dashed line.

### Agent tools (`src/agent/tools.ts`, `docs/agent-tools.md`)

`set_smart_charging` is replaced by `set_smart_meter_rollout { active }`;
`get_game_overview` reports `smartMeters` instead of `smartCharging`;
`get_energy_report` includes the three flex figures and `unshifted` in
history samples. Docs table updated; the test that lists tool names
updated.

## Determinism and performance

Per tick: one clamp, a few arithmetic lines, one hash per vehicle
decision (already per vehicle). No RNG. The pool is a handful of scalar
operations.

## Testing

- `src/sim/smartMeters.test.ts`: pacing (exactly `installsPerDay`
  meters after one day), billing per meter, no installs when broke,
  pause stops installs, clamp on demolition (bulldoze a metered city
  → metered ≤ buildings), coverage 0 without buildings, legacy-save
  migration (smartCharging true → full coverage, false → none),
  round-trip of the new save fields.
- `src/sim/vehicles.test.ts` / `transit.test.ts`: at coverage 0 every
  vehicle charges whenever plugged in; at coverage 1 the old smart
  behaviour; at 0.5 the smart set is stable across ticks and roughly
  half (hash gate).
- `src/sim/energy.test.ts`: with coverage 0 results are byte-identical
  to a run without the feature (snapshot of consumption/storage over a
  day); with coverage 1 at night with no surplus, `flexDeferred > 0`
  and consumption drops by exactly the flexible share; with surplus the
  backlog drains into `flexRecovered` and never below 0; the comfort
  bound serves overflow and keeps `flexBacklog ≤ capacity`;
  `unshifted − consumption === deferred − recovered − overflow`.
- `src/sim/goals.test.ts`: `flexibleCity` needs coverage, population and
  shifting, achieved after half a day of qualifying ticks.
- `src/sim/engine.test.ts` determinism tests keep passing;
  `serialization.test.ts` covers the new optional fields.
- `src/ui/*`: existing UI tests pass; the rollout control renders
  coverage; EnergyGraph hides the dashed line without a rollout.
- `src/agent/tools.test.ts`: tool list, `set_smart_meter_rollout`
  validation and effect, overview block.
- Pacing probe (temporary, deleted after): script a 150-building city,
  start the rollout, run 20 in-game days, print coverage per day, total
  cost, daily shifted share and peak-load reduction; adjust the balance
  values so full coverage takes roughly one in-game year for a mid-size
  city and shifted load is visible (≥ 5 % of consumption) without
  trivialising storage.

  Done (`src/sim/_smartMetersProbe.test.ts`, deleted): a 144-building,
  960-resident town on 16 plants over two weather seeds, plus a
  298-building, 1_766-resident city on 35 plants, each run a full year
  (20 days, all four seasons) per configuration and always against the
  same city with the rollout paused. Results that the Balance block is
  frozen on:

  - **Pacing**: at `installsPerDay` 15 the 298-building city (a
    mid-size city on the default 64×64 map) reaches 98 % coverage over
    the 20-day year, the small 144-building town in ten days; at 8 the
    larger city was still at 51 % after a year. The 150-building
    yardstick in the target above was written before the probe: on the
    default map size, 15 a day is what "roughly one in-game year"
    means.
  - **Cost**: 900 money a day while the crews work, 4.2-4.5 % of either
    city's daily tax income; 8_640 for the small town (about five
    batteries), 18_000 for the larger one. A full-coverage year ran
    20_000-34_000 money ahead of the paused town (import 10-13 %
    lower), the build-up year behind it — the programme pays for itself
    from the second year.
  - **Shifted load**: 2.1-2.2 % of a full-coverage year's consumption is
    recovered out of the backlog, up to 6.4 % on a single day. The
    spec's "≥ 5 % of consumption" target is a daily-average figure the
    mechanic only reaches on its best days; hour by hour it is far more
    visible, with served load 10-25 % below the unshifted line through a
    deficit evening and 20-25 % above it when generation returns.
  - **Storage**: at 4 backlog hours the mean state of charge is
    0.42 / 0.54 against the paused town's 0.46 / 0.50, and 0.553
    against 0.553 on the larger city — no systematic loss. At 6-8 hours
    it drops to 0.38-0.40 while the backlog grows to ten times the
    town's battery capacity: the pool would take over storage's job.
  - **Comfort bound**: about three quarters of all deferred energy is
    served under the comfort rule rather than shifted into surplus
    (87 % at 2 backlog hours, 67 % at 8) — a night is longer than the
    window, which is the intended behaviour, not a tuning failure.
  - **Peaks**: the pool shifts load out of hours _without_ renewable
    surplus and into hours _with_ it, which is not always the midday —
    a windy evening drains the backlog, so the evening peak can be
    higher than it would have been without the rollout (up to +20 % in
    the measured year, always within that hour's generation). Recovery
    had no per-tick rate limit when this was measured, so a strongly
    over-generating city could serve the whole backlog in a few ticks:
    the worst single tick measured was 1.36x the unshifted peak at the
    frozen values (1.9-2.3x with larger flex shares). The final review
    added that cap for the shrinking-pool case — `maxDrainShare`, see
    the Flexible pool — and it bounds this spike as well: served load
    is now at most `1 + maxDrainShare` times the tick's own unshifted
    load, i.e. 1.35x, just under what the probe measured.

- `node scripts/smoke.mjs`; `pnpm coverage` gate; e2e `smart-charging`
  checkbox test still passes.
- Mac visual pass: the dashed line reads clearly against the solid
  consumption line; the HUD label fits the console width in both
  languages.

## Out of scope

Per-building meter placement or an overlay; demand response contracts
(next backlog item); tariffs or price signals to households; changes to
storage, market trading or heat-network dispatch; a settings option to
hide the dashed line.
