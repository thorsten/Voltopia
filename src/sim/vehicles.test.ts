import { describe, expect, it } from 'vitest';
import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { PlantType, RoadClass, Zone } from '../shared/types.ts';
import { placePlant } from './energy.ts';
import { islandOf } from './powerGrid.ts';
import { buildPowerLines } from './powerLines.ts';
import { buildRail } from './rail.ts';
import { buildRoads, bulldozeTiles } from './roads.ts';
import { findRoadPath } from './routing.ts';
import { refreshBuildingCount } from './smartMeters.ts';
import {
  createSimState,
  TileType,
  TrainKind,
  TrainPhase,
  VanPhase,
  VehiclePhase,
  type SimState,
  type Train,
} from './state.ts';
import { transitStats } from './transit.ts';
import { updateTrafficLoad } from './traffic.ts';
import {
  chargingDemand,
  chargingDemandByIsland,
  drivingVehicles,
  isRider,
  ridesRail,
  surplusAvailable,
  vehiclesStep,
} from './vehicles.ts';

const SIZE = 24;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);

/**
 * A commuter town: homes in the west, jobs in the east, one main road.
 * ~citizens residents plus enough commercial density for workplaces.
 * Powered by default — a solar farm on a line that runs the length of
 * the street, so every home road and the workplaces are on one island;
 * cars only charge where there is a grid. Pass `powered: false` for a
 * town that never got a plant.
 */
function commuterTown(seed = 1, citizens = 150, powered = true): SimState {
  const state = createSimState(seed, SIZE);
  const road = Array.from({ length: 16 }, (_, x) => at(x + 3, 10));
  buildRoads(state, road);
  const perBuilding = BALANCE.growth.populationByDensity[3];
  const homes = Math.ceil(citizens / perBuilding);
  for (let i = 0; i < homes; i++) {
    state.layers.zone[at(3 + i, 9)] = Zone.Residential;
    state.layers.density[at(3 + i, 9)] = 3;
  }
  for (let i = 0; i < 4; i++) {
    state.layers.zone[at(15 + i, 9)] = Zone.Commercial;
    state.layers.density[at(15 + i, 9)] = 3;
  }
  if (powered) {
    state.money = 1e9;
    buildPowerLines(
      state,
      Array.from({ length: 16 }, (_, x) => at(x + 3, 12)),
    );
    placePlant(state, at(10, 13), PlantType.SolarFarm); // touches the line
  }
  return state;
}

function setHour(state: SimState, hour: number): void {
  state.tick =
    Math.floor(state.tick / TICKS_PER_DAY) * TICKS_PER_DAY +
    Math.round((hour / 24) * TICKS_PER_DAY);
}

/** Run whole in-game hours of vehicle simulation. */
function runHours(state: SimState, hours: number): void {
  const ticks = Math.round((hours / 24) * TICKS_PER_DAY);
  for (let i = 0; i < ticks; i++) {
    stepVehicles(state);
    state.tick++;
  }
}

/** One tick of commuting plus the traffic-load fold that tick.ts performs. */
function stepVehicles(state: SimState): void {
  updateTrafficLoad(state, vehiclesStep(state));
}

describe('findRoadPath', () => {
  it('finds a connected path along roads', () => {
    const state = commuterTown();
    const path = findRoadPath(state, at(3, 10), at(18, 10));
    expect(path).not.toBeNull();
    expect(path![0]).toBe(at(3, 10));
    expect(path![path!.length - 1]).toBe(at(18, 10));
    for (const tile of path!) {
      expect(state.layers.tileType[tile]).toBe(TileType.Road);
    }
    // Straight road: the path is the direct line.
    expect(path!.length).toBe(16);
  });

  it('returns null for disconnected networks', () => {
    const state = createSimState(1, SIZE);
    buildRoads(state, [at(2, 2), at(3, 2)]);
    buildRoads(state, [at(10, 10), at(11, 10)]);
    expect(findRoadPath(state, at(2, 2), at(10, 10))).toBeNull();
  });

  it('handles from === to', () => {
    const state = commuterTown();
    expect(findRoadPath(state, at(5, 10), at(5, 10))).toEqual([at(5, 10)]);
  });
});

