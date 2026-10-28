import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BALANCE, MAP_SIZES } from '../shared/constants.ts';
import { Terrain, TownRoad, Zone } from '../shared/types.ts';
import { OSM_IMPORT } from './config.ts';
import { countComponents } from './grid.ts';
import {
  type Bbox,
  type LonLat,
  type OsmData,
  OsmImportError,
  type OsmPlace,
  type OsmRelation,
  type OsmWay,
  parseOsm,
} from './osm.ts';
import { marginTiles, rasteriseTown } from './rasterise.ts';

/** A 16-tile grid over a 0.01° box on the equator: tile (x, y) spans lon x/16 %, lat from the top. */
const SIZE = 16;
const BOX: Bbox = [0, 0, 0.01, 0.01];
const idx = (x: number, y: number): number => y * SIZE + x;

/** Lon/lat of fractional grid coordinates (x east, y south) on the 16-tile box. */
function pt(x: number, y: number): LonLat {
  return [(x / SIZE) * 0.01, 0.01 - (y / SIZE) * 0.01];
}
const centre = (x: number, y: number): LonLat => pt(x + 0.5, y + 0.5);

/** Hand-built OsmData: ways through tile centres, polygons on tile corners. */
function town(bounds: Bbox | null = BOX) {
  const nodes = new Map<string, LonLat>();
  const ways: OsmWay[] = [];
  const relations: OsmRelation[] = [];
  const places: OsmPlace[] = [];
  const node = (point: LonLat): string => {
    const id = String(nodes.size + 1);
    nodes.set(id, point);
    return id;
  };
  const way = (tags: Record<string, string>, points: LonLat[]): string => {
    const id = String(1000 + ways.length);
    ways.push({ id, refs: points.map(node), tags });
    return id;
  };
  return {
    node,
    way,
    /** A line through the centres of the given tiles. */
    line: (tags: Record<string, string>, tiles: [number, number][]) =>
      way(
        tags,
        tiles.map(([x, y]) => centre(x, y)),
      ),
    /** A closed ring on tile corners covering tiles x0..x1-1, y0..y1-1. */
    rect: (tags: Record<string, string>, x0: number, y0: number, x1: number, y1: number) => {
      const corners = [pt(x0, y0), pt(x1, y0), pt(x1, y1), pt(x0, y1)];
      const refs = corners.map(node);
      refs.push(refs[0]);
      const id = String(1000 + ways.length);
      ways.push({ id, refs, tags });
      return id;
    },
    /** A small building whose centroid lies on tile (x, y). */
    building: (x: number, y: number) => {
      const refs = [pt(x + 0.3, y + 0.3), pt(x + 0.7, y + 0.3), pt(x + 0.5, y + 0.7)].map(node);
      refs.push(refs[0]);
      ways.push({ id: String(1000 + ways.length), refs, tags: { building: 'yes' } });
    },
    relation: (tags: Record<string, string>, outer: string[]) => {
      relations.push({ outer, tags });
    },
    place: (x: number, y: number, tags: Record<string, string>) => {
      const [lon, lat] = centre(x, y);
      places.push({ lon, lat, tags });
    },
    data: (): OsmData => ({ nodes, ways, relations, places, bounds }),
  };
}

function noBlock(mask: Uint8Array): boolean {
  for (let y = 0; y + 1 < SIZE; y++) {
    for (let x = 0; x + 1 < SIZE; x++) {
      if (mask[idx(x, y)] && mask[idx(x + 1, y)] && mask[idx(x, y + 1)] && mask[idx(x + 1, y + 1)])
        return false;
    }
  }
  return true;
}

