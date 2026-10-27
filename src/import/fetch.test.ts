import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OSM_IMPORT } from './config.ts';
import {
  buildOverpassQuery,
  type FetchDeps,
  type FetchProgress,
  fetchTown,
  resetSearchGate,
  searchPlaces,
} from './fetch.ts';
import { squareBbox, METRES_PER_DEGREE, metresPerDegreeLon } from './geo.ts';
import { type Bbox, OsmImportError } from './osm.ts';

const bbox: Bbox = [8.6, 49.8, 8.7, 49.9];

type Call = { url: string; init: RequestInit | undefined };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A fetch stub that answers each call with the next item of `answers`. */
function fakeFetch(answers: Array<Response | Error | 'hang'>): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const stub = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const answer = answers.shift();
    if (answer === undefined) throw new Error('unexpected fetch call');
    if (answer === 'hang') {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    }
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(answer);
  }) as typeof fetch;
  return { fetch: stub, calls };
}

/** A response whose body arrives in the given chunks, optionally with a Content-Length. */
function chunkedResponse(chunks: string[], total?: number): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: total === undefined ? {} : { 'content-length': String(total) },
  });
}

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(OsmImportError);
    return (error as OsmImportError).code;
  }
  throw new Error('expected a rejection');
}

describe('squareBbox', () => {
  it('spans sideKm metres in both directions around the centre', () => {
    const [w, s, e, n] = squareBbox(49.87, 8.65, 3.5);
    expect((n - s) * METRES_PER_DEGREE).toBeCloseTo(3500, 6);
    expect((e - w) * metresPerDegreeLon(49.87)).toBeCloseTo(3500, 6);
    expect((w + e) / 2).toBeCloseTo(8.65, 9);
    expect((s + n) / 2).toBeCloseTo(49.87, 9);
  });
});

describe('buildOverpassQuery', () => {
  const query = buildOverpassQuery(bbox);

  it('sets output, timeout and the box as south,west,north,east', () => {
    expect(
      query.startsWith(
        `[out:xml][timeout:${OSM_IMPORT.overpassTimeoutS}][bbox:49.8,8.6,49.9,8.7];`,
      ),
    ).toBe(true);
    expect(query.endsWith('out body;\n>;\nout skel qt;')).toBe(true);
  });

  it('contains every tag value of the mapping tables', () => {
    const values = [
      ...OSM_IMPORT.avenueHighways,
      ...OSM_IMPORT.streetHighways,
      ...OSM_IMPORT.pedestrianHighways,
      ...OSM_IMPORT.railways,
      ...OSM_IMPORT.waterways,
      ...OSM_IMPORT.waterNaturals,
      ...OSM_IMPORT.waterLanduses,
      ...OSM_IMPORT.forestLanduses,
      ...OSM_IMPORT.forestNaturals,
      ...Object.keys(OSM_IMPORT.zoneLanduses),
      ...OSM_IMPORT.placeRanks,
    ];
    for (const value of values) {
      expect(query, value).toMatch(new RegExp(`[(|]${value}[|)]`));
    }
  });

  it('asks for ways, multipolygon relations, buildings and place nodes', () => {
    expect(query).toContain('way["highway"~');
    expect(query).toContain('way["railway"~');
    expect(query).toContain('way["waterway"~');
    expect(query).toContain('way["water"];');
    expect(query).toContain('way["building"];');
    expect(query).toContain('relation["type"="multipolygon"]["natural"~');
    expect(query).toContain('relation["type"="multipolygon"]["water"];');
    expect(query).toContain('relation["type"="multipolygon"]["landuse"~');
    expect(query).toContain('node["place"~');
    expect(query).not.toContain('footway');
  });
});

