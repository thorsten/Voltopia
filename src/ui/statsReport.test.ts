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