describe('vehiclesStep (commuting)', () => {
  it('fleet size scales with population', () => {
    const small = commuterTown(1, 60);
    const large = commuterTown(1, 250);
    stepVehicles(small);
    stepVehicles(large);
    expect(large.vehicles.length).toBeGreaterThan(small.vehicles.length);
  });

  it('no vehicles without residential buildings next to roads', () => {
    const state = createSimState(1, SIZE);
    buildRoads(state, [at(2, 2), at(3, 2)]);
    stepVehicles(state);
    expect(state.vehicles).toHaveLength(0);
  });

  it('a stale traffic load still decays without residential buildings', () => {
    const state = createSimState(1, SIZE);
    const road = at(2, 2);
    buildRoads(state, [road, at(3, 2)]);
    state.layers.trafficLoad[road] = 255;
    for (let i = 0; i < 400; i++) stepVehicles(state);
    expect(state.layers.trafficLoad[road]).toBe(0);
  });

  it('vehicles drive to work in the morning and are parked before dawn', () => {
    const state = commuterTown(7, 200);
    setHour(state, 5);
    stepVehicles(state);
    expect(drivingVehicles(state)).toHaveLength(0);

    setHour(state, BALANCE.vehicles.commute.morningStartHour);
    runHours(state, BALANCE.vehicles.commute.departureWindowHours / 2);
    expect(drivingVehicles(state).length).toBeGreaterThan(0);
  });

  it('vehicles arrive at work and later return home', () => {
    const state = commuterTown(3, 200);
    setHour(state, BALANCE.vehicles.commute.morningStartHour);
    stepVehicles(state); // spawn fleet
    runHours(state, 4); // morning window + travel time
    const atWork = state.vehicles.filter((v) => v.phase === VehiclePhase.ParkedWork);
    expect(atWork.length).toBe(state.vehicles.length);

    setHour(state, BALANCE.vehicles.commute.eveningStartHour);
    runHours(state, 4);
    const atHome = state.vehicles.filter((v) => v.phase === VehiclePhase.ParkedHome);
    expect(atHome.length).toBe(state.vehicles.length);
  });

  it('driving vehicles stay on road tiles', () => {
    const state = commuterTown(9, 200);
    setHour(state, BALANCE.vehicles.commute.morningStartHour);
    const ticks = Math.round((3 / 24) * TICKS_PER_DAY);
    for (let i = 0; i < ticks; i++) {
      stepVehicles(state);
      state.tick++;
      for (const v of drivingVehicles(state)) {
        const tile = at(Math.floor(v.x), Math.floor(v.y));
        expect(state.layers.tileType[tile]).toBe(TileType.Road);
      }
    }
  });

  it('without workplaces, vehicles stay parked at home', () => {
    const state = createSimState(1, SIZE);
    buildRoads(
      state,
      Array.from({ length: 8 }, (_, x) => at(x + 3, 10)),
    );
    for (let i = 0; i < 4; i++) {
      state.layers.zone[at(3 + i, 9)] = Zone.Residential;
      state.layers.density[at(3 + i, 9)] = 3;
    }
    setHour(state, 8);
    runHours(state, 3);
    expect(state.vehicles.length).toBeGreaterThan(0);
    expect(drivingVehicles(state)).toHaveLength(0);
  });

  it('a disconnected workplace means no trip (and no crash)', () => {
    const state = createSimState(1, SIZE);
    buildRoads(
      state,
      Array.from({ length: 4 }, (_, x) => at(x + 2, 5)),
    );
    buildRoads(
      state,
      Array.from({ length: 4 }, (_, x) => at(x + 12, 15)),
    );
    state.layers.zone[at(2, 4)] = Zone.Residential;
    state.layers.density[at(2, 4)] = 3;
    state.layers.zone[at(12, 14)] = Zone.Commercial;
    state.layers.density[at(12, 14)] = 3;
    setHour(state, 8);
    runHours(state, 3);
    expect(drivingVehicles(state)).toHaveLength(0);
  });

  it('is deterministic', () => {
    const a = commuterTown(5, 200);
    const b = commuterTown(5, 200);
    setHour(a, 6);
    setHour(b, 6);
    for (let i = 0; i < 800; i++) {
      stepVehicles(a);
      a.tick++;
      stepVehicles(b);
      b.tick++;
    }
    expect(a.vehicles).toEqual(b.vehicles);
  });
});

/** Simulate from the state's current tick for whole in-game days. */
function runDays(state: SimState, days: number, sample?: (hour: number) => void): void {
  const ticks = days * TICKS_PER_DAY;
  for (let i = 0; i < ticks; i++) {
    stepVehicles(state);
    if (sample) sample(((state.tick % TICKS_PER_DAY) / TICKS_PER_DAY) * 24);
    state.tick++;
  }
}

