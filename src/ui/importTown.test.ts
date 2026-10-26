import { describe, expect, it } from 'vitest';
import type { PlaceHit } from '../import/fetch.ts';
import { type OsmData, OsmImportError } from '../import/osm.ts';
import type { ImportReport } from '../import/rasterise.ts';
import type { TownLayout } from '../shared/types.ts';
import {
  DEFAULT_SIDE_KM,
  importBlocksStart,
  importErrorKey,
  importTownReducer,
  importedLayout,
  initialImportState,
  loadTown,
  metresPerTile,
  readTownFile,
  type ImportFlowState,
} from './importTown.ts';

const hit: PlaceHit = {
  name: 'Testhausen',
  displayName: 'Testhausen, Bayern, Deutschland',
  type: 'town',
  lat: 48.12,
  lon: 10.72,
};
const other: PlaceHit = { ...hit, name: 'Anderstadt', lat: 49, lon: 11 };

const data: OsmData = { nodes: new Map(), ways: [], relations: [], places: [], bounds: null };

function layoutOf(size: number): TownLayout {
  const tiles = size * size;
  return {
    size,
    terrain: new Uint8Array(tiles),
    forest: new Uint8Array(tiles),
    road: new Uint8Array(tiles),
    pedestrian: new Uint8Array(tiles),
    rail: new Uint8Array(tiles),
    zone: new Uint8Array(tiles),
    density: new Uint8Array(tiles),
    name: 'Testhausen',
    bbox: [10.7, 48.1, 10.74, 48.14],
  };
}

const report: ImportReport = {
  metresPerTile: 36,
  widthM: 3500,
  heightM: 3500,
  counts: {
    street: 1,
    avenue: 0,
    pedestrian: 0,
    rail: 0,
    river: 0,
    lake: 0,
    forest: 0,
    residential: 0,
    commercial: 0,
    retail: 0,
    industrial: 0,
    buildings: 0,
  },
  roadComponents: 1,
  droppedZones: 0,
  thinned: 0,
  skippedHighways: {},
};

function run(actions: Parameters<typeof importTownReducer>[1][], size = 96): ImportFlowState {
  return actions.reduce(importTownReducer, initialImportState(size));
}

const parsedSearch = (size = 96): ImportFlowState =>
  run(
    [
      { type: 'query', query: 'Test' },
      { type: 'search' },
      { type: 'searched', hits: [hit, other] },
      { type: 'pick', place: hit },
      { type: 'load', source: 'search' },
      { type: 'parsed', data, bbox: [1, 2, 3, 4] },
      { type: 'rasterised', layout: layoutOf(size), report },
    ],
    size,
  );

describe('importTownReducer: search', () => {
  it('starts idle with the middle side and the given size', () => {
    const state = initialImportState(64);
    expect(state.status).toBe('idle');
    expect(state.sideKm).toBe(DEFAULT_SIDE_KM);
    expect(state.size).toBe(64);
    expect(importedLayout(state)).toBeNull();
    expect(importBlocksStart(state)).toBe(false);
  });

  it('searches and lists hits', () => {
    const searching = run([{ type: 'query', query: 'Test' }, { type: 'search' }]);
    expect(searching.status).toBe('searching');
    const results = importTownReducer(searching, { type: 'searched', hits: [hit] });
    expect(results.status).toBe('results');
    expect(results.hits).toEqual([hit]);
  });

  it('reports no results as a search error that typing clears', () => {
    const empty = run([{ type: 'search' }, { type: 'searched', hits: [] }]);
    expect(empty.status).toBe('error');
    expect(empty.errorKey).toBe('newGame.import.noResults');
    expect(empty.errorStep).toBe('search');
    expect(importBlocksStart(empty)).toBe(true);
    const typed = importTownReducer(empty, { type: 'query', query: 'Testh' });
    expect(typed.status).toBe('idle');
    expect(typed.errorKey).toBeNull();
    expect(typed.query).toBe('Testh');
  });

  it('keeps hits while typing and drops them on a failed search', () => {
    const results = run([{ type: 'search' }, { type: 'searched', hits: [hit] }]);
    expect(importTownReducer(results, { type: 'query', query: 'x' }).hits).toEqual([hit]);
    const failed = importTownReducer(results, {
      type: 'failed',
      step: 'search',
      errorKey: 'newGame.import.error.searchFailed',
    });
    expect(failed.status).toBe('error');
    expect(failed.hits).toEqual([]);
  });

  it('picks a place and keeps the list', () => {
    const picked = run([
      { type: 'search' },
      { type: 'searched', hits: [hit, other] },
      { type: 'pick', place: other },
    ]);
    expect(picked.status).toBe('results');
    expect(picked.place).toBe(other);
    expect(picked.hits).toHaveLength(2);
  });
});

