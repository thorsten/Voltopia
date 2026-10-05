import { BALANCE, TICK_RATE, TICKS_PER_DAY } from '../shared/constants.ts';
import { neighbors4, tileIndex, tileX, tileY } from '../shared/grid.ts';
import { PlantType, RoadClass, Zone } from '../shared/types.ts';
import { recomputeGrid } from './powerGrid.ts';
import { findRoadPath } from './routing.ts';
import { isSmartVehicle } from './smartMeters.ts';
import {
  BusPhase,
  countPopulationAndJobs,
  TileType,
  VanPhase,
  VehiclePhase,
  type SimState,
  type Vehicle,
} from './state.ts';
import { laneCapacity, laneKey } from './traffic.ts';

/** Road tiles adjacent to buildings of the given zones. */
function roadTilesNextToZones(state: SimState, zones: readonly Zone[]): number[] {
  const { tileType, zone, density } = state.layers;
  const result: number[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < tileType.length; i++) {
    if (tileType[i] !== TileType.Empty || density[i] === 0) continue;
    if (!zones.includes(zone[i] as Zone)) continue;
    for (const neighbor of neighbors4(i, state.size)) {
      if (tileType[neighbor] === TileType.Road && !seen.has(neighbor)) {
        seen.add(neighbor);
        result.push(neighbor);
      }
    }
  }
  return result;
}

/** Tile indices of all charging hubs. */
function chargingHubTiles(state: SimState): number[] {
  const { tileType, plantType } = state.layers;
  const hubs: number[] = [];
  for (let i = 0; i < tileType.length; i++) {
    if (tileType[i] === TileType.Plant && plantType[i] === PlantType.ChargingHub) {
      hubs.push(i);
    }
  }
  return hubs;
}

/** Tick offset into the day at which the given hour (0..24) starts. */
export function ticksAtHour(hour: number): number {
  return Math.floor((hour / 24) * TICKS_PER_DAY);
}

/** Anything that drives along a road path: commuter cars, delivery vans and buses. */
export interface Mover {
  x: number;
  y: number;
  angle: number;
  /** Road tiles of the current trip (empty while parked). */
  path: number[];
  pathIndex: number;
  /** Battery state of charge, 0..1. Drains while driving. */
  charge: number;
  /** Consecutive ticks spent waiting behind a full lane (gridlock breaker). */
  waitTicks: number;
}

export type MoveResult = 'moving' | 'waiting' | 'arrived' | 'lost';

function parkAt(state: SimState, mover: Mover, tile: number): void {
  mover.x = tileX(tile, state.size) + 0.5;
  mover.y = tileY(tile, state.size) + 0.5;
  mover.path = [];
  mover.pathIndex = 0;
}

/** The road tile under a mover. */
export function vehicleTile(state: SimState, mover: Mover): number {
  return tileIndex(Math.floor(mover.x), Math.floor(mover.y), state.size);
}

/** Heading from one tile to a 4-neighbour: 0 = north, 1 = east, 2 = south, 3 = west. */
function headingOf(from: number, to: number, size: number): number {
  const dx = tileX(to, size) - tileX(from, size);
  const dy = tileY(to, size) - tileY(from, size);
  if (dx > 0) return 1;
  if (dx < 0) return 3;
  if (dy > 0) return 2;
  return 0;
}

/**
 * The lane a driving mover currently occupies: its tile plus the
 * heading toward its next path tile (or the one after, while it is still
 * approaching the centre of its own tile).
 */
export function vehicleLane(state: SimState, mover: Mover): number {
  const tile = vehicleTile(state, mover);
  let target = mover.path[mover.pathIndex];
  if (target === tile) target = mover.path[mover.pathIndex + 1];
  const heading = target === undefined ? 0 : headingOf(tile, target, state.size);
  return laneKey(tile, heading);
}

/**
 * Move one tick along the path at `step` tiles per tick (avenue tiles
 * are faster). Enforces lane capacity with the gridlock breaker, keeps
 * the occupancy map current, drains the battery. 'lost' when the next
 * path tile is no longer a road; 'arrived' after the last tile, with the
 * path cleared and the lane released.
 */