describe('rasteriseTown mapping', () => {
  it.each(OSM_IMPORT.avenueHighways)('highway=%s is an avenue', (highway) => {
    const t = town();
    t.line({ highway }, [
      [2, 5],
      [10, 5],
    ]);
    const { layout, report } = rasteriseTown(t.data(), SIZE, undefined, 0);
    expect(layout.road[idx(6, 5)]).toBe(TownRoad.Avenue);
    expect(report.counts.avenue).toBe(9);
    expect(report.counts.street).toBe(0);
  });

  it.each(OSM_IMPORT.streetHighways)('highway=%s is a street', (highway) => {
    const t = town();
    t.line({ highway }, [
      [2, 5],
      [10, 5],
    ]);
    const { layout, report } = rasteriseTown(t.data(), SIZE, undefined, 0);
    expect(layout.road[idx(6, 5)]).toBe(TownRoad.Street);
    expect(layout.pedestrian[idx(6, 5)]).toBe(0);
    expect(report.counts.street).toBe(9);
  });

  it('highway=pedestrian is a street with the pedestrian lane', () => {
    const t = town();
    t.line({ highway: 'pedestrian' }, [
      [2, 5],
      [10, 5],
    ]);
    const { layout, report } = rasteriseTown(t.data(), SIZE, undefined, 0);
    expect(layout.road[idx(6, 5)]).toBe(TownRoad.Street);
    expect(layout.pedestrian[idx(6, 5)]).toBe(1);
    expect(report.counts.pedestrian).toBe(9);
    expect(report.counts.street).toBe(9);
  });

  it('an avenue over a pedestrian street drops the lane', () => {
    const t = town();
    t.line({ highway: 'pedestrian' }, [
      [2, 5],
      [10, 5],
    ]);
    t.line({ highway: 'primary' }, [
      [6, 2],
      [6, 9],
    ]);
    const { layout } = rasteriseTown(t.data(), SIZE, undefined, 0);
    expect(layout.road[idx(6, 5)]).toBe(TownRoad.Avenue);
    expect(layout.pedestrian[idx(6, 5)]).toBe(0);
    expect(layout.pedestrian[idx(5, 5)]).toBe(1);
  });

  it('railway=rail is track; sidings and other rail kinds are not', () => {
    const t = town();
    t.line({ railway: 'rail' }, [
      [0, 3],
      [15, 3],
    ]);
    t.line({ railway: 'rail', service: 'siding' }, [
      [0, 8],
      [15, 8],
    ]);
    t.line({ railway: 'tram' }, [
      [0, 12],
      [15, 12],
    ]);
    const { layout, report } = rasteriseTown(t.data(), SIZE, undefined, 0);
    expect(layout.rail[idx(7, 3)]).toBe(1);
    expect(layout.rail[idx(7, 8)]).toBe(0);
    expect(layout.rail[idx(7, 12)]).toBe(0);
    expect(report.counts.rail).toBe(16);
  });

  it.each(OSM_IMPORT.waterways)('waterway=%s is a river line', (waterway) => {
    const t = town();
    t.line({ waterway }, [
      [0, 7],
      [15, 7],
    ]);
    const { layout, report } = rasteriseTown(t.data(), SIZE, undefined, 0);
    expect(layout.terrain[idx(4, 7)]).toBe(Terrain.River);
    expect(layout.terrain[idx(4, 8)]).toBe(Terrain.Land);
    expect(report.counts.river).toBe(16 * OSM_IMPORT.riverWidthTiles);
  });

  it.each<Record<string, string>>([
    { natural: 'water' },
    { water: 'pond' },
    { landuse: 'reservoir' },
    { landuse: 'basin' },
  ])('%o fills a lake', (tags) => {
    const t = town();
    t.rect(tags, 4, 4, 8, 8);
    const { layout, report } = rasteriseTown(t.data(), SIZE, undefined, 0);
    expect(layout.terrain[idx(5, 5)]).toBe(Terrain.Lake);
    expect(layout.terrain[idx(3, 5)]).toBe(Terrain.Land);
    expect(layout.terrain[idx(8, 5)]).toBe(Terrain.Land);
    expect(report.counts.lake).toBe(16);
  });

  it('skips a closed way tagged area=no', () => {
    const t = town();
    t.rect({ natural: 'water', area: 'no' }, 4, 4, 8, 8);
    expect(rasteriseTown(t.data(), SIZE, undefined, 0).report.counts.lake).toBe(0);
  });

  it.each<Record<string, string>>([{ landuse: 'forest' }, { natural: 'wood' }])(
    '%o fills mature forest',
    (tags) => {
      const t = town();
      t.rect(tags, 1, 1, 5, 4);
      const { layout, report } = rasteriseTown(t.data(), SIZE, undefined, 0);
      expect(layout.forest[idx(2, 2)]).toBe(BALANCE.forest.maxStage);
      expect(layout.forest[idx(5, 2)]).toBe(0);
      expect(report.counts.forest).toBe(12);
    },
  );

  it.each([
    ['residential', Zone.Residential, 'residential'],
    ['commercial', Zone.Commercial, 'commercial'],
    ['retail', Zone.Retail, 'retail'],
    ['industrial', Zone.Industrial, 'industrial'],
  ] as const)('landuse=%s zones the tiles beside a road', (landuse, zone, count) => {
    const t = town();
    t.line({ highway: 'residential' }, [
      [1, 2],
      [1, 6],
    ]);
    t.rect({ landuse }, 2, 2, 4, 7);
    const { layout, report } = rasteriseTown(t.data(), SIZE, undefined, 0);
    for (let y = 2; y < 7; y++) {
      expect(layout.zone[idx(2, y)]).toBe(zone);
      expect(layout.zone[idx(3, y)]).toBe(Zone.None);
    }
    expect(report.counts[count]).toBe(5);
    expect(report.droppedZones).toBe(5);
  });

  it('names the town after the best-ranked place inside the box', () => {
    const t = town();
    t.line({ highway: 'residential' }, [
      [1, 1],
      [3, 1],
    ]);
    t.place(2, 2, { place: 'village', name: 'Unterdorf' });
    t.place(5, 5, { place: 'town', name: 'Mittelstadt' });
    t.place(7, 7, { place: 'hamlet', name: 'Weiler' });
    t.place(30, 30, { place: 'city', name: 'Far Away' });
    t.place(8, 8, { place: 'city' });
    expect(rasteriseTown(t.data(), SIZE, undefined, 0).layout.name).toBe('Mittelstadt');
  });

  it('has no name without a place node', () => {
    const t = town();
    t.line({ highway: 'residential' }, [
      [1, 1],
      [3, 1],
    ]);
    expect(rasteriseTown(t.data(), SIZE, undefined, 0).layout.name).toBeNull();
  });

  it('counts skipped highway classes and draws nothing for them', () => {
    const t = town();
    t.line({ highway: 'footway' }, [
      [1, 1],
      [9, 1],
    ]);
    t.line({ highway: 'service' }, [
      [1, 3],
      [9, 3],
    ]);
    t.line({ highway: 'service' }, [
      [1, 5],
      [9, 5],
    ]);
    const { layout, report } = rasteriseTown(t.data(), SIZE, undefined, 0);
    expect(report.skippedHighways).toEqual({ footway: 1, service: 2 });
    expect(layout.road.every((v) => v === TownRoad.None)).toBe(true);
    expect(report.roadComponents).toBe(0);
  });
});

