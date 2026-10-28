/**
 * Rasterise parsed OpenStreetMap data onto the tile grid: roads, rail,
 * rivers, lakes, woods and zones become a TownLayout the sim stamps as
 * an imported city. Pure and DOM-free; the probe script and the import
 * page share it. The rules follow the design spec's "Parsing and
 * rasterising" section: terrain is its own layer (a road on the river is
 * a bridge, a road on a lake turns the tile into land), two-wide bands
 * are thinned without splitting the network, zones without a road are
 * dropped and building centroids settle the town.
 */
import { BALANCE } from '../shared/constants.ts';
import { Terrain, TownRoad, Zone, type TownLayout } from '../shared/types.ts';
import { OSM_IMPORT } from './config.ts';
import { boundsOf, createProjection, type Projection } from './geo.ts';
import {
  countComponents,
  fillPolygon,
  hasSetNeighbor,
  line4,
  type Point,
  ringArea,
} from './grid.ts';
import { type Bbox, type OsmData, type OsmWay, OsmImportError } from './osm.ts';

export type ImportCount =
  | 'street'
  | 'avenue'
  | 'pedestrian'
  | 'rail'
  | 'river'
  | 'lake'
  | 'forest'
  | 'residential'
  | 'commercial'
  | 'retail'
  | 'industrial'
  | 'buildings';

/** What the rasteriser made of the data; shown in the preview and returned by the agent tool. */
export interface ImportReport {
  metresPerTile: number;
  widthM: number;
  heightM: number;
  /** Tiles per layer; `buildings` counts the settled building tiles. */
  counts: Record<ImportCount, number>;
  /** 4-connected components of the road network (1 is what the sim wants). */
  roadComponents: number;
  /** Zone tiles dropped for lacking a road neighbour. */
  droppedZones: number;
  /** Road and rail tiles removed by the 2x2 thinning. */
  thinned: number;
  /** `highway=*` values the mapping ignores, with their way counts. */
  skippedHighways: Record<string, number>;
}

type AreaKind = { layer: 'lake' } | { layer: 'forest' } | { layer: 'zone'; zone: Zone };

interface Area {
  rings: Point[][];
  kind: AreaKind;
  size: number;
}

const AVENUES: ReadonlySet<string> = new Set(OSM_IMPORT.avenueHighways);
const STREETS: ReadonlySet<string> = new Set(OSM_IMPORT.streetHighways);
const PEDESTRIAN: ReadonlySet<string> = new Set(OSM_IMPORT.pedestrianHighways);
const RAILWAYS: ReadonlySet<string> = new Set(OSM_IMPORT.railways);
const WATERWAYS: ReadonlySet<string> = new Set(OSM_IMPORT.waterways);
const WATER_NATURALS: ReadonlySet<string> = new Set(OSM_IMPORT.waterNaturals);
const WATER_LANDUSES: ReadonlySet<string> = new Set(OSM_IMPORT.waterLanduses);
const FOREST_LANDUSES: ReadonlySet<string> = new Set(OSM_IMPORT.forestLanduses);
const FOREST_NATURALS: ReadonlySet<string> = new Set(OSM_IMPORT.forestNaturals);

function classifyArea(tags: Record<string, string>): AreaKind | null {
  if (
    (tags.natural !== undefined && WATER_NATURALS.has(tags.natural)) ||
    tags.water !== undefined ||
    (tags.landuse !== undefined && WATER_LANDUSES.has(tags.landuse))
  ) {
    return { layer: 'lake' };
  }
  if (
    (tags.natural !== undefined && FOREST_NATURALS.has(tags.natural)) ||
    (tags.landuse !== undefined && FOREST_LANDUSES.has(tags.landuse))
  ) {
    return { layer: 'forest' };
  }
  const zone = tags.landuse === undefined ? undefined : OSM_IMPORT.zoneLanduses[tags.landuse];
  return zone === undefined ? null : { layer: 'zone', zone };
}

function isClosed(refs: string[]): boolean {
  return refs.length > 3 && refs[0] === refs[refs.length - 1];
}

/** Width of the unzoned ring around the excerpt on a `size` grid. */
export function marginTiles(size: number): number {
  return Math.round(size * OSM_IMPORT.marginShare);
}

