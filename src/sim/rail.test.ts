import { describe, expect, it } from 'vitest';
import { BALANCE } from '../shared/constants.ts';
import { DIR_E, DIR_N, DIR_S, DIR_W, LINE_PRESENT, tileIndex } from '../shared/grid.ts';
import { MAX_RAIL_AGE, PlantType, SupplyStatus, Terrain, Zone } from '../shared/types.ts';
import { placePlant } from './energy.ts';
import { buildPowerLines } from './powerLines.ts';
import {
  ageRailPlants,
  railCensus,
  railStats,
  buildRail,
  countRailTiles,
  depotsInReach,
  hasRail,
  isStationServed,
  plantNetwork,
  plantTrack,
  railNetworkOf,
  railNetworkTiles,
  railTileCost,
  recomputeRailNetworks,
  stampRailGoods,
  terminalLoads,
  terminalUnloads,
  updateRailCover,
} from './rail.ts';
import { buildRoads, bulldozeTiles, undoLastAction } from './roads.ts';
import { paintZones } from './zones.ts';
import {
  BuildIntent,
  buildRejection,
  createSimState,
  stationServiceTicks,
  TileType,
  type SimState,
} from './state.ts';

export const SIZE = 24;
export const at = (x: number, y: number) => tileIndex(x, y, SIZE);

/** Flat map with a river column at x = 12 and a lake tile at (3, 3). */
export function flat(seed = 1): SimState {
  const state = createSimState(seed, SIZE);
  state.layers.elevation.fill(0);
  state.layers.terrain.fill(Terrain.Land);
  for (let y = 0; y < SIZE; y++) state.layers.terrain[at(12, y)] = Terrain.River;
  state.layers.terrain[at(3, 3)] = Terrain.Lake;
  state.money = 1e9;
  return state;
}

