# Annual Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-year summary table, energy outcome figures, a compare-with-save overlay, CSV export and a `get_annual_report` agent tool to the statistics page.

**Architecture:** The sim keeps writing one `LifetimeSample` per in-game day and gains five optional energy fields. A pure function in `src/shared/annualReport.ts` folds samples into years; the stats page, the CSV export and the agent tool all call it. The `lifetimeData` worker event carries `seasonOriginDay` so the year cut is the sim's.

**Tech Stack:** TypeScript, React 19, vitest, three-layer split `src/sim` (worker) / `src/shared` / `src/ui`; oxfmt formatting; i18n en + de.

**Spec:** `docs/superpowers/specs/2026-10-20-annual-report-design.md`

## Global Constraints

- No DOM or three.js imports in `src/sim` or `src/shared`.
- No magic numbers in sim code: year length is `daysPerYear()` from `src/sim/seasons.ts` (= `BALANCE.seasons.daysPerSeason × 4` = 20), ticks per day is `TICKS_PER_DAY` from `src/shared/constants.ts`.
- `SaveGame` stays backward compatible: all new sample fields are optional; `SAVE_VERSION` does not change.
- Every user-visible string goes through `src/ui/i18n.tsx` with both `en` and `de` entries.
- Run `pnpm format` after edits; the pre-commit hook runs `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`.
- Commit with `-c user.name='Thorsten Rinne' -c user.email='thorsten@phpmyfaq.de'` in the sandbox (no global identity) and end every message with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Money columns/fields are omitted in a sandbox city, matching `get_lifetime_stats`.

## Review Focus

1. A save from before this change (samples without the new fields) opens the stats page and the table shows "–" for the optional columns, never `NaN` or `0`. → Task 2 test "year with a sample lacking optional fields".
2. A save from before seasons (`seasonOriginDay` later than its first sample day) must not produce year 0 or negative years. → Task 2 test "samples before the origin fall into year 1".
3. A city younger than one day (no samples) must render the empty message and still offer no crash on "CSV years". → Task 5 test `annualCsv([])` header only; Task 6 renders empty state.
4. Comparing with a sandbox save must not draw its money line; comparing with an incompatible save must not be offered. → Task 6 `compareOptions` test filters `compatible === false`; `alignedSeries` test for sandbox money.
5. CSV numbers must be locale-independent (`.` decimal, no thousands separator) so spreadsheets parse them. → Task 2 CSV test with a value of 12345.678.

---

### Task 1: Record the new daily energy fields in the sim

**Files:**

- Modify: `src/shared/types.ts:371-389` (`LifetimeSample`)
- Modify: `src/shared/messages.ts:86` (`lifetimeData` event)
- Modify: `src/sim/state.ts:581-592, 837-840` (`lifetime.daySums`)
- Modify: `src/sim/tick.ts:122-166` (`recordLifetime`)
- Modify: `src/sim/engine.ts:122-128` (`requestLifetime`)
- Test: `src/sim/integration-stall.test.ts:31-70`
- Test: `src/storage/serialization.test.ts`

**Interfaces:**

- Produces: `LifetimeSample` with optional `renewable`, `gridImport`, `gridExport`, `curtailment`, `deficitTicks` (numbers). Event `{ type: 'lifetimeData'; samples: LifetimeSample[]; seasonOriginDay: number }`.

- [ ] **Step 1: Extend the failing test**

In `src/sim/integration-stall.test.ts`, inside `it('records one sample per day and survives save/load')`, after the `cooling` expectation add:

```ts
// Energy outcome fields (annual report).
expect(samples[2].renewable).toBeGreaterThan(0);
expect(samples[2].gridImport).toBeGreaterThanOrEqual(0);
expect(samples[2].gridExport).toBeGreaterThanOrEqual(0);
expect(samples[2].curtailment).toBeGreaterThanOrEqual(0);
expect(Number.isInteger(samples[2].deficitTicks)).toBe(true);
expect(samples[2].deficitTicks).toBeLessThanOrEqual(TICKS_PER_DAY);
```

and after `expect(lifetimeEvents[0].samples.length).toBe(3);` add:

```ts
expect(lifetimeEvents[0].seasonOriginDay).toBe(restored.state.seasonOriginDay);
expect(lifetimeEvents[0].samples[2].renewable).toBe(samples[2].renewable);
```

In `src/storage/serialization.test.ts` add:

```ts
it('round-trips the energy fields of a lifetime sample', () => {
  const state = createSimState(77, 16);
  state.lifetime.samples.push({
    day: 0,
    population: 1,
    jobs: 2,
    happiness: 0.5,
    avgGeneration: 3,
    avgConsumption: 4,
    money: 5,
    renewable: 2.5,
    gridImport: 1.5,
    gridExport: 0.25,
    curtailment: 0.75,
    deficitTicks: 7,
  });
  const restored = saveFromJson(saveToJson(serializeState(state)));
  expect(restored.lifetime?.[0]).toMatchObject({
    renewable: 2.5,
    gridImport: 1.5,
    gridExport: 0.25,
    curtailment: 0.75,
    deficitTicks: 7,
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/sim/integration-stall.test.ts src/storage/serialization.test.ts`
Expected: FAIL (typecheck or `expected undefined to be > 0`).

- [ ] **Step 3: Add the fields to the type and the event**

`src/shared/types.ts`, after `cooling?: number;` in `LifetimeSample`:

```ts
  /** Average renewable output per tick (solar, wind, rooftop, hydro, tidal, geothermal, fuel cell); absent in older samples. */
  renewable?: number;
  /** Average grid import per tick (absent in older samples). */
  gridImport?: number;
  /** Average grid export per tick (absent in older samples). */
  gridExport?: number;
  /** Average curtailed output per tick (absent in older samples). */
  curtailment?: number;
  /** Ticks of the day with an unmet deficit (absent in older samples). */
  deficitTicks?: number;
```

`src/shared/messages.ts`:

```ts
  | { type: 'lifetimeData'; samples: LifetimeSample[]; seasonOriginDay: number }
```

- [ ] **Step 4: Sum them in the sim**

`src/sim/state.ts` `daySums` type gains `renewable: number; gridImport: number; gridExport: number; curtailment: number; deficitTicks: number;` and the initialiser becomes:

```ts
      daySums: {
        generation: 0,
        consumption: 0,
        heating: 0,
        cooling: 0,
        temperature: 0,
        renewable: 0,
        gridImport: 0,
        gridExport: 0,
        curtailment: 0,
        deficitTicks: 0,
        ticks: 0,
      },
```

`src/sim/tick.ts` `recordLifetime`, after `sums.temperature += …`:

