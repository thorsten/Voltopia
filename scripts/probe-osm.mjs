// Probe: rasterise an OpenStreetMap export (.osm XML) onto the Voltopia tile grid
// with the import modules the game uses, and print the result as ASCII.
//
//   node scripts/probe-osm.mjs town.osm [size] [--bbox=minlon,minlat,maxlon,maxlat]
//
// Node imports the TypeScript directly (no build step). Prints the grid plus
// the import report and connectivity stats (corners, dead ends, components):
// the question is whether a real town is still recognisable on the grid and
// whether the sim gets one road network. *.osm files in the repo root are
// gitignored; drop a real export there.
import { readFileSync } from 'node:fs';
import { parseOsm } from '../src/import/osm.ts';
import { rasteriseTown } from '../src/import/rasterise.ts';
import { Terrain, TownRoad, Zone } from '../src/shared/types.ts';

const args = process.argv.slice(2);
const file = args[0];
if (!file) {
  console.error('usage: node scripts/probe-osm.mjs town.osm [size] [--bbox=w,s,e,n]');
  process.exit(1);
}
const size = Number(args.find((a, i) => i > 0 && /^\d+$/.test(a)) ?? 96);
const bboxArg = args.find((a) => a.startsWith('--bbox='))?.slice(7);
const bbox = bboxArg ? bboxArg.split(',').map(Number) : undefined;

const started = performance.now();
const data = parseOsm(readFileSync(file, 'utf8'));
const parsedAt = performance.now();
const { layout, report } = rasteriseTown(data, size, bbox);
const doneAt = performance.now();

// ---------- ASCII ----------
const ZONE_CH = {
  [Zone.Residential]: 'r',
  [Zone.Commercial]: 'c',
  [Zone.Retail]: 's',
  [Zone.Industrial]: 'i',
};
function glyph(i) {
  if (layout.road[i] === TownRoad.Avenue) return '=';
  if (layout.pedestrian[i]) return 'p';
  if (layout.road[i] === TownRoad.Street) return '-';
  if (layout.rail[i]) return '#';
  if (layout.terrain[i] === Terrain.River) return 'w';
  if (layout.terrain[i] === Terrain.Lake) return '~';
  if (layout.forest[i]) return 'f';
  const zone = ZONE_CH[layout.zone[i]];
  if (zone) return layout.density[i] ? zone.toUpperCase() : zone;
  return '.';
}
const rows = [];
for (let y = 0; y < size; y++) {
  let line = '';
  for (let x = 0; x < size; x++) line += glyph(y * size + x);
  rows.push(line);
}
console.log(rows.join('\n'));
console.log(
  '\nlegend: = avenue  - street  p pedestrian  # rail  w river  ~ lake  f forest  r/c/s/i zones (upper case: settled)  . empty',
);

// ---------- stats ----------
const inside = (x, y) => x >= 0 && y >= 0 && x < size && y < size;
const isRoad = (i) => layout.road[i] !== TownRoad.None;
let roads = 0;
let corners = 0;
let deadEnds = 0;
for (let y = 0; y < size; y++) {
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
    const degree = nb.filter(Boolean).length;
    if (degree === 1) deadEnds++;
    if (degree === 2 && nb[0] !== nb[2]) corners++;
  }
}
const pct = (part, whole) => `${((100 * part) / Math.max(1, whole)).toFixed(0)} %`;
const { counts } = report;
const zones = counts.residential + counts.commercial + counts.retail + counts.industrial;
console.log(
  `bbox ${layout.bbox.map((v) => v.toFixed(4)).join(',')}  ${Math.round(report.widthM)} x ${Math.round(report.heightM)} m  → ${size}² tiles @ ${report.metresPerTile.toFixed(1)} m/tile`,
);
console.log(
  `name ${layout.name ?? '(none)'}  nodes ${data.nodes.size}  ways ${data.ways.length}  relations ${data.relations.length}  parse ${(parsedAt - started).toFixed(0)} ms  rasterise ${(doneAt - parsedAt).toFixed(0)} ms`,
);
console.log('tiles', JSON.stringify(counts));
console.log(
  `roads ${roads}: corners ${corners} (${pct(corners, roads)}), dead ends ${deadEnds}, components ${report.roadComponents}, thinned ${report.thinned}`,
);
console.log(
  `zones ${zones} beside a road, ${report.droppedZones} dropped (${pct(zones, zones + report.droppedZones)} kept), settled buildings ${counts.buildings}`,
);
console.log('skipped highway tags', JSON.stringify(report.skippedHighways));
