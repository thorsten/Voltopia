import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SaveGame } from '../shared/types.ts';
import { saveFromJson, saveToJson } from '../storage/serialization.ts';
import { newSlotId, type SaveStorage, type SaveSummary } from '../storage/storage.ts';
import { dayOfTick, defaultSaveName } from '../storage/summary.ts';
import { Modal } from './Modal.tsx';
import { useI18n } from './i18n.tsx';
import { exportTextFile } from './platform.ts';
import { currentCityFileName, nameFromFileName, saveFileName } from './saveFiles.ts';

/** How long Overwrite/Delete wait in their "Really …?" state for the second click. */
const CONFIRM_RESET_MS = 4000;

const CURRENCY = '⌁';

type ConfirmAction = 'overwrite' | 'delete';

function errorText(error: unknown): string {
  return String(error instanceof Error ? error.message : error);
}

/**
 * The named saves: save the running city as a new entry, and load,
 * overwrite, rename, export or delete existing ones. Import adds an entry
 * without loading it. Loading goes through `replaceCityAndReload` so no
 * autosave can write the old city back before the reload.
 */
export function SavesPage({
  storage,
  requestSnapshot,
  replaceCityAndReload,
  population,
  tick,
  onClose,
}: {
  storage: SaveStorage;
  /** Asks the sim for a fresh SaveGame snapshot. */
  requestSnapshot: () => Promise<SaveGame>;
  /** Makes `save` the running city via the autosave and reloads. */
  replaceCityAndReload: (save: SaveGame) => Promise<void>;
  /** Live population, so a new entry is not a day behind. */
  population: number;
  /** Current sim tick, for the default name's day. */
  tick: number;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const [saves, setSaves] = useState<SaveSummary[] | null>(null);
  const [name, setName] = useState(() => defaultSaveName(dayOfTick(tick), t('saves.defaultName')));
  const [message, setMessage] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ id: string; action: ConfirmAction } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  // Enter commits and unmounts the field; a trailing blur must not commit twice.
  const renameDone = useRef(false);

  const refresh = useCallback(async (): Promise<void> => {
    setSaves(await storage.list());
  }, [storage]);

  useEffect(() => {
    let cancelled = false;
    void storage.list().then((list) => {
      if (!cancelled) setSaves(list);
    });
    return () => {
      cancelled = true;
    };
  }, [storage]);

  useEffect(() => {
    if (!confirm) return;
    const timer = setTimeout(() => setConfirm(null), CONFIRM_RESET_MS);
    return () => clearTimeout(timer);
  }, [confirm]);

  const run = async (action: () => Promise<void>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      setMessage(errorText(error));
    }
  };

  // The page re-renders every tick (live population); build the formatter once per locale.
  const dateFormat = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }),
    [locale],
  );

  const saveNew = (): Promise<void> =>
    run(async () => {
      const label = name.trim() || defaultSaveName(dayOfTick(tick), t('saves.defaultName'));
      const snapshot = await requestSnapshot();
      const id = newSlotId();
      await storage.save(snapshot, id, label, population);
      await refresh();
      setHighlight(id);
      setMessage(t('saves.saved', { name: label }));
    });

  const load = (summary: SaveSummary): Promise<void> =>
    run(async () => {
      const save = await storage.load(summary.id);
      if (!save) throw new Error(t('saves.loadFailed'));
      await replaceCityAndReload(save);
    });

  const overwrite = (summary: SaveSummary): Promise<void> =>
    run(async () => {
      setConfirm(null);
      const snapshot = await requestSnapshot();
      await storage.save(snapshot, summary.id, undefined, population);
      await refresh();
      setHighlight(summary.id);
      setMessage(t('saves.saved', { name: summary.name }));
    });

  const remove = (summary: SaveSummary): Promise<void> =>
    run(async () => {
      setConfirm(null);
      await storage.clear(summary.id);
      await refresh();
      setMessage(t('saves.deleted', { name: summary.name }));
    });

  /** First click arms the button, the second (within CONFIRM_RESET_MS) acts. */
  const confirmOr = (summary: SaveSummary, action: ConfirmAction, act: () => void): void => {
    if (confirm?.id === summary.id && confirm.action === action) act();
    else setConfirm({ id: summary.id, action });
  };

  const startRename = (summary: SaveSummary): void => {
    renameDone.current = false;
    setRenaming({ id: summary.id, value: summary.name });
  };

  const commitRename = (): Promise<void> =>
    run(async () => {
      if (!renaming || renameDone.current) return;
      if (renaming.value.trim() === '') {
        setMessage(t('saves.nameRequired'));
        return;
      }
      renameDone.current = true;
      setRenaming(null);
      await storage.rename(renaming.id, renaming.value);
      await refresh();
    });

  const cancelRename = (): void => {
    renameDone.current = true;
    setRenaming(null);
  };

  const exportEntry = (summary: SaveSummary): Promise<void> =>
    run(async () => {
      const save = await storage.load(summary.id);
      if (!save) throw new Error(t('saves.loadFailed'));
      await exportTextFile(saveFileName(summary.name, new Date()), saveToJson(save));
    });

  const exportCurrent = (): Promise<void> =>
    run(async () => {
      const snapshot = await requestSnapshot();
      await exportTextFile(currentCityFileName(new Date()), saveToJson(snapshot));
    });

  const importFile = (file: File): Promise<void> =>
    run(async () => {
      const save = saveFromJson(await file.text());
      const label = nameFromFileName(file.name, t('saves.importedName'));
      const id = newSlotId();
      await storage.save(save, id, label);
      await refresh();
      setHighlight(id);
      setMessage(t('saves.imported', { name: label }));
    });

  const renderButtons = (summary: SaveSummary) => {
    const armed = (action: ConfirmAction): boolean =>
      confirm?.id === summary.id && confirm.action === action;
    const deleteButton = (
      <button
        type="button"
        className={armed('delete') ? 'armed' : ''}
        data-testid={`save-delete-${summary.id}`}
        onClick={() => confirmOr(summary, 'delete', () => void remove(summary))}
      >
        {armed('delete') ? t('saves.confirmDelete') : t('saves.delete')}
      </button>
    );
    if (!summary.compatible) return deleteButton;
    return (
      <>
        <button
          type="button"
          data-testid={`save-load-${summary.id}`}
          onClick={() => void load(summary)}
        >
          {t('saves.load')}
        </button>
        <button
          type="button"
          className={armed('overwrite') ? 'armed' : ''}
          data-testid={`save-overwrite-${summary.id}`}
          onClick={() => confirmOr(summary, 'overwrite', () => void overwrite(summary))}
        >
          {armed('overwrite') ? t('saves.confirmOverwrite') : t('saves.overwrite')}
        </button>
        <button
          type="button"
          data-testid={`save-rename-${summary.id}`}
          onClick={() => startRename(summary)}
        >
          {t('saves.rename')}
        </button>
        <button
          type="button"
          data-testid={`save-export-${summary.id}`}
          onClick={() => void exportEntry(summary)}
        >
          {t('saves.export')}
        </button>
        {deleteButton}
      </>
    );
  };

  return (
    <Modal title={t('saves.title')} onClose={onClose} testId="saves-page">
      <section>
        <h3>{t('saves.current')}</h3>
        <form
          className="saves-new"
          onSubmit={(e) => {
            e.preventDefault();
            void saveNew();
          }}
        >
          <input
            type="text"
            className="saves-input"
            data-testid="save-name-input"
            aria-label={t('saves.nameLabel')}
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" data-testid="save-new">
            {t('saves.saveNew')}
          </button>
        </form>
      </section>
      <section>
        <h3>{t('saves.list')}</h3>
        {saves !== null && saves.length === 0 && (
          <p className="saves-hint" data-testid="saves-empty">
            {t('saves.empty')}
          </p>
        )}
        {saves?.map((summary) => (
          <div
            key={summary.id}
            className={`saves-entry${highlight === summary.id ? ' highlight' : ''}`}
            data-testid={`save-row-${summary.id}`}
          >
            <div className="saves-entry-info">
              {renaming?.id === summary.id ? (
                <input
                  type="text"
                  className="saves-input"
                  data-testid={`save-rename-input-${summary.id}`}
                  aria-label={t('saves.nameLabel')}
                  value={renaming.value}
                  maxLength={80}
                  autoFocus
                  onChange={(e) => setRenaming({ id: summary.id, value: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void commitRename();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      cancelRename();
                    }
                  }}
                  onBlur={() => void commitRename()}
                />
              ) : (
                <span className="saves-entry-name" data-testid={`save-name-${summary.id}`}>
                  {summary.name}
                </span>
              )}
              <span className="saves-entry-meta">{dateFormat.format(summary.savedAt)}</span>
              <span className="saves-entry-meta">
                {t('saves.details', {
                  day: summary.day,
                  population: summary.population,
                  money: `${Math.round(summary.money).toLocaleString('en-US')} ${CURRENCY}`,
                  map: `${summary.size}×${summary.size}`,
                })}
              </span>
              {!summary.compatible && (
                <span className="saves-entry-meta saves-incompatible">
                  {t('saves.incompatible')}
                </span>
              )}
            </div>
            <span className="saves-row-buttons">{renderButtons(summary)}</span>
          </div>
        ))}
      </section>
      <section>
        <h3>{t('saves.transfer')}</h3>
        <div className="saves-row">
          <button type="button" data-testid="export-save" onClick={() => void exportCurrent()}>
            {t('saves.exportCurrent')}
          </button>
          <label className="saves-import">
            {t('saves.import')}
            <input
              type="file"
              accept="application/json,.json"
              data-testid="import-save"
              onChange={(e) => {
                const input = e.currentTarget;
                const file = input.files?.[0];
                // Reset so the same file can be imported again.
                input.value = '';
                if (file) void importFile(file);
              }}
            />
          </label>
        </div>
      </section>
      {message && (
        <p className="saves-message" data-testid="saves-message">
          {message}
        </p>
      )}
    </Modal>
  );
}
