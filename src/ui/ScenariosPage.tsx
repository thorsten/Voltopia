// Side effect: registers the shipped scenario definitions in this bundle.
import '../sim/scenarios/defs/index.ts';
import { scenarioDefs } from '../sim/scenarios/registry.ts';
import type { ScenarioId } from '../sim/scenarios/types.ts';
import { useI18n, type TranslationKey } from './i18n.tsx';
import { Modal } from './Modal.tsx';
import { describeRule, ruleFromDef } from './scenarioFormat.ts';
import { readBestResult } from './scenarioResults.ts';

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
              {def.win.map((c) => describeRule(ruleFromDef(c), t)).join(' · ')}
            </p>
            <p>
              <strong>{t('scenarios.fail')}:</strong>{' '}
              {def.fail.map((c) => describeRule(ruleFromDef(c), t)).join(' · ')}
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
