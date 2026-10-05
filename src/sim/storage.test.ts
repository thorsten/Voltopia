import { describe, expect, it } from 'vitest';
import { BALANCE } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { PlantType } from '../shared/types.ts';
import { addDamage } from './disasters.ts';
import { placePlant } from './energy.ts';
import { createSimState, type SimState } from './state.ts';
import { buildStats, stepTick } from './tick.ts';
import {
  chargeTiles,
  dischargeTiles,
  poolOf,
  scaleTiles,
  storageCapacityAt,
  storageTilesOfKind,
  storedByKind,
} from './storage.ts';

const SIZE = 16;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);

function withBatteries(): SimState {
  const state = createSimState(1, SIZE);
  state.money = 1e9;
  placePlant(state, at(2, 2), PlantType.Battery);
  placePlant(state, at(6, 2), PlantType.Battery);
  return state;
}

describe('storage per tile', () => {
  it('capacity comes from the plant on the tile and is 0 for damaged or other tiles', () => {
    const state = withBatteries();
    expect(storageCapacityAt(state, at(2, 2))).toBe(BALANCE.energy.batteryCapacity);
    expect(storageCapacityAt(state, at(3, 3))).toBe(0);
    placePlant(state, at(10, 2), PlantType.SolarFarm);
    expect(storageCapacityAt(state, at(10, 2))).toBe(0);
    addDamage(state, at(2, 2), 10);
    expect(storageCapacityAt(state, at(2, 2))).toBe(0);
  });

  it('charges in proportion to headroom and never past capacity', () => {
    const state = withBatteries();
    const tiles = storageTilesOfKind(state, PlantType.Battery);
    state.layers.stored[at(2, 2)] = 1_000; // headroom 2_000 vs 3_000
    chargeTiles(state, tiles, 500);
    expect(state.layers.stored[at(2, 2)]).toBeCloseTo(1_000 + 200, 3);
    expect(state.layers.stored[at(6, 2)]).toBeCloseTo(300, 3);
    chargeTiles(state, tiles, 1e9);
    expect(poolOf(state, tiles).stored).toBeCloseTo(2 * BALANCE.energy.batteryCapacity, 3);
  });

  it('discharges in proportion to stored energy and never below zero', () => {
    const state = withBatteries();
    const tiles = storageTilesOfKind(state, PlantType.Battery);
    state.layers.stored[at(2, 2)] = 900;
    state.layers.stored[at(6, 2)] = 300;
    dischargeTiles(state, tiles, 400);
    expect(state.layers.stored[at(2, 2)]).toBeCloseTo(600, 3);
    expect(state.layers.stored[at(6, 2)]).toBeCloseTo(200, 3);
    dischargeTiles(state, tiles, 1e9);
    expect(poolOf(state, tiles).stored).toBe(0);
  });

  it('pool and storedByKind sum the tiles; scaleTiles applies a standing loss', () => {
    const state = withBatteries();
    state.layers.stored[at(2, 2)] = 100;
    state.layers.stored[at(6, 2)] = 50;
    expect(storedByKind(state, PlantType.Battery)).toBeCloseTo(150, 6);
    scaleTiles(state, storageTilesOfKind(state, PlantType.Battery), 0.5);
    expect(storedByKind(state, PlantType.Battery)).toBeCloseTo(75, 6);
    expect(poolOf(state, []).capacity).toBe(0);
  });

  it("a damaged battery's frozen level is untouched by charge, discharge and scale", () => {
    const state = withBatteries();
    const damaged = at(2, 2);
    const intact = at(6, 2);
    state.layers.stored[damaged] = 500;
    state.layers.stored[intact] = 500;
    addDamage(state, damaged, 10);
    // Bypass storageTilesOfKind's own filter: the tiles list here still
    // includes the damaged tile, as a caller composing its own list might.
    const tiles = [damaged, intact];
    chargeTiles(state, tiles, 1_000);
    expect(state.layers.stored[damaged]).toBe(500);
    dischargeTiles(state, tiles, 1_000);
    expect(state.layers.stored[damaged]).toBe(500);
    scaleTiles(state, tiles, 0.5);
    expect(state.layers.stored[damaged]).toBe(500);
  });

  it('a heat store on no island does not count toward the city-wide SoC stats', () => {
    // Unlike the other storage kinds, a heat store cannot generate
    // electricity, so it never seeds a grid island on its own (see
    // SUPPLY_SOURCES in shared/plants.ts) — with no line and no building
    // in reach, it stays on island 0 even after the grid is computed.
    const state = createSimState(1, SIZE);
    state.money = 1e9;
    placePlant(state, at(2, 2), PlantType.HeatStore);
    state.layers.stored[at(2, 2)] = 50;
    stepTick(state);
    expect(state.layers.island[at(2, 2)]).toBe(0);
    const stats = buildStats(state);
    expect(stats.energy.heatStored).toBe(0);
    expect(stats.energy.heatCapacity).toBe(0);
  });
});
