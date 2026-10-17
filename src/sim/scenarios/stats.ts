import type { ConditionStatus, ScenarioStats } from '../../shared/types.ts';
import type { SimState } from '../state.ts';
import { conditionLabel, evaluateCondition } from './conditions.ts';
import { scenarioDef } from './registry.ts';
import { scenarioDay } from './step.ts';
import type { Condition } from './types.ts';

export function scenarioStats(state: SimState): ScenarioStats | undefined {
  const run = state.scenario;
  if (!run) return undefined;
  const def = scenarioDef(run.id);
  const rows = (role: 'win' | 'fail', list: Condition[]): ConditionStatus[] =>
    list.map((c) => ({
      role,
      kind: c.kind,
      label: conditionLabel(c),
      op: c.kind === 'goal' ? '>=' : c.op,
      ...(c.kind === 'metric' && c.windowDays !== undefined ? { windowDays: c.windowDays } : {}),
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
