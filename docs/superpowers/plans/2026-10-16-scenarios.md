# Scenarios / Campaign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Four hand-made scenarios (island, dunkelflaute, oldTown, stormSeason) with a stamped starting city, rules, a deadline, win/fail conditions, an objectives panel, an end screen, agent tools and docs.

**Architecture:** Scenario definitions and evaluation live in the pure sim (`src/sim/scenarios/`), driven by a new `scenarioStep` in `tick.ts` and persisted in `SaveGame` as optional fields. The engine stamps the starting city at `init` when the command carries a `scenario` id. The UI reads `GlobalStats.scenario` for the objectives panel and end screen; the new-game reload path is reused to start a scenario.

**Tech Stack:** TypeScript strict, vitest, React 19, i18n in `src/ui/i18n.tsx`, Playwright for e2e. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-16-scenarios-design.md`

## Global Constraints

- `src/sim/` has no DOM or three.js imports; all randomness via `state.rng`.
- No magic numbers in sim code: every tuning value in `BALANCE` (`src/shared/constants.ts`).
- Every user-visible string goes through `src/ui/i18n.tsx`, English AND German.
- `SaveGame` stays backward compatible: new fields optional, `SAVE_VERSION` unchanged.
- Keep any single test under ~15 s; one in-game day costs ~1.5 s headless, so tests simulate at most a few days and use `TICKS_PER_DAY` arithmetic for deadlines instead of long runs (set `state.scenario.startTick` or `state.tick` directly).
- Run `pnpm format` after edits; commit only with the hook green (`pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`).
- New sim command or feature: add agent tool support and update `docs/agent-tools.md`.

## Review Focus

1. A save from before scenarios (no `scenario`, no `rules`) must load as free play with import capacity factor 1 and the season unchanged. Test in Task 1 and Task 3.
2. A scenario that fails on the same day the deadline is reached must end `failed`, never `won`. Test in Task 3.
3. A `windowDays` longer than the days played so far must sum only the days that exist, not treat missing days as zero deficit. Test in Task 3.
4. Stamping onto a water tile, a non-zoned tile or a tile without road access must throw, so a broken scenario definition fails its smoke test instead of shipping a half city. Test in Task 2.
5. Starting a scenario from the UI must not consume a pending plain new-game option set, and reloading mid-scenario must keep the objectives panel. Test in Task 5 (unit) and Task 9 (e2e).

---

### Task 1: Rules on the state, BALANCE block, import factor, season start

**Files:**

- Create: `src/sim/scenarios/types.ts`
- Modify: `src/shared/constants.ts` (add `BALANCE.scenarios`)
- Modify: `src/sim/state.ts` (add `rules`, serialize/deserialize)
- Modify: `src/shared/types.ts` (`SaveGame.rules?`)
- Modify: `src/sim/islandBalance.ts:19-25,172` (`importCapacityFactor` on `IslandInput`)
- Modify: `src/sim/energy.ts:527` (pass the factor)
- Create: `src/sim/scenarios/rules.ts`
- Test: `src/sim/scenarios/rules.test.ts`, `src/sim/islandBalance.test.ts`

**Interfaces:**

- Produces: `ScenarioRules`, `DEFAULT_RULES`, `seasonOriginDayFor(startSeason: SeasonId): number`, `applyRules(state, rules)`, `SimState.rules: ScenarioRules`, `IslandInput.importCapacityFactor: number`.

- [ ] **Step 1: Create the types file**

```ts
// src/sim/scenarios/types.ts
import type { SeasonId } from '../../shared/types.ts';
import type { GoalId } from '../goals.ts';
import type { SimState } from '../state.ts';

export const SCENARIO_IDS = ['island', 'dunkelflaute', 'oldTown', 'stormSeason'] as const;
export type ScenarioId = (typeof SCENARIO_IDS)[number];

export const SCENARIO_METRICS = [
  'population',
  'money',
  'deficitTicks',
  'importedEnergy',
  'renewableShare',
  'suppliedShare',
] as const;
export type ScenarioMetric = (typeof SCENARIO_METRICS)[number];

export type Condition =
  | { kind: 'goal'; id: GoalId }
  | {
      kind: 'metric';
      metric: ScenarioMetric;
      op: '>=' | '<=';
      value: number;
      /** For deficitTicks / importedEnergy: sum over the last N days (default: whole run). */
      windowDays?: number;
    };

export interface ScenarioRules {
  /** Multiplies BALANCE.market.importCapacity; 0 = no import link. */
  importCapacityFactor: number;
  /** Season in which day 0 falls. */
  startSeason: SeasonId;
}

export const DEFAULT_RULES: ScenarioRules = { importCapacityFactor: 1, startSeason: 'spring' };

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

export type ScenarioStatus = 'running' | 'won' | 'failed';

export interface ScenarioRun {
  id: ScenarioId;
  startTick: number;
  status: ScenarioStatus;
  endedTick?: number;
  /** Per-day samples, newest last, capped at BALANCE.scenarios.maxSamples. */
  samples: Record<ScenarioMetric, number[]>;
  /** Running counters for the current day. */
  today: {
    deficitTicks: number;
    importedEnergy: number;
    renewable: number;
    generation: number;
    suppliedShareSum: number;
    ticks: number;
  };
}

export function emptyRun(id: ScenarioId, startTick: number): ScenarioRun {
  return {
    id,
    startTick,
    status: 'running',
    samples: {
      population: [],
      money: [],
      deficitTicks: [],
      importedEnergy: [],
      renewableShare: [],
      suppliedShare: [],
    },
    today: {
      deficitTicks: 0,
      importedEnergy: 0,
      renewable: 0,
      generation: 0,
      suppliedShareSum: 0,
      ticks: 0,
    },
  };
}
```

- [ ] **Step 2: Add the BALANCE block** (append inside `BALANCE` in `src/shared/constants.ts`, next to `goals`):

```ts
  scenarios: {
    /** Money at or below which any scenario is lost. */
    bankruptMoney: -5_000,
    /** Longest metric window any scenario uses; samples beyond it are dropped. */
    maxSamples: 365,
    island: {
      seed: 11,
      size: 48,
      startingMoney: 30_000,
      deadlineDays: 4 * DAYS_PER_SEASON,
      population: 300,
      deficitWindowDays: 30,
    },
    dunkelflaute: {
      seed: 12,
      size: 48,
      startingMoney: 20_000,
      deadlineDays: 90,
      maxDeficitTicks: 200,
    },
    oldTown: {
      seed: 13,
      size: 48,
      startingMoney: 35_000,
      deadlineDays: 180,
      suppliedShare: 0.95,
      renewableShare: 0.8,
    },
    stormSeason: {
      seed: 14,
      size: 48,
      startingMoney: 25_000,
      disasterScale: 1.6,
      deadlineDays: 120,
      maxDeficitTicks: 300,
      deficitWindowDays: 30,
      minSuppliedShare: 0.5,
    },
  },
```

Numbers are first guesses; Task 8 tunes them with a probe.

- [ ] **Step 3: Write the failing rules test**

```ts
// src/sim/scenarios/rules.test.ts
import { describe, expect, it } from 'vitest';
import { BALANCE } from '../../shared/constants.ts';
import { SEASON_ORDER } from '../../shared/types.ts';
import { createSimState, deserializeState, serializeState } from '../state.ts';
import { stepTick } from '../tick.ts';
import { applyRules, seasonOriginDayFor } from './rules.ts';
import { DEFAULT_RULES } from './types.ts';

describe('scenario rules', () => {
  it('a new state carries the default rules', () => {
    const state = createSimState(1, 16);
    expect(state.rules).toEqual(DEFAULT_RULES);
  });

  it('seasonOriginDayFor puts day 0 on the first day of the season', () => {
    const days = BALANCE.seasons.daysPerSeason;
    expect(seasonOriginDayFor('spring')).toBe(0);
    expect(seasonOriginDayFor('winter')).toBe(-days * SEASON_ORDER.indexOf('winter'));
  });

  it('applyRules sets the season so the first tick is in that season', () => {
    const state = createSimState(1, 16);
    applyRules(state, { importCapacityFactor: 0, startSeason: 'winter' });
    stepTick(state);
    expect(state.season.season).toBe('winter');
    expect(state.rules.importCapacityFactor).toBe(0);
  });

  it('rules survive a save round trip and default when absent', () => {
    const state = createSimState(1, 16);
    applyRules(state, { importCapacityFactor: 0, startSeason: 'autumn' });
    const save = serializeState(state);
    expect(deserializeState(save).rules).toEqual({
      importCapacityFactor: 0,
      startSeason: 'autumn',
    });
    delete save.rules;
    expect(deserializeState(save).rules).toEqual(DEFAULT_RULES);
  });
});
```

- [ ] **Step 4: Run it to see it fail**

Run: `npx vitest run src/sim/scenarios/rules.test.ts`
Expected: FAIL, `rules.ts` not found.

- [ ] **Step 5: Implement rules**

```ts
// src/sim/scenarios/rules.ts
import { BALANCE } from '../../shared/constants.ts';
import { SEASON_ORDER, type SeasonId } from '../../shared/types.ts';
import type { SimState } from '../state.ts';
import type { ScenarioRules } from './types.ts';

/** seasonOriginDay such that day 0 is the first day of `startSeason`. */
export function seasonOriginDayFor(startSeason: SeasonId): number {
  return -BALANCE.seasons.daysPerSeason * SEASON_ORDER.indexOf(startSeason);
}

/** Install scenario rules on a freshly created state (before any tick). */
export function applyRules(state: SimState, rules: ScenarioRules): void {
  state.rules = { ...rules };
  state.seasonOriginDay = seasonOriginDayFor(rules.startSeason);
}
```

In `src/sim/state.ts`:

- Import `DEFAULT_RULES, type ScenarioRules` from `./scenarios/types.ts`.
- Add to the `SimState` interface next to `seasonOriginDay`: `/** Scenario rules; DEFAULT_RULES in free play. */ rules: ScenarioRules;`
- In `createSimState` next to `seasonOriginDay: 0,`: `rules: { ...DEFAULT_RULES },`
- In `serializeState` next to `seasonOriginDay:`: `rules: { ...state.rules },`
- In `deserializeState` after the `seasonOriginDay` line: `state.rules = { ...DEFAULT_RULES, ...(save.rules ?? {}) };`

In `src/shared/types.ts` add to `SaveGame` after `seasonOriginDay?`:

```ts
  /** Scenario rules (absent in older saves → free-play defaults). */
  rules?: { importCapacityFactor: number; startSeason: SeasonId };
