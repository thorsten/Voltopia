import { describe, expect, it } from 'vitest';
import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import { LINE_PRESENT, tileIndex } from '../shared/grid.ts';
import { DeliveryState, RoadClass, StopState, Terrain } from '../shared/types.ts';
import { placePlant } from './energy.ts';
import { recomputeGrid } from './powerGrid.ts';
import { buildRoads } from './roads.ts';
import { isCoastalSea } from './sea.ts';
import { generateTerrain } from './terrain.ts';
import { generateWater } from './water.ts';
import {
  BuildIntent,
  buildRejection,
  collectDiffs,
  createSimState,
  deliveryStateOfAge,
  deserializeState,
  isBuildable,
  isLakeShore,
  markDirty,
  PlantType,
  serializeState,
  slopeAt,
  slopeCostMultiplier,
  stopStateOfAge,
  TileType,
  Zone,
  type SimState,
} from './state.ts';

/** A generated map: elevation and water (river, lake, sea) but no zoning. */
function generatedState(seed: number, size: number): SimState {
  const state = createSimState(seed, size);
  generateTerrain(state);
  generateWater(state);
  return state;
}

/** First tile index matching the predicate; fails loudly when there is none. */
function findTile(state: SimState, predicate: (index: number) => boolean): number {
  for (let i = 0; i < state.layers.terrain.length; i++) {
    if (predicate(i)) return i;
  }
  throw new Error('no matching tile on this map');
}

const SIZE = 16;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);

function makeState(): SimState {
  const state = createSimState(1, SIZE);
  state.layers.terrain[at(5, 5)] = Terrain.River;
  state.layers.terrain[at(8, 8)] = Terrain.Lake;
  return state;
}

describe('buildRejection', () => {
  it('allows everything on empty land', () => {
    const state = makeState();
    expect(buildRejection(state, at(1, 1), BuildIntent.Road)).toBeNull();
    expect(buildRejection(state, at(1, 1), BuildIntent.Zone)).toBeNull();
    expect(buildRejection(state, at(1, 1), BuildIntent.Plant, PlantType.SolarFarm)).toBeNull();
  });

  it('rejects occupied tiles first', () => {
    const state = makeState();
    state.layers.tileType[at(1, 1)] = TileType.Road;
    expect(buildRejection(state, at(1, 1), BuildIntent.Road)).toBe('tileOccupied');
    state.layers.density[at(2, 2)] = 1;
    expect(buildRejection(state, at(2, 2), BuildIntent.Zone)).toBe('tileOccupied');
  });

  it('allows roads (bridges) and run-of-river plants on river tiles only', () => {
    const state = makeState();
    expect(buildRejection(state, at(5, 5), BuildIntent.Road)).toBeNull();
    expect(buildRejection(state, at(5, 5), BuildIntent.Zone)).toBe('cannotBuildOnWater');
    expect(buildRejection(state, at(5, 5), BuildIntent.Plant, PlantType.SolarFarm)).toBe(
      'cannotBuildOnWater',
    );
    expect(buildRejection(state, at(5, 5), BuildIntent.Plant, PlantType.RunOfRiver)).toBeNull();
    expect(buildRejection(state, at(1, 1), BuildIntent.Plant, PlantType.RunOfRiver)).toBe(
      'needsRiverTile',
    );
  });

  it('rejects everything on lake tiles', () => {
    const state = makeState();
    expect(buildRejection(state, at(8, 8), BuildIntent.Road)).toBe('cannotBuildOnWater');
    expect(buildRejection(state, at(8, 8), BuildIntent.Zone)).toBe('cannotBuildOnWater');
    expect(buildRejection(state, at(8, 8), BuildIntent.Plant, PlantType.RunOfRiver)).toBe(
      'cannotBuildOnWater',
    );
  });

  it('requires a lake shore for pumped storage', () => {
    const state = makeState();
    expect(isLakeShore(state, at(8, 7))).toBe(true);
    expect(isLakeShore(state, at(1, 1))).toBe(false);
    expect(buildRejection(state, at(8, 7), BuildIntent.Plant, PlantType.PumpedStorage)).toBeNull();
    expect(buildRejection(state, at(1, 1), BuildIntent.Plant, PlantType.PumpedStorage)).toBe(
      'needsLakeShore',
    );
    expect(isBuildable(state, at(8, 7), BuildIntent.Plant, PlantType.PumpedStorage)).toBe(true);
  });

  it('a logistics depot needs a road next to it, like the stations', () => {
    const state = createSimState(1, SIZE);
    expect(buildRejection(state, at(5, 5), BuildIntent.Plant, PlantType.LogisticsDepot)).toBe(
      'needsRoad',
    );
    buildRoads(state, [at(5, 6)]);
    expect(buildRejection(state, at(5, 5), BuildIntent.Plant, PlantType.LogisticsDepot)).toBeNull();
  });

  it('accepts power lines on land, roads, river and lake but not on plants or buildings', () => {
    const state = makeState();
    expect(buildRejection(state, at(1, 1), BuildIntent.PowerLine)).toBeNull();
    expect(buildRejection(state, at(5, 5), BuildIntent.PowerLine)).toBeNull(); // river
    expect(buildRejection(state, at(8, 8), BuildIntent.PowerLine)).toBeNull(); // lake
    state.layers.tileType[at(2, 2)] = TileType.Road;
    expect(buildRejection(state, at(2, 2), BuildIntent.PowerLine)).toBeNull();
    state.layers.tileType[at(3, 3)] = TileType.Plant;
    expect(buildRejection(state, at(3, 3), BuildIntent.PowerLine)).toBe('needsLineSite');
    state.layers.density[at(4, 4)] = 1;
    expect(buildRejection(state, at(4, 4), BuildIntent.PowerLine)).toBe('needsLineSite');
  });

  it('keeps zones and plants off line tiles while roads may share them', () => {
    const state = makeState();
    state.layers.powerLine[at(1, 1)] = LINE_PRESENT;
    expect(buildRejection(state, at(1, 1), BuildIntent.Road)).toBeNull();
    expect(buildRejection(state, at(1, 1), BuildIntent.Zone)).toBe('tileOccupied');
    expect(buildRejection(state, at(1, 1), BuildIntent.Plant, PlantType.SolarFarm)).toBe(
      'tileOccupied',
    );
  });
});

