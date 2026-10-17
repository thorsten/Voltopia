import type { ScenarioDef, ScenarioId } from './types.ts';

const DEFS: Partial<Record<ScenarioId, ScenarioDef>> = {};

export function registerScenario(def: ScenarioDef): void {
  DEFS[def.id] = def;
}

export function scenarioDef(id: ScenarioId): ScenarioDef {
  const def = DEFS[id];
  if (!def) throw new Error(`unknown scenario ${id}`);
  return def;
}

export function scenarioDefs(): ScenarioDef[] {
  return Object.values(DEFS) as ScenarioDef[];
}
