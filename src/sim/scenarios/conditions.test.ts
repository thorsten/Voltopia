import { describe, expect, it } from 'vitest';
import { createSimState } from '../state.ts';
import { evaluateCondition } from './conditions.ts';
import { emptyRun } from './types.ts';

describe('scenario conditions', () => {
  it('last-day metrics read the newest sample', () => {
    const state = createSimState(1, 16);
    const run = emptyRun('island', 0);
    run.samples.population = [10, 250, 320];
    expect(
      evaluateCondition(state, run, { kind: 'metric', metric: 'population', op: '>=', value: 300 }),
    ).toEqual({ met: true, current: 320, target: 300 });
    run.samples.money = [100, -6000];
    expect(
      evaluateCondition(state, run, { kind: 'metric', metric: 'money', op: '<=', value: -5000 })
        .met,
    ).toBe(true);
  });

  it('an "at most" rule is not met before the first sample exists', () => {
    const state = createSimState(1, 16);
    const run = emptyRun('stormSeason', 0);
    const r = evaluateCondition(state, run, {
      kind: 'metric',
      metric: 'suppliedShare',
      op: '<=',
      value: 0.5,
    });
    expect(r).toEqual({ met: false, current: 0, target: 0.5 });
    run.samples.suppliedShare = [0.4];
    expect(
      evaluateCondition(state, run, {
        kind: 'metric',
        metric: 'suppliedShare',
        op: '<=',
        value: 0.5,
      }).met,
    ).toBe(true);
  });

  it('a metric with no sample yet is unmet with current 0', () => {
    const state = createSimState(1, 16);
    const run = emptyRun('island', 0);
    const r = evaluateCondition(state, run, {
      kind: 'metric',
      metric: 'population',
      op: '>=',
      value: 1,
    });
    expect(r).toEqual({ met: false, current: 0, target: 1 });
  });

  it('window metrics sum the last N existing days only', () => {
    const state = createSimState(1, 16);
    const run = emptyRun('island', 0);
    run.samples.deficitTicks = [50, 0, 5, 7];
    expect(
      evaluateCondition(state, run, {
        kind: 'metric',
        metric: 'deficitTicks',
        op: '<=',
        value: 12,
        windowDays: 3,
      }),
    ).toEqual({ met: true, current: 12, target: 12 });
    expect(
      evaluateCondition(state, run, {
        kind: 'metric',
        metric: 'deficitTicks',
        op: '<=',
        value: 12,
        windowDays: 30,
      }).current,
    ).toBe(62);
    expect(
      evaluateCondition(state, run, {
        kind: 'metric',
        metric: 'deficitTicks',
        op: '<=',
        value: 100,
      }).current,
    ).toBe(62);
  });

  it('goal conditions read goalsAchieved', () => {
    const state = createSimState(1, 16);
    const run = emptyRun('stormSeason', 0);
    expect(evaluateCondition(state, run, { kind: 'goal', id: 'stormProof' })).toEqual({
      met: false,
      current: 0,
      target: 1,
    });
    state.goalsAchieved.add('stormProof');
    expect(evaluateCondition(state, run, { kind: 'goal', id: 'stormProof' }).met).toBe(true);
  });
});
