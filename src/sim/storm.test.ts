import { describe, expect, it } from 'vitest';
import { BALANCE } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { DisasterKind, PlantType, type DisasterEvent } from '../shared/types.ts';
import { placePlant } from './energy.ts';
import { recomputeGrid } from './powerGrid.ts';
import { buildPowerLines } from './powerLines.ts';
import { createSimState, type SimState } from './state.ts';
import { stormGust, stormSpec, strikesThisTick } from './storm.ts';
import { effectiveWind, windFactor } from './weather.ts';

const SIZE = 24;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);

/**
 * Blow a storm for `ticks` ticks. The tick has to advance: the strike
 * count is a possibly-fractional rate accumulated from
 * `state.tick - event.startTick`, so re-applying the same tick is a storm
 * standing still.
 */
function blow(state: SimState, event: DisasterEvent, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    stormSpec.apply(state, event);
    state.tick++;
  }
}

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
    // A storm only rolls above BALANCE.disasters.storm.windThreshold, so
    // that is the wind the gust adds to — testing it at half wind would
    // measure a weather situation no storm ever blows in.
    state.weather.windSpeed = BALANCE.disasters.storm.windThreshold + 0.05;
    state.disasters.active.push(storm(state, 1));
    state.weather.gust = stormGust(state);
    expect(effectiveWind(state.weather)).toBeGreaterThanOrEqual(BALANCE.energy.windCutOutSpeed);
    expect(windFactor(effectiveWind(state.weather))).toBe(0);
  });

  it('only runs the fleet flat out at the mildest severity', () => {
    // The other half of the gust's job, and the reason it is not larger:
    // a moderate storm must leave the turbines turning, or storage alone
    // would have to carry every storm and stormProof would be unwinnable.
    const state = createSimState(1, SIZE);
    placePlant(state, at(5, 5), PlantType.WindTurbine);
    state.weather.windSpeed = BALANCE.disasters.storm.windThreshold + 0.05;
    state.disasters.active.push(storm(state, BALANCE.disasters.storm.severityRange[0]));
    state.weather.gust = stormGust(state);
    expect(effectiveWind(state.weather)).toBeLessThan(BALANCE.energy.windCutOutSpeed);
    expect(windFactor(effectiveWind(state.weather))).toBeGreaterThan(0.9);
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
    blow(state, event, stormSpec.durationTicks);

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
    blow(state, event, stormSpec.durationTicks);
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

  it('strikes fewer tiles at low severity than at high', () => {
    // The property the old `max(1, round(hitsPerTick * severity))` could
    // not have: with a rate at or below one per tick it floored at one
    // strike every tick, so every storm damaged exactly `durationTicks`
    // tiles whatever its severity — severity changed only how deep the
    // damage went, never how much of the city it touched.
    const struck = (severity: number): number => {
      const state = createSimState(11, SIZE);
      placePlant(state, at(2, 2), PlantType.WindTurbine);
      for (let y = 4; y < 20; y++) {
        for (let x = 2; x < 20; x++) {
          state.layers.zone[at(x, y)] = 1;
          state.layers.density[at(x, y)] = 2;
        }
      }
      const event = storm(state, severity);
      blow(state, event, stormSpec.durationTicks);
      return event.tiles.length;
    };
    const mild = struck(BALANCE.disasters.storm.severityRange[0]);
    const severe = struck(1);
    expect(mild).toBeGreaterThan(0);
    expect(severe).toBeGreaterThan(mild);
  });

  it('spends a sub-one strike rate over several ticks instead of rounding up', () => {
    const state = createSimState(12, SIZE);
    placePlant(state, at(2, 2), PlantType.WindTurbine);
    const event = { ...storm(state, 1), startTick: 100 };
    const rate = BALANCE.disasters.storm.hitsPerTick * event.severity;
    // The regression this guards only exists for a rate under one strike
    // per tick — which is the whole point of the number being fractional.
    expect(rate).toBeLessThan(1);

    const window = 20;
    const spent: number[] = [];
    for (let elapsed = 0; elapsed < window; elapsed++) {
      state.tick = event.startTick + elapsed;
      spent.push(strikesThisTick(state, event));
    }
    // Some ticks strike nothing (the floor used to forbid that)...
    expect(spent).toContain(0);
    // ...and no tick strikes more than the rate can pay for...
    for (const hits of spent) expect(hits).toBeLessThanOrEqual(Math.ceil(rate));
    // ...while the total is exactly the rate, with nothing invented or lost.
    expect(spent.reduce((sum, value) => sum + value, 0)).toBe(Math.floor(rate * window));
  });

  it('strikes nothing before it has started', () => {
    const state = createSimState(13, SIZE);
    placePlant(state, at(2, 2), PlantType.WindTurbine);
    const event = { ...storm(state, 1), startTick: state.tick + 50 };
    expect(strikesThisTick(state, event)).toBe(0);
  });
});
