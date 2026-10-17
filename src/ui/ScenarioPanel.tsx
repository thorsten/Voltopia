import type { ScenarioStats } from '../shared/types.ts';
import { useI18n, type TranslationKey } from './i18n.tsx';

function fmt(kind: 'goal' | 'metric', label: string, value: number): string {
  if (kind === 'goal') return value >= 1 ? '✓' : '–';
  if (label.endsWith('Share')) return `${Math.round(value * 100)}%`;
  return String(Math.round(value));
}

/** HUD objectives of the running scenario; takes the goals panel's slot. */
export function ScenarioPanel({ scenario }: { scenario: ScenarioStats }) {
  const { t } = useI18n();
  const rows = (role: 'win' | 'fail') => scenario.conditions.filter((c) => c.role === role);
  return (
    <div className="hud-plate scenario-panel" data-testid="scenario-panel">
      <div className="scenario-head">
        <strong>{t(`scenario.${scenario.id}.title` as TranslationKey)}</strong>
        <span data-testid="scenario-day">
          {t('scenario.panel.day', {
            day: Math.min(scenario.day, scenario.deadlineDays),
            total: scenario.deadlineDays,
          })}
        </span>
        <span className={`scenario-status scenario-status-${scenario.status}`}>
          {t(`scenario.status.${scenario.status}` as TranslationKey)}
        </span>
      </div>
      <ul className="scenario-list">
        {rows('win').map((c, i) => (
          <li key={`w${i}`} className={c.met ? 'met' : ''}>
            <span>{c.met ? '✓' : '○'}</span> {t(c.label as TranslationKey)}:{' '}
            {fmt(c.kind, c.label, c.current)} / {fmt(c.kind, c.label, c.target)}
          </li>
        ))}
      </ul>
      <p className="scenario-fail-head">{t('scenarios.fail')}</p>
      <ul className="scenario-list scenario-fail">
        {rows('fail').map((c, i) => (
          <li key={`f${i}`} className={c.met ? 'met' : ''}>
            {t(c.label as TranslationKey)}: {fmt(c.kind, c.label, c.current)} (
            {fmt(c.kind, c.label, c.target)})
          </li>
        ))}
      </ul>
    </div>
  );
}