```ts
// Same renewable sum as the scenario's renewable share (scenarios/step.ts).
sums.renewable += e.solar + e.wind + e.rooftop + e.hydro + e.tidal + e.geothermal + e.fuelCell;
sums.gridImport += e.gridImport;
sums.gridExport += e.gridExport;
sums.curtailment += e.curtailment;
if (e.deficit > 0) sums.deficitTicks++;
```

In the pushed sample add:

```ts
    renewable: sums.renewable / ticks,
    gridImport: sums.gridImport / ticks,
    gridExport: sums.gridExport / ticks,
    curtailment: sums.curtailment / ticks,
    deficitTicks: sums.deficitTicks,
```

and in the reset block add `sums.renewable = 0; sums.gridImport = 0; sums.gridExport = 0; sums.curtailment = 0; sums.deficitTicks = 0;`.

`src/sim/engine.ts` `requestLifetime`:

```ts
      case 'requestLifetime':
        return [
          {
            type: 'lifetimeData',
            samples: state.lifetime.samples.map((sample) => ({ ...sample })),
            seasonOriginDay: state.seasonOriginDay,
          },
        ];
```

`src/sim/state.ts` `loadState` (line ~1522) already copies whole sample objects, and the `lifetime` validator in `src/storage/serialization.ts:268` keeps whole objects, so no change there. `src/sim/worker.ts` forwards events untouched.

- [ ] **Step 5: Fix the compile errors in consumers**

`src/ui/useSimBridge.ts`: the `lifetimeData` case passes `event.samples` to listeners today; leave that for now (Task 4 changes the listener type). `src/agent/tools.test.ts:97-100` still compiles (`event.samples`). Run `pnpm typecheck`; expected: clean.

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run src/sim/integration-stall.test.ts src/storage/serialization.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
pnpm format
git add src/shared/types.ts src/shared/messages.ts src/sim/state.ts src/sim/tick.ts src/sim/engine.ts src/sim/integration-stall.test.ts src/storage/serialization.test.ts
git -c user.name='Thorsten Rinne' -c user.email='thorsten@phpmyfaq.de' commit -m "sim: record daily renewable, trade, curtailment and deficit figures

The lifetime sample gains the energy outcome of the day for the
annual report; the lifetime event carries the season origin so the
UI can cut years.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Shared annual aggregation and CSV

**Files:**

- Create: `src/shared/annualReport.ts`
- Test: `src/shared/annualReport.test.ts`

**Interfaces:**

- Consumes: `LifetimeSample` from Task 1.
- Produces:

```ts
export interface AnnualRow {
  year: number;
  days: number;
  complete: boolean;
  population: number;
  jobs: number;
  happiness: number;
  generation: number;
  consumption: number;
  moneyEnd: number;
  moneyDelta: number;
  renewableShare?: number;
  gridImport?: number;
  gridExport?: number;
  curtailment?: number;
  deficitTicks?: number;
}
export function annualReport(
  samples: LifetimeSample[],
  seasonOriginDay: number,
  daysPerYear: number,
  ticksPerDay: number,
): AnnualRow[];
export function yearOfDay(day: number, seasonOriginDay: number, daysPerYear: number): number;
export function lifetimeCsv(samples: LifetimeSample[], sandbox: boolean): string;
export function annualCsv(rows: AnnualRow[], sandbox: boolean): string;
```

- [ ] **Step 1: Write the failing tests**

`src/shared/annualReport.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { LifetimeSample } from './types.ts';
import { annualCsv, annualReport, lifetimeCsv, yearOfDay } from './annualReport.ts';

const DAYS = 4;
const TICKS = 10;

function sample(day: number, extra: Partial<LifetimeSample> = {}): LifetimeSample {
  return {
    day,
    population: 100 + day,
    jobs: 50 + day,
    happiness: 0.5,
    avgGeneration: 2,
    avgConsumption: 1,
    money: 1000 + day * 10,
    renewable: 1.5,
    gridImport: 0.5,
    gridExport: 0.25,
    curtailment: 0.1,
    deficitTicks: 1,
    ...extra,
  };
}

describe('yearOfDay', () => {
  it('cuts years at the season origin', () => {
    expect(yearOfDay(0, 0, DAYS)).toBe(1);
    expect(yearOfDay(3, 0, DAYS)).toBe(1);
    expect(yearOfDay(4, 0, DAYS)).toBe(2);
    expect(yearOfDay(7, 7, DAYS)).toBe(1);
    expect(yearOfDay(11, 7, DAYS)).toBe(2);
  });

  it('puts samples before the origin into year 1', () => {
    expect(yearOfDay(2, 7, DAYS)).toBe(1);
  });
});

describe('annualReport', () => {
  it('sums a complete year and marks the running one', () => {
    const samples = Array.from({ length: 6 }, (_, day) => sample(day));
    const rows = annualReport(samples, 0, DAYS, TICKS);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      year: 1,
      days: 4,
      complete: true,
      population: 103,
      jobs: 53,
      happiness: 0.5,
      generation: 2 * TICKS * 4,
      consumption: 1 * TICKS * 4,
      moneyEnd: 1030,
      gridImport: 0.5 * TICKS * 4,
      gridExport: 0.25 * TICKS * 4,
      curtailment: 0.1 * TICKS * 4,
      deficitTicks: 4,
    });
    // First year: delta against the first sample's money.
    expect(rows[0].moneyDelta).toBe(1030 - 1000);
    expect(rows[1]).toMatchObject({ year: 2, days: 2, complete: false, moneyEnd: 1050 });
    expect(rows[1].moneyDelta).toBe(1050 - 1030);
  });

  it('computes the renewable share against generation plus import', () => {
    const rows = annualReport([sample(0)], 0, DAYS, TICKS);
    // renewable 1.5 / (generation 2 + import 0.5)
    expect(rows[0].renewableShare).toBeCloseTo(1.5 / 2.5, 6);
    const noImport = annualReport([sample(0, { gridImport: 0, renewable: 2 })], 0, DAYS, TICKS);
    expect(noImport[0].renewableShare).toBe(1);
  });

  it('leaves the optional figures undefined when any sample of the year lacks them', () => {
    const legacy: LifetimeSample = {
      day: 1,
      population: 1,
      jobs: 1,
      happiness: 0.4,
      avgGeneration: 1,
      avgConsumption: 1,
      money: 5,
    };
    const rows = annualReport([sample(0), legacy, sample(4)], 0, DAYS, TICKS);
    expect(rows[0].renewableShare).toBeUndefined();
    expect(rows[0].gridImport).toBeUndefined();
    expect(rows[0].deficitTicks).toBeUndefined();
    expect(rows[0].happiness).toBeCloseTo(0.45, 6);
    expect(rows[1].deficitTicks).toBe(1);
  });

  it('folds samples before the origin into year 1', () => {
    const rows = annualReport([sample(0), sample(1), sample(7), sample(8)], 7, DAYS, TICKS);
    expect(rows.map((r) => r.year)).toEqual([1]);
    expect(rows[0].days).toBe(4);
  });

  it('returns no rows without samples', () => {
    expect(annualReport([], 0, DAYS, TICKS)).toEqual([]);
  });
});

describe('csv', () => {
  it('writes the daily samples with a header and locale-free numbers', () => {
    const csv = lifetimeCsv([sample(0, { money: 12345.678, temperature: 21.456 })], false);
    const [header, row] = csv.split('\n');
    expect(header).toBe(
      'day,population,jobs,happiness,avgGeneration,avgConsumption,money,temperature,heating,cooling,renewable,gridImport,gridExport,curtailment,deficitTicks',
    );
    expect(row).toBe('0,100,50,0.5,2,1,12345.68,21.46,,,1.5,0.5,0.25,0.1,1');
  });

  it('drops the money column in a sandbox city', () => {
    const csv = lifetimeCsv([sample(0)], true);
    expect(csv.split('\n')[0]).not.toContain('money');
    expect(csv.split('\n')[1].split(',')).toHaveLength(14);
  });

  it('writes the annual rows, empty cells for missing figures', () => {
    const rows = annualReport([sample(0)], 0, DAYS, TICKS);
    rows[0].deficitTicks = undefined;
    const csv = annualCsv(rows, false);
    const [header, row] = csv.split('\n');
    expect(header).toBe(
      'year,days,complete,population,jobs,happiness,generation,consumption,renewableShare,gridImport,gridExport,curtailment,deficitTicks,moneyEnd,moneyDelta',
    );
    expect(row).toBe('1,1,false,100,50,0.5,20,10,0.6,5,2.5,1,,1000,0');
  });

  it('writes only the header without rows', () => {
    expect(annualCsv([], true).split('\n')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/shared/annualReport.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/shared/annualReport.ts`:

