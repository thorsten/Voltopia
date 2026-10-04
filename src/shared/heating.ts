import { BALANCE } from './constants.ts';

/**
 * Degree curves shared by the sim (heating/cooling load) and the
 * renderer (chimney smoke strength), so a house stops smoking at exactly
 * the temperature where its heating load reaches zero.
 */

/** 0..1 heating demand share: 0 at comfort temperature, 1 heatingRange below it. */
export function heatingDegree(temperature: number): number {
  const { comfortTemperature, heatingRange } = BALANCE.seasons.heating;
  return Math.min(1, Math.max(0, (comfortTemperature - temperature) / heatingRange));
}

/** 0..1 cooling demand share: 0 at comfort temperature, 1 coolingRange above it. */
export function coolingDegree(temperature: number): number {
  const { comfortTemperature, coolingRange } = BALANCE.seasons.cooling;
  return Math.min(1, Math.max(0, (temperature - comfortTemperature) / coolingRange));
}