```

- [ ] **Step 6: Write the failing import-factor test** (append to `src/sim/islandBalance.test.ts`; copy the existing `baseInput()` helper usage in that file for an input with one substation and a shortfall):

```ts
it('importCapacityFactor scales the import link', () => {
  const input = baseInput(); // existing helper in this file: deficit island, substations: 1
  const full = balanceIsland({ ...input, importCapacityFactor: 1 }, emptyPool());
  const none = balanceIsland({ ...input, importCapacityFactor: 0 }, emptyPool());
  expect(full.gridImport).toBeGreaterThan(0);
  expect(none.gridImport).toBe(0);
  expect(none.deficit).toBeGreaterThan(full.deficit);
});
```

If the file has no such helper, build the input the way the existing deficit test in that file does and set `substations: 1`.

- [ ] **Step 7: Implement the factor**

`src/sim/islandBalance.ts`: add to `IslandInput`:

```ts
/** Scenario rule: multiplies the import link (1 in free play, 0 = none). */
importCapacityFactor: number;
```

and change line 172 to:

```ts
const importCapacity =
  input.substations * BALANCE.market.importCapacity * input.importCapacityFactor;
```

`src/sim/energy.ts` at the `balanceIsland(...)` call (around line 527): add `importCapacityFactor: state.rules.importCapacityFactor,` next to `substations: c.substations,`. Fix every other `IslandInput` literal in tests with `importCapacityFactor: 1` (grep `substations:` in `src/sim/*.test.ts`).

- [ ] **Step 8: Run the tests**

Run: `npx vitest run src/sim/scenarios src/sim/islandBalance.test.ts src/sim/state.test.ts src/storage`
Expected: PASS. Then `pnpm typecheck`.

- [ ] **Step 9: Commit**

```bash
pnpm format
git add src/sim/scenarios/types.ts src/sim/scenarios/rules.ts src/sim/scenarios/rules.test.ts src/shared/constants.ts src/shared/types.ts src/sim/state.ts src/sim/islandBalance.ts src/sim/islandBalance.test.ts src/sim/energy.ts
git commit -m "feat(sim): scenario rules on the state and an import-link factor"
```

---

### Task 2: Stamp helpers

**Files:**

- Create: `src/sim/scenarios/stamp.ts`
- Test: `src/sim/scenarios/stamp.test.ts`

**Interfaces:**

- Consumes: `buildRoads`, `paintZones`, `placePlant`, `buildPowerLines` (`BuildResult { rejected?: string }`), `hasRoadAccess(state, index)`, `markDirty`, `bumpGridVersion`-style counter `state.gridVersion`.
- Produces: `stampRoads(state, tiles, avenue?)`, `stampZone(state, tiles, zone)`, `stampPlant(state, tile, plant)`, `stampLines(state, tiles)`, `stampBuildings(state, tiles, density)`, `withFreeBuild(state, fn)`, `ScenarioSetupError`.

- [ ] **Step 1: Write the failing test**

```ts
// src/sim/scenarios/stamp.test.ts
import { describe, expect, it } from 'vitest';
import { BALANCE } from '../../shared/constants.ts';
import { tileIndex } from '../../shared/grid.ts';
import { PlantType, Terrain, TileType, Zone } from '../../shared/types.ts';
import { createSimState } from '../state.ts';
import {
  ScenarioSetupError,
  stampBuildings,
  stampLines,
  stampPlant,
  stampRoads,
  stampZone,
  withFreeBuild,
} from './stamp.ts';

const SIZE = 16;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);

function flatState() {
  // createSimState leaves terrain all Land and the map empty.
  return createSimState(5, SIZE);
}

describe('stamp helpers', () => {
  it('stamps a road, a zone and buildings beside it without spending money', () => {
    const state = flatState();
    const money = state.money;
    withFreeBuild(state, () => {
      stampRoads(state, [at(2, 5), at(3, 5), at(4, 5)]);
      stampZone(state, [at(2, 4), at(3, 4)], Zone.Residential);
      stampBuildings(state, [at(2, 4), at(3, 4)], 2);
      stampPlant(state, at(6, 5), PlantType.Solar);
      stampLines(state, [at(5, 5), at(6, 5)]);
    });
    expect(state.money).toBe(money);
    expect(state.layers.tileType[at(3, 5)]).toBe(TileType.Road);
    expect(state.layers.density[at(2, 4)]).toBe(2);
    expect(state.layers.buildingAge[at(2, 4)]).toBe(BALANCE.growth.ageStageTicks[0]);
    expect(state.layers.tileType[at(6, 5)]).toBe(TileType.Plant);
    expect(state.dirty.has(at(2, 4))).toBe(true);
  });

  it('throws on a building without zone or road access, or on water', () => {
    const state = flatState();
    stampRoads(state, [at(2, 5)]);
    expect(() => stampBuildings(state, [at(2, 4)], 1)).toThrow(ScenarioSetupError);
    stampZone(state, [at(2, 4), at(9, 9)], Zone.Residential);
    expect(() => stampBuildings(state, [at(9, 9)], 1)).toThrow(ScenarioSetupError);
    state.layers.terrain[at(2, 4)] = Terrain.Lake;
    expect(() => stampBuildings(state, [at(2, 4)], 1)).toThrow(ScenarioSetupError);
  });

  it('throws when the underlying build is rejected', () => {
    const state = flatState();
    state.layers.terrain[at(1, 1)] = Terrain.Sea;
    expect(() => stampRoads(state, [at(1, 1)])).toThrow(ScenarioSetupError);
  });

  it('restores the money even when setup throws', () => {
    const state = flatState();
    const money = state.money;
    expect(() =>
      withFreeBuild(state, () => {
        stampRoads(state, [at(2, 5)]);
        throw new ScenarioSetupError('boom');
      }),
    ).toThrow(ScenarioSetupError);
    expect(state.money).toBe(money);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/sim/scenarios/stamp.test.ts`
Expected: FAIL, `stamp.ts` not found.

- [ ] **Step 3: Implement**

```ts
// src/sim/scenarios/stamp.ts
import { BALANCE, BUILDING_VARIANTS } from '../../shared/constants.ts';
import { type PlantType, Terrain, TileType, Zone } from '../../shared/types.ts';
import { placePlant } from '../energy.ts';
import { hasRoadAccess } from '../growth.ts';
import { buildPowerLines } from '../powerLines.ts';
import { type BuildResult, buildRoads } from '../roads.ts';
import { markDirty, type SimState } from '../state.ts';
import { paintZones } from '../zones.ts';

/** A scenario definition tried to stamp something the map cannot hold. */
export class ScenarioSetupError extends Error {}

function check(result: BuildResult, what: string): void {
  if (result.rejected) throw new ScenarioSetupError(`${what}: ${result.rejected}`);
}

/**
 * Run a setup with unlimited funds and restore the treasury afterwards,
 * so a stamped city costs the player nothing.
 */
export function withFreeBuild(state: SimState, setup: () => void): void {
  const money = state.money;
  state.money = Number.MAX_SAFE_INTEGER / 2;
  try {
    setup();
  } finally {
    state.money = money;
  }
}

export function stampRoads(state: SimState, tiles: number[], avenue = false): void {
  check(buildRoads(state, tiles, avenue), 'road');
}

export function stampZone(state: SimState, tiles: number[], zone: Zone): void {
  check(paintZones(state, tiles, zone), 'zone');
}

export function stampPlant(state: SimState, tile: number, plant: PlantType): void {
  check(placePlant(state, tile, plant), `plant ${plant}`);
}

export function stampLines(state: SimState, tiles: number[]): void {
  check(buildPowerLines(state, tiles), 'power line');
}

/**
 * Place grown buildings directly: the tiles must be zoned land with road
 * access. Age is set to the lived-in threshold so the city looks settled.
 */
export function stampBuildings(state: SimState, tiles: number[], density: 1 | 2 | 3): void {
  const { layers } = state;
  for (const index of tiles) {
    if (layers.terrain[index] !== Terrain.Land)
      throw new ScenarioSetupError(`building on water at ${index}`);
    if (layers.zone[index] === Zone.None)
      throw new ScenarioSetupError(`building on unzoned tile ${index}`);
    if (layers.tileType[index] !== TileType.Empty)
      throw new ScenarioSetupError(`building on built tile ${index}`);
    if (!hasRoadAccess(state, index))
      throw new ScenarioSetupError(`building without road at ${index}`);
    layers.density[index] = density;
    layers.variant[index] = state.rng.nextInt(BUILDING_VARIANTS);
    layers.buildingAge[index] = BALANCE.growth.ageStageTicks[0];
    markDirty(state, index);
  }
}
```

Check the exact export name of `BUILDING_VARIANTS` (grep `BUILDING_VARIANTS` in `src/shared/constants.ts`; `growth.ts` imports it) and whether `buildRoads` rejects a sea tile (if it does not, use a `Terrain.River` tile in the third test or whatever the road builder rejects, e.g. an out-of-range index).

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/sim/scenarios/stamp.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add src/sim/scenarios/stamp.ts src/sim/scenarios/stamp.test.ts
git commit -m "feat(sim): stamp helpers for scenario starting cities"
```

---

### Task 3: Scenario run state, conditions, step, serialization

**Files:**

- Create: `src/sim/scenarios/conditions.ts`, `src/sim/scenarios/step.ts`
- Modify: `src/sim/state.ts` (`scenario?: ScenarioRun`, serialize/deserialize), `src/shared/types.ts` (`SaveGame.scenario?`), `src/sim/tick.ts` (call `scenarioStep` after `goalsStep`)
- Test: `src/sim/scenarios/conditions.test.ts`, `src/sim/scenarios/step.test.ts`

**Interfaces:**

- Consumes: `ScenarioRun`, `Condition`, `ScenarioDef`, `emptyRun`, `state.lastEnergy` (`deficit`, `gridImport`, `solar`, `wind`, `rooftop`, `hydro`, `tidal`, `geothermal`, `biogas`, `fuelCell`), `state.layers.supplied`/`density`, `countPopulationAndJobs(state).population`, `state.goalsAchieved`, `TICKS_PER_DAY`.
- Produces: `evaluateCondition(state, run, c): ConditionResult { met: boolean; current: number; target: number }`, `scenarioStep(state, def)`, `scenarioDay(run, tick): number` (completed days since start), `SimState.scenario?: ScenarioRun`.

- [ ] **Step 1: Write the failing conditions test**