describe('sea build rules', () => {
  it('accepts a tidal plant on a coastal sea tile', () => {
    const state = generatedState(1, 64);
    const coastal = findTile(state, (index) => isCoastalSea(state, index));
    expect(buildRejection(state, coastal, BuildIntent.Plant, PlantType.TidalPlant)).toBeNull();
  });

  it('rejects a tidal plant on open water and on land', () => {
    const state = generatedState(1, 64);
    const open = findTile(
      state,
      (index) => state.layers.terrain[index] === Terrain.Sea && !isCoastalSea(state, index),
    );
    expect(buildRejection(state, open, BuildIntent.Plant, PlantType.TidalPlant)).toBe('needsCoast');
    const land = findTile(state, (index) => state.layers.terrain[index] === Terrain.Land);
    expect(buildRejection(state, land, BuildIntent.Plant, PlantType.TidalPlant)).toBe(
      'needsSeaTile',
    );
  });

  it('accepts wind turbines at sea but no roads, zones or other plants', () => {
    const state = generatedState(1, 64);
    const sea = findTile(state, (index) => state.layers.terrain[index] === Terrain.Sea);
    expect(buildRejection(state, sea, BuildIntent.Plant, PlantType.WindTurbine)).toBeNull();
    expect(buildRejection(state, sea, BuildIntent.Road)).toBe('cannotBuildOnWater');
    expect(buildRejection(state, sea, BuildIntent.Zone)).toBe('cannotBuildOnWater');
    expect(buildRejection(state, sea, BuildIntent.Plant, PlantType.SolarFarm)).toBe(
      'cannotBuildOnWater',
    );
  });

  it('still allows power lines across the sea', () => {
    const state = generatedState(1, 64);
    // Open water, not a coastal tile: coastal sea can sit at the foot of a
    // cliff, which would fail on slope alone and defeat the point of this
    // check (power lines ignore terrain, only occupancy and slope matter).
    const sea = findTile(
      state,
      (index) => state.layers.terrain[index] === Terrain.Sea && !isCoastalSea(state, index),
    );
    expect(buildRejection(state, sea, BuildIntent.PowerLine)).toBeNull();
  });
});

