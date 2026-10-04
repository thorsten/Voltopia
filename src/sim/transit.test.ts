import { describe, expect, it } from 'vitest';
import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { PlantType, StopState, Zone } from '../shared/types.ts';
import {
  ageStops,
  buildBusStops,
  busDepotInfo,
  busDepotTiles,
  claimedBusStops,
  countBusStops,
  drivingBuses,
  isBusStop,
  planBusTour,
  stopDueTicks,
  stopServiceTicks,
  stopState,
  syncBusFleet,
  transitStats,
  transitStep,
  updateCoverage,
} from './transit.ts';
import { placePlant } from './energy.ts';
import { buildPowerLines } from './powerLines.ts';
import { buildRoads, bulldozeTiles, undoLastAction } from './roads.ts';
import { refreshBuildingCount } from './smartMeters.ts';
import { chargingDemand, laneOccupancy, ticksAtHour, vehiclesStep } from './vehicles.ts';
import { BusPhase, createSimState, TileType, type SimState } from './state.ts';

export const SIZE = 24;
export const at = (x: number, y: number) => tileIndex(x, y, SIZE);

/** One street y=10 from x=2..20 on flat ground. */
export function street(seed = 1): SimState {
  const state = createSimState(seed, SIZE);
  state.layers.elevation.fill(0);
  buildRoads(
    state,
    Array.from({ length: 19 }, (_, i) => at(i + 2, 10)),
  );
  return state;
}

describe('buildBusStops', () => {
  it('marks stops on road tiles for the stop price and skips the rest', () => {
    const state = street();
    const before = state.money;
    expect(buildBusStops(state, [at(5, 10), at(6, 10), at(5, 11)])).toEqual({});
    expect(isBusStop(state, at(5, 10))).toBe(true);
    expect(isBusStop(state, at(6, 10))).toBe(true);
    expect(isBusStop(state, at(5, 11))).toBe(false);
    expect(state.layers.busStop[at(5, 11)]).toBe(0);
    expect(state.money).toBe(before - 2 * BALANCE.costs.busStop);
    expect(countBusStops(state)).toBe(2);
    expect(state.dirty.has(at(5, 10))).toBe(true);
  });

  it('countBusStops ignores a busStop flag left on a non-road tile', () => {
    const state = street();
    state.layers.busStop[at(2, 2)] = 1;
    expect(countBusStops(state)).toBe(0);
  });

  it('a fresh stop starts served (age 0)', () => {
    const state = street();
    state.layers.stopAge[at(5, 10)] = 400;
    buildBusStops(state, [at(5, 10)]);
    expect(state.layers.stopAge[at(5, 10)]).toBe(0);
  });

  it('retracing existing stops is silent, a drag off the road is rejected', () => {
    const state = street();
    buildBusStops(state, [at(5, 10)]);
    const before = state.money;
    expect(buildBusStops(state, [at(5, 10)])).toEqual({});
    expect(state.money).toBe(before);
    expect(buildBusStops(state, [at(5, 12)])).toEqual({ rejected: 'needsRoadTile' });
  });

  it('rejects the whole drag when funds are short', () => {
    const state = street();
    state.money = BALANCE.costs.busStop - 1;
    expect(buildBusStops(state, [at(5, 10)])).toEqual({ rejected: 'notEnoughMoney' });
    expect(isBusStop(state, at(5, 10))).toBe(false);
  });

  it('bulldozing removes the stop first and the road on a second pass', () => {
    const state = street();
    buildBusStops(state, [at(5, 10)]);
    bulldozeTiles(state, [at(5, 10)]);
    expect(isBusStop(state, at(5, 10))).toBe(false);
    expect(state.layers.tileType[at(5, 10)]).toBe(TileType.Road);
    bulldozeTiles(state, [at(5, 10)]);
    expect(state.layers.tileType[at(5, 10)]).toBe(TileType.Empty);
  });

  it('a line and a stop on one road tile both go on the first pass', () => {
    const state = street();
    buildBusStops(state, [at(5, 10)]);
    buildPowerLines(state, [at(5, 10)]);
    bulldozeTiles(state, [at(5, 10)]);
    expect(state.layers.busStop[at(5, 10)]).toBe(0);
    expect(state.layers.powerLine[at(5, 10)]).toBe(0);
    expect(state.layers.tileType[at(5, 10)]).toBe(TileType.Road);
  });

  it('undo restores a stop after a bulldoze and refunds a build', () => {
    const state = street();
    const before = state.money;
    buildBusStops(state, [at(5, 10)]);
    undoLastAction(state);
    expect(isBusStop(state, at(5, 10))).toBe(false);
    expect(state.money).toBe(before);
    buildBusStops(state, [at(5, 10)]);
    bulldozeTiles(state, [at(5, 10)]);
    undoLastAction(state);
    expect(isBusStop(state, at(5, 10))).toBe(true);
  });
});

