import { SAVE_VERSION, TICKS_PER_DAY } from '../shared/constants.ts';
import type { SaveGame } from '../shared/types.ts';
import type { SaveSummary } from './storage.ts';

/**
 * The list entry for a save. `id` is left empty for the catalogue to
 * fill in. Population defaults to the last daily lifetime sample (0 on
 * day 1); callers with live stats pass the current value instead, so
 * the entry is not a day behind.
 */
export function summarizeSave(
  save: SaveGame,
  name: string,
  savedAt: number,
  population?: number,
): SaveSummary {
  const lifetime = save.lifetime ?? [];
  return {
    id: '',
    name,
    savedAt,
    day: Math.floor(save.tick / TICKS_PER_DAY) + 1,
    population: population ?? lifetime.at(-1)?.population ?? 0,
    money: save.money,
    size: save.size,
    compatible: save.version === SAVE_VERSION,
  };
}