describe('save round trip', () => {
  it('persists terrain, river flow and pumped storage', () => {
    const state = makeState();
    state.weather.riverFlow = 0.8;
    state.pumpedStorageEnergy = 1234;
    const save = serializeState(state);
    const restored = deserializeState(save);
    expect(restored.layers.terrain).toEqual(state.layers.terrain);
    expect(restored.weather.riverFlow).toBe(0.8);
    expect(restored.pumpedStorageEnergy).toBe(1234);
  });

  it('loads older saves without the new fields as dry land', () => {
    const state = makeState();
    const save = serializeState(state);
    delete save.layers.terrain;
    delete save.riverFlow;
    delete save.pumpedStorageEnergy;
    const restored = deserializeState(save);
    expect(restored.layers.terrain.every((t) => t === Terrain.Land)).toBe(true);
    expect(restored.weather.riverFlow).toBe(BALANCE.water.dryBaselineFlow);
    expect(restored.pumpedStorageEnergy).toBe(0);
  });

  it('persists the power line layer', () => {
    const state = makeState();
    state.layers.powerLine[at(1, 1)] = LINE_PRESENT;
    const restored = deserializeState(serializeState(state));
    expect(restored.layers.powerLine[at(1, 1)]).toBe(LINE_PRESENT);
    expect(restored.gridComputedVersion).toBe(-1);
  });

  it('grants lines along plant-connected roads to saves without the layer', () => {
    const state = makeState();
    state.money = 1e9;
    buildRoads(state, [at(1, 2), at(2, 2), at(3, 2)]);
    state.layers.tileType[at(1, 1)] = TileType.Plant;
    state.layers.plantType[at(1, 1)] = PlantType.WindTurbine; // touches road (1,2)
    buildRoads(state, [at(10, 10), at(11, 10)]); // no plant nearby
    const save = serializeState(state);
    delete save.layers.powerLine;
    const restored = deserializeState(save);
    expect(restored.layers.powerLine[at(1, 2)]).not.toBe(0);
    expect(restored.layers.powerLine[at(3, 2)]).not.toBe(0);
    expect(restored.layers.powerLine[at(10, 10)]).toBe(0);
  });

  it('connects a plant that stands off the street to the road network', () => {
    const state = makeState();
    state.money = 1e9;
    buildRoads(state, [at(1, 5), at(2, 5), at(3, 5)]);
    state.layers.tileType[at(1, 3)] = TileType.Plant; // two tiles off the road
    state.layers.plantType[at(1, 3)] = PlantType.WindTurbine;
    state.layers.tileType[at(5, 3)] = TileType.Plant; // a second plant on the same network
    state.layers.plantType[at(5, 3)] = PlantType.SolarFarm;
    const save = serializeState(state);
    delete save.layers.powerLine;
    const restored = deserializeState(save);
    // Connector from the plant down to the nearest road tile…
    expect(restored.layers.powerLine[at(1, 4)]).not.toBe(0);
    expect(restored.layers.powerLine[at(1, 3)]).toBe(0); // never on the plant itself
    expect(restored.layers.powerLine[at(3, 4)]).not.toBe(0); // the second plant too
    // …and lines along every road reachable from there.
    expect(restored.layers.powerLine[at(1, 5)]).not.toBe(0);
    expect(restored.layers.powerLine[at(3, 5)]).not.toBe(0);
    // A building next to that road is energised again.
    restored.layers.zone[at(3, 7)] = Zone.Residential;
    restored.layers.density[at(3, 7)] = 1;
    recomputeGrid(restored);
    expect(restored.layers.energized[at(3, 7)]).toBe(1);
  });

  it('does not persist the services layer but recomputes it after loading', () => {
    const state = makeState();
    expect(state.layers.services.length).toBe(state.layers.tileType.length);
    const save = serializeState(state);
    expect('services' in save.layers).toBe(false);
    const restored = deserializeState(save);
    expect(restored.layers.services.every((v) => v === 0)).toBe(true);
    expect(restored.lastServices).toEqual({ fire: 0, police: 0 });
  });

  it('grants nothing for a plant with no road in reach', () => {
    const state = makeState();
    state.layers.tileType[at(8, 2)] = TileType.Plant;
    state.layers.plantType[at(8, 2)] = PlantType.WindTurbine;
    const save = serializeState(state);
    delete save.layers.powerLine;
    const restored = deserializeState(save);
    expect(restored.layers.powerLine.some((mask) => mask !== 0)).toBe(false);
  });

  it('leaves a save that has an all-zero line layer alone', () => {
    const state = makeState();
    state.money = 1e9;
    buildRoads(state, [at(1, 2)]);
    state.layers.tileType[at(1, 1)] = TileType.Plant;
    state.layers.plantType[at(1, 1)] = PlantType.WindTurbine;
    const restored = deserializeState(serializeState(state));
    expect(restored.layers.powerLine[at(1, 2)]).toBe(0);
  });

  it('persists season origin, snowpack and insulation', () => {
    const state = makeState();
    state.seasonOriginDay = 12;
    state.weather.snowpack = 0.4;
    state.insulation = true;
    const restored = deserializeState(serializeState(state));
    expect(restored.seasonOriginDay).toBe(12);
    expect(restored.weather.snowpack).toBe(0.4);
    expect(restored.insulation).toBe(true);
  });

  it('persists winter resilience progress', () => {
    const state = makeState();
    state.goalProgress.winterTicks = 1234;
    const restored = deserializeState(serializeState(state));
    expect(restored.goalProgress.winterTicks).toBe(1234);
  });

  it('starts a save without winter progress at zero', () => {
    const state = makeState();
    state.goalProgress.winterTicks = 500;
    const save = serializeState(state);
    delete save.winterTicks;
    expect(deserializeState(save).goalProgress.winterTicks).toBe(0);
  });

  it('persists summer resilience progress', () => {
    const state = makeState();
    state.goalProgress.summerTicks = 777;
    const restored = deserializeState(serializeState(state));
    expect(restored.goalProgress.summerTicks).toBe(777);
  });

  it('starts a save without summer progress at zero', () => {
    const state = makeState();
    state.goalProgress.summerTicks = 500;
    const save = serializeState(state);
    delete save.summerTicks;
    expect(deserializeState(save).goalProgress.summerTicks).toBe(0);
  });

  it('persists free-flow progress', () => {
    const state = makeState();
    state.goalProgress.freeFlowTicks = 777;
    const restored = deserializeState(serializeState(state));
    expect(restored.goalProgress.freeFlowTicks).toBe(777);
  });

  it('starts a save without free-flow progress at zero', () => {
    const state = makeState();
    state.goalProgress.freeFlowTicks = 500;
    const save = serializeState(state);
    delete save.freeFlowTicks;
    expect(deserializeState(save).goalProgress.freeFlowTicks).toBe(0);
  });

  it('persists the well-stocked streak and starts fresh shops at delivery age 0', () => {
    const state = createSimState(1, SIZE);
    state.goalProgress.wellStockedTicks = 77;
    state.layers.deliveryAge[at(1, 1)] = 500;
    const restored = deserializeState(serializeState(state));
    expect(restored.goalProgress.wellStockedTicks).toBe(77);
    expect(restored.layers.deliveryAge[at(1, 1)]).toBe(0);
    expect(restored.vans).toEqual([]);
  });

  it('deliveryStateOfAge buckets by the due and supply windows', () => {
    const day = TICKS_PER_DAY;
    expect(deliveryStateOfAge(0)).toBe(DeliveryState.Supplied);
    expect(deliveryStateOfAge(BALANCE.deliveries.dueAfterDays * day)).toBe(DeliveryState.Supplied);
    expect(deliveryStateOfAge(BALANCE.deliveries.dueAfterDays * day + 1)).toBe(DeliveryState.Due);
    expect(deliveryStateOfAge(BALANCE.deliveries.supplyWindowDays * day + 1)).toBe(
      DeliveryState.Unsupplied,
    );
  });

  it('starts a save without season data on the first spring day', () => {
    const state = makeState();
    state.tick = TICKS_PER_DAY * 37 + 100;
    const save = serializeState(state);
    delete save.seasonOriginDay;
    delete save.snowpack;
    delete save.insulation;
    const restored = deserializeState(save);
    expect(restored.seasonOriginDay).toBe(37);
    expect(restored.season.season).toBe('spring');
    expect(restored.season.dayOfSeason).toBe(1);
    expect(restored.weather.snowpack).toBe(0);
    expect(restored.insulation).toBe(false);
  });

  it('sanitizes hand-edited season fields', () => {
    const state = makeState();
    const save = serializeState(state);
    save.seasonOriginDay = 3.5;
    save.snowpack = 2.5;
    const restored = deserializeState(save);
    expect(restored.seasonOriginDay).toBe(3);
    expect(restored.weather.snowpack).toBe(1);
    save.snowpack = -0.5;
    expect(deserializeState(save).weather.snowpack).toBe(0);
  });

  it('recomputes the season for the loaded tick', () => {
    const state = makeState();
    state.tick = TICKS_PER_DAY * 7;
    const restored = deserializeState(serializeState(state));
    expect(restored.season.season).toBe('summer');
    expect(restored.season.dayOfSeason).toBe(3);
  });

  it('round-trips elevation and recomputes the lake level', () => {
    const state = createSimState(11, 48);
    generateTerrain(state);
    generateWater(state);
    const loaded = deserializeState(serializeState(state));
    expect([...loaded.layers.elevation]).toEqual([...state.layers.elevation]);
    expect(loaded.lakeLevel).toBe(state.lakeLevel);
  });

  it('loads saves without an elevation layer as flat maps', () => {
    const state = createSimState(11, 48);
    const save = serializeState(state);
    delete save.layers.elevation;
    const loaded = deserializeState(save);
    expect(loaded.layers.elevation.every((v) => v === 0)).toBe(true);
    expect(loaded.lakeLevel).toBe(0);
  });

  it('round-trips the road class layer and loads old saves as streets', () => {
    const state = makeState();
    state.layers.tileType[at(1, 1)] = TileType.Road;
    state.layers.roadClass[at(1, 1)] = RoadClass.Avenue;
    const loaded = deserializeState(serializeState(state));
    expect(loaded.layers.roadClass[at(1, 1)]).toBe(RoadClass.Avenue);
    const save = serializeState(state);
    delete save.layers.roadClass;
    expect(deserializeState(save).layers.roadClass.every((v) => v === 0)).toBe(true);
  });

  it('round-trips sea tiles and tidal plants', () => {
    const state = generatedState(1, 64);
    state.money = 1_000_000;
    const tile = findTile(state, (index) => isCoastalSea(state, index));
    placePlant(state, tile, PlantType.TidalPlant);

    const restored = deserializeState(serializeState(state));
    expect([...restored.layers.terrain]).toEqual([...state.layers.terrain]);
    expect(restored.layers.plantType[tile]).toBe(PlantType.TidalPlant);
  });
});

