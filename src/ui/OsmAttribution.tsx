import { useI18n } from './i18n.tsx';

export const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright';

/**
 * The ODbL attribution an imported city carries in the HUD footer. A
 * plain `_blank` anchor like the imprint's links: in the native app the
 * opener plugin hands those to the system browser.
 */
export function OsmAttribution() {
  const { t } = useI18n();
  return (
    <a
      className="osm-attribution"
      data-testid="osm-attribution"
      href={OSM_COPYRIGHT_URL}
      target="_blank"
      rel="noreferrer"
    >
      {t('hud.osmAttribution')}
    </a>
  );
}
