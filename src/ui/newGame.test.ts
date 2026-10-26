import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BALANCE } from '../shared/constants.ts';
import { Terrain, TownRoad, Zone, type TownLayout } from '../shared/types.ts';
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

describe('pending town layout', () => {
  const size = 48;
  const tiles = size * size;
  const layout = (): TownLayout => {
    const made: TownLayout = {
      size,
      terrain: new Uint8Array(tiles),
      forest: new Uint8Array(tiles),
      road: new Uint8Array(tiles),
      pedestrian: new Uint8Array(tiles),
      rail: new Uint8Array(tiles),
      zone: new Uint8Array(tiles),
      density: new Uint8Array(tiles),
      name: 'Testhausen',
      bbox: [10.7, 48.1, 10.75, 48.14],
    };
    for (let x = 0; x < size; x++) made.road[20 * size + x] = TownRoad.Avenue;
    made.terrain[5] = Terrain.River;
    made.forest[6] = BALANCE.forest.maxStage;
    made.zone[21 * size + 3] = Zone.Residential;
    made.density[21 * size + 3] = 2;
    return made;
  };

  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
    vi.resetModules();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('round-trips a layout through the pending store', async () => {
    const m = await import('./newGame.ts');
    const original = layout();
    m.storePendingNewGame({ ...m.DEFAULT_NEW_GAME, size, layout: original });
    const options = m.consumePendingNewGame();
    expect(options.size).toBe(size);
    expect(options.layout).toBeDefined();
    for (const layer of m.LAYOUT_LAYERS) {
      expect(Array.from(options.layout![layer])).toEqual(Array.from(original[layer]));
    }
    expect(options.layout!.name).toBe('Testhausen');
    expect(options.layout!.bbox).toEqual(original.bbox);
  });

  it('encodes every layer as base64url text', async () => {
    const m = await import('./newGame.ts');
    const code = m.encodePendingLayout(layout());
    expect(Object.keys(code.layers).sort()).toEqual([...m.LAYOUT_LAYERS].sort());
    for (const text of Object.values(code.layers)) expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    // base64url: 4 characters per 3 bytes, plus the header.
    expect(JSON.stringify(code).length).toBeLessThan(tiles * m.LAYOUT_LAYERS.length * 1.5);
  });

  it('drops a corrupt code with a warning and keeps the other options', async () => {
    const m = await import('./newGame.ts');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const code = m.encodePendingLayout(layout());
    code.layers.road = '!!not base64!!';
    localStorage.setItem(
      'voltopia.pendingNewGame',
      JSON.stringify({ ...m.DEFAULT_NEW_GAME, size, layoutCode: code }),
    );
    const options = m.consumePendingNewGame();
    expect(options.layout).toBeUndefined();
    expect(options.size).toBe(size);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('drops a layout whose layers do not match the map size', async () => {
    const m = await import('./newGame.ts');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const oversize = { ...layout(), terrain: new Uint8Array(tiles + 1) };
    expect(m.decodePendingLayout(m.encodePendingLayout(oversize), size)).toBeNull();
    // A layout of another size than the chosen map falls back as well.
    expect(m.decodePendingLayout(m.encodePendingLayout(layout()), 64)).toBeNull();
    // And a size the game does not offer.
    expect(m.decodePendingLayout({ ...m.encodePendingLayout(layout()), size: 50 }, 50)).toBeNull();
  });

  it('rejects a layer value outside its enum range', async () => {
    const m = await import('./newGame.ts');
    const bad = layout();
    bad.zone[0] = 9;
    expect(m.decodePendingLayout(m.encodePendingLayout(bad), size)).toBeNull();
  });

  it('ignores a missing or non-object code', async () => {
    const m = await import('./newGame.ts');
    expect(m.decodePendingLayout(undefined, size)).toBeNull();
    expect(m.decodePendingLayout('nope', size)).toBeNull();
    expect(m.decodePendingLayout({ size, layers: null }, size)).toBeNull();
    expect(m.decodePendingLayout({ size, layers: { terrain: 1 } }, size)).toBeNull();
  });

  it('never carries a layout into a scenario start', async () => {
    const m = await import('./newGame.ts');
    localStorage.setItem(
      'voltopia.pendingNewGame',
      JSON.stringify({ scenario: 'island', layoutCode: m.encodePendingLayout(layout()) }),
    );
    expect(m.consumePendingNewGame().layout).toBeUndefined();
  });
});