/**
 * Rasterise `data` onto a `size` x `size` grid. The box comes from the
 * argument (search flow), else the file's `<bounds>`, else the nodes.
 * `margin` tiles on every side stay free of zones and buildings.
 */
export function rasteriseTown(
  data: OsmData,
  size: number,
  bbox?: Bbox,
  margin = marginTiles(size),
): { layout: TownLayout; report: ImportReport } {
  const box = bbox ?? data.bounds ?? boundsOf(data.nodes.values());
  const projection = createProjection(box, size, margin);
  if (!Number.isFinite(projection.sideM)) throw new OsmImportError('empty');
  if (projection.sideM > OSM_IMPORT.maxBoxKm * 1000) throw new OsmImportError('boxTooLarge');

  const tiles = size * size;
  const terrain = new Uint8Array(tiles);
  const forest = new Uint8Array(tiles);
  const road = new Uint8Array(tiles);
  const pedestrian = new Uint8Array(tiles);
  const rail = new Uint8Array(tiles);
  const zone = new Uint8Array(tiles);
  const density = new Uint8Array(tiles);
  const skippedHighways: Record<string, number> = {};

  const points = (way: OsmWay): Point[] => wayPoints(data, projection, way.refs);
  const inside = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < size && y < size;
  const insideBox = (x: number, y: number): boolean =>
    x >= margin && y >= margin && x < size - margin && y < size - margin;
  const stamp = (x: number, y: number, width: number, paint: (index: number) => void): void => {
    for (let dy = 0; dy < width; dy++) {
      for (let dx = 0; dx < width; dx++) {
        if (inside(x + dx, y + dy)) paint((y + dy) * size + x + dx);
      }
    }
  };
  const polyline = (way: OsmWay, width: number, paint: (index: number) => void): void => {
    const pts = points(way);
    for (let i = 1; i < pts.length; i++) {
      line4(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], (x, y) =>
        stamp(x, y, width, paint),
      );
    }
  };

  // Areas, largest first, so a smaller area inside a bigger one wins its tiles.
  const areas: Area[] = [];
  const wayById = new Map<string, OsmWay>();
  for (const way of data.ways) {
    wayById.set(way.id, way);
    const kind = classifyArea(way.tags);
    if (kind === null || !isClosed(way.refs) || way.tags.area === 'no') continue;
    const ring = points(way);
    areas.push({ rings: [ring], kind, size: ringArea(ring) });
  }
  for (const relation of data.relations) {
    const kind = classifyArea(relation.tags);
    if (kind === null) continue;
    const rings: Point[][] = [];
    for (const id of relation.outer) {
      const way = wayById.get(id);
      if (way !== undefined) rings.push(points(way));
    }
    if (rings.length === 0) continue;
    areas.push({ rings, kind, size: rings.reduce((sum, ring) => sum + ringArea(ring), 0) });
  }
  areas.sort((a, b) => b.size - a.size);
  for (const { rings, kind } of areas) {
    fillPolygon(rings, size, (x, y) => {
      const index = y * size + x;
      if (kind.layer === 'lake') terrain[index] = Terrain.Lake;
      else if (kind.layer === 'forest') forest[index] = BALANCE.forest.maxStage;
      else if (insideBox(x, y)) zone[index] = kind.zone;
    });
  }

  // Lines: rivers, rail, then roads (streets before avenues).
  for (const way of data.ways) {
    const { tags } = way;
    if (tags.waterway !== undefined && WATERWAYS.has(tags.waterway)) {
      polyline(way, OSM_IMPORT.riverWidthTiles, (index) => {
        terrain[index] = Terrain.River;
      });
    }
    if (tags.railway !== undefined && RAILWAYS.has(tags.railway) && tags.service === undefined) {
      polyline(way, 1, (index) => {
        rail[index] = 1;
      });
    }
  }
  const avenues: OsmWay[] = [];
  for (const way of data.ways) {
    const highway = way.tags.highway;
    if (highway === undefined) continue;
    if (AVENUES.has(highway)) avenues.push(way);
    else if (STREETS.has(highway)) {
      polyline(way, 1, (index) => {
        road[index] = TownRoad.Street;
      });
    } else if (PEDESTRIAN.has(highway)) {
      polyline(way, 1, (index) => {
        road[index] = TownRoad.Street;
        pedestrian[index] = 1;
      });
    } else skippedHighways[highway] = (skippedHighways[highway] ?? 0) + 1;
  }
  for (const way of avenues) {
    polyline(way, 1, (index) => {
      road[index] = TownRoad.Avenue;
      pedestrian[index] = 0;
    });
  }

  // Terrain fix-up: the sim paves and lays track over the river (bridges)
  // but never over a lake; nothing grows on water, under a road or a track;
  // woods beat zones; a pedestrian lane fits neither a bridge nor a crossing.
  for (let index = 0; index < tiles; index++) {
    const paved = road[index] !== TownRoad.None || rail[index] !== 0;
    if (paved && terrain[index] === Terrain.Lake) terrain[index] = Terrain.Land;
    if (paved || terrain[index] !== Terrain.Land) {
      zone[index] = Zone.None;
      forest[index] = 0;
    } else if (forest[index] !== 0) zone[index] = Zone.None;
    if (terrain[index] === Terrain.River || rail[index] !== 0) pedestrian[index] = 0;
  }

  // Thinning: two-wide bands (dual carriageways, double track) lose one tile per 2x2 block.
  const thinned =
    thinBlocks(road, size, (index) => {
      road[index] = TownRoad.None;
      pedestrian[index] = 0;
    }) +
    thinBlocks(rail, size, (index) => {
      rail[index] = 0;
    });

  // Zones the sim could never grow: no road beside them.
  let droppedZones = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const index = y * size + x;
      if (zone[index] === Zone.None || hasSetNeighbor(road, size, x, y)) continue;
      zone[index] = Zone.None;
      droppedZones++;
    }
  }

  // Settling: building centroids per tile raise the density of what is left.
  const centroids = new Uint16Array(tiles);
  for (const way of data.ways) {
    if (way.tags.building === undefined) continue;
    const pts = points(way);
    if (pts.length === 0) continue;
    const ring = isClosed(way.refs) ? pts.slice(0, -1) : pts;
    let sx = 0;
    let sy = 0;
    for (const [x, y] of ring) {
      sx += x;
      sy += y;
    }
    const x = Math.floor(sx / ring.length);
    const y = Math.floor(sy / ring.length);
    if (insideBox(x, y)) centroids[y * size + x]++;
  }
  const thresholds = BALANCE.osmImport.buildingsPerDensity;
  for (let index = 0; index < tiles; index++) {
    if (zone[index] === Zone.None || centroids[index] < thresholds[0]) continue;
    let level = 0;
    while (level < thresholds.length && centroids[index] >= thresholds[level]) level++;
    density[index] = level;
  }

  const counts: Record<ImportCount, number> = {
    street: 0,
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
  };
  for (let index = 0; index < tiles; index++) {
    if (road[index] === TownRoad.Street) counts.street++;
    else if (road[index] === TownRoad.Avenue) counts.avenue++;
    if (pedestrian[index] !== 0) counts.pedestrian++;
    if (rail[index] !== 0) counts.rail++;
    if (terrain[index] === Terrain.River) counts.river++;
    else if (terrain[index] === Terrain.Lake) counts.lake++;
    if (forest[index] !== 0) counts.forest++;
    if (zone[index] === Zone.Residential) counts.residential++;
    else if (zone[index] === Zone.Commercial) counts.commercial++;
    else if (zone[index] === Zone.Retail) counts.retail++;
    else if (zone[index] === Zone.Industrial) counts.industrial++;
    if (density[index] !== 0) counts.buildings++;
  }

  const layout: TownLayout = {
    size,
    terrain,
    forest,
    road,
    pedestrian,
    rail,
    zone,
    density,
    name: townName(data, box),
    bbox: [box[0], box[1], box[2], box[3]],
  };
  const report: ImportReport = {
    metresPerTile: projection.metresPerTile,
    widthM: projection.widthM,
    heightM: projection.heightM,
    counts,
    roadComponents: countComponents(road, size),
    droppedZones,
    thinned,
    skippedHighways,
  };
  return { layout, report };
}

