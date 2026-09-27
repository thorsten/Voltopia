import { describe, expect, it } from 'vitest';
import { nightFactor } from '../shared/daylight.ts';
import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import { createSimState } from './state.ts';
import {
  frontMeans,
  nextWaterStep,
  riverFlowFactor,
  solarFactor,
  sunIntensity,
  SUNRISE,
  SUNSET,
  updateWeather,
  windFactor,
} from './weather.ts';

describe('sunIntensity', () => {
  it('is zero at night and before sunrise', () => {
    expect(sunIntensity(0)).toBe(0);
    expect(sunIntensity(SUNRISE)).toBe(0);
    expect(sunIntensity(0.9)).toBe(0);
  });

  it('peaks at noon', () => {
    expect(sunIntensity(0.5)).toBeCloseTo(1, 5);
    expect(sunIntensity(0.35)).toBeGreaterThan(0);
    expect(sunIntensity(0.35)).toBeLessThan(1);
  });

  it('is symmetric around noon', () => {
    expect(sunIntensity(0.35)).toBeCloseTo(sunIntensity(0.65), 5);
  });

  it('is zero at sunset', () => {
    expect(sunIntensity(SUNSET)).toBeCloseTo(0, 5);
  });

  it('night factor is 1 at midnight and 0 at noon', () => {
    expect(nightFactor(0)).toBe(1);
    expect(nightFactor(0.5)).toBe(0);
    expect(nightFactor(0.27)).toBeGreaterThan(0);
    expect(nightFactor(0.27)).toBeLessThan(1);
  });

  it('accepts a seasonal sunrise and sunset', () => {
    expect(sunIntensity(0.22, 0.2, 0.8)).toBeGreaterThan(0);
    expect(sunIntensity(0.22, 0.25, 0.75)).toBe(0);
    expect(sunIntensity(0.5, 0.3, 0.7)).toBeCloseTo(1, 5);
    expect(sunIntensity(0.72, 0.3, 0.7)).toBe(0);
    expect(nightFactor(0.22, 0.2, 0.8)).toBeLessThan(1);
    expect(nightFactor(0.22, 0.3, 0.7)).toBe(1);
  });
});

describe('solarFactor', () => {
  it('full sun with clear sky gives full output', () => {
    expect(solarFactor(0.5, 0)).toBeCloseTo(1, 5);
  });

  it('overcast sky strongly reduces output but keeps diffuse share', () => {
    const overcast = solarFactor(0.5, 1);
    expect(overcast).toBeGreaterThan(0);
    expect(overcast).toBeLessThan(0.2);
  });

  it('no output at night regardless of clouds', () => {
    expect(solarFactor(0, 0)).toBe(0);
  });
});

describe('windFactor', () => {
  it('is zero below the cut-in speed', () => {
    expect(windFactor(0)).toBe(0);
    expect(windFactor(0.05)).toBe(0);
  });

  it('rises with the cube of wind speed and caps at 1', () => {
    expect(windFactor(0.3)).toBeGreaterThan(0);
    expect(windFactor(0.3)).toBeLessThan(windFactor(0.5));
    // 1 is now above the cut-out speed and legitimately reads 0 (see the
    // "zero at and above the cut-out speed" case in storm.test.ts) — 0.7
    // is comfortably below the cut-out and still shows the cap.
    expect(windFactor(0.7)).toBe(1);
  });
});

