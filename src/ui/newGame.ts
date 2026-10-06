import { BALANCE, GRID_SIZE } from '../shared/constants.ts';

/** Options chosen in the new-game dialog, applied on the next boot. */
export interface NewGameOptions {
  size: number;
  startingMoney: number;
  /** Fixed seed, or null for a random one. */
  seed: number | null;
  /** Disaster intensity: 0 = off .. 1.6 = harsh, see DISASTER_LEVELS. */
  disasterScale: number;
}

/**
 * Selectable map sizes. 128 is four times the tiles of 64: the
 * simulation carries it comfortably (measured 23 ms of a tick's 250 ms
 * budget on a grown city), while the frame cost grows with the map
 * because the instanced meshes span the whole grid — the diagnostics
 * panel in the settings is there to show what a given machine makes
 * of it.
 */
export const MAP_SIZES = [48, 64, 96, 128] as const;

export const DIFFICULTIES = [
  { id: 'easy', startingMoney: 40_000 },
  { id: 'normal', startingMoney: BALANCE.startingMoney },
  { id: 'hard', startingMoney: 15_000 },
] as const;

// Difficulty (starting funds) and disaster intensity are independent
// dials on purpose — a "hard" city is not forced into harsh disasters.
export const DISASTER_LEVELS = [
  { id: 'off', scale: 0 },
  { id: 'mild', scale: 0.5 },
  { id: 'normal', scale: 1 },
  { id: 'harsh', scale: 1.6 },
] as const;

export const DEFAULT_NEW_GAME: NewGameOptions = {
  size: GRID_SIZE,
  startingMoney: BALANCE.startingMoney,
  seed: null,
  disasterScale: 1,
};

const PENDING_KEY = 'voltopia.pendingNewGame';

/** Persist options for the reload that starts the new city. */
export function storePendingNewGame(options: NewGameOptions): void {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(options));
  } catch {
    // best effort only
  }
}

let consumedThisLoad: NewGameOptions | null = null;

/**
 * Read and consume pending options (returns defaults if none). The
 * result is cached per page load so React StrictMode's double effect
 * run doesn't lose the options after the first consumption.
 */
export function consumePendingNewGame(): NewGameOptions {
  if (consumedThisLoad) return consumedThisLoad;
  consumedThisLoad = readPendingNewGame();
  return consumedThisLoad;
}

function readPendingNewGame(): NewGameOptions {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    localStorage.removeItem(PENDING_KEY);
    if (!raw) return { ...DEFAULT_NEW_GAME };
    const parsed = JSON.parse(raw) as Partial<NewGameOptions>;
    return {
      size: MAP_SIZES.includes(parsed.size as (typeof MAP_SIZES)[number])
        ? (parsed.size as number)
        : DEFAULT_NEW_GAME.size,
      startingMoney:
        typeof parsed.startingMoney === 'number' && parsed.startingMoney > 0
          ? parsed.startingMoney
          : DEFAULT_NEW_GAME.startingMoney,
      seed: typeof parsed.seed === 'number' ? parsed.seed : null,
      disasterScale: DISASTER_LEVELS.some((level) => level.scale === parsed.disasterScale)
        ? (parsed.disasterScale as number)
        : DEFAULT_NEW_GAME.disasterScale,
    };
  } catch {
    return { ...DEFAULT_NEW_GAME };
  }
}

/** Derive a numeric seed from free-form text (or random when empty). */
export function seedFromText(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && Number.isInteger(numeric)) {
    return Math.abs(numeric) % 2147483647;
  }
  let hash = 5381;
  for (let i = 0; i < trimmed.length; i++) {
    hash = (hash * 33 + trimmed.charCodeAt(i)) >>> 0;
  }
  return hash % 2147483647;
}