describe('buildRail', () => {
  it('lays an isolated track with the presence bit and connects neighbours', () => {
    const state = flat();
    expect(buildRail(state, [at(5, 5)])).toEqual({});
    expect(state.layers.rail[at(5, 5)]).toBe(LINE_PRESENT);
    expect(hasRail(state, at(5, 5))).toBe(true);
    buildRail(state, [at(6, 5), at(6, 6)]);
    expect(state.layers.rail[at(5, 5)]).toBe(LINE_PRESENT | DIR_E);
    expect(state.layers.rail[at(6, 5)]).toBe(LINE_PRESENT | DIR_W | DIR_S);
    expect(state.layers.rail[at(6, 6)]).toBe(LINE_PRESENT | DIR_N);
    expect(countRailTiles(state)).toBe(3);
    expect(state.dirty.has(at(5, 5))).toBe(true);
  });

  it('charges the track price on land and the bridge price over the river, never twice', () => {
    const state = flat();
    const before = state.money;
    buildRail(state, [at(11, 5), at(12, 5)]);
    expect(state.money).toBe(before - BALANCE.costs.railPerTile - BALANCE.costs.railBridgePerTile);
    expect(railTileCost(state, at(12, 5))).toBe(BALANCE.costs.railBridgePerTile);
    const again = state.money;
    expect(buildRail(state, [at(11, 5), at(12, 5)])).toEqual({});
    expect(state.money).toBe(again);
  });

  it('shares a tile with a road (level crossing) and with a power line', () => {
    const state = flat();
    buildRoads(state, [at(5, 5), at(6, 5)]);
    buildPowerLines(state, [at(7, 5)]);
    expect(buildRail(state, [at(5, 4), at(5, 5), at(5, 6)])).toEqual({});
    expect(buildRail(state, [at(7, 5)])).toEqual({});
    expect(state.layers.tileType[at(5, 5)]).toBe(TileType.Road);
    expect(hasRail(state, at(5, 5))).toBe(true);
    expect(hasRail(state, at(7, 5))).toBe(true);
  });

  it('rejects buildings, plants, lake and sea, and steep tiles', () => {
    const state = flat();
    paintZones(state, [at(8, 8)], Zone.Residential);
    state.layers.density[at(8, 8)] = 1;
    placePlant(state, at(9, 9), PlantType.SolarFarm);
    expect(buildRail(state, [at(8, 8)])).toEqual({ rejected: 'needsRailSite' });
    expect(buildRail(state, [at(9, 9)])).toEqual({ rejected: 'needsRailSite' });
    expect(buildRail(state, [at(3, 3)])).toEqual({ rejected: 'cannotBuildOnWater' });
    state.layers.terrain[at(0, 0)] = Terrain.Sea;
    expect(buildRail(state, [at(0, 0)])).toEqual({ rejected: 'cannotBuildOnWater' });
    state.layers.elevation[at(15, 15)] = BALANCE.terrain.maxBuildSlope + 1;
    expect(buildRail(state, [at(15, 15)])).toEqual({ rejected: 'tooSteep' });
  });

  it('keeps zones and plants off a track tile but lets a road cross it', () => {
    const state = flat();
    buildRail(state, [at(5, 5)]);
    expect(buildRejection(state, at(5, 5), BuildIntent.Zone)).toBe('tileOccupied');
    expect(buildRejection(state, at(5, 5), BuildIntent.Plant, PlantType.SolarFarm)).toBe(
      'tileOccupied',
    );
    expect(buildRejection(state, at(5, 5), BuildIntent.Road)).toBeNull();
  });

  it('rejects the whole drag when the treasury cannot pay', () => {
    const state = flat();
    state.money = BALANCE.costs.railPerTile - 1;
    expect(buildRail(state, [at(5, 5)])).toEqual({ rejected: 'notEnoughMoney' });
    expect(hasRail(state, at(5, 5))).toBe(false);
  });

  it('bulldozes the track first and the road underneath on a second pass; undo restores both', () => {
    const state = flat();
    buildRoads(state, [at(5, 5)]);
    buildRail(state, [at(4, 5), at(5, 5), at(6, 5)]);
    bulldozeTiles(state, [at(5, 5)]);
    expect(hasRail(state, at(5, 5))).toBe(false);
    expect(state.layers.tileType[at(5, 5)]).toBe(TileType.Road);
    expect(state.layers.rail[at(4, 5)]).toBe(LINE_PRESENT);
    bulldozeTiles(state, [at(5, 5)]);
    expect(state.layers.tileType[at(5, 5)]).toBe(TileType.Empty);
    undoLastAction(state);
    undoLastAction(state);
    expect(hasRail(state, at(5, 5))).toBe(true);
    expect(state.layers.tileType[at(5, 5)]).toBe(TileType.Road);
    expect(state.layers.rail[at(4, 5)]).toBe(LINE_PRESENT | DIR_E);
  });
});

describe('rail networks', () => {
  it('labels components ascending by lowest tile and merges them when the gap closes', () => {
    const state = flat();
    buildRail(state, [at(2, 2), at(3, 2), at(4, 2)]);
    buildRail(state, [at(6, 2), at(7, 2)]);
    recomputeRailNetworks(state);
    expect(railNetworkOf(state, at(2, 2))).toBe(1);
    expect(railNetworkOf(state, at(7, 2))).toBe(2);
    expect(railNetworkOf(state, at(5, 2))).toBe(0);
    expect(state.railNetworkKeys).toEqual([-1, at(2, 2), at(6, 2)]);
    expect(railNetworkTiles(state, 1)).toBe(3);
    buildRail(state, [at(5, 2)]);
    expect(railNetworkOf(state, at(7, 2))).toBe(1);
    expect(railNetworkTiles(state, 1)).toBe(6);
    expect(state.railNetworkKeys).toEqual([-1, at(2, 2)]);
  });

  it('recomputes only when the rail version changed', () => {
    const state = flat();
    buildRail(state, [at(2, 2)]);
    recomputeRailNetworks(state);
    const version = state.railComputedVersion;
    recomputeRailNetworks(state);
    expect(state.railComputedVersion).toBe(version);
    bulldozeTiles(state, [at(2, 2)]);
    recomputeRailNetworks(state);
    expect(state.railComputedVersion).toBe(version + 1);
    expect(state.railNetworkKeys).toEqual([-1]);
  });
});

