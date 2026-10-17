import { describe, expect, it } from 'vitest';
import { TICKS_PER_DAY } from '../../shared/constants.ts';
import type { SavedScenario } from '../../shared/types.ts';
import { createSimState, deserializeState, serializeState, type SimState } from '../state.ts';
import { scenarioDay, scenarioStep } from './step.ts';
import { DEFAULT_RULES, emptyRun, type ScenarioDef } from './types.ts';

function def(over: Partial<ScenarioDef> = {}): ScenarioDef {
  return {
    id: 'island',
    seed: 1,
    size: 16,
    startingMoney: 1000,
    disasterScale: 0,
    rules: { importCapacityFactor: 1, startSeason: 'spring' },
    deadlineDays: 2,
    win: [{ kind: 'metric', metric: 'money', op: '>=', value: 0 }],
    fail: [{ kind: 'metric', metric: 'money', op: '<=', value: -100 }],
    setup: () => {},
    ...over,
  };
}

function running(): SimState {
  const state = createSimState(1, 16);
  state.scenario = emptyRun('island', 0);
  return state;
}

/** Run one full day of scenario steps with a fixed energy outcome. */
function runDay(state: SimState, d: ScenarioDef, deficitTicks = 0): void {
  for (let i = 0; i < TICKS_PER_DAY; i++) {
    state.tick++;
    state.lastEnergy.deficit = i < deficitTicks ? 1 : 0;
    scenarioStep(state, d);
  }
}

describe('scenarioStep', () => {
  it('pushes one sample per metric at the day rollover', () => {
    const state = running();
    runDay(state, def(), 7);
    expect(state.scenario!.samples.deficitTicks).toEqual([7]);
    expect(state.scenario!.samples.money).toEqual([state.money]);
    expect(state.scenario!.today.ticks).toBe(0);
    expect(scenarioDay(state.scenario!, state.tick)).toBe(1);
  });

  it('wins at the deadline when every win condition holds', () => {
    const state = running();
    const d = def();
    runDay(state, d);
    expect(state.scenario!.status).toBe('running');
    runDay(state, d);
    expect(state.scenario!.status).toBe('won');
    expect(state.scenario!.endedTick).toBe(state.tick);
  });

  it('fails at the deadline when a win condition is unmet', () => {
    const state = running();
    state.money = -50;
    const d = def();
    runDay(state, d);
    runDay(state, d);
    expect(state.scenario!.status).toBe('failed');
  });

  it('a fail condition ends the run early and beats a win on the same day', () => {
    const state = running();
    state.money = -500;
    const d = def({
      win: [{ kind: 'metric', metric: 'money', op: '<=', value: 0 }],
      deadlineDays: 1,
    });
    runDay(state, d);
    expect(state.scenario!.status).toBe('failed');
  });

  it('freezes after the end', () => {
    const state = running();
    const d = def({ deadlineDays: 1 });
    runDay(state, d);
    const samples = state.scenario!.samples.money.length;
    runDay(state, d);
    expect(state.scenario!.samples.money.length).toBe(samples);
    expect(state.scenario!.status).toBe('won');
  });

  it('does nothing without a scenario', () => {
    const state = createSimState(1, 16);
    state.tick = TICKS_PER_DAY;
    expect(() => scenarioStep(state, def())).not.toThrow();
    expect(state.scenario).toBeUndefined();
  });

  it('survives a save round trip and is absent in an old save', () => {
    const state = running();
    runDay(state, def(), 3);
    const save = serializeState(state);
    const loaded = deserializeState(save);
    expect(loaded.scenario).toEqual(state.scenario);
    delete save.scenario;
    expect(deserializeState(save).scenario).toBeUndefined();
  });

  it('drops a saved scenario this build does not ship', () => {
    const save = serializeState(running());
    save.scenario = { ...save.scenario!, id: 'nope' };
    save.rules = { importCapacityFactor: 0, startSeason: 'winter' };
    const loaded = deserializeState(save);
    expect(loaded.scenario).toBeUndefined();
    expect(loaded.rules).toEqual(DEFAULT_RULES);
  });

  it('fills metrics and counters a save lacks from an empty run', () => {
    const save = serializeState(running());
    const samples = save.scenario!.samples as Record<string, number[]>;
    delete samples.suppliedShare;
    const today = save.scenario!.today as Partial<SavedScenario['today']>;
    delete today.suppliedShareSum;
    const loaded = deserializeState(save);
    expect(loaded.scenario!.samples.suppliedShare).toEqual([]);
    expect(loaded.scenario!.today.suppliedShareSum).toBe(0);
    expect(loaded.scenario!.id).toBe('island');
  });
});
