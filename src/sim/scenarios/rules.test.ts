// src/sim/scenarios/rules.test.ts
import { describe, expect, it } from 'vitest';
import { BALANCE } from '../../shared/constants.ts';
import { SEASON_ORDER } from '../../shared/types.ts';
import { createSimState, deserializeState, serializeState } from '../state.ts';
import { stepTick } from '../tick.ts';
import { applyRules, seasonOriginDayFor } from './rules.ts';
import { DEFAULT_RULES } from './types.ts';

describe('scenario rules', () => {
  it('a new state carries the default rules', () => {
    const state = createSimState(1, 16);
    expect(state.rules).toEqual(DEFAULT_RULES);
  });

  it('seasonOriginDayFor puts day 0 on the first day of the season', () => {
    const days = BALANCE.seasons.daysPerSeason;
    expect(seasonOriginDayFor('spring')).toBe(0);
    expect(seasonOriginDayFor('winter')).toBe(-days * SEASON_ORDER.indexOf('winter'));
  });

  it('applyRules sets the season so the first tick is in that season', () => {
    const state = createSimState(1, 16);
    applyRules(state, { importCapacityFactor: 0, startSeason: 'winter' });
    stepTick(state);
    expect(state.season.season).toBe('winter');
    expect(state.rules.importCapacityFactor).toBe(0);
  });

  it('rules survive a save round trip and default when absent', () => {
    const state = createSimState(1, 16);
    applyRules(state, { importCapacityFactor: 0, startSeason: 'autumn' });
    const save = serializeState(state);
    expect(deserializeState(save).rules).toEqual({
      importCapacityFactor: 0,
      startSeason: 'autumn',
    });
    delete save.rules;
    expect(deserializeState(save).rules).toEqual(DEFAULT_RULES);
  });
});