```ts
import type { LifetimeSample } from './types.ts';

/** One in-game year of the lifetime statistics (see docs/superpowers/specs/2026-10-20-annual-report-design.md). */
export interface AnnualRow {
  /** 1-based, as `SeasonState.year`. */
  year: number;
  /** Samples in the year; equals `daysPerYear` when complete. */
  days: number;
  complete: boolean;
  /** Last sample of the year. */
  population: number;
  jobs: number;
  /** Mean over the year, 0..1. */
  happiness: number;
  /** Sums over the year in energy units. */
  generation: number;
  consumption: number;
  moneyEnd: number;
  /** Against the previous year's end (first year: against its first sample). */
  moneyDelta: number;
  /** renewable / (generation + import); absent when a sample of the year lacks the energy fields. */
  renewableShare?: number;
  gridImport?: number;
  gridExport?: number;
  curtailment?: number;
  deficitTicks?: number;
}

/** 1-based year of an in-game day; days before the origin count as year 1. */
export function yearOfDay(day: number, seasonOriginDay: number, daysPerYear: number): number {
  return Math.max(1, Math.floor((day - seasonOriginDay) / daysPerYear) + 1);
}

const ENERGY_FIELDS = [
  'renewable',
  'gridImport',
  'gridExport',
  'curtailment',
  'deficitTicks',
] as const;

function hasEnergyFields(sample: LifetimeSample): boolean {
  return ENERGY_FIELDS.every((field) => typeof sample[field] === 'number');
}

export function annualReport(
  samples: LifetimeSample[],
  seasonOriginDay: number,
  daysPerYear: number,
  ticksPerDay: number,
): AnnualRow[] {
  const rows: AnnualRow[] = [];
  let group: LifetimeSample[] = [];
  let groupYear = 0;
  let previousEnd: number | undefined;
  const flush = (): void => {
    if (group.length === 0) return;
    const last = group[group.length - 1];
    const sum = (pick: (s: LifetimeSample) => number): number =>
      group.reduce((acc, s) => acc + pick(s), 0);
    const generation = sum((s) => s.avgGeneration) * ticksPerDay;
    const row: AnnualRow = {
      year: groupYear,
      days: group.length,
      complete: group.length >= daysPerYear,
      population: last.population,
      jobs: last.jobs,
      happiness: sum((s) => s.happiness) / group.length,
      generation,
      consumption: sum((s) => s.avgConsumption) * ticksPerDay,
      moneyEnd: last.money,
      moneyDelta: last.money - (previousEnd ?? group[0].money),
    };
    if (group.every(hasEnergyFields)) {
      const renewable = sum((s) => s.renewable!) * ticksPerDay;
      const gridImport = sum((s) => s.gridImport!) * ticksPerDay;
      const supplied = generation + gridImport;
      row.renewableShare = supplied === 0 ? 1 : Math.min(1, renewable / supplied);
      row.gridImport = gridImport;
      row.gridExport = sum((s) => s.gridExport!) * ticksPerDay;
      row.curtailment = sum((s) => s.curtailment!) * ticksPerDay;
      row.deficitTicks = sum((s) => s.deficitTicks!);
    }
    rows.push(row);
    previousEnd = last.money;
    group = [];
  };
  for (const sample of samples) {
    const year = yearOfDay(sample.day, seasonOriginDay, daysPerYear);
    if (year !== groupYear) {
      flush();
      groupYear = year;
    }
    group.push(sample);
  }
  flush();
  return rows;
}

/** Locale-free cell: `.` decimal, at most two decimals, empty for a missing value. */
function cell(value: number | boolean | undefined): string {
  if (value === undefined) return '';
  if (typeof value === 'boolean') return String(value);
  return String(Math.round(value * 100) / 100);
}

function csv<T>(
  columns: Array<[string, (row: T) => number | boolean | undefined]>,
  rows: T[],
): string {
  const lines = [columns.map(([name]) => name).join(',')];
  for (const row of rows) lines.push(columns.map(([, pick]) => cell(pick(row))).join(','));
  return lines.join('\n');
}

export function lifetimeCsv(samples: LifetimeSample[], sandbox: boolean): string {
  const columns: Array<[string, (s: LifetimeSample) => number | undefined]> = [
    ['day', (s) => s.day],
    ['population', (s) => s.population],
    ['jobs', (s) => s.jobs],
    ['happiness', (s) => s.happiness],
    ['avgGeneration', (s) => s.avgGeneration],
    ['avgConsumption', (s) => s.avgConsumption],
    ...(sandbox
      ? []
      : [['money', (s: LifetimeSample) => s.money] as [string, (s: LifetimeSample) => number]]),
    ['temperature', (s) => s.temperature],
    ['heating', (s) => s.heating],
    ['cooling', (s) => s.cooling],
    ['renewable', (s) => s.renewable],
    ['gridImport', (s) => s.gridImport],
    ['gridExport', (s) => s.gridExport],
    ['curtailment', (s) => s.curtailment],
    ['deficitTicks', (s) => s.deficitTicks],
  ];
  return csv(columns, samples);
}

export function annualCsv(rows: AnnualRow[], sandbox: boolean): string {
  const columns: Array<[string, (r: AnnualRow) => number | boolean | undefined]> = [
    ['year', (r) => r.year],
    ['days', (r) => r.days],
    ['complete', (r) => r.complete],
    ['population', (r) => r.population],
    ['jobs', (r) => r.jobs],
    ['happiness', (r) => r.happiness],
    ['generation', (r) => r.generation],
    ['consumption', (r) => r.consumption],
    ['renewableShare', (r) => r.renewableShare],
    ['gridImport', (r) => r.gridImport],
    ['gridExport', (r) => r.gridExport],
    ['curtailment', (r) => r.curtailment],
    ['deficitTicks', (r) => r.deficitTicks],
  ];
  if (!sandbox) columns.push(['moneyEnd', (r) => r.moneyEnd], ['moneyDelta', (r) => r.moneyDelta]);
  return csv(columns, rows);
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run src/shared/annualReport.test.ts`
Expected: PASS. (If the `complete: false` row in the annual CSV test differs, check `days 1 < DAYS 4`.)