describe('rasteriseTown areas and lines', () => {
  it('fills areas largest first so a smaller area wins its tiles', () => {
    const t = town();
    t.rect({ landuse: 'retail' }, 4, 4, 7, 6);
    t.rect({ landuse: 'residential' }, 2, 2, 10, 10);
    t.line({ highway: 'residential' }, [
      [2, 3],
      [9, 3],
    ]);
    const { layout } = rasteriseTown(t.data(), SIZE, undefined, 0);
    expect(layout.zone[idx(5, 4)]).toBe(Zone.Retail);
    expect(layout.zone[idx(3, 4)]).toBe(Zone.Residential);
    expect(layout.zone[idx(8, 4)]).toBe(Zone.Residential);
  });

  it('fills a multipolygon relation from its outer ways', () => {
    const t = town();
    const outer = t.rect({}, 4, 4, 9, 9);
    t.rect({}, 6, 6, 7, 7);
    t.relation({ type: 'multipolygon', natural: 'water' }, [outer]);
    const { report, layout } = rasteriseTown(t.data(), SIZE, undefined, 0);
    expect(report.counts.lake).toBe(25);
    expect(layout.terrain[idx(6, 6)]).toBe(Terrain.Lake);
  });

  it('draws a diagonal way 4-connected', () => {
    const t = town();
    t.line({ highway: 'residential' }, [
      [1, 1],
      [13, 9],
    ]);
    const { layout, report } = rasteriseTown(t.data(), SIZE, undefined, 0);
    const { road } = layout;
    let tiles = 0;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        if (road[idx(x, y)] === TownRoad.None) continue;
        tiles++;
        const beside =
          (y > 0 && road[idx(x, y - 1)] !== 0) ||
          (x < SIZE - 1 && road[idx(x + 1, y)] !== 0) ||
          (y < SIZE - 1 && road[idx(x, y + 1)] !== 0) ||
          (x > 0 && road[idx(x - 1, y)] !== 0);
        expect(beside).toBe(true);
      }
    }
    expect(tiles).toBe(12 + 8 + 1);
    expect(report.roadComponents).toBe(1);
  });

  it('keeps the river under a road (bridge) and drops the pedestrian lane there', () => {
    const t = town();
    t.line({ waterway: 'river' }, [
      [0, 5],
      [15, 5],
    ]);
    t.line({ highway: 'pedestrian' }, [
      [7, 2],
      [7, 9],
    ]);
    const { layout } = rasteriseTown(t.data(), SIZE, undefined, 0);
    expect(layout.terrain[idx(7, 5)]).toBe(Terrain.River);
    expect(layout.road[idx(7, 5)]).toBe(TownRoad.Street);
    expect(layout.pedestrian[idx(7, 5)]).toBe(0);
    expect(layout.pedestrian[idx(7, 4)]).toBe(1);
  });

  it('turns a lake tile into land under a road or a track', () => {
    const t = town();
    t.rect({ natural: 'water' }, 4, 4, 9, 9);
    t.line({ highway: 'residential' }, [
      [2, 6],
      [11, 6],
    ]);
    t.line({ railway: 'rail' }, [
      [2, 8],
      [11, 8],
    ]);
    const { layout } = rasteriseTown(t.data(), SIZE, undefined, 0);
    expect(layout.terrain[idx(6, 6)]).toBe(Terrain.Land);
    expect(layout.road[idx(6, 6)]).toBe(TownRoad.Street);
    expect(layout.terrain[idx(6, 8)]).toBe(Terrain.Land);
    expect(layout.rail[idx(6, 8)]).toBe(1);
    expect(layout.terrain[idx(6, 5)]).toBe(Terrain.Lake);
  });

  it('drops the pedestrian lane on a level crossing', () => {
    const t = town();
    t.line({ railway: 'rail' }, [
      [0, 5],
      [15, 5],
    ]);
    t.line({ highway: 'pedestrian' }, [
      [7, 2],
      [7, 9],
    ]);
    const { layout } = rasteriseTown(t.data(), SIZE, undefined, 0);
    expect(layout.rail[idx(7, 5)]).toBe(1);
    expect(layout.road[idx(7, 5)]).toBe(TownRoad.Street);
    expect(layout.pedestrian[idx(7, 5)]).toBe(0);
  });

  it('clears zones and forest on water', () => {
    const t = town();
    t.rect({ natural: 'water' }, 2, 2, 12, 12);
    t.rect({ landuse: 'residential' }, 3, 3, 6, 6);
    t.rect({ landuse: 'forest' }, 7, 7, 10, 10);
    t.line({ highway: 'residential' }, [
      [2, 4],
      [11, 4],
    ]);
    const { layout, report } = rasteriseTown(t.data(), SIZE, undefined, 0);
    expect(report.counts.residential).toBe(0);
    expect(report.counts.forest).toBe(0);
    expect(report.droppedZones).toBe(0);
    expect(layout.terrain[idx(8, 8)]).toBe(Terrain.Lake);
  });

  it('clears zones and forest under roads and track, and zones under woods', () => {
    const t = town();
    t.rect({ landuse: 'residential' }, 2, 2, 12, 12);
    t.rect({ landuse: 'forest' }, 8, 8, 11, 11);
    t.line({ highway: 'residential' }, [
      [2, 4],
      [11, 4],
    ]);
    t.line({ railway: 'rail' }, [
      [2, 9],
      [11, 9],
    ]);
    t.rect({ natural: 'wood' }, 2, 5, 5, 6);
    const { layout } = rasteriseTown(t.data(), SIZE, undefined, 0);
    expect(layout.zone[idx(5, 4)]).toBe(Zone.None);
    expect(layout.zone[idx(5, 9)]).toBe(Zone.None);
    expect(layout.forest[idx(9, 9)]).toBe(0);
    expect(layout.zone[idx(9, 10)]).toBe(Zone.None);
    expect(layout.forest[idx(9, 10)]).toBe(BALANCE.forest.maxStage);
    expect(layout.zone[idx(3, 5)]).toBe(Zone.None);
    expect(layout.forest[idx(3, 5)]).toBe(BALANCE.forest.maxStage);
    expect(layout.zone[idx(5, 3)]).toBe(Zone.Residential);
  });
});

