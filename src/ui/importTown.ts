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
import type { ImportReport } from '../import/rasterise.ts';
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
}

export type ImportFlowAction =
  | { type: 'query'; query: string }
  | { type: 'search' }
  | { type: 'searched'; hits: PlaceHit[] }
  | { type: 'pick'; place: PlaceHit }
  | { type: 'side'; sideKm: number }
  | { type: 'size'; size: number }
  | { type: 'load'; source: ImportSource }
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
  };
}

const NO_DATA = { data: null, bbox: null, layout: null, report: null, source: null } as const;
const NO_ERROR = { errorKey: null, errorStep: null } as const;

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
      return { ...state, status: 'loading', source: action.source, ...NO_ERROR };
    case 'parsed':
      return {
        ...state,
        status: 'parsed',
        data: action.data,
        bbox: action.bbox,
        layout: null,
        report: null,
        ...NO_ERROR,
      };
    case 'rasterised':
      // Only the preview of the current data; a stale effect result is dropped.
      if (state.status !== 'parsed' || action.layout.size !== state.size) return state;
      return { ...state, layout: action.layout, report: action.report };
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
  return (sideKm * 1000) / size;
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
export async function readTownFile(file: File): Promise<OsmData> {
  return parseOsm(await file.text());
}

export interface LoadDeps {
  fetchTown?: typeof fetchTown;
}

/** Download the `sideKm` box around a place from Overpass and parse it. */
export async function loadTown(
  place: Pick<PlaceHit, 'lat' | 'lon'>,
  sideKm: number,
  signal?: AbortSignal,
  deps: LoadDeps = {},
): Promise<{ data: OsmData; bbox: Bbox }> {
  const bbox = squareBbox(place.lat, place.lon, sideKm);
  const xml = await (deps.fetchTown ?? fetchTown)(bbox, {}, signal);
  return { data: parseOsm(xml), bbox };
}
