import { describe, expect, it } from 'vitest';
import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { buildRoads, bulldozeTiles } from './roads.ts';
import {
  countBuildings,
  isSmartVehicle,
  meteredCoverage,
  refreshBuildingCount,
  setSmartMeterRollout,
  smartMetersStep,
} from './smartMeters.ts';
import { createSimState, deserializeState, serializeState, Zone, type SimState } from './state.ts';
import { stepTick } from './tick.ts';

// 32 (not 16) so town() can lay out enough bands for the isSmartVehicle
// coverage tests below (town(100) needs 8 bands, reaching y = 23).
const SIZE = 32;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);

/**
 * Houses per band in the layout `town()` lays out below: a band's road
 * and house rows run x = 1..HOUSES_PER_BAND, which fits inside the
 * grid's width with room to spare either side.
 */
const HOUSES_PER_BAND = 14;

/** Tile index of the i-th house `town()` lays down (0-based). */
function houseTile(i: number): number {
  const band = Math.floor(i / HOUSES_PER_BAND);
  const x = 1 + (i % HOUSES_PER_BAND);
  return at(x, 2 + 3 * band);
}

/**
 * A town with `n` houses along roads and a full treasury. Houses (and
 * the road serving them) are laid out in bands of up to
 * HOUSES_PER_BAND: band b uses road row y = 1 + 3b and house row
 * y = 2 + 3b, so bands never touch and — unlike a single row that
 * wraps past the grid width once n exceeds it — a road tile never
 * aliases a house tile. `money` is applied only after the fixture is
 * built, so the cost of laying the roads never eats into the money a
 * test asks for.
 */
function town(n: number, money = 1e9): SimState {
  const state = createSimState(5, SIZE);
  state.money = 1e9;
  let remaining = n;
  let band = 0;
  while (remaining > 0) {
    const count = Math.min(HOUSES_PER_BAND, remaining);
    const roadY = 1 + 3 * band;
    buildRoads(
      state,
      Array.from({ length: count }, (_, i) => at(1 + i, roadY)),
    );
    for (let i = 0; i < count; i++) {
      const tile = houseTile(band * HOUSES_PER_BAND + i);
      state.layers.zone[tile] = Zone.Residential;
      state.layers.density[tile] = 1;
    }
    remaining -= count;
    band++;
  }
  state.money = money;
  // The coverage denominator is a per-tick cache (see
  // refreshBuildingCount): a hand-built town never ticked, so refresh it
  // here, exactly as stepTick does for a running city.
  refreshBuildingCount(state);
  return state;
}