describe('importTownReducer: load, parse, rasterise', () => {
  it('loads, parses and takes the rasterised preview', () => {
    const state = parsedSearch();
    expect(state.status).toBe('parsed');
    expect(state.source).toBe('search');
    expect(state.bbox).toEqual([1, 2, 3, 4]);
    expect(state.layout?.size).toBe(96);
    expect(state.report).toBe(report);
    expect(importedLayout(state)).toBe(state.layout);
    expect(importBlocksStart(state)).toBe(false);
  });

  it('blocks Start while loading and lets cancel return to the results', () => {
    const loading = run([
      { type: 'search' },
      { type: 'searched', hits: [hit] },
      { type: 'pick', place: hit },
      { type: 'load', source: 'search' },
    ]);
    expect(loading.status).toBe('loading');
    expect(importBlocksStart(loading)).toBe(true);
    const cancelled = importTownReducer(loading, { type: 'cancel' });
    expect(cancelled.status).toBe('results');
    expect(cancelled.data).toBeNull();
    expect(cancelled.place).toBe(hit);
    // Cancel outside a load is a no-op.
    expect(importTownReducer(cancelled, { type: 'cancel' })).toBe(cancelled);
  });

  it('cancel without hits returns to idle', () => {
    const cancelled = run([{ type: 'load', source: 'file' }, { type: 'cancel' }]);
    expect(cancelled.status).toBe('idle');
  });

  it('a new size drops the preview and takes the next rasterised one', () => {
    const resized = importTownReducer(parsedSearch(), { type: 'size', size: 64 });
    expect(resized.status).toBe('parsed');
    expect(resized.data).toBe(data);
    expect(resized.layout).toBeNull();
    expect(resized.report).toBeNull();
    expect(importedLayout(resized)).toBeNull();
    // A stale result of the old size is ignored; the new one is taken.
    const stale = importTownReducer(resized, { type: 'rasterised', layout: layoutOf(96), report });
    expect(stale.layout).toBeNull();
    const fresh = importTownReducer(resized, { type: 'rasterised', layout: layoutOf(64), report });
    expect(fresh.layout?.size).toBe(64);
  });

  it('the same size again changes nothing', () => {
    const state = parsedSearch();
    expect(importTownReducer(state, { type: 'size', size: 96 })).toBe(state);
  });

  it('a rasterised result outside the parsed state is ignored', () => {
    const idle = initialImportState();
    expect(importTownReducer(idle, { type: 'rasterised', layout: layoutOf(64), report })).toBe(
      idle,
    );
  });

  it('a new place clears the data and preview', () => {
    const repicked = importTownReducer(parsedSearch(), { type: 'pick', place: other });
    expect(repicked.status).toBe('results');
    expect(repicked.data).toBeNull();
    expect(repicked.layout).toBeNull();
    expect(repicked.source).toBeNull();
    expect(repicked.hits).toHaveLength(2);
  });

  it('a new side clears a searched town but not a file', () => {
    const resided = importTownReducer(parsedSearch(), { type: 'side', sideKm: 5 });
    expect(resided.status).toBe('results');
    expect(resided.sideKm).toBe(5);
    expect(resided.data).toBeNull();
    const fromFile = run([
      { type: 'load', source: 'file' },
      { type: 'parsed', data, bbox: null },
      { type: 'rasterised', layout: layoutOf(96), report },
    ]);
    const keep = importTownReducer(fromFile, { type: 'side', sideKm: 5 });
    expect(keep.status).toBe('parsed');
    expect(keep.sideKm).toBe(5);
    expect(keep.layout).not.toBeNull();
    // The same side again is a no-op.
    expect(importTownReducer(keep, { type: 'side', sideKm: 5 })).toBe(keep);
  });

  it('a failed load clears the data and blocks Start until the next load', () => {
    const failed = importTownReducer(parsedSearch(), {
      type: 'failed',
      step: 'load',
      errorKey: 'newGame.import.error.fetchFailed',
    });
    expect(failed.status).toBe('error');
    expect(failed.errorStep).toBe('load');
    expect(failed.data).toBeNull();
    expect(failed.place).toBe(hit);
    expect(importBlocksStart(failed)).toBe(true);
    const retried = importTownReducer(failed, { type: 'load', source: 'search' });
    expect(retried.status).toBe('loading');
    expect(retried.errorKey).toBeNull();
  });

  it('typing after a load error does not clear it', () => {
    const failed = importTownReducer(parsedSearch(), {
      type: 'failed',
      step: 'file',
      errorKey: 'newGame.import.error.notOsm',
    });
    expect(importTownReducer(failed, { type: 'query', query: 'x' }).status).toBe('error');
  });
});