describe('rail plants', () => {
  /** Track along y = 10 from x = 2..20, a road along y = 8 from x = 2..20. */
  function corridor(): SimState {
    const state = flat();
    buildRail(
      state,
      Array.from({ length: 19 }, (_, i) => at(i + 2, 10)),
    );
    buildRoads(
      state,
      Array.from({ length: 19 }, (_, i) => at(i + 2, 8)),
    );
    return state;
  }

  it('a station needs a track and a road as 4-neighbours', () => {
    const state = corridor();
    expect(placePlant(state, at(5, 9), PlantType.TrainStation)).toEqual({});
    expect(placePlant(state, at(5, 12), PlantType.TrainStation)).toEqual({ rejected: 'needsRoad' });
    expect(placePlant(state, at(5, 7), PlantType.TrainStation)).toEqual({
      rejected: 'needsRailAccess',
    });
    expect(plantTrack(state, at(5, 9))).toBe(at(5, 10));
  });

  it('a terminal and a yard need a track; neither needs a road', () => {
    const state = corridor();
    expect(placePlant(state, at(7, 11), PlantType.FreightTerminal)).toEqual({});
    expect(placePlant(state, at(9, 11), PlantType.RailYard)).toEqual({});
    expect(placePlant(state, at(7, 13), PlantType.RailYard)).toEqual({
      rejected: 'needsRailAccess',
    });
    expect(plantNetwork(state, at(9, 11))).toBe(railNetworkOf(state, at(9, 10)));
  });

  it('stations start due, age per tick and serve for the service window after a halt', () => {
    const state = corridor();
    placePlant(state, at(5, 9), PlantType.TrainStation);
    expect(state.layers.stationAge[at(5, 9)]).toBe(MAX_RAIL_AGE);
    expect(isStationServed(state, at(5, 9))).toBe(false);
    expect(ageRailPlants(state).stationsDue).toBe(1);
    state.layers.stationAge[at(5, 9)] = 0;
    for (let i = 0; i < stationServiceTicks(); i++) ageRailPlants(state);
    expect(isStationServed(state, at(5, 9))).toBe(true);
    ageRailPlants(state);
    expect(isStationServed(state, at(5, 9))).toBe(false);
    // Non-station tiles keep the saturated age.
    expect(state.layers.stationAge[at(6, 9)]).toBe(MAX_RAIL_AGE);
  });

  it('updateRailCover marks road tiles within stationRadius of a served station with the nearest one', () => {
    const state = corridor();
    placePlant(state, at(5, 9), PlantType.TrainStation);
    placePlant(state, at(15, 9), PlantType.TrainStation);
    state.layers.stationAge[at(5, 9)] = 0;
    state.layers.stationAge[at(15, 9)] = 0;
    updateRailCover(state);
    expect(state.layers.railStation[at(5, 8)]).toBe(at(5, 9));
    expect(state.layers.railStation[at(2, 8)]).toBe(at(5, 9));
    expect(state.layers.railStation[at(15, 8)]).toBe(at(15, 9));
    expect(state.layers.railStation[at(20, 8)]).toBe(at(15, 9));
    // Equidistant: the lower station index wins.
    expect(state.layers.railStation[at(10, 8)]).toBe(at(5, 9));
    expect(state.layers.railStation[at(5, 10)]).toBe(-1); // a track tile, not a road
    state.layers.stationAge[at(5, 9)] = stationServiceTicks() + 1;
    updateRailCover(state);
    expect(state.layers.railStation[at(5, 8)]).toBe(-1);
    expect(state.layers.railStation[at(10, 8)]).toBe(at(15, 9));
    expect(state.dirty.has(at(5, 8))).toBe(true);
  });

  it('ageRailPlants returns the census of the pass: plants by kind, ascending, and the track count', () => {
    const state = corridor();
    placePlant(state, at(15, 9), PlantType.TrainStation);
    placePlant(state, at(5, 9), PlantType.TrainStation);
    placePlant(state, at(7, 11), PlantType.FreightTerminal);
    placePlant(state, at(9, 11), PlantType.RailYard);
    const census = ageRailPlants(state);
    expect(census.stations).toEqual([at(5, 9), at(15, 9)]);
    expect(census.terminals).toEqual([at(7, 11)]);
    expect(census.yards).toEqual([at(9, 11)]);
    expect(census.trackTiles).toBe(19);
    // The pure census agrees and ages nothing.
    const age = state.layers.stationAge[at(5, 9)];
    const pure = railCensus(state);
    expect(pure).toEqual({
      stations: census.stations,
      terminals: census.terminals,
      yards: census.yards,
      trackTiles: 19,
    });
    expect(state.layers.stationAge[at(5, 9)]).toBe(age);
    // railStats reads the census it is handed.
    expect(railStats(state, pure)).toMatchObject({
      stations: 2,
      terminals: 1,
      yards: 1,
      trackTiles: 19,
    });
  });

  it('updateRailCover clears the cover when the last station falls out of service, then idles', () => {
    const state = corridor();
    placePlant(state, at(5, 9), PlantType.TrainStation);
    state.layers.stationAge[at(5, 9)] = 0;
    updateRailCover(state);
    const covered = state.layers.railStation.filter((s) => s >= 0).length;
    expect(covered).toBeGreaterThan(0);
    expect(state.railCoveredRoads).toBe(covered);
    // Unserved: the cover is cleared even though no station is served any more.
    state.layers.stationAge[at(5, 9)] = stationServiceTicks() + 1;
    state.dirty.clear();
    updateRailCover(state);
    expect(state.layers.railStation.every((s) => s === -1)).toBe(true);
    expect(state.railCoveredRoads).toBe(0);
    expect(state.dirty.size).toBe(covered);
    // Nothing served, nothing covered: a further call changes nothing.
    state.dirty.clear();
    updateRailCover(state);
    expect(state.dirty.size).toBe(0);
    expect(state.railCoveredRoads).toBe(0);
  });

  it('a terminal loads beside a powered factory and unloads beside a depot', () => {
    const state = corridor();
    placePlant(state, at(7, 11), PlantType.FreightTerminal);
    expect(terminalLoads(state, at(7, 11))).toBe(false);
    expect(terminalUnloads(state, at(7, 11))).toBe(false);
    // A factory: industrial zone with a building, supplied.
    state.layers.zone[at(9, 13)] = Zone.Industrial;
    state.layers.density[at(9, 13)] = 1;
    state.layers.supplied[at(9, 13)] = SupplyStatus.Supplied;
    expect(terminalLoads(state, at(7, 11))).toBe(true);
    state.layers.damage[at(9, 13)] = 5;
    expect(terminalLoads(state, at(7, 11))).toBe(false);
    state.layers.damage[at(9, 13)] = 0;
    state.layers.supplied[at(9, 13)] = SupplyStatus.Undersupplied;
    expect(terminalLoads(state, at(7, 11))).toBe(false);
    // A depot in reach.
    buildRoads(state, [at(3, 14)]);
    placePlant(state, at(3, 15), PlantType.LogisticsDepot);
    expect(terminalUnloads(state, at(7, 11))).toBe(true);
    expect(depotsInReach(state, at(7, 11))).toEqual([at(3, 15)]);
    // Beyond freightRadius: no customer.
    buildRoads(state, [at(15, 21)]);
    expect(placePlant(state, at(15, 20), PlantType.LogisticsDepot)).toEqual({});
    expect(depotsInReach(state, at(7, 11))).toEqual([at(3, 15)]);
  });

  it('stampRailGoods resets terminalAge and the railGoodsAge of every depot in reach', () => {
    const state = corridor();
    placePlant(state, at(7, 11), PlantType.FreightTerminal);
    buildRoads(state, [at(3, 14)]);
    placePlant(state, at(3, 15), PlantType.LogisticsDepot);
    expect(state.layers.railGoodsAge[at(3, 15)]).toBe(MAX_RAIL_AGE);
    stampRailGoods(state, at(7, 11));
    expect(state.layers.terminalAge[at(7, 11)]).toBe(0);
    expect(state.layers.railGoodsAge[at(3, 15)]).toBe(0);
    ageRailPlants(state);
    expect(state.layers.railGoodsAge[at(3, 15)]).toBe(1);
    expect(state.layers.terminalAge[at(7, 11)]).toBe(1);
  });
});