describe('rasteriseTown thinning', () => {
  it('thins a lone 2x2 block to a straight two-tile piece in one component', () => {
    const t = town();
    t.line({ highway: 'residential' }, [
      [5, 5],
      [6, 5],
    ]);
    t.line({ highway: 'residential' }, [
      [5, 6],
      [6, 6],
    ]);
    const { layout, report } = rasteriseTown(t.data(), SIZE, undefined, 0);
    // One tile per block, then the stub the remaining L would leave.
    expect(report.thinned).toBe(2);
    expect(report.counts.street).toBe(2);
    expect(report.roadComponents).toBe(1);
    expect(layout.road[idx(5, 5)]).toBe(TownRoad.None);
    expect(layout.road[idx(6, 5)]).toBe(TownRoad.None);
    expect(layout.road[idx(5, 6)]).toBe(TownRoad.Street);
    expect(layout.road[idx(6, 6)]).toBe(TownRoad.Street);
  });

  it('thins a two-wide avenue band to one line without splitting it', () => {
    const t = town();
    t.line({ highway: 'primary' }, [
      [2, 5],
      [12, 5],
    ]);
    t.line({ highway: 'primary' }, [
      [2, 6],
      [12, 6],
    ]);
    t.line({ highway: 'residential' }, [
      [7, 6],
      [7, 12],
    ]);
    const { layout, report } = rasteriseTown(t.data(), SIZE, undefined, 0);
    expect(noBlock(layout.road)).toBe(true);
    expect(report.roadComponents).toBe(1);
    // A band of 11 columns keeps 11 tiles: the lower row, no stub at either end.
    expect(report.thinned).toBe(11);
    expect(report.counts.avenue).toBe(11);
    for (let x = 2; x <= 12; x++) {
      expect(layout.road[idx(x, 5)]).toBe(TownRoad.None);
      expect(layout.road[idx(x, 6)]).toBe(TownRoad.Avenue);
    }
    expect(countComponents(layout.road, SIZE)).toBe(1);
    expect(layout.road[idx(7, 10)]).toBe(TownRoad.Street);
  });

  it('keeps the tile a side street joins a band on', () => {
    const t = town();
    t.line({ highway: 'primary' }, [
      [2, 5],
      [12, 5],
    ]);
    t.line({ highway: 'primary' }, [
      [2, 6],
      [12, 6],
    ]);
    // Joins the upper row (the one thinning strips) and loops back to the lower row.
    t.line({ highway: 'residential' }, [
      [7, 5],
      [7, 1],
      [14, 1],
      [14, 6],
      [12, 6],
    ]);
    const { layout, report } = rasteriseTown(t.data(), SIZE, undefined, 0);
    expect(noBlock(layout.road)).toBe(true);
    expect(report.roadComponents).toBe(1);
    expect(layout.road[idx(7, 5)]).toBe(TownRoad.Avenue);
    expect(layout.road[idx(7, 4)]).toBe(TownRoad.Street);
    expect(layout.road[idx(6, 5)]).toBe(TownRoad.None);
    expect(layout.road[idx(8, 5)]).toBe(TownRoad.None);
  });

  it('keeps a block whose every tile holds a branch together (split guard)', () => {
    const t = town();
    t.line({ highway: 'residential' }, [
      [5, 3],
      [5, 6],
    ]);
    t.line({ highway: 'residential' }, [
      [6, 5],
      [6, 8],
    ]);
    t.line({ highway: 'residential' }, [
      [6, 5],
      [8, 5],
    ]);
    t.line({ highway: 'residential' }, [
      [3, 6],
      [5, 6],
    ]);
    const { layout, report } = rasteriseTown(t.data(), SIZE, undefined, 0);
    expect(report.thinned).toBe(0);
    expect(report.roadComponents).toBe(1);
    for (const [x, y] of [
      [5, 5],
      [6, 5],
      [5, 6],
      [6, 6],
    ]) {
      expect(layout.road[idx(x, y)]).toBe(TownRoad.Street);
    }
  });

  it('thins double track the same way', () => {
    const t = town();
    t.line({ railway: 'rail' }, [
      [0, 7],
      [15, 7],
    ]);
    t.line({ railway: 'rail' }, [
      [0, 8],
      [15, 8],
    ]);
    const { layout, report } = rasteriseTown(t.data(), SIZE, undefined, 0);
    expect(noBlock(layout.rail)).toBe(true);
    expect(countComponents(layout.rail, SIZE)).toBe(1);
    expect(report.thinned).toBe(16);
    expect(report.counts.rail).toBe(16);
  });
});

