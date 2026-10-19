import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BALANCE } from '../shared/constants.ts';
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
    const options = m.consumePendingNewGame();
    expect(options.scenario).toBe('island');
    expect(options.size).toBe(BALANCE.scenarios.island.size);
  });

  it('drops an unknown scenario id', async () => {
    const m = await import('./newGame.ts');
    localStorage.setItem('voltopia.pendingNewGame', JSON.stringify({ scenario: 'nope' }));
    expect(m.consumePendingNewGame().scenario).toBeUndefined();
  });
});

describe('pending sandbox', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
    vi.resetModules();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('reads back a stored sandbox flag', async () => {
    const m = await import('./newGame.ts');
    m.storePendingNewGame({ ...m.DEFAULT_NEW_GAME, sandbox: true });
    expect(m.consumePendingNewGame().sandbox).toBe(true);
  });

  it('drops a sandbox value that is not true', async () => {
    const m = await import('./newGame.ts');
    localStorage.setItem('voltopia.pendingNewGame', JSON.stringify({ sandbox: 'yes' }));
    expect('sandbox' in m.consumePendingNewGame()).toBe(false);
  });

  it('never carries sandbox into a scenario start', async () => {
    const m = await import('./newGame.ts');
    localStorage.setItem(
      'voltopia.pendingNewGame',
      JSON.stringify({ scenario: 'island', sandbox: true }),
    );
    const options = m.consumePendingNewGame();
    expect(options.scenario).toBe('island');
    expect('sandbox' in options).toBe(false);
  });

  it('reads options without sandbox back without the key', async () => {
    const m = await import('./newGame.ts');
    m.storePendingNewGame({ ...m.DEFAULT_NEW_GAME });
    expect('sandbox' in m.consumePendingNewGame()).toBe(false);
  });
});
