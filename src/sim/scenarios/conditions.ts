import type { SimState } from '../state.ts';
import type { Condition, ScenarioMetric, ScenarioRun } from './types.ts';

export interface ConditionResult {
  met: boolean;
  current: number;
  target: number;
}

/** Metrics summed over a window; the rest read the last completed day. */
export const WINDOW_METRICS: ReadonlySet<ScenarioMetric> = new Set([
  'deficitTicks',
  'importedEnergy',
]);

/** i18n key naming a condition: the goal title or the metric label. */
export function conditionLabel(c: Condition): string {
  return c.kind === 'goal' ? `goal.${c.id}.title` : `scenario.condition.${c.metric}`;
}

/**
 * The metric's value for a condition: a window sum (zero before the first
 * day, which is a true zero), or the last completed day's sample — null
 * until one exists, so an "at most" rule is not met by the mere absence
 * of data on the first day.
 */
function metricValue(run: ScenarioRun, metric: ScenarioMetric, windowDays?: number): number | null {
  const samples = run.samples[metric];
  if (WINDOW_METRICS.has(metric)) {
    const from = windowDays === undefined ? 0 : Math.max(0, samples.length - windowDays);
    let sum = 0;
    for (let i = from; i < samples.length; i++) sum += samples[i];
    return sum;
  }
  return samples.length === 0 ? null : samples[samples.length - 1];
}

export function evaluateCondition(
  state: SimState,
  run: ScenarioRun,
  c: Condition,
): ConditionResult {
  if (c.kind === 'goal') {
    const met = state.goalsAchieved.has(c.id);
    return { met, current: met ? 1 : 0, target: 1 };
  }
  const value = metricValue(run, c.metric, c.windowDays);
  if (value === null) return { met: false, current: 0, target: c.value };
  const met = c.op === '>=' ? value >= c.value : value <= c.value;
  return { met, current: value, target: c.value };
}
