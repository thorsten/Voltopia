import type {
  GlobalStats,
  LifetimeSample,
  PlantType,
  SaveGame,
  Speed,
  TileDiff,
  VehicleState,
  Zone,
} from './types.ts';

/**
 * Commands sent from the main thread to the simulation worker. A command
 * may carry a `requestId`; the worker then answers with a `commandResult`
 * event once the command has been applied (agent tools await it).
 */
export type SimCommand = SimCommandBody & { requestId?: number };

type SimCommandBody =
  | {
      type: 'init';
      seed: number;
      size: number;
      save?: SaveGame;
      /** Difficulty: overrides the default starting funds (new games only). */
      startingMoney?: number;
      /** Disaster intensity: 0 = off .. 1.6 = harsh (new games only). */
      disasterScale?: number;
    }
  | { type: 'setSpeed'; speed: Speed }
  | { type: 'buildRoad'; tiles: number[]; avenue?: boolean }
  | { type: 'buildPowerLine'; tiles: number[] }
  | { type: 'buildBusStop'; tiles: number[] }
  | { type: 'paintZone'; tiles: number[]; zone: Zone }
  | { type: 'placePlant'; tile: number; plant: PlantType }
  | { type: 'bulldoze'; tiles: number[] }
  | { type: 'undo' }
  | { type: 'setTaxRate'; rate: number }
  | { type: 'setSmartCharging'; enabled: boolean }
  | { type: 'setSmartMeterRollout'; active: boolean }
  | { type: 'setMarketTrading'; enabled: boolean }
  | { type: 'plantForest'; tiles: number[] }
  | { type: 'buyInsulation' }
  /** Select a tile for the inspector (null clears it). */
  | { type: 'inspectTile'; tile: number | null }
  | { type: 'requestSave' }
  | { type: 'requestLifetime' };

/** Events sent from the simulation worker to the main thread. */
export type SimEvent =
  | { type: 'ready' }
  | {
      type: 'tick';
      diffs: TileDiff[];
      stats: GlobalStats;
      vehicles: VehicleState[];
    }
  | { type: 'saveData'; save: SaveGame }
  | { type: 'lifetimeData'; samples: LifetimeSample[] }
  | { type: 'rejected'; reason: string }
  | {
      type: 'commandResult';
      requestId: number;
      /** Rejection code when the command was refused (see i18n `rejection.*`). */
      rejected?: string;
    };
