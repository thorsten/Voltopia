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
            <div className="scenario-card-head">
              <h3>{t(`scenario.${def.id}.title` as TranslationKey)}</h3>
              <span
                className={`scenario-best${best ? ` scenario-best-${best.status}` : ''}`}
                data-testid={`scenario-best-${def.id}`}
              >
                {best
                  ? t(`scenarios.best.${best.status}` as TranslationKey, { n: best.day })
                  : t('scenarios.best.none')}
              </span>
            </div>
            <p className="scenario-teaser">{t(`scenario.${def.id}.teaser` as TranslationKey)}</p>
            <dl className="scenario-rules">
              <dt>{t('scenarios.win')}</dt>
              <dd>{def.win.map((c) => describeRule(ruleFromDef(c), t)).join(' · ')}</dd>
              <dt>{t('scenarios.fail')}</dt>
              <dd>{def.fail.map((c) => describeRule(ruleFromDef(c), t)).join(' · ')}</dd>
            </dl>
            <div className="scenario-card-foot">
              <span className="scenario-meta">
                {t('scenarios.deadline', { n: def.deadlineDays })}
              </span>
              <button
                type="button"
                className="scenario-start"
                data-testid={`start-scenario-${def.id}`}
                onClick={() => onStart(def.id)}
              >
                {t('scenarios.start')}
              </button>
            </div>
          </section>
        );
      })}
    </Modal>
  );
}
