import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_NEW_GAME, DISASTER_LEVELS } from './newGame.ts';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

describe('disaster levels', () => {
  it('offers off, mild, normal and harsh', () => {
    expect(DISASTER_LEVELS.map((level) => level.id)).toEqual(['off', 'mild', 'normal', 'harsh']);
  });

  it('rises monotonically from off to harsh', () => {
    const scales = DISASTER_LEVELS.map((level) => level.scale);
    expect(scales[0]).toBe(0);
    for (let i = 1; i < scales.length; i++) expect(scales[i]).toBeGreaterThan(scales[i - 1]);
  });

  it('defaults a new city to normal', () => {
    expect(DEFAULT_NEW_GAME.disasterScale).toBe(1);
  });
});

describe('pending scenario', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
    vi.resetModules();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('stores and consumes a pending scenario', async () => {
    const m = await import('./newGame.ts');
    m.storePendingScenario('island');
    expect(m.consumePendingNewGame().scenario).toBe('island');
  });

  it('drops an unknown scenario id', async () => {
    const m = await import('./newGame.ts');
    localStorage.setItem('voltopia.pendingNewGame', JSON.stringify({ scenario: 'nope' }));
    expect(m.consumePendingNewGame().scenario).toBeUndefined();
  });
});