describe('emergent charging', () => {
  it('driving drains the battery', () => {
    const state = commuterTown(3, 200);
    setHour(state, BALANCE.vehicles.commute.morningStartHour);
    stepVehicles(state);
    const before = state.vehicles.map((v) => v.charge);
    runHours(state, 4);
    const drained = state.vehicles.filter((v, i) => v.charge < before[i]);
    expect(drained.length).toBeGreaterThan(0);
  });

  it('the evening home-charging peak emerges from arrivals', () => {
    const state = commuterTown(11, 200);
    const demandByHour = new Map<number, number>();
    runDays(state, 2, (hour) => {
      // keep the day-2 samples only (day 1 still burns the spawn charge)
      if (state.tick >= TICKS_PER_DAY) {
        demandByHour.set(Math.floor(hour), chargingDemand(state));
      }
    });
    const atWorkNoon = demandByHour.get(13) ?? 0;
    const evening = demandByHour.get(19) ?? 0;
    // No hubs: nothing charges at work; plugging in happens after the
    // evening commute.
    expect(atWorkNoon).toBe(0);
    expect(evening).toBeGreaterThan(0);
  });

  it('charging hubs near workplaces shift load into the day', () => {
    const withHub = commuterTown(11, 200);
    placePlant(withHub, at(17, 11), PlantType.ChargingHub); // next to the jobs
    const demandByHour = new Map<number, number>();
    runDays(withHub, 2, (hour) => {
      if (withHub.tick >= TICKS_PER_DAY) {
        demandByHour.set(Math.floor(hour), chargingDemand(withHub));
      }
    });
    // Mid-morning, arrivals are plugged in at the hub (PV ramp window).
    expect(demandByHour.get(10) ?? 0).toBeGreaterThan(0);
  });

  it('a hub only serves a limited number of vehicles', () => {
    const state = commuterTown(11, 250);
    placePlant(state, at(17, 11), PlantType.ChargingHub);
    setHour(state, 12);
    // Everyone parked at work with an empty-ish battery.
    stepVehicles(state);
    for (const v of state.vehicles) {
      v.phase = VehiclePhase.ParkedWork;
      v.charge = 0.3;
      v.path = [];
    }
    stepVehicles(state);
    const charging = state.vehicles.filter((v) => v.charging).length;
    expect(charging).toBeGreaterThan(0);
    expect(charging).toBeLessThanOrEqual(BALANCE.vehicles.vehiclesPerHub);
  });

  it('smart charging defers home charging until there is surplus', () => {
    const state = commuterTown(5, 200);
    state.smartMeters.metered = refreshBuildingCount(state); // full coverage: every vehicle is smart
    setHour(state, 3); // everyone parked at home
    stepVehicles(state);
    for (const v of state.vehicles) v.charge = 0.8; // above the floor

    // No renewable surplus: nobody charges.
    state.lastEnergy.solar = 0;
    state.lastEnergy.wind = 0;
    state.lastEnergy.rooftop = 0;
    state.lastEnergy.buildingConsumption = 50;
    stepVehicles(state);
    expect(chargingDemand(state)).toBe(0);

    // Surplus appears: charging follows it.
    state.lastEnergy.wind = 500;
    stepVehicles(state);
    expect(chargingDemand(state)).toBeGreaterThan(0);

    // Below the floor, vehicles charge even without surplus.
    state.lastEnergy.wind = 0;
    for (const v of state.vehicles) v.charge = BALANCE.vehicles.smartChargeFloor - 0.1;
    stepVehicles(state);
    expect(chargingDemand(state)).toBeGreaterThan(0);
  });

  it('smart charging counts hydro surplus (run-of-river covers night load too)', () => {
    const state = commuterTown(5, 200);
    state.smartMeters.metered = refreshBuildingCount(state); // full coverage: every vehicle is smart
    setHour(state, 3); // everyone parked at home
    stepVehicles(state);
    for (const v of state.vehicles) v.charge = 0.8; // above the floor

    // Only hydro is generating, but it covers the load: this is a
    // surplus and smart charging should let vehicles charge past the
    // floor, same as with solar/wind/rooftop surplus.
    state.lastEnergy.solar = 0;
    state.lastEnergy.wind = 0;
    state.lastEnergy.rooftop = 0;
    state.lastEnergy.hydro = 500;
    state.lastEnergy.buildingConsumption = 50;
    stepVehicles(state);
    expect(chargingDemand(state)).toBeGreaterThan(0);
  });

  it('smart charging gate counts cooling load, not just building consumption', () => {
    const state = commuterTown(5, 200);
    state.smartMeters.metered = refreshBuildingCount(state); // full coverage: every vehicle is smart
    setHour(state, 3); // everyone parked at home
    stepVehicles(state);
    for (const v of state.vehicles) v.charge = 0.8; // above the floor

    // Generation covers buildings alone, but the cooling load eats the
    // rest: this is not a real surplus, so smart charging must not
    // dispatch vehicles into the shortfall.
    state.lastEnergy.solar = 60;
    state.lastEnergy.wind = 0;
    state.lastEnergy.rooftop = 0;
    state.lastEnergy.hydro = 0;
    state.lastEnergy.buildingConsumption = 50;
    state.lastEnergy.heatingConsumption = 0;
    state.lastEnergy.coolingConsumption = 20;
    stepVehicles(state);
    expect(chargingDemand(state)).toBe(0);

    // With cooling load at 0, the same generation is a real surplus.
    state.lastEnergy.coolingConsumption = 0;
    stepVehicles(state);
    expect(chargingDemand(state)).toBeGreaterThan(0);
  });

  it('full batteries stop charging', () => {
    const state = commuterTown(5, 200);
    setHour(state, 3);
    stepVehicles(state);
    for (const v of state.vehicles) v.charge = 1;
    stepVehicles(state);
    expect(chargingDemand(state)).toBe(0);
  });
});

