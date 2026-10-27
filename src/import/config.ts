/**
 * Import configuration: which OpenStreetMap tags land on which layer and
 * the limits of the rasteriser. Rasteriser tuning lives here, not in
 * BALANCE — the settling thresholds (sim pacing) are BALANCE.osmImport.
 * The Overpass query is built from the same tables, so the download and
 * the rasteriser never disagree.
 */
import { Zone } from '../shared/types.ts';

export const OSM_IMPORT = {
  /** `highway=*` values drawn as avenues. */
  avenueHighways: [
    'motorway',
    'trunk',
    'primary',
    'secondary',
    'tertiary',
    'motorway_link',
    'trunk_link',
    'primary_link',
    'secondary_link',
    'tertiary_link',
  ] as const,
  /** `highway=*` values drawn as streets. */
  streetHighways: ['residential', 'unclassified', 'living_street'] as const,
  /** `highway=*` values drawn as streets with the pedestrian lane. */
  pedestrianHighways: ['pedestrian'] as const,
  /** `railway=*` values drawn as track; ways with a `service` tag (sidings, yards) are skipped. */
  railways: ['rail'] as const,
  /** `waterway=*` values drawn as river lines. */
  waterways: ['river', 'canal', 'stream'] as const,
  /** `natural=*` values filled as lake. */
  waterNaturals: ['water'] as const,
  /** `landuse=*` values filled as lake. */
  waterLanduses: ['reservoir', 'basin'] as const,
  /** `landuse=*` values filled as forest. */
  forestLanduses: ['forest'] as const,
  /** `natural=*` values filled as forest. */
  forestNaturals: ['wood'] as const,
  /** `landuse=*` values filled as zones. */
  zoneLanduses: {
    residential: Zone.Residential,
    commercial: Zone.Commercial,
    retail: Zone.Retail,
    industrial: Zone.Industrial,
  } as Readonly<Record<string, Zone>>,
  /** `place=*` values that can name the town, best first. */
  placeRanks: ['city', 'town', 'village'] as const,
  /** Nominatim place search (usage policy: at most one request per second, no autocomplete). */
  nominatimUrl: 'https://nominatim.openstreetmap.org/search',
  /** Overpass API endpoints, tried in order. */
  overpassEndpoints: [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ] as const,
  /** Sides in kilometres of the square excerpt the player can choose. */
  sideKm: [2.5, 3.5, 5] as const,
  /** Overpass server-side timeout; the client waits as long. */
  overpassTimeoutS: 60,
  /** Minimum gap between two place searches in milliseconds. */
  searchMinIntervalMs: 1000,
  /** Maximum number of place hits requested. */
  searchLimit: 8,
  /** Longest side of the box in kilometres the rasteriser accepts. */
  maxBoxKm: 20,
  /** Width of a rasterised river line in tiles. */
  riverWidthTiles: 1,
  /**
   * Chebyshev radius the 2x2 thinning searches to prove that a tile's
   * road neighbours stay connected without it before removing it.
   */
  thinningWindow: 3,
  /**
   * Estimates behind the import progress bar where nothing exact is
   * known: Overpass answers chunked, without a Content-Length, after
   * running the query server-side.
   */
  progress: {
    /**
     * Expected download size per square kilometre of the excerpt, in
     * bytes: Schwabmünchen's 3.5 km filtered download is about 2.5 MB over
     * 12.7 km².
     */
    expectedBytesPerKm2: 200_000,
    /** How long the Overpass queue typically takes to send the first byte. */
    expectedConnectMs: 15_000,
  },
} as const;
