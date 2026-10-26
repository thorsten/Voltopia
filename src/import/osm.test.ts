import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OsmImportError, parseOsm, unescapeXml } from './osm.ts';

const xml = readFileSync(new URL('./fixtures/town.osm', import.meta.url), 'utf8');
const data = parseOsm(xml);

describe('parseOsm', () => {
  it('counts the fixture', () => {
    expect(data.nodes.size).toBe(252);
    expect(data.ways).toHaveLength(79);
    expect(data.relations).toHaveLength(1);
    expect(data.places).toHaveLength(2);
  });

  it('reads a node as lon/lat', () => {
    const first = data.nodes.get('1');
    expect(first).toBeDefined();
    const [lon, lat] = first!;
    expect(lon).toBeCloseTo(8.65, 6);
    expect(lat).toBeCloseTo(49.87 + (0.45 * 3000) / 111320, 6);
  });

  it('reads a way with its refs and tags', () => {
    const primary = data.ways.find((w) => w.tags.highway === 'primary');
    expect(primary).toBeDefined();
    expect(primary!.id).toBe('1001');
    expect(primary!.refs).toEqual(['33', '32', '34', '35', '36']);
    expect(primary!.tags).toEqual({ highway: 'primary', ref: 'B 17' });
  });

  it('keeps a closed ring closed', () => {
    const lake = data.ways.find((w) => w.tags.natural === 'water');
    expect(lake!.refs[0]).toBe(lake!.refs[lake!.refs.length - 1]);
    expect(lake!.refs).toHaveLength(5);
  });

  it('reduces a multipolygon to its outer ways', () => {
    const [relation] = data.relations;
    expect(relation.outer).toHaveLength(1);
    const outer = data.ways.find((w) => w.id === relation.outer[0]);
    expect(outer).toBeDefined();
    expect(outer!.tags).toEqual({});
    expect(outer!.refs).toHaveLength(5);
    expect(relation.tags).toMatchObject({ type: 'multipolygon', natural: 'water' });
  });

  it('reads the bounds as west, south, east, north', () => {
    expect(data.bounds).not.toBeNull();
    const [w, s, e, n] = data.bounds!;
    expect(w).toBeCloseTo(8.65, 6);
    expect(s).toBeCloseTo(49.87, 6);
    expect(e).toBeGreaterThan(w);
    expect(n).toBeGreaterThan(s);
  });

  it('unescapes entities in tag values', () => {
    const town = data.places.find((p) => p.tags.place === 'town');
    expect(town!.tags.name).toBe('Bach & Berg');
    expect(unescapeXml('a &lt;b&gt; &quot;c&quot; &apos;d&apos; &#65;&#x42; &unknown;')).toBe(
      'a <b> "c" \'d\' AB &unknown;',
    );
  });

  it('skips tags on nodes without a place', () => {
    expect(data.places.every((p) => p.tags.place !== undefined)).toBe(true);
    expect(data.places.map((p) => p.tags.place).sort()).toEqual(['town', 'village']);
  });

  it('rejects garbage and documents without ways', () => {
    expect(() => parseOsm('<html><body>nope</body></html>')).toThrow(OsmImportError);
    expect(() => parseOsm('<html><body>nope</body></html>')).toThrow(/notOsm/);
    expect(() => parseOsm('<osm version="0.6"><node id="1" lat="1" lon="2"/></osm>')).toThrow(
      /notOsm/,
    );
    try {
      parseOsm('');
    } catch (error) {
      expect((error as OsmImportError).code).toBe('notOsm');
    }
  });

  it('reports null bounds when the file has none', () => {
    const noBounds = xml.replace(/<bounds[^>]*\/>\n/, '');
    expect(noBounds).not.toContain('<bounds');
    const parsed = parseOsm(noBounds);
    expect(parsed.bounds).toBeNull();
    expect(parsed.ways).toHaveLength(79);
  });

  it('tolerates a different attribute order and self-closing tags', () => {
    const parsed = parseOsm(
      `<osm>
        <node lon="2" lat="1" id="7"><tag v="village" k="place"></tag><tag k="name" v="X"/></node>
        <way id="9"><nd ref="7"></nd><tag k="highway" v="residential"/></way>
        <relation id="3"><member role="outer" ref="9" type="way"/><tag k="type" v="multipolygon"/></relation>
      </osm>`,
    );
    expect(parsed.nodes.get('7')).toEqual([2, 1]);
    expect(parsed.places[0].tags).toEqual({ place: 'village', name: 'X' });
    expect(parsed.ways[0].refs).toEqual(['7']);
    expect(parsed.relations[0].outer).toEqual(['9']);
  });
});