describe('metres per tile', () => {
  it('divides the side by the map size', () => {
    expect(metresPerTile(3.5, 96)).toBeCloseTo(36.46, 2);
    expect(metresPerTile(5, 128)).toBeCloseTo(39.06, 2);
  });
});

describe('importErrorKey', () => {
  it('maps every OsmImportError code to its message', () => {
    const codes = ['notOsm', 'boxTooLarge', 'searchFailed', 'fetchFailed', 'aborted', 'empty'];
    for (const code of codes) {
      expect(importErrorKey(new OsmImportError(code as OsmImportError['code']))).toBe(
        `newGame.import.error.${code}`,
      );
    }
  });

  it('maps anything else to the generic message', () => {
    expect(importErrorKey(new TypeError('boom'))).toBe('newGame.import.error.unknown');
    expect(importErrorKey('string')).toBe('newGame.import.error.unknown');
  });
});

describe('loaders', () => {
  const xml =
    '<osm version="0.6"><node id="1" lat="48.1" lon="10.7"/><node id="2" lat="48.11" lon="10.71"/>' +
    '<way id="3"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/></way></osm>';

  it('reads a file as OSM data', async () => {
    const file = { text: async () => xml } as unknown as File;
    const parsed = await readTownFile(file);
    expect(parsed.ways).toHaveLength(1);
  });

  it('rejects a file that is not OSM', async () => {
    const file = { text: async () => '<html></html>' } as unknown as File;
    await expect(readTownFile(file)).rejects.toMatchObject({ code: 'notOsm' });
  });

  it('fetches the square box around the place and parses the answer', async () => {
    const calls: unknown[] = [];
    const { data: loaded, bbox } = await loadTown(hit, 2.5, undefined, {
      fetchTown: async (box, _deps, signal) => {
        calls.push([box, signal]);
        return xml;
      },
    });
    expect(loaded.ways).toHaveLength(1);
    expect(calls).toHaveLength(1);
    // A 2.5 km box: about 0.0225° of latitude either side of the centre.
    expect(bbox[3] - bbox[1]).toBeCloseTo(2500 / 111_320, 5);
    expect((bbox[0] + bbox[2]) / 2).toBeCloseTo(hit.lon, 6);
  });
});
