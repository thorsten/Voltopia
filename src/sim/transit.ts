import { BALANCE, TICK_RATE, TICKS_PER_DAY } from '../shared/constants.ts';
import { tileIndex, tileX, tileY } from '../shared/grid.ts';
import { MAX_STOP_AGE, PlantType, StopState } from '../shared/types.ts';
import type { BusDepotInfo, TransitStats } from '../shared/types.ts';
import { depotRoadTile } from './deliveries.ts';
import { isTileConnected } from './energy.ts';
import { findRoadPath, nearestNeighbourOrder, roadDistances } from './routing.ts';
import type { BuildResult } from './roads.ts';
import { isSmartVehicle } from './smartMeters.ts';
import {
  advanceAlongPath,
  isRider,
  surplusAvailable,
  ticksAtHour,
  vehicleTile,
} from './vehicles.ts';
import {
  BusPhase,
  markDirty,
  snapshotTile,
  stopDueTicks,
  stopServiceTicks,
  stopStateOfAge,
  TileType,
  type Bus,
  type SimState,
  type UndoEntry,
} from './state.ts';

export { stopDueTicks, stopServiceTicks, stopStateOfAge } from './state.ts';

/** A road tile that carries a bus stop. */
export function isBusStop(state: SimState, index: number): boolean {
  const { tileType, busStop } = state.layers;
  return tileType[index] === TileType.Road && busStop[index] !== 0;
}

/** Service bucket of a tile; tiles without a stop count as served. */
export function stopState(state: SimState, index: number): StopState {
  if (!isBusStop(state, index)) return StopState.Served;
  return stopStateOfAge(state.layers.stopAge[index]);
}

/**
 * Mark bus stops on the given road tiles. Tiles that already carry a stop
 * are kept and not charged again; tiles that are not roads are skipped.
 * A drag that hits no road at all is rejected so the player learns why.
 */
export function buildBusStops(state: SimState, tiles: number[]): BuildResult {
  const { layers } = state;
  const buildable = tiles.filter(
    (index) => layers.tileType[index] === TileType.Road && layers.busStop[index] === 0,
  );
  if (buildable.length === 0) {
    const blocked = tiles.find((index) => layers.busStop[index] === 0);
    if (blocked === undefined) return {};
    return { rejected: 'needsRoadTile' };
  }
  const cost = buildable.length * BALANCE.costs.busStop;
  if (cost > state.money) return { rejected: 'notEnoughMoney' };

  const undo: UndoEntry = {
    moneyDelta: cost,
    tiles: buildable.map((index) => snapshotTile(state, index)),
  };
  state.money -= cost;
  for (const index of buildable) {
    layers.busStop[index] = 1;
    // A fresh stop starts served so coverage shows up at once.
    layers.stopAge[index] = 0;
    markDirty(state, index);
  }
  state.undoStack.push(undo);
  return {};
}

/** Remove the stops from the given tiles; the roads stay. The caller owns the undo entry. */
export function clearBusStops(state: SimState, tiles: number[]): void {
  const { layers } = state;
  for (const index of tiles) {
    layers.busStop[index] = 0;
    layers.stopAge[index] = 0;
    markDirty(state, index);
  }
}

export function countBusStops(state: SimState): number {
  const { busStop } = state.layers;
  let count = 0;
  for (let i = 0; i < busStop.length; i++) if (isBusStop(state, i)) count++;
  return count;
}

/** True while the stop had a bus within the service window. */
export function isStopServed(state: SimState, index: number): boolean {
  return isBusStop(state, index) && state.layers.stopAge[index] <= stopServiceTicks();
}

function isBusDepot(state: SimState, tile: number): boolean {
  const { tileType, plantType } = state.layers;
  return tile >= 0 && tileType[tile] === TileType.Plant && plantType[tile] === PlantType.BusDepot;
}

/** Tile indices of every bus depot. */
export function busDepotTiles(state: SimState): number[] {
  const { tileType } = state.layers;
  const depots: number[] = [];
  for (let i = 0; i < tileType.length; i++) {
    if (isBusDepot(state, i)) depots.push(i);
  }
  return depots;
}

