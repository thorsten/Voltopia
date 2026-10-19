import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SaveGame } from '../shared/types.ts';
import { saveFromJson, saveToJson } from '../storage/serialization.ts';
import { decodeShareCode, encodeShareCode } from '../storage/shareCode.ts';
import { newSlotId, type SaveStorage, type SaveSummary } from '../storage/storage.ts';
import { dayOfTick, defaultSaveName } from '../storage/summary.ts';
import { Modal } from './Modal.tsx';
import { useI18n } from './i18n.tsx';
import { exportTextFile } from './platform.ts';
import { currentCityFileName, nameFromFileName, saveFileName } from './saveFiles.ts';
import { SharedCityDialog } from './SharedCityDialog.tsx';
import {
  copyToClipboard,
  datedName,
  extractShareCode,
  keepAndOpenShared,
  type KeptSlot,
  SHARE_LINK_WARN_LENGTH,
  shareSupported,
  shareUrl,
} from './shareLink.ts';

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
  canShare,
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
  /** Sharing is off during a scenario. */
  canShare: boolean;
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
  // Shown when copying the share link failed, so it can be copied by hand.
  const [shareLink, setShareLink] = useState<string | null>(null);
  const [pasted, setPasted] = useState('');
  // A decoded share link awaiting the "Load shared city?" dialog.
  const [shared, setShared] = useState<SaveGame | null>(null);
  const [sharedBusy, setSharedBusy] = useState(false);
  const [sharedError, setSharedError] = useState<string | null>(null);
  // The slot the current city was kept in: a retried Load reuses it.
  const keptSlot = useRef<KeptSlot>({ id: null });
  const sharing = useMemo(() => shareSupported(), []);

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

  const shareCurrent = (): void => {
    setShareLink(null);
    // Built synchronously inside the click, so the clipboard write keeps
    // the user activation (Safari) while the snapshot is still encoding.
    const link = requestSnapshot()
      .then(encodeShareCode)
      .then((code) => shareUrl(code));
    void run(async () => {
      const copied = await copyToClipboard(link);
      const url = await link;
      if (!copied) {
        setShareLink(url);
        setMessage(t('share.copyFailed'));
        return;
      }
      const copiedText = t('share.copied', { size: Math.max(1, Math.round(url.length / 1024)) });
      setMessage(
        url.length > SHARE_LINK_WARN_LENGTH ? `${copiedText} ${t('share.long')}` : copiedText,
      );
    });
  };

  const openPasted = (): Promise<void> =>
    run(async () => {
      const code = extractShareCode(pasted);
      try {
        if (code === null) throw new Error('no share code');
        const save = await decodeShareCode(code);
        setSharedError(null);
        keptSlot.current = { id: null };
        setShared(save);
        setPasted('');
      } catch (error) {
        console.warn('Shared city link rejected', error);
        setMessage(t('share.invalid'));
      }
    });

  const loadShared = async (): Promise<void> => {
    if (!shared) return;
    setSharedBusy(true);
    setSharedError(null);
    try {
      await keepAndOpenShared({
        storage,
        current: await requestSnapshot(),
        currentPopulation: population,
        keptName: datedName(t('share.keptName'), new Date(), locale),
        shared,
        replace: replaceCityAndReload,
        kept: keptSlot.current,
      });
    } catch (error) {
      console.error('Loading the shared city failed', error);
      setSharedError(t('share.loadFailed'));
    } finally {
      setSharedBusy(false);
    }
  };

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

  // Instead of the saves modal, so there are never two backdrops.
  if (shared) {
    return (
      <SharedCityDialog
        save={shared}
        busy={sharedBusy}
        error={sharedError}
        onLoad={() => void loadShared()}
        onCancel={() => {
          setShared(null);
          setSharedError(null);
        }}
      />
    );
  }

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
                  money: summary.sandbox
                    ? `∞ ${CURRENCY}`
                    : `${Math.round(summary.money).toLocaleString('en-US')} ${CURRENCY}`,
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
          {canShare && sharing && (
            <button type="button" data-testid="share-city" onClick={shareCurrent}>
              {t('share.button')}
            </button>
          )}
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
        {shareLink !== null && (
          <input
            type="text"
            className="saves-input share-link-output"
            data-testid="share-link-output"
            aria-label={t('share.linkLabel')}
            value={shareLink}
            readOnly
            onFocus={(e) => e.currentTarget.select()}
          />
        )}
        {sharing && (
          <form
            className="saves-new share-open"
            onSubmit={(e) => {
              e.preventDefault();
              void openPasted();
            }}
          >
            <input
              type="text"
              className="saves-input"
              data-testid="share-open-input"
              aria-label={t('share.openLabel')}
              placeholder={t('share.openLabel')}
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
            />
            <button type="submit" data-testid="share-open">
              {t('share.open')}
            </button>
          </form>
        )}
      </section>
      {message && (
        <p className="saves-message" data-testid="saves-message">
          {message}
        </p>
      )}
    </Modal>
  );
}
