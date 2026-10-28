/**
 * The town-import flow of the new-game page, without React: the file
 * and network loaders, the error-to-message mapping and a pure reducer
 * for the page's state, so the transitions are unit-tested in node.
 * Rasterising stays out of the reducer; the page runs it in an effect
 * keyed on the parsed data and dispatches `rasterised`.
 */
import { OSM_IMPORT } from '../import/config.ts';
import { fetchTown, type PlaceHit } from '../import/fetch.ts';
import { squareBbox } from '../import/geo.ts';
import { type Bbox, type OsmData, OsmImportError, parseOsm } from '../import/osm.ts';
import { type ImportReport, marginTiles } from '../import/rasterise.ts';
import { GRID_SIZE } from '../shared/constants.ts';
import type { TownLayout } from '../shared/types.ts';
import type { TranslationKey } from './i18n.tsx';

/** Side of the excerpt offered when the page opens (the middle option). */
export const DEFAULT_SIDE_KM: number = OSM_IMPORT.sideKm[1];

/** What the page is doing; the data fields say what it has. */
export type ImportFlowStatus = 'idle' | 'searching' | 'results' | 'loading' | 'parsed' | 'error';

/** Which step an error belongs to, so it shows inline under that step. */
export type ImportStep = 'search' | 'load' | 'file';

/** Where the parsed data came from: the side buttons only apply to a search. */
export type ImportSource = 'search' | 'file';

/**
 * Steps of a load as the bar names them. A search goes connecting →
 * downloading → parsing → rasterising, a file reading → parsing →
 * rasterising.
 */
export type ImportPhase = 'connecting' | 'downloading' | 'parsing' | 'rasterising' | 'reading';

export interface ImportProgress {
  phase: ImportPhase;
  /** Bytes received so far (download only). */
  bytes: number;
  /** Declared download size, or null when the response is chunked. */
  total: number | null;
  /** Milliseconds since the load started. */
  elapsedMs: number;
  /** Side of the excerpt being loaded; sizes the download estimate. */
  sideKm: number;
}

/** What a loader reports: the fetch phases plus `parsing` before the parse. */
export type LoadProgress = Pick<ImportProgress, 'phase' | 'bytes' | 'total'>;

export type LoadProgressListener = (progress: LoadProgress) => void;

export interface ImportFlowState {
  status: ImportFlowStatus;
  query: string;
  hits: PlaceHit[];
  place: PlaceHit | null;
  sideKm: number;
  size: number;
  source: ImportSource | null;
  data: OsmData | null;
  /** The box the data was fetched for; null for a file (its own bounds apply). */
  bbox: Bbox | null;
  layout: TownLayout | null;
  report: ImportReport | null;
  errorKey: TranslationKey | null;
  errorStep: ImportStep | null;
  /** The running step while loading and rasterising; null once the preview is there. */
  progress: ImportProgress | null;
  /** The bar's value: the highest estimate so far, so it never steps back. */
  percent: number;
}

export type ImportFlowAction =
  | { type: 'query'; query: string }
  | { type: 'search' }
  | { type: 'searched'; hits: PlaceHit[] }
  | { type: 'pick'; place: PlaceHit }
  | { type: 'side'; sideKm: number }
  | { type: 'size'; size: number }
  | { type: 'load'; source: ImportSource }
  | ({ type: 'progress' } & LoadProgress)
  | { type: 'tick'; elapsedMs: number }
  | { type: 'parsed'; data: OsmData; bbox: Bbox | null }
  | { type: 'rasterised'; layout: TownLayout; report: ImportReport }
  | { type: 'failed'; step: ImportStep; errorKey: TranslationKey }
  | { type: 'cancel' };

export function initialImportState(size: number = GRID_SIZE): ImportFlowState {
  return {
    status: 'idle',
    query: '',
    hits: [],
    place: null,
    sideKm: DEFAULT_SIDE_KM,
    size,
    source: null,
    data: null,
    bbox: null,
    layout: null,
    report: null,
    errorKey: null,
    errorStep: null,
    progress: null,
    percent: 0,
  };
}

