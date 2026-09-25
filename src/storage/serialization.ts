import { SAVE_VERSION } from '../shared/constants.ts';
import type { LifetimeSample, SaveGame } from '../shared/types.ts';

/** JSON-friendly form of a save game (ArrayBuffers as base64). */
interface SaveGameJson {
  version: number;
  seed: number;
  size: number;
  tick: number;
  money: number;
  taxRate: number;
  smartCharging: boolean;
  storedEnergy: number;
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
    smartCharging: save.smartCharging,
    storedEnergy: save.storedEnergy,
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
    layers,
  };
  return JSON.stringify(json, null, 2);
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
    smartCharging: parsed.smartCharging === true,
    storedEnergy: typeof parsed.storedEnergy === 'number' ? parsed.storedEnergy : 0,
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
    layers,
  };
}