export function advanceAlongPath(
  state: SimState,
  mover: Mover,
  step: number,
  occupancy: Map<number, number>,
): MoveResult {
  const target = mover.path[mover.pathIndex];
  if (target === undefined || state.layers.tileType[target] !== TileType.Road) return 'lost';

  const targetX = tileX(target, state.size) + 0.5;
  const targetY = tileY(target, state.size) + 0.5;
  const dx = targetX - mover.x;
  const dy = targetY - mover.y;
  const distance = Math.hypot(dx, dy);

  // Congestion: entering a lane that is full means waiting — unless the
  // wait has gone on so long that this is a gridlock, in which case the
  // mover squeezes past so traffic never freezes for good.
  const currentTile = vehicleTile(state, mover);
  const stride =
    state.layers.roadClass[currentTile] === RoadClass.Avenue
      ? step * BALANCE.vehicles.avenueSpeedFactor
      : step;
  const move = Math.min(stride, distance);
  const nextX = distance <= stride ? targetX : mover.x + (dx / distance) * move;
  const nextY = distance <= stride ? targetY : mover.y + (dy / distance) * move;
  const nextTile = tileIndex(Math.floor(nextX), Math.floor(nextY), state.size);
  if (nextTile !== currentTile) {
    const heading = headingOf(currentTile, nextTile, state.size);
    const nextLane = laneKey(nextTile, heading);
    const full = (occupancy.get(nextLane) ?? 0) >= laneCapacity(state, nextTile);
    if (full && mover.waitTicks < BALANCE.vehicles.maxWaitTicks) {
      mover.waitTicks++;
      return 'waiting';
    }
    const currentLane = vehicleLane(state, mover);
    occupancy.set(currentLane, Math.max(0, (occupancy.get(currentLane) ?? 1) - 1));
    occupancy.set(nextLane, (occupancy.get(nextLane) ?? 0) + 1);
  }
  mover.waitTicks = 0;

  mover.x = nextX;
  mover.y = nextY;
  if (move > 1e-9) {
    mover.angle = Math.atan2(dy, dx);
    mover.charge = Math.max(0, mover.charge - move * BALANCE.vehicles.batteryDrainPerTile);
  }

  if (distance <= stride) {
    mover.pathIndex++;
    if (mover.pathIndex >= mover.path.length) {
      const lane = vehicleLane(state, mover);
      occupancy.set(lane, Math.max(0, (occupancy.get(lane) ?? 1) - 1));
      mover.path = [];
      mover.pathIndex = 0;
      return 'arrived';
    }
  }
  return 'moving';
}

/** Commuter wrapper: park again when the route is gone, record the trip on arrival. */
function driveAlongPath(
  state: SimState,
  vehicle: Vehicle,
  step: number,
  occupancy: Map<number, number>,
): void {
  const result = advanceAlongPath(state, vehicle, step, occupancy);
  if (result === 'lost') {
    // A bulldozed tile on the route: abort the trip and re-plan next tick.
    const parked = vehicle.phase === VehiclePhase.ToWork ? vehicle.homeRoad : vehicle.workRoad;
    vehicle.phase =
      vehicle.phase === VehiclePhase.ToWork ? VehiclePhase.ParkedHome : VehiclePhase.ParkedWork;
    parkAt(state, vehicle, parked);
    return;
  }
  if (result === 'arrived') {
    vehicle.phase =
      vehicle.phase === VehiclePhase.ToWork ? VehiclePhase.ParkedWork : VehiclePhase.ParkedHome;
    recordCommute(state, vehicle);
  }
}

/**
 * How many driving movers occupy each lane (road tile and heading) at
 * the start of the tick. Oncoming traffic uses the other lane, so it
 * never blocks; only movers going the same way queue up.
 */
export function laneOccupancy(state: SimState): Map<number, number> {
  const occupancy = new Map<number, number>();
  for (const vehicle of state.vehicles) {
    if (vehicle.phase === VehiclePhase.ToWork || vehicle.phase === VehiclePhase.ToHome) {
      const lane = vehicleLane(state, vehicle);
      occupancy.set(lane, (occupancy.get(lane) ?? 0) + 1);
    }
  }
  for (const van of state.vans) {
    if (van.phase === VanPhase.Driving) {
      const lane = vehicleLane(state, van);
      occupancy.set(lane, (occupancy.get(lane) ?? 0) + 1);
    }
  }
  for (const bus of state.buses) {
    if (bus.phase === BusPhase.Driving) {
      const lane = vehicleLane(state, bus);
      occupancy.set(lane, (occupancy.get(lane) ?? 0) + 1);
    }
  }
  return occupancy;
}