```ts
// src/sim/scenarios/conditions.test.ts
import { describe, expect, it } from 'vitest';
import { createSimState } from '../state.ts';
import { evaluateCondition } from './conditions.ts';
import { emptyRun } from './types.ts';

describe('scenario conditions', () => {
  it('last-day metrics read the newest sample', () => {
    const state = createSimState(1, 16);
    const run = emptyRun('island', 0);
    run.samples.population = [10, 250, 320];
    expect(
      evaluateCondition(state, run, { kind: 'metric', metric: 'population', op: '>=', value: 300 }),
    ).toEqual({ met: true, current: 320, target: 300 });
    run.samples.money = [100, -6000];
    expect(
      evaluateCondition(state, run, { kind: 'metric', metric: 'money', op: '<=', value: -5000 })
        .met,
    ).toBe(true);
  });

  it('a metric with no sample yet is unmet with current 0', () => {
    const state = createSimState(1, 16);
    const run = emptyRun('island', 0);
    const r = evaluateCondition(state, run, {
      kind: 'metric',
      metric: 'population',
      op: '>=',
      value: 1,
    });
    expect(r).toEqual({ met: false, current: 0, target: 1 });
  });

  it('window metrics sum the last N existing days only', () => {
    const state = createSimState(1, 16);
    const run = emptyRun('island', 0);
    run.samples.deficitTicks = [50, 0, 5, 7];
    expect(
      evaluateCondition(state, run, {
        kind: 'metric',
        metric: 'deficitTicks',
        op: '<=',
        value: 12,
        windowDays: 3,
      }),
    ).toEqual({ met: true, current: 12, target: 12 });
    expect(
      evaluateCondition(state, run, {
        kind: 'metric',
        metric: 'deficitTicks',
        op: '<=',
        value: 12,
        windowDays: 30,
      }).current,
    ).toBe(62);
    expect(
      evaluateCondition(state, run, {
        kind: 'metric',
        metric: 'deficitTicks',
        op: '<=',
        value: 100,
      }).current,
    ).toBe(62);
  });

  it('goal conditions read goalsAchieved', () => {
    const state = createSimState(1, 16);
    const run = emptyRun('stormSeason', 0);
    expect(evaluateCondition(state, run, { kind: 'goal', id: 'stormProof' })).toEqual({
      met: false,
      current: 0,
      target: 1,
    });
    state.goalsAchieved.add('stormProof');
    expect(evaluateCondition(state, run, { kind: 'goal', id: 'stormProof' }).met).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/sim/scenarios/conditions.test.ts`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement conditions**

```ts
// src/sim/scenarios/conditions.ts
import type { SimState } from '../state.ts';
import type { Condition, ScenarioMetric, ScenarioRun } from './types.ts';

export interface ConditionResult {
  met: boolean;
  current: number;
  target: number;
}

/** Metrics summed over a window; the rest read the last completed day. */
const WINDOW_METRICS: ReadonlySet<ScenarioMetric> = new Set(['deficitTicks', 'importedEnergy']);

function metricValue(run: ScenarioRun, metric: ScenarioMetric, windowDays?: number): number {
  const samples = run.samples[metric];
  if (WINDOW_METRICS.has(metric)) {
    const from = windowDays === undefined ? 0 : Math.max(0, samples.length - windowDays);
    let sum = 0;
    for (let i = from; i < samples.length; i++) sum += samples[i];
    return sum;
  }
  return samples.length === 0 ? 0 : samples[samples.length - 1];
}

export function evaluateCondition(
  state: SimState,
  run: ScenarioRun,
  c: Condition,
): ConditionResult {
  if (c.kind === 'goal') {
    const met = state.goalsAchieved.has(c.id);
    return { met, current: met ? 1 : 0, target: 1 };
  }
  const current = metricValue(run, c.metric, c.windowDays);
  const met = c.op === '>=' ? current >= c.value : current <= c.value;
  return { met, current, target: c.value };
}
```

- [ ] **Step 4: Run the conditions test**

Run: `npx vitest run src/sim/scenarios/conditions.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing step test**

```ts
// src/sim/scenarios/step.test.ts
import { describe, expect, it } from 'vitest';
import { TICKS_PER_DAY } from '../../shared/constants.ts';
import { createSimState, deserializeState, serializeState, type SimState } from '../state.ts';
import { scenarioDay, scenarioStep } from './step.ts';
import { emptyRun, type ScenarioDef } from './types.ts';

function def(over: Partial<ScenarioDef> = {}): ScenarioDef {
  return {
    id: 'island',
    seed: 1,
    size: 16,
    startingMoney: 1000,
    disasterScale: 0,
    rules: { importCapacityFactor: 1, startSeason: 'spring' },
    deadlineDays: 2,
    win: [{ kind: 'metric', metric: 'money', op: '>=', value: 0 }],
    fail: [{ kind: 'metric', metric: 'money', op: '<=', value: -100 }],
    setup: () => {},
    ...over,
  };
}

function running(): SimState {
  const state = createSimState(1, 16);
  state.scenario = emptyRun('island', 0);
  return state;
}

/** Run one full day of scenario steps with a fixed energy outcome. */
function runDay(state: SimState, d: ScenarioDef, deficitTicks = 0): void {
  for (let i = 0; i < TICKS_PER_DAY; i++) {
    state.tick++;
    state.lastEnergy.deficit = i < deficitTicks ? 1 : 0;
    scenarioStep(state, d);
  }
}

describe('scenarioStep', () => {
  it('pushes one sample per metric at the day rollover', () => {
    const state = running();
    runDay(state, def(), 7);
    expect(state.scenario!.samples.deficitTicks).toEqual([7]);
    expect(state.scenario!.samples.money).toEqual([state.money]);
    expect(state.scenario!.today.ticks).toBe(0);
    expect(scenarioDay(state.scenario!, state.tick)).toBe(1);
  });

  it('wins at the deadline when every win condition holds', () => {
    const state = running();
    const d = def();
    runDay(state, d);
    expect(state.scenario!.status).toBe('running');
    runDay(state, d);
    expect(state.scenario!.status).toBe('won');
    expect(state.scenario!.endedTick).toBe(state.tick);
  });

  it('fails at the deadline when a win condition is unmet', () => {
    const state = running();
    state.money = -50;
    const d = def();
    runDay(state, d);
    runDay(state, d);
    expect(state.scenario!.status).toBe('failed');
  });

  it('a fail condition ends the run early and beats a win on the same day', () => {
    const state = running();
    state.money = -500;
    const d = def({
      win: [{ kind: 'metric', metric: 'money', op: '<=', value: 0 }],
      deadlineDays: 1,
    });
    runDay(state, d);
    expect(state.scenario!.status).toBe('failed');
  });

  it('freezes after the end', () => {
    const state = running();
    const d = def({ deadlineDays: 1 });
    runDay(state, d);
    const samples = state.scenario!.samples.money.length;
    runDay(state, d);
    expect(state.scenario!.samples.money.length).toBe(samples);
    expect(state.scenario!.status).toBe('won');
  });

  it('does nothing without a scenario', () => {
    const state = createSimState(1, 16);
    state.tick = TICKS_PER_DAY;
    expect(() => scenarioStep(state, def())).not.toThrow();
    expect(state.scenario).toBeUndefined();
  });

  it('survives a save round trip and is absent in an old save', () => {
    const state = running();
    runDay(state, def(), 3);
    const save = serializeState(state);
    const loaded = deserializeState(save);
    expect(loaded.scenario).toEqual(state.scenario);
    delete save.scenario;
    expect(deserializeState(save).scenario).toBeUndefined();
  });
});
```

- [ ] **Step 6: Run it to see it fail**

Run: `npx vitest run src/sim/scenarios/step.test.ts`
Expected: FAIL, `step.ts` missing.

- [ ] **Step 7: Implement the step and the state fields**

```ts
// src/sim/scenarios/step.ts
import { BALANCE, TICKS_PER_DAY } from '../../shared/constants.ts';
import { SupplyStatus } from '../../shared/types.ts';
import { countPopulationAndJobs, type SimState } from '../state.ts';
import { evaluateCondition } from './conditions.ts';
import type { ScenarioDef, ScenarioMetric, ScenarioRun } from './types.ts';

/** Completed scenario days at `tick`. */
export function scenarioDay(run: ScenarioRun, tick: number): number {
  return Math.floor((tick - run.startTick) / TICKS_PER_DAY);
}

function suppliedShare(state: SimState): number {
  const { density, supplied } = state.layers;
  let buildings = 0;
  let ok = 0;
  for (let i = 0; i < density.length; i++) {
    if (density[i] === 0) continue;
    buildings++;
    if (supplied[i] === SupplyStatus.Supplied) ok++;
  }
  return buildings === 0 ? 1 : ok / buildings;
}

function push(run: ScenarioRun, metric: ScenarioMetric, value: number): void {
  const samples = run.samples[metric];
  samples.push(value);
  if (samples.length > BALANCE.scenarios.maxSamples) samples.shift();
}

/**
 * Accumulate the day's counters every tick; at the day rollover store
 * the samples, then check fail conditions and, at the deadline, the win
 * conditions. Fail beats win on the same day. Nothing runs once the
 * scenario has ended.
 */
export function scenarioStep(state: SimState, def: ScenarioDef): void {
  const run = state.scenario;
  if (!run || run.status !== 'running') return;
  const e = state.lastEnergy;
  const t = run.today;
  if (e.deficit > 0) t.deficitTicks++;
  t.importedEnergy += e.gridImport;
  const renewable = e.solar + e.wind + e.rooftop + e.hydro + e.tidal + e.geothermal + e.fuelCell;
  t.renewable += renewable;
  t.generation += renewable + e.biogas + e.gridImport;
  t.suppliedShareSum += suppliedShare(state);
  t.ticks++;

  if ((state.tick - run.startTick) % TICKS_PER_DAY !== 0) return;

  push(run, 'population', countPopulationAndJobs(state).population);
  push(run, 'money', state.money);
  push(run, 'deficitTicks', t.deficitTicks);
  push(run, 'importedEnergy', t.importedEnergy);
  push(run, 'renewableShare', t.generation === 0 ? 1 : t.renewable / t.generation);
  push(run, 'suppliedShare', t.ticks === 0 ? 1 : t.suppliedShareSum / t.ticks);
  run.today = {
    deficitTicks: 0,
    importedEnergy: 0,
    renewable: 0,
    generation: 0,
    suppliedShareSum: 0,
    ticks: 0,
  };

  if (def.fail.some((c) => evaluateCondition(state, run, c).met)) {
    run.status = 'failed';
    run.endedTick = state.tick;
    return;
  }
  if (scenarioDay(run, state.tick) >= def.deadlineDays) {
    run.status = def.win.every((c) => evaluateCondition(state, run, c).met) ? 'won' : 'failed';
    run.endedTick = state.tick;
  }
}
```

`src/sim/state.ts`:

- Import `type ScenarioRun` from `./scenarios/types.ts`.
- `SimState`: `/** The running (or finished) scenario; absent in free play. */ scenario?: ScenarioRun;`
- `serializeState`: `...(state.scenario ? { scenario: structuredClone(state.scenario) } : {}),` (place after `rules:`).
- `deserializeState`: `if (save.scenario) state.scenario = structuredClone(save.scenario);`

`src/shared/types.ts`, `SaveGame`:

```ts
  /** Scenario run (absent in free play and older saves). */
  scenario?: SavedScenario;
```

and above `SaveGame`:

```ts
export interface SavedScenario {
  id: string;
  startTick: number;
  status: 'running' | 'won' | 'failed';
  endedTick?: number;
  samples: Record<string, number[]>;
  today: {
    deficitTicks: number;
    importedEnergy: number;
    renewable: number;
    generation: number;
    suppliedShareSum: number;
    ticks: number;
  };
}
```

In `deserializeState` cast: `state.scenario = structuredClone(save.scenario) as ScenarioRun;`.

`src/sim/tick.ts`: after `goalsStep(state);` add

```ts
if (state.scenario) scenarioStep(state, scenarioDef(state.scenario.id));
```

`scenarioDef` comes from Task 4 (`./scenarios/registry.ts`). To keep this task green on its own, create the registry file now with a placeholder-free minimal body and extend it in Task 4:

```ts
// src/sim/scenarios/registry.ts
import type { ScenarioDef, ScenarioId } from './types.ts';