describe('congestion', () => {
  /** A hand-built driving vehicle for gate tests. */
  function makeDriver(state: SimState, id: number, tile: number, path: number[], workRoad: number) {
    state.vehicles.push({
      id,
      homeRoad: tile,
      workRoad,
      x: (tile % SIZE) + 0.5,
      y: Math.floor(tile / SIZE) + 0.5,
      angle: 0,
      phase: VehiclePhase.ToWork,
      path,
      pathIndex: 0,
      departureOffset: 0,
      charge: 0.8,
      tripTicks: 0,
      tripFreeFlowTicks: 0,
      charging: false,
      chargeTile: -1,
      waitTicks: 0,
      riderDay: -1,
      riderMode: 'bus',
    });
  }

  /**
   * Enough residents next to the road that vehiclesStep keeps the
   * hand-built drivers (it trims the fleet to population / citizensPerVehicle).
   */
  function residents(state: SimState, xFrom: number, y: number, tiles = 4): void {
    for (let i = 0; i < tiles; i++) {
      state.layers.zone[at(xFrom + i, y)] = Zone.Residential;
      state.layers.density[at(xFrom + i, y)] = 3;
    }
  }

  it('a full tile blocks followers from entering', () => {
    const state = createSimState(1, SIZE);
    const a = at(3, 5);
    const b = at(4, 5);
    const c = at(5, 5);
    buildRoads(state, [a, b, c]);
    residents(state, 3, 4);
    // The follower is processed first; two blockers already fill tile b's
    // eastbound lane and are held there.
    makeDriver(state, 100, a, [b, c], c);
    makeDriver(state, 101, b, [b, c], c);
    makeDriver(state, 102, b, [b, c], c);
    const [follower, ...blockers] = state.vehicles;
    for (let i = 0; i < 5; i++) {
      stepVehicles(state);
      for (const blocker of blockers) {
        blocker.x = (b % SIZE) + 0.5;
        blocker.pathIndex = 0;
      }
    }
    expect(follower.x).toBeLessThan(4); // rolled to the edge of a, never entered b
  });

  it('queues form at a bottleneck but everyone still arrives', () => {
    const state = createSimState(2, SIZE);
    const road = Array.from({ length: 14 }, (_, x) => at(x + 3, 10));
    buildRoads(state, road);
    // Homes spread along the road, one shared workplace at the far end.
    for (let i = 0; i < 8; i++) {
      state.layers.zone[at(3 + i, 9)] = Zone.Residential;
      state.layers.density[at(3 + i, 9)] = 3;
    }
    state.layers.zone[at(16, 9)] = Zone.Commercial;
    state.layers.density[at(16, 9)] = 3;
    setHour(state, BALANCE.vehicles.commute.morningStartHour);
    stepVehicles(state);
    for (const v of state.vehicles) v.departureOffset = 0; // rush together

    let sawWaiting = false;
    const positions = new Map<number, number>();
    for (let i = 0; i < TICKS_PER_DAY / 4; i++) {
      for (const v of drivingVehicles(state)) positions.set(v.id, v.x);
      stepVehicles(state);
      state.tick++;
      for (const v of drivingVehicles(state)) {
        if (positions.get(v.id) === v.x && v.path.length > 0) sawWaiting = true;
      }
    }
    expect(sawWaiting).toBe(true);
    expect(state.vehicles.every((v) => v.phase === VehiclePhase.ParkedWork)).toBe(true);
  });

  it('oncoming traffic uses the other lane and does not block', () => {
    const state = createSimState(1, SIZE);
    const a = at(3, 5);
    const b = at(4, 5);
    const c = at(5, 5);
    buildRoads(state, [a, b, c]);
    residents(state, 3, 4);
    // Two westbound cars fill tile b's westbound lane; the eastbound
    // follower on a must still be able to enter b.
    makeDriver(state, 100, a, [b, c], c);
    makeDriver(state, 101, b, [b, a], a);
    makeDriver(state, 102, b, [b, a], a);
    const follower = state.vehicles[0];
    const xBefore = follower.x;
    stepVehicles(state);
    expect(follower.x).toBeGreaterThan(xBefore);
  });

  it('head-on traffic on a single road never deadlocks', () => {
    const state = createSimState(1, SIZE);
    const road = Array.from({ length: 12 }, (_, x) => at(x + 2, 5));
    buildRoads(state, road);
    residents(state, 2, 4);
    const east = road.slice(4); // from x=6 to the east end
    const west = road.slice(0, 6).reverse(); // from x=7 to the west end
    makeDriver(state, 100, at(6, 5), east, road[11]);
    makeDriver(state, 101, at(6, 5), east, road[11]);
    makeDriver(state, 102, at(7, 5), west, road[0]);
    makeDriver(state, 103, at(7, 5), west, road[0]);
    state.tick = TICKS_PER_DAY / 2; // noon: no scheduled departures interfere
    for (let i = 0; i < 200; i++) {
      stepVehicles(state);
      state.tick++;
    }
    // Everyone got past the oncoming pair and finished the trip.
    expect(state.vehicles.slice(0, 4).every((v) => v.phase === VehiclePhase.ParkedWork)).toBe(true);
  });

  it('a car blocked for too long squeezes past instead of waiting forever', () => {
    const state = createSimState(1, SIZE);
    const a = at(3, 5);
    const b = at(4, 5);
    const c = at(5, 5);
    buildRoads(state, [a, b, c]);
    residents(state, 3, 4);
    makeDriver(state, 100, a, [b, c], c);
    makeDriver(state, 101, b, [b, c], c);
    makeDriver(state, 102, b, [b, c], c);
    const [follower, ...blockers] = state.vehicles;
    const xBefore = follower.x;
    const freeze = () => {
      for (const blocker of blockers) {
        blocker.x = (b % SIZE) + 0.5;
        blocker.pathIndex = 0;
        blocker.phase = VehiclePhase.ToWork;
      }
    };
    // One tick to reach the edge of a, then maxWaitTicks ticks of waiting.
    for (let i = 0; i < BALANCE.vehicles.maxWaitTicks + 1; i++) {
      stepVehicles(state);
      freeze();
    }
    expect(follower.x).toBeGreaterThan(xBefore);
    expect(follower.x).toBeLessThan(4);
    stepVehicles(state);
    expect(follower.x).toBeGreaterThanOrEqual(4); // squeezed into b
  });
});

