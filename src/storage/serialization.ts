import { SAVE_VERSION } from '../shared/constants.ts';
import {
  POLICY_IDS,
  SEASON_ORDER,
  type FinanceSave,
  type LifetimeSample,
  type PolicyId,
  type SaveGame,
  type SavedDisasters,
  type SavedScenario,
  type SavedTrain,
  type SeasonId,
} from '../shared/types.ts';

/** Canonical layer order. Share format v1 depends on it: APPEND ONLY. */
export const SAVE_LAYERS = [
  // required (present in every save since v1)
  'tileType',
  'roadMask',
  'zone',
  'density',
  'variant',
  'supplied',
  'plantType',
  // optional, in the order they were introduced
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
  'overpass',
  'roadLane',
  'pvMandated',
] as const satisfies readonly (keyof SaveGame['layers'])[];
/** The first `REQUIRED_LAYER_COUNT` entries of `SAVE_LAYERS` are in every save. */
export const REQUIRED_LAYER_COUNT = 7;
export type SaveLayerName = (typeof SAVE_LAYERS)[number];
// Compile-time exhaustiveness: a new layer key must be appended above.
type MissingLayer = Exclude<keyof SaveGame['layers'], SaveLayerName>;
const LAYERS_COMPLETE: [MissingLayer] extends [never] ? true : MissingLayer = true;
void LAYERS_COMPLETE;

/** Every SaveGame field except `layers`, JSON-ready (no ArrayBuffers). */
export type SaveFields = Omit<SaveGame, 'layers'>;

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

function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/**
 * Finite, not just a number: a persisted counter must not be poisoned by
 * a hand-edited export's NaN (the goal could never be met).
 */