/** The street plus a bus depot at (2,9) parking on (2,10) and `stops` stops from x=6 on. */
export function busTown(seed = 1, stops = 4): SimState {
  const state = street(seed);
  placePlant(state, at(2, 9), PlantType.BusDepot);
  buildBusStops(
    state,
    Array.from({ length: stops }, (_, i) => at(6 + i * 3, 10)),
  );
  return state;
}

describe('bus fleet', () => {
  it('a depot fields busesPerDepot buses parked on its road tile', () => {
    const state = busTown();
    syncBusFleet(state);
    expect(busDepotTiles(state)).toEqual([at(2, 9)]);
    expect(state.buses).toHaveLength(BALANCE.transit.busesPerDepot);
    for (const bus of state.buses) {
      expect(bus.depot).toBe(at(2, 9));
      expect(bus.depotRoad).toBe(at(2, 10));
      expect(bus.phase).toBe(BusPhase.AtDepot);
      expect([Math.floor(bus.x), Math.floor(bus.y)]).toEqual([2, 10]);
    }
    syncBusFleet(state);
    expect(state.buses).toHaveLength(BALANCE.transit.busesPerDepot);
  });

  it('a depot without road access fields no buses', () => {
    const state = createSimState(1, SIZE);
    state.layers.tileType[at(15, 2)] = TileType.Plant;
    state.layers.plantType[at(15, 2)] = PlantType.BusDepot;
    syncBusFleet(state);
    expect(state.buses).toHaveLength(0);
  });

  it('bulldozing the depot drops its buses', () => {
    const state = busTown();
    syncBusFleet(state);
    bulldozeTiles(state, [at(2, 9)]);
    syncBusFleet(state);
    expect(state.buses).toHaveLength(0);
  });

  it('buses get unique ids shared with the car counter', () => {
    const state = busTown();
    state.nextVehicleId = 20;
    syncBusFleet(state);
    expect(state.buses.map((b) => b.id)).toEqual([20, 21, 22]);
    expect(state.nextVehicleId).toBe(23);
  });
});