describe('frontMeans (multi-day pressure systems)', () => {
  it('stays within sane bounds', () => {
    for (let day = 0; day < 40; day++) {
      const { cloudMean, windMean } = frontMeans(123, day * TICKS_PER_DAY);
      expect(cloudMean).toBeGreaterThanOrEqual(0.05);
      expect(cloudMean).toBeLessThanOrEqual(0.95);
      expect(windMean).toBeGreaterThanOrEqual(0.05);
      expect(windMean).toBeLessThanOrEqual(0.95);
    }
  });

  it('produces both sunny spells and overcast fronts over weeks', () => {
    let minCloud = 1;
    let maxCloud = 0;
    let minWind = 1;
    let maxWind = 0;
    for (let t = 0; t < 30 * TICKS_PER_DAY; t += 60) {
      const { cloudMean, windMean } = frontMeans(77, t);
      minCloud = Math.min(minCloud, cloudMean);
      maxCloud = Math.max(maxCloud, cloudMean);
      minWind = Math.min(minWind, windMean);
      maxWind = Math.max(maxWind, windMean);
    }
    expect(maxCloud - minCloud).toBeGreaterThan(0.4);
    expect(maxWind - minWind).toBeGreaterThan(0.4);
  });

  it('changes slowly within a single day', () => {
    const a = frontMeans(9, 0);
    const b = frontMeans(9, TICKS_PER_DAY / 4);
    expect(Math.abs(a.cloudMean - b.cloudMean)).toBeLessThan(0.3);
  });

  it('is deterministic and seed-dependent', () => {
    expect(frontMeans(5, 1000)).toEqual(frontMeans(5, 1000));
    const a = frontMeans(5, 1000);
    const b = frontMeans(6, 1000);
    expect(a.cloudMean === b.cloudMean && a.windMean === b.windMean).toBe(false);
  });

  it('the weather walk follows the fronts', () => {
    const state = createSimState(31, 8);
    let error = 0;
    let samples = 0;
    for (let t = 0; t < 10 * TICKS_PER_DAY; t++) {
      state.tick = t;
      updateWeather(state);
      if (t % 200 === 0) {
        const { cloudMean } = frontMeans(state.seed, t);
        error += Math.abs(state.weather.cloudCover - cloudMean);
        samples++;
      }
    }
    // On average the walk stays reasonably close to the front mean.
    expect(error / samples).toBeLessThan(0.25);
  });
});

describe('updateWeather', () => {
  it('keeps values within 0..1 over a long run', () => {
    const state = createSimState(99, 8);
    for (let i = 0; i < 20_000; i++) {
      updateWeather(state);
      expect(state.weather.cloudCover).toBeGreaterThanOrEqual(0);
      expect(state.weather.cloudCover).toBeLessThanOrEqual(1);
      expect(state.weather.windSpeed).toBeGreaterThanOrEqual(0);
      expect(state.weather.windSpeed).toBeLessThanOrEqual(1);
    }
  });

  it('changes smoothly from tick to tick', () => {
    const state = createSimState(7, 8);
    for (let i = 0; i < 5_000; i++) {
      const before = { ...state.weather };
      updateWeather(state);
      expect(Math.abs(state.weather.cloudCover - before.cloudCover)).toBeLessThan(0.05);
      expect(Math.abs(state.weather.windSpeed - before.windSpeed)).toBeLessThan(0.05);
    }
  });

  it('actually varies over time', () => {
    const state = createSimState(3, 8);
    const values = new Set<number>();
    for (let i = 0; i < 2_000; i++) {
      updateWeather(state);
      values.add(Math.round(state.weather.cloudCover * 20));
    }
    expect(values.size).toBeGreaterThan(3);
  });

  it('is deterministic for the same seed', () => {
    const a = createSimState(5, 8);
    const b = createSimState(5, 8);
    for (let i = 0; i < 1_000; i++) {
      updateWeather(a);
      updateWeather(b);
    }
    expect(a.weather).toEqual(b.weather);
  });
});

describe('river flow', () => {
  function stateWithClouds(cloudCover: number) {
    const state = createSimState(5, 8);
    state.weather.cloudCover = cloudCover;
    return state;
  }

  it('rises under heavy cloud and is capped at 1', () => {
    const state = stateWithClouds(1);
    const start = state.weather.riverFlow;
    for (let i = 0; i < 100; i++) {
      state.tick++;
      updateWeather(state);
      // Pin the clouds: updateWeather drifts them, this test wants rain.
      state.weather.cloudCover = 1;
    }
    expect(state.weather.riverFlow).toBeGreaterThan(start);
    for (let i = 0; i < 20_000; i++) {
      updateWeather(state);
      state.weather.cloudCover = 1;
    }
    expect(state.weather.riverFlow).toBe(1);
  });

  it('decays toward the dry baseline in clear weather', () => {
    const state = stateWithClouds(0);
    state.weather.riverFlow = 1;
    for (let i = 0; i < 10_000; i++) {
      updateWeather(state);
      state.weather.cloudCover = 0;
    }
    expect(state.weather.riverFlow).toBeCloseTo(BALANCE.water.dryBaselineFlow, 2);
    expect(state.weather.riverFlow).toBeGreaterThanOrEqual(BALANCE.water.dryBaselineFlow);
  });

  it('maps flow to an output factor with a floor', () => {
    const state = stateWithClouds(0);
    state.weather.riverFlow = 0;
    expect(riverFlowFactor(state)).toBeCloseTo(BALANCE.water.minFlowFactor, 6);
    state.weather.riverFlow = 1;
    expect(riverFlowFactor(state)).toBeCloseTo(1, 6);
  });

  it('is deterministic', () => {
    const a = createSimState(9, 8);
    const b = createSimState(9, 8);
    for (let i = 0; i < 500; i++) {
      a.tick++;
      b.tick++;
      updateWeather(a);
      updateWeather(b);
    }
    expect(a.weather.riverFlow).toBe(b.weather.riverFlow);
  });
});

