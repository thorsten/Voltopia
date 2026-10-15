import { describe, expect, it } from 'vitest';
import { currentCityFileName, nameFromFileName, saveFileName, slugify } from './saveFiles.ts';

const DATE = new Date('2026-10-15T12:00:00Z');

describe('slugify', () => {
  it('lowercases and joins words with dashes', () => {
    expect(slugify('Voltopia – day 12')).toBe('voltopia-day-12');
  });

  it('folds umlauts, accents and ß', () => {
    expect(slugify('Große Brücke über Café')).toBe('grosse-brucke-uber-cafe');
  });

  it('trims stray dashes and caps the length', () => {
    expect(slugify('  --Hello!-- ')).toBe('hello');
    expect(slugify('a'.repeat(100))).toHaveLength(48);
  });

  it('is empty when nothing usable is left', () => {
    expect(slugify('🌞 ⚡')).toBe('');
  });
});

describe('saveFileName', () => {
  it('builds voltopia-<slug>-<date>.json', () => {
    expect(saveFileName('Testville', DATE)).toBe('voltopia-testville-2026-10-15.json');
  });

  it('falls back to "save" for an empty slug', () => {
    expect(saveFileName('⚡', DATE)).toBe('voltopia-save-2026-10-15.json');
  });

  it('keeps the current-city export name', () => {
    expect(currentCityFileName(DATE)).toBe('voltopia-save-2026-10-15.json');
  });
});

describe('nameFromFileName', () => {
  it('drops the .json extension', () => {
    expect(nameFromFileName('voltopia-testville-2026-10-15.json', 'Import')).toBe(
      'voltopia-testville-2026-10-15',
    );
    expect(nameFromFileName('My City.JSON', 'Import')).toBe('My City');
  });

  it('falls back when nothing is left', () => {
    expect(nameFromFileName('.json', 'Import')).toBe('Import');
  });
});
