import { describe, expect, it } from 'vitest';
import { BALANCE } from '../../shared/constants.ts';
import { tileIndex } from '../../shared/grid.ts';
import { PlantType, Terrain, TileType, Zone } from '../../shared/types.ts';
import { createSimState } from '../state.ts';
import {
  ScenarioSetupError,
  stampBuildings,
  stampLines,
  stampPlant,
  stampRoads,
  stampZone,
  withFreeBuild,
} from './stamp.ts';

const SIZE = 16;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);

function flatState() {
  // createSimState leaves terrain all Land and the map empty.
  return createSimState(5, SIZE);
}

describe('stamp helpers', () => {
  it('stamps a road, a zone and buildings beside it without spending money', () => {
    const state = flatState();
    const money = state.money;
    withFreeBuild(state, () => {
      stampRoads(state, [at(2, 5), at(3, 5), at(4, 5)]);
      stampZone(state, [at(2, 4), at(3, 4)], Zone.Residential);
      stampBuildings(state, [at(2, 4), at(3, 4)], 2);
      stampPlant(state, at(6, 5), PlantType.SolarFarm);
      stampLines(state, [at(7, 5), at(8, 5)]);
    });
    expect(state.money).toBe(money);
    expect(state.layers.tileType[at(3, 5)]).toBe(TileType.Road);
    expect(state.layers.density[at(2, 4)]).toBe(2);
    expect(state.layers.buildingAge[at(2, 4)]).toBe(BALANCE.growth.ageStageTicks[0]);
    expect(state.layers.tileType[at(6, 5)]).toBe(TileType.Plant);
    expect(state.dirty.has(at(2, 4))).toBe(true);
  });

  it('throws on a building without zone or road access, or on water', () => {
    const state = flatState();
    stampRoads(state, [at(2, 5)]);
    expect(() => stampBuildings(state, [at(2, 4)], 1)).toThrow(ScenarioSetupError);
    stampZone(state, [at(2, 4), at(9, 9)], Zone.Residential);
    expect(() => stampBuildings(state, [at(9, 9)], 1)).toThrow(ScenarioSetupError);
    state.layers.terrain[at(2, 4)] = Terrain.Lake;
    expect(() => stampBuildings(state, [at(2, 4)], 1)).toThrow(ScenarioSetupError);
  });

  it('throws when a road does not land on sea', () => {
    const state = flatState();
    state.layers.terrain[at(1, 1)] = Terrain.Sea;
    expect(() => stampRoads(state, [at(1, 1)])).toThrow(ScenarioSetupError);
  });

  it('throws when the underlying build is rejected for funds', () => {
    const state = flatState();
    state.money = 0;
    expect(() => stampRoads(state, [at(1, 1)])).toThrow(ScenarioSetupError);
  });

  it('throws when a zone does not land on a road', () => {
    const state = flatState();
    stampRoads(state, [at(2, 5)]);
    expect(() => stampZone(state, [at(2, 5)], Zone.Residential)).toThrow(ScenarioSetupError);
  });

  it('restores the money even when setup throws', () => {
    const state = flatState();
    const money = state.money;
    expect(() =>
      withFreeBuild(state, () => {
        stampRoads(state, [at(2, 5)]);
        throw new ScenarioSetupError('boom');
      }),
    ).toThrow(ScenarioSetupError);
    expect(state.money).toBe(money);
  });
});
