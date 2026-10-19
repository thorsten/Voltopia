import { describe, expect, it } from 'vitest';
import { BALANCE } from '../../shared/constants.ts';
import { SimEngine } from '../engine.ts';
import { buildStats } from '../tick.ts';
import { scenarioDef } from './registry.ts';

describe('scenario stats', () => {
  it('free play has no scenario block', () => {
    const engine = new SimEngine(1, 16);
    engine.applyCommand({ type: 'init', seed: 1, size: 16 });
    expect(buildStats(engine.state).scenario).toBeUndefined();
  });

  it('a running scenario reports day, deadline and one row per condition', () => {
    const engine = new SimEngine(1, 16);
    engine.applyCommand({ type: 'init', seed: 1, size: 16, scenario: 'stormSeason' });
    const def = scenarioDef('stormSeason');
    const s = buildStats(engine.state).scenario!;
    expect(s).toMatchObject({
      id: 'stormSeason',
      status: 'running',
      day: 0,
      deadlineDays: def.deadlineDays,
    });
    expect(s.conditions).toHaveLength(def.win.length + def.fail.length);
    expect(s.conditions[0]).toMatchObject({
      role: 'win',
      kind: 'goal',
      label: 'goal.stormProof.title',
      op: '>=',
      met: false,
      target: 1,
    });
    const cash = s.conditions.find(
      (c) => c.role === 'fail' && c.label === 'scenario.condition.cash',
    );
    expect(cash).toMatchObject({ op: '<=' });
    expect(cash?.windowDays).toBeUndefined();
    const deficit = s.conditions.find(
      (c) => c.role === 'win' && c.label === 'scenario.condition.deficitTicks',
    );
    expect(deficit).toMatchObject({
      op: '<=',
      windowDays: BALANCE.scenarios.stormSeason.deficitWindowDays,
    });
  });
});
