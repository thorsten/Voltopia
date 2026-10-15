import type { SaveGame } from '../shared/types.ts';
import { type CatalogStores, SaveCatalog, type StoredSummary } from './catalog.ts';

/**
 * In-memory catalogue stores for tests (node has no IndexedDB). Values
 * are cloned in and out like IndexedDB's structured clone, so callers
 * cannot mutate what is stored.
 */
export class MemoryCatalogStores implements CatalogStores {
  readonly saves = new Map<string, SaveGame>();
  readonly summaries = new Map<string, StoredSummary>();

  async getSave(id: string): Promise<SaveGame | undefined> {
    const save = this.saves.get(id);
    return save && structuredClone(save);
  }

  async getSummary(id: string): Promise<StoredSummary | undefined> {
    const summary = this.summaries.get(id);
    return summary && structuredClone(summary);
  }

  async allSummaries(): Promise<StoredSummary[]> {
    return [...this.summaries.values()].map((summary) => structuredClone(summary));
  }

  async write(id: string, save: SaveGame, summary: StoredSummary | null): Promise<void> {
    this.saves.set(id, structuredClone(save));
    if (summary) this.summaries.set(id, structuredClone(summary));
  }

  async writeSummary(summary: StoredSummary): Promise<void> {
    this.summaries.set(summary.id, structuredClone(summary));
  }

  async remove(id: string): Promise<void> {
    this.saves.delete(id);
    this.summaries.delete(id);
  }
}

/** A complete in-memory `SaveStorage` (not used by the app). */
export function createMemoryStorage(now?: () => number): SaveCatalog {
  return new SaveCatalog(new MemoryCatalogStores(), now);
}
