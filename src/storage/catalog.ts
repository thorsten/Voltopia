import { SAVE_VERSION } from '../shared/constants.ts';
import type { SaveGame } from '../shared/types.ts';
import { AUTOSAVE_SLOT, LEGACY_SLOT_IDS, type SaveStorage, type SaveSummary } from './storage.ts';
import { summarizeSave } from './summary.ts';

/**
 * A summary row as stored: the public summary plus the save's version,
 * so `compatible` can be recomputed when SAVE_VERSION moves on without
 * loading the save.
 */
export interface StoredSummary extends SaveSummary {
  version: number;
}

/**
 * Two key/value stores sharing their keys: full saves and their
 * summaries. Implemented by IndexedDB and by an in-memory map for tests.
 */
export interface CatalogStores {
  getSave(id: string): Promise<SaveGame | undefined>;
  getSummary(id: string): Promise<StoredSummary | undefined>;
  allSummaries(): Promise<StoredSummary[]>;
  /** Save and summary in one transaction; a null summary (autosave) writes no summary row. */
  write(id: string, save: SaveGame, summary: StoredSummary | null): Promise<void>;
  /** Removes the save and its summary in one transaction. */
  remove(id: string): Promise<void>;
  /** Replaces the summary row only (rename), leaving the save untouched. */
  writeSummary(summary: StoredSummary): Promise<void>;
}

/** The summary row to store for `save` under `id`. */
export function storedSummary(
  id: string,
  save: SaveGame,
  name: string,
  savedAt: number,
  population?: number,
): StoredSummary {
  return { ...summarizeSave(save, name, savedAt, population), id, version: save.version };
}

/**
 * The summary a legacy slot gets on migration ("Slot N", saved at the
 * upgrade time since the original time is unknown), or null when the
 * slot is empty or already listed. Shared by `migrateLegacySlots` and
 * the IndexedDB upgrade, which cannot await promises.
 */
export function legacySlotSummary(
  index: number,
  save: SaveGame | undefined,
  existing: StoredSummary | undefined,
  now: number,
): StoredSummary | null {
  if (!save || existing) return null;
  return storedSummary(LEGACY_SLOT_IDS[index], save, `Slot ${index + 1}`, now);
}

/** Gives the old fixed slots `slot1`..`slot3` a summary each. */
export async function migrateLegacySlots(stores: CatalogStores, now: number): Promise<void> {
  for (const [index, id] of LEGACY_SLOT_IDS.entries()) {
    const save = await stores.getSave(id);
    const summary = legacySlotSummary(index, save, await stores.getSummary(id), now);
    if (save && summary) await stores.write(id, save, summary);
  }
}

function publicSummary({ version, ...summary }: StoredSummary): SaveSummary {
  return { ...summary, compatible: version === SAVE_VERSION };
}

/** Save storage with a catalogue of named saves on top of `CatalogStores`. */
export class SaveCatalog implements SaveStorage {
  constructor(
    private readonly stores: CatalogStores,
    private readonly now: () => number = Date.now,
  ) {}

  async load(slot: string = AUTOSAVE_SLOT): Promise<SaveGame | null> {
    try {
      const save = await this.stores.getSave(slot);
      if (!save || save.version !== SAVE_VERSION) return null;
      return save;
    } catch (error) {
      console.warn('Loading the save game failed', error);
      return null;
    }
  }

  async save(
    game: SaveGame,
    slot: string = AUTOSAVE_SLOT,
    name?: string,
    population?: number,
  ): Promise<void> {
    if (slot === AUTOSAVE_SLOT) {
      await this.stores.write(slot, game, null);
      return;
    }
    const existing = await this.stores.getSummary(slot);
    const label = name ?? existing?.name ?? slot;
    await this.stores.write(slot, game, storedSummary(slot, game, label, this.now(), population));
  }

  async clear(slot: string = AUTOSAVE_SLOT): Promise<void> {
    await this.stores.remove(slot);
  }

  async list(): Promise<SaveSummary[]> {
    const summaries = await this.stores.allSummaries();
    return summaries
      .filter((summary) => summary.id !== AUTOSAVE_SLOT)
      .map(publicSummary)
      .sort((a, b) => b.savedAt - a.savedAt);
  }

  async rename(slot: string, name: string): Promise<void> {
    const trimmed = name.trim();
    if (trimmed === '') throw new Error('A save needs a name');
    const summary = await this.stores.getSummary(slot);
    if (!summary || slot === AUTOSAVE_SLOT) throw new Error(`Unknown save: ${slot}`);
    await this.stores.writeSummary({ ...summary, name: trimmed });
  }
}
