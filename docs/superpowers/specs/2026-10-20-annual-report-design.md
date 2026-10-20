# Annual report — Design

Date: 2026-10-20
Status: draft for review

## Goal

The statistics page shows one sample per in-game day since founding
(population, jobs, happiness, average generation and consumption,
money, temperature, heating, cooling) as five line charts. A year is 20
in-game days (4 seasons × 5 days) and the sample cap of 365 days keeps
about 18 years, so the multi-year series already exists. What is
missing: a per-year summary, the energy figures that tell whether a
year went well (import, export, deficit, renewable share), a way to
compare two cities, and a CSV export.

## Decisions (with the user, 2026-10-19)

- All four parts: annual table, CSV export, comparison with a second
  save, `get_annual_report` agent tool.
- **Aggregate outside the sim** (rejected: a persisted `lifetime.years`
  list in the sim state). The sim keeps writing one daily sample; a
  pure function in `src/shared/` folds samples into years. UI, CSV and
  the agent tool share that function, and a second save compares for
  free because it only has to provide its samples. The 365-day cap
  (18 years) stays.

## Scope

In: five new optional sample fields, the shared aggregation and CSV
functions, the annual table and two new charts on the statistics page,
the compare-with-save overlay, CSV export buttons, the agent tool,
docs, i18n (en + de), tests. Tick the native build item in
`docs/plan.md`.

Out: history beyond the 365-day cap, per-island or per-plant history,
comparing more than two saves, a comparison column in the table,
charts of the compared save's money (compared save may be a sandbox),
screenshots/PNG export, share links carrying the history (still
stripped by the share codec).

## Daily samples

`LifetimeSample` (`src/shared/types.ts`) gains optional fields, all
absent in samples recorded before this change:

| Field          | Meaning                                                                            |
| -------------- | ---------------------------------------------------------------------------------- |
| `renewable`    | Average per tick of solar + wind + rooftop + hydro + tidal + geothermal + fuelCell |
| `gridImport`   | Average per tick of `lastEnergy.gridImport`                                        |
| `gridExport`   | Average per tick of `lastEnergy.gridExport`                                        |
| `curtailment`  | Average per tick of `lastEnergy.curtailment`                                       |
| `deficitTicks` | Number of ticks in the day with `lastEnergy.deficit > 0`                           |

The renewable sum matches `src/sim/scenarios/step.ts` so the
scenario's renewable share and the report agree. Averages per tick
follow the existing fields (`avgGeneration`, `heating`); a day total is
the average × `TICKS_PER_DAY`.

`recordLifetime` in `src/sim/tick.ts` sums them in `lifetime.daySums`
and resets the sums at the day rollover like the others. The sums are
in-memory only (not saved), as today.

The `lifetimeData` worker message (`src/shared/messages.ts`) carries
`seasonOriginDay` next to `samples`; the UI needs it to cut years.
`serializeState` / `loadState` and `saveToJson` / `saveFromJson` pass
the new fields through (the lifetime validator in
`src/storage/serialization.ts` is per-sample and must accept them).

## Shared aggregation

New file `src/shared/annualReport.ts` (no DOM, no sim imports):

```ts
export interface AnnualRow {
  year: number; // 1-based, as SeasonState.year
  days: number; // samples in the year (20 = complete)
  complete: boolean; // days === daysPerYear
  population: number; // last sample of the year
  jobs: number; // last sample
  happiness: number; // mean over the year, 0..1
  generation: number; // sum over the year (per-tick average × ticks per day)
  consumption: number; // sum
  moneyEnd: number; // last sample
  moneyDelta: number; // moneyEnd − money at the end of the previous year (first year: − first sample)
  renewableShare?: number; // renewable / (renewable + biogas + import), 0..1
  gridImport?: number; // sum
  gridExport?: number; // sum
  curtailment?: number; // sum
  deficitTicks?: number; // sum
}

export function annualReport(
  samples: LifetimeSample[],
  seasonOriginDay: number,
  daysPerYear: number,
  ticksPerDay: number,
): AnnualRow[];
```

- Year of a sample: `Math.floor((sample.day - seasonOriginDay) / daysPerYear) + 1`.
  Samples before `seasonOriginDay` (old saves loaded before seasons
  existed) count as year 1 with `days` possibly above `daysPerYear`;
  they never occur in new cities.
