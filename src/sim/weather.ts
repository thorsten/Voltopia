import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import type { Weather } from '../shared/types.ts';
import { timeOfDay } from './tick.ts';
import type { SimState } from './state.ts';

import { SUNRISE, SUNSET, sunIntensity } from '../shared/daylight.ts';

export { SUNRISE, SUNSET, sunIntensity };

export interface SolarSeason {
  sunrise: number;
  sunset: number;
  solarStrength: number;
}

const NO_SEASON: SolarSeason = { sunrise: SUNRISE, sunset: SUNSET, solarStrength: 1 };

/**
 * Photovoltaic output factor 0..1: sun position within the seasonal day
 * window, sun elevation (strength), attenuated by clouds. Overcast skies
 * still deliver some diffuse irradiance.
 */
export function solarFactor(
  time: number,
  cloudCover: number,
  season: SolarSeason = NO_SEASON,
): number {
  return (
    sunIntensity(time, season.sunrise, season.sunset) *
    season.solarStrength *
    (1 - 0.85 * cloudCover)
  );
}

/**
 * Wind speed the turbines actually see: the random walk plus the gust an
 * active storm adds, clamped to 1.
 */
export function effectiveWind(weather: Weather): number {
  return Math.min(1, weather.windSpeed + weather.gust);
}

/**
 * Wind turbine output factor 0..1. Below the cut-in speed the rotor
 * stands still; above it output rises with the cube of wind speed, as
 * with real turbines — until the cut-out speed, where the blades feather
 * and output drops to nothing. A storm is therefore not a windfall but a
 * blackout risk.
 */
export function windFactor(windSpeed: number): number {
  const { windCutInSpeed, windCutOutSpeed } = BALANCE.energy;
  if (windSpeed < windCutInSpeed) return 0;
  if (windSpeed >= windCutOutSpeed) return 0;
  return Math.min(1, windSpeed ** 3 / 0.6 ** 3);
}

export interface FrontBias {
  cloudBias: number;
  windBias: number;
}

const NO_BIAS: FrontBias = { cloudBias: 0, windBias: 0 };

/**
 * Multi-day pressure systems: slowly moving fronts shift the mean that
 * the short-term weather noise reverts to. Stateless in (seed, tick), so
 * save games reproduce the same fronts. When a high-cloud front meets a
 * low-wind front, the city faces a genuine Dunkelflaute. The season
 * shifts the base means (winter: more cloud and wind).
 */
export function frontMeans(
  seed: number,
  tick: number,
  bias: FrontBias = NO_BIAS,
): { cloudMean: number; windMean: number } {
  const { cloud, wind } = BALANCE.weather.fronts;
  return {
    cloudMean: frontValue(seed, tick, cloud, 0, bias.cloudBias),
    windMean: frontValue(seed, tick, wind, 1, bias.windBias),
  };
}

function frontValue(
  seed: number,
  tick: number,
  config: {
    periodsDays: readonly number[];
    amplitudes: readonly number[];
    base: number;
  },
  channel: number,
  bias: number,
): number {
  let value = config.base + bias;
  for (let i = 0; i < config.periodsDays.length; i++) {
    // Seed-derived phase per wave so every city gets its own fronts.
    const phase = (((seed >>> (channel * 8 + i * 4)) & 0xff) / 255) * 2 * Math.PI;
    const period = config.periodsDays[i] * TICKS_PER_DAY;
    value += config.amplitudes[i] * Math.sin((2 * Math.PI * tick) / period + phase);
  }
  return Math.min(0.95, Math.max(0.05, value));
}

/**
 * Advance cloud cover, wind speed, river flow and snowpack by one tick: a
 * seeded random walk with mean reversion toward the current (seasonally
 * biased) front means, so weather varies smoothly, reproducibly, and
 * with multi-day character.
 */
export function updateWeather(state: SimState): void {
  const { cloudDrift, windDrift } = BALANCE.weather;
  const { cloudMean, windMean } = frontMeans(state.seed, state.tick, state.season);
  const w = state.weather;
  w.cloudCover = drift(w.cloudCover, state.rng.next(), cloudDrift, cloudMean);
  w.windSpeed = drift(w.windSpeed, state.rng.next(), windDrift, windMean);
  const water = nextWaterStep(w.riverFlow, w.snowpack, w.cloudCover, state.season.temperature);
  w.riverFlow = water.flow;
  w.snowpack = water.snowpack;
}

function drift(value: number, random: number, step: number, mean: number): number {
  const reversion = (mean - value) * step * 2;
  const noise = (random - 0.5) * 2 * step * 8;
  return Math.min(1, Math.max(0, value + reversion + noise));
}

/**
 * River flow and snowpack for the next tick. Precipitation (cloud cover
 * above the rain threshold) feeds the river when it is warm enough and
 * the snowpack when it is freezing; warm weather melts the snowpack into
 * the river. Without precipitation the flow relaxes toward the dry
 * baseline, so run-of-river output follows multi-day weather and the
 * seasons (little in winter, a melt surge in spring).
 */
export function nextWaterStep(
  flow: number,
  snowpack: number,
  cloudCover: number,
  temperature: number,
): { flow: number; snowpack: number } {
  const { rainCloudThreshold, rainRate, dryRate, dryBaselineFlow } = BALANCE.water;
  const { snowTemperature, meltTemperature, meltRate } = BALANCE.seasons;
  const precipitation =
    cloudCover > rainCloudThreshold
      ? (rainRate * (cloudCover - rainCloudThreshold)) / (1 - rainCloudThreshold)
      : 0;
  const snowing = temperature < snowTemperature;
  const melt =
    temperature > meltTemperature
      ? Math.min(snowpack, meltRate * (temperature - meltTemperature))
      : 0;

  let nextSnow = snowpack - melt;
  let nextFlow = flow + melt;
  if (precipitation > 0 && snowing) {
    nextSnow += precipitation;
    nextFlow += (dryBaselineFlow - nextFlow) * dryRate;
  } else if (precipitation > 0) {
    nextFlow += precipitation;
  } else {
    nextFlow += (dryBaselineFlow - nextFlow) * dryRate;
  }
  return {
    flow: Math.min(1, Math.max(0, nextFlow)),
    snowpack: Math.min(1, Math.max(0, nextSnow)),
  };
}

/** Run-of-river output multiplier: a drought halves output, never stops it. */
export function riverFlowFactor(state: SimState): number {
  const { minFlowFactor } = BALANCE.water;
  return minFlowFactor + (1 - minFlowFactor) * state.weather.riverFlow;
}

/** Convenience: current solar factor of the simulation state. */
export function currentSolarFactor(state: SimState): number {
  return solarFactor(timeOfDay(state.tick), state.weather.cloudCover, state.season);
}

/** Convenience: current wind factor of the simulation state. */
export function currentWindFactor(state: SimState): number {
  return windFactor(effectiveWind(state.weather));
}
