// Spike: rasterise an OpenStreetMap export (.osm XML) onto the Voltopia tile grid.
//
//   node scripts/probe-osm.mjs town.osm [size] [--bbox=minlon,minlat,maxlon,maxlat] [--services] [--manhattan]
//
// --manhattan simplifies every way (Douglas-Peucker, ~1.5 tiles) and draws each
// segment as an axis-aligned L instead of a diagonal staircase: fewer corners,
// less faithful shape. Compare both pictures on a real export.
//
// Prints the grid as ASCII plus pacing stats (metres per tile, tile counts,
// road connectivity, staircase share). No dependencies, no sim import:
// the question is only whether a real town is still recognisable on the grid.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const file = args[0];
if (!file) {
  console.error('usage: node scripts/probe-osm.mjs town.osm [size] [--bbox w,s,e,n] [--services]');
  process.exit(1);
}
const size = Number(args.find((a, i) => i > 0 && /^\d+$/.test(a)) ?? 96);
const bboxArg = args.find((a) => a.startsWith('--bbox='))?.slice(7);
const withServices = args.includes('--services');
const manhattan = args.includes('--manhattan');
const SIMPLIFY_TOL = 1.5; // tiles
const MAX_STEP = 6; // tiles: a long diagonal becomes stairs with steps this long, not one giant L

// ---------- parse ----------
const xml = readFileSync(file, 'utf8');
const nodes = new Map();
for (const m of xml.matchAll(/<node\b([^>]*?)\/?>/g)) {
  const a = m[1];
  const id = /\bid="(-?\d+)"/.exec(a)?.[1];
  const lat = Number(/\blat="(-?[\d.]+)"/.exec(a)?.[1]);
  const lon = Number(/\blon="(-?[\d.]+)"/.exec(a)?.[1]);
  if (id && Number.isFinite(lat) && Number.isFinite(lon)) nodes.set(id, [lon, lat]);
}
const ways = [];
for (const m of xml.matchAll(/<way\b[^>]*>([\s\S]*?)<\/way>/g)) {
  const body = m[1];
  const refs = [...body.matchAll(/<nd ref="(-?\d+)"/g)].map((r) => r[1]);
  const tags = {};
  for (const t of body.matchAll(/<tag k="([^"]*)" v="([^"]*)"/g)) tags[t[1]] = t[2];
  ways.push({ refs, tags });
}
// Multipolygon relations (lakes with islands, large forests): take the outer ways.
const relations = [];
for (const m of xml.matchAll(/<relation\b[^>]*>([\s\S]*?)<\/relation>/g)) {
  const body = m[1];
  const tags = {};
  for (const t of body.matchAll(/<tag k="([^"]*)" v="([^"]*)"/g)) tags[t[1]] = t[2];
  if (tags.type !== 'multipolygon') continue;
  const outer = [...body.matchAll(/<member type="way" ref="(-?\d+)" role="outer"/g)].map(
    (r) => r[1],
  );
  relations.push({ outer, tags });
}
const wayById = new Map();
for (const m of xml.matchAll(/<way\b([^>]*)>([\s\S]*?)<\/way>/g)) {
  const id = /\bid="(-?\d+)"/.exec(m[1])?.[1];
  if (id)
    wayById.set(
      id,
      [...m[2].matchAll(/<nd ref="(-?\d+)"/g)].map((r) => r[1]),
    );
}

// ---------- bounding box, square in metres ----------
let bbox;
if (bboxArg) bbox = bboxArg.split(',').map(Number);
else {
  const b = /<bounds\b([^>]*)\/?>/.exec(xml)?.[1];
  if (b) {
    bbox = ['minlon', 'minlat', 'maxlon', 'maxlat'].map((k) =>
      Number(new RegExp(`${k}="(-?[\\d.]+)"`).exec(b)[1]),
    );
  } else {
    bbox = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [lon, lat] of nodes.values()) {
      bbox[0] = Math.min(bbox[0], lon);
      bbox[1] = Math.min(bbox[1], lat);
      bbox[2] = Math.max(bbox[2], lon);
      bbox[3] = Math.max(bbox[3], lat);
    }
  }
}
const [w, s, e, n] = bbox;
const midLat = (s + n) / 2;
const mPerDegLat = 111_320;
const mPerDegLon = 111_320 * Math.cos((midLat * Math.PI) / 180);
const widthM = (e - w) * mPerDegLon;
const heightM = (n - s) * mPerDegLat;
const sideM = Math.max(widthM, heightM);
const tileM = sideM / size;
const cx = (w + e) / 2;
const cy = (s + n) / 2;
const project = ([lon, lat]) => [
  ((lon - cx) * mPerDegLon) / tileM + size / 2,
  ((cy - lat) * mPerDegLat) / tileM + size / 2,
];