describe('elevation', () => {
  it('starts flat and carries elevation in diffs', () => {
    const state = createSimState(1, 8);
    expect(state.layers.elevation.every((v) => v === 0)).toBe(true);
    state.layers.elevation[10] = 5;
    markDirty(state, 10);
    const diff = collectDiffs(state).find((d) => d.index === 10);
    expect(diff?.elevation).toBe(5);
  });

  it('slopeAt is the largest level difference to a 4-neighbour', () => {
    const state = createSimState(1, 8);
    const center = tileIndex(3, 3, 8);
    state.layers.elevation[center] = 4;
    state.layers.elevation[tileIndex(4, 3, 8)] = 6;
    state.layers.elevation[tileIndex(2, 3, 8)] = 4;
    expect(slopeAt(state, center)).toBe(4);
    expect(slopeAt(state, tileIndex(2, 3, 8))).toBe(4); // vs flat neighbour at 0
  });

  it('slopeAt ignores off-map neighbours', () => {
    const state = createSimState(1, 8);
    state.layers.elevation.fill(7);
    expect(slopeAt(state, tileIndex(0, 0, 8))).toBe(0);
  });

  it('slopeCostMultiplier surcharges sloped tiles only', () => {
    const state = createSimState(1, 8);
    expect(slopeCostMultiplier(state, 0)).toBe(1);
    state.layers.elevation[tileIndex(1, 0, 8)] = 1;
    expect(slopeCostMultiplier(state, 0)).toBe(BALANCE.terrain.slopeCostFactor);
  });
});

