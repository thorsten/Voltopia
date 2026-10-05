import type { IslandStats } from '../shared/types.ts';

/**
 * A district row's status, the same rule the Grid overlay colours tiles
 * by: a deficit outranks curtailment (an island can run both), everything
 * else reads as healthy.
 */
export function districtStatus(island: {
  deficit: number;
  curtailment: number;
}): 'deficit' | 'curtailing' | 'ok' {
  if (island.deficit > 0) return 'deficit';
  if (island.curtailment > 0) return 'curtailing';
  return 'ok';
}

/** District list order: biggest island first, lowest number breaking ties. */
export function sortDistricts(islands: readonly IslandStats[]): IslandStats[] {
  return [...islands].sort((a, b) => b.tiles - a.tiles || a.number - b.number);
}