describe('rasteriseTown zones and settling', () => {
  it('drops zone tiles without a road neighbour', () => {
    const t = town();
    t.rect({ landuse: 'industrial' }, 2, 2, 6, 6);
    t.line({ highway: 'residential' }, [
      [10, 10],
      [12, 10],
    ]);
    const { report } = rasteriseTown(t.data(), SIZE, undefined, 0);
    expect(report.counts.industrial).toBe(0);
    expect(report.droppedZones).toBe(16);
  });

  it('settles buildings by centroid count on zoned, road-served land', () => {
    const [one, two, three] = BALANCE.osmImport.buildingsPerDensity;
    const t = town();
    t.line({ highway: 'residential' }, [
      [0, 2],
      [15, 2],
    ]);
    t.rect({ landuse: 'residential' }, 2, 3, 11, 5);
    for (let i = 0; i < one; i++) t.building(3, 3);
    for (let i = 0; i < two; i++) t.building(5, 3);
    for (let i = 0; i < three; i++) t.building(7, 3);
    for (let i = 0; i < three + 2; i++) t.building(9, 3);
    t.building(4, 4); // zoned but unserved: dropped before settling
    t.building(13, 3); // unzoned
    t.building(6, 2); // on the road
    const { layout, report } = rasteriseTown(t.data(), SIZE, undefined, 0);
    expect(layout.density[idx(2, 3)]).toBe(0);
    expect(layout.density[idx(3, 3)]).toBe(1);
    expect(layout.density[idx(5, 3)]).toBe(2);
    expect(layout.density[idx(7, 3)]).toBe(3);
    expect(layout.density[idx(9, 3)]).toBe(3);
    expect(layout.density[idx(4, 4)]).toBe(0);
    expect(layout.density[idx(13, 3)]).toBe(0);
    expect(layout.density[idx(6, 2)]).toBe(0);
    expect(report.counts.buildings).toBe(4);
  });
});

