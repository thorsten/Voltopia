/**
 * Network side of the town import: place search on Nominatim and the
 * Overpass download of a town excerpt. DOM-free — `fetch`, `URL` and
 * `AbortSignal` only — and every function takes its globals as `deps`
 * so tests inject them. The Overpass query is built from the tag tables
 * in OSM_IMPORT, the same ones the rasteriser reads, so the download and
 * the mapping cannot drift apart.
 */
import { OSM_IMPORT } from './config.ts';
import { type Bbox, OsmImportError } from './osm.ts';

export interface FetchDeps {
  fetch?: typeof fetch;
  /** Clock in milliseconds for the search rate gate. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Overpass client timeout in milliseconds; defaults to the server timeout. */
  overpassTimeoutMs?: number;
}

export interface PlaceHit {
  name: string;
  displayName: string;
  type: string;
  lat: number;
  lon: number;
}

/** Shape of a Nominatim `jsonv2` hit, as far as the import reads it. */
interface NominatimHit {
  name?: string;
  display_name?: string;
  type?: string;
  lat?: string | number;
  lon?: string | number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveDeps(deps: FetchDeps): Required<FetchDeps> {
  return {
    fetch: deps.fetch ?? globalThis.fetch,
    now: deps.now ?? Date.now,
    sleep: deps.sleep ?? defaultSleep,
    overpassTimeoutMs: deps.overpassTimeoutMs ?? OSM_IMPORT.overpassTimeoutS * 1000,
  };
}

function alternation(values: readonly string[]): string {
  return `^(${values.join('|')})$`;
}

/**
 * Overpass QL for everything in the mapping table inside `bbox`: roads,
 * rail, waterways, water and wood areas, zone landuses, buildings and
 * the place nodes that can name the town, as ways and as multipolygon
 * relations; `>` pulls in their nodes.
 */
export function buildOverpassQuery(bbox: Bbox): string {
  const [w, s, e, n] = bbox;
  const highways = alternation([
    ...OSM_IMPORT.avenueHighways,
    ...OSM_IMPORT.streetHighways,
    ...OSM_IMPORT.pedestrianHighways,
  ]);
  const railways = alternation(OSM_IMPORT.railways);
  const waterways = alternation(OSM_IMPORT.waterways);
  const naturals = alternation([...OSM_IMPORT.waterNaturals, ...OSM_IMPORT.forestNaturals]);
  const landuses = alternation([
    ...OSM_IMPORT.waterLanduses,
    ...OSM_IMPORT.forestLanduses,
    ...Object.keys(OSM_IMPORT.zoneLanduses),
  ]);
  const places = alternation(OSM_IMPORT.placeRanks);
  const settings = `[out:xml][timeout:${OSM_IMPORT.overpassTimeoutS}][bbox:${s},${w},${n},${e}];`;
  const union = [
    `way["highway"~"${highways}"];`,
    `way["railway"~"${railways}"];`,
    `way["waterway"~"${waterways}"];`,
    `way["natural"~"${naturals}"];`,
    `way["water"];`,
    `way["landuse"~"${landuses}"];`,
    `way["building"];`,
    `relation["type"="multipolygon"]["natural"~"${naturals}"];`,
    `relation["type"="multipolygon"]["water"];`,
    `relation["type"="multipolygon"]["landuse"~"${landuses}"];`,
    `node["place"~"${places}"];`,
  ];
  return `${settings}\n(\n${union.join('\n')}\n);\nout body;\n>;\nout skel qt;`;
}

/** Start time of the last Nominatim request, for the rate gate. */
let lastSearchStart = -Infinity;

/** Forgets the last search time (tests). */
export function resetSearchGate(): void {
  lastSearchStart = -Infinity;
}

function hitName(hit: NominatimHit): string {
  if (hit.name !== undefined && hit.name !== '') return hit.name;
  const display = hit.display_name ?? '';
  const comma = display.indexOf(',');
  return (comma === -1 ? display : display.slice(0, comma)).trim();
}

/**
 * Nominatim place search. Honours the usage policy: a call within
 * `searchMinIntervalMs` of the previous request waits, and the caller
 * must not fire it as autocomplete. A blank query returns no hits
 * without a request.
 */
export async function searchPlaces(
  query: string,
  locale: string,
  deps: FetchDeps = {},
): Promise<PlaceHit[]> {
  const trimmed = query.trim();
  if (trimmed === '') return [];
  const { fetch, now, sleep } = resolveDeps(deps);
  const wait = lastSearchStart + OSM_IMPORT.searchMinIntervalMs - now();
  if (wait > 0) await sleep(wait);
  lastSearchStart = now();
  const url = new URL(OSM_IMPORT.nominatimUrl);
  url.search = new URLSearchParams({
    q: trimmed,
    format: 'jsonv2',
    limit: String(OSM_IMPORT.searchLimit),
    'accept-language': locale,
  }).toString();
  let hits: NominatimHit[];
  try {
    const response = await fetch(url.toString(), { method: 'GET' });
    if (!response.ok) throw new OsmImportError('searchFailed');
    hits = (await response.json()) as NominatimHit[];
  } catch (error) {
    throw error instanceof OsmImportError ? error : new OsmImportError('searchFailed');
  }
  if (!Array.isArray(hits)) throw new OsmImportError('searchFailed');
  return hits.map((hit) => ({
    name: hitName(hit),
    displayName: hit.display_name ?? '',
    type: hit.type ?? '',
    lat: Number(hit.lat),
    lon: Number(hit.lon),
  }));
}

/**
 * Downloads the OSM XML of a box from the Overpass endpoints in turn:
 * a network error, HTTP error or timeout moves on to the next one, the
 * last failure surfaces as `fetchFailed`. The caller's `signal` aborts
 * the download with `aborted`.
 */
export async function fetchTown(
  bbox: Bbox,
  deps: FetchDeps = {},
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new OsmImportError('aborted');
  const { fetch, overpassTimeoutMs } = resolveDeps(deps);
  const body = new URLSearchParams({ data: buildOverpassQuery(bbox) }).toString();
  for (const endpoint of OSM_IMPORT.overpassEndpoints) {
    const timeout = AbortSignal.timeout(overpassTimeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: combined,
      });
      if (response.ok) return await response.text();
      // 429/503/504 is the endpoint saying "not now"; any other status is
      // unexpected for the same query — either way the next endpoint gets a go.
    } catch {
      // Network error or timeout: next endpoint. A caller abort ends the download.
      if (signal?.aborted) throw new OsmImportError('aborted');
    }
  }
  throw new OsmImportError('fetchFailed');
}