describe('commute congestion metric', () => {
  it('stays near 1 with free-flowing traffic', () => {
    const state = commuterTown(5, 120);
    setHour(state, 6);
    runDays(state, 1);
    expect(state.commuteCongestion).toBeGreaterThan(0.8);
    expect(state.commuteCongestion).toBeLessThan(1.3);
  });

  it('rises when a bottleneck jams the commute', () => {
    const state = createSimState(2, SIZE);
    buildRoads(
      state,
      Array.from({ length: 14 }, (_, x) => at(x + 3, 10)),
    );
    for (let i = 0; i < 8; i++) {
      state.layers.zone[at(3 + i, 9)] = Zone.Residential;
      state.layers.density[at(3 + i, 9)] = 3;
    }
    state.layers.zone[at(16, 9)] = Zone.Commercial;
    state.layers.density[at(16, 9)] = 3;
    setHour(state, 6);
    stepVehicles(state);
    for (const v of state.vehicles) v.departureOffset = 0; // rush together
    runDays(state, 1);
    const jammed = state.commuteCongestion;

    const calm = commuterTown(2, 120);
    setHour(calm, 6);
    runDays(calm, 1);
    expect(jammed).toBeGreaterThan(calm.commuteCongestion);
  });
});

describe('routing', () => {
  /** Two parallel east-west streets joined at both ends: a ring. */
  function ring() {
    const state = createSimState(3, SIZE);
    state.layers.elevation.fill(0);
    const top = Array.from({ length: 8 }, (_, x) => at(x + 3, 4));
    const bottom = Array.from({ length: 8 }, (_, x) => at(x + 3, 6));
    buildRoads(state, [...top, ...bottom, at(3, 5), at(10, 5)]);
    return { state, top, bottom };
  }

  it('matches the shortest path length on an unloaded street map', () => {
    const state = commuterTown();
    const path = findRoadPath(state, at(3, 10), at(18, 10))!;
    expect(path.length).toBe(16);
    expect(path[0]).toBe(at(3, 10));
    expect(path[15]).toBe(at(18, 10));
  });

  it('avoids a loaded street when an empty one of equal length exists', () => {
    const { state, top, bottom } = ring();
    for (const tile of top) state.layers.trafficLoad[tile] = 255;
    const path = findRoadPath(state, at(3, 5), at(10, 5))!;
    expect(path.some((tile) => bottom.includes(tile))).toBe(true);
    expect(path.some((tile) => top.slice(1, -1).includes(tile))).toBe(false);
  });

  it('prefers an avenue detour over a slightly shorter street', () => {
    const state = createSimState(3, SIZE);
    state.layers.elevation.fill(0);
    // Top route: 9 street tiles. Bottom route: 11 tiles, all avenue
    // (cost 1/1.5 each) except the shared destination — cheaper overall.
    const top = Array.from({ length: 8 }, (_, x) => at(x + 3, 4));
    const bottom = Array.from({ length: 8 }, (_, x) => at(x + 3, 7));
    const links = [at(3, 5), at(3, 6), at(10, 5), at(10, 6)];
    buildRoads(state, [...top, ...bottom, ...links]);
    for (const tile of [...bottom, at(3, 6), at(10, 6)]) {
      state.layers.roadClass[tile] = RoadClass.Avenue;
    }
    const path = findRoadPath(state, at(3, 5), at(10, 5))!;
    expect(path.some((tile) => bottom.includes(tile))).toBe(true);
    expect(path.some((tile) => top.includes(tile))).toBe(false);
  });

  it('is deterministic for equal-cost alternatives', () => {
    const { state } = ring();
    const a = findRoadPath(state, at(3, 5), at(10, 5));
    const b = findRoadPath(state, at(3, 5), at(10, 5));
    expect(a).toEqual(b);
  });
});