- The optional figures are `undefined` for a year in which any sample
  lacks the field; a partial year is never reported with partial sums.
  Biogas is not in the sample today: `renewableShare` uses
  `generation − renewable` as the biogas term, so no sixth field is
  needed (generation = all own plants, see `recordLifetime`).
- Rows are oldest first; the current, incomplete year is the last row
  with `complete: false`.

CSV in the same file:

```ts
export function lifetimeCsv(samples: LifetimeSample[], sandbox: boolean): string;
export function annualCsv(rows: AnnualRow[], sandbox: boolean): string;
```

- Header row with the field names, `,` separator, `\n` line ends,
  numbers with `.` decimal and at most 2 decimals, empty cell for a
  missing optional value, no quoting needed (no text columns). In a
  sandbox city the money columns are left out, matching
  `get_lifetime_stats`.

## Statistics page

`src/ui/StatsPage.tsx` (modal, opened from the HUD console as today):

1. **Toolbar** above the content: a `<select>` "Compare with…" listing
   the save slots from `storage.list()` (compatible, not the current
   autosave; label `name · day N`), default "none"; two buttons
   "CSV days" and "CSV years".
2. **Annual table**: one row per `AnnualRow`, newest first, the running
   year marked ("year 3 · 7 of 20 days"). Columns: year, residents,
   jobs, happiness %, generation, consumption, renewable %, import,
   export, deficit ticks, treasury end, Δ treasury. Money columns are
   hidden in a sandbox city; optional figures show "–". Numbers use the
   existing compact formatting of the budget panel.
3. **Charts**: the five existing charts, plus "Grid import & export"
   (two lines) and "Deficit ticks per day" (one line). Missing optional
   values break the line (`NaN`, as temperature does today).
4. **Comparison**: choosing a save loads it via `storage.load(id)` and
   reads `save.lifetime` and `save.seasonOriginDay`. Its series are
   drawn dashed in the same colour, aligned by **year** (its day 1 of
   year 1 under our day 1 of year 1), so two cities of different age
   line up at founding. The money chart does not draw the compared
   save when it is a sandbox. The table stays single-city.
5. **CSV export**: `exportTextFile(name, csv)` from `src/ui/platform.ts`
   (web download, native save dialog). File names
   `voltopia-days-<YYYY-MM-DD>.csv`, `voltopia-years-<YYYY-MM-DD>.csv`.

The `StatsPage` currently receives `bridge` and `sandbox`; it also
needs the `SaveStorage` (as `SavesPage` has it) for the compare list.

i18n keys (en + de): `stats.compare`, `stats.compare.none`,
`stats.csvDays`, `stats.csvYears`, `stats.annual`, `stats.annual.running`,
column headers `stats.col.*`, chart titles `stats.gridTrade`,
`stats.deficit`.

## Agent tools

- `get_annual_report` (read-only): `{ years: AnnualRow[] }`, rounded
  like `get_lifetime_stats`; money fields left out in a sandbox city.
  Description names the year length and that the last row may be
  running.
- `get_lifetime_stats`: returns the five new fields when present.
- `docs/agent-tools.md`: new table row, update the lifetime row.

## Tests

- `src/shared/annualReport.test.ts`: year cut via `seasonOriginDay`
  (origin 0 and origin 7), a running last year, samples without the
  optional fields give `undefined` for that year only, `moneyDelta` of
  the first year, `renewableShare` with and without import, CSV header,
  missing cells, sandbox columns, rounding.
- `src/sim/engine.test.ts` (or `tick`-level test): after one full day
  the sample carries `deficitTicks`, `gridImport`, `renewable` matching
  the sums of the ticks.
- `src/storage/serialization.test.ts`: round trip keeps the new fields.
- `src/agent/tools.test.ts`: `get_annual_report` on a headless engine
  run for two years returns two rows, the second running; sandbox drops
  money.
- `src/ui/StatsPage` logic that is not JSX (year alignment of the
  compared series, file names) goes into `src/ui/statsReport.ts` with
  its own test, as `scenarioFormat.ts` does.

## Risks

- Per-tick cost: five additions per tick, negligible.
- Save size: five numbers per day, 365 days: under 20 KB of JSON at
  most; the share codec strips `lifetime` anyway.
- A save from before seasons has `seasonOriginDay` set on load to its
  day; samples before it fall into year 1 as documented.