/**
 * Smart charging gate: was there renewable surplus last tick? Compared
 * against buildings plus heating and cooling load (not charging itself,
 * or the gate would feed back on its own dispatch decision). The three
 * figures report what was *served*, so the smart meters' shifted load is
 * added back: otherwise the threshold would fall by exactly the deferred
 * amount in the ticks that had no surplus, and the gate would read a
 * shortfall as an invitation to charge.
 */
export function surplusAvailable(state: SimState): boolean {
  const e = state.lastEnergy;
  const unshiftedLoad =
    e.buildingConsumption +
    e.heatingConsumption +
    e.coolingConsumption +
    e.flexDeferred -
    e.flexRecovered -
    e.flexOverflow;
  return e.solar + e.wind + e.rooftop + e.hydro > unshiftedLoad;
}

/**
 * Commuting electric vehicles with a physical battery model: driving
 * drains the battery, plugging in at home (evenings) or at a nearby
 * charging hub (workdays) recharges it — the charging load on the grid
 * emerges from what the fleet actually does. Congestion: at most a few
 * vehicles fit on a road tile; followers wait, so queues form. Riders —
 * commuters covered by a served bus stop at both home and work — decide
 * once a day at the morning departure moment to leave the car parked
 * instead; they record no commute and never enter the traffic load, so
 * the charging peak and the traffic load fall with the rider share.
 * Returns this tick's lane occupancy map; the caller must pass it on to
 * both `deliveriesStep` (so vans queue behind cars) and
 * `updateTrafficLoad` (see `tick.ts`).
 */
export function vehiclesStep(state: SimState): Map<number, number> {
  // The charging decisions below read the island labels: a car can only
  // draw from a tile that is on a grid island at all.
  recomputeGrid(state);
  const { population, jobs } = countPopulationAndJobs(state);
  const targetCount = Math.min(
    BALANCE.vehicles.maxVehicles,
    Math.floor((population + jobs) / BALANCE.vehicles.citizensPerVehicle),
  );

  const homeRoads = roadTilesNextToZones(state, [Zone.Residential]);
  const workRoads = roadTilesNextToZones(state, [Zone.Commercial, Zone.Retail, Zone.Industrial]);

  if (homeRoads.length === 0) {
    state.vehicles.length = 0;
    return laneOccupancy(state);
  }

  while (state.vehicles.length > targetCount) state.vehicles.pop();
  const windowTicks = Math.floor(
    (BALANCE.vehicles.commute.departureWindowHours / 24) * TICKS_PER_DAY,
  );
  while (state.vehicles.length < targetCount) {
    const home = homeRoads[state.rng.nextInt(homeRoads.length)];
    const work = workRoads.length > 0 ? workRoads[state.rng.nextInt(workRoads.length)] : -1;
    state.vehicles.push({
      id: state.nextVehicleId++,
      homeRoad: home,
      workRoad: work,
      x: tileX(home, state.size) + 0.5,
      y: tileY(home, state.size) + 0.5,
      angle: 0,
      phase: VehiclePhase.ParkedHome,
      path: [],
      pathIndex: 0,
      departureOffset: state.rng.nextInt(Math.max(1, windowTicks)),
      charge: state.rng.nextRange(0.5, 0.9),
      tripTicks: 0,
      tripFreeFlowTicks: 0,
      charging: false,
      chargeTile: -1,
      waitTicks: 0,
      riderDay: -1,
    });
  }

  const { tileType, transitCover } = state.layers;
  const step = BALANCE.vehicles.speedTilesPerSecond / TICK_RATE;
  const ticksIntoDay = state.tick % TICKS_PER_DAY;
  const morningDeparture = ticksAtHour(BALANCE.vehicles.commute.morningStartHour);
  const eveningDeparture = ticksAtHour(BALANCE.vehicles.commute.eveningStartHour);

  const occupancy = laneOccupancy(state);

  // Work charging: hubs serve nearby workplaces up to their capacity.
  const hubs = chargingHubTiles(state);
  const hubLoad = new Map<number, number>();

  const surplus = surplusAvailable(state);

  for (const vehicle of state.vehicles) {
    // Reassign endpoints that were bulldozed or lost their buildings.
    if (tileType[vehicle.homeRoad] !== TileType.Road) {
      vehicle.homeRoad = homeRoads[state.rng.nextInt(homeRoads.length)];
      vehicle.phase = VehiclePhase.ParkedHome;
      parkAt(state, vehicle, vehicle.homeRoad);
    }
    if (vehicle.workRoad >= 0 && tileType[vehicle.workRoad] !== TileType.Road) {
      vehicle.workRoad = workRoads.length > 0 ? workRoads[state.rng.nextInt(workRoads.length)] : -1;
      if (vehicle.phase !== VehiclePhase.ParkedHome) {
        vehicle.phase = VehiclePhase.ParkedHome;
        parkAt(state, vehicle, vehicle.homeRoad);
      }
    }
    if (vehicle.workRoad < 0 && workRoads.length > 0) {
      vehicle.workRoad = workRoads[state.rng.nextInt(workRoads.length)];
    }

    switch (vehicle.phase) {
      case VehiclePhase.ParkedHome: {
        const departAt = morningDeparture + vehicle.departureOffset;
        if (vehicle.workRoad >= 0 && ticksIntoDay >= departAt && ticksIntoDay < eveningDeparture) {
          const day = Math.floor(state.tick / TICKS_PER_DAY);
          // Decided to ride today: the car stays parked all day.
          if (vehicle.riderDay === day) break;
          if (transitCover[vehicle.homeRoad] === 1 && transitCover[vehicle.workRoad] === 1) {
            vehicle.riderDay = day;
            break;
          }
          const path = findRoadPath(state, vehicle.homeRoad, vehicle.workRoad);
          if (path) {
            vehicle.riderDay = -1;
            vehicle.path = path;
            vehicle.pathIndex = 0;
            vehicle.phase = VehiclePhase.ToWork;
            startTripClock(state, vehicle, step);
          } else {
            // Not connected (yet): try again tomorrow.
            vehicle.departureOffset = state.rng.nextInt(Math.max(1, windowTicks));
          }
        }
        break;
      }
      case VehiclePhase.ParkedWork: {
        const departAt = eveningDeparture + vehicle.departureOffset;
        if (ticksIntoDay >= departAt || ticksIntoDay < morningDeparture) {
          const path = findRoadPath(state, vehicle.workRoad, vehicle.homeRoad);
          if (path) {
            vehicle.path = path;
            vehicle.pathIndex = 0;
            vehicle.phase = VehiclePhase.ToHome;
            startTripClock(state, vehicle, step);
          }
        }
        break;
      }
      case VehiclePhase.ToWork:
      case VehiclePhase.ToHome: {
        vehicle.tripTicks++;
        driveAlongPath(state, vehicle, step, occupancy);
        break;
      }
    }

    const chargeTile = decideCharging(state, vehicle, hubs, hubLoad, surplus);
    vehicle.chargeTile = chargeTile;
    vehicle.charging = chargeTile >= 0;
    if (vehicle.charging) {
      vehicle.charge = Math.min(1, vehicle.charge + BALANCE.vehicles.chargeRatePerTick);
    }
  }

  return occupancy;
}