describe('ageStops / stopState', () => {
  it('counts ticks for stops only and saturates', () => {
    const state = busTown();
    for (let t = 0; t < 5; t++) ageStops(state);
    expect(state.layers.stopAge[at(6, 10)]).toBe(5);
    expect(state.layers.stopAge[at(7, 10)]).toBe(0); // road without a stop
    state.layers.stopAge[at(9, 10)] = 65535;
    ageStops(state);
    expect(state.layers.stopAge[at(9, 10)]).toBe(65535);
  });

  it('resets the age of a tile that lost its stop', () => {
    const state = busTown();
    state.layers.stopAge[at(6, 10)] = 40;
    state.layers.busStop[at(6, 10)] = 0;
    ageStops(state);
    expect(state.layers.stopAge[at(6, 10)]).toBe(0);
  });

  it('buckets served, due and unserved and marks the tile dirty on a change', () => {
    const state = busTown();
    expect(stopState(state, at(6, 10))).toBe(StopState.Served);
    expect(stopState(state, at(7, 10))).toBe(StopState.Served); // no stop
    state.layers.stopAge[at(6, 10)] = stopDueTicks();
    state.dirty.clear();
    ageStops(state);
    expect(stopState(state, at(6, 10))).toBe(StopState.Due);
    expect(state.dirty.has(at(6, 10))).toBe(true);
    state.layers.stopAge[at(6, 10)] = stopServiceTicks();
    state.dirty.clear();
    ageStops(state);
    expect(stopState(state, at(6, 10))).toBe(StopState.Unserved);
    expect(state.dirty.has(at(6, 10))).toBe(true);
    state.dirty.clear();
    ageStops(state);
    expect(state.dirty.has(at(6, 10))).toBe(false);
  });

  it('reports how many stops are at least half-way to due', () => {
    const state = busTown(1, 3);
    expect(ageStops(state)).toBe(0);
    state.layers.stopAge[at(6, 10)] = Math.floor(stopDueTicks() / 2);
    expect(ageStops(state)).toBe(1);
  });

  it('window sizes follow BALANCE', () => {
    expect(stopServiceTicks()).toBe(Math.round(BALANCE.transit.serviceWindowDays * TICKS_PER_DAY));
    expect(stopDueTicks()).toBe(Math.round(BALANCE.transit.dueAfterDays * TICKS_PER_DAY));
  });
});

describe('updateCoverage', () => {
  it('covers road tiles within stopRadius of a served stop only', () => {
    const state = busTown(1, 1); // one stop at (6,10)
    buildRoads(state, [at(6, 11), at(6, 12), at(6, 13), at(6, 14), at(6, 15)]);
    const r = BALANCE.transit.stopRadius;
    state.dirty.clear();
    updateCoverage(state);
    expect(state.layers.transitCover[at(6, 10)]).toBe(1);
    expect(state.layers.transitCover[at(6 + r, 10)]).toBe(1);
    expect(state.layers.transitCover[at(6 + r + 1, 10)]).toBe(0);
    expect(state.layers.transitCover[at(6, 10 + r)]).toBe(1);
    expect(state.layers.transitCover[at(6, 10 + r + 1)]).toBe(0);
    expect(state.layers.transitCover[at(6, 9)]).toBe(0); // not a road
    expect(state.dirty.has(at(6 + r, 10))).toBe(true);
    // No change on the second run: nothing is marked dirty.
    state.dirty.clear();
    updateCoverage(state);
    expect(state.dirty.size).toBe(0);
  });

  it('an unserved stop covers nothing and the loss is diffed', () => {
    const state = busTown(1, 1);
    updateCoverage(state);
    state.layers.stopAge[at(6, 10)] = stopServiceTicks() + 1;
    state.dirty.clear();
    updateCoverage(state);
    expect(state.layers.transitCover[at(6, 10)]).toBe(0);
    expect(state.dirty.has(at(6, 10))).toBe(true);
  });
});