describe('rasteriseTown box handling', () => {
  it('throws boxTooLarge over the limit', () => {
    const t = town([0, 0, 0.5, 0.5]);
    t.line({ highway: 'residential' }, [
      [1, 1],
      [3, 1],
    ]);
    expect(() => rasteriseTown(t.data(), SIZE, undefined, 0)).toThrow(OsmImportError);
    try {
      rasteriseTown(t.data(), SIZE, undefined, 0);
    } catch (error) {
      expect((error as OsmImportError).code).toBe('boxTooLarge');
    }
  });

  it('throws empty when nothing has a position', () => {
    const data: OsmData = {
      nodes: new Map(),
      ways: [{ id: '1', refs: [], tags: { highway: 'residential' } }],
      relations: [],
      places: [],
      bounds: null,
    };
    try {
      rasteriseTown(data, SIZE, undefined, 0);
      expect.unreachable();
    } catch (error) {
      expect((error as OsmImportError).code).toBe('empty');
    }
  });

  it('takes the box from the nodes when the file has no bounds', () => {
    const t = town(null);
    t.line({ highway: 'residential' }, [
      [2, 3],
      [9, 7],
    ]);
    const { layout } = rasteriseTown(t.data(), SIZE, undefined, 0);
    const [w, s, e, n] = layout.bbox;
    expect(w).toBeCloseTo(centre(2, 3)[0], 9);
    expect(e).toBeCloseTo(centre(9, 7)[0], 9);
    expect(n).toBeCloseTo(centre(2, 3)[1], 9);
    expect(s).toBeCloseTo(centre(9, 7)[1], 9);
  });

  it('prefers the bbox argument over the bounds', () => {
    const t = town();
    // In the south-west quarter: lands on row 4, columns 6..14 of the quarter's own grid.
    t.way({ highway: 'residential' }, [pt(3.25, 10.25), pt(7.25, 10.25)]);
    const half: Bbox = [0, 0, 0.005, 0.005];
    const { layout, report } = rasteriseTown(t.data(), SIZE, half, 0);
    expect(layout.bbox).toEqual(half);
    expect(report.metresPerTile).toBeCloseTo(
      rasteriseTown(t.data(), SIZE, undefined, 0).report.metresPerTile / 2,
    );
    expect(layout.road[idx(10, 4)]).toBe(TownRoad.Street);
    expect(layout.road[idx(5, 4)]).toBe(TownRoad.None);
    expect(report.counts.street).toBe(9);
    expect(rasteriseTown(t.data(), SIZE, undefined, 0).layout.road[idx(5, 10)]).toBe(
      TownRoad.Street,
    );
  });

  it('reports metres per tile from the longer side', () => {
    const t = town([0, 0, 0.02, 0.01]);
    t.line({ highway: 'residential' }, [
      [2, 5],
      [10, 5],
    ]);
    const { report } = rasteriseTown(t.data(), SIZE, undefined, 0);
    expect(report.widthM).toBeCloseTo(2 * report.heightM, 0);
    expect(report.metresPerTile).toBeCloseTo(report.widthM / SIZE);
  });
});