describe('avenues on the road', () => {
  function driver(state: SimState, id: number, tile: number, path: number[], workRoad: number) {
    state.vehicles.push({
      id,
      homeRoad: tile,
      workRoad,
      x: (tile % SIZE) + 0.5,
      y: Math.floor(tile / SIZE) + 0.5,
      angle: 0,
      phase: VehiclePhase.ToWork,
      path,
      pathIndex: 0,
      departureOffset: 0,
      charge: 0.8,
      tripTicks: 0,
      tripFreeFlowTicks: 0,
      charging: false,
      chargeTile: -1,
      waitTicks: 0,
      riderDay: -1,
      riderMode: 'bus',
    });
  }

  function residents(state: SimState, xFrom: number, y: number): void {
    for (let i = 0; i < 4; i++) {
      state.layers.zone[at(xFrom + i, y)] = Zone.Residential;
      state.layers.density[at(xFrom + i, y)] = 3;
    }
  }

  it('an avenue lane admits avenueMaxPerTile cars', () => {
    const state = createSimState(1, SIZE);
    state.layers.elevation.fill(0);
    const a = at(3, 5);
    const b = at(4, 5);
    const c = at(5, 5);
    buildRoads(state, [a, b, c], true);
    residents(state, 3, 4);
    driver(state, 100, a, [b, c], c);
    for (let i = 0; i < BALANCE.vehicles.avenueMaxPerTile - 1; i++) {
      driver(state, 101 + i, b, [b, c], c);
    }
    const follower = state.vehicles[0];
    for (let i = 0; i < 3; i++) {
      stepVehicles(state);
      for (const blocker of state.vehicles.slice(1)) {
        blocker.x = (b % SIZE) + 0.5;
        blocker.pathIndex = 0;
      }
    }
    expect(follower.x).toBeGreaterThanOrEqual(4); // entered b: 3 blockers leave room on a 4-car lane
  });

  it('crosses an avenue tile in fewer ticks than a street tile', () => {
    const ticksToCross = (avenue: boolean): number => {
      const state = createSimState(1, SIZE);
      state.layers.elevation.fill(0);
      const road = Array.from({ length: 6 }, (_, x) => at(x + 2, 5));
      buildRoads(state, road, avenue);
      residents(state, 2, 4);
      driver(state, 100, road[0], road, road[5]);
      const car = state.vehicles[0];
      state.tick = TICKS_PER_DAY / 2;
      let ticks = 0;
      while (car.phase === VehiclePhase.ToWork && ticks < 200) {
        stepVehicles(state);
        state.tick++;
        ticks++;
      }
      return ticks;
    };
    expect(ticksToCross(true)).toBeLessThan(ticksToCross(false));
  });

  it('free-flow ticks account for avenue speed', () => {
    const estimate = (avenue: boolean): number => {
      const state = commuterTown();
      if (avenue) {
        for (let i = 0; i < state.layers.tileType.length; i++) {
          if (state.layers.tileType[i] === TileType.Road) {
            state.layers.roadClass[i] = RoadClass.Avenue;
          }
        }
      }
      setHour(state, BALANCE.vehicles.commute.morningStartHour);
      stepVehicles(state); // spawn the fleet
      for (const v of state.vehicles) v.departureOffset = 0;
      stepVehicles(state); // everyone departs; same seed → same homes and workplaces
      return state.vehicles[0].tripFreeFlowTicks;
    };
    const street = estimate(false);
    expect(street).toBeGreaterThan(0);
    expect(estimate(true)).toBeLessThan(street);
  });

  it('a lone car on an empty road matches its own free-flow estimate exactly', () => {
    const ratio = (tiles: number, avenue: boolean): number => {
      const state = createSimState(1, SIZE);
      state.layers.elevation.fill(0);
      const road = Array.from({ length: tiles }, (_, x) => at(x + 2, 5));
      buildRoads(state, road, avenue);
      residents(state, 2, 4);
      driver(state, 100, road[0], [], road[road.length - 1]);
      const car = state.vehicles[0];
      // Depart via the normal path (so startTripClock runs); widen the
      // literal so TS doesn't narrow the phase check below to "never".
      car.phase = VehiclePhase.ParkedHome as VehiclePhase;
      state.tick = TICKS_PER_DAY / 2; // noon: departs at once, no evening departure to interfere
      let ticks = 0;
      while (car.phase !== VehiclePhase.ParkedWork && ticks < 200) {
        stepVehicles(state);
        state.tick++;
        ticks++;
      }
      expect(car.phase).toBe(VehiclePhase.ParkedWork);
      return car.tripTicks / car.tripFreeFlowTicks;
    };
    expect(ratio(6, false)).toBe(1);
    expect(ratio(16, false)).toBe(1);
    expect(ratio(6, true)).toBe(1);
    expect(ratio(16, true)).toBe(1);
  });
});

describe('vans in the commuter step', () => {
  it('a driving van occupies a lane the cars must respect', () => {
    const state = commuterTown();
    state.vans.push({
      id: 999,
      depot: -1,
      depotRoad: at(5, 10),
      x: 5.5,
      y: 10.5,
      angle: 0,
      phase: VanPhase.Driving,
      stops: [at(8, 10)],
      pickup: -1,
      path: [at(5, 10), at(6, 10), at(7, 10), at(8, 10)],
      pathIndex: 1,
      charge: 0.8,
      charging: false,
      waitTicks: 0,
      dwellTicks: 0,
    });
    const occupancy = vehiclesStep(state);
    let total = 0;
    for (const count of occupancy.values()) total += count;
    expect(total).toBe(1);
  });
});

