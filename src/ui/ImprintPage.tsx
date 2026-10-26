import { Modal } from './Modal.tsx';
import { useI18n } from './i18n.tsx';
import { OSM_COPYRIGHT_URL } from './OsmAttribution.tsx';

/** Legal notice / Impressum contact details. */
const IMPRINT = {
  name: 'Thorsten Rinne',
  addressLines: ['Hermann-Hesse-Straße 16', '86830 Schwabmünchen', 'Deutschland'],
  email: 'thorsten@rinne.info',
  website: 'https://www.rinne.info',
};

export function ImprintPage({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Modal title={t('imprint.title')} onClose={onClose} testId="imprint-page">
      <section>
        <h3>{t('imprint.according')}</h3>
        <p>
          {IMPRINT.name}
          <br />
          {IMPRINT.addressLines.map((line) => (
            <span key={line}>
              {line}
              <br />
            </span>
          ))}
        </p>
      </section>
      <section>
        <h3>{t('imprint.contact')}</h3>
        <p>
          E-Mail: <a href={`mailto:${IMPRINT.email}`}>{IMPRINT.email}</a>
          <br />
          Web:{' '}
          <a href={IMPRINT.website} target="_blank" rel="noreferrer">
            {IMPRINT.website}
          </a>
        </p>
      </section>
      <section>
        <h3>{t('imprint.responsible')}</h3>
        <p>{IMPRINT.name}</p>
      </section>
      <section>
        <h3>{t('imprint.disclaimer.title')}</h3>
        <p>{t('imprint.disclaimer.body')}</p>
      </section>
      <section data-testid="imprint-osm">
        <h3>{t('imprint.osm.title')}</h3>
        <p>
          {t('imprint.osm.data')}{' '}
          <a href={OSM_COPYRIGHT_URL} target="_blank" rel="noreferrer">
            openstreetmap.org/copyright
          </a>
        </p>
        <p>{t('imprint.osm.requests')}</p>
      </section>
    </Modal>
  );
}
