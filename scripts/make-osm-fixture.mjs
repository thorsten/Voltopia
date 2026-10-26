// Generates the synthetic OSM fixture for the town import tests:
//
//   node scripts/make-osm-fixture.mjs > src/import/fixtures/town.osm
//
// A 3 km square at lon 8.65, lat 49.87 with a curving river, a diagonal
// primary road, a rotated residential grid, a south village, a rail line,
// landuse zones, a forest, a lake, a second lake as a multipolygon with an
// island, 40 buildings and a place=town node whose name needs an XML
// entity. Deterministic, no dependencies; stays under 30 KB.
const w = 8.65;
const s = 49.87;
const dLon = 3000 / (111320 * Math.cos((49.885 * Math.PI) / 180));
const dLat = 3000 / 111320;
const nodes = [];
const ways = [];
const relations = [];
/** A node at fraction (fx east, fy south) of the box; returns its id. */
const N = (fx, fy, tags) => {
  nodes.push({ lon: w + fx * dLon, lat: s + (1 - fy) * dLat, tags });
  return nodes.length;
};
const W = (ids, tags) => {
  ways.push({ ids, tags });
  return 1000 + ways.length - 1;
};
const poly = (pts, tags) => {
  const ids = pts.map(([x, y]) => N(x, y));
  ids.push(ids[0]);
  return W(ids, tags);
};

// river: sine curve west → east
const river = [];
for (let i = 0; i <= 30; i++) river.push(N(i / 30, 0.55 + 0.12 * Math.sin(i / 4)));
W(river, { waterway: 'river', name: 'Bach' });
// diagonal primary road SW → NE; the junction node is shared with the village street
const junction = N(0.3, 0.7);
W([N(0.05, 0.95), junction, N(0.4, 0.6), N(0.55, 0.5), N(0.95, 0.1)], {
  highway: 'primary',
  ref: 'B 17',
});
// east-west secondary and a tertiary spur
W([N(0, 0.3), N(0.3, 0.32), N(0.6, 0.28), N(1, 0.3)], { highway: 'secondary' });
W([N(0.6, 0.28), N(0.62, 0.15)], { highway: 'tertiary' });
// residential grid, slightly rotated
for (let k = 0; k < 6; k++) {
  const a = 0.12 + k * 0.07;
  W([N(a, 0.05), N(a + 0.03, 0.45)], { highway: 'residential' });
  W([N(0.1, a - 0.05), N(0.5, a - 0.02)], { highway: 'residential' });
}
// pedestrian high street through the retail block
W([N(0.3, 0.35), N(0.42, 0.35)], { highway: 'pedestrian', name: 'Marktgasse' });
// south village grid, tied to the primary by one street
const villageCorner = N(0.6, 0.7);
W([junction, villageCorner], { highway: 'unclassified' });
for (let k = 0; k < 4; k++) {
  W([k === 0 ? villageCorner : N(0.6 + k * 0.08, 0.7), N(0.6 + k * 0.08, 0.95)], {
    highway: 'residential',
  });
  W([N(0.6, 0.7 + k * 0.08), N(0.9, 0.7 + k * 0.08)], { highway: 'residential' });
}
// footway and a service road (both skipped by the import)
W([N(0.2, 0.5), N(0.3, 0.6)], { highway: 'footway' });
W([N(0.7, 0.4), N(0.75, 0.45)], { highway: 'service' });
// rail along the north, gentle curve, plus a siding that is ignored
W([N(0, 0.02), N(0.3, 0.03), N(0.6, 0.06), N(1, 0.12)], { railway: 'rail' });
W([N(0.3, 0.03), N(0.35, 0.05)], { railway: 'rail', service: 'siding' });
// landuse polygons
poly(
  [
    [0.1, 0.05],
    [0.5, 0.05],
    [0.5, 0.45],
    [0.1, 0.45],
  ],
  { landuse: 'residential' },
);
poly(
  [
    [0.58, 0.68],
    [0.92, 0.68],
    [0.92, 0.97],
    [0.58, 0.97],
  ],
  { landuse: 'residential' },
);
poly(
  [
    [0.55, 0.15],
    [0.8, 0.15],
    [0.8, 0.3],
    [0.55, 0.3],
  ],
  { landuse: 'industrial' },
);
poly(
  [
    [0.3, 0.3],
    [0.42, 0.3],
    [0.42, 0.4],
    [0.3, 0.4],
  ],
  { landuse: 'retail' },
);
poly(
  [
    [0.42, 0.3],
    [0.5, 0.3],
    [0.5, 0.4],
    [0.42, 0.4],
  ],
  { landuse: 'commercial' },
);
poly(
  [
    [0.02, 0.6],
    [0.3, 0.62],
    [0.35, 0.9],
    [0.05, 0.92],
  ],
  { landuse: 'forest' },
);
poly(
  [
    [0.8, 0.45],
    [0.95, 0.42],
    [0.97, 0.55],
    [0.82, 0.58],
  ],
  { natural: 'water' },
);
// multipolygon lake with an island (outer + inner ring, untagged ways)
const outer = poly(
  [
    [0.4, 0.75],
    [0.55, 0.75],
    [0.55, 0.9],
    [0.4, 0.9],
  ],
  {},
);
const inner = poly(
  [
    [0.46, 0.81],
    [0.49, 0.81],
    [0.49, 0.84],
    [0.46, 0.84],
  ],
  {},
);
relations.push({
  members: [
    { ref: outer, role: 'outer' },
    { ref: inner, role: 'inner' },
  ],
  tags: { type: 'multipolygon', natural: 'water', name: 'Weiher' },
});
// 40 small buildings in the residential grid
for (let i = 0; i < 40; i++) {
  const bx = 0.15 + (i % 8) * 0.04;
  const by = 0.1 + Math.floor(i / 8) * 0.06;
  poly(
    [
      [bx, by],
      [bx + 0.01, by],
      [bx + 0.01, by + 0.01],
    ],
    { building: 'yes' },
  );
}
// the town itself, with an ampersand in the name
N(0.36, 0.35, { place: 'town', name: 'Bach & Berg', population: '4200' });
N(0.75, 0.85, { place: 'village', name: 'Unterdorf' });

const escape = (v) =>
  String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const tagLines = (tags, indent) =>
  Object.entries(tags)
    .map(([k, v]) => `${indent}<tag k="${k}" v="${escape(v)}"/>`)
    .join('\n');
let out = `<?xml version="1.0" encoding="UTF-8"?>\n<osm version="0.6" generator="make-osm-fixture">\n<bounds minlat="${s}" minlon="${w}" maxlat="${s + dLat}" maxlon="${w + dLon}"/>\n`;
nodes.forEach(({ lon, lat, tags }, i) => {
  const head = `<node id="${i + 1}" lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}"`;
  out += tags ? `${head}>\n${tagLines(tags, '  ')}\n</node>\n` : `${head}/>\n`;
});
ways.forEach(({ ids, tags }, i) => {
  const refs = ids.map((id) => `  <nd ref="${id}"/>`).join('\n');
  const tagText = Object.keys(tags).length ? `\n${tagLines(tags, '  ')}` : '';
  out += `<way id="${1000 + i}">\n${refs}${tagText}\n</way>\n`;
});
relations.forEach(({ members, tags }, i) => {
  const memberText = members
    .map(({ ref, role }) => `  <member type="way" ref="${ref}" role="${role}"/>`)
    .join('\n');
  out += `<relation id="${5000 + i}">\n${memberText}\n${tagLines(tags, '  ')}\n</relation>\n`;
});
out += '</osm>\n';
process.stdout.write(out);
