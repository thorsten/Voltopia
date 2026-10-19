import { afterEach, describe, expect, it, vi } from 'vitest';
import { SAVE_VERSION } from '../shared/constants.ts';
import type { SaveGame } from '../shared/types.ts';
import { createMemoryStorage } from '../storage/memory.ts';
import { PUBLIC_WEB_URL } from './platform.ts';
import {
  copyToClipboard,
  datedName,
  extractShareCode,
  keepAndOpenShared,
  resetShareCodeCacheForTests,
  shareBaseUrl,
  shareSupported,
  shareUrl,
  takeShareCodeOnce,
} from './shareLink.ts';

const CODE = 'AbCdEfGhIjKlMnOp_-0123456789';

function makeSave(money: number): SaveGame {
  return {
    version: SAVE_VERSION,
    seed: 1,
    size: 64,
    tick: 0,
    money,
    taxRate: 0.1,
    layers: {} as SaveGame['layers'],
  };
}

describe('shareBaseUrl', () => {
  it('points native links at the public web build', () => {
    expect(shareBaseUrl({ native: true, origin: 'tauri://localhost', base: '/' })).toBe(
      PUBLIC_WEB_URL,
    );
  });
  it('uses the dev server root', () => {
    expect(shareBaseUrl({ native: false, origin: 'http://127.0.0.1:5199', base: '/' })).toBe(
      'http://127.0.0.1:5199/',
    );
  });
  it('keeps the GitHub Pages base path', () => {
    expect(
      shareBaseUrl({ native: false, origin: 'https://thorsten.github.io', base: '/Voltopia/' }),
    ).toBe('https://thorsten.github.io/Voltopia/');
  });
});

describe('shareUrl', () => {
  it('appends the code after #city=', () => {
    expect(shareUrl(CODE, 'https://x.test/Voltopia/')).toBe(
      `https://x.test/Voltopia/#city=${CODE}`,
    );
  });
});

describe('extractShareCode', () => {
  it('takes the code from a full link', () => {
    expect(extractShareCode(`https://thorsten.github.io/Voltopia/#city=${CODE}`)).toBe(CODE);
  });
  it('takes the code from a bare hash', () => {
    expect(extractShareCode(`#city=${CODE}`)).toBe(CODE);
  });
  it('accepts a bare code', () => {
    expect(extractShareCode(CODE)).toBe(CODE);
  });
  it('trims surrounding whitespace', () => {
    expect(extractShareCode(`  \n https://a.test/#city=${CODE}  \n`)).toBe(CODE);
    expect(extractShareCode(`\t${CODE} `)).toBe(CODE);
  });
  it('returns null without a usable code', () => {
    expect(extractShareCode('https://thorsten.github.io/Voltopia/')).toBeNull();
    expect(extractShareCode('')).toBeNull();
    expect(extractShareCode('   ')).toBeNull();
    expect(extractShareCode('#city=')).toBeNull();
    expect(extractShareCode('short')).toBeNull();
  });
});

describe('takeShareCodeOnce', () => {
  afterEach(() => resetShareCodeCacheForTests());

  it('strips the hash and caches the code', () => {
    const loc = { hash: `#city=${CODE}`, pathname: '/Voltopia/', search: '?lang=de' };
    const hist = { state: { a: 1 }, replaceState: vi.fn() };
    expect(takeShareCodeOnce(loc, hist)).toBe(CODE);
    expect(hist.replaceState).toHaveBeenCalledWith({ a: 1 }, '', '/Voltopia/?lang=de');
    // StrictMode's second effect run sees the stripped hash but still gets the code.
    loc.hash = '';
    expect(takeShareCodeOnce(loc, hist)).toBe(CODE);
    expect(hist.replaceState).toHaveBeenCalledOnce();
  });

  it('reads the code before stripping a live location', () => {
    const loc = { hash: `#city=${CODE}`, pathname: '/', search: '' };
    const hist = { state: null, replaceState: vi.fn(() => (loc.hash = '')) };
    expect(takeShareCodeOnce(loc, hist)).toBe(CODE);
  });

  it('leaves other hashes alone and caches null', () => {
    const loc = { hash: '#other', pathname: '/', search: '' };
    const hist = { state: null, replaceState: vi.fn() };
    expect(takeShareCodeOnce(loc, hist)).toBeNull();
    loc.hash = `#city=${CODE}`;
    expect(takeShareCodeOnce(loc, hist)).toBeNull();
    expect(hist.replaceState).not.toHaveBeenCalled();
  });

  it('is null without a window', () => {
    expect(takeShareCodeOnce()).toBeNull();
  });
});