describe('geothermal', () => {
  it('carries the geothermal layers in tile diffs', () => {
    const state = createSimState(7, 8);
    state.layers.geothermal[5] = 2;
    state.layers.reservoirHeat[5] = 200;
    markDirty(state, 5);
    const diff = collectDiffs(state).find((d) => d.index === 5);
    expect(diff?.geothermal).toBe(2);
    expect(diff?.reservoirHeat).toBe(200);
  });
});

describe('tooSteep', () => {
  function steepState() {
    const state = createSimState(1, 8);
    // A cliff: centre at 3, east neighbour at 0 -> slope 3 on both tiles.
    state.layers.elevation[tileIndex(3, 3, 8)] = 3;
    return state;
  }

  it('rejects every intent on a steep tile', () => {
    const state = steepState();
    const steep = tileIndex(3, 3, 8);
    expect(buildRejection(state, steep, BuildIntent.Road)).toBe('tooSteep');
    expect(buildRejection(state, steep, BuildIntent.Zone)).toBe('tooSteep');
    expect(buildRejection(state, steep, BuildIntent.Plant, PlantType.SolarFarm)).toBe('tooSteep');
    expect(buildRejection(state, steep, BuildIntent.PowerLine)).toBe('tooSteep');
  });

  it('water rejections win over tooSteep', () => {
    const state = steepState();
    const steep = tileIndex(3, 3, 8);
    state.layers.terrain[steep] = Terrain.Lake;
    expect(buildRejection(state, steep, BuildIntent.Zone)).toBe('cannotBuildOnWater');
  });

  it('a steep river tile cannot carry a bridge', () => {
    const state = steepState();
    const steep = tileIndex(3, 3, 8);
    state.layers.terrain[steep] = Terrain.River;
    expect(buildRejection(state, steep, BuildIntent.Road)).toBe('tooSteep');
  });
});

