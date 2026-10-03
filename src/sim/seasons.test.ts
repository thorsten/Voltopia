import { describe, expect, it } from 'vitest';
import { BALANCE } from '../shared/constants.ts';
import { daysPerYear, seasonState, yearPhase } from './seasons.ts';

const { seasons } = BALANCE;

function at(day: number, timeOfDay = 0, seasonOriginDay = 0, cloudCover = 0) {
  return seasonState({ day, timeOfDay, seasonOriginDay, cloudCover });
}

describe('yearPhase', () => {
  it('is 0 on the first spring day and wraps after a year', () => {
    expect(yearPhase(0, 0, 0)).toBe(0);
    expect(yearPhase(daysPerYear(), 0, 0)).toBe(0);
    expect(yearPhase(daysPerYear() / 2, 0, 0)).toBeCloseTo(0.5, 9);
  });

  it('is continuous within a day', () => {
    expect(yearPhase(3, 0.5, 0)).toBeCloseTo(3.5 / daysPerYear(), 9);
  });

  it('counts from the season origin', () => {
    expect(yearPhase(12, 0, 12)).toBe(0);
    expect(yearPhase(13, 0, 12)).toBeCloseTo(1 / daysPerYear(), 9);
  });
});

describe('seasonState', () => {
  it('maps days to seasons in order', () => {
    const d = seasons.daysPerSeason;
    expect(at(0).season).toBe('spring');
    expect(at(d - 1).season).toBe('spring');
    expect(at(d).season).toBe('summer');
    expect(at(2 * d).season).toBe('autumn');
    expect(at(3 * d).season).toBe('winter');
    expect(at(4 * d - 1).season).toBe('winter');
    expect(at(4 * d).season).toBe('spring');
  });

  it('numbers the day of season and the year', () => {
    const d = seasons.daysPerSeason;
    expect(at(0).dayOfSeason).toBe(1);
    expect(at(d - 1).dayOfSeason).toBe(d);
    expect(at(d).dayOfSeason).toBe(1);
    expect(at(0).year).toBe(1);
    expect(at(daysPerYear()).year).toBe(2);
  });

  it('a legacy city starts its year on the origin day', () => {
    expect(at(37, 0, 37).season).toBe('spring');
    expect(at(37, 0, 37).dayOfSeason).toBe(1);
    expect(at(37, 0, 37).year).toBe(1);
  });

  it('keeps temperature within the configured bounds', () => {
    const lo = seasons.winterLow - seasons.diurnalAmplitude - seasons.cloudDamping;
    const hi = seasons.summerHigh + seasons.diurnalAmplitude;
    for (let day = 0; day < daysPerYear(); day++) {
      for (let t = 0; t < 1; t += 1 / 48) {
        for (const cloud of [0, 1]) {
          const { temperature } = at(day, t, 0, cloud);
          expect(temperature).toBeGreaterThanOrEqual(lo);
          expect(temperature).toBeLessThanOrEqual(hi);
        }
      }
    }
  });

  it('is warmer in summer than in winter and colder at night', () => {
    const d = seasons.daysPerSeason;
    expect(at(d + 2, 0.6).temperature).toBeGreaterThan(at(3 * d + 2, 0.6).temperature);
    expect(at(d + 2, seasons.coldestTime).temperature).toBeLessThan(at(d + 2, 0.6).temperature);
  });

  it('overcast days are cooler at noon but not at night', () => {
    expect(at(6, 0.5, 0, 1).temperature).toBeLessThan(at(6, 0.5, 0, 0).temperature);
    expect(at(6, 0, 0, 1).temperature).toBe(at(6, 0, 0, 0).temperature);
  });

  it('is continuous across day and year boundaries', () => {
    const before = at(daysPerYear() - 1, 1 - 1 / 960).temperature;
    const after = at(daysPerYear(), 0).temperature;
    expect(Math.abs(after - before)).toBeLessThan(0.1);
    const eve = at(4, 1 - 1 / 960).temperature;
    const dawn = at(5, 0).temperature;
    expect(Math.abs(dawn - eve)).toBeLessThan(0.1);
  });

  it('winter days are shorter than summer days, symmetric around noon', () => {
    const longest = at(Math.round(seasons.longestDayPhase * daysPerYear()));
    const shortest = at(Math.round((seasons.longestDayPhase + 0.5) * daysPerYear()));
    const hours = (s: { sunrise: number; sunset: number }) => (s.sunset - s.sunrise) * 24;
    expect(hours(longest)).toBeCloseTo(seasons.dayLengthHours.longest, 1);
    expect(hours(shortest)).toBeCloseTo(seasons.dayLengthHours.shortest, 1);
    expect(longest.sunrise + longest.sunset).toBeCloseTo(1, 9);
    expect(shortest.sunrise + shortest.sunset).toBeCloseTo(1, 9);
  });

  it('solar strength peaks on the longest day and bottoms on the shortest', () => {
    const longest = at(Math.round(seasons.longestDayPhase * daysPerYear()));
    const shortest = at(Math.round((seasons.longestDayPhase + 0.5) * daysPerYear()));
    expect(longest.solarStrength).toBeCloseTo(1, 1);
    expect(shortest.solarStrength).toBeCloseTo(seasons.winterSolarStrength, 1);
  });

  it('biases fronts toward cloud and wind in winter, away in summer', () => {
    const winter = at(Math.round((seasons.longestDayPhase + 0.5) * daysPerYear()));
    const summer = at(Math.round(seasons.longestDayPhase * daysPerYear()));
    expect(winter.cloudBias).toBeCloseTo(seasons.cloudBiasAmplitude, 1);
    expect(summer.cloudBias).toBeCloseTo(-seasons.cloudBiasAmplitude, 1);
    expect(winter.windBias).toBeGreaterThan(0);
    expect(summer.windBias).toBeLessThan(0);
  });
});
