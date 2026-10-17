import type { SimState } from '../state.ts';
import { applyRules } from './rules.ts';
import { emptyRun, type ScenarioDef } from './types.ts';

/**
 * Turn a generated, empty state into the scenario's starting city.
 * Call after terrain/water/forest generation and before the first tick.
 */
export function startScenario(state: SimState, def: ScenarioDef): void {
  state.disasterScale = def.disasterScale;
  applyRules(state, def.rules);
  def.setup(state);
  state.gridVersion++;
  state.statsDirty = true;
  state.scenario = emptyRun(def.id, state.tick);
}
