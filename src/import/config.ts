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
  /** Longest side of the box in kilometres the rasteriser accepts. */
  maxBoxKm: 20,
  /** Width of a rasterised river line in tiles. */
  riverWidthTiles: 1,
  /**
   * Chebyshev radius the 2x2 thinning searches to prove that a tile's
   * road neighbours stay connected without it before removing it.
   */
  thinningWindow: 3,
} as const;
