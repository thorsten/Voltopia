# Scenarios / campaign — design

Date: 2026-10-16. Status: approved in conversation, awaiting spec review.

## Purpose

Hand-made challenges that teach the later systems (grid islands,
Dunkelflaute, storms, electrifying an existing town) with a fixed map,
a starting city, a deadline, explicit win and fail conditions and an
end screen. Guided play goals first; replayability and authoring by
players are out of scope.

## Decisions

- Scenarios live in the simulation (`src/sim/scenarios/`), not the UI:
  deterministic, reload-safe, visible to agents, testable headless.
- A starting city is **stamped** at init, never grown: one in-game day
  of simulation costs about 1.5 s headless on a 48 grid, so a growth
  warmup would freeze the worker for the better part of a minute.
- Each scenario has a deadline in days, win conditions (all must hold)
  and fail conditions (any one ends the run). After the end the city
  stays playable as a sandbox.
- Regular goals keep counting during a scenario but the goals panel is
  replaced by the objectives panel; the all-goals win screen stays for
  free play.

## 1. Definitions

`src/sim/scenarios/types.ts`:

```ts
export const SCENARIO_IDS = ['island', 'dunkelflaute', 'oldTown', 'stormSeason'] as const;
export type ScenarioId = (typeof SCENARIO_IDS)[number];

export type ScenarioMetric =
  'population' | 'money' | 'deficitTicks' | 'importedEnergy' | 'renewableShare' | 'suppliedShare';

export type Condition =
  | { kind: 'goal'; id: GoalId }
  | { kind: 'metric'; metric: ScenarioMetric; op: '>=' | '<='; value: number; windowDays?: number };

export interface ScenarioRules {
  /** Multiplies BALANCE.market.importCapacity; 0 = no import link. */
  importCapacityFactor: number;
  /** Season in which day 0 falls. */
  startSeason: SeasonId;
}

export interface ScenarioDef {
  id: ScenarioId;
  seed: number;
  size: number;
  startingMoney: number;
  disasterScale: number;
  rules: ScenarioRules;
  deadlineDays: number;
  win: Condition[];
  fail: Condition[];
  setup: (state: SimState) => void;
}
```

Metric semantics (all evaluated at day rollover):

