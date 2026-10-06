import { describe, expect, it } from 'vitest';
import { BALANCE } from '../shared/constants.ts';
import { DIR_E, DIR_N, DIR_S, DIR_W, LINE_PRESENT, tileIndex } from '../shared/grid.ts';
import { PlantType, Terrain, Zone } from '../shared/types.ts';
import { placePlant } from './energy.ts';
import { buildPowerLines } from './powerLines.ts';
import {
  buildRail,
  countRailTiles,
  hasRail,
  railNetworkOf,
  railNetworkTiles,
  railTileCost,
  recomputeRailNetworks,
} from './rail.ts';
import { buildRoads, bulldozeTiles, undoLastAction } from './roads.ts';
import { paintZones } from './zones.ts';
import { BuildIntent, buildRejection, createSimState, TileType, type SimState } from './state.ts';

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