describe('seasonal fronts and solar strength', () => {
  it('shifts the front means by the season biases', () => {
    const base = frontMeans(5, 1000);
    const winter = frontMeans(5, 1000, { cloudBias: 0.1, windBias: 0.1 });
    expect(winter.cloudMean).toBeCloseTo(Math.min(0.95, base.cloudMean + 0.1), 9);
    expect(winter.windMean).toBeCloseTo(Math.min(0.95, base.windMean + 0.1), 9);
  });

  it('scales solar output by strength and the seasonal day window', () => {
    const summer = { sunrise: 0.2, sunset: 0.8, solarStrength: 1 };
    const winter = { sunrise: 0.3, sunset: 0.7, solarStrength: 0.45 };
    expect(solarFactor(0.5, 0, summer)).toBeCloseTo(1, 5);
    expect(solarFactor(0.5, 0, winter)).toBeCloseTo(0.45, 5);
    expect(solarFactor(0.28, 0, summer)).toBeGreaterThan(0);
    expect(solarFactor(0.28, 0, winter)).toBe(0);
  });

  it('the weather walk uses the state season', () => {
    const state = createSimState(31, 8);
    state.season = { ...state.season, cloudBias: 0.3, windBias: 0 };
    let sumBiased = 0;
    for (let t = 0; t < 3 * TICKS_PER_DAY; t++) {
      state.tick = t;
      updateWeather(state);
      sumBiased += state.weather.cloudCover;
    }
    const plain = createSimState(31, 8);
    plain.season = { ...plain.season, cloudBias: 0, windBias: 0 };
    let sumPlain = 0;
    for (let t = 0; t < 3 * TICKS_PER_DAY; t++) {
      plain.tick = t;
      updateWeather(plain);
      sumPlain += plain.weather.cloudCover;
    }
    expect(sumBiased).toBeGreaterThan(sumPlain);
  });
});

describe('snowpack', () => {
  const { rainCloudThreshold, dryBaselineFlow } = BALANCE.water;
  const { snowTemperature, meltTemperature } = BALANCE.seasons;

  it('sub-zero precipitation grows the snowpack and leaves the river on the dry path', () => {
    const start = { flow: 0.5, snowpack: 0 };
    const next = nextWaterStep(start.flow, start.snowpack, 1, snowTemperature - 5);
    expect(next.snowpack).toBeGreaterThan(0);
    expect(next.flow).toBeLessThan(0.5);
    expect(next.flow).toBeGreaterThan(dryBaselineFlow);
  });

  it('rain above freezing feeds the river, not the snowpack', () => {
    const next = nextWaterStep(0.5, 0, 1, meltTemperature + 5);
    expect(next.snowpack).toBe(0);
    expect(next.flow).toBeGreaterThan(0.5);
  });

  it('warm weather melts the snowpack into the river', () => {
    const next = nextWaterStep(dryBaselineFlow, 0.5, 0, meltTemperature + 10);
    expect(next.snowpack).toBeLessThan(0.5);
    expect(next.flow).toBeGreaterThan(dryBaselineFlow);
    expect(next.snowpack + (next.flow - dryBaselineFlow)).toBeGreaterThan(0.49);
  });

  it('never melts more than there is and caps the snowpack at 1', () => {
    expect(nextWaterStep(0.3, 0.00001, 0, 40).snowpack).toBe(0);
    let snow = 0.999;
    for (let i = 0; i < 100; i++) snow = nextWaterStep(0.3, snow, 1, snowTemperature - 1).snowpack;
    expect(snow).toBe(1);
  });

  it('does not melt at or below the melt temperature without precipitation', () => {
    const cold = nextWaterStep(0.3, 0.5, rainCloudThreshold - 0.1, meltTemperature);
    expect(cold.snowpack).toBe(0.5);
  });

  it('is applied by updateWeather from the state season', () => {
    const state = createSimState(9, 8);
    state.season = { ...state.season, temperature: -5 };
    for (let i = 0; i < 200; i++) {
      state.tick++;
      updateWeather(state);
      state.weather.cloudCover = 1;
    }
    expect(state.weather.snowpack).toBeGreaterThan(0);
  });
});
