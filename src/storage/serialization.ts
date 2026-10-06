import { SAVE_VERSION } from '../shared/constants.ts';
import type { LifetimeSample, SaveGame, SavedDisasters, SavedTrain } from '../shared/types.ts';

/** JSON-friendly form of a save game (ArrayBuffers as base64). */
interface SaveGameJson {
  version: number;
  seed: number;
  size: number;
  tick: number;
  money: number;
  taxRate: number;
  smartCharging?: boolean;
  /** Legacy battery pool; read on load, never written (see `stored`). */
  storedEnergy?: number;
  /** Storage per plant tile as [index, value, index, value, …]. */
  stored?: number[];
  smartMeters?: { active: boolean; metered: number };
  flexBacklog?: number;
  demandResponse?: { active: boolean; callBudget?: number };
  /** Per-island pools as [key, flexBacklog, callBudget] triplets. */
  islandPools?: [number, number, number][];
  shedTotal?: number;
  goals?: string[];
  lifetime?: LifetimeSample[];
  riverFlow?: number;
  pumpedStorageEnergy?: number;
  hydrogenEnergy?: number;
  marketTrading?: boolean;
  seasonOriginDay?: number;
  snowpack?: number;
  insulation?: boolean;
  winterTicks?: number;
  summerTicks?: number;
  freeFlowTicks?: number;
  wellStockedTicks?: number;
  transitTicks?: number;
  railTicks?: number;
  /** Trains in flight (absent in saves from before railways). */
  trains?: SavedTrain[];
  heatStored?: number;
  warmWinterTicks?: number;
  districtDeficitTicks?: number;
  flexTicks?: number;
  disasterScale?: number;
  disasters?: SavedDisasters;
  layers: Record<string, string>;
}

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x2000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer as ArrayBuffer;
}

