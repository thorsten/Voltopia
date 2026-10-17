// src/sim/scenarios/rules.ts
import { BALANCE } from '../../shared/constants.ts';
import { SEASON_ORDER, type SeasonId } from '../../shared/types.ts';
import type { SimState } from '../state.ts';
import type { ScenarioRules } from './types.ts';

/** seasonOriginDay such that day 0 is the first day of `startSeason`. */
export function seasonOriginDayFor(startSeason: SeasonId): number {
  // 0 - x, not -x: spring must give +0, not -0.
  return 0 - BALANCE.seasons.daysPerSeason * SEASON_ORDER.indexOf(startSeason);
}

/** Install scenario rules on a freshly created state (before any tick). */
export function applyRules(state: SimState, rules: ScenarioRules): void {
  state.rules = { ...rules };
  state.seasonOriginDay = seasonOriginDayFor(rules.startSeason);
}