const NO_PROGRESS = { progress: null, percent: 0 } as const;
const NO_DATA = {
  data: null,
  bbox: null,
  layout: null,
  report: null,
  source: null,
  ...NO_PROGRESS,
} as const;
const NO_ERROR = { errorKey: null, errorStep: null } as const;

/** Where each phase sits on the bar, in percent. */
const PERCENT_BANDS = {
  /** The wait for the first byte creeps through this band. */
  connecting: { from: 0, to: 10 },
  /** The download fills this band, exactly or by the size estimate. */
  downloading: { from: 10, to: 80 },
  parsing: 85,
  rasterising: 95,
  done: 100,
} as const;

/**
 * The bar's estimate for a progress state. Only a download with a
 * declared total is exact; the connecting wait and a chunked download
 * creep towards their band's end with `1 − exp(−x / expected)`, so the
 * bar keeps moving but never claims to be done. Not monotonic by itself:
 * the reducer keeps the maximum.
 */
export function importProgressPercent(progress: ImportProgress): number {
  const { expectedBytesPerKm2, expectedConnectMs } = OSM_IMPORT.progress;
  switch (progress.phase) {
    case 'connecting':
    case 'reading': {
      // A file read is the same wait for the first byte, just a short one.
      const { from, to } = PERCENT_BANDS.connecting;
      return from + (to - from) * (1 - Math.exp(-progress.elapsedMs / expectedConnectMs));
    }
    case 'downloading': {
      const { from, to } = PERCENT_BANDS.downloading;
      const expected = expectedBytesPerKm2 * progress.sideKm * progress.sideKm;
      const ratio =
        progress.total !== null
          ? Math.min(1, progress.bytes / progress.total)
          : 1 - Math.exp(-progress.bytes / expected);
      return from + (to - from) * ratio;
    }
    case 'parsing':
      return PERCENT_BANDS.parsing;
    case 'rasterising':
      return PERCENT_BANDS.rasterising;
  }
}

/** The state with a new progress step; the percent never drops. */
function withProgress(state: ImportFlowState, progress: ImportProgress): ImportFlowState {
  return {
    ...state,
    progress,
    percent: Math.max(state.percent, importProgressPercent(progress)),
  };
}

/** The status to show once nothing is loading: results if there are any. */
function restingStatus(state: ImportFlowState): ImportFlowStatus {
  if (state.data) return 'parsed';
  return state.hits.length > 0 ? 'results' : 'idle';
}

export function importTownReducer(
  state: ImportFlowState,
  action: ImportFlowAction,
): ImportFlowState {
  switch (action.type) {
    case 'query':
      // Typing clears a search error; the hits stay until the next search.
      return {
        ...state,
        query: action.query,
        ...(state.errorStep === 'search' ? { ...NO_ERROR, status: restingStatus(state) } : {}),
      };
    case 'search':
      return { ...state, status: 'searching', hits: [], ...NO_ERROR };
    case 'searched':
      if (action.hits.length === 0) {
        return {
          ...state,
          status: 'error',
          hits: [],
          errorKey: 'newGame.import.noResults',
          errorStep: 'search',
        };
      }
      return { ...state, status: 'results', hits: action.hits, ...NO_ERROR };
    case 'pick':
      // A new place needs a new load: the preview of the old one goes.
      return { ...state, status: 'results', place: action.place, ...NO_DATA, ...NO_ERROR };
    case 'side':
      if (action.sideKm === state.sideKm) return state;
      // The side only shapes a search excerpt; a file keeps its own bounds.
      return state.source === 'search'
        ? { ...state, sideKm: action.sideKm, status: 'results', ...NO_DATA, ...NO_ERROR }
        : { ...state, sideKm: action.sideKm };
    case 'size':
      if (action.size === state.size) return state;
      // Parsed data is re-rasterised by the page's effect; until then no preview.
      return { ...state, size: action.size, layout: null, report: null };
    case 'load':
      return withProgress(
        { ...state, status: 'loading', source: action.source, ...NO_ERROR, ...NO_PROGRESS },
        {
          phase: action.source === 'file' ? 'reading' : 'connecting',
          bytes: 0,
          total: null,
          elapsedMs: 0,
          sideKm: state.sideKm,
        },
      );
    case 'progress':
      // A step of a load that is no longer running (cancelled, failed) is stale.
      if (state.status !== 'loading' || !state.progress) return state;
      return withProgress(state, {
        ...state.progress,
        phase: action.phase,
        bytes: action.bytes,
        total: action.total,
      });
    case 'tick':
      if (!state.progress) return state;
      return withProgress(state, { ...state.progress, elapsedMs: action.elapsedMs });
    case 'parsed': {
      const parsed: ImportFlowState = {
        ...state,
        status: 'parsed',
        data: action.data,
        bbox: action.bbox,
        layout: null,
        report: null,
        ...NO_ERROR,
      };
      // The page's effect rasterises next; the bar stays up for it.
      return withProgress(parsed, {
        phase: 'rasterising',
        bytes: state.progress?.bytes ?? 0,
        total: state.progress?.total ?? null,
        elapsedMs: state.progress?.elapsedMs ?? 0,
        sideKm: state.progress?.sideKm ?? state.sideKm,
      });
    }
    case 'rasterised':
      // Only the preview of the current data; a stale effect result is dropped.
      if (state.status !== 'parsed' || action.layout.size !== state.size) return state;
      return {
        ...state,
        layout: action.layout,
        report: action.report,
        progress: null,
        percent: PERCENT_BANDS.done,
      };
    case 'failed':
      return {
        ...state,
        status: 'error',
        ...(action.step === 'search' ? { hits: [] } : NO_DATA),
        errorKey: action.errorKey,
        errorStep: action.step,
      };
    case 'cancel':
      if (state.status !== 'loading') return state;
      return { ...state, status: restingStatus({ ...state, ...NO_DATA }), ...NO_DATA };
  }
}