function wayPoints(data: OsmData, projection: Projection, refs: string[]): Point[] {
  const pts: Point[] = [];
  for (const ref of refs) {
    const node = data.nodes.get(ref);
    if (node !== undefined) pts.push(projection.project(node));
  }
  return pts;
}

/**
 * Remove one tile from every 2x2 block of set tiles, trying the block's
 * tiles top-left first. A tile goes only when its set neighbours stay
 * connected to each other without it inside a small window: that can
 * never split the network (the global component count is implied) and
 * it keeps the tile a side street joins a dual carriageway on. A second
 * pass drops the one-tile stubs the first leaves where a band ends.
 */
function thinBlocks(mask: Uint8Array, size: number, remove: (index: number) => void): number {
  const gone = new Uint8Array(mask.length);
  let removed = 0;
  const drop = (index: number): void => {
    mask[index] = 0;
    gone[index] = 1;
    remove(index);
    removed++;
  };
  for (let y = 0; y + 1 < size; y++) {
    for (let x = 0; x + 1 < size; x++) {
      const index = y * size + x;
      if (
        mask[index] === 0 ||
        mask[index + 1] === 0 ||
        mask[index + size] === 0 ||
        mask[index + size + 1] === 0
      ) {
        continue;
      }
      for (const candidate of [index, index + 1, index + size, index + size + 1]) {
        if (neighborsStayConnected(mask, size, candidate)) {
          drop(candidate);
          break;
        }
      }
    }
  }
  // Stubs: a lone tile left sticking out sideways where a band ended. The
  // band's own end tile continues the line (the tile beyond its neighbour is
  // set) and stays; a stub's neighbour must keep another neighbour.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const index = y * size + x;
      if (mask[index] === 0 || !hasSetNeighbor(gone, size, x, y)) continue;
      const neighbors = setNeighbors(mask, size, index);
      if (neighbors.length !== 1) continue;
      const next = neighbors[0];
      const nx = next % size;
      const ny = (next - nx) / size;
      const bx = nx + (nx - x);
      const by = ny + (ny - y);
      const beyondInside = bx >= 0 && bx < size && by >= 0 && by < size;
      if (beyondInside && mask[by * size + bx] !== 0) continue;
      if (setNeighbors(mask, size, next).length < 2) continue;
      drop(index);
    }
  }
  return removed;
}