describe('rasteriseTown margin ring', () => {
  it('leaves a ring of a tenth of the size by default', () => {
    expect(marginTiles(96)).toBe(10);
    expect(marginTiles(64)).toBe(6);
    expect(marginTiles(128)).toBe(13);
    expect(marginTiles(16)).toBe(2);
  });

  it('maps the box onto the inner square so the tiles grow', () => {
    const t = town();
    t.line({ highway: 'residential' }, [
      [0, 8],
      [15, 8],
    ]);
    const { layout, report } = rasteriseTown(t.data(), SIZE, undefined, 2);
    expect(report.metresPerTile).toBeCloseTo(report.widthM / 12);
    // tile x on the 16-box lands on 2 + 0.75 x in the inner 12
    expect(layout.road[idx(2, 8)]).toBe(TownRoad.Street);
    expect(layout.road[idx(13, 8)]).toBe(TownRoad.Street);
    expect(layout.road[idx(1, 8)]).toBe(TownRoad.None);
    expect(layout.road[idx(14, 8)]).toBe(TownRoad.None);
  });

  it('keeps the ring free of zones and buildings; roads may run out into it', () => {
    const t = town();
    t.rect({ landuse: 'residential' }, -4, -4, 20, 20);
    t.line({ highway: 'residential' }, [
      [-4, 8],
      [20, 8],
    ]);
    for (let x = -4; x < 20; x++) t.building(x, 7);
    const { layout, report } = rasteriseTown(t.data(), SIZE, undefined, 2);
    expect(layout.road[idx(0, 8)]).toBe(TownRoad.Street);
    expect(layout.road[idx(15, 8)]).toBe(TownRoad.Street);
    for (let x = 0; x < SIZE; x++) {
      const inner = x >= 2 && x < 14;
      expect(layout.zone[idx(x, 7)]).toBe(inner ? Zone.Residential : Zone.None);
      expect(layout.density[idx(x, 7)] !== 0).toBe(inner);
      expect(layout.zone[idx(x, 1)]).toBe(Zone.None);
      expect(layout.zone[idx(x, 14)]).toBe(Zone.None);
    }
    // only the rows beside the road keep their zone
    expect(report.counts.residential).toBe(12 * 2);
  });
});

