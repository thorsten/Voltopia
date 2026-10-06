import { describe, expect, it } from 'vitest';
import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { MAX_RAIL_AGE, PlantType, SupplyStatus, Terrain, Zone } from '../shared/types.ts';
import { placePlant } from './energy.ts';
import { islandOf } from './powerGrid.ts';
import { buildPowerLines } from './powerLines.ts';
import { buildRail, isStationServed, railStats } from './rail.ts';
import { buildRoads, bulldozeTiles } from './roads.ts';
import { ticksAtHour } from './vehicles.ts';
import {
  advanceTrain,
  planFreightTour,
  planPassengerTour,
  runningTrains,
  syncTrainFleet,
  tractionDemandByIsland,
  trailingPoint,
  trainsStep,
  yardDeficitShare,
} from './trains.ts';
import { createSimState, TrainKind, TrainPhase, type SimState, type Train } from './state.ts';

const SIZE = 32;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);

/**
 * A rail town: track along y = 10 from x = 2..28, a road along y = 8,
 * a yard at (4, 11) on a powered island (solar farm + line beside it),
 * stations at (10, 9) and (24, 9), a terminal at (16, 11) with a factory
 * at (18, 13) and a terminal at (26, 11) with a depot at (27, 13).
 */
function railTown(seed = 1): SimState {
  const state = createSimState(seed, SIZE);
  state.layers.elevation.fill(0);
  state.layers.terrain.fill(Terrain.Land);
  state.money = 1e9;
  buildRail(
    state,
    Array.from({ length: 27 }, (_, i) => at(i + 2, 10)),
  );
  buildRoads(
    state,
    Array.from({ length: 27 }, (_, i) => at(i + 2, 8)),
  );
  buildPowerLines(state, [at(4, 12), at(5, 12), at(6, 12)]);
  placePlant(state, at(7, 12), PlantType.SolarFarm);
  placePlant(state, at(4, 11), PlantType.RailYard);
  placePlant(state, at(10, 9), PlantType.TrainStation);
  placePlant(state, at(24, 9), PlantType.TrainStation);
  placePlant(state, at(16, 11), PlantType.FreightTerminal);
  state.layers.zone[at(18, 13)] = Zone.Industrial;
  state.layers.density[at(18, 13)] = 1;
  state.layers.supplied[at(18, 13)] = SupplyStatus.Supplied;
  placePlant(state, at(26, 11), PlantType.FreightTerminal);
  buildRoads(state, [at(27, 14)]);
  placePlant(state, at(27, 13), PlantType.LogisticsDepot);
  return state;
}

function setHour(state: SimState, hour: number): void {
  state.tick = Math.floor(state.tick / TICKS_PER_DAY) * TICKS_PER_DAY + ticksAtHour(hour);
}

function runTicks(state: SimState, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    trainsStep(state);
    state.tick++;
  }
}

describe('syncTrainFleet', () => {
  it('gives a powered yard its passenger and freight trains parked on its track', () => {
    const state = railTown();
    syncTrainFleet(state);
    const c = BALANCE.rail;
    expect(state.trains).toHaveLength(c.passengerTrainsPerYard + c.freightTrainsPerYard);
    expect(state.trains.filter((t) => t.kind === TrainKind.Freight)).toHaveLength(
      c.freightTrainsPerYard,
    );
    expect(state.trains.every((t) => t.yard === at(4, 11) && t.yardTrack === at(4, 10))).toBe(true);
    expect(state.trains.every((t) => t.phase === TrainPhase.Parked)).toBe(true);
    const ids = new Set(state.trains.map((t) => t.id));
    expect(ids.size).toBe(state.trains.length);
  });

  it('drops the trains of a bulldozed yard and spawns none for a yard off the grid', () => {
    const state = railTown();
    syncTrainFleet(state);
    bulldozeTiles(state, [at(4, 11)]);
    syncTrainFleet(state);
    expect(state.trains).toHaveLength(0);
    placePlant(state, at(20, 11), PlantType.RailYard); // no line, no plant nearby
    syncTrainFleet(state);
    expect(state.trains).toHaveLength(0);
  });
});

