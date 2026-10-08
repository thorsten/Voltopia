import { BALANCE, TICK_RATE, TICKS_PER_DAY } from '../shared/constants.ts';
import { neighbors4, tileIndex, tileX, tileY } from '../shared/grid.ts';
import { StopState, type YardInfo } from '../shared/types.ts';
import { hashTileTick, isTileConnected } from './energy.ts';
import { islandOf, recomputeGrid } from './powerGrid.ts';
import {
  ageRailPlants,
  isStation,
  isTerminal,
  isYard,
  plantNetwork,
  plantTrack,
  railNetworkOf,
  stampRailGoods,
  stationTiles,
  terminalLoads,
  terminalTiles,
  terminalUnloads,
  updateRailCover,
  yardTiles,
  type RailCensus,
} from './rail.ts';
import { findRailPath, nearestNeighbourOrder, railDistances } from './routing.ts';
import {
  markDirty,
  stationDueTicks,
  stationStateOfAge,
  TrainKind,
  TrainPhase,
  type SimState,
  type Train,
} from './state.ts';
import { ticksAtHour } from './vehicles.ts';

/** The yard's catenary has a feed: its tile is energised (as depots charge). */
export function yardPowered(state: SimState, yard: number): boolean {
  return isTileConnected(state, yard);
}

/** Yard for the inspector. */
export function yardInfo(state: SimState, yard: number): YardInfo {
  let passengerTrains = 0;
  let freightTrains = 0;
  let running = 0;
  let stalled = 0;
  for (const t of state.trains) {
    if (t.yard !== yard) continue;
    if (t.kind === TrainKind.Freight) freightTrains++;
    else passengerTrains++;
    if (t.phase !== TrainPhase.Parked) running++;
    if (t.stalled) stalled++;
  }
  const network = plantNetwork(state, yard);
  const inNetwork = (tiles: number[]) =>
    network === 0 ? 0 : tiles.filter((p) => plantNetwork(state, p) === network).length;
  return {
    passengerTrains,
    freightTrains,
    running,
    stalled,
    powered: yardPowered(state, yard),
    stationsInNetwork: inNetwork(stationTiles(state)),
    terminalsInNetwork: inNetwork(terminalTiles(state)),
  };
}

function createTrain(state: SimState, yard: number, yardTrack: number, kind: TrainKind): Train {
  return {
    id: state.nextVehicleId++,
    kind,
    yard,
    yardTrack,
    x: tileX(yardTrack, state.size) + 0.5,
    y: tileY(yardTrack, state.size) + 0.5,
    angle: 0,
    phase: TrainPhase.Parked,
    stops: [],
    pickup: -1,
    path: [],
    pathIndex: 0,
    dwellTicks: 0,
    stalled: false,
    trail: [],
  };
}

/** Wagons behind this train's locomotive. */
export function wagonsOf(train: Train): number {
  return train.kind === TrainKind.Freight
    ? BALANCE.rail.freightWagons
    : BALANCE.rail.passengerWagons;
}

/** Trail length that covers the longest train plus a tile of slack each way. */
export const TRAIL_TILES =
  Math.ceil(
    Math.max(BALANCE.rail.passengerWagons, BALANCE.rail.freightWagons) * BALANCE.rail.wagonGap,
  ) + 2;

/**
 * Keep every powered yard's fleet complete: drop trains whose yard or
 * parking track is gone (a train mid-tour just vanishes, like a bus),
 * spawn the missing ones parked at the yard. A yard without a grid tie
 * keeps the trains it has (they stand stalled) but gets no new ones.
 */
