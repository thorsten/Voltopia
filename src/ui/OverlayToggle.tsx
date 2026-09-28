import { OverlayMode } from '../shared/types.ts';
import { useI18n, type TranslationKey } from './i18n.tsx';

const MODES: Array<{
  mode: OverlayMode;
  id: string;
  label: TranslationKey;
  title: TranslationKey;
}> = [
  { mode: OverlayMode.None, id: 'off', label: 'overlay.off', title: 'overlay.off.title' },
  {
    mode: OverlayMode.Supply,
    id: 'supply',
    label: 'overlay.supply',
    title: 'overlay.supply.title',
  },
  {
    mode: OverlayMode.Demand,
    id: 'demand',
    label: 'overlay.demand',
    title: 'overlay.demand.title',
  },
  {
    mode: OverlayMode.Services,
    id: 'services',
    label: 'overlay.services',
    title: 'overlay.services.title',
  },
  {
    mode: OverlayMode.Traffic,
    id: 'traffic',
    label: 'overlay.traffic',
    title: 'overlay.traffic.title',
  },
  {
    mode: OverlayMode.Deliveries,
    id: 'deliveries',
    label: 'overlay.deliveries',
    title: 'overlay.deliveries.title',
  },
  {
    mode: OverlayMode.Transit,
    id: 'transit',
    label: 'overlay.transit',
    title: 'overlay.transit.title',
  },
  {
    mode: OverlayMode.Damage,
    id: 'damage',
    label: 'overlay.damage',
    title: 'overlay.damage.title',
  },
];

export function OverlayToggle({
  mode,
  onChange,
}: {
  mode: OverlayMode;
  onChange: (mode: OverlayMode) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="overlay-toggle" data-testid="overlay-toggle">
      <span className="overlay-toggle-label">{t('overlay.label')}</span>
      {MODES.map((entry) => (
        <button
          key={entry.mode}
          type="button"
          title={t(entry.title)}
          className={mode === entry.mode ? 'active' : ''}
          data-testid={`overlay-${entry.id}`}
          onClick={() => onChange(entry.mode)}
        >
          {t(entry.label)}
        </button>
      ))}
    </div>
  );
}
