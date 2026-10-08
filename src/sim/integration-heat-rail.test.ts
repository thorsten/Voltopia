import { describe, expect, it } from 'vitest';
import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { HEATED_SERVED, PlantType, Terrain, Zone } from '../shared/types.ts';
import { placePlant } from './energy.ts';
import { buildPowerLines } from './powerLines.ts';
import { buildRail } from './rail.ts';
import { buildRoads } from './roads.ts';
import { createSimState, deserializeState, serializeState } from './state.ts';
import { ticksAtHour } from './vehicles.ts';
import { buildStats, stepTick } from './tick.ts';

const SIZE = 32;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);

/** Split from integration.test.ts: each file stays far below vitest's 60 s worker RPC timeout on CI. */
describe('district heating in the tick loop', () => {
  it('heats a served building through stepTick and reports it in the stats', () => {
    const size = 32;
    const at = (x: number, y: number) => tileIndex(x, y, size);
    const state = createSimState(7, size);
    state.money = 1e9;
    buildRoads(
      state,
      Array.from({ length: 10 }, (_, i) => at(3 + i, 10)),
    );
    placePlant(state, at(2, 10), PlantType.HeatPlant);
    placePlant(state, at(2, 12), PlantType.WindTurbine);
    placePlant(state, at(2, 14), PlantType.HeatStore);
    state.layers.zone[at(4, 9)] = Zone.Residential;
    state.layers.density[at(4, 9)] = 2;
    // Winter: SEASON_ORDER is spring, summer, autumn, winter, so a year
    // that started three seasons ago puts day 0 on the first winter day.
    state.seasonOriginDay = -BALANCE.seasons.daysPerSeason * 3;
    for (let i = 0; i < 20; i++) stepTick(state);
    expect(state.season.season).toBe('winter');
    expect(state.layers.heated[at(4, 9)]).toBe(HEATED_SERVED);
    const stats = buildStats(state);
    expect(stats.energy.networkHeat).toBeGreaterThan(0);
    expect(stats.energy.consumption.heatPumps).toBeGreaterThan(0);
    expect(stats.energy.heatCapacity).toBe(BALANCE.heat.storeCapacity);
    expect(stats.energy.heatCop).toBeLessThan(BALANCE.heat.copWarm);
  });
});

describe('railways in the tick loop', () => {
  it('carries commuters between two districts, draws traction and supplies a depot by rail', () => {
    const state = createSimState(3, SIZE);
    state.layers.elevation.fill(0);
    state.layers.terrain.fill(Terrain.Land);
    state.money = 1e9;
    // Track along y = 10, a road along y = 8 (the railTown layout).
    buildRail(
      state,
      Array.from({ length: 27 }, (_, i) => at(i + 2, 10)),
    );
    buildRoads(
      state,
      Array.from({ length: 27 }, (_, i) => at(i + 2, 8)),
    );
    // Houses in the west district, workplaces in the east one.
    for (let x = 3; x <= 8; x++) {
      state.layers.zone[at(x, 7)] = Zone.Residential;
      state.layers.density[at(x, 7)] = 3;
    }
    for (let x = 23; x <= 28; x++) {
      state.layers.zone[at(x, 7)] = Zone.Commercial;
      state.layers.density[at(x, 7)] = 3;
    }
    state.layers.zone[at(18, 13)] = Zone.Industrial;
    state.layers.density[at(18, 13)] = 1;
    // Grid: a trunk up to the road and along it, a branch along y = 12.
    buildPowerLines(state, [
      at(8, 12),
      at(8, 11),
      at(8, 10),
      at(8, 9),
      ...Array.from({ length: 27 }, (_, i) => at(i + 2, 8)),
      ...Array.from({ length: 19 }, (_, i) => at(i + 9, 12)),
      at(4, 12),
      at(5, 12),
      at(6, 12),
    ]);
    placePlant(state, at(7, 12), PlantType.SolarFarm);
    placePlant(state, at(10, 13), PlantType.WindTurbine);
    placePlant(state, at(12, 13), PlantType.WindTurbine);
    placePlant(state, at(14, 13), PlantType.BiogasPlant);
    placePlant(state, at(20, 13), PlantType.Battery);
    placePlant(state, at(4, 11), PlantType.RailYard);
    placePlant(state, at(5, 9), PlantType.TrainStation);
    placePlant(state, at(25, 9), PlantType.TrainStation);
    placePlant(state, at(16, 11), PlantType.FreightTerminal);
    placePlant(state, at(26, 11), PlantType.FreightTerminal);
    buildRoads(state, [at(27, 14)]);
    placePlant(state, at(27, 13), PlantType.LogisticsDepot);

    state.tick = ticksAtHour(BALANCE.rail.windowStartHour);
    let maxTraction = 0;
    let maxRailRiders = 0;
    for (let i = 0; i < TICKS_PER_DAY; i++) {
      stepTick(state);
      maxTraction = Math.max(maxTraction, state.lastEnergy.tractionConsumption);
      maxRailRiders = Math.max(maxRailRiders, state.lastTransit.railRiders);
    }
    expect(maxRailRiders).toBeGreaterThan(0);
    expect(state.lastTransit.railRiders).toBeGreaterThan(0);
    expect(maxTraction).toBeGreaterThan(0);
    expect(state.lastDeliveries.depotsRailSupplied).toBe(1);
    expect(state.lastRail.stationsServed).toBe(2);

    const restored = deserializeState(serializeState(state));
    expect(restored.trains).toHaveLength(state.trains.length);
    expect(restored.trains.length).toBeGreaterThan(0);
    for (let i = 0; i < 40; i++) stepTick(restored);
    expect(restored.trains).toHaveLength(state.trains.length);
  });
});