export function syncTrainFleet(state: SimState, yards: readonly number[] = yardTiles(state)): void {
  state.trains = state.trains.filter(
    (t) => isYard(state, t.yard) && state.layers.rail[t.yardTrack] !== 0,
  );
  const perYard = new Map<number, { passenger: number; freight: number }>();
  for (const t of state.trains) {
    const n = perYard.get(t.yard) ?? { passenger: 0, freight: 0 };
    if (t.kind === TrainKind.Freight) n.freight++;
    else n.passenger++;
    perYard.set(t.yard, n);
  }
  const c = BALANCE.rail;
  for (const yard of yards) {
    const track = plantTrack(state, yard);
    if (track < 0 || !yardPowered(state, yard)) continue;
    const n = perYard.get(yard) ?? { passenger: 0, freight: 0 };
    for (let i = n.passenger; i < c.passengerTrainsPerYard; i++) {
      state.trains.push(createTrain(state, yard, track, TrainKind.Passenger));
    }
    for (let i = n.freight; i < c.freightTrainsPerYard; i++) {
      state.trains.push(createTrain(state, yard, track, TrainKind.Freight));
    }
  }
}

/** The track tile under a train. */
function trainTile(state: SimState, train: Train): number {
  return tileIndex(Math.floor(train.x), Math.floor(train.y), state.size);
}

/**
 * Move one tick along the path, covering up to `step` tiles total. No
 * lanes, no battery: trains neither queue nor charge. Unlike cars (see
 * `advanceAlongPath`), a train carries the remainder of its step across
 * tile centres within the same call, so reaching a centre — including
 * the zero-distance first hop to the train's own tile — never burns a
 * tick: the leftover step keeps driving the next leg. 'lost' when a
 * tile reached mid-step lost its track; 'arrived' after the last tile.
 * The finished leg stays on the train (`pathIndex === path.length`) so
 * the wagon keeps trailing it through the dwell; only `routeToNextHalt`
 * and `parkAtYard` replace it. Only ever called for a Running train,
 * whose path always has a tile ahead.
 */
export function advanceTrain(
  state: SimState,
  train: Train,
  step: number,
): 'moving' | 'arrived' | 'lost' {
  let remaining = step;
  while (remaining > 0) {
    const target = train.path[train.pathIndex];
    if (target === undefined || state.layers.rail[target] === 0) return 'lost';
    const targetX = tileX(target, state.size) + 0.5;
    const targetY = tileY(target, state.size) + 0.5;
    const dx = targetX - train.x;
    const dy = targetY - train.y;
    const distance = Math.hypot(dx, dy);
    if (distance <= remaining) {
      train.x = targetX;
      train.y = targetY;
      if (distance > 1e-9) train.angle = Math.atan2(dy, dx);
      train.trail.push(target);
      if (train.trail.length > TRAIL_TILES) train.trail.shift();
      remaining -= distance;
      train.pathIndex++;
      if (train.pathIndex >= train.path.length) return 'arrived';
      continue;
    }
    train.x += (dx / distance) * remaining;
    train.y += (dy / distance) * remaining;
    train.angle = Math.atan2(dy, dx);
    remaining = 0;
  }
  return 'moving';
}

/**
 * Halts every train is already going to visit — all but the closing yard
 * track, where a train only parks. A yard track planned as an
 * intermediate halt (a station or terminal beside it) is claimed.
 */
function claimedHalts(state: SimState): Set<number> {
  const claimed = new Set<number>();
  for (const t of state.trains) claimTour(claimed, t.stops);
  return claimed;
}

function claimTour(claimed: Set<number>, stops: number[]): void {
  for (let i = 0; i < stops.length - 1; i++) claimed.add(stops[i]);
}

/**
 * Nearest-neighbour order starting from `initial`'s source (the
 * caller's own distance map — never recomputed here), then the yard
 * track.
 */
function orderTour(
  state: SimState,
  remaining: Set<number>,
  yardTrack: number,
  head: number[],
  initial: Map<number, number>,
): number[] {
  const ordered = [
    ...head,
    ...nearestNeighbourOrder(remaining, (tile) => railDistances(state, tile), initial),
  ];
  ordered.push(yardTrack);
  return ordered;
}

/**
 * Plan a passenger tour for a train parked at its yard: up to
 * stationsPerTour stations of the yard's network with
 * `stationAge >= stationDueTicks() / 2`, not claimed, oldest first
 * (ties: nearer by rail from the yard, then lower index), ordered
 * nearest-neighbour and closed by the yard track. Empty when nothing
 * qualifies, so an idle fleet does not circle — checked before the
 * network-wide Dijkstra, so a train with nothing due costs none.
 */
