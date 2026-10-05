import type { DemandStats } from '../shared/types.ts';
import { useI18n } from './i18n.tsx';

const BARS: Array<{ key: keyof DemandStats; label: string; className: string }> = [
  { key: 'residential', label: 'R', className: 'demand-residential' },
  { key: 'commercial', label: 'C', className: 'demand-commercial' },
  { key: 'retail', label: 'S', className: 'demand-retail' },
  { key: 'industrial', label: 'I', className: 'demand-industrial' },
];

/** Compact R/C/S/I demand indicator (S = shopping/retail, I = industry). */
export function DemandBars({ demand }: { demand: DemandStats }) {
  const { t } = useI18n();
  return (
    <div className="demand-bars" title={t('hud.demand.title')}>
      {BARS.map(({ key, label, className }) => {
        const value = demand[key];
        const height = Math.round(Math.abs(value) * 100);
        return (
          <div key={key} className="demand-bar-track" data-testid={`demand-${key}`}>
            <div
              className={`demand-bar-fill ${className} ${value < 0 ? 'negative' : ''}`}
              style={{ height: `${height}%` }}
            />
            <span className="demand-bar-label">{label}</span>
          </div>
        );
      })}
    </div>
  );
}
