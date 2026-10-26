import { BALANCE, GRID_SIZE, MAP_SIZES } from '../shared/constants.ts';
import { SCENARIO_IDS, type ScenarioId, type TownLayout } from '../shared/types.ts';
import { validateTownLayout } from '../sim/importTown.ts';
import { fromBase64Url, toBase64Url } from '../storage/shareCode.ts';

/** Options chosen in the new-game dialog, applied on the next boot. */
export interface NewGameOptions {
  size: number;
  startingMoney: number;
  /** Fixed seed, or null for a random one. */
  seed: number | null;
  /** Disaster intensity: 0 = off .. 1.6 = harsh, see DISASTER_LEVELS. */
  disasterScale: number;
  /** Start this scenario instead of a free city; the other options are ignored. */
  scenario?: ScenarioId;
  /** Sandbox free play: unlimited money, no credit, grant or goals. */
  sandbox?: boolean;
  /** Start on an imported town instead of a seeded map (same size). */
  layout?: TownLayout;
}

/** The typed-array layers of a TownLayout, in the order they are encoded. */
export const LAYOUT_LAYERS = [
  'terrain',
  'forest',
  'road',
  'pedestrian',
  'rail',
  'zone',
  'density',
] as const;
type LayoutLayer = (typeof LAYOUT_LAYERS)[number];

/** A TownLayout as JSON: every layer a base64url string (~100 KB at 128²). */
export interface PendingLayoutCode {
  size: number;
  name: string | null;
  bbox: [number, number, number, number];
  layers: Record<LayoutLayer, string>;
}

/** JSON shape of the pending options: the layout travels as `layoutCode`. */
type PendingNewGameJson = Omit<NewGameOptions, 'layout'> & { layoutCode?: PendingLayoutCode };

export { MAP_SIZES };

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
    const { layout, ...rest } = options;
    const json: PendingNewGameJson = layout
      ? { ...rest, layoutCode: encodePendingLayout(layout) }
      : rest;
    localStorage.setItem(PENDING_KEY, JSON.stringify(json));
  } catch {
    // best effort only
  }
}

/** Persist a scenario start for the reload that begins it. */
export function storePendingScenario(id: ScenarioId): void {
  storePendingNewGame({ ...DEFAULT_NEW_GAME, scenario: id });
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
    const parsed = JSON.parse(raw) as Partial<PendingNewGameJson>;
    const scenario = SCENARIO_IDS.includes(parsed.scenario as ScenarioId)
      ? (parsed.scenario as ScenarioId)
      : undefined;
    // A scenario fixes its own map size (the sim builds it from BALANCE).
    const size = scenario
      ? BALANCE.scenarios[scenario].size
      : MAP_SIZES.includes(parsed.size as (typeof MAP_SIZES)[number])
        ? (parsed.size as number)
        : DEFAULT_NEW_GAME.size;
    // An imported town only rides a free city of its own size; anything
    // else falls back to the seeded map rather than a half-trusted layout.
    const layout = scenario ? null : decodePendingLayout(parsed.layoutCode, size);
    if (parsed.layoutCode && !layout) {
      console.warn('Dropping an invalid pending town layout; starting a seeded city instead.');
    }
    return {
      size,
      startingMoney:
        typeof parsed.startingMoney === 'number' && parsed.startingMoney > 0
          ? parsed.startingMoney
          : DEFAULT_NEW_GAME.startingMoney,
      seed: typeof parsed.seed === 'number' ? parsed.seed : null,
      disasterScale: DISASTER_LEVELS.some((level) => level.scale === parsed.disasterScale)
        ? (parsed.disasterScale as number)
        : DEFAULT_NEW_GAME.disasterScale,
      ...(scenario ? { scenario } : {}),
      // Sandbox is free play only: a scenario start never carries it.
      ...(parsed.sandbox === true && !scenario ? { sandbox: true } : {}),
      ...(layout ? { layout } : {}),
    };
  } catch {
    return { ...DEFAULT_NEW_GAME };
  }
}

/** The JSON form of a layout for the pending-options store. */
export function encodePendingLayout(layout: TownLayout): PendingLayoutCode {
  const layers = {} as Record<LayoutLayer, string>;
  for (const layer of LAYOUT_LAYERS) layers[layer] = toBase64Url(layout[layer]);
  return { size: layout.size, name: layout.name, bbox: layout.bbox, layers };
}

/**
 * Decode a stored layout for a city of `size` tiles, or null when the
 * code is missing, corrupt, of another size or fails the sim's
 * validation (oversize layers, values out of range, bad bbox).
 */
export function decodePendingLayout(code: unknown, size: number): TownLayout | null {
  if (typeof code !== 'object' || code === null) return null;
  const { size: codeSize, name, bbox, layers } = code as Partial<PendingLayoutCode>;
  if (typeof layers !== 'object' || layers === null) return null;
  try {
    const layout: Record<string, unknown> = { size: codeSize, name, bbox };
    for (const layer of LAYOUT_LAYERS) {
      const text = layers[layer];
      if (typeof text !== 'string') return null;
      layout[layer] = fromBase64Url(text);
    }
    return validateTownLayout(layout, size) ? layout : null;
  } catch {
    return null;
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