describe('shareSupported', () => {
  it('is true where deflate-raw compression exists (node 22)', () => {
    expect(shareSupported()).toBe(true);
  });
  it('is false without CompressionStream', () => {
    vi.stubGlobal('CompressionStream', undefined);
    try {
      expect(shareSupported()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('copyToClipboard', () => {
  afterEach(() => vi.unstubAllGlobals());

  class FakeClipboardItem {
    constructor(readonly items: Record<string, Promise<Blob>>) {}
  }

  function stubNavigator(clipboard: Partial<Clipboard>): Navigator {
    return { clipboard } as unknown as Navigator;
  }

  it('writes a ClipboardItem with the promised text', async () => {
    vi.stubGlobal('ClipboardItem', FakeClipboardItem);
    const write = vi.fn(async (_items: ClipboardItems) => {});
    const writeText = vi.fn(async () => {});
    expect(
      await copyToClipboard(Promise.resolve('link'), stubNavigator({ write, writeText })),
    ).toBe(true);
    expect(write).toHaveBeenCalledOnce();
    expect(writeText).not.toHaveBeenCalled();
    const item = write.mock.calls[0][0][0] as unknown as FakeClipboardItem;
    expect(await (await item.items['text/plain']).text()).toBe('link');
  });

  it('falls back to writeText without ClipboardItem', async () => {
    vi.stubGlobal('ClipboardItem', undefined);
    const write = vi.fn(async () => {});
    const writeText = vi.fn(async () => {});
    expect(
      await copyToClipboard(Promise.resolve('link'), stubNavigator({ write, writeText })),
    ).toBe(true);
    expect(write).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith('link');
  });

  it('falls back to writeText when write rejects', async () => {
    vi.stubGlobal('ClipboardItem', FakeClipboardItem);
    const write = vi.fn(async () => {
      throw new Error('denied');
    });
    const writeText = vi.fn(async () => {});
    expect(
      await copyToClipboard(Promise.resolve('link'), stubNavigator({ write, writeText })),
    ).toBe(true);
    expect(writeText).toHaveBeenCalledWith('link');
  });

  it('is false when both reject', async () => {
    vi.stubGlobal('ClipboardItem', FakeClipboardItem);
    const write = vi.fn(async () => {
      throw new Error('denied');
    });
    const writeText = vi.fn(async () => {
      throw new Error('denied');
    });
    expect(
      await copyToClipboard(Promise.resolve('link'), stubNavigator({ write, writeText })),
    ).toBe(false);
  });

  it('is false without a clipboard', async () => {
    expect(await copyToClipboard(Promise.resolve('link'), stubNavigator(undefined as never))).toBe(
      false,
    );
  });
});

describe('datedName', () => {
  it('fills {date} with the localized date', () => {
    const date = new Date(2026, 9, 19, 14, 5);
    const name = datedName('Before shared city – {date}', date, 'en-GB');
    expect(name.startsWith('Before shared city – ')).toBe(true);
    expect(name).toContain('2026');
    expect(name).not.toContain('{date}');
  });
});

describe('keepAndOpenShared', () => {
  it('keeps the current city under the given name, then opens the shared one', async () => {
    const storage = createMemoryStorage(() => 1000);
    const shared = makeSave(42);
    const replace = vi.fn(async () => {});
    await keepAndOpenShared({
      storage,
      current: makeSave(7),
      currentPopulation: 123,
      keptName: 'Before shared city',
      shared,
      replace,
      newId: () => 'save-kept',
    });
    const list = await storage.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'save-kept', name: 'Before shared city', population: 123 });
    expect((await storage.load('save-kept'))?.money).toBe(7);
    expect(replace).toHaveBeenCalledWith(shared);
  });

  it('saves nothing without a current city', async () => {
    const storage = createMemoryStorage();
    const replace = vi.fn(async () => {});
    const shared = makeSave(42);
    await keepAndOpenShared({ storage, current: null, keptName: 'x', shared, replace });
    expect(await storage.list()).toEqual([]);
    expect(replace).toHaveBeenCalledWith(shared);
  });

  it('does not open the shared city when keeping fails', async () => {
    const error = new Error('quota');
    const storage = { save: vi.fn(async () => Promise.reject(error)) };
    const replace = vi.fn(async () => {});
    await expect(
      keepAndOpenShared({
        storage,
        current: makeSave(7),
        keptName: 'x',
        shared: makeSave(42),
        replace,
      }),
    ).rejects.toBe(error);
    expect(replace).not.toHaveBeenCalled();
  });
});
