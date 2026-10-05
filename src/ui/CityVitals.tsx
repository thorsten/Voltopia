/**
 * Top-left HUD plate: the city at a glance — funds, residents, jobs,
 * happiness and zone demand. Docked into the top-left corner like the
 * resource bar of an RTS, so it reads as part of the frame, not a card.
 */
import { BALANCE } from '../shared/constants.ts';
import type { GlobalStats } from '../shared/types.ts';
import { DemandBars } from './DemandBars.tsx';
import { useI18n, type TranslationKey } from './i18n.tsx';

const CURRENCY = '⌁';

function happinessEmoji(happiness: number): string {
  if (happiness >= 0.7) return '😊';
  if (happiness >= 0.45) return '😐';
  return '😞';
}

function trafficLabel(congestion: number): TranslationKey {
  if (congestion <= BALANCE.traffic.flowing) return 'traffic.flowing';
  if (congestion <= BALANCE.traffic.jammed) return 'traffic.slow';
  return 'traffic.jammed';
}

export function CityVitals({ stats }: { stats: GlobalStats }) {
  const { t } = useI18n();
  return (
    <div className="hud-plate hud-vitals hud-row" data-testid="hud-vitals">
      <div className="hud-title">Voltopia</div>
      <div className="hud-stat hud-stat-wide" data-testid="money">
        <span className="hud-stat-value">
          {Math.round(stats.money).toLocaleString('en-US')} {CURRENCY}
        </span>
        <span className="hud-stat-label">{t('hud.funds')}</span>
      </div>
      <div className="hud-stat" data-testid="population">
        <span className="hud-stat-value">{stats.population}</span>
        <span className="hud-stat-label">{t('hud.residents')}</span>
      </div>
      <div className="hud-stat" data-testid="jobs">
        <span className="hud-stat-value">{stats.jobs}</span>
        <span className="hud-stat-label">{t('hud.jobs')}</span>
      </div>
      <div className="hud-stat" data-testid="happiness">
        <span className="hud-stat-value">
          {happinessEmoji(stats.happiness)} {Math.round(stats.happiness * 100)}%
        </span>
        <span className="hud-stat-label">{t('hud.happiness')}</span>
      </div>
      <div
        className={`hud-stat ${stats.traffic.congestion > BALANCE.traffic.jammed ? 'negative' : ''}`}
        data-testid="traffic"
        title={t('hud.traffic.title', {
          label: t(trafficLabel(stats.traffic.congestion)),
          driving: stats.traffic.driving,
          avenues: Math.round(stats.traffic.avenueShare * 100),
        })}
      >
        <span className="hud-stat-value">🚗 {stats.traffic.congestion.toFixed(1)}×</span>
        <span className="hud-stat-label">{t('hud.traffic')}</span>
      </div>
      {stats.deliveries.shops > 0 && (
        <div
          className={`hud-stat ${
            stats.deliveries.suppliedShare < BALANCE.deliveries.goalSuppliedShare ? 'negative' : ''
          }`}
          data-testid="deliveries"
          title={t('hud.deliveries.title', {
            supplied: Math.round(stats.deliveries.suppliedShare * stats.deliveries.shops),
            shops: stats.deliveries.shops,
            vans: stats.deliveries.driving,
            factories: stats.deliveries.factories,
            local: Math.round(stats.deliveries.localShare * 100),
          })}
        >
          <span className="hud-stat-value">
            🚚 {Math.round(stats.deliveries.suppliedShare * 100)}%
          </span>
          <span className="hud-stat-label">{t('hud.deliveries')}</span>
        </div>
      )}
      {stats.transit.stops > 0 && (
        <div
          className="hud-stat"
          data-testid="transit"
          title={t('hud.transit.title', {
            riders: stats.transit.riders,
            buses: stats.transit.driving,
            served: stats.transit.stopsServed,
            stops: stats.transit.stops,
          })}
        >
          <span className="hud-stat-value">🚌 {Math.round(stats.transit.riderShare * 100)}%</span>
          <span className="hud-stat-label">{t('hud.transit')}</span>
        </div>
      )}
      {stats.forestShare > 0 && (
        <div
          className="hud-stat"
          data-testid="nature"
          title={t('hud.nature.title', { share: Math.round(stats.forestShare * 100) })}
        >
          <span className="hud-stat-value">🌲 {Math.round(stats.forestShare * 100)}%</span>
          <span className="hud-stat-label">{t('hud.nature')}</span>
        </div>
      )}
      <DemandBars demand={stats.demand} />
    </div>
  );
}