/** A `stored` array is only usable whole: even length, all finite numbers. */
function isStoredPairs(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length % 2 === 0 &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

/** Serialize a save game to a portable JSON string (for file export). */
export function saveToJson(save: SaveGame): string {
  const layers: Record<string, string> = {};
  for (const [name, buffer] of Object.entries(save.layers)) {
    layers[name] = bufferToBase64(buffer);
  }
  const json: SaveGameJson = {
    version: save.version,
    seed: save.seed,
    size: save.size,
    tick: save.tick,
    money: save.money,
    taxRate: save.taxRate,
    ...(save.stored !== undefined ? { stored: save.stored } : {}),
    ...(save.smartCharging !== undefined ? { smartCharging: save.smartCharging } : {}),
    ...(save.smartMeters !== undefined ? { smartMeters: save.smartMeters } : {}),
    ...(save.flexBacklog !== undefined ? { flexBacklog: save.flexBacklog } : {}),
    ...(save.islandPools !== undefined ? { islandPools: save.islandPools } : {}),
    ...(save.goals ? { goals: save.goals } : {}),
    ...(save.lifetime ? { lifetime: save.lifetime } : {}),
    ...(save.riverFlow !== undefined ? { riverFlow: save.riverFlow } : {}),
    ...(save.hydrogenEnergy !== undefined ? { hydrogenEnergy: save.hydrogenEnergy } : {}),
    ...(save.marketTrading !== undefined ? { marketTrading: save.marketTrading } : {}),
    ...(save.pumpedStorageEnergy !== undefined
      ? { pumpedStorageEnergy: save.pumpedStorageEnergy }
      : {}),
    ...(save.seasonOriginDay !== undefined ? { seasonOriginDay: save.seasonOriginDay } : {}),
    ...(save.snowpack !== undefined ? { snowpack: save.snowpack } : {}),
    ...(save.insulation !== undefined ? { insulation: save.insulation } : {}),
    ...(save.winterTicks !== undefined ? { winterTicks: save.winterTicks } : {}),
    ...(save.summerTicks !== undefined ? { summerTicks: save.summerTicks } : {}),
    ...(save.freeFlowTicks !== undefined ? { freeFlowTicks: save.freeFlowTicks } : {}),
    ...(save.wellStockedTicks !== undefined ? { wellStockedTicks: save.wellStockedTicks } : {}),
    ...(save.transitTicks !== undefined ? { transitTicks: save.transitTicks } : {}),
    ...(save.railTicks !== undefined ? { railTicks: save.railTicks } : {}),
    ...(save.trains !== undefined ? { trains: save.trains } : {}),
    ...(save.heatStored !== undefined ? { heatStored: save.heatStored } : {}),
    ...(save.warmWinterTicks !== undefined ? { warmWinterTicks: save.warmWinterTicks } : {}),
    ...(save.districtDeficitTicks !== undefined
      ? { districtDeficitTicks: save.districtDeficitTicks }
      : {}),
    ...(save.flexTicks !== undefined ? { flexTicks: save.flexTicks } : {}),
    ...(save.demandResponse !== undefined ? { demandResponse: save.demandResponse } : {}),
    ...(save.shedTotal !== undefined ? { shedTotal: save.shedTotal } : {}),
    ...(save.disasterScale !== undefined ? { disasterScale: save.disasterScale } : {}),
    ...(save.disasters !== undefined ? { disasters: save.disasters } : {}),
    layers,
  };
  return JSON.stringify(json, null, 2);
}

/** Shallow shape check: a hand-edited export must not break the loader. */
function isSavedDisasterEvent(value: unknown): value is SavedDisasters['events'][number] {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Partial<SavedDisasters['events'][number]>;
  return (
    typeof e.id === 'number' &&
    typeof e.kind === 'number' &&
    typeof e.severity === 'number' &&
    typeof e.startTick === 'number' &&
    typeof e.endTick === 'number' &&
    typeof e.origin === 'number' &&
    Array.isArray(e.tiles) &&
    e.tiles.every((t) => typeof t === 'number') &&
    Array.isArray(e.intensity) &&
    e.intensity.every((n) => typeof n === 'number') &&
    typeof e.active === 'boolean'
  );
}

/**
 * Shallow shape check: a hand-edited export must not break the loader.
 * A missing/malformed cooldownTicks would become undefined or NaN, where
 * both `> 0` and `=== 0` are false — the city would never roll another
 * disaster again. So validate every field the loader actually reads, not
 * just nextId/events, and let the caller drop the whole block on failure:
 * a city with no events in flight is a safe fallback, one that can never
 * face another disaster is not.
 */
function isSavedDisasters(value: unknown): value is SavedDisasters {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<SavedDisasters>;
  return (
    typeof candidate.nextId === 'number' &&
    typeof candidate.cooldownTicks === 'number' &&
    Array.isArray(candidate.events) &&
    candidate.events.every(isSavedDisasterEvent)
  );
}

/** Shallow shape check: a hand-edited export must not break the loader. */
function isSavedTrain(value: unknown): value is SavedTrain {
  if (typeof value !== 'object' || value === null) return false;
  const t = value as Partial<SavedTrain>;
  return (
    typeof t.id === 'number' &&
    typeof t.kind === 'number' &&
    typeof t.yard === 'number' &&
    typeof t.yardTrack === 'number' &&
    typeof t.x === 'number' &&
    typeof t.y === 'number' &&
    typeof t.angle === 'number' &&
    typeof t.phase === 'number' &&
    Array.isArray(t.stops) &&
    t.stops.every((n) => typeof n === 'number') &&
    typeof t.pickup === 'number' &&
    Array.isArray(t.path) &&
    t.path.every((n) => typeof n === 'number') &&
    typeof t.pathIndex === 'number' &&
    typeof t.dwellTicks === 'number'
  );
}

/** Shallow shape check: a hand-edited export must not break the loader. */
function isSavedSmartMeters(value: unknown): value is { active: boolean; metered: number } {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Partial<{ active: boolean; metered: number }>;
  return typeof m.active === 'boolean' && typeof m.metered === 'number';
}

function isSavedDemandResponse(value: unknown): value is { active: boolean; callBudget?: number } {
  if (typeof value !== 'object' || value === null) return false;
  const d = value as Partial<{ active: boolean; callBudget: number }>;
  if (typeof d.active !== 'boolean') return false;
  return d.callBudget === undefined || typeof d.callBudget === 'number';
}

/**
 * An `islandPools` array is only usable whole: even one entry with a
 * non-finite number invalidates the whole field, the same as
 * `isStoredPairs` — dropping just the bad entry would leave the rest
 * keyed correctly but the caller has no way to tell which survived.
 */
function isSavedIslandPools(value: unknown): value is [number, number, number][] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 3 &&
        entry.every((n) => typeof n === 'number' && Number.isFinite(n)),
    )
  );
}

