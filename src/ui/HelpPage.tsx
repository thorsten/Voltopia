import { Modal } from './Modal.tsx';
import { useI18n, type TranslationKey } from './i18n.tsx';

const SECTIONS: Array<{ title: TranslationKey; body: TranslationKey }> = [
  { title: 'help.goal.title', body: 'help.goal.body' },
  { title: 'help.build.title', body: 'help.build.body' },
  { title: 'help.energy.title', body: 'help.energy.body' },
  { title: 'help.grid.title', body: 'help.grid.body' },
  { title: 'help.water.title', body: 'help.water.body' },
  { title: 'help.terrain.title', body: 'help.terrain.body' },
  { title: 'help.nature.title', body: 'help.nature.body' },
  { title: 'help.seasons.title', body: 'help.seasons.body' },
  { title: 'help.disasters.title', body: 'help.disasters.body' },
  { title: 'help.ev.title', body: 'help.ev.body' },
  { title: 'help.traffic.title', body: 'help.traffic.body' },
  { title: 'help.deliveries.title', body: 'help.deliveries.body' },
  { title: 'help.transit.title', body: 'help.transit.body' },
  { title: 'help.services.title', body: 'help.services.body' },
  { title: 'help.icons.title', body: 'help.icons.body' },
  { title: 'help.controls.title', body: 'help.controls.body' },
];

export function HelpPage({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Modal title={t('help.title')} onClose={onClose} testId="help-page">
      {SECTIONS.map((section) => (
        <section key={section.title}>
          <h3>{t(section.title)}</h3>
          <p>{t(section.body)}</p>
        </section>
      ))}
    </Modal>
  );
}
