import type { ConditionStatus, ScenarioStats } from '../shared/types.ts';
import { conditionLabel, WINDOW_METRICS } from '../sim/scenarios/conditions.ts';
import type { Condition, ScenarioMetric } from '../sim/scenarios/types.ts';
import type { TranslationKey } from './i18n.tsx';

export type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string;

/** What a rule needs to be described: from a definition or a live row. */
export type ConditionRule = Pick<
  ConditionStatus,
  'kind' | 'label' | 'op' | 'target' | 'windowDays'
>;

const METRIC_PREFIX = 'scenario.condition.';

function metricOf(label: string): ScenarioMetric | undefined {
  return label.startsWith(METRIC_PREFIX)
    ? (label.slice(METRIC_PREFIX.length) as ScenarioMetric)
    : undefined;
}

/** A definition's condition as a rule (same shape the HUD rows carry). */
export function ruleFromDef(c: Condition): ConditionRule {
  return c.kind === 'goal'
    ? { kind: 'goal', label: conditionLabel(c), op: '>=', target: 1 }
    : {
        kind: 'metric',
        label: conditionLabel(c),
        op: c.op,
        target: c.value,
        ...(c.windowDays !== undefined ? { windowDays: c.windowDays } : {}),
      };
}

/** A metric value for display: shares as percent, the rest rounded. */
export function formatMetricValue(label: string, value: number): string {
  return label.endsWith('Share') ? `${Math.round(value * 100)}%` : String(Math.round(value));
}

/** The threshold with its operator and window, e.g. "at most 800 over the last 5 days". */
export function ruleText(c: ConditionRule, t: Translate): string {
  if (c.kind === 'goal') return '';
  const v = formatMetricValue(c.label, c.target);
  const bound = t(c.op === '>=' ? 'scenario.cond.atLeast' : 'scenario.cond.atMost', { v });
  const metric = metricOf(c.label);
  if (c.windowDays !== undefined)
    return `${bound} ${t('scenario.window.lastDays', { n: c.windowDays })}`;
  if (metric !== undefined && WINDOW_METRICS.has(metric))
    return `${bound} ${t('scenario.window.wholeRun')}`;
  return bound;
}

/** A rule as on the scenarios page: "Residents: at least 360". */
export function describeRule(c: ConditionRule, t: Translate): string {
  const name = t(c.label as TranslationKey);
  return c.kind === 'goal' ? name : `${name}: ${ruleText(c, t)}`;
}

/** A live row: "Residents: 412 (at least 360)"; goal rows only name the goal. */
export function describeStatus(c: ConditionStatus, t: Translate): string {
  const name = t(c.label as TranslationKey);
  if (c.kind === 'goal') return name;
  return `${name}: ${formatMetricValue(c.label, c.current)} (${ruleText(c, t)})`;
}

/**
 * Decorative marker: win rows ✓ (met) or ○ (open); fail rows ⚠ only when
 * they triggered, otherwise none.
 */
export function statusIcon(c: Pick<ConditionStatus, 'role' | 'met'>): string {
  if (c.role === 'win') return c.met ? '✓' : '○';
  return c.met ? '⚠' : '';
}

/**
 * The scenario day to show, 1-based like the HUD clock: the running day
 * (capped at the deadline), or once ended the day it ended on — which
 * then stops counting.
 */
export function scenarioDisplayDay(
  s: Pick<ScenarioStats, 'status' | 'day' | 'deadlineDays' | 'endedDay'>,
): number {
  if (s.status !== 'running') return s.endedDay ?? Math.min(s.day, s.deadlineDays);
  return Math.min(s.day + 1, s.deadlineDays);
}
