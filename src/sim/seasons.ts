import { BALANCE } from '../shared/constants.ts';
import { sunIntensity } from '../shared/daylight.ts';
import { SEASON_ORDER, type SeasonState } from '../shared/types.ts';

const TWO_PI = 2 * Math.PI;
const HOURS_PER_DAY = 24;

export interface SeasonInput {
  /** Day number since founding (floor(tick / TICKS_PER_DAY)). */
  day: number;
  /** 0..1 within the day. */
  timeOfDay: number;
  /** Day number on which year 1 started (0 for new games). */
  seasonOriginDay: number;
  /** Current cloud cover 0..1 (cools the daytime). */
  cloudCover: number;
}

export function daysPerYear(): number {
  return BALANCE.seasons.daysPerSeason * SEASON_ORDER.length;
}

/** 0..1 through the year, continuous within the day, 0 = first spring day. */
export function yearPhase(day: number, timeOfDay: number, seasonOriginDay: number): number {
  const total = daysPerYear();
  const elapsed = day - seasonOriginDay + timeOfDay;
  return (((elapsed % total) + total) % total) / total;
}

/** Seasonal cosine: 1 at `peakPhase`, -1 half a year later. */
function yearWave(phase: number, peakPhase: number): number {
  return Math.cos(TWO_PI * (phase - peakPhase));
}

/**
 * The seasonal signal for one tick. Deterministic in its inputs: the
 * only variance comes from the cloud cover the weather walk provides.
 */
export function seasonState(input: SeasonInput): SeasonState {
  const cfg = BALANCE.seasons;
  const total = daysPerYear();
  const phase = yearPhase(input.day, input.timeOfDay, input.seasonOriginDay);
  const elapsedDays = Math.max(0, input.day - input.seasonOriginDay);
  const dayOfYear = elapsedDays % total;
  // Deliberately derived from the whole day, not from floor(phase * 4):
  // that keeps dayOfSeason integral and the season boundary exact.
  const seasonIndex = Math.floor(dayOfYear / cfg.daysPerSeason);

  // Day length swings around 12 h, symmetric around noon.
  const { shortest, longest } = cfg.dayLengthHours;
  const meanHours = (shortest + longest) / 2;
  const swingHours = (longest - shortest) / 2;
  const halfDay =
    (meanHours + swingHours * yearWave(phase, cfg.longestDayPhase)) / HOURS_PER_DAY / 2;
  const sunrise = 0.5 - halfDay;
  const sunset = 0.5 + halfDay;

  const solarStrength =
    cfg.winterSolarStrength +
    ((1 - cfg.winterSolarStrength) * (1 + yearWave(phase, cfg.longestDayPhase))) / 2;

  const seasonalMean =
    (cfg.winterLow + cfg.summerHigh) / 2 +
    ((cfg.summerHigh - cfg.winterLow) / 2) * yearWave(phase, cfg.warmestPhase);
  const diurnal = -cfg.diurnalAmplitude * Math.cos(TWO_PI * (input.timeOfDay - cfg.coldestTime));
  const damping =
    cfg.cloudDamping * input.cloudCover * sunIntensity(input.timeOfDay, sunrise, sunset);
  const temperature = seasonalMean + diurnal - damping;

  // Most cloud and wind half a year after the longest day (winter).
  const winterness = -yearWave(phase, cfg.longestDayPhase);

  return {
    phase,
    season: SEASON_ORDER[seasonIndex],
    dayOfSeason: (dayOfYear % cfg.daysPerSeason) + 1,
    year: Math.floor(elapsedDays / total) + 1,
    temperature,
    sunrise,
    sunset,
    solarStrength,
    cloudBias: cfg.cloudBiasAmplitude * winterness,
    windBias: cfg.windBiasAmplitude * winterness,
  };
}