describe('transit state', () => {
  it('round-trips the bus stop layer and loads old saves without stops', () => {
    const state = makeState();
    state.layers.tileType[at(1, 1)] = TileType.Road;
    state.layers.busStop[at(1, 1)] = 1;
    const loaded = deserializeState(serializeState(state));
    expect(loaded.layers.busStop[at(1, 1)]).toBe(1);
    const save = serializeState(state);
    delete save.layers.busStop;
    expect(deserializeState(save).layers.busStop.every((v) => v === 0)).toBe(true);
  });

  it('persists the modal-shift streak and starts stops, coverage and buses fresh', () => {
    const state = createSimState(1, SIZE);
    state.goalProgress.transitTicks = 33;
    state.layers.stopAge[at(1, 1)] = 500;
    state.layers.transitCover[at(2, 2)] = 1;
    const restored = deserializeState(serializeState(state));
    expect(restored.goalProgress.transitTicks).toBe(33);
    expect(restored.layers.stopAge[at(1, 1)]).toBe(0);
    expect(restored.layers.transitCover[at(2, 2)]).toBe(0);
    expect(restored.buses).toEqual([]);
    const save = serializeState(state);
    delete save.transitTicks;
    expect(deserializeState(save).goalProgress.transitTicks).toBe(0);
  });

  it('stopStateOfAge buckets by the due and service windows', () => {
    const day = TICKS_PER_DAY;
    expect(stopStateOfAge(0)).toBe(StopState.Served);
    const due = Math.round(BALANCE.transit.dueAfterDays * day);
    const window = Math.round(BALANCE.transit.serviceWindowDays * day);
    expect(stopStateOfAge(due)).toBe(StopState.Served);
    expect(stopStateOfAge(due + 1)).toBe(StopState.Due);
    expect(stopStateOfAge(window)).toBe(StopState.Due);
    expect(stopStateOfAge(window + 1)).toBe(StopState.Unserved);
  });

  it('carries busStop, stopState and transitCover in diffs', () => {
    const state = createSimState(1, 8);
    state.layers.tileType[10] = TileType.Road;
    state.layers.busStop[10] = 1;
    state.layers.stopAge[10] = Math.round(BALANCE.transit.serviceWindowDays * TICKS_PER_DAY) + 1;
    state.layers.transitCover[10] = 1;
    markDirty(state, 10);
    state.layers.stopAge[11] = 9999; // no stop here: state stays 0
    markDirty(state, 11);
    const diffs = collectDiffs(state);
    expect(diffs.find((d) => d.index === 10)).toMatchObject({
      busStop: 1,
      stopState: StopState.Unserved,
      transitCover: 1,
    });
    expect(diffs.find((d) => d.index === 11)).toMatchObject({ busStop: 0, stopState: 0 });
  });

  it('a bus depot needs a road neighbour', () => {
    const state = createSimState(1, SIZE);
    expect(buildRejection(state, at(5, 5), BuildIntent.Plant, PlantType.BusDepot)).toBe(
      'needsRoad',
    );
    state.layers.tileType[at(5, 6)] = TileType.Road;
    expect(buildRejection(state, at(5, 5), BuildIntent.Plant, PlantType.BusDepot)).toBeNull();
  });
});
