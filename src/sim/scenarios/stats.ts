import type { ConditionStatus, ScenarioStats } from '../../shared/types.ts';
import type { SimState } from '../state.ts';
import { evaluateCondition } from './conditions.ts';
import { scenarioDef } from './registry.ts';
import { scenarioDay } from './step.ts';
import type { Condition } from './types.ts';

function labelFor(c: Condition): string {
  return c.kind === 'goal' ? `goal.${c.id}.title` : `scenario.condition.${c.metric}`;
}

export function scenarioStats(state: SimState): ScenarioStats | undefined {
  const run = state.scenario;
  if (!run) return undefined;
  const def = scenarioDef(run.id);
  const rows = (role: 'win' | 'fail', list: Condition[]): ConditionStatus[] =>
    list.map((c) => ({
      role,
      kind: c.kind,
      label: labelFor(c),
      ...evaluateCondition(state, run, c),
    }));
  return {
    id: run.id,
    status: run.status,
    day: scenarioDay(run, state.tick),
    deadlineDays: def.deadlineDays,
    ...(run.endedTick !== undefined ? { endedDay: scenarioDay(run, run.endedTick) } : {}),
    conditions: [...rows('win', def.win), ...rows('fail', def.fail)],
  };
}
