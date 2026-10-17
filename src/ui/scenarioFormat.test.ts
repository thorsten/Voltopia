import { describe, expect, it } from 'vitest';
import type { ConditionStatus } from '../shared/types.ts';
import { englishText } from './i18n.tsx';
import {
  describeRule,
  describeStatus,
  ruleFromDef,
  scenarioDisplayDay,
  statusIcon,
} from './scenarioFormat.ts';

const t = englishText;

function row(over: Partial<ConditionStatus>): ConditionStatus {
  return {
    role: 'win',
    kind: 'metric',
    label: 'scenario.condition.population',
    op: '>=',
    met: false,
    current: 0,
    target: 0,
    ...over,
  };
}

describe('scenario condition formatter', () => {
  it('describes definition rules with operator words, percent and window', () => {
    expect(
      describeRule(ruleFromDef({ kind: 'metric', metric: 'population', op: '>=', value: 360 }), t),
    ).toBe('Residents: at least 360');
    expect(
      describeRule(
        ruleFromDef({ kind: 'metric', metric: 'renewableShare', op: '>=', value: 0.8 }),
        t,
      ),
    ).toBe('Renewable share: at least 80%');
    expect(
      describeRule(
        ruleFromDef({
          kind: 'metric',
          metric: 'deficitTicks',
          op: '<=',
          value: 800,
          windowDays: 5,
        }),
        t,
      ),
    ).toBe('Deficit ticks: at most 800 over the last 5 days');
    expect(
      describeRule(
        ruleFromDef({ kind: 'metric', metric: 'deficitTicks', op: '<=', value: 5_400 }),
        t,
      ),
    ).toBe('Deficit ticks: at most 5400 over the whole run');
    expect(describeRule(ruleFromDef({ kind: 'goal', id: 'stormProof' }), t)).toBe(
      t('goal.stormProof.title'),
    );
  });

  it('describes live rows with the current value next to the rule', () => {
    expect(describeStatus(row({ current: 412.4, target: 360 }), t)).toBe(
      'Residents: 412 (at least 360)',
    );
    expect(
      describeStatus(
        row({
          role: 'fail',
          label: 'scenario.condition.suppliedShare',
          op: '<=',
          current: 0.613,
          target: 0.5,
        }),
        t,
      ),
    ).toBe('Buildings supplied: 61% (at most 50%)');
    // Goal rows carry no 0/1 numbers.
    expect(
      describeStatus(row({ kind: 'goal', label: 'goal.stormProof.title', target: 1 }), t),
    ).toBe(t('goal.stormProof.title'));
  });

  it('marks win rows ✓/○ and only triggered fail rows ⚠', () => {
    expect(statusIcon({ role: 'win', met: true })).toBe('✓');
    expect(statusIcon({ role: 'win', met: false })).toBe('○');
    expect(statusIcon({ role: 'fail', met: true })).toBe('⚠');
    expect(statusIcon({ role: 'fail', met: false })).toBe('');
  });

  it('counts the day from 1 while running and freezes it once ended', () => {
    const base = { deadlineDays: 20 };
    expect(scenarioDisplayDay({ ...base, status: 'running', day: 0 })).toBe(1);
    expect(scenarioDisplayDay({ ...base, status: 'running', day: 20 })).toBe(20);
    expect(scenarioDisplayDay({ ...base, status: 'failed', day: 9, endedDay: 3 })).toBe(3);
    expect(scenarioDisplayDay({ ...base, status: 'won', day: 25, endedDay: 20 })).toBe(20);
  });
});
