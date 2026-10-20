import { useState } from 'react';
import { Modal } from './Modal.tsx';
import { useI18n, type TranslationKey } from './i18n.tsx';
import { INTROS, type IntroId } from './intros.ts';

const SECTIONS: Array<{ title: TranslationKey; body: TranslationKey }> = [
  { title: 'help.goal.title', body: 'help.goal.body' },
  { title: 'help.build.title', body: 'help.build.body' },
  { title: 'help.energy.title', body: 'help.energy.body' },
  { title: 'help.grid.title', body: 'help.grid.body' },
  { title: 'help.districts.title', body: 'help.districts.body' },
  { title: 'help.water.title', body: 'help.water.body' },
  { title: 'help.terrain.title', body: 'help.terrain.body' },
  { title: 'help.nature.title', body: 'help.nature.body' },
  { title: 'help.seasons.title', body: 'help.seasons.body' },
  { title: 'help.heat.title', body: 'help.heat.body' },
  { title: 'help.disasters.title', body: 'help.disasters.body' },
  { title: 'help.ev.title', body: 'help.ev.body' },
  { title: 'help.traffic.title', body: 'help.traffic.body' },
  { title: 'help.deliveries.title', body: 'help.deliveries.body' },
  { title: 'help.transit.title', body: 'help.transit.body' },
  { title: 'help.rail.title', body: 'help.rail.body' },
  { title: 'help.cycling.title', body: 'help.cycling.body' },
  { title: 'help.services.title', body: 'help.services.body' },
  { title: 'help.icons.title', body: 'help.icons.body' },
  { title: 'help.controls.title', body: 'help.controls.body' },
  { title: 'help.saves.title', body: 'help.saves.body' },
];

export function HelpPage({
  onClose,
  onStartIntro,
  onStartTutorial,
  onResetIntros,
}: {
  onClose: () => void;
  onStartIntro: (id: IntroId) => void;
  onStartTutorial: () => void;
  onResetIntros: () => void;
}) {
  const { t } = useI18n();
  const [resetDone, setResetDone] = useState(false);
  return (
    <Modal title={t('help.title')} onClose={onClose} testId="help-page">
      <section>
        <h3>{t('help.intros.title')}</h3>
        <p>{t('help.intros.body')}</p>
        <div className="help-intro-row">
          <span>{t('help.intros.tutorial')}</span>
          <button type="button" data-testid="help-tutorial-start" onClick={onStartTutorial}>
            {t('help.intros.start')}
          </button>
        </div>
        {INTROS.map((intro) => (
          <div className="help-intro-row" key={intro.id}>
            <span>{t(intro.steps[0].title)}</span>
            <button
              type="button"
              data-testid={`help-intro-start-${intro.id}`}
              onClick={() => onStartIntro(intro.id)}
            >
              {t('help.intros.start')}
            </button>
          </div>
        ))}
        <div className="help-intro-row">
          <button
            type="button"
            data-testid="help-intros-reset"
            onClick={() => {
              onResetIntros();
              setResetDone(true);
            }}
          >
            {t('help.intros.reset')}
          </button>
          {resetDone && <span className="help-intro-note">{t('help.intros.resetDone')}</span>}
        </div>
      </section>
      {SECTIONS.map((section) => (
        <section key={section.title}>
          <h3>{t(section.title)}</h3>
          <p>{t(section.body)}</p>
        </section>
      ))}
    </Modal>
  );
}
