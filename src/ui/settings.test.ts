import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, loadSettings, persistSettings } from './settings.ts';

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

describe('settings', () => {
  beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
  afterEach(() => vi.unstubAllGlobals());

  it('ambient occlusion is on by default', () => {
    expect(DEFAULT_SETTINGS.ambientOcclusion).toBe(true);
    expect(loadSettings().ambientOcclusion).toBe(true);
  });

  it('round-trips the ambient occlusion switch', () => {
    persistSettings({ ...DEFAULT_SETTINGS, ambientOcclusion: false });
    expect(loadSettings().ambientOcclusion).toBe(false);
  });

  it('settings stored before the switch existed load with the default', () => {
    localStorage.setItem('voltopia.settings', JSON.stringify({ shadows: false, theme: 'light' }));
    const loaded = loadSettings();
    expect(loaded.ambientOcclusion).toBe(true);
    expect(loaded.shadows).toBe(false);
  });
});
