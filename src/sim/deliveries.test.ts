import { describe, expect, it } from 'vitest';
import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { DeliveryState, PlantType, Zone } from '../shared/types.ts';
import {
  ageShops,
  claimedStops,
  deliveriesStep,
  deliveryState,
  drivingVans,
  dueTicks,
  planTour,
  supplyWindowTicks,
  syncFleet,
} from './deliveries.ts';
import { placePlant } from './energy.ts';
import { bulldozeTiles, buildRoads } from './roads.ts';
import { countBuildings } from './smartMeters.ts';
import { createSimState, TileType, VanPhase, type SimState } from './state.ts';
import { chargingDemand, laneOccupancy, vehiclesStep } from './vehicles.ts';

const SIZE = 24;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);

/**
 * A shop street: road y=10 from x=2..20, depot at (2,9) parking on (2,10),
 * `shops` retail buildings south of the road from x=6 on.
 */
export function shopTown(seed = 1, shops = 6): SimState {
  const state = createSimState(seed, SIZE);
  buildRoads(
    state,
    Array.from({ length: 19 }, (_, i) => at(i + 2, 10)),
  );
  placePlant(state, at(2, 9), PlantType.LogisticsDepot);
  for (let i = 0; i < shops; i++) {
    state.layers.zone[at(6 + i, 11)] = Zone.Retail;
    state.layers.density[at(6 + i, 11)] = 1;
  }
  return state;
}

describe('fleet', () => {
  it('a depot fields vansPerDepot vans parked on its road tile', () => {
    const state = shopTown();
    syncFleet(state);
    expect(state.vans).toHaveLength(BALANCE.deliveries.vansPerDepot);
    for (const van of state.vans) {
      expect(van.depot).toBe(at(2, 9));
      expect(van.depotRoad).toBe(at(2, 10));
      expect(van.phase).toBe(VanPhase.AtDepot);
      expect([Math.floor(van.x), Math.floor(van.y)]).toEqual([2, 10]);
    }
    syncFleet(state);
    expect(state.vans).toHaveLength(BALANCE.deliveries.vansPerDepot); // idempotent
  });

  it('a depot without road access fields no vans', () => {
    const state = createSimState(1, SIZE);
    state.layers.tileType[at(15, 2)] = TileType.Plant;
    state.layers.plantType[at(15, 2)] = PlantType.LogisticsDepot;
    syncFleet(state);
    expect(state.vans).toHaveLength(0);
  });

  it('bulldozing the depot drops its vans', () => {
    const state = shopTown();
    syncFleet(state);
    bulldozeTiles(state, [at(2, 9)]);
    syncFleet(state);
    expect(state.vans).toHaveLength(0);
  });

  it('vans get unique ids shared with the car counter', () => {
    const state = shopTown();
    state.nextVehicleId = 10;
    syncFleet(state);
    expect(state.vans.map((v) => v.id)).toEqual([10, 11, 12]);
    expect(state.nextVehicleId).toBe(13);
  });
});

describe('ageShops / deliveryState', () => {
  it('counts ticks for shops only and saturates', () => {
    const state = shopTown();
    for (let t = 0; t < 5; t++) ageShops(state);
    expect(state.layers.deliveryAge[at(6, 11)]).toBe(5);
    expect(state.layers.deliveryAge[at(6, 10)]).toBe(0); // road
    state.layers.deliveryAge[at(7, 11)] = 65535;
    ageShops(state);
    expect(state.layers.deliveryAge[at(7, 11)]).toBe(65535);
  });

  it('resets the age of a tile that stops being a shop', () => {
    const state = shopTown();
    state.layers.deliveryAge[at(6, 11)] = 40;
    state.layers.density[at(6, 11)] = 0;
    ageShops(state);
    expect(state.layers.deliveryAge[at(6, 11)]).toBe(0);
  });

  it('buckets supplied, due and unsupplied and marks the tile dirty on a change', () => {
    const state = shopTown();
    expect(deliveryState(state, at(6, 11))).toBe(DeliveryState.Supplied);
    expect(deliveryState(state, at(6, 10))).toBe(DeliveryState.Supplied); // not a shop
    state.layers.deliveryAge[at(6, 11)] = dueTicks();
    state.dirty.clear();
    ageShops(state);
    expect(deliveryState(state, at(6, 11))).toBe(DeliveryState.Due);
    expect(state.dirty.has(at(6, 11))).toBe(true);
    state.layers.deliveryAge[at(6, 11)] = supplyWindowTicks();
    state.dirty.clear();
    ageShops(state);
    expect(deliveryState(state, at(6, 11))).toBe(DeliveryState.Unsupplied);
    expect(state.dirty.has(at(6, 11))).toBe(true);
  });

  it('window sizes follow BALANCE', () => {
    expect(supplyWindowTicks()).toBe(
      Math.round(BALANCE.deliveries.supplyWindowDays * TICKS_PER_DAY),
    );
    expect(dueTicks()).toBe(Math.round(BALANCE.deliveries.dueAfterDays * TICKS_PER_DAY));
  });
});

