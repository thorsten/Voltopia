/**
 * Top-right HUD plate: clock, weather, simulation speed and the way out
 * to a new city. Docked into the top-right corner, opposite the vitals.
 */
import { BALANCE } from '../shared/constants.ts';
import { effectiveWind } from '../sim/weather.ts';
import type { GlobalStats, SeasonId, Speed, TideState } from '../shared/types.ts';
import { Clock } from './Clock.tsx';
import { useI18n, type TranslationKey } from './i18n.tsx';
import { SpeedControls } from './SpeedControls.tsx';

const SEASON_GLYPH: Record<SeasonId, string> = {
  spring: '🌸',
  summer: '☀️',
  autumn: '🍂',
  winter: '❄️',
};

/** Slack water reads as high/low; otherwise it's simply on its way there. */
function tideStateKey(tide: TideState): TranslationKey {
  if (tide.factor < 0.05) return tide.level > 0 ? 'tide.high' : 'tide.low';
  return tide.rising ? 'tide.rising' : 'tide.falling';
}

export function TimeControls({
  stats,
  onSetSpeed,
  onNewGame,
}: {
  stats: GlobalStats;
  onSetSpeed: (speed: Speed) => void;
  onNewGame: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="hud-plate hud-controls hud-row" data-testid="hud-controls">
      <Clock timeOfDay={stats.timeOfDay} day={stats.day} />
      <div className="hud-weather" data-testid="weather" title={t('hud.weather.title')}>
        <span data-testid="season">
          {SEASON_GLYPH[stats.season.season]}{' '}
          {t('hud.season', {
            season: t(`season.${stats.season.season}` as TranslationKey),
            day: stats.season.dayOfSeason,
            days: BALANCE.seasons.daysPerSeason,
            temperature: Math.round(stats.season.temperature),
          })}
        </span>
        <span>☁️ {Math.round(stats.weather.cloudCover * 100)}%</span>
        {/* Gust-inclusive: turbines cut out on effectiveWind(), so the bare
            windSpeed would under-report during a storm while the fleet
            correctly stops — reading as a bug. */}
        <span>💨 {Math.round(effectiveWind(stats.weather) * 100)}%</span>
      </div>
      <div
        className="hud-stat"
        data-testid="tide"
        title={t('hud.tide.title', {
          state: t(tideStateKey(stats.tide)),
          percent: Math.round(stats.tide.factor * 100),
        })}
      >
        <span className="hud-stat-value">🌊 {t(tideStateKey(stats.tide))}</span>
        <span className="hud-stat-label">{t('hud.tide')}</span>
      </div>
      <SpeedControls speed={stats.speed as Speed} onChange={onSetSpeed} />
      <button type="button" className="new-game-button" data-testid="new-game" onClick={onNewGame}>
        {t('newCity.label')}
      </button>
    </div>
  );
}
