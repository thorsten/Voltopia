import { useEffect, useState } from 'react';
import type { GlobalStats, ScenarioId } from '../shared/types.ts';
import { useI18n, type TranslationKey } from './i18n.tsx';
import { recordResult } from './scenarioResults.ts';

function winShownKey(seed: number): string {
  return `voltopia.winShown.${seed}`;
}

/** Remembers that a scenario's end screen was shown; a retry clears it. */
export function endShownKey(seed: number, id: string): string {
  return `voltopia.endShown.${seed}.${id}`;
}

/**
 * Overlay shown once per city: the celebration when every goal is
 * achieved in free play, or the result when a scenario is won or lost.
 */
export function EndScreen({
  stats,
  onCelebrate,
  onRetry,
  onScenarios,
}: {
  stats: GlobalStats;
  /** Called when a win appears (e.g. to play a fanfare). */
  onCelebrate?: () => void;
  onRetry: (id: ScenarioId) => void;
  onScenarios: () => void;
}) {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);

  const scenario = stats.scenario;
  const scenarioEnded = scenario !== undefined && scenario.status !== 'running';
  const allDone =
    scenario === undefined && stats.goals.length > 0 && stats.goals.every((g) => g.achieved);
  const shownKey = scenarioEnded ? endShownKey(stats.seed, scenario.id) : winShownKey(stats.seed);

  useEffect(() => {
    if (!(allDone || scenarioEnded) || visible) return;
    try {
      if (localStorage.getItem(shownKey) === '1') return;
      localStorage.setItem(shownKey, '1');
    } catch {
      // storage unavailable: still show, just maybe twice
    }
    if (scenarioEnded) {
      recordResult(
        scenario.id,
        scenario.status as 'won' | 'failed',
        scenario.endedDay ?? scenario.day,
      );
    }
    setVisible(true);
    if (allDone || scenario?.status === 'won') onCelebrate?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allDone, scenarioEnded, shownKey]);

  if (!visible) return null;

  if (scenarioEnded) {
    return (
      <div className="win-backdrop" data-testid="end-screen">
        <div className="win-card">
          <div className="win-emoji">{scenario.status === 'won' ? '🏆⚡🎉' : '🌑'}</div>
          <h2>{t(`scenario.end.${scenario.status}.title` as TranslationKey)}</h2>
          <p>{t('scenario.end.day', { n: scenario.endedDay ?? scenario.day })}</p>
          <ul className="scenario-list">
            {scenario.conditions.map((c, i) => (
              <li key={i} className={c.met ? 'met' : ''}>
                {c.role === 'fail' ? '⚠ ' : c.met ? '✓ ' : '○ '}
                {t(c.label as TranslationKey)}:{' '}
                {c.label.endsWith('Share')
                  ? `${Math.round(c.current * 100)}%`
                  : Math.round(c.current)}
              </li>
            ))}
          </ul>
          <div className="option-row">
            <button
              type="button"
              className="primary"
              data-testid="end-continue"
              onClick={() => setVisible(false)}
            >
              {t('scenario.end.continue')}
            </button>
            <button
              type="button"
              data-testid="end-retry"
              onClick={() => onRetry(scenario.id as ScenarioId)}
            >
              {t('scenario.end.retry')}
            </button>
            <button
              type="button"
              data-testid="end-scenarios"
              onClick={() => {
                setVisible(false);
                onScenarios();
              }}
            >
              {t('scenario.end.scenarios')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="win-backdrop" data-testid="win-screen">
      <div className="win-card">
        <div className="win-emoji">🏆⚡🎉</div>
        <h2>{t('win.title')}</h2>
        <p>{t('win.body')}</p>
        <p className="win-stats">
          {t('hud.residents')}: <strong>{stats.population}</strong> ·{' '}
          {t('hud.day', { n: stats.day + 1 })} · {t('hud.happiness')}:{' '}
          <strong>{Math.round(stats.happiness * 100)}%</strong>
        </p>
        <button
          type="button"
          className="primary"
          data-testid="win-continue"
          onClick={() => setVisible(false)}
        >
          {t('win.continue')}
        </button>
      </div>
    </div>
  );
}
