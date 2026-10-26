/**
 * OpenStreetMap XML parser for the town import. DOM-free and regex
 * based: the OSM API `map` call and the Overpass export are machine
 * written, so attribute order and escaping are predictable. Unknown
 * elements are skipped; only a document without an `<osm>` root or
 * without a single way is rejected.
 */

/** Longitude, latitude in degrees. */
export type LonLat = [number, number];

/** West, south, east, north in degrees. */
export type Bbox = [number, number, number, number];

export interface OsmWay {
  id: string;
  /** Node ids in drawing order; a closed ring repeats the first id last. */
  refs: string[];
  tags: Record<string, string>;
}

/** A multipolygon relation reduced to its outer way ids. */
export interface OsmRelation {
  outer: string[];
  tags: Record<string, string>;
}

/** A node carrying a `place` tag (city, town, village, …). */
export interface OsmPlace {
  lon: number;
  lat: number;
  tags: Record<string, string>;
}

export interface OsmData {
  nodes: Map<string, LonLat>;
  ways: OsmWay[];
  relations: OsmRelation[];
  /** Nodes tagged `place=*`, for the town name. */
  places: OsmPlace[];
  /** The export's `<bounds>` element when present. */
  bounds: Bbox | null;
}

/** Why an import failed; the UI maps the code to a message. */
export type OsmImportErrorCode =
  | 'notOsm'
  | 'boxTooLarge'
  | 'searchFailed'
  | 'fetchFailed'
  | 'aborted'
  | 'empty';

export class OsmImportError extends Error {
  readonly code: OsmImportErrorCode;

  constructor(code: OsmImportErrorCode) {
    super(code);
    this.name = 'OsmImportError';
    this.code = code;
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** Decode the XML entities OSM writers emit in attribute values. */
export function unescapeXml(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

function attribute(attrs: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];
}

function parseTags(body: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const m of body.matchAll(/<tag\b([^>]*?)\/?>/g)) {
    const k = attribute(m[1], 'k');
    const v = attribute(m[1], 'v');
    if (k !== undefined && v !== undefined) tags[unescapeXml(k)] = unescapeXml(v);
  }
  return tags;
}

export function parseOsm(xml: string): OsmData {
  if (!/<osm\b/.test(xml)) throw new OsmImportError('notOsm');

  const nodes = new Map<string, LonLat>();
  const places: OsmPlace[] = [];
  // Self-closing nodes carry no tags; nodes with a body are scanned for a place tag only.
  for (const m of xml.matchAll(/<node\b([^>]*?)(?:\/>|>([\s\S]*?)<\/node>)/g)) {
    const attrs = m[1];
    const id = attribute(attrs, 'id');
    const lat = Number(attribute(attrs, 'lat'));
    const lon = Number(attribute(attrs, 'lon'));
    if (id === undefined || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    nodes.set(id, [lon, lat]);
    const body = m[2];
    if (body !== undefined && body.includes('k="place"')) {
      const tags = parseTags(body);
      if (tags.place !== undefined) places.push({ lon, lat, tags });
    }
  }

  const ways: OsmWay[] = [];
  for (const m of xml.matchAll(/<way\b([^>]*)>([\s\S]*?)<\/way>/g)) {
    const id = attribute(m[1], 'id');
    if (id === undefined) continue;
    const body = m[2];
    const refs: string[] = [];
    for (const r of body.matchAll(/<nd\b([^>]*?)\/?>/g)) {
      const ref = attribute(r[1], 'ref');
      if (ref !== undefined) refs.push(ref);
    }
    ways.push({ id, refs, tags: parseTags(body) });
  }
  if (ways.length === 0) throw new OsmImportError('notOsm');

  const relations: OsmRelation[] = [];
  for (const m of xml.matchAll(/<relation\b[^>]*>([\s\S]*?)<\/relation>/g)) {
    const body = m[1];
    const tags = parseTags(body);
    if (tags.type !== 'multipolygon') continue;
    const outer: string[] = [];
    for (const r of body.matchAll(/<member\b([^>]*?)\/?>/g)) {
      const attrs = r[1];
      if (attribute(attrs, 'type') !== 'way' || attribute(attrs, 'role') !== 'outer') continue;
      const ref = attribute(attrs, 'ref');
      if (ref !== undefined) outer.push(ref);
    }
    relations.push({ outer, tags });
  }

  let bounds: Bbox | null = null;
  const b = /<bounds\b([^>]*?)\/?>/.exec(xml)?.[1];
  if (b !== undefined) {
    const box = [
      Number(attribute(b, 'minlon')),
      Number(attribute(b, 'minlat')),
      Number(attribute(b, 'maxlon')),
      Number(attribute(b, 'maxlat')),
    ];
    if (box.every(Number.isFinite)) bounds = box as Bbox;
  }

  return { nodes, ways, relations, places, bounds };
}