function createBus(state: SimState, depot: number, depotRoad: number): Bus {
  return {
    id: state.nextVehicleId++,
    depot,
    depotRoad,
    x: tileX(depotRoad, state.size) + 0.5,
    y: tileY(depotRoad, state.size) + 0.5,
    angle: 0,
    phase: BusPhase.AtDepot,
    stops: [],
    path: [],
    pathIndex: 0,
    charge: state.rng.nextRange(0.5, 0.9),
    charging: false,
    waitTicks: 0,
    dwellTicks: 0,
  };
}

/**
 * Keep every depot's fleet at busesPerDepot: drop buses whose depot or
 * parking road is gone (a bus mid-tour just vanishes, like a van), spawn
 * the missing ones parked at the depot.
 */
export function syncBusFleet(state: SimState): void {
  const { tileType } = state.layers;
  state.buses = state.buses.filter(
    (bus) => isBusDepot(state, bus.depot) && tileType[bus.depotRoad] === TileType.Road,
  );
  const perDepot = new Map<number, number>();
  for (const bus of state.buses) perDepot.set(bus.depot, (perDepot.get(bus.depot) ?? 0) + 1);
  for (const depot of busDepotTiles(state)) {
    const road = depotRoadTile(state, depot);
    if (road < 0) continue;
    for (let n = perDepot.get(depot) ?? 0; n < BALANCE.transit.busesPerDepot; n++) {
      state.buses.push(createBus(state, depot, road));
    }
  }
}

/**
 * Advance every stop's age by one tick (saturating); tiles without a stop
 * sit at 0. A tile is marked dirty when it crosses into "due" or
 * "unserved" so the overlay follows. Returns the number of stops with
 * `stopAge >= floor(stopDueTicks() / 2)` — the threshold `planBusTour`
 * requires of a candidate — so `transitStep` can skip dispatching (and
 * its Dijkstra) while the fleet has nothing to do.
 */
export function ageStops(state: SimState): number {
  const { layers } = state;
  const due = stopDueTicks();
  const window = stopServiceTicks();
  const minAge = Math.floor(due / 2);
  let dueSoon = 0;
  for (let i = 0; i < layers.tileType.length; i++) {
    const age = layers.stopAge[i];
    if (!isBusStop(state, i)) {
      if (age !== 0) layers.stopAge[i] = 0;
      continue;
    }
    if (age >= MAX_STOP_AGE) {
      dueSoon++;
      continue;
    }
    const next = age + 1;
    layers.stopAge[i] = next;
    if (next === due + 1 || next === window + 1) markDirty(state, i);
    if (next >= minAge) dueSoon++;
  }
  return dueSoon;
}

/**
 * Rebuild the coverage layer: every road tile within stopRadius
 * (chessboard distance) of a served stop. Tiles whose value changes are
 * marked dirty so the overlay and the riders follow. Cost is stops ×
 * (2r+1)² plus one pass over the grid.
 */
export function updateCoverage(state: SimState): void {
  const { layers, size } = state;
  const next = new Uint8Array(layers.transitCover.length);
  const r = BALANCE.transit.stopRadius;
  for (let i = 0; i < layers.tileType.length; i++) {
    if (!isStopServed(state, i)) continue;
    const cx = tileX(i, size);
    const cy = tileY(i, size);
    const x0 = Math.max(0, cx - r);
    const x1 = Math.min(size - 1, cx + r);
    const y0 = Math.max(0, cy - r);
    const y1 = Math.min(size - 1, cy + r);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const tile = tileIndex(x, y, size);
        if (layers.tileType[tile] === TileType.Road) next[tile] = 1;
      }
    }
  }
  for (let i = 0; i < next.length; i++) {
    if (next[i] === layers.transitCover[i]) continue;
    layers.transitCover[i] = next[i];
    markDirty(state, i);
  }
}

/** Stops every bus is already going to visit (never the depot roads). */
export function claimedBusStops(state: SimState): Set<number> {
  const claimed = new Set<number>();
  for (const bus of state.buses) {
    for (const stop of bus.stops) if (stop !== bus.depotRoad) claimed.add(stop);
  }
  return claimed;
}