describe('rasteriseTown on the fixture', () => {
  const data = parseOsm(readFileSync(new URL('./fixtures/town.osm', import.meta.url), 'utf8'));

  it.each(MAP_SIZES)('fills a %i grid', (size) => {
    const { layout, report } = rasteriseTown(data, size);
    expect(layout.size).toBe(size);
    for (const key of [
      'terrain',
      'forest',
      'road',
      'pedestrian',
      'rail',
      'zone',
      'density',
    ] as const) {
      expect(layout[key]).toBeInstanceOf(Uint8Array);
      expect(layout[key]).toHaveLength(size * size);
    }
    expect(report.metresPerTile).toBeCloseTo(3000 / (size - 2 * marginTiles(size)), 0);
    expect(report.roadComponents).toBe(1);
  });

  it('reports a sane town at 96', () => {
    const { layout, report } = rasteriseTown(data, 96);
    expect(report.metresPerTile).toBeCloseTo(3000 / 76, 1);
    expect(report.roadComponents).toBe(1);
    expect(layout.name).toBe('Bach & Berg');
    expect(layout.bbox[0]).toBeCloseTo(8.65, 6);
    for (const count of Object.values(report.counts)) expect(count).toBeGreaterThan(0);
    expect(report.skippedHighways).toEqual({ footway: 1, service: 1 });
    expect(report.thinned).toBeGreaterThan(0);
    expect(report.droppedZones).toBeGreaterThan(0);
    // the multipolygon lake, including its island (outer ring only), on
    // the inner 76 tiles behind the 10-tile ring
    const at = (share: number): number => 10 + Math.floor(share * 76);
    expect(layout.terrain[at(0.82) * 96 + at(0.47)]).toBe(Terrain.Lake);
  });

  it('never breaks the sim rules a stamp would reject', () => {
    const size = 96;
    const { layout } = rasteriseTown(data, size);
    const { terrain, forest, road, pedestrian, rail, zone, density } = layout;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const paved = road[i] !== TownRoad.None || rail[i] !== 0;
        if (terrain[i] === Terrain.Lake) expect(paved).toBe(false);
        if (terrain[i] !== Terrain.Land || paved) {
          expect(zone[i]).toBe(Zone.None);
          expect(forest[i]).toBe(0);
        }
        if (pedestrian[i] !== 0) {
          expect(road[i]).toBe(TownRoad.Street);
          expect(terrain[i]).toBe(Terrain.Land);
          expect(rail[i]).toBe(0);
        }
        if (zone[i] !== Zone.None) {
          const served =
            (y > 0 && road[i - size] !== 0) ||
            (x < size - 1 && road[i + 1] !== 0) ||
            (y < size - 1 && road[i + size] !== 0) ||
            (x > 0 && road[i - 1] !== 0);
          expect(served).toBe(true);
        }
        if (density[i] !== 0) {
          expect(zone[i]).not.toBe(Zone.None);
          expect(density[i]).toBeLessThanOrEqual(3);
        }
      }
    }
  });
});