export function planPassengerTour(state: SimState, train: Train, claimed: Set<number>): number[] {
  const network = railNetworkOf(state, train.yardTrack);
  if (network === 0) return [];
  const minAge = Math.floor(stationDueTicks() / 2);
  const qualifying: Array<{ halt: number; age: number }> = [];
  for (const station of stationTiles(state)) {
    if (plantNetwork(state, station) !== network) continue;
    const halt = plantTrack(state, station);
    if (halt < 0 || claimed.has(halt)) continue;
    const age = state.layers.stationAge[station];
    if (age < minAge) continue;
    qualifying.push({ halt, age });
  }
  if (qualifying.length === 0) return [];
  const fromYard = railDistances(state, train.yardTrack);
  const candidates = qualifying.map(({ halt, age }) => ({
    halt,
    age,
    distance: fromYard.get(halt) ?? Infinity,
  }));
  candidates.sort((a, b) => b.age - a.age || a.distance - b.distance || a.halt - b.halt);
  const remaining = new Set(candidates.slice(0, BALANCE.rail.stationsPerTour).map((c) => c.halt));
  if (remaining.size === 0) return [];
  return orderTour(state, remaining, train.yardTrack, [], fromYard);
}

/**
 * Plan a freight tour: the nearest loading terminal of the network
 * (ties: lower index) first, then up to terminalsPerTour unloading
 * terminals with `terminalAge >= stationDueTicks() / 2`, oldest first,
 * nearest-neighbour from the loading halt, closed by the yard track.
 * Empty without a loading terminal or without a due unloading one —
 * checked with a plain scan before either Dijkstra, so a train with
 * nothing to haul costs none.
 */
export function planFreightTour(state: SimState, train: Train, claimed: Set<number>): number[] {
  const network = railNetworkOf(state, train.yardTrack);
  if (network === 0) return [];
  const minAge = Math.floor(stationDueTicks() / 2);
  let hasLoading = false;
  let hasDueUnloading = false;
  for (const terminal of terminalTiles(state)) {
    if (plantNetwork(state, terminal) !== network) continue;
    const halt = plantTrack(state, terminal);
    if (halt < 0) continue;
    if (terminalLoads(state, terminal)) hasLoading = true;
    if (
      terminalUnloads(state, terminal) &&
      !claimed.has(halt) &&
      state.layers.terminalAge[terminal] >= minAge
    ) {
      hasDueUnloading = true;
    }
  }
  if (!hasLoading || !hasDueUnloading) return [];

  const fromYard = railDistances(state, train.yardTrack);
  let pickup = -1;
  let pickupCost = Infinity;
  const unloading: Array<{ halt: number; age: number; distance: number }> = [];
  for (const terminal of terminalTiles(state)) {
    if (plantNetwork(state, terminal) !== network) continue;
    const halt = plantTrack(state, terminal);
    if (halt < 0) continue;
    const distance = fromYard.get(halt) ?? Infinity;
    if (
      terminalLoads(state, terminal) &&
      (distance < pickupCost || (distance === pickupCost && halt < pickup))
    ) {
      pickup = halt;
      pickupCost = distance;
    }
    if (terminalUnloads(state, terminal) && !claimed.has(halt)) {
      const age = state.layers.terminalAge[terminal];
      if (age >= minAge) unloading.push({ halt, age, distance });
    }
  }
  if (pickup < 0) return [];
  unloading.sort((a, b) => b.age - a.age || a.distance - b.distance || a.halt - b.halt);
  const remaining = new Set(
    unloading
      .slice(0, BALANCE.rail.terminalsPerTour)
      .map((c) => c.halt)
      .filter((halt) => halt !== pickup),
  );
  if (remaining.size === 0) return [];
  const fromPickup = railDistances(state, pickup);
  return orderTour(state, remaining, train.yardTrack, [pickup], fromPickup);
}

/**
 * Route the train to stops[0], skipping halts that became unreachable;
 * park it when the yard is unreachable. The new leg keeps the tile the
 * train came from in front (pathIndex 1), so the wagon trails through
 * the halt instead of snapping into the locomotive on departure.
 */