describe('advanceTrain', () => {
  it('moves along the path at the rail speed, turns the heading and arrives', () => {
    const state = railTown();
    syncTrainFleet(state);
    const train = state.trains[0];
    train.path = [at(4, 10), at(5, 10), at(6, 10)];
    train.pathIndex = 1;
    const step = 0.5;
    expect(advanceTrain(state, train, step)).toBe('moving');
    expect(train.x).toBeCloseTo(5.0);
    expect(train.angle).toBeCloseTo(0);
    expect(advanceTrain(state, train, step)).toBe('moving');
    expect(advanceTrain(state, train, step)).toBe('moving');
    expect(advanceTrain(state, train, step)).toBe('arrived');
    expect(train.x).toBeCloseTo(6.5);
    expect(train.path).toEqual([]);
  });

  it('is lost when the next track tile vanished', () => {
    const state = railTown();
    syncTrainFleet(state);
    const train = state.trains[0];
    train.path = [at(4, 10), at(5, 10)];
    train.pathIndex = 1;
    bulldozeTiles(state, [at(5, 10)]);
    expect(advanceTrain(state, train, 0.5)).toBe('lost');
  });
});

describe('tour planning', () => {
  it('a passenger tour visits the due stations of the network oldest-first and returns to the yard', () => {
    const state = railTown();
    syncTrainFleet(state);
    const train = state.trains.find((t) => t.kind === TrainKind.Passenger)!;
    // Both past half of stationDueTicks() (336 → 168), so both qualify.
    state.layers.stationAge[at(10, 9)] = 400;
    state.layers.stationAge[at(24, 9)] = 500;
    const tour = planPassengerTour(state, train, new Set());
    // Oldest first picks both; nearest-neighbour from the yard orders them west to east.
    expect(tour).toEqual([at(10, 10), at(24, 10), at(4, 10)]);
  });

  it('skips claimed and not-yet-due stations and stations of another network', () => {
    const state = railTown();
    syncTrainFleet(state);
    const train = state.trains.find((t) => t.kind === TrainKind.Passenger)!;
    state.layers.stationAge[at(10, 9)] = 0; // fresh: not due
    expect(planPassengerTour(state, train, new Set())).toEqual([at(24, 10), at(4, 10)]);
    expect(planPassengerTour(state, train, new Set([at(24, 10)]))).toEqual([]);
    // Cut the track: the eastern station is on another network now.
    state.layers.stationAge[at(10, 9)] = MAX_RAIL_AGE;
    bulldozeTiles(state, [at(15, 10)]);
    expect(planPassengerTour(state, train, new Set())).toEqual([at(10, 10), at(4, 10)]);
  });

  it('a freight tour starts at a loading terminal, unloads at the due terminal and returns', () => {
    const state = railTown();
    syncTrainFleet(state);
    const train = state.trains.find((t) => t.kind === TrainKind.Freight)!;
    const tour = planFreightTour(state, train, new Set());
    expect(tour).toEqual([at(16, 10), at(26, 10), at(4, 10)]);
    // Without a loading terminal there is no tour.
    state.layers.supplied[at(18, 13)] = SupplyStatus.Undersupplied;
    expect(planFreightTour(state, train, new Set())).toEqual([]);
    // Without a due unloading terminal there is no tour either.
    state.layers.supplied[at(18, 13)] = SupplyStatus.Supplied;
    state.layers.terminalAge[at(26, 11)] = 0;
    expect(planFreightTour(state, train, new Set())).toEqual([]);
  });
});

describe('trainsStep', () => {
  it('runs tours inside the window, serves stations and supplies the depot', () => {
    const state = railTown();
    setHour(state, BALANCE.rail.windowStartHour);
    // Both stations and the depot are served well inside this run (around
    // tick 13-70), but the single due tour per vehicle parks everything by
    // tick ~115 and the fleet then sits idle until stations are due again
    // around tick ~181 (dueAfterDays/2 after being served) — neither the
    // brief's (3 * TICKS_PER_DAY) / 24 (120 ticks) nor its 160-tick fallback
    // land outside that idle gap. 90 ticks keeps both trains mid-tour while
    // everything downstream is already served.
    runTicks(state, 90);
    expect(runningTrains(state).length).toBeGreaterThan(0);
    expect(isStationServed(state, at(10, 9))).toBe(true);
    expect(isStationServed(state, at(24, 9))).toBe(true);
    expect(state.layers.railGoodsAge[at(27, 13)]).toBeLessThan(MAX_RAIL_AGE);
    expect(state.layers.railStation[at(10, 8)]).toBe(at(10, 9));
    const stats = railStats(state);
    expect(stats.stations).toBe(2);
    expect(stats.stationsServed).toBe(2);
    expect(stats.terminalsLoading).toBe(1);
    expect(stats.terminalsUnloading).toBe(1);
    expect(stats.yards).toBe(1);
    expect(stats.networks).toBe(1);
  });

  it('dispatches nothing outside the operating window', () => {
    const state = railTown();
    setHour(state, BALANCE.rail.windowEndHour);
    state.layers.stationAge.fill(MAX_RAIL_AGE);
    runTicks(state, 40);
    expect(runningTrains(state)).toHaveLength(0);
  });

  it('a lost train is re-parked at the yard and the tour dropped', () => {
    const state = railTown();
    setHour(state, BALANCE.rail.windowStartHour);
    runTicks(state, 12);
    const train = runningTrains(state)[0];
    expect(train).toBeDefined();
    bulldozeTiles(state, [train.path[train.pathIndex]]);
    runTicks(state, 1);
    expect(train.phase).toBe(TrainPhase.Parked);
    expect(train.stops).toEqual([]);
    expect(train.x).toBeCloseTo(4.5);
  });

  it('is deterministic for the same seed and script', () => {
    const a = railTown(5);
    const b = railTown(5);
    setHour(a, 6);
    setHour(b, 6);
    runTicks(a, 300);
    runTicks(b, 300);
    expect(a.trains.map((t) => [t.x, t.y, t.phase, t.stops])).toEqual(
      b.trains.map((t) => [t.x, t.y, t.phase, t.stops]),
    );
  });
});