/**
 * Plan a tour for a bus waiting at its depot: up to stopsPerTour stops
 * reachable within maxRouteTiles, oldest first (ties: nearer, then lower
 * index), ordered nearest-neighbour from the depot and closed by the
 * depot road. Only stops with `age >= stopDueTicks() / 2` qualify, so a
 * stop sees a bus at most a few times per service window and an idle
 * fleet does not circle. Empty when nothing qualifies.
 */
export function planBusTour(state: SimState, bus: Bus, claimed: Set<number>): number[] {
  const { stopsPerTour, maxRouteTiles } = BALANCE.transit;
  const distances = roadDistances(state, bus.depotRoad, maxRouteTiles);
  const minAge = Math.floor(stopDueTicks() / 2);
  const candidates: Array<{ tile: number; age: number; distance: number }> = [];
  for (const [tile, distance] of distances) {
    if (claimed.has(tile) || !isBusStop(state, tile)) continue;
    const age = state.layers.stopAge[tile];
    if (age < minAge) continue;
    candidates.push({ tile, age, distance });
  }
  candidates.sort((a, b) => b.age - a.age || a.distance - b.distance || a.tile - b.tile);
  const remaining = new Set(candidates.slice(0, stopsPerTour).map((c) => c.tile));
  if (remaining.size === 0) return [];

  // Every stop lies within maxRouteTiles of the depot road, so twice
  // that bound covers every later hop (triangle inequality).
  const ordered = nearestNeighbourOrder(
    remaining,
    (tile) => roadDistances(state, tile, 2 * maxRouteTiles),
    distances,
  );
  ordered.push(bus.depotRoad);
  return ordered;
}

/**
 * A depot can charge whenever its tile is energised — like home charging
 * of cars, this ignores a city-wide deficit; the bus's load feeds the
 * deficit like every other load instead of being gated by it.
 */
function depotPowered(state: SimState, depot: number): boolean {
  return isTileConnected(state, depot);
}

function decideBusCharging(state: SimState, bus: Bus, surplus: boolean): boolean {
  if (bus.charge >= 1 || !depotPowered(state, bus.depot)) return false;
  if (!isSmartVehicle(state, bus.id)) return true;
  return surplus || bus.charge < BALANCE.vehicles.smartChargeFloor;
}

/**
 * Route the bus to stops[0], skipping stops that became unreachable. A
 * bus that cannot even reach its depot is marked lost and removed by the
 * next syncBusFleet.
 */
function routeToNextStop(state: SimState, bus: Bus): void {
  const from = vehicleTile(state, bus);
  while (bus.stops.length > 0) {
    const path = findRoadPath(state, from, bus.stops[0]);
    if (path) {
      bus.path = path;
      bus.pathIndex = 0;
      bus.phase = BusPhase.Driving;
      return;
    }
    bus.stops.shift();
  }
  bus.depot = -1;
  bus.path = [];
  bus.pathIndex = 0;
}

/** The bus pulled in: the stop is served right now. */
function halt(state: SimState, bus: Bus): void {
  const tile = vehicleTile(state, bus);
  if (!isBusStop(state, tile)) return;
  const before = stopStateOfAge(state.layers.stopAge[tile]);
  state.layers.stopAge[tile] = 0;
  if (before !== StopState.Served) markDirty(state, tile);
}

function arrive(state: SimState, bus: Bus): void {
  if (bus.stops.length <= 1) {
    // Last stop is always the depot road.
    bus.stops = [];
    bus.phase = BusPhase.AtDepot;
    bus.dwellTicks = BALANCE.transit.turnaroundTicks;
    bus.x = tileX(bus.depotRoad, state.size) + 0.5;
    bus.y = tileY(bus.depotRoad, state.size) + 0.5;
    return;
  }
  halt(state, bus);
  bus.phase = BusPhase.Boarding;
  bus.dwellTicks = BALANCE.transit.dwellTicks;
}

/**
 * Public transit: keep the fleets in sync, age the stops, charge at the
 * depot, dispatch tours inside the operating window, drive on the shared
 * lanes, halt at every stop, then rebuild the coverage layer. Runs after
 * vehiclesStep and deliveriesStep with their lane occupancy map so cars,
 * vans and buses queue behind each other.
 */
