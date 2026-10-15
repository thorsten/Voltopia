import type { SaveGame } from '../shared/types.ts';
import {
  type CatalogStores,
  legacySlotSummary,
  SaveCatalog,
  type StoredSummary,
} from './catalog.ts';
import { LEGACY_SLOT_IDS } from './storage.ts';

const DB_NAME = 'voltopia';
/** 1: `saves` only. 2: adds `summaries` (same keys) for the saves list. */
const DB_VERSION = 2;
const SAVES_STORE = 'saves';
const SUMMARIES_STORE = 'summaries';

/**
 * v1 → v2: give the legacy slots a summary each. An upgrade transaction
 * commits as soon as no request is pending, so awaiting anything that is
 * not an IndexedDB request (like `migrateLegacySlots`) would let it close
 * mid-way. The reads and writes are chained via request callbacks
 * instead; the per-slot decision is shared through `legacySlotSummary`.
 */
function migrateInUpgrade(transaction: IDBTransaction, now: number): void {
  const saves = transaction.objectStore(SAVES_STORE);
  const summaries = transaction.objectStore(SUMMARIES_STORE);
  LEGACY_SLOT_IDS.forEach((id, index) => {
    const saveRequest = saves.get(id) as IDBRequest<SaveGame | undefined>;
    saveRequest.onsuccess = () => {
      const save = saveRequest.result;
      if (!save) return;
      const summaryRequest = summaries.get(id) as IDBRequest<StoredSummary | undefined>;
      summaryRequest.onsuccess = () => {
        const summary = legacySlotSummary(index, save, summaryRequest.result, now);
        if (summary) summaries.put(summary, id);
      };
    };
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SAVES_STORE)) db.createObjectStore(SAVES_STORE);
      if (!db.objectStoreNames.contains(SUMMARIES_STORE)) db.createObjectStore(SUMMARIES_STORE);
      if (event.oldVersion >= 1 && event.oldVersion < 2 && request.transaction) {
        migrateInUpgrade(request.transaction, Date.now());
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction: IDBTransaction, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error(`IndexedDB ${what} failed`));
    transaction.onabort = () => reject(transaction.error ?? new Error(`IndexedDB ${what} aborted`));
  });
}

/** Reads one store; opens and closes the database around the request. */
async function read<T>(store: string, query: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDatabase();
  try {
    const transaction = db.transaction(store, 'readonly');
    return (await requestToPromise(query(transaction.objectStore(store)))) as T;
  } finally {
    db.close();
  }
}

/** The two IndexedDB object stores behind the catalogue. */
export class IndexedDbStores implements CatalogStores {
  getSave(id: string): Promise<SaveGame | undefined> {
    return read(SAVES_STORE, (store) => store.get(id));
  }

  getSummary(id: string): Promise<StoredSummary | undefined> {
    return read(SUMMARIES_STORE, (store) => store.get(id));
  }

  allSummaries(): Promise<StoredSummary[]> {
    return read(SUMMARIES_STORE, (store) => store.getAll());
  }

  async write(id: string, save: SaveGame, summary: StoredSummary | null): Promise<void> {
    const db = await openDatabase();
    try {
      // One transaction over both stores: a crash never leaves a save without its summary.
      const transaction = db.transaction([SAVES_STORE, SUMMARIES_STORE], 'readwrite');
      const done = transactionDone(transaction, 'write');
      transaction.objectStore(SAVES_STORE).put(save, id);
      if (summary) transaction.objectStore(SUMMARIES_STORE).put(summary, id);
      await done;
    } finally {
      db.close();
    }
  }

  async writeSummary(summary: StoredSummary): Promise<void> {
    const db = await openDatabase();
    try {
      const transaction = db.transaction(SUMMARIES_STORE, 'readwrite');
      const done = transactionDone(transaction, 'write');
      transaction.objectStore(SUMMARIES_STORE).put(summary, summary.id);
      await done;
    } finally {
      db.close();
    }
  }

  async remove(id: string): Promise<void> {
    const db = await openDatabase();
    try {
      const transaction = db.transaction([SAVES_STORE, SUMMARIES_STORE], 'readwrite');
      const done = transactionDone(transaction, 'delete');
      transaction.objectStore(SAVES_STORE).delete(id);
      transaction.objectStore(SUMMARIES_STORE).delete(id);
      await done;
    } finally {
      db.close();
    }
  }
}

/** IndexedDB-backed save storage (ArrayBuffers persist natively). */
export class IndexedDbStorage extends SaveCatalog {
  constructor() {
    super(new IndexedDbStores());
  }
}
