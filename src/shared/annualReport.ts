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
