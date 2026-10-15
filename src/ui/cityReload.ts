import type { SaveGame } from '../shared/types.ts';
import type { SaveStorage } from '../storage/storage.ts';

/**
 * The one path that replaces the running city and reloads the page, plus
 * the autosave that must stay out of its way. Loading a save copies it
 * into the autosave slot and reloads; without the guard, the interval,
 * Ctrl+S, visibility or native-close autosave could land between the copy
 * and the reload and write the old city back.
 */
export interface CityReloader {
  /** True once a replacement has started; autosaves are dropped from then on. */
  readonly leaving: boolean;
  /** Writes the autosave unless the city is being replaced (then resolves without writing). */
  autosave(save: SaveGame): Promise<void>;
  /**
   * Sets the guard, makes `save` the autosave (or clears it for a new
   * city when null), then reloads. If the write fails the guard is lifted
   * again and the error rethrown, so the running city keeps autosaving.
   */
  replaceCityAndReload(save: SaveGame | null): Promise<void>;
}

export function createCityReloader(
  storage: Pick<SaveStorage, 'save' | 'clear'>,
  reload: () => void,
): CityReloader {
  let leaving = false;
  return {
    get leaving() {
      return leaving;
    },
    async autosave(save) {
      if (leaving) return;
      await storage.save(save);
    },
    async replaceCityAndReload(save) {
      leaving = true;
      try {
        if (save) await storage.save(save);
        else await storage.clear();
      } catch (error) {
        leaving = false;
        throw error;
      }
      reload();
    },
  };
}