const DEFS: Partial<Record<ScenarioId, ScenarioDef>> = {};

export function registerScenario(def: ScenarioDef): void {
  DEFS[def.id] = def;
}

export function scenarioDef(id: ScenarioId): ScenarioDef {
  const def = DEFS[id];
  if (!def) throw new Error(`unknown scenario ${id}`);
  return def;
}

export function scenarioDefs(): ScenarioDef[] {
  return Object.values(DEFS) as ScenarioDef[];
}
```

Check `lastEnergy` has `fuelCell` (it does, `state.ts:~585`).

- [ ] **Step 8: Run tests**

Run: `npx vitest run src/sim/scenarios src/sim/state.test.ts src/storage src/sim/tick.test.ts`
Expected: PASS. `pnpm typecheck` green.

- [ ] **Step 9: Commit**

```bash
pnpm format
git add src/sim/scenarios src/sim/state.ts src/sim/tick.ts src/shared/types.ts
git commit -m "feat(sim): scenario run state, conditions and per-day evaluation"
```

---

### Task 4: Shipped scenario definitions and engine init

**Files:**

- Create: `src/sim/scenarios/defs/island.ts`, `dunkelflaute.ts`, `oldTown.ts`, `stormSeason.ts`, `src/sim/scenarios/defs/index.ts`
- Modify: `src/sim/scenarios/registry.ts` (import `./defs/index.ts` so defs self-register), `src/sim/engine.ts:54-70` (`init` with `scenario`), `src/shared/messages.ts:24-33` (`scenario?: ScenarioId`)
- Test: `src/sim/scenarios/defs.test.ts`, `src/sim/engine.test.ts`

**Interfaces:**

- Consumes: stamp helpers, `applyRules`, `emptyRun`, `registerScenario`, `generateTerrain/generateWater/generateGeothermal/discoverGeothermalFields/generateForest` (engine already imports them).
- Produces: `startScenario(state, def)`, registered defs for all four ids, `SimCommand init.scenario`.

- [ ] **Step 1: Write the failing defs test**

```ts
// src/sim/scenarios/defs.test.ts
import { describe, expect, it } from 'vitest';
import { TICKS_PER_DAY } from '../../shared/constants.ts';
import { Terrain } from '../../shared/types.ts';
import { SimEngine } from '../engine.ts';
import { hasRoadAccess } from '../growth.ts';
import { serializeState } from '../state.ts';
import { scenarioDef } from './registry.ts';
import { SCENARIO_IDS } from './types.ts';