function routeToNextHalt(state: SimState, train: Train): void {
  const from = trainTile(state, train);
  const old = train.path;
  const cameFrom = old.length >= 2 && old[old.length - 1] === from ? old[old.length - 2] : -1;
  while (train.stops.length > 0) {
    const path = findRailPath(state, from, train.stops[0]);
    if (path) {
      if (cameFrom >= 0) {
        train.path = [cameFrom, ...path];
        train.pathIndex = 1;
      } else {
        train.path = path;
        train.pathIndex = 0;
      }
      train.phase = TrainPhase.Running;
      return;
    }
    if (train.stops[0] === train.pickup) train.pickup = -1;
    train.stops.shift();
  }
  parkAtYard(state, train);
}

function parkAtYard(state: SimState, train: Train): void {
  train.stops = [];
  train.pickup = -1;
  train.path = [];
  train.pathIndex = 0;
  train.phase = TrainPhase.Parked;
  train.dwellTicks = BALANCE.rail.turnaroundTicks;
  train.x = tileX(train.yardTrack, state.size) + 0.5;
  train.y = tileY(train.yardTrack, state.size) + 0.5;
  train.trail = [];
}

/**
 * The train pulled in at a halt: every station beside the track tile is
 * served (passenger) or every unloading terminal beside it is supplied
 * (freight, not at the loading halt). Returns the dwell length.
 */
function halt(state: SimState, train: Train): number {
  const tile = trainTile(state, train);
  const c = BALANCE.rail;
  if (train.kind === TrainKind.Passenger) {
    for (const n of neighbors4(tile, state.size)) {
      if (!isStation(state, n)) continue;
      const before = stationStateOfAge(state.layers.stationAge[n]);
      state.layers.stationAge[n] = 0;
      if (before !== StopState.Served) markDirty(state, n);
    }
    return c.dwellTicks;
  }
  if (tile === train.pickup) {
    train.pickup = -1; // loaded
    return c.loadTicks;
  }
  for (const n of neighbors4(tile, state.size)) {
    if (isTerminal(state, n) && terminalUnloads(state, n)) stampRailGoods(state, n);
  }
  return c.unloadTicks;
}

function arrive(state: SimState, train: Train): void {
  if (train.stops.length <= 1) {
    parkAtYard(state, train);
    return;
  }
  train.phase = TrainPhase.Dwelling;
  train.dwellTicks = halt(state, train);
}

/**
 * Deficit share (deficit / consumption, 0..1) of each yard's island from
 * the last energy step, keyed by yard tile. Yards whose island has no
 * record (or no consumption) get 0.
 */
export function yardDeficitShare(state: SimState): Map<number, number> {
  recomputeGrid(state);
  const byKey = new Map<number, number>();
  for (const island of state.lastIslands) {
    byKey.set(
      island.key,
      island.consumption > 0 ? Math.min(1, island.deficit / island.consumption) : 0,
    );
  }
  const out = new Map<number, number>();
  for (const yard of yardTiles(state)) {
    const n = islandOf(state, yard);
    out.set(yard, n === 0 ? 0 : (byKey.get(state.islandKeys[n]) ?? 0));
  }
  return out;
}

/**
 * Catenary load per island this tick (index = island number): every
 * train in phase Running that is not stalled draws its kind's traction
 * load on the island of its yard. Bucket 0 stays empty: a yard off the
 * grid runs nothing.
 */
export function tractionDemandByIsland(state: SimState): Float64Array {
  recomputeGrid(state);
  const out = new Float64Array(state.islandKeys.length);
  const c = BALANCE.rail;
  for (const t of state.trains) {
    if (t.phase !== TrainPhase.Running || t.stalled) continue;
    const island = state.layers.island[t.yard];
    if (island === 0) continue;
    out[island] += t.kind === TrainKind.Freight ? c.tractionLoadFreight : c.tractionLoadPassenger;
  }
  return out;
}

