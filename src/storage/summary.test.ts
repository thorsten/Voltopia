import { describe, expect, it } from 'vitest';
import { SAVE_VERSION, TICKS_PER_DAY } from '../shared/constants.ts';
import type { LifetimeSample, SaveGame } from '../shared/types.ts';
import { newSlotId } from './storage.ts';
import { dayOfTick, defaultSaveName, summarizeSave } from './summary.ts';

function sample(day: number, population: number): LifetimeSample {
  return {
    day,
    population,
    jobs: 0,
    happiness: 0.5,
    avgGeneration: 0,
    avgConsumption: 0,
    money: 0,
  };
}

function makeSave(overrides: Partial<SaveGame> = {}): SaveGame {
  return {
    version: SAVE_VERSION,
    seed: 1,
    size: 64,
    tick: 0,
    money: 5000,
    taxRate: 0.1,
    layers: {} as SaveGame['layers'],
    ...overrides,
  };
}

describe('summarizeSave', () => {
  it('derives the day, money and size from the save', () => {
    const summary = summarizeSave(
      makeSave({ tick: 2 * TICKS_PER_DAY + 5, money: 1234, size: 128 }),
      'Testville',
      42,
    );
    expect(summary).toEqual({
      id: '',
      name: 'Testville',
      savedAt: 42,
      day: 3,
      population: 0,
      money: 1234,
      size: 128,
      compatible: true,
    });
  });

  it('starts on day 1 with no population', () => {
    const summary = summarizeSave(makeSave(), 'New', 0);
    expect(summary.day).toBe(1);
    expect(summary.population).toBe(0);
  });

  it('takes the population from the last lifetime sample', () => {
    const save = makeSave({ lifetime: [sample(1, 10), sample(2, 25)] });
    expect(summarizeSave(save, 'x', 0).population).toBe(25);
  });

  it('prefers a live population override', () => {
    const save = makeSave({ lifetime: [sample(1, 10)] });
    expect(summarizeSave(save, 'x', 0, 17).population).toBe(17);
  });

  it('flags saves of another version as incompatible', () => {
    expect(summarizeSave(makeSave({ version: SAVE_VERSION + 1 }), 'x', 0).compatible).toBe(false);
  });
});

describe('newSlotId', () => {
  it('combines the time and four random characters in base 36', () => {
    expect(newSlotId(36 ** 3, () => 0)).toBe('save-1000-0000');
    expect(newSlotId(35, () => 0.999999)).toMatch(/^save-z-[0-9a-z]{4}$/);
  });

  it('produces different ids for different random draws', () => {
    expect(newSlotId(1, () => 0.1)).not.toBe(newSlotId(1, () => 0.2));
  });
});

describe('defaultSaveName', () => {
  it('names the city and the day in English by default', () => {
    expect(defaultSaveName(12)).toBe('Voltopia – day 12');
  });

  it('fills a translated template', () => {
    expect(defaultSaveName(3, '{city} – Tag {day}')).toBe('Voltopia – Tag 3');
  });

  it('counts days from 1', () => {
    expect(dayOfTick(0)).toBe(1);
    expect(dayOfTick(TICKS_PER_DAY)).toBe(2);
  });
});