describe('smart-meter rollout', () => {
  it('counts buildings and reports zero coverage before any meter', () => {
    const state = town(10);
    expect(countBuildings(state)).toBe(10);
    expect(meteredCoverage(state)).toBe(0);
    expect(meteredCoverage(createSimState(1, SIZE))).toBe(0);
    // town()'s banded layout must not lose houses to road/house aliasing
    // even once n crosses a single band's width.
    expect(countBuildings(town(40))).toBe(40);
  });

  it('installs installsPerDay meters over one day while active, billing each', () => {
    const state = town(40);
    setSmartMeterRollout(state, true);
    const before = state.money;
    let spent = 0;
    for (let t = 0; t < TICKS_PER_DAY; t++) spent += smartMetersStep(state);
    const { installsPerDay, costPerMeter } = BALANCE.smartMeters;
    expect(state.smartMeters.metered).toBe(installsPerDay);
    expect(spent).toBe(installsPerDay * costPerMeter);
    expect(before - state.money).toBe(spent);
    expect(meteredCoverage(state)).toBeCloseTo(installsPerDay / 40, 9);
  });

  it('does nothing while paused and stops at full coverage', () => {
    const state = town(5);
    for (let t = 0; t < TICKS_PER_DAY; t++) smartMetersStep(state);
    expect(state.smartMeters.metered).toBe(0);
    setSmartMeterRollout(state, true);
    for (let t = 0; t < 3 * TICKS_PER_DAY; t++) smartMetersStep(state);
    expect(state.smartMeters.metered).toBe(5);
    expect(meteredCoverage(state)).toBe(1);
  });

  it('waits when the treasury cannot pay and never goes into debt', () => {
    const state = town(40, BALANCE.smartMeters.costPerMeter * 2 + 1);
    setSmartMeterRollout(state, true);
    for (let t = 0; t < TICKS_PER_DAY; t++) smartMetersStep(state);
    expect(state.smartMeters.metered).toBe(2);
    expect(state.money).toBeGreaterThanOrEqual(0);
    state.money = 1e9;
    for (let t = 0; t < TICKS_PER_DAY; t++) smartMetersStep(state);
    expect(state.smartMeters.metered).toBeGreaterThan(2);
  });

  it('loses meters with demolished buildings', () => {
    const state = town(5);
    state.smartMeters.metered = 5;
    bulldozeTiles(state, [houseTile(0), houseTile(1)]);
    smartMetersStep(state);
    expect(state.smartMeters.metered).toBe(3);
    expect(meteredCoverage(state)).toBe(1);
  });

  it('round-trips rollout state and the flexible backlog through a save', () => {
    const state = town(5);
    state.smartMeters = { active: true, metered: 3, installCarry: 0.4 };
    state.flexBacklog = 12.5;
    const restored = deserializeState(serializeState(state));
    expect(restored.smartMeters.active).toBe(true);
    expect(restored.smartMeters.metered).toBe(3);
    expect(restored.flexBacklog).toBe(12.5);
  });

  it('migrates a legacy save: smart charging on means every building metered', () => {
    const state = town(5);
    const save = serializeState(state);
    delete save.smartMeters;
    delete save.flexBacklog;
    const on = deserializeState({ ...save, smartCharging: true });
    expect(on.smartMeters.active).toBe(true);
    expect(on.smartMeters.metered).toBe(5);
    const off = deserializeState({ ...save, smartCharging: false });
    expect(off.smartMeters.active).toBe(false);
    expect(off.smartMeters.metered).toBe(0);
    expect(off.flexBacklog).toBe(0);
  });

  it('clamps a saved meter count to the current building count', () => {
    const state = town(5);
    const save = serializeState(state);
    const restored = deserializeState({ ...save, smartMeters: { active: false, metered: 99 } });
    expect(restored.smartMeters.metered).toBe(5);
  });

  it('clamps a non-finite or negative restored meter count and backlog to zero', () => {
    const state = town(5);
    const save = serializeState(state);
    const restored = deserializeState({
      ...save,
      smartMeters: { active: false, metered: -5 },
      flexBacklog: Number.NaN,
    });
    expect(restored.smartMeters.metered).toBe(0);
    expect(restored.flexBacklog).toBe(0);
  });

  it('keeps the pacing exact over several days', () => {
    const state = town(56);
    setSmartMeterRollout(state, true);
    const { installsPerDay } = BALANCE.smartMeters;
    for (let day = 1; day <= 3; day++) {
      for (let t = 0; t < TICKS_PER_DAY; t++) smartMetersStep(state);
      expect(state.smartMeters.metered).toBe(installsPerDay * day);
    }
  });

  it('refreshes the cached building count once per tick', () => {
    const state = town(10);
    state.smartMeters.metered = 10;
    expect(meteredCoverage(state)).toBe(1);
    // An eleventh building appears, as growth would place it. Coverage
    // still reads the cached denominator from the last refresh...
    const extra = houseTile(10);
    state.layers.zone[extra] = Zone.Residential;
    state.layers.density[extra] = 1;
    expect(state.lastBuildingCount).toBe(10);
    expect(meteredCoverage(state)).toBe(1);
    // ...until the next tick refreshes it.
    stepTick(state);
    expect(state.lastBuildingCount).toBe(countBuildings(state));
    expect(state.lastBuildingCount).toBe(11);
    expect(meteredCoverage(state)).toBeCloseTo(10 / 11, 9);
  });

  it('does not stockpile installs while broke', () => {
    const state = town(40, 0);
    setSmartMeterRollout(state, true);
    for (let t = 0; t < 3 * TICKS_PER_DAY; t++) smartMetersStep(state);
    state.money = 1e9;
    smartMetersStep(state);
    expect(state.smartMeters.metered).toBeLessThanOrEqual(1);
  });
});

describe('isSmartVehicle', () => {
  it('is false for everyone at zero coverage and true for everyone at full coverage', () => {
    const none = town(10);
    const full = town(10);
    full.smartMeters.metered = 10;
    for (let id = 0; id < 50; id++) {
      expect(isSmartVehicle(none, id)).toBe(false);
      expect(isSmartVehicle(full, id)).toBe(true);
    }
  });

  it('picks a stable set that only grows with coverage', () => {
    const state = town(100);
    state.smartMeters.metered = 50;
    const half = Array.from({ length: 200 }, (_, id) => isSmartVehicle(state, id));
    const count = half.filter(Boolean).length;
    expect(count).toBeGreaterThan(70);
    expect(count).toBeLessThan(130);
    expect(Array.from({ length: 200 }, (_, id) => isSmartVehicle(state, id))).toEqual(half);
    state.smartMeters.metered = 80;
    for (let id = 0; id < 200; id++) if (half[id]) expect(isSmartVehicle(state, id)).toBe(true);
  });
});
