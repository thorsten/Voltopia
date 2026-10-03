import { describe, expect, it } from 'vitest';
import { BALANCE } from './constants.ts';
import { coolingDegree, heatingDegree } from './heating.ts';

const { seasons } = BALANCE;

describe('heatingDegree', () => {
  it('is 0 at or above the comfort temperature', () => {
    expect(heatingDegree(seasons.heating.comfortTemperature)).toBe(0);
    expect(heatingDegree(30)).toBe(0);
  });

  it('reaches 1 at the bottom of the heating range and is linear between', () => {
    const { comfortTemperature, heatingRange } = seasons.heating;
    expect(heatingDegree(comfortTemperature - heatingRange)).toBe(1);
    expect(heatingDegree(comfortTemperature - heatingRange - 10)).toBe(1);
    expect(heatingDegree(comfortTemperature - heatingRange / 2)).toBeCloseTo(0.5, 9);
  });
});

describe('coolingDegree', () => {
  it('is 0 at or below the cooling comfort temperature', () => {
    expect(coolingDegree(seasons.cooling.comfortTemperature)).toBe(0);
    expect(coolingDegree(-10)).toBe(0);
  });

  it('reaches 1 at the top of the cooling range and is linear between', () => {
    const { comfortTemperature, coolingRange } = seasons.cooling;
    expect(coolingDegree(comfortTemperature + coolingRange)).toBe(1);
    expect(coolingDegree(comfortTemperature + coolingRange + 10)).toBe(1);
    expect(coolingDegree(comfortTemperature + coolingRange / 2)).toBeCloseTo(0.5, 9);
  });

  it('never overlaps with heating: no temperature has both loads', () => {
    for (let t = -20; t <= 40; t += 0.5) {
      expect(heatingDegree(t) * coolingDegree(t)).toBe(0);
    }
  });
});