describe('planBusTour', () => {
  it('returns nothing while no stop is at least half-way to due', () => {
    const state = busTown();
    syncBusFleet(state);
    expect(planBusTour(state, state.buses[0], new Set())).toEqual([]);
  });

  it('picks the oldest stops first, caps at stopsPerTour and ends at the depot road', () => {
    // busTown asks for stops at x = 6, 9, …, 27; the street ends at x = 20,
    // so buildBusStops silently keeps the five at x = 6, 9, 12, 15, 18.
    const state = busTown(1, 8);
    syncBusFleet(state);
    const onRoad = [6, 9, 12, 15, 18].map((x) => at(x, 10));
    onRoad.forEach((tile, i) => {
      state.layers.stopAge[tile] = stopDueTicks() + i * 10;
    });
    const tour = planBusTour(state, state.buses[0], new Set());
    const expectedStops = Math.min(BALANCE.transit.stopsPerTour, onRoad.length);
    expect(tour).toHaveLength(expectedStops + 1);
    expect(tour[tour.length - 1]).toBe(at(2, 10));
    const stops = tour.slice(0, -1);
    // Nearest-neighbour from the depot: ascending x along the street.
    expect(stops).toEqual([...stops].sort((a, b) => a - b));
  });

  it('leaves the youngest stops for later when there are more than stopsPerTour', () => {
    const state = street();
    placePlant(state, at(2, 9), PlantType.BusDepot);
    const tiles = Array.from({ length: BALANCE.transit.stopsPerTour + 2 }, (_, i) =>
      at(4 + i * 2, 10),
    );
    buildBusStops(state, tiles);
    syncBusFleet(state);
    tiles.forEach((tile, i) => {
      state.layers.stopAge[tile] = stopDueTicks() + i * 10;
    });
    const stops = planBusTour(state, state.buses[0], new Set()).slice(0, -1);
    expect(stops).toHaveLength(BALANCE.transit.stopsPerTour);
    expect(stops).not.toContain(tiles[0]);
    expect(stops).not.toContain(tiles[1]);
  });

  it('never picks a stop claimed by another bus', () => {
    const state = busTown(1, 2); // stops at (6,10) and (9,10)
    syncBusFleet(state);
    state.layers.stopAge[at(6, 10)] = stopDueTicks();
    state.layers.stopAge[at(9, 10)] = stopDueTicks();
    state.buses[1].stops = [at(6, 10), at(2, 10)];
    const claimed = claimedBusStops(state);
    expect(claimed.has(at(6, 10))).toBe(true);
    expect(claimed.has(at(2, 10))).toBe(false);
    expect(planBusTour(state, state.buses[0], claimed)).toEqual([at(9, 10), at(2, 10)]);
  });

  it('ignores stops beyond maxRouteTiles', () => {
    const BIG = 80;
    const big = (x: number, y: number) => tileIndex(x, y, BIG);
    const state = createSimState(1, BIG);
    state.layers.elevation.fill(0);
    buildRoads(
      state,
      Array.from({ length: 75 }, (_, i) => big(i + 2, 10)),
    );
    placePlant(state, big(2, 9), PlantType.BusDepot);
    const near = big(2 + BALANCE.transit.maxRouteTiles - 1, 10);
    const far = big(2 + BALANCE.transit.maxRouteTiles + 5, 10);
    buildBusStops(state, [near, far]);
    state.layers.stopAge[near] = stopDueTicks();
    state.layers.stopAge[far] = stopDueTicks();
    syncBusFleet(state);
    expect(planBusTour(state, state.buses[0], new Set())).toEqual([near, big(2, 10)]);
  });
});

function setHour(state: SimState, hour: number): void {
  state.tick =
    Math.floor(state.tick / TICKS_PER_DAY) * TICKS_PER_DAY +
    Math.round((hour / 24) * TICKS_PER_DAY);
}

/** Power the depot: a wind turbine's ring energises it. */
function powerDepot(state: SimState): void {
  placePlant(state, at(3, 9), PlantType.WindTurbine);
}

/** One tick of cars + buses exactly as tick.ts runs them. */
function stepAll(state: SimState): void {
  const occupancy = vehiclesStep(state);
  transitStep(state, occupancy);
  state.tick++;
}