/** Whether a town is loaded and the next city starts from it. */
export function importedLayout(state: ImportFlowState): TownLayout | null {
  return state.status === 'parsed' ? state.layout : null;
}

/** The Start button waits for a load and refuses while an import step failed. */
export function importBlocksStart(state: ImportFlowState): boolean {
  return state.status === 'loading' || state.status === 'error';
}

/** Metres one tile covers for a side and map size (shown before loading). */
export function metresPerTile(sideKm: number, size: number): number {
  return (sideKm * 1000) / (size - 2 * marginTiles(size));
}

const ERROR_KEYS: Record<OsmImportError['code'], TranslationKey> = {
  notOsm: 'newGame.import.error.notOsm',
  boxTooLarge: 'newGame.import.error.boxTooLarge',
  searchFailed: 'newGame.import.error.searchFailed',
  fetchFailed: 'newGame.import.error.fetchFailed',
  aborted: 'newGame.import.error.aborted',
  empty: 'newGame.import.error.empty',
};

/** The message key for an import failure; anything unexpected gets the generic one. */
export function importErrorKey(error: unknown): TranslationKey {
  if (error instanceof OsmImportError) return ERROR_KEYS[error.code];
  return 'newGame.import.error.unknown';
}

/** Parse a chosen `.osm` file (the whole text at once; a 12 MB export takes about a second). */
export async function readTownFile(
  file: File,
  onProgress?: LoadProgressListener,
): Promise<OsmData> {
  onProgress?.({ phase: 'reading', bytes: 0, total: file.size });
  const text = await file.text();
  onProgress?.({ phase: 'parsing', bytes: file.size, total: file.size });
  return parseOsm(text);
}

export interface LoadDeps {
  fetchTown?: typeof fetchTown;
}

/** Download the `sideKm` box around a place from Overpass and parse it. */
export async function loadTown(
  place: Pick<PlaceHit, 'lat' | 'lon'>,
  sideKm: number,
  signal?: AbortSignal,
  onProgress?: LoadProgressListener,
  deps: LoadDeps = {},
): Promise<{ data: OsmData; bbox: Bbox }> {
  const bbox = squareBbox(place.lat, place.lon, sideKm);
  // What the download reported last, so the parsing step keeps the size.
  const received = { bytes: 0, total: null as number | null };
  const xml = await (deps.fetchTown ?? fetchTown)(bbox, {}, signal, (progress) => {
    received.bytes = progress.bytes;
    received.total = progress.total;
    onProgress?.(progress);
  });
  onProgress?.({ phase: 'parsing', ...received });
  return { data: parseOsm(xml), bbox };
}