/**
 * Railways: keep the fleets in sync, age stations, terminals and depot
 * goods, dispatch tours inside the operating window, run the trains on
 * the tracks — stalled in proportion to their yard island's deficit —
 * halt at every stop, then rebuild the station coverage. Runs after
 * transitStep (needs nothing from it) and before the energy step reads
 * tractionDemandByIsland. One grid pass (`ageRailPlants`) feeds the
 * fleet sync, the cover and — through the returned census — the stats.
 */
export function trainsStep(state: SimState): RailCensus {
  const census = ageRailPlants(state);
  const { stationsDue, terminalsDue } = census;
  syncTrainFleet(state, census.yards);
  if (state.trains.length > 0) {
    const c = BALANCE.rail;
    const step = c.speedTilesPerSecond / TICK_RATE;
    const ticksIntoDay = state.tick % TICKS_PER_DAY;
    const inWindow =
      ticksIntoDay >= ticksAtHour(c.windowStartHour) && ticksIntoDay < ticksAtHour(c.windowEndHour);
    const deficit = yardDeficitShare(state);
    const claimed = claimedHalts(state);
    for (const train of state.trains) {
      const powered = yardPowered(state, train.yard);
      // Proportional stall: the same hash rule that flickers buildings.
      train.stalled =
        !powered || hashTileTick(train.yard, state.tick) < (deficit.get(train.yard) ?? 0);
      switch (train.phase) {
        case TrainPhase.Parked: {
          // Standing in a powered yard is not a stall; a dark yard's trains are.
          train.stalled = !powered;
          if (train.dwellTicks > 0) train.dwellTicks--;
          if (!powered || train.dwellTicks > 0 || !inWindow) break;
          const due = train.kind === TrainKind.Freight ? terminalsDue : stationsDue;
          if (due === 0) break;
          const stops =
            train.kind === TrainKind.Freight
              ? planFreightTour(state, train, claimed)
              : planPassengerTour(state, train, claimed);
          if (stops.length === 0) break;
          claimTour(claimed, stops);
          train.stops = stops;
          train.pickup = train.kind === TrainKind.Freight ? stops[0] : -1;
          routeToNextHalt(state, train);
          break;
        }
        case TrainPhase.Running: {
          if (train.stalled) break;
          const result = advanceTrain(state, train, step);
          if (result === 'arrived') arrive(state, train);
          else if (result === 'lost') parkAtYard(state, train);
          break;
        }
        case TrainPhase.Dwelling: {
          if (train.stalled) break;
          train.dwellTicks--;
          if (train.dwellTicks <= 0) {
            train.stops.shift();
            routeToNextHalt(state, train);
          }
          break;
        }
      }
    }
  }
  updateRailCover(state, census.stations);
  return census;
}

/** Trains out of the yard (parked ones are not rendered). */
export function runningTrains(state: SimState): Train[] {
  return state.trains.filter((t) => t.phase !== TrainPhase.Parked);
}

/**
 * A point `gap` tiles behind the locomotive, walking back over its trail of
 * reached tile centres (newest first) so wagons follow through curves. The
 * trail survives a new leg starting at a halt, so wagons stay behind
 * through a dwell; only a fresh train leaving the yard has an empty trail,
 * so its wagons unfold over the first tiles it covers. Clamps at the
 * oldest trail point once the trail runs out.
 */
export function trailingPoint(
  state: SimState,
  train: Train,
  gap: number,
): { x: number; y: number; angle: number } {
  let x = train.x;
  let y = train.y;
  let remaining = gap;
  let angle = train.angle;
  for (let i = train.trail.length - 1; i >= 0 && remaining > TRAIL_EPSILON; i--) {
    const px = tileX(train.trail[i], state.size) + 0.5;
    const py = tileY(train.trail[i], state.size) + 0.5;
    const dx = px - x;
    const dy = py - y;
    const d = Math.hypot(dx, dy);
    if (d <= TRAIL_EPSILON) continue;
    angle = Math.atan2(-dy, -dx);
    if (d >= remaining) {
      x += (dx / d) * remaining;
      y += (dy / d) * remaining;
      remaining = 0;
    } else {
      x = px;
      y = py;
      remaining -= d;
    }
  }
  return { x, y, angle };
}
const TRAIL_EPSILON = 1e-9;
