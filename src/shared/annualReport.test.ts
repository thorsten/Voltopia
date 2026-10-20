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
    biogas: 0.5,
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

  it('computes the renewable share against renewable plus biogas plus import', () => {
    const rows = annualReport([sample(0)], 0, DAYS, TICKS);
    // renewable 1.5 / (renewable 1.5 + biogas 0.5 + import 0.5)
    expect(rows[0].renewableShare).toBeCloseTo(0.6, 6);
    const noImport = annualReport(
      [sample(0, { gridImport: 0, biogas: 0, renewable: 2 })],
      0,
      DAYS,
      TICKS,
    );
    expect(noImport[0].renewableShare).toBe(1);
    const nothing = annualReport(
      [sample(0, { gridImport: 0, biogas: 0, renewable: 0 })],
      0,
      DAYS,
      TICKS,
    );
    expect(nothing[0].renewableShare).toBe(1);
  });

  it('keeps the share within 0..1 when fuel cells push renewable above generation', () => {
    // Fuel cells count as renewable but not as generation: renewable 3 > avgGeneration 2.
    const rows = annualReport(
      [sample(0, { renewable: 3, biogas: 0.25, gridImport: 0.75 })],
      0,
      DAYS,
      TICKS,
    );
    expect(rows[0].renewableShare).toBeCloseTo(3 / (3 + 0.25 + 0.75), 6);
    expect(rows[0].renewableShare).toBeLessThanOrEqual(1);
  });

  it('marks a short first year complete when a later year follows', () => {
    // Scenario city: origin -15 with 20-day years, year 1 covers days 0..4 (5 samples);
    // 24 samples leave year 2 one day short, so it is still running.
    const samples = Array.from({ length: 24 }, (_, day) => sample(day));
    const rows = annualReport(samples, -15, 20, TICKS);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ year: 1, days: 5, complete: true });
    expect(rows[1]).toMatchObject({ year: 2, days: 19, complete: false });
  });

  it('marks a truncated oldest year complete', () => {
    // History capped: the first stored sample is day 3, mid-year 1.
    const samples = Array.from({ length: 45 }, (_, i) => sample(i + 3));
    const rows = annualReport(samples, 0, DAYS, TICKS);
    expect(rows[0]).toMatchObject({ year: 1, days: 1, complete: true });
    expect(rows[rows.length - 1].complete).toBe(rows[rows.length - 1].days >= DAYS);
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
      'day,population,jobs,happiness,avgGeneration,avgConsumption,money,temperature,heating,cooling,renewable,biogas,gridImport,gridExport,curtailment,deficitTicks',
    );
    expect(row).toBe('0,100,50,0.5,2,1,12345.68,21.46,,,1.5,0.5,0.5,0.25,0.1,1');
  });

  it('drops the money column in a sandbox city', () => {
    const csv = lifetimeCsv([sample(0)], true);
    expect(csv.split('\n')[0]).not.toContain('money');
    expect(csv.split('\n')[1].split(',')).toHaveLength(15);
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

  it('drops moneyEnd and moneyDelta from the annual rows in a sandbox city', () => {
    const rows = annualReport([sample(0), sample(1)], 0, DAYS, TICKS);
    const [header, row] = annualCsv(rows, true).split('\n');
    expect(header).not.toContain('moneyEnd');
    expect(header).not.toContain('moneyDelta');
    expect(header.split(',')).toHaveLength(13);
    expect(row.split(',')).toHaveLength(13);
  });

  it('writes only the header without rows', () => {
    expect(annualCsv([], true).split('\n')).toHaveLength(1);
  });
});
