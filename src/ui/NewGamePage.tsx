import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { OSM_IMPORT } from '../import/config.ts';
import { searchPlaces, type PlaceHit } from '../import/fetch.ts';
import { rasteriseTown } from '../import/rasterise.ts';
import { ImportProgressBar } from './ImportProgressBar.tsx';
import { Modal } from './Modal.tsx';
import { useI18n, type TranslationKey } from './i18n.tsx';
import {
  importBlocksStart,
  importErrorKey,
  importTownReducer,
  importedLayout,
  initialImportState,
  loadTown,
  metresPerTile,
  readTownFile,
  type ImportStep,
} from './importTown.ts';
import {
  DEFAULT_NEW_GAME,
  DIFFICULTIES,
  DISASTER_LEVELS,
  MAP_SIZES,
  seedFromText,
  storePendingNewGame,
} from './newGame.ts';
import { TownPreview } from './TownPreview.tsx';

/** Decimals of the coordinates shown in the chosen-place chip (~10 m). */
const CHIP_COORDINATE_DECIMALS = 4;

/** How often the progress bar's elapsed time advances while loading. */
const PROGRESS_TICK_MS = 250;

export function NewGamePage({
  onStart,
  onClose,
  onOpenImprint,
}: {
  /** Called after options are stored; should clear the autosave + reload. */
  onStart: () => void;
  onClose: () => void;
  /** Opens the imprint, which explains what the import sends where. */
  onOpenImprint?: () => void;
}) {
  const { t, locale } = useI18n();
  const [flow, dispatch] = useReducer(importTownReducer, DEFAULT_NEW_GAME.size, initialImportState);
  const [difficulty, setDifficulty] = useState<string>('normal');
  const [seedText, setSeedText] = useState('');
  const [disasters, setDisasters] = useState<number>(DEFAULT_NEW_GAME.disasterScale);
  const [sandbox, setSandbox] = useState(false);
  // Disaster level chosen before sandbox preset it to off, restored on uncheck.
  const [disastersBeforeSandbox, setDisastersBeforeSandbox] = useState(disasters);
  // The running download; aborted by Cancel, a newer load and unmount.
  const abortRef = useRef<AbortController | null>(null);
  // Bumped per search and per file read so a stale answer is dropped.
  const runRef = useRef(0);
  const size = flow.size;
  const layout = importedLayout(flow);

  useEffect(() => () => abortRef.current?.abort(), []);

  // While loading, the bar's waiting phases creep with the elapsed time.
  const loading = flow.status === 'loading';
  useEffect(() => {
    if (!loading) return;
    const started = Date.now();
    const id = setInterval(
      () => dispatch({ type: 'tick', elapsedMs: Date.now() - started }),
      PROGRESS_TICK_MS,
    );
    return () => clearInterval(id);
  }, [loading]);

  // Rasterising is pure and fast (tens of milliseconds); it reruns when
  // the data, its box or the map size changes and feeds the preview.
  useEffect(() => {
    if (!flow.data) return;
    try {
      const made = rasteriseTown(flow.data, flow.size, flow.bbox ?? undefined);
      dispatch({ type: 'rasterised', layout: made.layout, report: made.report });
    } catch (error) {
      dispatch({
        type: 'failed',
        step: flow.source === 'file' ? 'file' : 'load',
        errorKey: importErrorKey(error),
      });
    }
  }, [flow.data, flow.bbox, flow.size, flow.source]);

  const toggleSandbox = (on: boolean): void => {
    setSandbox(on);
    // Sandbox presets disasters to off; the player may switch them back on.
    if (on) {
      setDisastersBeforeSandbox(disasters);
      setDisasters(0);
    } else {
      setDisasters(disastersBeforeSandbox);
    }
  };

  const search = async (): Promise<void> => {
    if (flow.query.trim() === '' || flow.status === 'searching') return;
    const run = ++runRef.current;
    dispatch({ type: 'search' });
    try {
      const hits = await searchPlaces(flow.query, locale);
      if (run === runRef.current) dispatch({ type: 'searched', hits });
    } catch (error) {
      if (run === runRef.current) {
        dispatch({ type: 'failed', step: 'search', errorKey: importErrorKey(error) });
      }
    }
  };

  const load = async (): Promise<void> => {
    if (!flow.place) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    runRef.current++;
    dispatch({ type: 'load', source: 'search' });
    try {
      const { data, bbox } = await loadTown(flow.place, flow.sideKm, controller.signal, (p) => {
        if (!controller.signal.aborted) dispatch({ type: 'progress', ...p });
      });
      if (!controller.signal.aborted) dispatch({ type: 'parsed', data, bbox });
    } catch (error) {
      // A cancelled download already dispatched `cancel`.
      if (!controller.signal.aborted) {
        dispatch({ type: 'failed', step: 'load', errorKey: importErrorKey(error) });
      }
    }
  };

  const cancel = (): void => {
    abortRef.current?.abort();
    runRef.current++;
    dispatch({ type: 'cancel' });
  };

  const readFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    abortRef.current?.abort();
    const run = ++runRef.current;
    dispatch({ type: 'load', source: 'file' });
    try {
      const data = await readTownFile(file, (p) => {
        if (run === runRef.current) dispatch({ type: 'progress', ...p });
      });
      if (run === runRef.current) dispatch({ type: 'parsed', data, bbox: null });
    } catch (error) {
      if (run === runRef.current) {
        dispatch({ type: 'failed', step: 'file', errorKey: importErrorKey(error) });
      }
    }
  };

  const start = (): void => {
    const chosen = DIFFICULTIES.find((d) => d.id === difficulty) ?? DIFFICULTIES[1];
    storePendingNewGame({
      size,
      startingMoney: chosen.startingMoney,
      // An imported town takes a random seed (it only picks geothermal
      // spots and building variants); the seed field is hidden then.
      seed: layout ? null : seedFromText(seedText),
      disasterScale: disasters,
      ...(sandbox ? { sandbox: true } : {}),
      ...(layout ? { layout } : {}),
    });
    onStart();
  };

  /**
   * The one status line of the import, under the step it belongs to: the
   * progress bar of a running load, or an error.
   */
  const statusUnder = (step: ImportStep): ReactNode => {
    const loadStep: ImportStep = flow.source === 'file' ? 'file' : 'load';
    if (flow.progress && step === loadStep) {
      return <ImportProgressBar progress={flow.progress} percent={flow.percent} />;
    }
    let text: string | null = null;
    let error = false;
    if (flow.status === 'searching' && step === 'search') text = t('newGame.import.searching');
    else if (flow.status === 'error' && flow.errorStep === step && flow.errorKey) {
      text = t(flow.errorKey, { km: OSM_IMPORT.maxBoxKm });
      error = true;
    }
    if (text === null) return null;
    return (
      <p
        className={`import-status${error ? ' import-error' : ''}`}
        role={error ? 'alert' : 'status'}
        data-testid="import-town-status"
      >
        {text}
      </p>
    );
  };

  const chipFor = (place: PlaceHit): string =>
    t('newGame.import.chip', {
      name: place.name,
      type: place.type,
      lat: place.lat.toFixed(CHIP_COORDINATE_DECIMALS),
      lon: place.lon.toFixed(CHIP_COORDINATE_DECIMALS),
    });

  const report = flow.report;
  const reportText =
    report &&
    t('newGame.import.report', {
      metres: Math.round(report.metresPerTile),
      roads: report.counts.street + report.counts.avenue + report.counts.pedestrian,
      zones:
        report.counts.residential +
        report.counts.commercial +
        report.counts.retail +
        report.counts.industrial,
      buildings: report.counts.buildings,
      dropped: report.droppedZones,
    });

  return (
    <Modal title={t('newGame.title')} onClose={onClose} testId="new-game-page">
      <section>
        <h3>{t('newGame.mapSize')}</h3>
        <div className="option-row">
          {MAP_SIZES.map((option) => (
            <button
              key={option}
              type="button"
              className={size === option ? 'active' : ''}
              data-testid={`size-${option}`}
              onClick={() => dispatch({ type: 'size', size: option })}
            >
              {option}×{option}
            </button>
          ))}
        </div>
      </section>
      <section className="import-town" data-testid="import-town">
        <h3>{t('newGame.import.title')}</h3>
        <p className="option-hint">{t('newGame.import.intro')}</p>
        <div className="import-search">
          <input
            type="search"
            className="seed-input"
            placeholder={t('newGame.import.searchPlaceholder')}
            value={flow.query}
            data-testid="import-town-query"
            onChange={(e) => dispatch({ type: 'query', query: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void search();
              }
            }}
          />
          <button
            type="button"
            data-testid="import-town-search"
            disabled={flow.query.trim() === '' || flow.status === 'searching'}
            onClick={() => void search()}
          >
            {t('newGame.import.search')}
          </button>
        </div>
        {statusUnder('search')}
        {flow.hits.length > 0 && (
          <ul className="import-results">
            {flow.hits.map((hit) => (
              <li key={`${hit.lat},${hit.lon}`}>
                <button
                  type="button"
                  className={flow.place === hit ? 'active' : ''}
                  data-testid="import-town-result"
                  onClick={() => dispatch({ type: 'pick', place: hit })}
                >
                  <span className="import-result-name">{hit.name}</span>
                  <span className="import-result-detail">
                    {hit.type} · {hit.displayName}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {flow.place && (
          <p className="import-chip" data-testid="import-town-place">
            {chipFor(flow.place)}
          </p>
        )}
        <div className="option-row">
          {OSM_IMPORT.sideKm.map((side) => (
            <button
              key={side}
              type="button"
              className={flow.sideKm === side ? 'active' : ''}
              data-testid="import-town-side"
              data-side={side}
              onClick={() => dispatch({ type: 'side', sideKm: side })}
            >
              {t('newGame.import.side', { km: side })}
            </button>
          ))}
        </div>
        <p className="option-hint">
          {t('newGame.import.metresPerTile', {
            metres: Math.round(metresPerTile(flow.sideKm, size)),
            size,
          })}
        </p>
        <div className="import-load">
          {flow.status === 'loading' && flow.source === 'search' ? (
            <button type="button" data-testid="import-town-cancel" onClick={cancel}>
              {t('newGame.import.cancel')}
            </button>
          ) : (
            <button
              type="button"
              className="primary"
              data-testid="import-town-load"
              disabled={!flow.place || flow.status === 'loading'}
              onClick={() => void load()}
            >
              {t('newGame.import.load')}
            </button>
          )}
          <span className="option-hint import-service-note">
            {t('newGame.import.serviceNote')}{' '}
            {onOpenImprint && (
              <button type="button" className="link-button" onClick={onOpenImprint}>
                {t('newGame.import.serviceNoteLink')}
              </button>
            )}
          </span>
        </div>
        {statusUnder('load')}
        <details className="import-file">
          <summary>{t('newGame.import.fileSummary')}</summary>
          <label className="import-file-label">
            {t('newGame.import.fileLabel')}
            <input
              type="file"
              accept=".osm,.xml,application/xml"
              data-testid="import-town-file"
              onChange={(e) => {
                void readFile(e.target.files?.[0]);
                // Choosing the same file again should read it again.
                e.target.value = '';
              }}
            />
          </label>
          {statusUnder('file')}
        </details>
        {layout && (
          <div className="import-preview">
            <TownPreview layout={layout} />
            <p className="import-loaded" data-testid="import-town-name">
              {t('newGame.import.loaded', {
                name: layout.name ?? t('newGame.import.unnamed'),
              })}
            </p>
            {reportText && (
              <p className="option-hint" data-testid="import-town-report">
                {reportText}
              </p>
            )}
          </div>
        )}
      </section>
      <section>
        <label className="option-toggle">
          <input
            type="checkbox"
            data-testid="sandbox-toggle"
            checked={sandbox}
            onChange={(e) => toggleSandbox(e.target.checked)}
          />{' '}
          {t('newGame.sandbox')}
        </label>
      </section>
      <section>
        <h3>{t('newGame.difficulty')}</h3>
        <div className="option-row">
          {DIFFICULTIES.map((option) => (
            <button
              key={option.id}
              type="button"
              className={difficulty === option.id ? 'active' : ''}
              data-testid={`difficulty-${option.id}`}
              title={`${option.startingMoney.toLocaleString('en-US')} ⌁`}
              disabled={sandbox}
              onClick={() => setDifficulty(option.id)}
            >
              {t(`newGame.difficulty.${option.id}` as TranslationKey)}
            </button>
          ))}
        </div>
        {sandbox && (
          <p className="option-hint" data-testid="sandbox-hint">
            {t('newGame.sandbox.hint')}
          </p>
        )}
      </section>
      <section>
        <h3>{t('newGame.disasters')}</h3>
        <div className="option-row">
          {DISASTER_LEVELS.map((level) => (
            <button
              key={level.id}
              type="button"
              className={disasters === level.scale ? 'active' : ''}
              data-testid={`disasters-${level.id}`}
              onClick={() => setDisasters(level.scale)}
            >
              {t(`newGame.disasters.${level.id}` as TranslationKey)}
            </button>
          ))}
        </div>
        <p className="option-hint">{t('newGame.disasters.hint')}</p>
      </section>
      {layout ? (
        <section>
          <p className="option-hint" data-testid="seed-hidden">
            {t('newGame.import.seedNote')}
          </p>
        </section>
      ) : (
        <section>
          <h3>{t('newGame.seed')}</h3>
          <input
            type="text"
            className="seed-input"
            placeholder={t('newGame.seedPlaceholder')}
            value={seedText}
            data-testid="seed-input"
            onChange={(e) => setSeedText(e.target.value)}
          />
        </section>
      )}
      <div className="new-game-actions">
        <button
          type="button"
          className="primary"
          data-testid="start-city"
          disabled={importBlocksStart(flow)}
          onClick={start}
        >
          {t('newGame.start')}
        </button>
        <button type="button" onClick={onClose}>
          {t('newGame.cancel')}
        </button>
      </div>
      <p className="new-game-warning">{t('newGame.warning')}</p>
    </Modal>
  );
}