describe('riders', () => {
  /** Cover every road tile of the commuter town as if served stops were everywhere. */
  function coverAll(state: SimState): void {
    for (let i = 0; i < state.layers.tileType.length; i++) {
      state.layers.transitCover[i] = state.layers.tileType[i] === TileType.Road ? 1 : 0;
    }
  }

  it('a commuter covered at home and at work stays parked and counts as a rider', () => {
    const state = commuterTown(3, 200);
    coverAll(state);
    setHour(state, BALANCE.vehicles.commute.morningStartHour);
    stepVehicles(state); // spawn fleet
    runHours(state, 4);
    expect(drivingVehicles(state)).toHaveLength(0);
    expect(state.vehicles.every((v) => v.phase === VehiclePhase.ParkedHome)).toBe(true);
    expect(state.vehicles.every((v) => isRider(state, v))).toBe(true);
    // Riders record no commute: the congestion ratio stays at 1.
    expect(state.commuteCongestion).toBe(1);
    // Still riders after midnight, before the next decision.
    setHour(state, 26);
    stepVehicles(state);
    expect(state.vehicles.every((v) => isRider(state, v))).toBe(true);
  });

  it('coverage at one end only means driving', () => {
    const state = commuterTown(3, 200);
    setHour(state, BALANCE.vehicles.commute.morningStartHour);
    stepVehicles(state);
    for (const v of state.vehicles) state.layers.transitCover[v.homeRoad] = 1;
    runHours(state, 4);
    expect(
      drivingVehicles(state).length +
        state.vehicles.filter((v) => v.phase === VehiclePhase.ParkedWork).length,
    ).toBe(state.vehicles.length);
    expect(state.vehicles.some((v) => isRider(state, v))).toBe(false);
  });

  it('a rider drives again the morning after coverage is lost', () => {
    const state = commuterTown(3, 200);
    coverAll(state);
    setHour(state, BALANCE.vehicles.commute.morningStartHour);
    stepVehicles(state);
    runHours(state, 4);
    expect(state.vehicles.every((v) => isRider(state, v))).toBe(true);
    state.layers.transitCover.fill(0);
    setHour(state, 24 + BALANCE.vehicles.commute.morningStartHour);
    runHours(state, 4);
    expect(state.vehicles.some((v) => isRider(state, v))).toBe(false);
    expect(state.vehicles.filter((v) => v.phase === VehiclePhase.ParkedWork)).toHaveLength(
      state.vehicles.length,
    );
  });

  /**
   * Two served stations on one track south of the street: west station
   * (4, 12) covers the homes' road tiles, east station (17, 12) the
   * workplaces'. Each station touches a road stub at y = 11 (off the
   * street y = 10) and the track at y = 13. Built on the unpowered town
   * so the line and the solar farm of the powered one are not in the way;
   * the coverage layer is written directly (updateRailCover is rail.ts'
   * business).
   */
  function railCovered(state: SimState): void {
    state.money = 1e9;
    buildRoads(state, [at(4, 11), at(17, 11)]);
    buildRail(
      state,
      Array.from({ length: 16 }, (_, x) => at(x + 3, 13)),
    );
    expect(placePlant(state, at(4, 12), PlantType.TrainStation)).toEqual({});
    expect(placePlant(state, at(17, 12), PlantType.TrainStation)).toEqual({});
    for (let x = 3; x <= 9; x++) state.layers.railStation[at(x, 10)] = at(4, 12);
    for (let x = 10; x <= 18; x++) state.layers.railStation[at(x, 10)] = at(17, 12);
  }

  it('rides the train when home and work have different served stations on one network', () => {
    const state = commuterTown(3, 200, false);
    railCovered(state);
    expect(ridesRail(state, at(3, 10), at(17, 10))).toBe(true);
    expect(ridesRail(state, at(3, 10), at(5, 10))).toBe(false); // same station
    expect(ridesRail(state, at(3, 10), at(2, 10))).toBe(false); // uncovered end
    setHour(state, BALANCE.vehicles.commute.morningStartHour);
    stepVehicles(state);
    for (const v of state.vehicles) {
      v.homeRoad = at(3, 10);
      v.workRoad = at(17, 10);
    }
    runHours(state, 4);
    expect(drivingVehicles(state)).toHaveLength(0);
    expect(state.vehicles.every((v) => isRider(state, v) && v.riderMode === 'rail')).toBe(true);
    const stats = transitStats(state);
    expect(stats.railRiders).toBe(state.vehicles.length);
    expect(stats.busRiders).toBe(0);
    expect(stats.riders).toBe(stats.railRiders);
  });

  it('two stations on different networks do not connect', () => {
    const state = commuterTown(3, 200, false);
    railCovered(state);
    bulldozeTiles(state, [at(10, 13)]);
    expect(ridesRail(state, at(3, 10), at(17, 10))).toBe(false);
  });

  it('bus coverage wins the label when both apply', () => {
    const state = commuterTown(3, 200, false);
    railCovered(state);
    coverAll(state);
    setHour(state, BALANCE.vehicles.commute.morningStartHour);
    stepVehicles(state);
    for (const v of state.vehicles) {
      v.homeRoad = at(3, 10);
      v.workRoad = at(17, 10);
    }
    // Full departureWindowHours (1.5h) must pass so every vehicle's
    // randomised departureOffset has had its chance to decide.
    runHours(state, 2);
    expect(state.vehicles.every((v) => v.riderMode === 'bus')).toBe(true);
    expect(transitStats(state).busRiders).toBe(state.vehicles.length);
  });
});

describe('surplusAvailable', () => {
  it('measures renewables against the unshifted household load', () => {
    const state = createSimState(1, SIZE);
    // Smart meters deferred 10 units, so the served household figure (50)
    // understates what the city actually wants (60).
    state.lastEnergy = {
      ...state.lastEnergy,
      buildingConsumption: 50,
      heatingConsumption: 0,
      coolingConsumption: 0,
      flexDeferred: 10,
      flexRecovered: 0,
      flexOverflow: 0,
      wind: 55,
    };
    // Above the served load but below the unshifted one: no surplus — the
    // shortfall is exactly why load was deferred in the first place.
    expect(surplusAvailable(state)).toBe(false);
    state.lastEnergy = { ...state.lastEnergy, wind: 65 };
    expect(surplusAvailable(state)).toBe(true);
  });
});

