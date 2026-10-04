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
moves consumption from the evening peak into the midday surplus, which
the energy graph shows directly. A goal rewards a highly metered city
that actually shifts load.

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
  /** Coverage the flexibleCity goal requires. */
  goalCoverage: 0.8,
},
```

`BALANCE.costs` is not used for the meter price because the price is
per unit installed, not a one-off; it lives with the mechanic's other
values. All numbers are provisional until the pacing probe (see
Testing).

### Sim state (`src/sim/state.ts`)

```ts
smartMeters: {
  /** Crews are installing. */
  active: boolean;
  /** Buildings with a meter (never above the building count). */
  metered: number;
  /** Fractional installs carried between ticks (installsPerDay / TICKS_PER_DAY per tick). */
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
budget. It clamps `metered` to the current building count (demolition
and abandonment lose meters), then, if active and `metered <
buildings`, adds `installsPerDay / TICKS_PER_DAY` to `installCarry`;
each whole meter in the carry installs one meter and costs
`costPerMeter`, as long as the treasury can pay (otherwise the carry
waits; the rollout does not go into debt). The cost is returned to the
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
and `heatingDemand` (on-site electric heating only; network pumps and
the fallback share are separate) and after `generation` is known:

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
capacity   = flexible × backlogHours × (TICKS_PER_DAY / 24)  // comfort bound, in energy units
overflow   = max(0, flexBacklog + deferred − capacity)   // served regardless
flexBacklog = flexBacklog + deferred − recovered − overflow
consumptionThisTick = inflexible + servedNow + recovered + overflow
```

`totalDemand` is replaced by `consumptionThisTick` for everything
downstream (storage cascade, biogas, deficit, import). The result
gains `flexDeferred = deferred`, `flexRecovered = recovered`,
`flexBacklog`, and `unshifted = inflexible + flexible` (what
consumption would have been). With coverage 0 every new term is 0 and
the step is numerically identical to today. No randomness is added.

### Stats and history (`src/shared/types.ts`, `src/sim/tick.ts`)

- `EnergyStats.consumption` gains `flexDeferred`, `flexRecovered`,
  `flexBacklog` (energy units) — `flexRecovered` is "load shifted this
  tick".
- `EnergyHistoryPoint` gains `unshifted: number`; the accumulator
  averages it like consumption. History is in-memory only.
- `GlobalStats` replaces `smartCharging: boolean` with
  `smartMeters: { active: boolean; metered: number; buildings: number;
coverage: number; costPerMeter: number }`.
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