- [ ] **Step 5: Commit**

```bash
pnpm format
git add src/shared/annualReport.ts src/shared/annualReport.test.ts
git -c user.name='Thorsten Rinne' -c user.email='thorsten@phpmyfaq.de' commit -m "shared: fold lifetime samples into annual rows and CSV

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Agent tools and docs

**Files:**

- Modify: `src/agent/tools.ts:70-80` (`AgentContext.requestLifetime`), `:1184-1208` (`get_lifetime_stats`), new tool after it
- Modify: `src/ui/useAgentTools.ts:77-84`
- Modify: `src/agent/tools.test.ts:97-100, 186, 367-373`
- Modify: `docs/agent-tools.md:183`
- Modify: `src/ui/useSimBridge.ts:22, 96-97, 153-156` (listener type)

**Interfaces:**

- Consumes: `annualReport`, `AnnualRow` (Task 2); `lifetimeData` event with `seasonOriginDay` (Task 1).
- Produces: `export interface LifetimeData { samples: LifetimeSample[]; seasonOriginDay: number }` in `src/shared/messages.ts`; `AgentContext.requestLifetime(): Promise<LifetimeData>`; `SimBridge.onLifetime(listener: (data: LifetimeData) => void)`.

- [ ] **Step 1: Write the failing tests**

In `src/agent/tools.test.ts`, add `'get_annual_report'` to the tool-name list right after `'get_lifetime_stats'` (line 186). Replace the `get_lifetime_stats` test with:

```ts
it('get_lifetime_stats returns one sample per day with the energy figures', async () => {
  const { call } = createHarness();
  expect(await call('get_lifetime_stats')).toMatchObject({ days: 0, samples: [] });
  await call('advance_time', { days: 1 });
  const after = (await call('get_lifetime_stats')) as {
    days: number;
    samples: Record<string, number>[];
  };
  expect(after.days).toBe(1);
  expect(after.samples[0]).toHaveProperty('deficitTicks');
  expect(after.samples[0]).toHaveProperty('gridImport');
  expect(after.samples[0]).toHaveProperty('money');
});

it('get_annual_report folds the days into years, the last one running', async () => {
  const { call } = createHarness();
  expect(await call('get_annual_report')).toMatchObject({ daysPerYear: daysPerYear(), years: [] });
  await call('advance_time', { days: 2 });
  const report = (await call('get_annual_report')) as { years: Record<string, unknown>[] };
  expect(report.years).toHaveLength(1);
  expect(report.years[0]).toMatchObject({ year: 1, days: 2, complete: false });
  expect(report.years[0]).toHaveProperty('moneyEnd');
  expect(report.years[0]).toHaveProperty('renewableShare');
});

it('get_annual_report drops money in a sandbox city', async () => {
  const { call } = createHarness({ sandbox: true });
  await call('advance_time', { days: 1 });
  const report = (await call('get_annual_report')) as { years: Record<string, unknown>[] };
  expect(report.years[0]).not.toHaveProperty('moneyEnd');
  expect(report.years[0]).not.toHaveProperty('moneyDelta');
});
```

Import `daysPerYear` from `'../sim/seasons.ts'` at the top of the test (check how `createHarness` takes `sandbox`: it is an option object field, see line ~55; if the signature is positional, adapt the call).

Update the harness `requestLifetime`:

```ts
    async requestLifetime() {
      const [event] = engine.applyCommand({ type: 'requestLifetime' });
      return event && event.type === 'lifetimeData'
        ? { samples: event.samples, seasonOriginDay: event.seasonOriginDay }
        : { samples: [], seasonOriginDay: 0 };
    },
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/agent/tools.test.ts`
Expected: FAIL (`get_annual_report` missing from the tool list).

- [ ] **Step 3: Add `LifetimeData` and thread it through**

`src/shared/messages.ts`, next to the event union:

```ts
/** Payload of the `lifetimeData` event: the daily samples and the day year 1 started on. */
export interface LifetimeData {
  samples: LifetimeSample[];
  seasonOriginDay: number;
}
```

and make the event `| ({ type: 'lifetimeData' } & LifetimeData)`.

`src/ui/useSimBridge.ts`: `onLifetime: (listener: (data: LifetimeData) => void) => () => void;`, the listener set typed the same, and the case:

```ts
        case 'lifetimeData':
          for (const listener of lifetimeListeners.current)
            listener({ samples: event.samples, seasonOriginDay: event.seasonOriginDay });
          break;
```

`src/ui/useAgentTools.ts`: `requestLifetime` resolves with the `data` object unchanged (`onLifetime((data) => { unsubscribe(); resolve(data); })`).

`src/ui/StatsPage.tsx`: for now `onLifetime((data) => setSamples(data.samples))` so it compiles (Task 6 rewrites it).

`src/agent/tools.ts`: `requestLifetime(): Promise<LifetimeData>;` (import from `../shared/messages.ts`). In `get_lifetime_stats`:

```ts
const { samples } = await ctx.requestLifetime();
```

and extend the mapped sample with:

```ts
            ...(sample.renewable !== undefined ? { renewable: round(sample.renewable) } : {}),
            ...(sample.gridImport !== undefined ? { gridImport: round(sample.gridImport) } : {}),
            ...(sample.gridExport !== undefined ? { gridExport: round(sample.gridExport) } : {}),
            ...(sample.curtailment !== undefined ? { curtailment: round(sample.curtailment) } : {}),
            ...(sample.deficitTicks !== undefined ? { deficitTicks: sample.deficitTicks } : {}),
