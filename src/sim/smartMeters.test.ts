import { describe, expect, it } from 'vitest';
import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { buildRoads, bulldozeTiles } from './roads.ts';
import {
  countBuildings,
  meteredCoverage,
  setSmartMeterRollout,
  smartMetersStep,
} from './smartMeters.ts';
import { createSimState, deserializeState, serializeState, Zone, type SimState } from './state.ts';

const SIZE = 16;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);

/** A town with `n` houses along a road and a full treasury. */
function town(n: number, money = 1e9): SimState {
  const state = createSimState(5, SIZE);
  state.money = money;
  buildRoads(
    state,
    Array.from({ length: n }, (_, i) => at(i, 5)),
  );
  for (let i = 0; i < n; i++) {
    state.layers.zone[at(i, 6)] = Zone.Residential;
    state.layers.density[at(i, 6)] = 1;
  }
  return state;
}

describe('smart-meter rollout', () => {
  it('counts buildings and reports zero coverage before any meter', () => {
    const state = town(10);
    expect(countBuildings(state)).toBe(10);
    expect(meteredCoverage(state)).toBe(0);
    expect(meteredCoverage(createSimState(1, SIZE))).toBe(0);
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
    // Not `/ 40`: at SIZE 16, town(40)'s road row (y=5) and building row
    // (y=6) alias once x wraps past the grid width (tileIndex has no
    // bounds check), so 24 of the 40 "building" tiles are paved over as
    // road and excluded by countBuildings's tileType check — only 16
    // remain actual buildings. Divide by the real count rather than the
    // nominal `n`.
    expect(meteredCoverage(state)).toBeCloseTo(installsPerDay / countBuildings(state), 9);
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
    bulldozeTiles(state, [at(0, 6), at(1, 6)]);
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

  it('does not stockpile installs while broke', () => {
    const state = town(40, 0);
    setSmartMeterRollout(state, true);
    for (let t = 0; t < 3 * TICKS_PER_DAY; t++) smartMetersStep(state);
    state.money = 1e9;
    smartMetersStep(state);
    expect(state.smartMeters.metered).toBeLessThanOrEqual(1);
  });
});
