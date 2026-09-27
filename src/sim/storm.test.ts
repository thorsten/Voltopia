import { describe, expect, it } from 'vitest';
import { BALANCE } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { DisasterKind, PlantType } from '../shared/types.ts';
import { placePlant } from './energy.ts';
import { recomputeGrid } from './powerGrid.ts';
import { buildPowerLines } from './powerLines.ts';
import { createSimState, type SimState } from './state.ts';
import { stormGust, stormSpec } from './storm.ts';
import { effectiveWind, windFactor } from './weather.ts';

const SIZE = 24;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);

function storm(state: SimState, severity = 1) {
  const plan = stormSpec.plan(state, severity);
  if (plan === null) throw new Error('the storm found no target');
  return {
    id: 1,
    kind: DisasterKind.Storm,
    severity,
    startTick: state.tick,
    endTick: state.tick + stormSpec.durationTicks,
    ...plan,
  };
}

describe('windFactor', () => {
  it('is zero below the cut-in speed', () => {
    expect(windFactor(BALANCE.energy.windCutInSpeed - 0.01)).toBe(0);
  });

  it('is zero at and above the cut-out speed — the rotors feather', () => {
    expect(windFactor(BALANCE.energy.windCutOutSpeed)).toBe(0);
    expect(windFactor(1)).toBe(0);
  });

  it('peaks just below the cut-out speed', () => {
    expect(windFactor(BALANCE.energy.windCutOutSpeed - 0.01)).toBeGreaterThan(0.9);
  });
});

describe('the storm gust', () => {
  it('is zero without a storm', () => {
    expect(stormGust(createSimState(1, SIZE))).toBe(0);
  });

  it('drives the effective wind over the cut-out speed at full severity', () => {
    const state = createSimState(1, SIZE);
    placePlant(state, at(5, 5), PlantType.WindTurbine);
    state.weather.windSpeed = 0.5;
    state.disasters.active.push(storm(state, 1));
    state.weather.gust = stormGust(state);
    expect(effectiveWind(state.weather)).toBeGreaterThanOrEqual(BALANCE.energy.windCutOutSpeed);
    expect(windFactor(effectiveWind(state.weather))).toBe(0);
  });
});

describe('storm strikes', () => {
  it('damages pylons and can island a district', () => {
    const state = createSimState(3, SIZE);
    placePlant(state, at(2, 2), PlantType.WindTurbine);
    const line = [at(3, 2), at(4, 2), at(5, 2), at(6, 2), at(7, 2), at(8, 2)];
    buildPowerLines(state, line);
    recomputeGrid(state);
    expect(state.layers.energized[at(8, 2)]).toBe(1);

    const event = storm(state, 1);
    state.disasters.active.push(event);
    for (let i = 0; i < stormSpec.durationTicks; i++) stormSpec.apply(state, event);

    expect(event.tiles.length).toBeGreaterThan(0);
    const damagedLines = line.filter((index) => state.layers.damage[index] !== 0);
    expect(damagedLines.length).toBeGreaterThan(0);
    recomputeGrid(state);
    expect(state.layers.energized[at(8, 2)]).toBe(0);
  });

  it('never damages a road', () => {
    const state = createSimState(4, SIZE);
    placePlant(state, at(2, 2), PlantType.WindTurbine);
    for (let x = 3; x < 20; x++) state.layers.tileType[at(x, 10)] = 1; // TileType.Road
    const event = storm(state, 1);
    state.disasters.active.push(event);
    for (let i = 0; i < stormSpec.durationTicks; i++) stormSpec.apply(state, event);
    for (let x = 3; x < 20; x++) {
      if (state.layers.powerLine[at(x, 10)] !== 0) continue;
      expect(state.layers.damage[at(x, 10)]).toBe(0);
    }
  });

  it('runs its full duration', () => {
    const state = createSimState(5, SIZE);
    placePlant(state, at(2, 2), PlantType.WindTurbine);
    const event = storm(state, 1);
    expect(stormSpec.apply(state, event)).toBe(false);
  });

  it('finds no site in an empty city', () => {
    expect(stormSpec.plan(createSimState(1, SIZE), 1)).toBe(null);
  });
});
