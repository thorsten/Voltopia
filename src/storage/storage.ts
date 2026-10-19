import type { SaveGame } from '../shared/types.ts';

export const AUTOSAVE_SLOT = 'autosave';

/** The three fixed slots from before the save catalogue; they keep their keys. */
export const LEGACY_SLOT_IDS = ['slot1', 'slot2', 'slot3'] as const;

/** What the saves list shows about one save, without loading its grids. */
export interface SaveSummary {
  /** Storage key; `autosave` is never listed. */
  id: string;
  name: string;
  /** Real-world save time, ms since epoch. */
  savedAt: number;
  /** In-game day (1-based) at save time. */
  day: number;
  population: number;
  money: number;
  size: number;
  /** False when the stored save has another SAVE_VERSION: delete only. */
  compatible: boolean;
  /** A sandbox city (unlimited money); absent on normal and old saves. */
  sandbox?: boolean;
}

/**
 * Persistence backend for save games. IndexedDB is the default; the
 * interface keeps the door open for other backends (cloud, file, ...).
 * Slots address independent save games; the autosave slot is the one
 * loaded on boot. Every other slot is a named save with a summary.
 */
export interface SaveStorage {
  load(slot?: string): Promise<SaveGame | null>;
  /**
   * Without a name, an existing named save keeps its name (overwrite).
   * `population` is the live value for the summary; without it the last
   * daily sample is used, up to a day behind.
   */
  save(game: SaveGame, slot?: string, name?: string, population?: number): Promise<void>;
  clear(slot?: string): Promise<void>;
  /** Named saves, newest first; never the autosave. */
  list(): Promise<SaveSummary[]>;
  rename(slot: string, name: string): Promise<void>;
}

/**
 * A fresh slot id: `save-<time base36>-<4 random base36>`. UI randomness,
 * not sim randomness, so the seeded `Rng` does not apply.
 */
export function newSlotId(now: number = Date.now(), random: () => number = Math.random): string {
  const suffix = Math.floor(random() * 36 ** 4)
    .toString(36)
    .padStart(4, '0');
  return `save-${now.toString(36)}-${suffix}`;
}