describe('planTour', () => {
  it('returns nothing while no shop is at least half-way to due', () => {
    const state = shopTown();
    syncFleet(state);
    expect(planTour(state, state.vans[0], new Set())).toEqual([]);
  });

  it('picks the oldest shops first, caps at stopsPerTour and ends at the depot road', () => {
    const state = shopTown(1, 8);
    syncFleet(state);
    for (let i = 0; i < 8; i++) state.layers.deliveryAge[at(6 + i, 11)] = dueTicks() + i * 10;
    const tour = planTour(state, state.vans[0], new Set());
    expect(tour).toHaveLength(BALANCE.deliveries.stopsPerTour + 1);
    expect(tour[tour.length - 1]).toBe(at(2, 10));
    const stops = tour.slice(0, -1);
    // The three youngest shops (x = 6, 7, 8) are left for the next tour.
    expect(stops).not.toContain(at(6, 10));
    expect(stops).not.toContain(at(7, 10));
    expect(stops).not.toContain(at(8, 10));
    // Nearest-neighbour from the depot: ascending x along the street.
    expect(stops).toEqual([...stops].sort((a, b) => a - b));
  });

  it('never picks a stop claimed by another van', () => {
    const state = shopTown(1, 2);
    syncFleet(state);
    state.layers.deliveryAge[at(6, 11)] = dueTicks();
    state.layers.deliveryAge[at(7, 11)] = dueTicks();
    state.vans[1].stops = [at(6, 10), at(2, 10)];
    const claimed = claimedStops(state);
    expect(claimed.has(at(6, 10))).toBe(true);
    expect(claimed.has(at(2, 10))).toBe(false);
    expect(planTour(state, state.vans[0], claimed)).toEqual([at(7, 10), at(2, 10)]);
  });

  it('ignores shops beyond maxRouteTiles', () => {
    const BIG = 80;
    const big = (x: number, y: number) => tileIndex(x, y, BIG);
    const state = createSimState(1, BIG);
    buildRoads(
      state,
      Array.from({ length: 75 }, (_, i) => big(i + 2, 10)),
    );
    placePlant(state, big(2, 9), PlantType.LogisticsDepot);
    const near = big(2 + BALANCE.deliveries.maxRouteTiles - 1, 11);
    const far = big(2 + BALANCE.deliveries.maxRouteTiles + 5, 11);
    for (const shop of [near, far]) {
      state.layers.zone[shop] = Zone.Retail;
      state.layers.density[shop] = 1;
      state.layers.deliveryAge[shop] = dueTicks();
    }
    syncFleet(state);
    const tour = planTour(state, state.vans[0], new Set());
    expect(tour).toEqual([big(2 + BALANCE.deliveries.maxRouteTiles - 1, 10), big(2, 10)]);
  });

  it('one stop serves every shop next to that road tile', () => {
    const state = shopTown(1, 1);
    state.layers.zone[at(6, 9)] = Zone.Retail; // second shop north of the same road tile
    state.layers.density[at(6, 9)] = 1;
    syncFleet(state);
    state.layers.deliveryAge[at(6, 11)] = dueTicks();
    state.layers.deliveryAge[at(6, 9)] = dueTicks();
    expect(planTour(state, state.vans[0], new Set())).toEqual([at(6, 10), at(2, 10)]);
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

/** One tick of cars + vans exactly as tick.ts runs them. */
function stepAll(state: SimState): void {
  const occupancy = vehiclesStep(state);
  deliveriesStep(state, occupancy);
  state.tick++;
}

describe('deliveriesStep', () => {
  it('a van tours due shops inside the window and resets their age', () => {
    const state = shopTown(1, 3);
    powerDepot(state);
    setHour(state, 8);
    for (let i = 0; i < 3; i++) state.layers.deliveryAge[at(6 + i, 11)] = dueTicks();
    let delivered = false;
    for (let t = 0; t < 400 && !delivered; t++) {
      stepAll(state);
      delivered = state.layers.deliveryAge[at(6, 11)] < 50;
    }
    expect(delivered).toBe(true);
    expect(state.vans.some((v) => v.phase !== VanPhase.AtDepot)).toBe(true);
    // Eventually every shop is served and the van is back at the depot.
    for (let t = 0; t < 600; t++) stepAll(state);
    for (let i = 0; i < 3; i++) expect(state.layers.deliveryAge[at(6 + i, 11)]).toBeLessThan(700);
    expect(state.vans.every((v) => v.phase === VanPhase.AtDepot)).toBe(true);
  });

  it('driving vans stay on road tiles and move slower than cars', () => {
    const state = shopTown(1, 3);
    powerDepot(state);
    setHour(state, 8);
    state.layers.deliveryAge[at(8, 11)] = dueTicks();
    let ticksDriving = 0;
    for (let t = 0; t < 200; t++) {
      stepAll(state);
      for (const van of drivingVans(state)) {
        expect(state.layers.tileType[tileIndex(Math.floor(van.x), Math.floor(van.y), SIZE)]).toBe(
          TileType.Road,
        );
      }
      if (state.vans[0].phase === VanPhase.Driving) ticksDriving++;
    }
    // 6 tiles out and 6 back at 0.8 × 1.6 tiles/s (4 ticks/s) ≈ 38 ticks, plus unloading.
    expect(ticksDriving).toBeGreaterThan(30);
  });

  it('no tour starts outside the delivery window', () => {
    const state = shopTown(1, 3);
    powerDepot(state);
    setHour(state, 3);
    for (let i = 0; i < 3; i++) state.layers.deliveryAge[at(6 + i, 11)] = dueTicks();
    for (let t = 0; t < 60; t++) stepAll(state);
    expect(state.vans.every((v) => v.phase === VanPhase.AtDepot)).toBe(true);
  });

  it('no tour starts while no shop is even half-way to due (dispatch guard)', () => {
    const state = shopTown(1, 3);
    powerDepot(state);
    setHour(state, 8); // inside the window the whole time
    for (let t = 0; t < 200; t++) stepAll(state);
    expect(state.vans.every((v) => v.phase === VanPhase.AtDepot)).toBe(true);
  });

  it('no tour starts below minTripCharge', () => {
    const state = shopTown(1, 3);
    setHour(state, 3); // outside the delivery window: spawn without dispatching
    stepAll(state); // spawn the fleet
    for (const van of state.vans) van.charge = 0.1;
    setHour(state, 8);
    for (let i = 0; i < 3; i++) state.layers.deliveryAge[at(6 + i, 11)] = dueTicks();
    for (let t = 0; t < 60; t++) stepAll(state);
    expect(state.vans.every((v) => v.phase === VanPhase.AtDepot)).toBe(true);
  });

  it('vans charge only at a powered depot, and driving drains them', () => {
    const dark = shopTown(1, 3);
    setHour(dark, 3);
    stepAll(dark);
    for (const van of dark.vans) van.charge = 0.5;
    for (let t = 0; t < 20; t++) stepAll(dark);
    expect(dark.vans[0].charge).toBe(0.5);
    expect(dark.vans[0].charging).toBe(false);

    const lit = shopTown(1, 3);
    powerDepot(lit);
    setHour(lit, 3);
    stepAll(lit);
    for (const van of lit.vans) van.charge = 0.5;
    for (let t = 0; t < 20; t++) stepAll(lit);
    expect(lit.vans[0].charge).toBeCloseTo(0.5 + 20 * BALANCE.deliveries.chargeRatePerTick, 6);
    expect(lit.vans[0].charging).toBe(true);

    setHour(lit, 8);
    // shopTown(1, 3) only zones shops up to x=8; use that last shop as the due one.
    lit.layers.deliveryAge[at(8, 11)] = dueTicks();
    const before = lit.vans[0].charge;
    for (let t = 0; t < 30; t++) stepAll(lit);
    expect(lit.vans[0].charge).toBeLessThan(before);
  });

  it('a deficit does not stop depot charging', () => {
    const state = shopTown(1, 3);
    powerDepot(state);
    setHour(state, 3);
    stepAll(state);
    for (const van of state.vans) van.charge = 0.5;
    state.lastEnergy.deficit = 5;
    for (let t = 0; t < 10; t++) stepAll(state);
    expect(state.vans[0].charge).toBeGreaterThan(0.5);
  });

  it('smart charging holds off without surplus unless the van is below the floor', () => {
    const state = shopTown(1, 3);
    powerDepot(state);
    state.smartMeters.metered = countBuildings(state); // full coverage: every vehicle is smart
    setHour(state, 3);
    stepAll(state);
    state.vans[0].charge = 0.5;
    state.vans[1].charge = BALANCE.vehicles.smartChargeFloor - 0.05;
    for (let t = 0; t < 10; t++) stepAll(state);
    expect(state.vans[0].charge).toBe(0.5);
    expect(state.vans[1].charge).toBeGreaterThan(BALANCE.vehicles.smartChargeFloor - 0.05);
    state.lastEnergy.solar = 1000; // surplus
    for (let t = 0; t < 10; t++) stepAll(state);
    expect(state.vans[0].charge).toBeGreaterThan(0.5);
  });

  it('driving vans count in the lane occupancy and the charging load counts vans', () => {
    const state = shopTown(1, 3);
    powerDepot(state);
    setHour(state, 8);
    // shopTown(1, 3) only zones shops up to x=8; use that last shop as the due one.
    state.layers.deliveryAge[at(8, 11)] = dueTicks();
    for (let t = 0; t < 12; t++) stepAll(state);
    expect(drivingVans(state).length).toBeGreaterThan(0);
    let total = 0;
    for (const count of laneOccupancy(state).values()) total += count;
    expect(total).toBe(drivingVans(state).length);

    for (const van of state.vans) van.charging = false;
    state.vans[0].charging = true;
    expect(chargingDemand(state)).toBe(BALANCE.deliveries.chargingEnergyPerVan);
  });

  it('a van whose route is bulldozed skips the stop and comes home', () => {
    // 7 shops (x=6..12) so the due stop at x=12 routes through the x=9 tile
    // this test bulldozes mid-trip; shopTown(1, 3) would stop at x=8.
    const state = shopTown(1, 7);
    powerDepot(state);
    setHour(state, 8);
    state.layers.deliveryAge[at(12, 11)] = dueTicks();
    for (let t = 0; t < 8; t++) stepAll(state);
    expect(state.vans[0].phase).toBe(VanPhase.Driving);
    bulldozeTiles(state, [at(9, 10)]);
    for (let t = 0; t < 200; t++) stepAll(state);
    expect(state.layers.deliveryAge[at(12, 11)]).toBeGreaterThan(dueTicks());
    expect(state.vans.every((v) => v.phase === VanPhase.AtDepot)).toBe(true);
  });

  it('a shop whose only road neighbour is the depot road still gets served', () => {
    const state = shopTown(1, 0);
    state.layers.zone[at(2, 11)] = Zone.Retail;
    state.layers.density[at(2, 11)] = 1;
    powerDepot(state);
    setHour(state, 8);
    state.layers.deliveryAge[at(2, 11)] = dueTicks();
    let delivered = false;
    for (let t = 0; t < 100 && !delivered; t++) {
      stepAll(state);
      delivered = state.layers.deliveryAge[at(2, 11)] < 50;
    }
    expect(delivered).toBe(true);
    for (let t = 0; t < 50; t++) stepAll(state); // let the van finish its way home
    expect(state.vans.every((v) => v.phase === VanPhase.AtDepot)).toBe(true);
  });

  it('is deterministic for the same seed', () => {
    const run = () => {
      const state = shopTown(7, 6);
      powerDepot(state);
      setHour(state, 7);
      for (let i = 0; i < 6; i++) state.layers.deliveryAge[at(6 + i, 11)] = dueTicks() + i;
      for (let t = 0; t < TICKS_PER_DAY / 2; t++) stepAll(state);
      return state.vans.map((v) => [v.id, v.x, v.y, v.phase, v.charge]);
    };
    expect(run()).toEqual(run());
  });
});