/**
 * Plugged in where? Returns the tile the car draws from — its home road
 * whenever the battery isn't full (smart charging defers to renewable
 * surplus unless the battery is low), a charging hub with free capacity
 * near the workplace, or -1 for not charging at all. The tile decides
 * which island carries the load, and a tile on no island carries none:
 * a car parked in an unpowered street does not charge.
 */
function decideCharging(
  state: SimState,
  vehicle: Vehicle,
  hubs: number[],
  hubLoad: Map<number, number>,
  surplusAvailable: boolean,
): number {
  if (vehicle.charge >= 1) return -1;
  const { island } = state.layers;

  if (vehicle.phase === VehiclePhase.ParkedHome) {
    if (island[vehicle.homeRoad] === 0) return -1;
    if (!isSmartVehicle(state, vehicle.id)) return vehicle.homeRoad;
    return surplusAvailable || vehicle.charge < BALANCE.vehicles.smartChargeFloor
      ? vehicle.homeRoad
      : -1;
  }

  if (vehicle.phase === VehiclePhase.ParkedWork && vehicle.workRoad >= 0) {
    const wx = tileX(vehicle.workRoad, state.size);
    const wy = tileY(vehicle.workRoad, state.size);
    for (const hub of hubs) {
      const distance = Math.max(
        Math.abs(wx - tileX(hub, state.size)),
        Math.abs(wy - tileY(hub, state.size)),
      );
      if (distance > BALANCE.vehicles.hubRadius) continue;
      // An unpowered hub has nothing to give; it does not fill up either.
      if (island[hub] === 0) continue;
      const used = hubLoad.get(hub) ?? 0;
      if (used >= BALANCE.vehicles.vehiclesPerHub) continue;
      hubLoad.set(hub, used + 1);
      return hub;
    }
  }
  return -1;
}