// ---------- grid ----------
// Priority (low → high): 0 empty, 1 landuse zones, 2 forest, 3 water fill, 4 river, 5 rail, 6 street, 7 avenue
const CH = {
  0: '.',
  R: 'r',
  C: 'c',
  S: 's',
  I: 'i',
  F: 'f',
  L: '~',
  W: 'w',
  T: '#',
  St: '-',
  Av: '=',
  P: 'p',
};
const PRIO = { R: 1, C: 1, S: 1, I: 1, F: 2, L: 3, W: 4, T: 5, P: 6, St: 6, Av: 7 };
const grid = Array.from({ length: size * size }, () => null);
const prio = new Uint8Array(size * size);
const inside = (x, y) => x >= 0 && y >= 0 && x < size && y < size;
function put(x, y, kind) {
  if (!inside(x, y)) return;
  const i = y * size + x;
  if (PRIO[kind] > prio[i]) {
    prio[i] = PRIO[kind];
    grid[i] = kind;
  }
}

// 4-connected line so roads stay orthogonally connected (sim neighbours are N/E/S/W).
function line4(x0, y0, x1, y1, kind) {
  let x = Math.floor(x0);
  let y = Math.floor(y0);
  const tx = Math.floor(x1);
  const ty = Math.floor(y1);
  const dx = Math.abs(tx - x);
  const dy = Math.abs(ty - y);
  const sx = x < tx ? 1 : -1;
  const sy = y < ty ? 1 : -1;
  let err = dx - dy;
  put(x, y, kind);
  while (x !== tx || y !== ty) {
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    } else {
      err += dx;
      y += sy;
    }
    put(x, y, kind);
  }
}

function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  let maxD = 0;
  let idx = 0;
  const [ax, ay] = pts[0];
  const [bx, by] = pts[pts.length - 1];
  const len = Math.hypot(bx - ax, by - ay) || 1;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i];
    const d = Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len;
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD <= tol) return [pts[0], pts[pts.length - 1]];
  return [...simplify(pts.slice(0, idx + 1), tol).slice(0, -1), ...simplify(pts.slice(idx), tol)];
}

function polyline(refs, kind) {
  let pts = refs
    .map((r) => nodes.get(r))
    .filter(Boolean)
    .map(project);
  if (manhattan) {
    const chopped = [];
    for (let i = 0; i < simplify(pts, SIMPLIFY_TOL).length; i++) {
      const p = simplify(pts, SIMPLIFY_TOL)[i];
      if (i === 0) {
        chopped.push(p);
        continue;
      }
      const [qx, qy] = chopped[chopped.length - 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(p[0] - qx, p[1] - qy) / MAX_STEP));
      for (let k = 1; k <= steps; k++)
        chopped.push([qx + ((p[0] - qx) * k) / steps, qy + ((p[1] - qy) * k) / steps]);
    }
    pts = chopped;
  }
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    if (!manhattan) line4(x0, y0, x1, y1, kind);
    else if (Math.abs(x1 - x0) >= Math.abs(y1 - y0)) {
      // longer axis first, then the short leg
      line4(x0, y0, x1, y0, kind);
      line4(x1, y0, x1, y1, kind);
    } else {
      line4(x0, y0, x0, y1, kind);
      line4(x0, y1, x1, y1, kind);
    }
  }
}

function fill(refsList, kind) {
  const rings = refsList
    .map((refs) =>
      refs
        .map((r) => nodes.get(r))
        .filter(Boolean)
        .map(project),
    )
    .filter((p) => p.length >= 3);
  if (!rings.length) return;
  for (let y = 0; y < size; y++) {
    const yc = y + 0.5;
    const xs = [];
    for (const pts of rings) {
      for (let i = 0; i < pts.length; i++) {
        const [ax, ay] = pts[i];
        const [bx, by] = pts[(i + 1) % pts.length];
        if (ay <= yc === by <= yc) continue;
        xs.push(ax + ((yc - ay) * (bx - ax)) / (by - ay));
      }
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      for (
        let x = Math.max(0, Math.floor(xs[i] + 0.5));
        x < Math.min(size, Math.floor(xs[i + 1] + 0.5));
        x++
      )
        put(x, y, kind);
    }
  }
}

const AVENUE = new Set([
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'motorway_link',
  'trunk_link',
  'primary_link',
]);
const STREET = new Set([
  'residential',
  'unclassified',
  'living_street',
  'secondary_link',
  'tertiary_link',
]);
const PED = new Set(['pedestrian']);
const LANDUSE = {
  residential: 'R',
  commercial: 'C',
  retail: 'S',
  industrial: 'I',
  forest: 'F',
  wood: 'F',
};

