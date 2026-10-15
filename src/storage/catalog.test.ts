import { describe, expect, it } from 'vitest';
import { SAVE_VERSION, TICKS_PER_DAY } from '../shared/constants.ts';
import type { SaveGame } from '../shared/types.ts';
import { migrateLegacySlots, SaveCatalog } from './catalog.ts';
import { createMemoryStorage, MemoryCatalogStores } from './memory.ts';
import { AUTOSAVE_SLOT } from './storage.ts';

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

/** A catalogue whose clock advances by one per call, so saves are ordered. */
function makeCatalog(stores = new MemoryCatalogStores()) {
  let time = 1000;
  return { stores, catalog: new SaveCatalog(stores, () => time++) };
}

describe('SaveCatalog', () => {
  it('stores a named save with its summary', async () => {
    const { catalog } = makeCatalog();
    await catalog.save(makeSave({ tick: TICKS_PER_DAY, money: 77 }), 'a', 'Testville');
    expect(await catalog.load('a')).toMatchObject({ money: 77 });
    expect(await catalog.list()).toEqual([
      {
        id: 'a',
        name: 'Testville',
        savedAt: 1000,
        day: 2,
        population: 0,
        money: 77,
        size: 64,
        compatible: true,
      },
    ]);
  });

  it('keeps the old name when overwriting without one', async () => {
    const { catalog } = makeCatalog();
    await catalog.save(makeSave(), 'a', 'Testville');
    await catalog.save(makeSave({ money: 1 }), 'a');
    const [summary] = await catalog.list();
    expect(summary).toMatchObject({ id: 'a', name: 'Testville', money: 1, savedAt: 1001 });
  });

  it('falls back to the id for an unnamed new slot', async () => {
    const { catalog } = makeCatalog();
    await catalog.save(makeSave(), 'slot2');
    expect((await catalog.list())[0].name).toBe('slot2');
  });

  it('never lists the autosave', async () => {
    const { catalog, stores } = makeCatalog();
    await catalog.save(makeSave({ money: 3 }));
    expect(await catalog.list()).toEqual([]);
    expect(await stores.getSummary(AUTOSAVE_SLOT)).toBeUndefined();
    expect(await catalog.load()).toMatchObject({ money: 3 });
  });

  it('lists newest first', async () => {
    const { catalog } = makeCatalog();
    await catalog.save(makeSave(), 'a', 'First');
    await catalog.save(makeSave(), 'b', 'Second');
    await catalog.save(makeSave(), 'c', 'Third');
    await catalog.save(makeSave(), 'a');
    expect((await catalog.list()).map((s) => s.id)).toEqual(['a', 'c', 'b']);
  });

  it('renames a save without touching its time', async () => {
    const { catalog } = makeCatalog();
    await catalog.save(makeSave(), 'a', 'Old');
    await catalog.rename('a', '  New  ');
    expect(await catalog.list()).toMatchObject([{ id: 'a', name: 'New', savedAt: 1000 }]);
    expect(await catalog.load('a')).not.toBeNull();
  });

  it('rejects renaming unknown saves, the autosave and empty names', async () => {
    const { catalog } = makeCatalog();
    await catalog.save(makeSave());
    await catalog.save(makeSave(), 'a', 'Old');
    await expect(catalog.rename('missing', 'x')).rejects.toThrow(Error);
    await expect(catalog.rename(AUTOSAVE_SLOT, 'x')).rejects.toThrow(Error);
    await expect(catalog.rename('a', '   ')).rejects.toThrow(Error);
    expect((await catalog.list())[0].name).toBe('Old');
  });

  it('removes save and summary together', async () => {
    const { catalog, stores } = makeCatalog();
    await catalog.save(makeSave(), 'a', 'Gone');
    await catalog.clear('a');
    expect(await catalog.load('a')).toBeNull();
    expect(await stores.getSummary('a')).toBeUndefined();
    expect(await catalog.list()).toEqual([]);
  });

  it('flags saves of another version and does not load them', async () => {
    const { catalog } = makeCatalog();
    await catalog.save(makeSave({ version: SAVE_VERSION + 1 }), 'old', 'Old');
    expect((await catalog.list())[0].compatible).toBe(false);
    expect(await catalog.load('old')).toBeNull();
  });

  it('recomputes compatibility from the stored version', async () => {
    const { catalog, stores } = makeCatalog();
    await catalog.save(makeSave(), 'a', 'A');
    const stored = await stores.getSummary('a');
    await stores.write('a', makeSave(), {
      ...stored!,
      version: SAVE_VERSION + 1,
      compatible: true,
    });
    expect((await catalog.list())[0].compatible).toBe(false);
  });

  it('returns null for a missing slot and swallows store errors on load', async () => {
    const { catalog, stores } = makeCatalog();
    expect(await catalog.load('nothing')).toBeNull();
    stores.getSave = () => Promise.reject(new Error('boom'));
    const warn = console.warn;
    console.warn = () => {};
    try {
      expect(await catalog.load()).toBeNull();
    } finally {
      console.warn = warn;
    }
  });
});

describe('migrateLegacySlots', () => {
  it('turns the legacy slots into named entries and keeps the autosave', async () => {
    const stores = new MemoryCatalogStores();
    await stores.write(AUTOSAVE_SLOT, makeSave({ money: 9 }), null);
    await stores.write('slot1', makeSave({ money: 1 }), null);
    await stores.write('slot3', makeSave({ money: 3, tick: TICKS_PER_DAY * 4 }), null);
    await migrateLegacySlots(stores, 500);

    const catalog = new SaveCatalog(stores);
    const list = await catalog.list();
    expect(list.map((s) => [s.id, s.name, s.savedAt])).toEqual(
      expect.arrayContaining([
        ['slot1', 'Slot 1', 500],
        ['slot3', 'Slot 3', 500],
      ]),
    );
    expect(list).toHaveLength(2);
    expect(list.find((s) => s.id === 'slot3')).toMatchObject({ day: 5, money: 3 });
    expect(await catalog.load()).toMatchObject({ money: 9 });
  });

  it('leaves slots that already have a summary alone', async () => {
    const { catalog, stores } = makeCatalog();
    await catalog.save(makeSave(), 'slot2', 'Mine');
    await migrateLegacySlots(stores, 5);
    expect(await catalog.list()).toMatchObject([{ id: 'slot2', name: 'Mine', savedAt: 1000 }]);
  });
});

describe('createMemoryStorage', () => {
  it('uses the injected clock', async () => {
    const storage = createMemoryStorage(() => 7);
    await storage.save(makeSave(), 'a', 'A');
    expect((await storage.list())[0].savedAt).toBe(7);
  });

  it('keeps stored saves independent of the caller', async () => {
    const storage = createMemoryStorage();
    const save = makeSave({ money: 1 });
    await storage.save(save, 'a', 'A');
    save.money = 2;
    expect(await storage.load('a')).toMatchObject({ money: 1 });
  });
});
