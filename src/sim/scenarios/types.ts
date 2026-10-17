// src/sim/scenarios/types.ts
import type { ScenarioId, SeasonId } from '../../shared/types.ts';
import type { GoalId } from '../goals.ts';
import type { SimState } from '../state.ts';

export { SCENARIO_IDS, type ScenarioId } from '../../shared/types.ts';

export const SCENARIO_METRICS = [
  'population',
  'money',
  'deficitTicks',
  'importedEnergy',
  'renewableShare',
  'suppliedShare',
] as const;
export type ScenarioMetric = (typeof SCENARIO_METRICS)[number];

export type Condition =
  | { kind: 'goal'; id: GoalId }
  | {
      kind: 'metric';
      metric: ScenarioMetric;
      op: '>=' | '<=';
      value: number;
      /** For deficitTicks / importedEnergy: sum over the last N days (default: whole run). */
      windowDays?: number;
    };

export interface ScenarioRules {
  /** Multiplies BALANCE.market.importCapacity; 0 = no import link. */
  importCapacityFactor: number;
  /** Season in which day 0 falls. */
  startSeason: SeasonId;
}

export const DEFAULT_RULES: ScenarioRules = { importCapacityFactor: 1, startSeason: 'spring' };

export interface ScenarioDef {
  id: ScenarioId;
  seed: number;
  size: number;
  startingMoney: number;
  disasterScale: number;
  rules: ScenarioRules;
  deadlineDays: number;
  win: Condition[];
  fail: Condition[];
  setup: (state: SimState) => void;
}

export type ScenarioStatus = 'running' | 'won' | 'failed';

export interface ScenarioRun {
  id: ScenarioId;
  startTick: number;
  status: ScenarioStatus;
  endedTick?: number;
  /** Per-day samples, newest last, capped at BALANCE.scenarios.maxSamples. */
  samples: Record<ScenarioMetric, number[]>;
  /** Running counters for the current day. */
  today: {
    deficitTicks: number;
    importedEnergy: number;
    renewable: number;
    generation: number;
    suppliedShareSum: number;
    ticks: number;
  };
}

export function emptyRun(id: ScenarioId, startTick: number): ScenarioRun {
  return {
    id,
    startTick,
    status: 'running',
    samples: {
      population: [],
      money: [],
      deficitTicks: [],
      importedEnergy: [],
      renewableShare: [],
      suppliedShare: [],
    },
    today: {
      deficitTicks: 0,
      importedEnergy: 0,
      renewable: 0,
      generation: 0,
      suppliedShareSum: 0,
      ticks: 0,
    },
  };
}