export function transitStep(state: SimState, occupancy: Map<number, number>): void {
  syncBusFleet(state);
  const dueSoon = ageStops(state);
  if (state.buses.length > 0) {
    const c = BALANCE.transit;
    const step = (BALANCE.vehicles.speedTilesPerSecond / TICK_RATE) * c.speedFactor;
    const ticksIntoDay = state.tick % TICKS_PER_DAY;
    const inWindow =
      ticksIntoDay >= ticksAtHour(c.windowStartHour) && ticksIntoDay < ticksAtHour(c.windowEndHour);
    const surplus = surplusAvailable(state);
    const claimed = claimedBusStops(state);

    for (const bus of state.buses) {
      bus.charging = false;
      switch (bus.phase) {
        case BusPhase.AtDepot: {
          if (bus.dwellTicks > 0) bus.dwellTicks--;
          bus.charging = decideBusCharging(state, bus, surplus);
          if (bus.charging) bus.charge = Math.min(1, bus.charge + c.chargeRatePerTick);
          if (dueSoon > 0 && bus.dwellTicks === 0 && inWindow && bus.charge >= c.minTripCharge) {
            const stops = planBusTour(state, bus, claimed);
            if (stops.length > 0) {
              for (const stop of stops) if (stop !== bus.depotRoad) claimed.add(stop);
              bus.stops = stops;
              bus.charging = false;
              routeToNextStop(state, bus);
            }
          }
          break;
        }
        case BusPhase.Driving: {
          const result = advanceAlongPath(state, bus, step, occupancy);
          if (result === 'arrived') arrive(state, bus);
          else if (result === 'lost') {
            bus.stops.shift();
            routeToNextStop(state, bus);
          }
          break;
        }
        case BusPhase.Boarding: {
          bus.dwellTicks--;
          if (bus.dwellTicks <= 0) {
            bus.stops.shift();
            routeToNextStop(state, bus);
          }
          break;
        }
      }
    }
  }
  updateCoverage(state);
}

/** Buses on the road (parked ones are not rendered). */
export function drivingBuses(state: SimState): Bus[] {
  return state.buses.filter((b) => b.phase !== BusPhase.AtDepot);
}

export function drivingBusCount(state: SimState): number {
  let count = 0;
  for (const b of state.buses) if (b.phase !== BusPhase.AtDepot) count++;
  return count;
}

/** City-wide transit figures for stats and the goal. */
export function transitStats(state: SimState): TransitStats {
  const { tileType } = state.layers;
  let stops = 0;
  let stopsServed = 0;
  for (let i = 0; i < tileType.length; i++) {
    if (!isBusStop(state, i)) continue;
    stops++;
    if (isStopServed(state, i)) stopsServed++;
  }
  let riders = 0;
  let busRiders = 0;
  let railRiders = 0;
  let commuters = 0;
  for (const vehicle of state.vehicles) {
    if (vehicle.workRoad < 0) continue;
    commuters++;
    if (!isRider(state, vehicle)) continue;
    riders++;
    if (vehicle.riderMode === 'rail') railRiders++;
    else busRiders++;
  }
  return {
    riderShare: commuters > 0 ? riders / commuters : 0,
    riders,
    busRiders,
    railRiders,
    commuters,
    driving: drivingBusCount(state),
    stops,
    stopsServed,
    depots: busDepotTiles(state).length,
  };
}

/** Fleet and reach of one depot for the inspector. */
export function busDepotInfo(state: SimState, depot: number): BusDepotInfo {
  let busesTotal = 0;
  let busesDriving = 0;
  let busesCharging = 0;
  for (const bus of state.buses) {
    if (bus.depot !== depot) continue;
    busesTotal++;
    if (bus.phase !== BusPhase.AtDepot) busesDriving++;
    if (bus.charging) busesCharging++;
  }
  const road = depotRoadTile(state, depot);
  let stopsInReach = 0;
  if (road >= 0) {
    for (const tile of roadDistances(state, road, BALANCE.transit.maxRouteTiles).keys()) {
      if (isBusStop(state, tile)) stopsInReach++;
    }
  }
  return { busesTotal, busesDriving, busesCharging, stopsInReach };
}