function setNeighbors(mask: Uint8Array, size: number, index: number): number[] {
  const x = index % size;
  const y = (index - x) / size;
  const found: number[] = [];
  if (y > 0 && mask[index - size] !== 0) found.push(index - size);
  if (x < size - 1 && mask[index + 1] !== 0) found.push(index + 1);
  if (y < size - 1 && mask[index + size] !== 0) found.push(index + size);
  if (x > 0 && mask[index - 1] !== 0) found.push(index - 1);
  return found;
}

/**
 * Whether the set neighbours of `index` reach each other without it,
 * searching only within OSM_IMPORT.thinningWindow tiles of it.
 */
function neighborsStayConnected(mask: Uint8Array, size: number, index: number): boolean {
  const targets = setNeighbors(mask, size, index);
  if (targets.length <= 1) return true;
  const cx = index % size;
  const cy = (index - cx) / size;
  const reach = OSM_IMPORT.thinningWindow;
  const seen = new Set<number>([index]);
  const stack = [targets[0]];
  seen.add(targets[0]);
  let found = 1;
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const next of setNeighbors(mask, size, current)) {
      if (seen.has(next)) continue;
      const nx = next % size;
      const ny = (next - nx) / size;
      if (Math.abs(nx - cx) > reach || Math.abs(ny - cy) > reach) continue;
      seen.add(next);
      stack.push(next);
      if (targets.includes(next) && ++found === targets.length) return true;
    }
  }
  return false;
}

/** Name of the best-ranked named place inside the box, or null. */
function townName(data: OsmData, box: Bbox): string | null {
  const [w, s, e, n] = box;
  let best: { rank: number; name: string } | null = null;
  for (const { lon, lat, tags } of data.places) {
    if (lon < w || lon > e || lat < s || lat > n || tags.name === undefined) continue;
    const rank = (OSM_IMPORT.placeRanks as readonly string[]).indexOf(tags.place);
    if (rank < 0) continue;
    if (best === null || rank < best.rank) best = { rank, name: tags.name };
  }
  return best?.name ?? null;
}
