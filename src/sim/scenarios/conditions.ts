import type { SimState } from '../state.ts';
import type { Condition, ScenarioMetric, ScenarioRun } from './types.ts';

export interface ConditionResult {
  met: boolean;
  current: number;
  target: number;
}

/** Metrics summed over a window; the rest read the last completed day. */
const WINDOW_METRICS: ReadonlySet<ScenarioMetric> = new Set(['deficitTicks', 'importedEnergy']);

function metricValue(run: ScenarioRun, metric: ScenarioMetric, windowDays?: number): number {
  const samples = run.samples[metric];
  if (WINDOW_METRICS.has(metric)) {
    const from = windowDays === undefined ? 0 : Math.max(0, samples.length - windowDays);
    let sum = 0;
    for (let i = from; i < samples.length; i++) sum += samples[i];
    return sum;
  }
  return samples.length === 0 ? 0 : samples[samples.length - 1];
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
  const current = metricValue(run, c.metric, c.windowDays);
  const met = c.op === '>=' ? current >= c.value : current <= c.value;
  return { met, current, target: c.value };
}
