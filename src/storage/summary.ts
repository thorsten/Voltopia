import { BALANCE, SAVE_VERSION, TICKS_PER_DAY } from '../shared/constants.ts';
import { TileType, Zone, type SaveGame } from '../shared/types.ts';
import type { SaveSummary } from './storage.ts';

/** The city's display name in default save names. */
export const CITY_LABEL = 'Voltopia';

/** English default-name template; the UI passes its translated one. */
export const DEFAULT_SAVE_NAME_TEMPLATE = '{city} – day {day}';

/** In-game day (1-based) of a tick. */
export function dayOfTick(tick: number): number {
  return Math.floor(tick / TICKS_PER_DAY) + 1;
}

/**
 * The name a new save gets unless the player types one, e.g.
 * "Voltopia – day 12". `template` fills `{city}` and `{day}`.
 */
export function defaultSaveName(
  day: number,
  template: string = DEFAULT_SAVE_NAME_TEMPLATE,
  city: string = CITY_LABEL,
): string {
  return template.replace('{city}', city).replace('{day}', String(day));
}

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
    day: dayOfTick(save.tick),
    population: population ?? lifetime.at(-1)?.population ?? 0,
    money: save.money,
    size: save.size,
    compatible: save.version === SAVE_VERSION,
    ...(save.sandbox ? { sandbox: true } : {}),
  };
}

/**
 * Residents of a save, counted from its raw layers with the same
 * arithmetic as the sim's `countPopulationAndJobs` (built residential
 * lots on non-road, non-plant tiles). For saves without a lifetime,
 * e.g. a decoded share code.
 */
export function populationOfSave(save: SaveGame): number {
  const tileType = new Uint8Array(save.layers.tileType);
  const zone = new Uint8Array(save.layers.zone);
  const density = new Uint8Array(save.layers.density);
  let population = 0;
  for (let i = 0; i < zone.length; i++) {
    if (tileType[i] !== TileType.Empty || zone[i] !== Zone.Residential) continue;
    population += BALANCE.growth.populationByDensity[density[i]] ?? 0;
  }
  return population;
}
