import { describe, expect, it } from 'vitest';
import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import { spotPriceFactor } from './market.ts';
import { createSimState, type SimState } from './state.ts';
import { SUNRISE, SUNSET } from './weather.ts';

function makeState(): SimState {
  const state = createSimState(1, 16);
  state.season = { ...state.season, sunrise: SUNRISE, sunset: SUNSET, solarStrength: 1 };
  return state;
}

/** Set the in-game clock to an hour of day 0. */
function setHour(state: SimState, hour: number): void {
  state.tick = Math.round((hour / 24) * TICKS_PER_DAY);
}

describe('spotPriceFactor', () => {
  it('is expensive in a calm, overcast evening (regional scarcity)', () => {
    const state = makeState();
    setHour(state, 19);
    state.weather.cloudCover = 1;
    state.weather.windSpeed = 0;
    expect(spotPriceFactor(state)).toBeGreaterThan(1.5);
  });

  it('is cheap around a clear, windy noon (regional abundance)', () => {
    const state = makeState();
    setHour(state, 12);
    state.weather.cloudCover = 0;
    // Below the cut-out speed: the turbines still run flat out.
    state.weather.windSpeed = 0.9;
    expect(spotPriceFactor(state)).toBeLessThan(0.6);
  });

  it('a calm overcast noon costs more than a windy one', () => {
    const state = makeState();
    setHour(state, 12);
    state.weather.cloudCover = 1;
    state.weather.windSpeed = 0;
    const scarce = spotPriceFactor(state);
    state.weather.windSpeed = 0.9; // below the cut-out: full wind output
    expect(spotPriceFactor(state)).toBeLessThan(scarce);
  });

  it('stays inside the configured clamp for every hour and weather corner', () => {
    const state = makeState();
    for (let hour = 0; hour < 24; hour++) {
      for (const cloud of [0, 1]) {
        for (const wind of [0, 1]) {
          setHour(state, hour);
          state.weather.cloudCover = cloud;
          state.weather.windSpeed = wind;
          const f = spotPriceFactor(state);
          expect(f).toBeGreaterThanOrEqual(BALANCE.market.spotMin);
          expect(f).toBeLessThanOrEqual(BALANCE.market.spotMax);
        }
      }
    }
  });
});