function finiteNum(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Shallow shape check, all or nothing (same reasoning as
 * `isSavedDisasters`): `deserializeState` merges a known scenario over a
 * fresh run, so every field it reads must be the right type.
 */
function isSavedScenario(value: unknown): value is SavedScenario {
  if (!isPlainObject(value)) return false;
  const s = value as Partial<Record<keyof SavedScenario, unknown>>;
  if (typeof s.id !== 'string' || !isFiniteNumber(s.startTick)) return false;
  if (s.status !== 'running' && s.status !== 'won' && s.status !== 'failed') return false;
  if (s.endedTick !== undefined && !isFiniteNumber(s.endedTick)) return false;
  if (!isPlainObject(s.samples)) return false;
  for (const series of Object.values(s.samples)) {
    if (!Array.isArray(series) || !series.every(isFiniteNumber)) return false;
  }
  if (!isPlainObject(s.today)) return false;
  const today = s.today;
  return (
    [
      'deficitTicks',
      'importedEnergy',
      'renewable',
      'generation',
      'suppliedShareSum',
      'ticks',
    ] as const
  ).every((key) => isFiniteNumber(today[key]));
}

function isSeasonId(value: unknown): value is SeasonId {
  return (SEASON_ORDER as readonly unknown[]).includes(value);
}

type BaseKey = 'version' | 'seed' | 'size' | 'tick' | 'money' | 'taxRate' | 'layers';
type OptionalKey = Exclude<keyof SaveGame, BaseKey>;
/**
 * One reader per optional SaveGame field: returns the sanitised value or
 * undefined (= drop). `-?` makes every key mandatory here, so a new
 * SaveGame field without a reader is a type error.
 */
type FieldReaders = { [K in OptionalKey]-?: (value: unknown) => SaveGame[K] | undefined };

const FIELD_READERS: FieldReaders = {
  policies: (value) => {
    if (!isPlainObject(value)) return undefined;
    const policies: Partial<Record<PolicyId, boolean>> = {};
    for (const id of POLICY_IDS) {
      if (typeof value[id] === 'boolean') policies[id] = value[id];
    }
    return policies;
  },
  // Only the shape: loadFinance sanitises every member on load.
  finance: (value) => (isPlainObject(value) ? (value as unknown as FinanceSave) : undefined),
  rules: (value) => {
    if (!isPlainObject(value)) return undefined;
    const { importCapacityFactor, startSeason } = value;
    if (!isFiniteNumber(importCapacityFactor) || importCapacityFactor < 0) return undefined;
    if (!isSeasonId(startSeason)) return undefined;
    return { importCapacityFactor, startSeason };
  },
  scenario: (value) => (isSavedScenario(value) ? value : undefined),
  sandbox: (value) => (value === true ? true : undefined),
  smartCharging: bool,
  storedEnergy: num,
  // Pairs of (tile index, level), taken whole or not at all: dropping a
  // single bad entry would shift every later pair onto the wrong tile.
  // The values themselves are checked on load, where the layers that
  // decide a tile's capacity are in place.
  stored: (value) => (isStoredPairs(value) ? value : undefined),
  goals: (value) =>
    Array.isArray(value) ? value.filter((g): g is string => typeof g === 'string') : undefined,
  lifetime: (value) =>
    Array.isArray(value)
      ? value.filter(
          (sample): sample is LifetimeSample =>
            typeof sample === 'object' && sample !== null && typeof sample.day === 'number',
        )
      : undefined,
  riverFlow: num,
  pumpedStorageEnergy: num,
  hydrogenEnergy: num,
  marketTrading: bool,
  seasonOriginDay: num,
  snowpack: num,
  insulation: bool,
  winterTicks: num,
  summerTicks: num,
  freeFlowTicks: num,
  wellStockedTicks: num,
  transitTicks: num,
  railTicks: finiteNum,
  activeTicks: finiteNum,
  // Dropped one train at a time, not the whole fleet: a bad record from
  // a hand-edited export should not cost every other train.
  trains: (value) => (Array.isArray(value) ? value.filter(isSavedTrain) : undefined),
  heatStored: num,
  warmWinterTicks: num,
  districtDeficitTicks: finiteNum,
  flexTicks: finiteNum,
  smartMeters: (value) => (isSavedSmartMeters(value) ? value : undefined),
  flexBacklog: num,
  demandResponse: (value) => (isSavedDemandResponse(value) ? value : undefined),
  islandPools: (value) => (isSavedIslandPools(value) ? value : undefined),
  shedTotal: finiteNum,
  disasterScale: num,
  disasters: (value) => (isSavedDisasters(value) ? value : undefined),
};

/** Every field but `layers`, copied as is: the writer can never drop a field. */
export function saveFieldsToJson(save: SaveGame): SaveFields {
  const { layers: _layers, ...fields } = save;
  return fields;
}

/**
 * Read every field but `layers` from parsed JSON. Throws on a missing or
 * malformed base field or an unsupported version; optional fields that
 * fail their reader are dropped.
 */
export function saveFieldsFromJson(parsed: unknown): SaveFields {
  if (!isPlainObject(parsed)) throw new Error('Not a valid Voltopia save file');
  if (
    parsed.version !== SAVE_VERSION ||
    typeof parsed.seed !== 'number' ||
    typeof parsed.size !== 'number' ||
    typeof parsed.tick !== 'number' ||
    typeof parsed.money !== 'number'
  ) {
    throw new Error('Not a valid Voltopia save file');
  }
  const fields: SaveFields = {
    version: parsed.version,
    seed: parsed.seed,
    size: parsed.size,
    tick: parsed.tick,
    money: parsed.money,
    taxRate: typeof parsed.taxRate === 'number' ? parsed.taxRate : 0.1,
  };
  const target = fields as Record<string, unknown>;
  for (const key of Object.keys(FIELD_READERS) as OptionalKey[]) {
    const value = (FIELD_READERS[key] as (value: unknown) => unknown)(parsed[key]);
    if (value !== undefined) target[key] = value;
  }
  return fields;
}

/** Serialize a save game to a portable JSON string (for file export). */
export function saveToJson(save: SaveGame): string {
  const layers: Record<string, string> = {};
  for (const name of SAVE_LAYERS) {
    const buffer = save.layers[name];
    if (buffer) layers[name] = bufferToBase64(buffer);
  }
  return JSON.stringify({ ...saveFieldsToJson(save), layers }, null, 2);
}

/**
 * Parse an exported JSON save. Throws on malformed input or an
 * unsupported version.
 */
export function saveFromJson(text: string): SaveGame {
  const parsed: unknown = JSON.parse(text);
  const rawLayers = isPlainObject(parsed) ? parsed.layers : undefined;
  if (typeof rawLayers !== 'object' || rawLayers === null) {
    throw new Error('Not a valid Voltopia save file');
  }
  const fields = saveFieldsFromJson(parsed);
  const encodedLayers = rawLayers as Record<string, unknown>;
  const expectedBytes = fields.size * fields.size;
  const layers = {} as SaveGame['layers'];
  SAVE_LAYERS.forEach((name, i) => {
    const encoded = encodedLayers[name];
    if (typeof encoded !== 'string') {
      if (i < REQUIRED_LAYER_COUNT) throw new Error(`Save file is missing layer "${name}"`);
      return;
    }
    const buffer = base64ToBuffer(encoded);
    if (buffer.byteLength !== expectedBytes) {
      throw new Error(`Layer "${name}" has the wrong size`);
    }
    layers[name] = buffer;
  });
  return { ...fields, layers };
}
