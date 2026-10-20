import type { LifetimeSample } from '../shared/types.ts';
import type { SaveSummary } from '../storage/storage.ts';

/** `voltopia-<kind>-<YYYY-MM-DD>.csv`. */
export function csvFileName(kind: 'days' | 'years', date: Date): string {
  return `voltopia-${kind}-${date.toISOString().slice(0, 10)}.csv`;
}

/** Saves a city can be compared with: compatible ones; the UI formats the label. */
export function compareOptions(
  saves: SaveSummary[],
): Array<{ id: string; name: string; day: number }> {
  return saves
    .filter((save) => save.compatible)
    .map((save) => ({ id: save.id, name: save.name, day: save.day }));
}

interface History {
  samples: LifetimeSample[];
}

/**
 * The other city's values on this city's day axis, founding-aligned:
 * `sample.day` counts from tick 0 (the founding) for every city kind —
 * free play, pre-season saves and scenarios alike. result[i] belongs to
 * own.samples[i]; NaN where the other city has no sample (or no value)
 * for that day.
 */
export function alignSeries(
  own: History,
  other: History,
  pick: (s: LifetimeSample) => number | undefined,
): number[] {
  const byDay = new Map<number, number>();
  for (const sample of other.samples) {
    const value = pick(sample);
    if (value !== undefined) byDay.set(sample.day, value);
  }
  return own.samples.map((sample) => byDay.get(sample.day) ?? NaN);
}
