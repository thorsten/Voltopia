import { describe, expect, it, vi } from 'vitest';
import { SAVE_VERSION } from '../shared/constants.ts';
import type { SaveGame } from '../shared/types.ts';
import { createMemoryStorage } from '../storage/memory.ts';
import { createCityReloader } from './cityReload.ts';

const city = (money: number): SaveGame => ({ version: SAVE_VERSION, money }) as unknown as SaveGame;

describe('createCityReloader', () => {
  it('autosaves while the city is not being replaced', async () => {
    const storage = createMemoryStorage();
    const reloader = createCityReloader(storage, vi.fn());
    await reloader.autosave(city(1));
    expect((await storage.load())?.money).toBe(1);
    expect(reloader.leaving).toBe(false);
  });

  it('drops an autosave that arrives after a load started', async () => {
    const storage = createMemoryStorage();
    const reload = vi.fn();
    const reloader = createCityReloader(storage, reload);
    await reloader.autosave(city(1));
    const replacing = reloader.replaceCityAndReload(city(2));
    // The old city's snapshot lands between the copy and the reload.
    await reloader.autosave(city(1));
    await replacing;
    await reloader.autosave(city(1));
    expect(reload).toHaveBeenCalledOnce();
    expect(reloader.leaving).toBe(true);
    expect((await storage.load())?.money).toBe(2);
  });

  it('clears the autosave for a new city before reloading', async () => {
    const storage = createMemoryStorage();
    const reload = vi.fn();
    const reloader = createCityReloader(storage, reload);
    await reloader.autosave(city(1));
    await reloader.replaceCityAndReload(null);
    await reloader.autosave(city(1));
    expect(reload).toHaveBeenCalledOnce();
    expect(await storage.load()).toBeNull();
  });

  it('lifts the guard and does not reload when the write fails', async () => {
    const save = vi.fn(async () => {
      throw new Error('disk');
    });
    const reload = vi.fn();
    const reloader = createCityReloader({ save, clear: vi.fn() }, reload);
    await expect(reloader.replaceCityAndReload(city(2))).rejects.toThrow('disk');
    expect(reload).not.toHaveBeenCalled();
    expect(reloader.leaving).toBe(false);
  });
});