```

Update its description: `'… mean temperature, heating load, and per day the renewable output, grid import, grid export, curtailment (averages per tick) and the deficit ticks.'`

New tool directly after it:

```ts
    {
      name: 'get_annual_report',
      description:
        'The lifetime statistics folded into in-game years (daysPerYear days each, year 1 starts at ' +
        'founding): residents and jobs at year end, mean happiness, generation and consumption sums, ' +
        'renewable share of generation plus import, grid import/export, curtailment, deficit ticks, ' +
        'treasury at year end and its change (both left out in a sandbox city). The last row is the ' +
        'running year when complete is false. Energy figures are absent for years recorded before they were tracked.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      async execute() {
        const { samples, seasonOriginDay } = await ctx.requestLifetime();
        const sandbox = ctx.getStats()?.sandbox === true;
        const years = annualReport(samples, seasonOriginDay, daysPerYear(), TICKS_PER_DAY).map(
          ({ moneyEnd, moneyDelta, ...row }) => ({
            ...row,
            happiness: round(row.happiness, 2),
            generation: round(row.generation),
            consumption: round(row.consumption),
            ...(row.renewableShare !== undefined ? { renewableShare: round(row.renewableShare, 3) } : {}),
            ...(row.gridImport !== undefined ? { gridImport: round(row.gridImport) } : {}),
            ...(row.gridExport !== undefined ? { gridExport: round(row.gridExport) } : {}),
            ...(row.curtailment !== undefined ? { curtailment: round(row.curtailment) } : {}),
            ...(sandbox ? {} : { moneyEnd: Math.round(moneyEnd), moneyDelta: Math.round(moneyDelta) }),
          }),
        );
        return { daysPerYear: daysPerYear(), years };
      },
    },