describe('chargingDemandByIsland', () => {
  it('buckets a car charging at home by the island of its home road, and sums to chargingDemand', () => {
    const state = commuterTown(11, 200);
    vehiclesStep(state);
    const byIsland = chargingDemandByIsland(state);
    let total = 0;
    for (const v of byIsland) total += v;
    expect(total).toBeCloseTo(chargingDemand(state), 9);
    const charging = state.vehicles.find((v) => v.charging)!;
    expect(charging.chargeTile).toBe(charging.homeRoad);
    expect(islandOf(state, charging.homeRoad)).toBeGreaterThan(0);
    expect(byIsland[islandOf(state, charging.homeRoad)]).toBeGreaterThan(0);
    // Nothing charges off the grid, so the unconnected bucket stays empty.
    expect(byIsland[0]).toBe(0);
  });

  it('a car parked in an unpowered street does not charge at all', () => {
    const dark = commuterTown(11, 200, false);
    vehiclesStep(dark);
    expect(dark.vehicles.length).toBeGreaterThan(0);
    expect(dark.vehicles.some((v) => v.charging)).toBe(false);
    expect(chargingDemand(dark)).toBe(0);

    // The same town with a plant and a line down the street: they plug in.
    const lit = commuterTown(11, 200);
    vehiclesStep(lit);
    expect(lit.vehicles.some((v) => v.charging)).toBe(true);
    expect(chargingDemand(lit)).toBeGreaterThan(0);
  });
});

describe('level crossings', () => {
  const ROAD_Y = 5;
  const CROSSING_X = 6;

  /** An east-west street crossed by a north-south track at (6, 5). */
  function crossingTown(): SimState {
    const state = createSimState(1, SIZE);
    state.money = 1e9;
    buildRoads(
      state,
      Array.from({ length: 6 }, (_, i) => at(i + 3, ROAD_Y)),
    );
    buildRail(
      state,
      Array.from({ length: 6 }, (_, i) => at(CROSSING_X, i + 2)),
    );
    for (let i = 0; i < 4; i++) {
      state.layers.zone[at(3 + i, ROAD_Y - 1)] = Zone.Residential;
      state.layers.density[at(3 + i, ROAD_Y - 1)] = 3;
    }
    return state;
  }

  function commuter(state: SimState): void {
    const home = at(3, ROAD_Y);
    const work = at(8, ROAD_Y);
    state.vehicles.push({
      id: 100,
      homeRoad: home,
      workRoad: work,
      x: 3.5,
      y: ROAD_Y + 0.5,
      angle: 0,
      phase: VehiclePhase.ToWork,
      path: [at(4, ROAD_Y), at(5, ROAD_Y), at(CROSSING_X, ROAD_Y), at(7, ROAD_Y), work],
      pathIndex: 0,
      departureOffset: 0,
      charge: 0.8,
      tripTicks: 0,
      tripFreeFlowTicks: 0,
      charging: false,
      chargeTile: -1,
      waitTicks: 0,
      riderDay: -1,
      riderMode: 'bus',
    });
  }

  /** A train standing two tiles north of the crossing, heading south. */
  function trainAbove(state: SimState): Train {
    const train: Train = {
      id: 1,
      kind: TrainKind.Passenger,
      yard: at(CROSSING_X, 2),
      yardTrack: at(CROSSING_X, 2),
      x: CROSSING_X + 0.5,
      y: ROAD_Y - 2 + 0.5,
      angle: -Math.PI / 2,
      phase: TrainPhase.Running,
      stops: [],
      pickup: -1,
      path: [],
      pathIndex: 0,
      dwellTicks: 0,
      stalled: false,
    };
    state.trains.push(train);
    return train;
  }

  it('holds a car at the crossing while a train is coming and lets it over once clear', () => {
    const state = crossingTown();
    commuter(state);
    trainAbove(state);
    for (let i = 0; i < 12; i++) stepVehicles(state);
    const car = state.vehicles[0];
    expect(car.x).toBeLessThan(CROSSING_X); // waiting at the barrier
    expect(car.x).toBeGreaterThan(5); // but right up to it
    state.trains.length = 0;
    for (let i = 0; i < 8; i++) stepVehicles(state);
    expect(state.vehicles[0].x).toBeGreaterThan(CROSSING_X);
  });

  /** Furthest east the car got over `ticks` ticks (it may turn around at the end). */
  function furthestEast(state: SimState, ticks: number): number {
    let furthest = state.vehicles[0].x;
    for (let i = 0; i < ticks; i++) {
      stepVehicles(state);
      furthest = Math.max(furthest, state.vehicles[0].x);
    }
    return furthest;
  }

  it('a car never waits forever: a train stalled on the crossing is squeezed past', () => {
    const state = crossingTown();
    commuter(state);
    const train = trainAbove(state);
    train.stalled = true;
    expect(furthestEast(state, BALANCE.vehicles.maxWaitTicks + 12)).toBeGreaterThan(CROSSING_X);
  });

  it('lets traffic run while the track is clear', () => {
    const state = crossingTown();
    commuter(state);
    expect(furthestEast(state, 12)).toBeGreaterThan(CROSSING_X);
  });
});
