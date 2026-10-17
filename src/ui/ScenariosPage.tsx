// Side effect: registers the shipped scenario definitions in this bundle.
import '../sim/scenarios/defs/index.ts';
import { scenarioDefs } from '../sim/scenarios/registry.ts';
import type { Condition, ScenarioId } from '../sim/scenarios/types.ts';
import { useI18n, type TranslationKey } from './i18n.tsx';
import { Modal } from './Modal.tsx';
import { readBestResult } from './scenarioResults.ts';

type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string;

function conditionKey(c: Condition): TranslationKey {
  return (
    c.kind === 'goal' ? `goal.${c.id}.title` : `scenario.condition.${c.metric}`
  ) as TranslationKey;
}

function conditionText(c: Condition, t: Translate): string {
  if (c.kind === 'goal') return t(conditionKey(c));
  const value = c.metric.endsWith('Share') ? `${Math.round(c.value * 100)}%` : String(c.value);
  const window = c.windowDays ? ` (${c.windowDays} d)` : '';
  return `${t(conditionKey(c))} ${c.op} ${value}${window}`;
}

/** Lists the shipped scenarios with their rules and the best result so far. */
export function ScenariosPage({
  onStart,
  onClose,
}: {
  onStart: (id: ScenarioId) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <Modal title={t('scenarios.title')} onClose={onClose} testId="scenarios-page">
      {scenarioDefs().map((def) => {
        const best = readBestResult(def.id);
        return (
          <section key={def.id} className="scenario-card" data-testid={`scenario-${def.id}`}>
            <h3>{t(`scenario.${def.id}.title` as TranslationKey)}</h3>
            <p>{t(`scenario.${def.id}.teaser` as TranslationKey)}</p>
            <p className="scenario-meta">
              {t('scenarios.deadline', { n: def.deadlineDays })} ·{' '}
              {best
                ? t(`scenarios.best.${best.status}` as TranslationKey, { n: best.day })
                : t('scenarios.best.none')}
            </p>
            <p>
              <strong>{t('scenarios.win')}:</strong>{' '}
              {def.win.map((c) => conditionText(c, t)).join(' · ')}
            </p>
            <p>
              <strong>{t('scenarios.fail')}:</strong>{' '}
              {def.fail.map((c) => conditionText(c, t)).join(' · ')}
            </p>
            <button
              type="button"
              className="primary"
              data-testid={`start-scenario-${def.id}`}
              onClick={() => onStart(def.id)}
            >
              {t('scenarios.start')}
            </button>
          </section>
        );
      })}
    </Modal>
  );
}