- `population`, `money`, `renewableShare`, `suppliedShare`: value of
  the last completed day (`windowDays` ignored; share metrics are the
  day's average).
- `deficitTicks`, `importedEnergy`: sum over the last `windowDays`
  days (default: the whole run).

### Stamping helpers, `src/sim/scenarios/stamp.ts`

- `stampRoads(state, tiles)`, `stampZone(state, tiles, zone)`,
  `stampPlant(state, tile, plant)`, `stampLines(state, tiles)`: call the
  existing sim build functions with the cost suppressed (money is
  restored to `startingMoney` after setup) and reject nothing silently:
  a rejected stamp throws, so a broken scenario fails its test.
- `stampBuildings(state, tiles, density)`: for zoned, road-adjacent
  land tiles sets `density`, `variant` (from `state.rng`), and
  `buildingAge` to the lived-in threshold; throws on any other tile.
- Every scenario's setup ends with `state.gridVersion++` and a full
  dirty mark so the renderer draws the stamped city.

### Shipped scenarios, `src/sim/scenarios/defs/<id>.ts`

| id           | start                                            | rules                                | deadline | win                                                              | fail                                           |
| ------------ | ------------------------------------------------ | ------------------------------------ | -------- | ---------------------------------------------------------------- | ---------------------------------------------- |
| island       | small coastal town, no substation possible       | importCapacityFactor 0, spring       | 1 year   | population >= 300; deficitTicks <= 0 over last 30 days           | money <= bankruptcy line                       |
| dunkelflaute | mid-size town with solar farms and few batteries | autumn end (winter begins at day 10) | 90 days  | deficitTicks <= N over whole run; population >= start population | money <= bankruptcy line                       |
| oldTown      | dense unpowered town, no plants, no lines        | normal import, spring                | 180 days | suppliedShare >= 0.95; renewableShare >= 0.8                     | money <= bankruptcy line                       |
| stormSeason  | town with a large onshore wind fleet, few pylons | disasterScale 1.6, autumn            | 120 days | goal stormProof; deficitTicks <= N over last 30 days             | money <= bankruptcy line; suppliedShare <= 0.5 |

Seeds, sizes (48 or 64), funds and all N values live in
`BALANCE.scenarios.<id>` and are tuned with a headless probe during
implementation (winnable with a sensible plan, lost when ignored).
The bankruptcy line is `BALANCE.scenarios.bankruptMoney` (negative).

## 2. Runtime, state, protocol

### State

```ts
SimState.scenario?: {
  id: ScenarioId;
  startTick: number;
  status: 'running' | 'won' | 'failed';
  endedTick?: number;
  /** Per-day samples, newest last, capped at the longest window used. */
  samples: Record<ScenarioMetric, number[]>;
  /** Running counters for the current day. */
  today: { deficitTicks: number; importedEnergy: number; supplied: number; renewable: number; ticks: number };
};
SimState.rules: ScenarioRules;   // default { importCapacityFactor: 1, startSeason: 'spring' }
```

`rules` exists on every state so the balance code has no scenario
branch: `islandBalance.ts` multiplies the import capacity by
`state.rules.importCapacityFactor`. `startSeason` is applied once at
init by setting `seasonOriginDay` so day 0 is the first day of that
season (negative origin is allowed by `yearPhase`).

### Step

`scenarioStep(state)` in `src/sim/scenarios/step.ts`, called from
`tick.ts` after `goalsStep`, only when `state.scenario` exists and is
`running`:

1. Accumulate `today` from `lastEnergy` and the supply layer.
2. At day rollover: push samples, reset `today`.
3. Evaluate `fail`; any true sets `failed` with `endedTick`.
4. Otherwise, if the elapsed days reach `deadlineDays`, evaluate `win`;
   all true sets `won`, else `failed`.
5. Goal conditions read `state.goalsAchieved`.

After the end the status is frozen and the sim runs on. Retry is a
fresh `init`.

### Engine init

`init` gets `scenario?: ScenarioId`. Order: `createSimState(def.seed,
def.size, def.startingMoney)`, `disasterScale = def.disasterScale`,
terrain/water/geothermal/forest generation as today, `rules`,
`seasonOriginDay`, `def.setup(state)`, restore money, then
`state.scenario = { id, startTick: 0, status: 'running', ... }`. The
`seed`/`size` fields of the command are ignored when `scenario` is set.

### Stats and save

- `GlobalStats.scenario?: { id; status; day; deadlineDays; conditions: ConditionStatus[] }`
  with `ConditionStatus = { role: 'win' | 'fail'; kind; label: string; met: boolean; current: number; target: number }`.
  `label` is an i18n key (`scenario.condition.<metric>` or `goal.<id>.title`).
- `SaveGame.scenario?` mirrors `SimState.scenario`; `SaveGame.rules?`
  mirrors `SimState.rules`. Both optional, `SAVE_VERSION` unchanged;
  missing fields mean free play with default rules.

### Tests (`src/sim/scenarios/*.test.ts`)

- stamp helpers: valid stamps change layers, invalid ones throw, money
  unchanged after setup.
- conditions: each metric and op, window sum versus last-day value,
  goal kind.
- step: fail beats win on the same day; win only at the deadline; status
  frozen afterwards.
- save round trip with and without scenario; determinism (same scenario
  twice gives equal state hashes after 2 days).
- one smoke test per shipped scenario: setup succeeds, no stamped
  building on water or without road access, `rules` applied.
- keep any single test under ~15 s; the per-scenario probes are
  temporary scripts, not tests.

## 3. UI, agent, docs

- **Scenarios page** `src/ui/ScenariosPage.tsx`: reached from the
  menu beside New Game. One card per scenario: title, teaser,
  deadline, win and fail lines, best result from `localStorage`
  (`voltopia.scenario.<id>` = `{ status, day }`). Start writes
  `{ scenario: id }` via `storePendingNewGame` (`NewGameOptions.scenario?: ScenarioId`)
  and reloads exactly like New Game.
- **Objectives panel** `src/ui/ScenarioPanel.tsx`: replaces
  `GoalsPanel` while `stats.scenario` is set. Shows "day X of Y", one
  row per win condition with current/target and a check, and the fail
  conditions under their own heading.
- **End screen**: `WinScreen` becomes `EndScreen` with a `won`/`failed`
  variant showing condition results and the day. Buttons: continue
  (sandbox), retry (store pending scenario, reload), scenarios page.
  Shown once per run, keyed by seed plus `startTick`; the free-play
  all-goals celebration keeps its current behaviour.
- **i18n**: `scenario.<id>.title`, `.teaser`, `scenario.condition.<metric>`,
  `scenario.status.{running,won,failed}`, panel and button strings; EN and DE.
- **Agent**: `list_scenarios`, `start_scenario(id)`; `get_game_overview`
  gains a `scenario` block (status, day, deadline, conditions). Update
  `docs/agent-tools.md`.
- **Docs**: mark the scenarios entry done in `docs/idea.md` with the
  probe numbers; update `docs/plan.md`.
- **e2e**: open scenarios page, start `dunkelflaute`, objectives panel
  shows the deadline, reload keeps the scenario.

## Out of scope

Campaign unlock order, leaderboards, player-authored scenario files,
multiple difficulty levels per scenario.