const counts = { buildings: 0, skippedHighways: {} };
const areas = [];
function ringArea(refs) {
  const pts = refs
    .map((r) => nodes.get(r))
    .filter(Boolean)
    .map(project);
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[(i + 1) % pts.length];
    a += ax * by - bx * ay;
  }
  return Math.abs(a) / 2;
}
function classifyArea(tags) {
  if (
    tags.natural === 'water' ||
    tags.water ||
    tags.landuse === 'reservoir' ||
    tags.landuse === 'basin'
  )
    return 'L';
  if (tags.natural === 'wood' || tags.landuse === 'forest') return 'F';
  if (tags.landuse && LANDUSE[tags.landuse]) return LANDUSE[tags.landuse];
  return null;
}
for (const { refs, tags } of ways) {
  if (tags.building) counts.buildings++;
  const closed = refs.length > 3 && refs[0] === refs[refs.length - 1];
  const area = classifyArea(tags);
  if (area && closed && tags.area !== 'no')
    areas.push({ rings: [refs], area, size: ringArea(refs) });
  if (tags.waterway === 'river' || tags.waterway === 'canal' || tags.waterway === 'stream')
    polyline(refs, 'W');
  if (tags.railway === 'rail' && !tags.service && tags.usage !== 'industrial') polyline(refs, 'T');
  const h = tags.highway;
  if (!h) continue;
  if (AVENUE.has(h)) polyline(refs, 'Av');
  else if (STREET.has(h) || (withServices && h === 'service')) polyline(refs, 'St');
  else if (PED.has(h)) polyline(refs, 'P');
  else counts.skippedHighways[h] = (counts.skippedHighways[h] ?? 0) + 1;
}
for (const { outer, tags } of relations) {
  const area = classifyArea(tags);
  if (!area) continue;
  const rings = outer.map((id) => wayById.get(id)).filter(Boolean);
  areas.push({ rings, area, size: rings.reduce((sum, r) => sum + ringArea(r), 0) });
}
// Largest first: a retail block inside a residential area must win the tile.
areas.sort((a, b) => b.size - a.size);
for (const { rings, area } of areas) fill(rings, area);

// ---------- stats ----------
const tally = {};
for (const k of grid) tally[k ?? 'empty'] = (tally[k ?? 'empty'] ?? 0) + 1;
const isRoad = (i) => grid[i] === 'St' || grid[i] === 'Av' || grid[i] === 'P';
let corners = 0;
let roads = 0;
let deadEnds = 0;
for (let y = 0; y < size; y++)
  for (let x = 0; x < size; x++) {
    const i = y * size + x;
    if (!isRoad(i)) continue;
    roads++;
    const nb = [
      inside(x, y - 1) && isRoad(i - size),
      inside(x + 1, y) && isRoad(i + 1),
      inside(x, y + 1) && isRoad(i + size),
      inside(x - 1, y) && isRoad(i - 1),
    ];
    const deg = nb.filter(Boolean).length;
    if (deg === 1) deadEnds++;
    if (deg === 2 && nb[0] !== nb[2]) corners++;
  }
// Road components (4-connected).
const seen = new Uint8Array(size * size);
let components = 0;
let largest = 0;
for (let i = 0; i < size * size; i++) {
  if (!isRoad(i) || seen[i]) continue;
  components++;
  let count = 0;
  const stack = [i];
  seen[i] = 1;
  while (stack.length) {
    const j = stack.pop();
    count++;
    const x = j % size;
    const y = (j - x) / size;
    for (const [nx, ny] of [
      [x, y - 1],
      [x + 1, y],
      [x, y + 1],
      [x - 1, y],
    ]) {
      if (!inside(nx, ny)) continue;
      const k = ny * size + nx;
      if (isRoad(k) && !seen[k]) {
        seen[k] = 1;
        stack.push(k);
      }
    }
  }
  largest = Math.max(largest, count);
}

// ---------- output ----------
const rows = [];
for (let y = 0; y < size; y++) {
  let line = '';
  for (let x = 0; x < size; x++) line += CH[grid[y * size + x] ?? 0];
  rows.push(line);
}
console.log(rows.join('\n'));
console.log(
  `\nlegend: = avenue  - street  p pedestrian  # rail  w river  ~ lake  f forest  r/c/s/i zones  . empty`,
);
console.log(
  `bbox ${bbox.map((v) => v.toFixed(4)).join(',')}  ${Math.round(widthM)} x ${Math.round(heightM)} m  → ${size}² tiles @ ${tileM.toFixed(1)} m/tile`,
);
console.log(
  `nodes ${nodes.size}  ways ${ways.length}  buildings ${counts.buildings} (not rasterised)`,
);
console.log('tiles', JSON.stringify(tally));
console.log(
  `roads ${roads}: corners ${corners} (${((100 * corners) / Math.max(1, roads)).toFixed(0)} %), dead ends ${deadEnds}, components ${components}, largest ${largest} (${((100 * largest) / Math.max(1, roads)).toFixed(0)} %)`,
);
console.log('skipped highway tags', JSON.stringify(counts.skippedHighways));