describe('traction and stalling', () => {
  it('books the traction load of running, unstalled trains on the yard island', () => {
    const state = railTown();
    setHour(state, BALANCE.rail.windowStartHour);
    runTicks(state, 12);
    const running = runningTrains(state);
    expect(running.length).toBeGreaterThan(0);
    const demand = tractionDemandByIsland(state);
    const island = islandOf(state, at(4, 11));
    expect(island).toBeGreaterThan(0);
    const expected = running.reduce(
      (sum, t) =>
        sum +
        (t.kind === TrainKind.Freight
          ? BALANCE.rail.tractionLoadFreight
          : BALANCE.rail.tractionLoadPassenger),
      0,
    );
    expect(demand[island]).toBeCloseTo(expected);
    expect(demand[0]).toBe(0);
    // Dwelling and parked trains draw nothing.
    for (const t of state.trains) t.phase = TrainPhase.Dwelling;
    expect(tractionDemandByIsland(state)[island]).toBe(0);
  });

  it('a full deficit on the yard island stalls every train; no deficit stalls none', () => {
    const state = railTown();
    setHour(state, BALANCE.rail.windowStartHour);
    runTicks(state, 12);
    const island = islandOf(state, at(4, 11));
    const key = state.islandKeys[island];
    const before = runningTrains(state).map((t) => t.x);
    state.lastIslands = [
      {
        number: island,
        key,
        tiles: 0,
        buildings: 0,
        substations: 0,
        generation: 0,
        consumption: 100,
        stored: 0,
        capacity: 0,
        deficit: 100,
        curtailment: 0,
        gridImport: 0,
        gridExport: 0,
        importCost: 0,
      },
    ];
    expect(yardDeficitShare(state).get(at(4, 11))).toBe(1);
    runTicks(state, 5);
    expect(runningTrains(state).every((t) => t.stalled)).toBe(true);
    expect(runningTrains(state).map((t) => t.x)).toEqual(before);
    state.lastIslands = [];
    runTicks(state, 1);
    expect(runningTrains(state).some((t) => t.stalled)).toBe(false);
  });

  it('a yard that lost its grid tie parks its trains stalled', () => {
    const state = railTown();
    syncTrainFleet(state);
    // The yard at (4, 11) is within lineSupplyRadius (3) of the solar farm
    // at (7, 12) itself (chebyshev distance 3), so bulldozing only the
    // connecting line tiles leaves it energised straight off the plant —
    // the plant has to go too to cut the tie.
    bulldozeTiles(state, [at(4, 12), at(5, 12), at(6, 12), at(7, 12)]);
    setHour(state, BALANCE.rail.windowStartHour);
    runTicks(state, 20);
    expect(runningTrains(state)).toHaveLength(0);
    expect(state.trains.every((t) => t.stalled)).toBe(true);
  });
});

describe('trailingPoint', () => {
  it('places the wagon one tile behind along the path and at the head when just departed', () => {
    const state = railTown();
    syncTrainFleet(state);
    const train: Train = {
      ...state.trains[0],
      path: [at(4, 10), at(5, 10), at(6, 10)],
      pathIndex: 2,
    };
    train.x = 6.0;
    train.y = 10.5;
    const wagon = trailingPoint(state, train, 1);
    expect(wagon.x).toBeCloseTo(5.0);
    expect(wagon.y).toBeCloseTo(10.5);
    const fresh: Train = { ...train, pathIndex: 1, x: 4.6 };
    expect(trailingPoint(state, fresh, 1).x).toBeCloseTo(4.5);
  });
});