/**
 * Reset a vehicle's trip clock and note its free-flow duration (avenues
 * count faster). Mirrors driveAlongPath exactly: the first driving tick
 * always snaps onto path[0] (the vehicle already sits there, parked),
 * then each further tile is paid for by the SOURCE tile's road class,
 * quantised the same way driveAlongPath quantises movement (whole
 * ticks, rounded up), so an empty road reports a ratio of exactly 1.
 */
function startTripClock(state: SimState, vehicle: Vehicle, step: number): void {
  vehicle.tripTicks = 0;
  let ticks = 1; // the first driving tick snaps onto path[0]
  for (let i = 0; i < vehicle.path.length - 1; i++) {
    const factor =
      state.layers.roadClass[vehicle.path[i]] === RoadClass.Avenue
        ? BALANCE.vehicles.avenueSpeedFactor
        : 1;
    ticks += Math.ceil(1 / (step * factor));
  }
  vehicle.tripFreeFlowTicks = Math.max(1, ticks);
}

/** Congestion smoothing factor per completed commute. */
const COMMUTE_EMA = 0.05;

/** Fold a finished trip into the city's smoothed congestion ratio. */
function recordCommute(state: SimState, vehicle: Vehicle): void {
  if (vehicle.tripFreeFlowTicks <= 0) return;
  const ratio = vehicle.tripTicks / vehicle.tripFreeFlowTicks;
  state.commuteCongestion += (ratio - state.commuteCongestion) * COMMUTE_EMA;
}

/** Vehicles currently on the road (parked ones are not rendered). */
export function drivingVehicles(state: SimState): Vehicle[] {
  return state.vehicles.filter(
    (v) => v.phase === VehiclePhase.ToWork || v.phase === VehiclePhase.ToHome,
  );
}

/**
 * Riding the bus: the commuter decided so this morning (or yesterday and
 * has not been re-decided yet, i.e. between midnight and the morning
 * departure). Driving commuters carry riderDay -1.
 */
export function isRider(state: SimState, vehicle: Vehicle): boolean {
  if (vehicle.riderDay < 0) return false;
  return vehicle.riderDay >= Math.floor(state.tick / TICKS_PER_DAY) - 1;
}

/** Count of vehicles currently on the road, without allocating an array. */
export function drivingVehicleCount(state: SimState): number {
  let count = 0;
  for (const v of state.vehicles) {
    if (v.phase === VehiclePhase.ToWork || v.phase === VehiclePhase.ToHome) count++;
  }
  return count;
}

/**
 * Charging demand for this tick: cars plugged in at home or a hub, vans
 * plugged in at their depot, and buses plugged in at theirs, each times
 * its charger power.
 */
export function chargingDemand(state: SimState): number {
  let cars = 0;
  for (const vehicle of state.vehicles) if (vehicle.charging) cars++;
  let vans = 0;
  for (const van of state.vans) if (van.charging) vans++;
  let buses = 0;
  for (const bus of state.buses) if (bus.charging) buses++;
  return (
    cars * BALANCE.vehicles.chargingEnergyPerVehicle +
    vans * BALANCE.deliveries.chargingEnergyPerVan +
    buses * BALANCE.transit.chargingEnergyPerBus
  );
}

/**
 * Charging demand per island this tick (index = island number, 0 = not
 * energised): cars at their home road or hub, vans and buses at their
 * depot tile. Sums to `chargingDemand`, which is the same figure for
 * the whole city. Bucket 0 stays empty: nothing charges off the grid —
 * `decideCharging` and `depotPowered` both refuse an unpowered tile.
 */
export function chargingDemandByIsland(state: SimState): Float64Array {
  recomputeGrid(state);
  const { island } = state.layers;
  const out = new Float64Array(state.islandKeys.length);
  for (const v of state.vehicles) {
    if (v.charging && v.chargeTile >= 0) {
      out[island[v.chargeTile]] += BALANCE.vehicles.chargingEnergyPerVehicle;
    }
  }
  for (const van of state.vans) {
    if (van.charging) out[island[van.depot]] += BALANCE.deliveries.chargingEnergyPerVan;
  }
  for (const bus of state.buses) {
    if (bus.charging) out[island[bus.depot]] += BALANCE.transit.chargingEnergyPerBus;
  }
  return out;
}