describe('transitStep', () => {
  it('a bus tours due stops inside the window and resets their age', () => {
    const state = busTown(1, 3); // stops at x = 6, 9, 12
    powerDepot(state);
    setHour(state, 8);
    for (const x of [6, 9, 12]) state.layers.stopAge[at(x, 10)] = stopDueTicks();
    let halted = false;
    for (let t = 0; t < 400 && !halted; t++) {
      stepAll(state);
      halted = state.layers.stopAge[at(6, 10)] < 50;
    }
    expect(halted).toBe(true);
    expect(state.buses.some((b) => b.phase !== BusPhase.AtDepot)).toBe(true);
    for (let t = 0; t < 600; t++) stepAll(state);
    for (const x of [6, 9, 12]) expect(state.layers.stopAge[at(x, 10)]).toBeLessThan(700);
    // Outside the window every bus finishes its tour and stays at the depot.
    // Run until 40 ticks before the window reopens (tied to windowStartHour
    // rather than a magic tick count, so a balance retune can't silently
    // make this cross into the next window and flake).
    setHour(state, 23.5);
    const ticksUntilWindowReopens =
      Math.round(((24 - 23.5) / 24) * TICKS_PER_DAY) + ticksAtHour(BALANCE.transit.windowStartHour);
    for (let t = 0; t < ticksUntilWindowReopens - 40; t++) stepAll(state);
    expect(state.buses.every((b) => b.phase === BusPhase.AtDepot)).toBe(true);
  });

  it('driving buses stay on road tiles and are slower than cars', () => {
    const state = busTown(1, 3);
    powerDepot(state);
    setHour(state, 8);
    state.layers.stopAge[at(12, 10)] = stopDueTicks();
    let ticksDriving = 0;
    for (let t = 0; t < 200; t++) {
      stepAll(state);
      for (const bus of drivingBuses(state)) {
        expect(state.layers.tileType[tileIndex(Math.floor(bus.x), Math.floor(bus.y), SIZE)]).toBe(
          TileType.Road,
        );
      }
      if (state.buses[0].phase === BusPhase.Driving) ticksDriving++;
    }
    // 10 tiles out and 10 back at 0.8 × 1.6 tiles/s (4 ticks/s) ≈ 62 ticks, plus boarding.
    expect(ticksDriving).toBeGreaterThan(50);
  });

  it('no tour starts outside the window, without a due stop, or below minTripCharge', () => {
    const night = busTown(1, 3);
    powerDepot(night);
    setHour(night, 3);
    for (const x of [6, 9, 12]) night.layers.stopAge[at(x, 10)] = stopDueTicks();
    for (let t = 0; t < 60; t++) stepAll(night);
    expect(night.buses.every((b) => b.phase === BusPhase.AtDepot)).toBe(true);

    const idle = busTown(1, 3);
    powerDepot(idle);
    setHour(idle, 8);
    for (let t = 0; t < 100; t++) stepAll(idle);
    expect(idle.buses.every((b) => b.phase === BusPhase.AtDepot)).toBe(true);

    const flat = busTown(1, 3);
    setHour(flat, 3);
    stepAll(flat); // spawn without dispatching
    for (const bus of flat.buses) bus.charge = 0.1;
    setHour(flat, 8);
    for (const x of [6, 9, 12]) flat.layers.stopAge[at(x, 10)] = stopDueTicks();
    for (let t = 0; t < 60; t++) stepAll(flat);
    expect(flat.buses.every((b) => b.phase === BusPhase.AtDepot)).toBe(true);
  });

  it('buses charge only at a powered depot, and driving drains them', () => {
    const dark = busTown(1, 3);
    setHour(dark, 3);
    stepAll(dark);
    for (const bus of dark.buses) bus.charge = 0.5;
    for (let t = 0; t < 20; t++) stepAll(dark);
    expect(dark.buses[0].charge).toBe(0.5);
    expect(dark.buses[0].charging).toBe(false);

    const lit = busTown(1, 3);
    powerDepot(lit);
    setHour(lit, 3);
    stepAll(lit);
    for (const bus of lit.buses) bus.charge = 0.5;
    for (let t = 0; t < 20; t++) stepAll(lit);
    expect(lit.buses[0].charge).toBeCloseTo(0.5 + 20 * BALANCE.transit.chargeRatePerTick, 6);
    expect(lit.buses[0].charging).toBe(true);
    expect(chargingDemand(lit)).toBe(3 * BALANCE.transit.chargingEnergyPerBus);

    setHour(lit, 8);
    lit.layers.stopAge[at(12, 10)] = stopDueTicks();
    const before = lit.buses[0].charge;
    for (let t = 0; t < 30; t++) stepAll(lit);
    expect(lit.buses[0].charge).toBeLessThan(before);
  });

  it('smart charging holds off without surplus unless the bus is below the floor', () => {
    const state = busTown(1, 3);
    powerDepot(state);
    // busTown has no zoned buildings; give it one so coverage can reach
    // full (every bus smart) via the meter rollout.
    state.layers.zone[at(1, 1)] = Zone.Residential;
    state.layers.density[at(1, 1)] = 1;
    state.smartMeters.metered = refreshBuildingCount(state); // full coverage: every vehicle is smart
    setHour(state, 3);
    stepAll(state);
    state.buses[0].charge = 0.5;
    state.buses[1].charge = BALANCE.vehicles.smartChargeFloor - 0.05;
    for (let t = 0; t < 10; t++) stepAll(state);
    expect(state.buses[0].charge).toBe(0.5);
    expect(state.buses[1].charge).toBeGreaterThan(BALANCE.vehicles.smartChargeFloor - 0.05);
    state.lastEnergy.solar = 1000;
    for (let t = 0; t < 10; t++) stepAll(state);
    expect(state.buses[0].charge).toBeGreaterThan(0.5);
  });

  it('driving buses count in the lane occupancy', () => {
    const state = busTown(1, 3);
    powerDepot(state);
    setHour(state, 8);
    state.layers.stopAge[at(12, 10)] = stopDueTicks();
    let seen = false;
    for (let t = 0; t < 60 && !seen; t++) {
      stepAll(state);
      if (state.buses[0].phase === BusPhase.Driving) {
        const total = [...laneOccupancy(state).values()].reduce((a, b) => a + b, 0);
        expect(total).toBeGreaterThan(0);
        seen = true;
      }
    }
    expect(seen).toBe(true);
  });

  it('a bus whose route is bulldozed is dropped and respawned at the depot', () => {
    const state = busTown(1, 3);
    powerDepot(state);
    setHour(state, 8);
    state.layers.stopAge[at(12, 10)] = stopDueTicks();
    for (let t = 0; t < 40; t++) stepAll(state);
    const driving = drivingBuses(state)[0];
    expect(driving).toBeDefined();
    // Cut the street between the bus and everything else.
    const tile = tileIndex(Math.floor(driving.x), Math.floor(driving.y), SIZE);
    bulldozeTiles(state, [tile - 1, tile + 1]);
    for (let t = 0; t < 5; t++) stepAll(state);
    expect(state.buses).toHaveLength(BALANCE.transit.busesPerDepot);
    expect(state.buses.every((b) => b.depot === at(2, 9))).toBe(true);
  });

  it('transitStats counts stops, served stops, buses and depots', () => {
    const state = busTown(1, 2);
    syncBusFleet(state);
    state.layers.stopAge[at(9, 10)] = stopServiceTicks() + 1;
    expect(transitStats(state)).toEqual({
      riderShare: 0,
      riders: 0,
      driving: 0,
      stops: 2,
      stopsServed: 1,
      depots: 1,
    });
  });

  it("busDepotInfo reports a depot's fleet and the stops in reach", () => {
    const state = busTown(1, 2);
    syncBusFleet(state);
    state.buses[0].charging = true;
    expect(busDepotInfo(state, at(2, 9))).toEqual({
      busesTotal: BALANCE.transit.busesPerDepot,
      busesDriving: 0,
      busesCharging: 1,
      stopsInReach: 2,
    });
    expect(busDepotInfo(state, at(15, 2))).toEqual({
      busesTotal: 0,
      busesDriving: 0,
      busesCharging: 0,
      stopsInReach: 0,
    });
  });
});