/**
 * Parse an exported JSON save. Throws on malformed input or an
 * unsupported version.
 */
export function saveFromJson(text: string): SaveGame {
  const parsed = JSON.parse(text) as Partial<SaveGameJson>;
  if (
    parsed.version !== SAVE_VERSION ||
    typeof parsed.seed !== 'number' ||
    typeof parsed.size !== 'number' ||
    typeof parsed.tick !== 'number' ||
    typeof parsed.money !== 'number' ||
    typeof parsed.layers !== 'object' ||
    parsed.layers === null
  ) {
    throw new Error('Not a valid Voltopia save file');
  }
  const expectedBytes = parsed.size * parsed.size;
  const layerNames = [
    'tileType',
    'roadMask',
    'zone',
    'density',
    'variant',
    'supplied',
    'plantType',
  ] as const;
  const layers = {} as SaveGame['layers'];
  for (const name of layerNames) {
    const encoded = parsed.layers[name];
    if (typeof encoded !== 'string') {
      throw new Error(`Save file is missing layer "${name}"`);
    }
    const buffer = base64ToBuffer(encoded);
    if (buffer.byteLength !== expectedBytes) {
      throw new Error(`Layer "${name}" has the wrong size`);
    }
    layers[name] = buffer;
  }
  const optionalLayers = [
    'terrain',
    'powerLine',
    'elevation',
    'roadClass',
    'busStop',
    'forest',
    'geothermal',
    'reservoirHeat',
    'damage',
    'rail',
  ] as const;
  for (const name of optionalLayers) {
    const encoded = parsed.layers[name];
    if (typeof encoded !== 'string') continue;
    const buffer = base64ToBuffer(encoded);
    if (buffer.byteLength !== expectedBytes) {
      throw new Error(`Layer "${name}" has the wrong size`);
    }
    layers[name] = buffer;
  }
  return {
    version: parsed.version,
    seed: parsed.seed,
    size: parsed.size,
    tick: parsed.tick,
    money: parsed.money,
    taxRate: typeof parsed.taxRate === 'number' ? parsed.taxRate : 0.1,
    ...(typeof parsed.storedEnergy === 'number' ? { storedEnergy: parsed.storedEnergy } : {}),
    // Pairs of (tile index, level), taken whole or not at all: dropping a
    // single bad entry would shift every later pair onto the wrong tile.
    // The values themselves are checked on load, where the layers that
    // decide a tile's capacity are in place.
    ...(isStoredPairs(parsed.stored) ? { stored: parsed.stored } : {}),
    ...(typeof parsed.smartCharging === 'boolean' ? { smartCharging: parsed.smartCharging } : {}),
    ...(isSavedSmartMeters(parsed.smartMeters) ? { smartMeters: parsed.smartMeters } : {}),
    ...(typeof parsed.flexBacklog === 'number' ? { flexBacklog: parsed.flexBacklog } : {}),
    ...(isSavedIslandPools(parsed.islandPools) ? { islandPools: parsed.islandPools } : {}),
    ...(Array.isArray(parsed.goals)
      ? { goals: parsed.goals.filter((g): g is string => typeof g === 'string') }
      : {}),
    ...(Array.isArray(parsed.lifetime)
      ? {
          lifetime: parsed.lifetime.filter(
            (sample): sample is LifetimeSample =>
              typeof sample === 'object' && sample !== null && typeof sample.day === 'number',
          ),
        }
      : {}),
    ...(typeof parsed.riverFlow === 'number' ? { riverFlow: parsed.riverFlow } : {}),
    ...(typeof parsed.hydrogenEnergy === 'number' ? { hydrogenEnergy: parsed.hydrogenEnergy } : {}),
    ...(typeof parsed.marketTrading === 'boolean' ? { marketTrading: parsed.marketTrading } : {}),
    ...(typeof parsed.pumpedStorageEnergy === 'number'
      ? { pumpedStorageEnergy: parsed.pumpedStorageEnergy }
      : {}),
    ...(typeof parsed.seasonOriginDay === 'number'
      ? { seasonOriginDay: parsed.seasonOriginDay }
      : {}),
    ...(typeof parsed.snowpack === 'number' ? { snowpack: parsed.snowpack } : {}),
    ...(typeof parsed.insulation === 'boolean' ? { insulation: parsed.insulation } : {}),
    ...(typeof parsed.winterTicks === 'number' ? { winterTicks: parsed.winterTicks } : {}),
    ...(typeof parsed.summerTicks === 'number' ? { summerTicks: parsed.summerTicks } : {}),
    ...(typeof parsed.freeFlowTicks === 'number' ? { freeFlowTicks: parsed.freeFlowTicks } : {}),
    ...(typeof parsed.wellStockedTicks === 'number'
      ? { wellStockedTicks: parsed.wellStockedTicks }
      : {}),
    ...(typeof parsed.transitTicks === 'number' ? { transitTicks: parsed.transitTicks } : {}),
    // Finite, not just a number: a persisted streak counter must not be
    // poisoned by a hand-edited export's NaN (same reasoning as flexTicks).
    ...(typeof parsed.railTicks === 'number' && Number.isFinite(parsed.railTicks)
      ? { railTicks: parsed.railTicks }
      : {}),
    // Dropped one train at a time, not the whole fleet: a bad record from
    // a hand-edited export should not cost every other train.
    ...(Array.isArray(parsed.trains) ? { trains: parsed.trains.filter(isSavedTrain) } : {}),
    ...(typeof parsed.heatStored === 'number' ? { heatStored: parsed.heatStored } : {}),
    ...(typeof parsed.warmWinterTicks === 'number'
      ? { warmWinterTicks: parsed.warmWinterTicks }
      : {}),
    ...(typeof parsed.districtDeficitTicks === 'number' &&
    Number.isFinite(parsed.districtDeficitTicks)
      ? { districtDeficitTicks: parsed.districtDeficitTicks }
      : {}),
    // Finite, not just a number: NaN from a hand-edited export would
    // poison a cumulative counter for good (the goal could never be met).
    ...(typeof parsed.flexTicks === 'number' && Number.isFinite(parsed.flexTicks)
      ? { flexTicks: parsed.flexTicks }
      : {}),
    ...(isSavedDemandResponse(parsed.demandResponse)
      ? { demandResponse: parsed.demandResponse }
      : {}),
    ...(typeof parsed.shedTotal === 'number' && Number.isFinite(parsed.shedTotal)
      ? { shedTotal: parsed.shedTotal }
      : {}),
    ...(typeof parsed.disasterScale === 'number' ? { disasterScale: parsed.disasterScale } : {}),
    ...(isSavedDisasters(parsed.disasters) ? { disasters: parsed.disasters } : {}),
    layers,
  };
}