describe('shipped scenarios', () => {
  for (const id of SCENARIO_IDS) {
    it(`${id}: setup stamps a valid city and applies its rules`, () => {
      const def = scenarioDef(id);
      const engine = new SimEngine(0, 16);
      engine.applyCommand({ type: 'init', seed: 0, size: 16, scenario: id });
      const state = engine.state;
      expect(state.seed).toBe(def.seed);
      expect(state.size).toBe(def.size);
      expect(state.money).toBe(def.startingMoney);
      expect(state.disasterScale).toBe(def.disasterScale);
      expect(state.rules).toEqual(def.rules);
      expect(state.scenario).toMatchObject({ id, status: 'running', startTick: 0 });
      const { density, terrain } = state.layers;
      let buildings = 0;
      for (let i = 0; i < density.length; i++) {
        if (density[i] === 0) continue;
        buildings++;
        expect(terrain[i]).toBe(Terrain.Land);
        expect(hasRoadAccess(state, i)).toBe(true);
      }
      expect(buildings).toBeGreaterThan(0);
      expect(state.dirty.size).toBeGreaterThan(0);
    });
  }

  it('is deterministic: two inits and a day give the same save', () => {
    const run = () => {
      const engine = new SimEngine(0, 16);
      engine.applyCommand({ type: 'init', seed: 0, size: 16, scenario: 'dunkelflaute' });
      for (let i = 0; i < TICKS_PER_DAY / 4; i++) engine.tick();
      return JSON.stringify(serializeState(engine.state));
    };
    expect(run()).toBe(run());
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/sim/scenarios/defs.test.ts`
Expected: FAIL (`scenario` not on the init command / unknown scenario).

- [ ] **Step 3: Write the definitions**

Each def file follows one shape. Coordinates are chosen in a flat inland area; the setup must verify with the smoke test above, so after writing each def run the test and move tiles that land on water (print the map with `generateTerrain`+`generateWater` for the seed via a throwaway test if needed). Use helpers from a shared `defs/layout.ts`:

```ts
// src/sim/scenarios/defs/layout.ts
import { tileIndex } from '../../../shared/grid.ts';

/** Horizontal run of tiles on row y from x0 to x1 inclusive. */
export function row(size: number, y: number, x0: number, x1: number): number[] {
  const out: number[] = [];
  for (let x = x0; x <= x1; x++) out.push(tileIndex(x, y, size));
  return out;
}

/** Vertical run of tiles on column x from y0 to y1 inclusive. */
export function column(size: number, x: number, y0: number, y1: number): number[] {
  const out: number[] = [];
  for (let y = y0; y <= y1; y++) out.push(tileIndex(x, y, size));
  return out;
}

/** Filled rectangle, inclusive corners. */
export function rect(size: number, x0: number, y0: number, x1: number, y1: number): number[] {
  const out: number[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push(tileIndex(x, y, size));
  return out;
}
```

```ts
// src/sim/scenarios/defs/island.ts
import { BALANCE } from '../../../shared/constants.ts';
import { PlantType, Zone } from '../../../shared/types.ts';
import { stampBuildings, stampPlant, stampRoads, stampZone, withFreeBuild } from '../stamp.ts';
import type { ScenarioDef } from '../types.ts';
import { rect, row } from './layout.ts';

const cfg = BALANCE.scenarios.island;

/**
 * Island without an import link: a small town with one solar farm and
 * no way to import. Grow it to the target population and keep the last
 * month deficit-free.
 */
export const island: ScenarioDef = {
  id: 'island',
  seed: cfg.seed,
  size: cfg.size,
  startingMoney: cfg.startingMoney,
  disasterScale: 0,
  rules: { importCapacityFactor: 0, startSeason: 'spring' },
  deadlineDays: cfg.deadlineDays,
  win: [
    { kind: 'metric', metric: 'population', op: '>=', value: cfg.population },
    {
      kind: 'metric',
      metric: 'deficitTicks',
      op: '<=',
      value: 0,
      windowDays: cfg.deficitWindowDays,
    },
  ],
  fail: [{ kind: 'metric', metric: 'money', op: '<=', value: BALANCE.scenarios.bankruptMoney }],
  setup(state) {
    const s = state.size;
    withFreeBuild(state, () => {
      stampRoads(state, row(s, 20, 14, 30));
      stampRoads(state, row(s, 24, 14, 30));
      stampZone(state, rect(s, 14, 19, 30, 19), Zone.Residential);
      stampZone(state, rect(s, 14, 21, 30, 21), Zone.Residential);
      stampZone(state, rect(s, 14, 23, 22, 23), Zone.Commercial);
      stampZone(state, rect(s, 23, 23, 30, 23), Zone.Retail);
      stampBuildings(state, rect(s, 14, 19, 30, 19), 1);
      stampBuildings(state, rect(s, 16, 21, 28, 21), 1);
      stampBuildings(state, rect(s, 15, 23, 20, 23), 1);
      stampBuildings(state, rect(s, 24, 23, 27, 23), 1);
      stampPlant(state, rect(s, 32, 20, 32, 20)[0], PlantType.Solar);
    });
  },
};
```

```ts
// src/sim/scenarios/defs/dunkelflaute.ts
import { BALANCE } from '../../../shared/constants.ts';
import { PlantType, Zone } from '../../../shared/types.ts';
import { stampBuildings, stampPlant, stampRoads, stampZone, withFreeBuild } from '../stamp.ts';
import type { ScenarioDef } from '../types.ts';
import { column, rect, row } from './layout.ts';

const cfg = BALANCE.scenarios.dunkelflaute;

/**
 * Survive a winter Dunkelflaute: a solar-only town ten days before
 * winter. Keep the deficit ticks under the limit for the whole run and do
 * not lose residents.
 */
export const dunkelflaute: ScenarioDef = {
  id: 'dunkelflaute',
  seed: cfg.seed,
  size: cfg.size,
  startingMoney: cfg.startingMoney,
  disasterScale: 0,
  rules: { importCapacityFactor: 1, startSeason: 'autumn' },
  deadlineDays: cfg.deadlineDays,
  win: [
    { kind: 'metric', metric: 'deficitTicks', op: '<=', value: cfg.maxDeficitTicks },
    { kind: 'metric', metric: 'population', op: '>=', value: cfg.population },
  ],
  fail: [{ kind: 'metric', metric: 'money', op: '<=', value: BALANCE.scenarios.bankruptMoney }],
  setup(state) {
    const s = state.size;
    withFreeBuild(state, () => {
      stampRoads(state, row(s, 18, 12, 34));
      stampRoads(state, row(s, 22, 12, 34));
      stampRoads(state, row(s, 26, 12, 34));
      stampRoads(state, column(s, 23, 18, 26));
      stampZone(state, rect(s, 12, 17, 34, 17), Zone.Residential);
      stampZone(state, rect(s, 12, 19, 34, 19), Zone.Residential);
      stampZone(state, rect(s, 12, 21, 22, 21), Zone.Commercial);
      stampZone(state, rect(s, 24, 21, 34, 21), Zone.Retail);
      stampZone(state, rect(s, 12, 23, 34, 23), Zone.Residential);
      stampZone(state, rect(s, 12, 25, 34, 25), Zone.Commercial);
      stampBuildings(state, rect(s, 12, 17, 34, 17), 2);
      stampBuildings(state, rect(s, 12, 19, 22, 19), 2);
      stampBuildings(state, rect(s, 24, 19, 34, 19), 1);
      stampBuildings(state, rect(s, 12, 21, 22, 21), 1);
      stampBuildings(state, rect(s, 24, 21, 34, 21), 1);
      stampBuildings(state, rect(s, 12, 23, 34, 23), 1);
      stampBuildings(state, rect(s, 14, 25, 30, 25), 1);
      for (const tile of rect(s, 37, 18, 38, 24)) stampPlant(state, tile, PlantType.Solar);
      stampPlant(state, rect(s, 37, 26, 37, 26)[0], PlantType.Battery);
    });
  },
};
```

Add `population` to `BALANCE.scenarios.dunkelflaute` (the stamped population; measure it in the probe of Task 8 and set it to about 90 % of the start value).

```ts
// src/sim/scenarios/defs/oldTown.ts
import { BALANCE } from '../../../shared/constants.ts';
import { Zone } from '../../../shared/types.ts';
import { stampBuildings, stampRoads, stampZone, withFreeBuild } from '../stamp.ts';
import type { ScenarioDef } from '../types.ts';
import { column, rect, row } from './layout.ts';

const cfg = BALANCE.scenarios.oldTown;

/**
 * Electrify an old town: a dense, unpowered town with no plant and no
 * line. Supply nearly every building from mostly renewable sources.
 */
export const oldTown: ScenarioDef = {
  id: 'oldTown',
  seed: cfg.seed,
  size: cfg.size,
  startingMoney: cfg.startingMoney,
  disasterScale: 0,
  rules: { importCapacityFactor: 1, startSeason: 'spring' },
  deadlineDays: cfg.deadlineDays,
  win: [
    { kind: 'metric', metric: 'suppliedShare', op: '>=', value: cfg.suppliedShare },
    { kind: 'metric', metric: 'renewableShare', op: '>=', value: cfg.renewableShare },
  ],
  fail: [{ kind: 'metric', metric: 'money', op: '<=', value: BALANCE.scenarios.bankruptMoney }],
  setup(state) {
    const s = state.size;
    withFreeBuild(state, () => {
      for (const y of [16, 20, 24, 28]) stampRoads(state, row(s, y, 14, 32));
      for (const x of [14, 23, 32]) stampRoads(state, column(s, x, 16, 28));
      for (const y of [17, 19, 25, 27]) stampZone(state, rect(s, 15, y, 31, y), Zone.Residential);
      for (const y of [21, 23]) stampZone(state, rect(s, 15, y, 22, y), Zone.Commercial);
      for (const y of [21, 23]) stampZone(state, rect(s, 24, y, 31, y), Zone.Retail);
      for (const y of [17, 19, 25, 27]) {
        stampBuildings(state, rect(s, 15, y, 22, y), 3);
        stampBuildings(state, rect(s, 24, y, 31, y), 2);
      }
      for (const y of [21, 23])
        stampBuildings(
          state,
          rect(s, 15, y, 31, y).filter((t) => t % s !== 23),
          2,
        );
    });
  },
};
```

```ts
// src/sim/scenarios/defs/stormSeason.ts
import { BALANCE } from '../../../shared/constants.ts';
import { PlantType, Zone } from '../../../shared/types.ts';
import {
  stampBuildings,
  stampLines,
  stampPlant,
  stampRoads,
  stampZone,
  withFreeBuild,
} from '../stamp.ts';
import type { ScenarioDef } from '../types.ts';
import { column, rect, row } from './layout.ts';

const cfg = BALANCE.scenarios.stormSeason;

/**
 * Storm season with a fragile wind fleet: a town hanging on one long
 * line to a wind park, harsh disasters, autumn start. Earn stormProof
 * and keep the last month nearly deficit-free; a town half dark is lost.
 */
export const stormSeason: ScenarioDef = {
  id: 'stormSeason',
  seed: cfg.seed,
  size: cfg.size,
  startingMoney: cfg.startingMoney,
  disasterScale: cfg.disasterScale,
  rules: { importCapacityFactor: 1, startSeason: 'autumn' },
  deadlineDays: cfg.deadlineDays,
  win: [
    { kind: 'goal', id: 'stormProof' },
    {
      kind: 'metric',
      metric: 'deficitTicks',
      op: '<=',
      value: cfg.maxDeficitTicks,
      windowDays: cfg.deficitWindowDays,
    },
  ],
  fail: [
    { kind: 'metric', metric: 'money', op: '<=', value: BALANCE.scenarios.bankruptMoney },
    { kind: 'metric', metric: 'suppliedShare', op: '<=', value: cfg.minSuppliedShare },
  ],
  setup(state) {
    const s = state.size;
    withFreeBuild(state, () => {
      stampRoads(state, row(s, 30, 10, 26));
      stampRoads(state, row(s, 34, 10, 26));
      stampZone(state, rect(s, 10, 29, 26, 29), Zone.Residential);
      stampZone(state, rect(s, 10, 31, 26, 31), Zone.Residential);
      stampZone(state, rect(s, 10, 33, 18, 33), Zone.Commercial);
      stampZone(state, rect(s, 19, 33, 26, 33), Zone.Retail);
      stampBuildings(state, rect(s, 10, 29, 26, 29), 2);
      stampBuildings(state, rect(s, 10, 31, 26, 31), 1);
      stampBuildings(state, rect(s, 10, 33, 26, 33), 1);
      for (const tile of rect(s, 10, 10, 18, 10)) stampPlant(state, tile, PlantType.Wind);
      stampLines(state, column(s, 14, 11, 28));
    });
  },
};
```

Check the real `PlantType` member names (`grep -n 'export const PlantType' -A20 src/shared/types.ts`) and use them (`Solar`, `Wind`, `Battery` or whatever they are). Check whether `buildPowerLines` needs the line to touch a plant and a building (it does not reject otherwise; the stamp only needs to succeed).

```ts
// src/sim/scenarios/defs/index.ts
import { registerScenario } from '../registry.ts';
import { dunkelflaute } from './dunkelflaute.ts';
import { island } from './island.ts';
import { oldTown } from './oldTown.ts';
import { stormSeason } from './stormSeason.ts';

for (const def of [island, dunkelflaute, oldTown, stormSeason]) registerScenario(def);
```

To avoid an import cycle (`registry` → `defs/index` → `registry`), do NOT import `defs/index.ts` from `registry.ts`. Instead add `import './scenarios/defs/index.ts';` at the top of `src/sim/engine.ts` and of `src/sim/tick.ts` (side-effect import; both files run in the worker and in tests).

- [ ] **Step 4: Add `startScenario` and the init command**

```ts
// src/sim/scenarios/start.ts
import type { SimState } from '../state.ts';
import { applyRules } from './rules.ts';
import { emptyRun, type ScenarioDef } from './types.ts';

/**
 * Turn a generated, empty state into the scenario's starting city.
 * Call after terrain/water/forest generation and before the first tick.
 */
export function startScenario(state: SimState, def: ScenarioDef): void {
  state.disasterScale = def.disasterScale;
  applyRules(state, def.rules);
  def.setup(state);
  state.gridVersion++;
  state.statsDirty = true;
  state.scenario = emptyRun(def.id, state.tick);
}
```

`src/shared/messages.ts` `init`: add `/** Start a shipped scenario; seed/size/startingMoney/disasterScale are taken from its definition. */ scenario?: ScenarioId;` with `import type { ScenarioId } from '../sim/scenarios/types.ts';` (shared → sim type-only import; if lint forbids it, move `SCENARIO_IDS`/`ScenarioId` into `src/shared/types.ts` and re-export from `scenarios/types.ts`).

`src/sim/engine.ts` `case 'init'`:

```ts
if (command.save) {
  this.state = deserializeState(command.save);
} else if (command.scenario) {
  const def = scenarioDef(command.scenario);
  this.state = createSimState(def.seed, def.size, def.startingMoney);
  generateTerrain(this.state);
  generateWater(this.state);
  generateGeothermal(this.state);
  discoverGeothermalFields(this.state);
  generateForest(this.state);
  startScenario(this.state, def);
} else {
  /* unchanged */
}
```

- [ ] **Step 5: Run the defs test, fix tile positions until every scenario passes**

Run: `npx vitest run src/sim/scenarios/defs.test.ts`
Expected: PASS for all four. If a stamp throws on water, print `state.layers.terrain` as a grid for that seed in a throwaway test and shift the layout; keep the probe out of git.

- [ ] **Step 6: Engine test**

Append to `src/sim/engine.test.ts`:

```ts
it('init with a scenario ignores seed and size from the command', () => {
  const engine = new SimEngine(7, 16);
  engine.applyCommand({ type: 'init', seed: 7, size: 16, scenario: 'island' });
  expect(engine.state.size).toBe(BALANCE.scenarios.island.size);
  expect(engine.state.scenario?.id).toBe('island');
});
```

Run: `npx vitest run src/sim/engine.test.ts src/sim/scenarios`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
pnpm format
git add src/sim/scenarios src/sim/engine.ts src/sim/engine.test.ts src/sim/tick.ts src/shared/messages.ts src/shared/constants.ts
git commit -m "feat(sim): four shipped scenarios and scenario init"
```

---

### Task 5: Stats, bridge and new-game plumbing

**Files:**

- Modify: `src/shared/types.ts` (`GlobalStats.scenario?`, `ScenarioStats`, `ConditionStatus`)
- Modify: `src/sim/tick.ts` `buildStats` (add `scenario`)
- Create: `src/sim/scenarios/stats.ts`
- Modify: `src/ui/newGame.ts` (`NewGameOptions.scenario?`), `src/ui/useSimBridge.ts:38-46,110-118` (forward `scenario`), `src/ui/App.tsx` boot (pass `options.scenario`)
- Test: `src/sim/scenarios/stats.test.ts`, `src/ui/newGame.test.ts`

**Interfaces:**

- Produces:

```ts
export interface ConditionStatus { role: 'win' | 'fail'; kind: 'goal' | 'metric'; label: string; met: boolean; current: number; target: number; }
export interface ScenarioStats { id: string; status: 'running' | 'won' | 'failed'; day: number; deadlineDays: number; endedDay?: number; conditions: ConditionStatus[]; }
GlobalStats.scenario?: ScenarioStats;
NewGameOptions.scenario?: ScenarioId;   // when set, other options are ignored
SimBridgeOptions.scenario?: ScenarioId;
```

- [ ] **Step 1: Failing stats test**

```ts
// src/sim/scenarios/stats.test.ts
import { describe, expect, it } from 'vitest';
import { SimEngine } from '../engine.ts';
import { buildStats } from '../tick.ts';
import { scenarioDef } from './registry.ts';

describe('scenario stats', () => {
  it('free play has no scenario block', () => {
    const engine = new SimEngine(1, 16);
    engine.applyCommand({ type: 'init', seed: 1, size: 16 });
    expect(buildStats(engine.state).scenario).toBeUndefined();
  });

  it('a running scenario reports day, deadline and one row per condition', () => {
    const engine = new SimEngine(1, 16);
    engine.applyCommand({ type: 'init', seed: 1, size: 16, scenario: 'stormSeason' });
    const def = scenarioDef('stormSeason');
    const s = buildStats(engine.state).scenario!;
    expect(s).toMatchObject({
      id: 'stormSeason',
      status: 'running',
      day: 0,
      deadlineDays: def.deadlineDays,
    });
    expect(s.conditions).toHaveLength(def.win.length + def.fail.length);
    expect(s.conditions[0]).toMatchObject({
      role: 'win',
      kind: 'goal',
      label: 'goal.stormProof.title',
      met: false,
    });
    const money = s.conditions.find(
      (c) => c.role === 'fail' && c.label === 'scenario.condition.money',
    );
    expect(money).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run src/sim/scenarios/stats.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/sim/scenarios/stats.ts
import type { ConditionStatus, ScenarioStats } from '../../shared/types.ts';
import type { SimState } from '../state.ts';
import { evaluateCondition } from './conditions.ts';
import { scenarioDef } from './registry.ts';
import { scenarioDay } from './step.ts';
import type { Condition } from './types.ts';

function labelFor(c: Condition): string {
  return c.kind === 'goal' ? `goal.${c.id}.title` : `scenario.condition.${c.metric}`;
}

export function scenarioStats(state: SimState): ScenarioStats | undefined {
  const run = state.scenario;
  if (!run) return undefined;
  const def = scenarioDef(run.id);
  const rows = (role: 'win' | 'fail', list: Condition[]): ConditionStatus[] =>
    list.map((c) => ({
      role,
      kind: c.kind,
      label: labelFor(c),
      ...evaluateCondition(state, run, c),
    }));
  return {
    id: run.id,
    status: run.status,
    day: scenarioDay(run, state.tick),
    deadlineDays: def.deadlineDays,
    ...(run.endedTick !== undefined ? { endedDay: scenarioDay(run, run.endedTick) } : {}),
    conditions: [...rows('win', def.win), ...rows('fail', def.fail)],
  };
}
```

`src/shared/types.ts`: add `ConditionStatus`, `ScenarioStats` as in Interfaces and `scenario?: ScenarioStats;` to `GlobalStats` after `goals`.

`src/sim/tick.ts` `buildStats`: after `goals: goalStates(state),` add `...(state.scenario ? { scenario: scenarioStats(state) } : {}),`.

`src/ui/newGame.ts`: add `scenario?: ScenarioId;` to `NewGameOptions` (doc: "Start this scenario instead of a free city; the other options are ignored."), and in `readPendingNewGame` return `...(SCENARIO_IDS.includes(parsed.scenario as ScenarioId) ? { scenario: parsed.scenario as ScenarioId } : {})`. Add `export function storePendingScenario(id: ScenarioId): void { storePendingNewGame({ ...DEFAULT_NEW_GAME, scenario: id }); }`.

`src/ui/useSimBridge.ts`: `SimBridgeOptions.scenario?: ScenarioId;`, and in the `init` literal add `...(options.scenario ? { scenario: options.scenario } : {}),`.

`src/ui/App.tsx`: where `useSimBridge` is called with `boot.options`, also pass `scenario: options.scenario` (only when `save === null`, same as the other new-game options).

- [ ] **Step 4: newGame unit test** (append to `src/ui/newGame.test.ts`, following its existing localStorage setup):

```ts
it('stores and consumes a pending scenario', () => {
  storePendingScenario('island');
  expect(consumePendingNewGame().scenario).toBe('island');
});

it('drops an unknown scenario id', () => {
  localStorage.setItem('voltopia.pendingNewGame', JSON.stringify({ scenario: 'nope' }));
  expect(consumePendingNewGame().scenario).toBeUndefined();
});
```

If `consumePendingNewGame` caches per load, reset the module between tests the way the existing tests in that file do (`vi.resetModules()` + dynamic import).

- [ ] **Step 5: Run**

Run: `npx vitest run src/sim/scenarios src/ui/newGame.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
pnpm format
git add src/shared/types.ts src/sim/tick.ts src/sim/scenarios/stats.ts src/sim/scenarios/stats.test.ts src/ui/newGame.ts src/ui/newGame.test.ts src/ui/useSimBridge.ts src/ui/App.tsx
git commit -m "feat: publish scenario status in GlobalStats and start scenarios through the new-game path"
```

---

### Task 6: UI — scenarios page, objectives panel, end screen, i18n

**Files:**

- Create: `src/ui/ScenariosPage.tsx`, `src/ui/ScenarioPanel.tsx`, `src/ui/scenarioResults.ts`
- Modify: `src/ui/WinScreen.tsx` → rename to `src/ui/EndScreen.tsx` (keep the free-play all-goals behaviour, add the scenario variant), `src/ui/App.tsx` (page type, buttons, panel swap), `src/ui/TimeControls.tsx` (add an "open scenarios" button next to new game, testid `open-scenarios`), `src/ui/i18n.tsx` (EN + DE), `src/ui/app.css`
- Test: `src/ui/scenarioResults.test.ts`

**Interfaces:**

- Consumes: `GlobalStats.scenario`, `storePendingScenario`, `scenarioDefs()` metadata (deadline, condition lists) — the UI may import `src/sim/scenarios/registry.ts` for static data (it is DOM-free and pulls no three.js); `src/ui/newGame.ts` already imports `src/shared`.
- Produces: `readBestResult(id): { status; day } | null`, `recordResult(id, status, day)`, keys `scenario.*`.

- [ ] **Step 1: Results store with a failing test**

```ts
// src/ui/scenarioResults.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { readBestResult, recordResult } from './scenarioResults.ts';

describe('scenario results', () => {
  beforeEach(() => localStorage.clear());
  it('keeps the best result: a win beats a loss, an earlier win beats a later one', () => {
    expect(readBestResult('island')).toBeNull();
    recordResult('island', 'failed', 40);
    expect(readBestResult('island')).toEqual({ status: 'failed', day: 40 });
    recordResult('island', 'won', 90);
    recordResult('island', 'failed', 10);
    expect(readBestResult('island')).toEqual({ status: 'won', day: 90 });
    recordResult('island', 'won', 80);
    expect(readBestResult('island')).toEqual({ status: 'won', day: 80 });
  });
});
```

```ts
// src/ui/scenarioResults.ts
export interface ScenarioResult {
  status: 'won' | 'failed';
  day: number;
}

const key = (id: string) => `voltopia.scenario.${id}`;

export function readBestResult(id: string): ScenarioResult | null {
  try {
    const raw = localStorage.getItem(key(id));
    return raw ? (JSON.parse(raw) as ScenarioResult) : null;
  } catch {
    return null;
  }
}

/** A win always beats a loss; among wins the earlier day wins. */
export function recordResult(id: string, status: 'won' | 'failed', day: number): void {
  const best = readBestResult(id);
  const better =
    !best ||
    (status === 'won' && best.status === 'failed') ||
    (status === best.status && status === 'won' && day < best.day) ||
    (status === best.status && status === 'failed' && day > best.day);
  if (!better) return;
  try {
    localStorage.setItem(key(id), JSON.stringify({ status, day }));
  } catch {
    // best effort only
  }
}
```

Run: `npx vitest run src/ui/scenarioResults.test.ts` → PASS (vitest env for `src/ui` tests is jsdom; check `vitest.config` `environmentMatchGlobs` and follow the pattern of `src/ui/newGame.test.ts`).

- [ ] **Step 2: i18n keys** (add to `en` and `de` in `src/ui/i18n.tsx`):

```ts
  'scenarios.title': 'Scenarios',
  'scenarios.open': 'Scenarios',
  'scenarios.start': 'Start scenario',
  'scenarios.deadline': 'Deadline: {n} days',
  'scenarios.best.won': 'Best: won on day {n}',
  'scenarios.best.failed': 'Best: lost on day {n}',
  'scenarios.best.none': 'Not played yet',
  'scenarios.win': 'Win',
  'scenarios.fail': 'Lose if',
  'scenario.island.title': 'Island without an import link',
  'scenario.island.teaser': 'No substation can bring power in. Grow the town and keep the last month free of blackouts.',
  'scenario.dunkelflaute.title': 'Survive a winter Dunkelflaute',
  'scenario.dunkelflaute.teaser': 'A solar town ten days before winter. Storage, wind and biogas decide who keeps the lights on.',
  'scenario.oldTown.title': 'Electrify an old town',
  'scenario.oldTown.teaser': 'A dense town with no plant and no line. Supply it, mostly from renewables.',
  'scenario.stormSeason.title': 'Storm season',
  'scenario.stormSeason.teaser': 'A wind fleet on one long line, harsh weather ahead. Harden the grid and ride it out.',
  'scenario.condition.population': 'Residents',
  'scenario.condition.money': 'Funds',
  'scenario.condition.deficitTicks': 'Deficit ticks',
  'scenario.condition.importedEnergy': 'Imported energy',
  'scenario.condition.renewableShare': 'Renewable share',
  'scenario.condition.suppliedShare': 'Buildings supplied',
  'scenario.panel.day': 'Day {day} of {total}',
  'scenario.status.running': 'Running',
  'scenario.status.won': 'Won',
  'scenario.status.failed': 'Lost',
  'scenario.end.won.title': 'Scenario won',
  'scenario.end.failed.title': 'Scenario lost',
  'scenario.end.day': 'Ended on day {n}',
  'scenario.end.continue': 'Keep playing',
  'scenario.end.retry': 'Retry',
  'scenario.end.scenarios': 'Scenarios',
```

German:

```ts
  'scenarios.title': 'Szenarien',
  'scenarios.open': 'Szenarien',
  'scenarios.start': 'Szenario starten',
  'scenarios.deadline': 'Frist: {n} Tage',
  'scenarios.best.won': 'Bestes Ergebnis: gewonnen an Tag {n}',
  'scenarios.best.failed': 'Bestes Ergebnis: verloren an Tag {n}',
  'scenarios.best.none': 'Noch nicht gespielt',
  'scenarios.win': 'Gewinnen',
  'scenarios.fail': 'Verloren, wenn',
  'scenario.island.title': 'Insel ohne Importleitung',
  'scenario.island.teaser': 'Kein Umspannwerk bringt Strom herein. Lass die Stadt wachsen und halte den letzten Monat frei von Blackouts.',
  'scenario.dunkelflaute.title': 'Eine Winter-Dunkelflaute überstehen',
  'scenario.dunkelflaute.teaser': 'Eine Solarstadt zehn Tage vor dem Winter. Speicher, Wind und Biogas entscheiden, wer das Licht anbehält.',
  'scenario.oldTown.title': 'Eine Altstadt elektrifizieren',
  'scenario.oldTown.teaser': 'Eine dichte Stadt ohne Kraftwerk und Leitung. Versorge sie, überwiegend erneuerbar.',
  'scenario.stormSeason.title': 'Sturmsaison',
  'scenario.stormSeason.teaser': 'Ein Windpark an einer langen Leitung, raues Wetter voraus. Härte das Netz und steh es durch.',
  'scenario.condition.population': 'Einwohner',
  'scenario.condition.money': 'Kasse',
  'scenario.condition.deficitTicks': 'Defizit-Ticks',
  'scenario.condition.importedEnergy': 'Importierte Energie',
  'scenario.condition.renewableShare': 'Erneuerbarer Anteil',
  'scenario.condition.suppliedShare': 'Versorgte Gebäude',
  'scenario.panel.day': 'Tag {day} von {total}',
  'scenario.status.running': 'Läuft',
  'scenario.status.won': 'Gewonnen',
  'scenario.status.failed': 'Verloren',
  'scenario.end.won.title': 'Szenario gewonnen',
  'scenario.end.failed.title': 'Szenario verloren',
  'scenario.end.day': 'Beendet an Tag {n}',
  'scenario.end.continue': 'Weiterspielen',
  'scenario.end.retry': 'Nochmal',
  'scenario.end.scenarios': 'Szenarien',
```

Check how placeholders are written in this file (`{n}` is used by `hud.day`); follow it.

- [ ] **Step 3: ScenariosPage**

```tsx
// src/ui/ScenariosPage.tsx
import { scenarioDefs } from '../sim/scenarios/registry.ts';
import type { Condition, ScenarioId } from '../sim/scenarios/types.ts';
import { useI18n, type TranslationKey } from './i18n.tsx';
import { Modal } from './Modal.tsx';
import { storePendingScenario } from './newGame.ts';
import { readBestResult } from './scenarioResults.ts';

function conditionKey(c: Condition): TranslationKey {
  return (
    c.kind === 'goal' ? `goal.${c.id}.title` : `scenario.condition.${c.metric}`
  ) as TranslationKey;
}

function conditionText(
  c: Condition,
  t: (k: TranslationKey, v?: Record<string, number | string>) => string,
): string {
  if (c.kind === 'goal') return t(conditionKey(c));
  const value = c.metric.endsWith('Share') ? `${Math.round(c.value * 100)}%` : String(c.value);
  const window = c.windowDays ? ` (${c.windowDays} d)` : '';
  return `${t(conditionKey(c))} ${c.op} ${value}${window}`;
}

export function ScenariosPage({
  onStart,
  onClose,
}: {
  onStart: (id: ScenarioId) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <Modal title={t('scenarios.title')} onClose={onClose} testId="scenarios-page">
      {scenarioDefs().map((def) => {
        const best = readBestResult(def.id);
        return (
          <section key={def.id} className="scenario-card" data-testid={`scenario-${def.id}`}>
            <h3>{t(`scenario.${def.id}.title` as TranslationKey)}</h3>
            <p>{t(`scenario.${def.id}.teaser` as TranslationKey)}</p>
            <p className="scenario-meta">
              {t('scenarios.deadline', { n: def.deadlineDays })} ·{' '}
              {best
                ? t(`scenarios.best.${best.status}` as TranslationKey, { n: best.day })
                : t('scenarios.best.none')}
            </p>
            <p>
              <strong>{t('scenarios.win')}:</strong>{' '}
              {def.win.map((c) => conditionText(c, t)).join(' · ')}
            </p>
            <p>
              <strong>{t('scenarios.fail')}:</strong>{' '}
              {def.fail.map((c) => conditionText(c, t)).join(' · ')}
            </p>
            <button
              type="button"
              className="primary"
              data-testid={`start-scenario-${def.id}`}
              onClick={() => onStart(def.id)}
            >
              {t('scenarios.start')}
            </button>
          </section>
        );
      })}
    </Modal>
  );
}
```

Check the signature of `t` in `useI18n` and match it (the second parameter type).

- [ ] **Step 4: ScenarioPanel**

```tsx
// src/ui/ScenarioPanel.tsx
import type { ScenarioStats } from '../shared/types.ts';
import { useI18n, type TranslationKey } from './i18n.tsx';

function fmt(kind: 'goal' | 'metric', label: string, value: number): string {
  if (kind === 'goal') return value >= 1 ? '✓' : '–';
  if (label.endsWith('Share')) return `${Math.round(value * 100)}%`;
  return String(Math.round(value));
}

export function ScenarioPanel({ scenario }: { scenario: ScenarioStats }) {
  const { t } = useI18n();
  const rows = (role: 'win' | 'fail') => scenario.conditions.filter((c) => c.role === role);
  return (
    <div className="hud-plate scenario-panel" data-testid="scenario-panel">
      <div className="scenario-head">
        <strong>{t(`scenario.${scenario.id}.title` as TranslationKey)}</strong>
        <span data-testid="scenario-day">
          {t('scenario.panel.day', {
            day: Math.min(scenario.day, scenario.deadlineDays),
            total: scenario.deadlineDays,
          })}
        </span>
        <span className={`scenario-status scenario-status-${scenario.status}`}>
          {t(`scenario.status.${scenario.status}` as TranslationKey)}
        </span>
      </div>
      <ul className="scenario-list">
        {rows('win').map((c, i) => (
          <li key={`w${i}`} className={c.met ? 'met' : ''}>
            <span>{c.met ? '✓' : '○'}</span> {t(c.label as TranslationKey)}:{' '}
            {fmt(c.kind, c.label, c.current)} / {fmt(c.kind, c.label, c.target)}
          </li>
        ))}
      </ul>
      <p className="scenario-fail-head">{t('scenarios.fail')}</p>
      <ul className="scenario-list scenario-fail">
        {rows('fail').map((c, i) => (
          <li key={`f${i}`} className={c.met ? 'met' : ''}>
            {t(c.label as TranslationKey)}: {fmt(c.kind, c.label, c.current)} (
            {fmt(c.kind, c.label, c.target)})
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 5: EndScreen**

Rename `src/ui/WinScreen.tsx` to `src/ui/EndScreen.tsx` with `git mv`. Keep the existing component body as the free-play branch and add the scenario branch:

```tsx
export function EndScreen({
  stats,
  onCelebrate,
  onRetry,
  onScenarios,
}: {
  stats: GlobalStats;
  onCelebrate?: () => void;
  onRetry: (id: ScenarioId) => void;
  onScenarios: () => void;
}) {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);
  const scenario = stats.scenario;
  const scenarioEnded = scenario !== undefined && scenario.status !== 'running';
  const allDone =
    scenario === undefined && stats.goals.length > 0 && stats.goals.every((g) => g.achieved);
  const shownKey = scenarioEnded
    ? `voltopia.endShown.${stats.seed}.${scenario.id}`
    : `voltopia.winShown.${stats.seed}`;

  useEffect(() => {
    if (!(allDone || scenarioEnded) || visible) return;
    try {
      if (localStorage.getItem(shownKey) === '1') return;
      localStorage.setItem(shownKey, '1');
    } catch {
      // storage unavailable: still show, just maybe twice
    }
    if (scenarioEnded)
      recordResult(
        scenario.id,
        scenario.status as 'won' | 'failed',
        scenario.endedDay ?? scenario.day,
      );
    setVisible(true);
    if (allDone || scenario?.status === 'won') onCelebrate?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allDone, scenarioEnded, shownKey]);

  if (!visible) return null;
  if (scenarioEnded) {
    return (
      <div className="win-backdrop" data-testid="end-screen">
        <div className="win-card">
          <div className="win-emoji">{scenario.status === 'won' ? '🏆⚡🎉' : '🌑'}</div>
          <h2>{t(`scenario.end.${scenario.status}.title` as TranslationKey)}</h2>
          <p>{t('scenario.end.day', { n: scenario.endedDay ?? scenario.day })}</p>
          <ul className="scenario-list">
            {scenario.conditions.map((c, i) => (
              <li key={i} className={c.met ? 'met' : ''}>
                {c.role === 'fail' ? '⚠ ' : c.met ? '✓ ' : '○ '}
                {t(c.label as TranslationKey)}:{' '}
                {Math.round(c.current * (c.label.endsWith('Share') ? 100 : 1))}
              </li>
            ))}
          </ul>
          <div className="option-row">
            <button
              type="button"
              className="primary"
              data-testid="end-continue"
              onClick={() => setVisible(false)}
            >
              {t('scenario.end.continue')}
            </button>
            <button
              type="button"
              data-testid="end-retry"
              onClick={() => onRetry(scenario.id as ScenarioId)}
            >
              {t('scenario.end.retry')}
            </button>
            <button
              type="button"
              data-testid="end-scenarios"
              onClick={() => {
                setVisible(false);
                onScenarios();
              }}
            >
              {t('scenario.end.scenarios')}
            </button>
          </div>
        </div>
      </div>
    );
  }
  /* existing free-play markup unchanged (data-testid="win-screen") */
}
```

The retry key: a fresh init resets `startTick` to 0 and the seed is the same, so the shown-key must not survive a retry. In `onRetry` (App) remove `voltopia.endShown.<seed>.<id>` before reloading.

- [ ] **Step 6: App wiring**

In `src/ui/App.tsx`:

- Page union: add `'scenarios'`.
- `TimeControls`: add prop `onScenarios` and a button `data-testid="open-scenarios"` beside the new-game button (label `t('scenarios.open')`).
- Replace the `GoalsPanel` block with:

```tsx
{
  stats && stats.scenario ? (
    <ScenarioPanel scenario={stats.scenario} />
  ) : (
    stats && (
      <GoalsPanel
        goals={stats.goals}
        services={stats.services}
        onAchievement={() => sound.play('achievement')}
      />
    )
  );
}
```

- Add:

```tsx
const startScenario = useCallback(
  (id: ScenarioId) => {
    try {
      localStorage.removeItem(`voltopia.endShown.${stats?.seed ?? 0}.${id}`);
    } catch {
      /* best effort */
    }
    storePendingScenario(id);
    void storage.clear().then(() => window.location.reload());
  },
  [stats?.seed],
);
```

- Render `{page === 'scenarios' && <ScenariosPage onStart={startScenario} onClose={() => setPage(null)} />}` and replace `<WinScreen …/>` with `<EndScreen stats={stats} onCelebrate={() => sound.play('achievement')} onRetry={startScenario} onScenarios={() => setPage('scenarios')} />`.
- Tutorial: `showTutorial` must stay false when `boot.options.scenario` is set (`save === null && !options.scenario && !isTutorialDone()`).

- [ ] **Step 7: CSS** (append to `src/ui/app.css`, reuse existing plate variables):

```css
.scenario-panel {
  max-width: 20rem;
}
.scenario-head {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem 0.8rem;
  align-items: baseline;
}
.scenario-status-won {
  color: var(--ok, #7fd37f);
}
.scenario-status-failed {
  color: var(--bad, #e06b6b);
}
.scenario-list {
  list-style: none;
  margin: 0.3rem 0;
  padding: 0;
  font-size: 0.85rem;
}
.scenario-list li.met {
  opacity: 0.85;
}
.scenario-fail li.met {
  color: var(--bad, #e06b6b);
}
.scenario-fail-head {
  margin: 0.4rem 0 0;
  font-size: 0.75rem;
  opacity: 0.7;
}
.scenario-card {
  border-top: 1px solid rgba(255, 255, 255, 0.12);
  padding-top: 0.6rem;
}
.scenario-meta {
  opacity: 0.75;
  font-size: 0.85rem;
}
```

Check the real CSS variable names in `app.css` (`grep -n '^  --' src/ui/app.css | head`) and use them.

- [ ] **Step 8: Verify**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: green. Also `grep -c "scenario\." src/ui/i18n.tsx` shows every key twice (EN+DE); the `i18n` test (if any) checks key parity.

- [ ] **Step 9: Commit**

```bash
pnpm format
git add src/ui
git commit -m "feat(ui): scenarios page, objectives panel and end screen"
```

---

### Task 7: Agent tools and docs

**Files:**

- Modify: `src/agent/tools.ts` (`list_scenarios`, `start_scenario`, `scenario` block in `get_game_overview`, `ToolContext.startScenario`), `src/ui/useAgentTools.ts` (or wherever `useAgentTools` builds the context — grep `startNewCity`), `src/ui/App.tsx` (pass `startScenario`), `docs/agent-tools.md`
- Test: `src/agent/tools.test.ts`

**Interfaces:**

- Consumes: `scenarioDefs()`, `GlobalStats.scenario`, `storePendingScenario`.
- Produces: tools `list_scenarios` (read), `start_scenario { id }` (consequential), overview field `scenario`.

- [ ] **Step 1: Failing tests** (append to `src/agent/tools.test.ts` using its existing harness helpers; grep how `start_new_city` is tested and mirror it):

```ts
it('list_scenarios names every shipped scenario with its conditions', async () => {
  const result = await call('list_scenarios', {});
  expect(result.scenarios.map((s: { id: string }) => s.id)).toEqual([
    'island',
    'dunkelflaute',
    'oldTown',
    'stormSeason',
  ]);
  expect(result.scenarios[0].win.length).toBeGreaterThan(0);
});

it('start_scenario hands the id to the host and rejects unknown ids', async () => {
  await call('start_scenario', { id: 'island' });
  expect(ctx.startScenario).toHaveBeenCalledWith('island');
  await expect(call('start_scenario', { id: 'nope' })).rejects.toThrow();
});

it('get_game_overview carries the scenario block when one runs', async () => {
  engine.applyCommand({ type: 'init', seed: 1, size: 16, scenario: 'island' });
  const overview = await call('get_game_overview', {});
  expect(overview.scenario).toMatchObject({ id: 'island', status: 'running', day: 0 });
  expect(overview.scenario.conditions[0]).toHaveProperty('met');
});
```

- [ ] **Step 2: Implement**

`ToolContext`: add `startScenario(id: ScenarioId): void;`. In `get_game_overview` after `goals:` add

```ts
          ...(s.scenario
            ? {
                scenario: {
                  id: s.scenario.id,
                  title: englishText(`scenario.${s.scenario.id}.title` as TranslationKey),
                  status: s.scenario.status,
                  day: s.scenario.day,
                  deadlineDays: s.scenario.deadlineDays,
                  conditions: s.scenario.conditions.map((c) => ({
                    role: c.role,
                    name: englishText(c.label as TranslationKey),
                    met: c.met,
                    current: round(c.current, 3),
                    target: c.target,
                  })),
                },
              }
            : {}),
```

Tools:

```ts
    {
      name: 'list_scenarios',
      description: 'The shipped scenarios: id, title, teaser, deadline in days, win conditions (all must hold at the deadline) and fail conditions (any one ends the run).',
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        return {
          scenarios: scenarioDefs().map((def) => ({
            id: def.id,
            title: englishText(`scenario.${def.id}.title` as TranslationKey),
            teaser: englishText(`scenario.${def.id}.teaser` as TranslationKey),
            deadlineDays: def.deadlineDays,
            size: def.size,
            startingMoney: def.startingMoney,
            win: def.win,
            fail: def.fail,
          })),
        };
      },
    },
    {
      name: 'start_scenario',
      description: 'Abandon the current city and start a shipped scenario (the page reloads; the autosave is replaced). See list_scenarios.',
      inputSchema: { type: 'object', properties: { id: { type: 'string', enum: [...SCENARIO_IDS] } }, required: ['id'] },
      annotations: { consequentialHint: true },
      async execute(input) {
        const id = readEnum(input, 'id', SCENARIO_IDS);
        ctx.startScenario(id);
        return { ok: true, scenario: id };
      },
    },
```

Check `readEnum`'s signature (it takes a fallback; pass none and make sure a missing id throws `ToolInputError`).

Host side: where `startNewCity` is supplied to the tool context (grep `startNewCity` in `src/ui`), add `startScenario: (id) => startScenario(id)` from App (Task 6's callback), threading it through `useAgentTools`.

- [ ] **Step 3: docs/agent-tools.md**

Add two rows to the table and extend the `get_game_overview` row with "`scenario` (id, title, status, day, deadlineDays, conditions[] with role/name/met/current/target) when a scenario runs":

```
| `list_scenarios`          | read  | Shipped scenarios: id, title, teaser, deadline, win and fail conditions |
| `start_scenario`          | write | Abandon the city and start a scenario by id (page reloads) |
```

- [ ] **Step 4: Run**

Run: `npx vitest run src/agent && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add src/agent src/ui docs/agent-tools.md
git commit -m "feat(agent): list and start scenarios, report scenario status"
```

---

### Task 8: Balance probe and tuning

**Files:**

- Temporary: `src/sim/zz-scenario-probe.test.ts` (deleted before commit)
- Modify: `src/shared/constants.ts` (`BALANCE.scenarios.*`), `docs/idea.md` (scenarios entry → done with probe numbers), `docs/plan.md`

- [ ] **Step 1: Write the probe**

```ts
// src/sim/zz-scenario-probe.test.ts  (temporary, do not commit)
import { it } from 'vitest';
import { TICKS_PER_DAY } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { PlantType } from '../shared/types.ts';
import { SimEngine } from './engine.ts';
import { scenarioDef } from './scenarios/registry.ts';
import { countPopulationAndJobs } from './state.ts';
import { SCENARIO_IDS, type ScenarioId } from './scenarios/types.ts';

function run(id: ScenarioId, plan: (e: SimEngine) => void, days: number) {
  const e = new SimEngine(0, 16);
  e.applyCommand({ type: 'init', seed: 0, size: 16, scenario: id });
  plan(e);
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < TICKS_PER_DAY; i++) e.tick();
    const s = e.state.scenario!;
    if (d % 10 === 9 || s.status !== 'running') {
      console.log(
        id,
        'day',
        d + 1,
        s.status,
        'pop',
        countPopulationAndJobs(e.state).population,
        'money',
        Math.round(e.state.money),
        'deficit',
        s.samples.deficitTicks.at(-1),
        'supplied',
        s.samples.suppliedShare.at(-1)?.toFixed(2),
      );
    }
    if (s.status !== 'running') break;
  }
  return e.state.scenario!.status;
}

for (const id of SCENARIO_IDS) {
  it(`${id} ignored`, () => {
    console.log(
      'IGNORED',
      id,
      run(id, () => {}, scenarioDef(id).deadlineDays),
    );
  }, 600_000);
}

it('dunkelflaute sensible plan', () => {
  const s = 48;
  const at = (x: number, y: number) => tileIndex(x, y, s);
  console.log(
    'PLANNED dunkelflaute',
    run(
      'dunkelflaute',
      (e) => {
        for (const [x, y] of [
          [40, 18],
          [40, 20],
          [40, 22],
          [40, 24],
        ])
          e.applyCommand({ type: 'placePlant', tile: at(x, y), plant: PlantType.Wind });
        for (const [x, y] of [
          [38, 28],
          [39, 28],
        ])
          e.applyCommand({ type: 'placePlant', tile: at(x, y), plant: PlantType.Battery });
        e.applyCommand({ type: 'placePlant', tile: at(40, 28), plant: PlantType.Biogas });
      },
      scenarioDef('dunkelflaute').deadlineDays,
    ),
    600_000,
  );
});
```

Write one "sensible plan" test per scenario in the same style (island: solar + batteries + biogas; oldTown: two solar farms, a line, a substation; stormSeason: a second line, a battery, a fire station).

- [ ] **Step 2: Run the probe**

Run: `npx vitest run src/sim/zz-scenario-probe.test.ts --reporter=verbose 2>&1 | grep -E 'IGNORED|PLANNED|day'`
A full run is 4 × deadline days × ~1.5 s; run scenarios one at a time with `-t island` etc. if needed.

- [ ] **Step 3: Tune**

Adjust `BALANCE.scenarios.*` until each ignored run ends `failed` and each planned run ends `won` with some slack (deficit limit about 1.5 × the planned run's figure, population target about 80 % of the planned run's). Set `dunkelflaute.population` to about 90 % of the stamped start population printed on day 10. Rerun the defs smoke test after any layout change.

- [ ] **Step 4: Record and clean up**

In `docs/idea.md` move the "Scenarios / campaign" bullet to the done list in the style of the others, with the probe figures (per scenario: ignored → failed on day N, planned → won, key numbers). In `docs/plan.md` add a "Scenarios" line under the native section or a new "Post-MVP" section marking it done. Delete `src/sim/zz-scenario-probe.test.ts`.

- [ ] **Step 5: Commit**

```bash
pnpm format
git status --short   # the probe must not appear
git add src/shared/constants.ts src/sim/scenarios docs/idea.md docs/plan.md
git commit -m "balance: tune scenario targets from a headless probe"
```

---

### Task 9: End-to-end test

**Files:**

- Modify: `e2e/game.spec.ts`

- [ ] **Step 1: Add the test** (after the new-game test, same fixtures):

```ts
test('a scenario starts from the scenarios page and survives a reload', async ({ page }) => {
  await page.getByTestId('open-scenarios').click();
  await expect(page.getByTestId('scenarios-page')).toBeVisible();
  await page.getByTestId('start-scenario-dunkelflaute').click();
  await expect(page.getByTestId('money')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('scenario-panel')).toBeVisible();
  await expect(page.getByTestId('scenario-day')).toContainText('90');
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(500);
  await page.reload();
  await expect(page.getByTestId('scenario-panel')).toBeVisible({ timeout: 15_000 });
});
```

- [ ] **Step 2: Run it**

Run: `pnpm e2e -- -g "scenario"` (on the Mac or CI; the Linux sandbox has no WebGL but the HUD renders in the fallback, so try locally first).
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add e2e/game.spec.ts
git commit -m "test(e2e): start a scenario and keep it across a reload"
```

---

## Self-review notes

- Spec coverage: definitions (T1, T4), stamping (T2), rules (T1), step/conditions/save (T3), engine init (T4), stats (T5), UI pages/panel/end screen/i18n (T6), agent + docs (T7), tuning + idea/plan docs (T8), e2e (T9). "Regular goals keep counting but panel is replaced" is in T6 step 6. "Tutorial not shown for a scenario" is in T6 step 6.
- Type consistency: `ScenarioRun`, `emptyRun`, `scenarioDay`, `evaluateCondition`, `scenarioDef`, `scenarioDefs`, `startScenario`, `storePendingScenario`, `recordResult/readBestResult`, `ScenarioStats/ConditionStatus` used with the same names throughout.
- Review Focus 1 → T1 step 3 + T3 step 5 (old save); 2 → T3 step 5 (fail beats win); 3 → T3 step 1 (window longer than history); 4 → T2 step 1; 5 → T5 step 4 and T9.