describe('searchPlaces', () => {
  beforeEach(() => resetSearchGate());
  afterEach(() => resetSearchGate());

  it('queries Nominatim with jsonv2, the limit and the locale', async () => {
    const { fetch, calls } = fakeFetch([jsonResponse([])]);
    await searchPlaces(' Darmstadt ', 'de', { fetch });
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(`${url.origin}${url.pathname}`).toBe(OSM_IMPORT.nominatimUrl);
    expect(url.searchParams.get('q')).toBe('Darmstadt');
    expect(url.searchParams.get('format')).toBe('jsonv2');
    expect(url.searchParams.get('limit')).toBe(String(OSM_IMPORT.searchLimit));
    expect(url.searchParams.get('accept-language')).toBe('de');
    expect(calls[0].init?.method).toBe('GET');
  });

  it('maps hits to name, displayName, type and numeric coordinates', async () => {
    const { fetch } = fakeFetch([
      jsonResponse([
        {
          name: 'Darmstadt',
          display_name: 'Darmstadt, Hessen, Deutschland',
          type: 'city',
          lat: '49.8728',
          lon: '8.6512',
        },
        { display_name: 'Eberstadt, Darmstadt, Hessen', type: 'suburb', lat: '49.81', lon: '8.64' },
      ]),
    ]);
    const hits = await searchPlaces('Darmstadt', 'en', { fetch });
    expect(hits).toEqual([
      {
        name: 'Darmstadt',
        displayName: 'Darmstadt, Hessen, Deutschland',
        type: 'city',
        lat: 49.8728,
        lon: 8.6512,
      },
      {
        name: 'Eberstadt',
        displayName: 'Eberstadt, Darmstadt, Hessen',
        type: 'suburb',
        lat: 49.81,
        lon: 8.64,
      },
    ]);
  });

  it('returns no hits for an empty result', async () => {
    const { fetch } = fakeFetch([jsonResponse([])]);
    expect(await searchPlaces('xyzzy', 'en', { fetch })).toEqual([]);
  });

  it('does not request a blank query', async () => {
    const { fetch, calls } = fakeFetch([]);
    expect(await searchPlaces('   ', 'en', { fetch })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('fails with searchFailed on an HTTP error', async () => {
    const { fetch } = fakeFetch([jsonResponse({ error: 'boom' }, 500)]);
    expect(await errorCode(searchPlaces('Darmstadt', 'en', { fetch }))).toBe('searchFailed');
  });

  it('fails with searchFailed on a network error', async () => {
    const { fetch } = fakeFetch([new TypeError('Failed to fetch')]);
    expect(await errorCode(searchPlaces('Darmstadt', 'en', { fetch }))).toBe('searchFailed');
  });

  it('fails with searchFailed on a non-JSON body', async () => {
    const { fetch } = fakeFetch([new Response('<html>', { status: 200 })]);
    expect(await errorCode(searchPlaces('Darmstadt', 'en', { fetch }))).toBe('searchFailed');
  });

  it('waits before a second search inside the minimum interval', async () => {
    let clock = 10_000;
    const slept: number[] = [];
    const deps: FetchDeps = {
      now: () => clock,
      sleep: (ms) => {
        slept.push(ms);
        clock += ms;
        return Promise.resolve();
      },
    };
    const first = fakeFetch([jsonResponse([])]);
    await searchPlaces('a', 'en', { ...deps, fetch: first.fetch });
    expect(slept).toEqual([]);

    clock += 300;
    const second = fakeFetch([jsonResponse([])]);
    await searchPlaces('b', 'en', { ...deps, fetch: second.fetch });
    expect(slept).toEqual([OSM_IMPORT.searchMinIntervalMs - 300]);
    expect(second.calls).toHaveLength(1);

    clock += OSM_IMPORT.searchMinIntervalMs + 1;
    const third = fakeFetch([jsonResponse([])]);
    await searchPlaces('c', 'en', { ...deps, fetch: third.fetch });
    expect(slept).toHaveLength(1);
  });

  it('counts the interval from the previous request start even if it failed', async () => {
    let clock = 0;
    const slept: number[] = [];
    const deps: FetchDeps = {
      now: () => clock,
      sleep: (ms) => {
        slept.push(ms);
        clock += ms;
        return Promise.resolve();
      },
    };
    await errorCode(
      searchPlaces('a', 'en', { ...deps, fetch: fakeFetch([new TypeError('x')]).fetch }),
    );
    await searchPlaces('b', 'en', { ...deps, fetch: fakeFetch([jsonResponse([])]).fetch });
    expect(slept).toEqual([OSM_IMPORT.searchMinIntervalMs]);
  });
});

describe('fetchTown', () => {
  const [first, second] = OSM_IMPORT.overpassEndpoints;

  it('posts the query as a form body to the first endpoint', async () => {
    const { fetch, calls } = fakeFetch([new Response('<osm/>')]);
    expect(await fetchTown(bbox, { fetch })).toBe('<osm/>');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(first);
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].init?.headers).toEqual({ 'content-type': 'application/x-www-form-urlencoded' });
    const body = new URLSearchParams(calls[0].init?.body as string);
    expect(body.get('data')).toBe(buildOverpassQuery(bbox));
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('moves to the second endpoint on 429', async () => {
    const { fetch, calls } = fakeFetch([
      new Response('busy', { status: 429 }),
      new Response('<osm/>'),
    ]);
    expect(await fetchTown(bbox, { fetch })).toBe('<osm/>');
    expect(calls.map((c) => c.url)).toEqual([first, second]);
  });

  it('moves to the second endpoint on 503 and 504', async () => {
    for (const status of [503, 504]) {
      const { fetch, calls } = fakeFetch([new Response('', { status }), new Response('<osm/>')]);
      expect(await fetchTown(bbox, { fetch })).toBe('<osm/>');
      expect(calls.map((c) => c.url)).toEqual([first, second]);
    }
  });

  it('moves to the second endpoint on another HTTP error', async () => {
    const { fetch, calls } = fakeFetch([
      new Response('bad query', { status: 400 }),
      new Response('<osm/>'),
    ]);
    expect(await fetchTown(bbox, { fetch })).toBe('<osm/>');
    expect(calls.map((c) => c.url)).toEqual([first, second]);
  });

  it('moves to the second endpoint on a network error', async () => {
    const { fetch, calls } = fakeFetch([new TypeError('Failed to fetch'), new Response('<osm/>')]);
    expect(await fetchTown(bbox, { fetch })).toBe('<osm/>');
    expect(calls.map((c) => c.url)).toEqual([first, second]);
  });

  it('moves to the second endpoint on a timeout', async () => {
    const { fetch, calls } = fakeFetch(['hang', new Response('<osm/>')]);
    expect(await fetchTown(bbox, { fetch, overpassTimeoutMs: 5 })).toBe('<osm/>');
    expect(calls.map((c) => c.url)).toEqual([first, second]);
  });

  it('fails with fetchFailed after the last endpoint', async () => {
    const { fetch, calls } = fakeFetch([
      new Response('', { status: 429 }),
      new TypeError('Failed to fetch'),
    ]);
    expect(await errorCode(fetchTown(bbox, { fetch }))).toBe('fetchFailed');
    expect(calls).toHaveLength(OSM_IMPORT.overpassEndpoints.length);
  });

  it('fails with aborted on a pre-aborted signal without a request', async () => {
    const { fetch, calls } = fakeFetch([]);
    const controller = new AbortController();
    controller.abort();
    expect(await errorCode(fetchTown(bbox, { fetch }, controller.signal))).toBe('aborted');
    expect(calls).toHaveLength(0);
  });

  it('reports connecting, then the bytes of each chunk with the declared total', async () => {
    const { fetch } = fakeFetch([chunkedResponse(['<osm>', '</osm>'], 11)]);
    const events: FetchProgress[] = [];
    expect(await fetchTown(bbox, { fetch }, undefined, (p) => events.push(p))).toBe('<osm></osm>');
    expect(events).toEqual([
      { phase: 'connecting', bytes: 0, total: null, endpoint: 0 },
      { phase: 'downloading', bytes: 5, total: 11, endpoint: 0 },
      { phase: 'downloading', bytes: 11, total: 11, endpoint: 0 },
    ]);
  });

  it('reports a null total for a chunked response without Content-Length', async () => {
    const { fetch } = fakeFetch([chunkedResponse(['<os', 'm/>'])]);
    const events: FetchProgress[] = [];
    expect(await fetchTown(bbox, { fetch }, undefined, (p) => events.push(p))).toBe('<osm/>');
    expect(events.filter((e) => e.phase === 'downloading')).toEqual([
      { phase: 'downloading', bytes: 3, total: null, endpoint: 0 },
      { phase: 'downloading', bytes: 6, total: null, endpoint: 0 },
    ]);
  });

  it('decodes a multi-byte character split across chunks', async () => {
    const bytes = new TextEncoder().encode('Schwabmünchen');
    const { fetch } = fakeFetch([
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            // Split inside the two-byte "ü".
            controller.enqueue(bytes.slice(0, 8));
            controller.enqueue(bytes.slice(8));
            controller.close();
          },
        }),
      ),
    ]);
    expect(await fetchTown(bbox, { fetch })).toBe('Schwabmünchen');
  });

  it('falls back to text() for a response without a body stream', async () => {
    const stub = {
      ok: true,
      body: null,
      headers: new Headers(),
      text: async () => '<osm/>',
    } as unknown as Response;
    const { fetch } = fakeFetch([stub]);
    const events: FetchProgress[] = [];
    expect(await fetchTown(bbox, { fetch }, undefined, (p) => events.push(p))).toBe('<osm/>');
    expect(events).toEqual([{ phase: 'connecting', bytes: 0, total: null, endpoint: 0 }]);
  });

  it('reports connecting again for the second endpoint', async () => {
    const { fetch } = fakeFetch([
      new Response('busy', { status: 429 }),
      chunkedResponse(['<osm/>']),
    ]);
    const events: FetchProgress[] = [];
    expect(await fetchTown(bbox, { fetch }, undefined, (p) => events.push(p))).toBe('<osm/>');
    expect(events).toEqual([
      { phase: 'connecting', bytes: 0, total: null, endpoint: 0 },
      { phase: 'connecting', bytes: 0, total: null, endpoint: 1 },
      { phase: 'downloading', bytes: 6, total: null, endpoint: 1 },
    ]);
  });

  it('fails with aborted when the caller aborts mid-flight', async () => {
    const { fetch, calls } = fakeFetch(['hang', new Response('<osm/>')]);
    const controller = new AbortController();
    const pending = errorCode(fetchTown(bbox, { fetch }, controller.signal));
    await Promise.resolve();
    controller.abort();
    expect(await pending).toBe('aborted');
    expect(calls).toHaveLength(1);
  });
});