```

Imports in `tools.ts`: `annualReport` from `'../shared/annualReport.ts'`, `daysPerYear` from `'../sim/seasons.ts'` (tools.ts already imports from `../sim/` for `SimEngine`-free helpers? Check the existing imports; `src/sim/seasons.ts` has no DOM and is fine to import), `TICKS_PER_DAY` from `'../shared/constants.ts'` (may already be imported). `round` exists in `tools.ts` (used by `get_lifetime_stats`).

- [ ] **Step 4: Update the docs**

`docs/agent-tools.md`: change the `get_lifetime_stats` row text to `One sample per in-game day incl. renewable output, grid import/export, curtailment and deficit ticks (no \`money\` in a sandbox city)` and add a row after it (pad the columns like the neighbours):

```
| `get_annual_report`       | read  | Lifetime statistics folded into in-game years (last row may be running); renewable share, import/export, curtailment, deficit ticks, treasury end and change (no money in a sandbox city) |
```

Also mention the new tool in the prose list near line 162-167 if `get_lifetime_stats` is named there (grep `get_lifetime_stats` in the file and mirror each mention).

- [ ] **Step 5: Run typecheck and tests**

Run: `pnpm typecheck && pnpm vitest run src/agent src/ui/useTools.test.ts src/ui/StatsPage.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
pnpm format
git add src/shared/messages.ts src/ui/useSimBridge.ts src/ui/useAgentTools.ts src/ui/StatsPage.tsx src/agent/tools.ts src/agent/tools.test.ts docs/agent-tools.md
git -c user.name='Thorsten Rinne' -c user.email='thorsten@phpmyfaq.de' commit -m "agent: add get_annual_report and the energy figures to get_lifetime_stats

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Let `exportTextFile` export CSV

**Files:**

- Modify: `src/ui/platform.ts:45-66`
- Test: `src/ui/platform.test.ts`

**Interfaces:**

- Produces: `exportTextFile(fileName, text, deps?)` picks the native dialog filter and the blob MIME type from the file extension: `.csv` → `{ name: 'CSV', extensions: ['csv'] }`, `text/csv`; anything else keeps JSON.

- [ ] **Step 1: Write the failing test**

Read `src/ui/platform.test.ts:33-44` ("asks for a path and writes the file in the native app") and add a sibling:

```ts
it('offers a CSV filter and MIME type for .csv files', async () => {
  const save = vi.fn(async () => '/tmp/out.csv');
  const writeTextFile = vi.fn(async () => undefined);
  await exportTextFile('voltopia-days-2026-10-20.csv', 'a,b\n1,2', {
    native: true,
    nativeApi: async () => ({ save, writeTextFile }),
  });
  expect(save).toHaveBeenCalledWith({
    defaultPath: 'voltopia-days-2026-10-20.csv',
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  expect(writeTextFile).toHaveBeenCalledWith('/tmp/out.csv', 'a,b\n1,2');
});
```

(Mirror the mocking style of the existing native test exactly; if it builds `nativeApi` differently, copy that.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/ui/platform.test.ts`
Expected: FAIL on the `filters` expectation.

- [ ] **Step 3: Implement**

In `src/ui/platform.ts` before `exportTextFile`:

```ts
function fileKind(fileName: string): {
  filter: { name: string; extensions: string[] };
  mime: string;
} {
  return /\.csv$/i.test(fileName)
    ? { filter: { name: 'CSV', extensions: ['csv'] }, mime: 'text/csv' }
    : { filter: { name: 'JSON', extensions: ['json'] }, mime: 'application/json' };
}
```

and use it: `filters: [fileKind(fileName).filter]` and `new Blob([text], { type: fileKind(fileName).mime })`.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run src/ui/platform.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add src/ui/platform.ts src/ui/platform.test.ts
git -c user.name='Thorsten Rinne' -c user.email='thorsten@phpmyfaq.de' commit -m "ui: let exportTextFile hand out CSV files

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Stats page helpers (pure, tested)

**Files:**

- Create: `src/ui/statsReport.ts`
- Test: `src/ui/statsReport.test.ts`

**Interfaces:**

- Consumes: `LifetimeSample`, `yearOfDay` (Task 2), `SaveSummary` (`src/storage/storage.ts`).
- Produces:

```ts
export function csvFileName(kind: 'days' | 'years', date: Date): string; // voltopia-days-YYYY-MM-DD.csv
export function compareOptions(saves: SaveSummary[]): Array<{ id: string; label: string }>; // compatible only, "name · day N"
/** Values of `other` placed on the same year axis as `own`: index i of the result is the day i of `own` (year-aligned); NaN where `other` has no sample. */
export function alignSeries(
  own: { samples: LifetimeSample[]; seasonOriginDay: number },
  other: { samples: LifetimeSample[]; seasonOriginDay: number },
  pick: (s: LifetimeSample) => number | undefined,
): number[];
```

- [ ] **Step 1: Write the failing tests**

`src/ui/statsReport.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { LifetimeSample } from '../shared/types.ts';
import { alignSeries, compareOptions, csvFileName } from './statsReport.ts';

function sample(day: number, population: number): LifetimeSample {
  return { day, population, jobs: 0, happiness: 0, avgGeneration: 0, avgConsumption: 0, money: 0 };
}

describe('csvFileName', () => {
  it('names the file by kind and ISO date', () => {
    expect(csvFileName('days', new Date('2026-10-20T12:00:00Z'))).toBe(
      'voltopia-days-2026-10-20.csv',
    );
    expect(csvFileName('years', new Date('2026-10-20T12:00:00Z'))).toBe(
      'voltopia-years-2026-10-20.csv',
    );
  });
});

describe('compareOptions', () => {
  it('lists compatible saves as "name · day N"', () => {
    const base = { savedAt: 0, population: 0, money: 0, size: 32 };
    expect(
      compareOptions([
        { ...base, id: 'a', name: 'Alpha', day: 12, compatible: true },
        { ...base, id: 'b', name: 'Beta', day: 3, compatible: false },
      ]),
    ).toEqual([{ id: 'a', label: 'Alpha · day 12' }]);
  });
});

describe('alignSeries', () => {
  it('aligns the other city by day since its season origin', () => {
    const own = { samples: [sample(5, 1), sample(6, 2), sample(7, 3)], seasonOriginDay: 5 };
    const other = { samples: [sample(0, 10), sample(1, 20)], seasonOriginDay: 0 };
    expect(alignSeries(own, other, (s) => s.population)).toEqual([10, 20, NaN]);
  });

  it('skips a missing optional value and days the other city has not reached', () => {
    const own = { samples: [sample(0, 1), sample(1, 2)], seasonOriginDay: 0 };
    const other = { samples: [sample(3, 10)], seasonOriginDay: 3 };
    expect(alignSeries(own, other, (s) => s.temperature)).toEqual([NaN, NaN]);
    expect(alignSeries(own, other, (s) => s.population)).toEqual([10, NaN]);
  });

  it('places old samples from before the origin at offset 0', () => {
    const own = { samples: [sample(0, 1), sample(1, 2)], seasonOriginDay: 0 };
    const other = { samples: [sample(2, 10), sample(4, 20)], seasonOriginDay: 4 };
    expect(alignSeries(own, other, (s) => s.population)).toEqual([20, NaN]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/ui/statsReport.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/ui/statsReport.ts`:

```ts
import type { LifetimeSample } from '../shared/types.ts';
import type { SaveSummary } from '../storage/storage.ts';

/** `voltopia-<kind>-<YYYY-MM-DD>.csv`. */
export function csvFileName(kind: 'days' | 'years', date: Date): string {
  return `voltopia-${kind}-${date.toISOString().slice(0, 10)}.csv`;
}

/** Saves a city can be compared with: compatible ones, labelled "name · day N". */
export function compareOptions(saves: SaveSummary[]): Array<{ id: string; label: string }> {
  return saves
    .filter((save) => save.compatible)
    .map((save) => ({ id: save.id, label: `${save.name} · day ${save.day}` }));
}

interface History {
  samples: LifetimeSample[];
  seasonOriginDay: number;
}

/** Days since year 1 started; samples from before the origin collapse onto 0. */
function offset(day: number, seasonOriginDay: number): number {
  return Math.max(0, day - seasonOriginDay);
}

/**
 * The other city's values on this city's day axis, founding under
 * founding: result[i] belongs to own.samples[i]; NaN where the other
 * city has no sample (or no value) for that offset.
 */
export function alignSeries(
  own: History,
  other: History,
  pick: (s: LifetimeSample) => number | undefined,
): number[] {
  const byOffset = new Map<number, number>();
  for (const sample of other.samples) {
    const value = pick(sample);
    if (value !== undefined) byOffset.set(offset(sample.day, other.seasonOriginDay), value);
  }
  return own.samples.map((sample) => byOffset.get(offset(sample.day, own.seasonOriginDay)) ?? NaN);
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run src/ui/statsReport.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add src/ui/statsReport.ts src/ui/statsReport.test.ts
git -c user.name='Thorsten Rinne' -c user.email='thorsten@phpmyfaq.de' commit -m "ui: add stats page helpers for CSV names and save comparison

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Statistics page: annual table, new charts, compare, CSV

**Files:**

- Modify: `src/ui/StatsPage.tsx` (whole file)
- Modify: `src/ui/App.tsx:587-593` (pass `storage`)
- Modify: `src/ui/i18n.tsx` (en block near line 503, de block near line 1337)
- Modify: `src/ui/app.css:1986-2012`

**Interfaces:**

- Consumes: `LifetimeData` (Task 3), `annualReport`, `lifetimeCsv`, `annualCsv` (Task 2), `csvFileName`, `compareOptions`, `alignSeries` (Task 5), `exportTextFile` (Task 4), `SaveStorage`, `daysPerYear()` from `src/sim/seasons.ts`, `TICKS_PER_DAY`.
- Produces: `StatsPage({ bridge, sandbox, storage, onClose })`.

No unit test for the JSX (the project has none for pages); the logic is covered by Tasks 2 and 5. Verify in the browser on the Mac (`pnpm dev`) or with the Playwright e2e smoke in Step 6.

- [ ] **Step 1: i18n keys**

Add to the `en` block after `'stats.temperature'`:

```ts
  'stats.compare': 'Compare with',
  'stats.compare.none': 'no other city',
  'stats.compare.hint': 'Dashed lines: the compared city, founding under founding.',
  'stats.csvDays': 'CSV (days)',
  'stats.csvYears': 'CSV (years)',
  'stats.annual': 'Annual report',
  'stats.annual.running': 'running · {days} of {total} days',
  'stats.col.year': 'Year',
  'stats.col.population': 'Residents',
  'stats.col.jobs': 'Jobs',
  'stats.col.happiness': 'Happiness',
  'stats.col.generation': 'Generation',
  'stats.col.consumption': 'Consumption',
  'stats.col.renewable': 'Renewable',
  'stats.col.import': 'Import',
  'stats.col.export': 'Export',
  'stats.col.deficit': 'Deficit ticks',
  'stats.col.money': 'Treasury',
  'stats.col.moneyDelta': 'Δ Treasury',
  'stats.gridTrade': 'Grid import & export (daily average per tick)',
  'stats.deficit': 'Deficit ticks per day',
  'energy.legend.import': 'import',
  'energy.legend.export': 'export',
```

(If `energy.legend.import` / `energy.legend.export` already exist, reuse them and do not add duplicates: grep first.)

And to the `de` block after `'stats.temperature'`:

```ts
  'stats.compare': 'Vergleichen mit',
  'stats.compare.none': 'keiner anderen Stadt',
  'stats.compare.hint': 'Gestrichelt: die Vergleichsstadt, Gründung unter Gründung.',
  'stats.csvDays': 'CSV (Tage)',
  'stats.csvYears': 'CSV (Jahre)',
  'stats.annual': 'Jahresbericht',
  'stats.annual.running': 'laufend · {days} von {total} Tagen',
  'stats.col.year': 'Jahr',
  'stats.col.population': 'Einwohner',
  'stats.col.jobs': 'Jobs',
  'stats.col.happiness': 'Zufriedenheit',
  'stats.col.generation': 'Erzeugung',
  'stats.col.consumption': 'Verbrauch',
  'stats.col.renewable': 'EE-Anteil',
  'stats.col.import': 'Import',
  'stats.col.export': 'Export',
  'stats.col.deficit': 'Defizit-Ticks',
  'stats.col.money': 'Stadtkasse',
  'stats.col.moneyDelta': 'Δ Stadtkasse',
  'stats.gridTrade': 'Netzimport & -export (Tagesdurchschnitt pro Tick)',
  'stats.deficit': 'Defizit-Ticks pro Tag',
  'energy.legend.import': 'Import',
  'energy.legend.export': 'Export',
```

Run `pnpm typecheck`: the `de` object is typed against `en` keys, so a missing key fails here.

- [ ] **Step 2: Rewrite `StatsPage.tsx`**

Keep `linePath` and `Chart`; extend `Chart`'s series items with an optional `dashed?: boolean` rendered as `strokeDasharray={s.dashed ? '4 3' : undefined}` and excluded from the legend when dashed. New body:

```tsx
import { useEffect, useMemo, useState } from 'react';
import { annualCsv, annualReport, lifetimeCsv, type AnnualRow } from '../shared/annualReport.ts';
import { TICKS_PER_DAY } from '../shared/constants.ts';
import type { LifetimeData } from '../shared/messages.ts';
import type { LifetimeSample } from '../shared/types.ts';
import { daysPerYear } from '../sim/seasons.ts';
import type { SaveStorage, SaveSummary } from '../storage/storage.ts';
import { Modal } from './Modal.tsx';
import { useI18n } from './i18n.tsx';
import { exportTextFile } from './platform.ts';
import { alignSeries, compareOptions, csvFileName } from './statsReport.ts';
import type { SimBridge } from './useSimBridge.ts';

// … linePath, Chart (with `dashed`) …

const fmt = (value: number): string => Math.round(value).toLocaleString('en-US');
const pct = (value: number | undefined): string =>
  value === undefined ? '–' : `${Math.round(value * 100)} %`;
const opt = (value: number | undefined): string => (value === undefined ? '–' : fmt(value));

function AnnualTable({ rows, sandbox }: { rows: AnnualRow[]; sandbox: boolean }) {
  const { t } = useI18n();
  const total = daysPerYear();
  return (
    <section className="stats-chart">
      <h3>{t('stats.annual')}</h3>
      <div className="stats-table-wrap">
        <table className="stats-table">
          <thead>
            <tr>
              <th>{t('stats.col.year')}</th>
              <th>{t('stats.col.population')}</th>
              <th>{t('stats.col.jobs')}</th>
              <th>{t('stats.col.happiness')}</th>
              <th>{t('stats.col.generation')}</th>
              <th>{t('stats.col.consumption')}</th>
              <th>{t('stats.col.renewable')}</th>
              <th>{t('stats.col.import')}</th>
              <th>{t('stats.col.export')}</th>
              <th>{t('stats.col.deficit')}</th>
              {!sandbox && <th>{t('stats.col.money')}</th>}
              {!sandbox && <th>{t('stats.col.moneyDelta')}</th>}
            </tr>
          </thead>
          <tbody>
            {[...rows].reverse().map((row) => (
              <tr key={row.year} className={row.complete ? undefined : 'stats-row-running'}>
                <td>
                  {row.year}
                  {!row.complete && (
                    <small> {t('stats.annual.running', { days: row.days, total })}</small>
                  )}
                </td>
                <td>{fmt(row.population)}</td>
                <td>{fmt(row.jobs)}</td>
                <td>{pct(row.happiness)}</td>
                <td>{fmt(row.generation)}</td>
                <td>{fmt(row.consumption)}</td>
                <td>{pct(row.renewableShare)}</td>
                <td>{opt(row.gridImport)}</td>
                <td>{opt(row.gridExport)}</td>
                <td>{opt(row.deficitTicks)}</td>
                {!sandbox && <td>{fmt(row.moneyEnd)}</td>}
                {!sandbox && <td>{(row.moneyDelta >= 0 ? '+' : '') + fmt(row.moneyDelta)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Lifetime statistics: one sample per in-game day since founding, folded into years. */
export function StatsPage({
  bridge,
  sandbox,
  storage,
  onClose,
}: {
  bridge: SimBridge;
  /** Sandbox city: the treasury is pinned, so its chart would be a flat line. */
  sandbox: boolean;
  storage: SaveStorage;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [data, setData] = useState<LifetimeData | null>(null);
  const [saves, setSaves] = useState<SaveSummary[]>([]);
  const [compareId, setCompareId] = useState('');
  const [other, setOther] = useState<(LifetimeData & { sandbox: boolean }) | null>(null);

  const { send, onLifetime } = bridge;
  useEffect(() => {
    const unsubscribe = onLifetime((next) => setData(next));
    send({ type: 'requestLifetime' });
    return unsubscribe;
  }, [send, onLifetime]);

  useEffect(() => {
    void storage.list().then(setSaves);
  }, [storage]);

  useEffect(() => {
    if (!compareId) {
      setOther(null);
      return;
    }
    let cancelled = false;
    void storage.load(compareId).then((save) => {
      if (cancelled || !save) return;
      setOther({
        samples: save.lifetime ?? [],
        seasonOriginDay: save.seasonOriginDay ?? Math.floor(save.tick / TICKS_PER_DAY),
        sandbox: save.sandbox === true,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [storage, compareId]);

  const samples = data?.samples ?? [];
  const rows = useMemo(
    () =>
      data ? annualReport(data.samples, data.seasonOriginDay, daysPerYear(), TICKS_PER_DAY) : [],
    [data],
  );

  const series = (
    pick: (s: LifetimeSample) => number | undefined,
    color: string,
    label: string,
    { money = false } = {},
  ) => {
    const own = { values: samples.map((s) => pick(s) ?? NaN), color, label };
    if (!data || !other || (money && other.sandbox)) return [own];
    return [own, { values: alignSeries(data, other, pick), color, label, dashed: true }];
  };

  const exportCsv = (kind: 'days' | 'years'): void => {
    const text = kind === 'days' ? lifetimeCsv(samples, sandbox) : annualCsv(rows, sandbox);
    void exportTextFile(csvFileName(kind, new Date()), text);
  };

  return (
    <Modal title={t('stats.title')} onClose={onClose} testId="stats-page">
      <div className="stats-toolbar">
        <label>
          {t('stats.compare')}{' '}
          <select value={compareId} onChange={(e) => setCompareId(e.target.value)}>
            <option value="">{t('stats.compare.none')}</option>
            {compareOptions(saves).map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => exportCsv('days')} disabled={samples.length === 0}>
          {t('stats.csvDays')}
        </button>
        <button type="button" onClick={() => exportCsv('years')} disabled={rows.length === 0}>
          {t('stats.csvYears')}
        </button>
      </div>
      {other && <p className="stats-hint">{t('stats.compare.hint')}</p>}
      {samples.length < 2 ? (
        <p className="stats-empty">{t('stats.empty')}</p>
      ) : (
        <>
          <AnnualTable rows={rows} sandbox={sandbox} />
          <Chart
            title={t('stats.population')}
            series={[
              ...series((s) => s.population, '#67c26b', t('hud.residents')),
              ...series((s) => s.jobs, '#5b8fd6', t('hud.jobs')),
            ]}
          />
          <Chart
            title={t('stats.energy')}
            series={[
              ...series((s) => s.avgGeneration, '#7be07f', t('energy.legend.generation')),
              ...series((s) => s.avgConsumption, '#e0788a', t('energy.legend.consumption')),
            ]}
          />
          <Chart
            title={t('stats.gridTrade')}
            series={[
              ...series((s) => s.gridImport, '#f28c6b', t('energy.legend.import')),
              ...series((s) => s.gridExport, '#6bc5f2', t('energy.legend.export')),
            ]}
          />
          <Chart
            title={t('stats.deficit')}
            series={series((s) => s.deficitTicks, '#e05a5a', t('stats.col.deficit'))}
          />
          {!sandbox && (
            <Chart
              title={t('stats.money')}
              series={series((s) => s.money, '#ffd166', '⌁', { money: true })}
            />
          )}
          <Chart
            title={t('stats.happiness')}
            series={series((s) => s.happiness * 100, '#d6a2e8', '%')}
          />
          <Chart
            title={t('stats.temperature')}
            series={series((s) => s.temperature, '#f4a261', '°C')}
          />
        </>
      )}
    </Modal>
  );
}
```

Note: `series` for happiness passes `s.happiness * 100`; `alignSeries` applies the same `pick`, so the compared line is scaled too.

- [ ] **Step 3: Wire `storage` in `App.tsx`**

```tsx
{
  page === 'stats' && (
    <StatsPage
      bridge={bridge}
      sandbox={bridge.stats?.sandbox ?? false}
      storage={storage}
      onClose={() => setPage(null)}
    />
  );
}
```

- [ ] **Step 4: CSS**

Append after `.stats-empty` in `src/ui/app.css`:

```css
.stats-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  font-size: 12px;
}

.stats-toolbar select {
  max-width: 220px;
}

.stats-hint {
  color: var(--hud-muted);
  font-size: 11px;
  margin-top: 6px;
}

.stats-table-wrap {
  overflow-x: auto;
}

.stats-table {
  border-collapse: collapse;
  font-size: 11px;
  white-space: nowrap;
}

.stats-table th,
.stats-table td {
  padding: 3px 8px;
  text-align: right;
  border-bottom: 1px solid var(--hud-border);
}

.stats-table th:first-child,
.stats-table td:first-child {
  text-align: left;
}

.stats-row-running td {
  color: var(--hud-muted);
}
```

Check that `.stats-toolbar button` picks up the existing modal button styling (grep `.saves-page button` or similar and reuse its class if buttons in modals use one).

- [ ] **Step 5: Typecheck, lint, tests**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all green.

- [ ] **Step 6: Smoke check**

Run `node scripts/smoke.mjs` (headless). On the Mac: `pnpm dev`, open the stats page after a few in-game days, check the table, the two new charts, pick a save in "Compare with", export both CSVs and open one in a spreadsheet. If an e2e test opens the stats page (`grep -rn "stats-page" e2e/`), run `pnpm e2e` on the Mac.

- [ ] **Step 7: Commit**

```bash
pnpm format
git add src/ui/StatsPage.tsx src/ui/App.tsx src/ui/i18n.tsx src/ui/app.css
git -c user.name='Thorsten Rinne' -c user.email='thorsten@phpmyfaq.de' commit -m "ui: annual report table, trade and deficit charts, save comparison, CSV export

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Docs bookkeeping

**Files:**

- Modify: `docs/plan.md:224, 227-233`
- Modify: `docs/idea.md` ("Annual report / statistics replay" bullet, line ~398)

- [ ] **Step 1: Tick the items**

`docs/plan.md`: change `- [ ] Mac: \`pnpm tauri build\` and the Cmd+Q save-then-relaunch check`to`- [x] Mac: \`pnpm tauri build\` (2026-10-19)`and keep a separate`- [ ] Mac: Cmd+Q save-then-relaunch check` line. Under "Post-MVP" append:

```
- [x] Annual report: energy outcome fields in the daily sample, a per-year table and two more charts on the statistics page, compare-with-save overlay, CSV export, `get_annual_report` agent tool (spec: `docs/superpowers/specs/2026-10-20-annual-report-design.md`)
```

`docs/idea.md`: change `- **Annual report / statistics replay**: multi-year time series, comparison of two saves, CSV export.` to:

```
- **Annual report / statistics replay** (done): the daily sample now
  records renewable output, grid import/export, curtailment and deficit
  ticks; the statistics page folds the 365-day history (18 in-game years)
  into a per-year table, adds trade and deficit charts, overlays a second
  save founding-aligned and exports days or years as CSV. Agents use
  `get_annual_report`.
```

- [ ] **Step 2: Commit**

```bash
pnpm format
git add docs/plan.md docs/idea.md
git -c user.name='Thorsten Rinne' -c user.email='thorsten@phpmyfaq.de' commit -m "docs: record the annual report and the native build check

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
