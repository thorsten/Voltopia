import { describe, expect, it } from 'vitest';
import { BALANCE, TICKS_PER_DAY, TICKS_PER_HISTORY_SAMPLE } from '../shared/constants.ts';
import { neighbors4, tileIndex } from '../shared/grid.ts';
import {
  buildingConsumption,
  censusPlants,
  coolingConsumption,
  energyStep,
  hasPowerInfrastructure,
  heatingConsumption,
  isStation,
  loadProfileFactor,
  placePlant,
} from './energy.ts';
import { buildPowerLines } from './powerLines.ts';
import { buildRoads, bulldozeTiles, undoLastAction } from './roads.ts';
import { isCoastalSea, tideFactor, tidalSiteFactor } from './sea.ts';
import { pendingHistoryPoint } from './tick.ts';
import {
  createSimState,
  PlantType,
  pumpedHeadAt,
  SupplyStatus,
  Terrain,
  TileType,
  totalPumpedStorageCapacity,
  Zone,
  type SimState,
} from './state.ts';
import { generateTerrain } from './terrain.ts';
import { generateWater } from './water.ts';
import { timeOfDay } from './tick.ts';
import { SUNRISE, SUNSET } from './weather.ts';

const SIZE = 32;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);

function makeState(): SimState {
  const state = createSimState(1, SIZE);
  // Neutral baseline so pre-season literal expectations pick up neither
  // heating nor cooling; the heating and cooling tests set their own
  // temperature.
  state.season = { ...state.season, temperature: 18 };
  return state;
}

/** Put a building on a tile directly (bypassing growth). */
function addBuilding(state: SimState, index: number, zone: Zone, density: number): void {
  state.layers.zone[index] = zone;
  state.layers.density[index] = density;
}

/**
 * Set the clock to noon with clear skies for predictable solar output.
 * Also neutralizes the season's day window and solar strength (this
 * state is otherwise created at day 0 midnight, i.e. mid-strength), so
 * pre-existing literal expectations keep their pre-season meaning.
 */
function setNoonClearSky(state: SimState): void {
  state.tick = TICKS_PER_DAY / 2;
  state.weather.cloudCover = 0;
  state.weather.windSpeed = 0;
  state.season = { ...state.season, sunrise: SUNRISE, sunset: SUNSET, solarStrength: 1 };
}

describe('placePlant', () => {
  it('places a plant and charges its cost', () => {
    const state = makeState();
    const before = state.money;
    const result = placePlant(state, at(5, 5), PlantType.SolarFarm);
    expect(result.rejected).toBeUndefined();
    expect(state.layers.tileType[at(5, 5)]).toBe(TileType.Plant);
    expect(state.layers.plantType[at(5, 5)]).toBe(PlantType.SolarFarm);
    expect(state.money).toBe(before - BALANCE.costs.plant[PlantType.SolarFarm]);
  });

  it('charges the slope surcharge on a sloped tile', () => {
    const state = makeState();
    state.layers.elevation[at(6, 5)] = 1; // makes tile (5,5) slope 1
    const before = state.money;
    placePlant(state, at(5, 5), PlantType.SolarFarm);
    expect(before - state.money).toBe(
      Math.round(BALANCE.costs.plant[PlantType.SolarFarm] * BALANCE.terrain.slopeCostFactor),
    );
  });

  it('rejects occupied tiles and missing funds', () => {
    const state = makeState();
    placePlant(state, at(5, 5), PlantType.SolarFarm);
    expect(placePlant(state, at(5, 5), PlantType.WindTurbine).rejected).toBeTruthy();
    state.money = 0;
    expect(placePlant(state, at(6, 6), PlantType.WindTurbine).rejected).toBeTruthy();
  });

  it('can be undone', () => {
    const state = makeState();
    const before = state.money;
    placePlant(state, at(5, 5), PlantType.Battery);
    undoLastAction(state);
    expect(state.layers.tileType[at(5, 5)]).toBe(TileType.Empty);
    expect(state.money).toBe(before);
  });

  it('census counts each plant type', () => {
    const state = makeState();
    placePlant(state, at(1, 1), PlantType.SolarFarm);
    placePlant(state, at(2, 1), PlantType.WindTurbine);
    placePlant(state, at(3, 1), PlantType.Battery);
    placePlant(state, at(4, 1), PlantType.BiogasPlant);
    placePlant(state, at(5, 1), PlantType.ChargingHub);
    const census = censusPlants(state);
    expect(census.solarFarms).toBe(1);
    expect(census.windTurbines).toBe(1);
    expect(census.batteries).toBe(1);
    expect(census.biogasPlants).toBe(1);
    expect(census.chargingHubs).toBe(1);
  });

  it('places run-of-river only on river tiles', () => {
    const state = makeState();
    expect(placePlant(state, at(5, 5), PlantType.RunOfRiver).rejected).toBe('needsRiverTile');
    state.layers.terrain[at(5, 5)] = Terrain.River;
    expect(placePlant(state, at(5, 5), PlantType.RunOfRiver).rejected).toBeUndefined();
    expect(state.layers.plantType[at(5, 5)]).toBe(PlantType.RunOfRiver);
  });

  it('places pumped storage only on the lake shore and never on water', () => {
    const state = makeState();
    state.layers.terrain[at(8, 8)] = Terrain.Lake;
    expect(placePlant(state, at(2, 2), PlantType.PumpedStorage).rejected).toBe('needsLakeShore');
    expect(placePlant(state, at(8, 8), PlantType.PumpedStorage).rejected).toBe(
      'cannotBuildOnWater',
    );
    expect(placePlant(state, at(8, 7), PlantType.PumpedStorage).rejected).toBeUndefined();
    expect(placePlant(state, at(8, 8), PlantType.SolarFarm).rejected).toBe('cannotBuildOnWater');
  });

  it('census counts hydro plants as supply sources', () => {
    const state = makeState();
    state.layers.terrain[at(5, 5)] = Terrain.River;
    state.layers.terrain[at(8, 8)] = Terrain.Lake;
    placePlant(state, at(5, 5), PlantType.RunOfRiver);
    placePlant(state, at(8, 7), PlantType.PumpedStorage);
    const census = censusPlants(state);
    expect(census.runOfRiverPlants).toBe(1);
    expect(census.pumpedStoragePlants).toBe(1);
  });
});

describe('load profiles', () => {
  it('residential peaks in the evening, commercial during the day', () => {
    const evening = 19.5 / 24;
    const noon = 12 / 24;
    const night = 3 / 24;
    expect(loadProfileFactor(Zone.Residential, evening)).toBeGreaterThan(
      loadProfileFactor(Zone.Residential, noon),
    );
    expect(loadProfileFactor(Zone.Commercial, noon)).toBeGreaterThan(
      loadProfileFactor(Zone.Commercial, evening),
    );
    expect(loadProfileFactor(Zone.Residential, night)).toBeLessThan(0.4);
  });

  it('interpolates smoothly between hours', () => {
    const a = loadProfileFactor(Zone.Residential, 18 / 24);
    const b = loadProfileFactor(Zone.Residential, 18.5 / 24);
    const c = loadProfileFactor(Zone.Residential, 19 / 24);
    expect(b).toBeGreaterThan(Math.min(a, c) - 1e-9);
    expect(b).toBeLessThan(Math.max(a, c) + 1e-9);
  });

  it('building consumption scales with density', () => {
    const noon = 0.5;
    expect(buildingConsumption(Zone.Residential, 3, noon)).toBeGreaterThan(
      buildingConsumption(Zone.Residential, 1, noon),
    );
    expect(buildingConsumption(Zone.None, 1, noon)).toBe(0);
  });
});

describe('energyStep', () => {
  it('solar generates at noon, nothing at night', () => {
    const state = makeState();
    placePlant(state, at(5, 5), PlantType.SolarFarm);
    setNoonClearSky(state);
    energyStep(state, { chargingDemand: 0 });
    expect(state.lastEnergy.solar).toBeCloseTo(BALANCE.energy.solarPeakOutput, 3);
    state.tick = 0; // midnight
    energyStep(state, { chargingDemand: 0 });
    expect(state.lastEnergy.solar).toBe(0);
  });

  it('wind output follows wind speed', () => {
    const state = makeState();
    placePlant(state, at(5, 5), PlantType.WindTurbine);
    state.weather.windSpeed = 0;
    energyStep(state, { chargingDemand: 0 });
    expect(state.lastEnergy.wind).toBe(0);
    state.weather.windSpeed = 1;
    energyStep(state, { chargingDemand: 0 });
    expect(state.lastEnergy.wind).toBeCloseTo(BALANCE.energy.windPeakOutput, 3);
  });

  it('surplus charges the battery first, then curtails', () => {
    const state = makeState();
    placePlant(state, at(5, 5), PlantType.SolarFarm);
    placePlant(state, at(6, 5), PlantType.Battery);
    setNoonClearSky(state);
    energyStep(state, { chargingDemand: 0 });
    const expectedCharge =
      Math.min(BALANCE.energy.solarPeakOutput, BALANCE.energy.batteryPowerLimit) *
      BALANCE.energy.batteryChargeEfficiency;
    expect(state.storedEnergy).toBeCloseTo(expectedCharge, 3);
    // Charge rate is limited; the rest is exported, then curtailed.
    const leftover = BALANCE.energy.solarPeakOutput - BALANCE.energy.batteryPowerLimit;
    expect(state.lastEnergy.gridExport).toBeCloseTo(
      Math.min(leftover, BALANCE.market.exportCapacity),
      3,
    );
    expect(state.lastEnergy.curtailment).toBeCloseTo(
      Math.max(0, leftover - BALANCE.market.exportCapacity),
      3,
    );
  });

  it('with full storage, surplus is exported up to the link capacity', () => {
    const state = makeState();
    placePlant(state, at(5, 5), PlantType.SolarFarm);
    placePlant(state, at(6, 5), PlantType.Battery);
    setNoonClearSky(state);
    state.storedEnergy = BALANCE.energy.batteryCapacity;
    energyStep(state, { chargingDemand: 0 });
    expect(state.lastEnergy.gridExport).toBeCloseTo(
      Math.min(BALANCE.energy.solarPeakOutput, BALANCE.market.exportCapacity),
      3,
    );
    expect(state.lastEnergy.curtailment).toBeCloseTo(
      Math.max(0, BALANCE.energy.solarPeakOutput - BALANCE.market.exportCapacity),
      3,
    );
    expect(state.storedEnergy).toBe(BALANCE.energy.batteryCapacity);
  });

  it('deficit discharges the battery before dispatching biogas', () => {
    const state = makeState();
    placePlant(state, at(5, 5), PlantType.Battery);
    placePlant(state, at(6, 5), PlantType.BiogasPlant);
    addBuilding(state, at(7, 5), Zone.Commercial, 3);
    state.tick = TICKS_PER_DAY / 2; // noon: commercial peak
    state.weather.cloudCover = 1;
    state.weather.windSpeed = 0;
    state.storedEnergy = 100;
    energyStep(state, { chargingDemand: 0 });
    const demand = state.lastEnergy.buildingConsumption;
    const rooftop = state.lastEnergy.rooftop;
    expect(demand).toBeGreaterThan(0);
    expect(state.storedEnergy).toBeCloseTo(100 - (demand - rooftop), 3);
    expect(state.lastEnergy.biogas).toBe(0);
    expect(state.lastEnergy.deficit).toBe(0);
  });

  it('dispatches biogas when the battery is empty', () => {
    const state = makeState();
    placePlant(state, at(6, 5), PlantType.BiogasPlant);
    addBuilding(state, at(7, 5), Zone.Commercial, 3);
    state.tick = TICKS_PER_DAY / 2;
    state.weather.cloudCover = 1;
    state.weather.windSpeed = 0;
    energyStep(state, { chargingDemand: 0 });
    expect(state.lastEnergy.biogas).toBeCloseTo(
      state.lastEnergy.buildingConsumption - state.lastEnergy.rooftop,
      3,
    );
    expect(state.lastEnergy.deficit).toBe(0);
  });

  it('flags undersupply when even imports cannot cover the deficit', () => {
    const state = makeState();
    placePlant(state, at(6, 5), PlantType.WindTurbine); // provides connection
    state.weather.windSpeed = 0; // ...but no output
    const buildings = 20;
    // 7 columns x 3 rows, all strictly north of the plant's row so none
    // land on the plant tile itself, and all within lineSupplyRadius.
    for (let i = 0; i < buildings; i++) {
      addBuilding(state, at(3 + (i % 7), 2 + Math.floor(i / 7)), Zone.Commercial, 3);
    }
    state.tick = TICKS_PER_DAY / 2;
    state.weather.cloudCover = 1;
    energyStep(state, { chargingDemand: 0 });
    // The transmission link imports at its capacity; the rest is deficit.
    expect(state.lastEnergy.gridImport).toBeCloseTo(BALANCE.market.importCapacity, 3);
    expect(state.lastEnergy.deficit).toBeCloseTo(
      state.lastEnergy.buildingConsumption -
        state.lastEnergy.rooftop -
        BALANCE.market.importCapacity,
      3,
    );
    // A majority of connected buildings flicker into undersupply.
    let undersupplied = 0;
    for (let i = 0; i < buildings; i++) {
      const tile = at(3 + (i % 7), 2 + Math.floor(i / 7));
      if (state.layers.supplied[tile] === SupplyStatus.Undersupplied) {
        undersupplied++;
      }
    }
    expect(undersupplied).toBeGreaterThan(buildings / 3);
  });

  it('small deficits are fully covered by (expensive) imports', () => {
    const state = makeState();
    placePlant(state, at(6, 5), PlantType.WindTurbine);
    state.weather.windSpeed = 0;
    addBuilding(state, at(8, 5), Zone.Commercial, 3);
    state.tick = TICKS_PER_DAY / 2;
    state.weather.cloudCover = 1;
    energyStep(state, { chargingDemand: 0 });
    expect(state.lastEnergy.deficit).toBe(0);
    expect(state.lastEnergy.gridImport).toBeGreaterThan(0);
    expect(state.layers.supplied[at(8, 5)]).toBe(SupplyStatus.Supplied);
  });

  it('marks buildings beyond the connection radius of any plant as not connected', () => {
    const state = makeState();
    placePlant(state, at(0, 0), PlantType.WindTurbine);
    const inside = at(BALANCE.energy.lineSupplyRadius, 0);
    const outside = at(BALANCE.energy.lineSupplyRadius + 2, 0);
    addBuilding(state, inside, Zone.Residential, 1);
    addBuilding(state, outside, Zone.Residential, 1);
    state.weather.windSpeed = 1; // plenty of power
    energyStep(state, { chargingDemand: 0 });
    expect(state.layers.supplied[inside]).toBe(SupplyStatus.Supplied);
    expect(state.layers.supplied[outside]).toBe(SupplyStatus.NotConnected);
    // Unconnected buildings do not draw from the grid.
    expect(state.lastEnergy.buildingConsumption).toBeCloseTo(
      buildingConsumption(Zone.Residential, 1, 0),
      3,
    );
  });

  it('drops the supply when the plant is bulldozed', () => {
    const state = makeState();
    placePlant(state, at(5, 5), PlantType.WindTurbine);
    const building = at(6, 5);
    addBuilding(state, building, Zone.Residential, 1);
    state.weather.windSpeed = 1;
    energyStep(state, { chargingDemand: 0 });
    expect(state.layers.supplied[building]).toBe(SupplyStatus.Supplied);
    bulldozeTiles(state, [at(5, 5)]);
    energyStep(state, { chargingDemand: 0 });
    expect(state.layers.supplied[building]).toBe(SupplyStatus.NotConnected);
  });

  it('a power line from the plant connects a distant building', () => {
    const state = makeState();
    placePlant(state, at(0, 0), PlantType.WindTurbine);
    const far = at(12, 0);
    addBuilding(state, far, Zone.Residential, 1);
    state.weather.windSpeed = 1;
    energyStep(state, { chargingDemand: 0 });
    expect(state.layers.supplied[far]).toBe(SupplyStatus.NotConnected);
    state.money = 1e9;
    buildPowerLines(
      state,
      Array.from({ length: 9 }, (_, i) => at(1 + i, 0)),
    ); // x 1..9
    energyStep(state, { chargingDemand: 0 });
    expect(state.layers.supplied[far]).toBe(SupplyStatus.Supplied);
  });

  it('serves charging demand and accounts it separately', () => {
    const state = makeState();
    placePlant(state, at(5, 5), PlantType.WindTurbine);
    state.weather.windSpeed = 1;
    energyStep(state, { chargingDemand: 10 });
    expect(state.lastEnergy.chargingConsumption).toBe(10);
    const surplus = BALANCE.energy.windPeakOutput - 10;
    expect(state.lastEnergy.gridExport).toBeCloseTo(
      Math.min(surplus, BALANCE.market.exportCapacity),
      3,
    );
    expect(state.lastEnergy.curtailment).toBeCloseTo(
      Math.max(0, surplus - BALANCE.market.exportCapacity),
      3,
    );
  });

  it('rooftop PV feeds in from dense connected buildings at noon', () => {
    const state = makeState();
    placePlant(state, at(5, 5), PlantType.WindTurbine); // provides connection
    addBuilding(state, at(7, 5), Zone.Residential, 3);
    addBuilding(state, at(8, 5), Zone.Residential, 1); // no rooftop yet
    setNoonClearSky(state);
    energyStep(state, { chargingDemand: 0 });
    expect(state.lastEnergy.rooftop).toBeCloseTo(BALANCE.energy.rooftopSolarPeakByDensity[3], 3);
    // At night there is no rooftop feed-in.
    state.tick = 0;
    energyStep(state, { chargingDemand: 0 });
    expect(state.lastEnergy.rooftop).toBe(0);
  });

  it('unconnected buildings do not feed rooftop PV into the grid', () => {
    const state = makeState();
    placePlant(state, at(0, 0), PlantType.WindTurbine);
    const outside = at(BALANCE.energy.lineSupplyRadius + 3, 20);
    addBuilding(state, outside, Zone.Residential, 3);
    setNoonClearSky(state);
    energyStep(state, { chargingDemand: 0 });
    expect(state.lastEnergy.rooftop).toBe(0);
  });

  /** Total generation of the last tick, as the history records it. */
  function tickGeneration(state: SimState): number {
    const e = state.lastEnergy;
    return e.solar + e.wind + e.rooftop + e.hydro + e.biogas;
  }

  it('history samples average the window instead of snapshotting the last tick', () => {
    const state = makeState();
    placePlant(state, at(5, 5), PlantType.SolarFarm);
    state.weather.cloudCover = 0;
    // Start at 06:00 (a sample boundary), so the window covers the sunrise
    // ramp and per-tick output actually differs within it.
    state.tick = TICKS_PER_DAY / 4;
    const perTick: number[] = [];
    for (let i = 0; i < TICKS_PER_HISTORY_SAMPLE; i++) {
      state.tick++;
      energyStep(state, { chargingDemand: 0 });
      perTick.push(tickGeneration(state));
    }
    expect(new Set(perTick).size).toBeGreaterThan(1);
    expect(state.energyHistory).toHaveLength(1);
    const mean = perTick.reduce((sum, v) => sum + v, 0) / perTick.length;
    expect(state.energyHistory[0].generation).toBeCloseTo(mean, 6);
    expect(state.energyHistory[0].generation).not.toBe(perTick[perTick.length - 1]);
    // The window was flushed, so the next sample starts from scratch.
    expect(state.energyHistoryAccum.ticks).toBe(0);
  });

  it('exposes the in-progress sample average, landing exactly on the next sample', () => {
    const state = makeState();
    placePlant(state, at(5, 5), PlantType.SolarFarm);
    state.weather.cloudCover = 0;
    state.tick = TICKS_PER_DAY / 4;
    const perTick: number[] = [];
    const partial = 5;
    for (let i = 0; i < partial; i++) {
      state.tick++;
      energyStep(state, { chargingDemand: 0 });
      perTick.push(tickGeneration(state));
    }
    const mean = perTick.reduce((sum, v) => sum + v, 0) / partial;
    expect(pendingHistoryPoint(state).generation).toBeCloseTo(mean, 6);

    for (let i = partial; i < TICKS_PER_HISTORY_SAMPLE; i++) {
      state.tick++;
      energyStep(state, { chargingDemand: 0 });
    }
    // Flush tick: nothing accumulated yet, so pending sits on the fresh sample.
    expect(pendingHistoryPoint(state)).toEqual(state.energyHistory[state.energyHistory.length - 1]);
    // And with no history at all it is simply empty.
    expect(pendingHistoryPoint(makeState())).toEqual({
      generation: 0,
      consumption: 0,
      stateOfCharge: 0,
      price: 1,
    });
  });

  it('records energy history samples', () => {
    const state = makeState();
    placePlant(state, at(5, 5), PlantType.WindTurbine);
    for (let i = 0; i < 200; i++) {
      state.tick++;
      energyStep(state, { chargingDemand: 0 });
    }
    expect(state.energyHistory.length).toBeGreaterThan(0);
    for (const point of state.energyHistory) {
      expect(point.generation).toBeGreaterThanOrEqual(0);
      expect(point.stateOfCharge).toBeGreaterThanOrEqual(0);
      expect(point.stateOfCharge).toBeLessThanOrEqual(1);
    }
  });
});

describe('hydro and pumped storage', () => {
  function riverState(): SimState {
    const state = makeState();
    state.tick = 0; // midnight: no solar
    state.weather.cloudCover = 0;
    state.weather.windSpeed = 0;
    state.layers.terrain[at(5, 5)] = Terrain.River;
    state.layers.terrain[at(8, 8)] = Terrain.Lake;
    return state;
  }

  it('run-of-river generates day and night, scaled by river flow', () => {
    const state = riverState();
    placePlant(state, at(5, 5), PlantType.RunOfRiver);
    state.weather.riverFlow = 1;
    energyStep(state, { chargingDemand: 0 });
    expect(state.lastEnergy.hydro).toBeCloseTo(BALANCE.energy.hydroPeakOutput, 6);
    state.weather.riverFlow = 0;
    energyStep(state, { chargingDemand: 0 });
    expect(state.lastEnergy.hydro).toBeCloseTo(
      BALANCE.energy.hydroPeakOutput * BALANCE.water.minFlowFactor,
      6,
    );
  });

  it('charges batteries before pumped storage and exports the rest', () => {
    const state = riverState();
    placePlant(state, at(5, 5), PlantType.RunOfRiver);
    placePlant(state, at(8, 7), PlantType.PumpedStorage);
    placePlant(state, at(2, 2), PlantType.Battery);
    state.weather.riverFlow = 1;
    state.money = 1e9;
    // Batteries take up to their power limit first.
    energyStep(state, { chargingDemand: 0 });
    const hydro = BALANCE.energy.hydroPeakOutput;
    const batteryTake = Math.min(hydro, BALANCE.energy.batteryPowerLimit);
    expect(state.storedEnergy).toBeCloseTo(batteryTake * BALANCE.energy.batteryChargeEfficiency, 6);
    expect(state.pumpedStorageEnergy).toBeCloseTo(
      (hydro - batteryTake) * BALANCE.energy.pumpedStorageChargeEfficiency,
      6,
    );
    // Fill the battery; the pumped pool absorbs the whole surplus next.
    state.storedEnergy = BALANCE.energy.batteryCapacity;
    const pumpedBefore = state.pumpedStorageEnergy;
    energyStep(state, { chargingDemand: 0 });
    expect(state.pumpedStorageEnergy).toBeCloseTo(
      pumpedBefore + hydro * BALANCE.energy.pumpedStorageChargeEfficiency,
      6,
    );
    expect(state.lastEnergy.gridExport).toBe(0);
    expect(state.lastEnergy.curtailment).toBe(0);
  });

  it('discharges batteries before pumped storage before biogas', () => {
    const state = riverState();
    placePlant(state, at(8, 7), PlantType.PumpedStorage);
    placePlant(state, at(2, 2), PlantType.Battery);
    placePlant(state, at(3, 2), PlantType.BiogasPlant);
    addBuilding(state, at(4, 2), Zone.Commercial, 3);
    state.storedEnergy = 10;
    state.pumpedStorageEnergy = 1_000;
    energyStep(state, { chargingDemand: 300 });
    expect(state.storedEnergy).toBe(0);
    expect(state.pumpedStorageEnergy).toBeLessThan(1_000);
    expect(state.pumpedStorageEnergy).toBeGreaterThanOrEqual(
      1_000 - BALANCE.energy.pumpedStoragePowerLimit,
    );
    expect(state.lastEnergy.biogas).toBeGreaterThan(0);
  });

  it('clamps pumped storage to installed capacity', () => {
    const state = riverState();
    placePlant(state, at(8, 7), PlantType.PumpedStorage);
    state.pumpedStorageEnergy = 1e9;
    energyStep(state, { chargingDemand: 0 });
    expect(state.pumpedStorageEnergy).toBeLessThanOrEqual(BALANCE.energy.pumpedStorageCapacity);
    const noPlants = makeState();
    noPlants.pumpedStorageEnergy = 500;
    energyStep(noPlants, { chargingDemand: 0 });
    expect(noPlants.pumpedStorageEnergy).toBe(0);
  });

  it('history state of charge combines both pools', () => {
    const state = riverState();
    placePlant(state, at(8, 7), PlantType.PumpedStorage);
    placePlant(state, at(2, 2), PlantType.Battery);
    state.storedEnergy = BALANCE.energy.batteryCapacity;
    state.pumpedStorageEnergy = 0;
    state.tick = TICKS_PER_DAY; // multiple of the history sample interval, midnight
    energyStep(state, { chargingDemand: 0 });
    const last = state.energyHistory[state.energyHistory.length - 1];
    const combined =
      state.storedEnergy / (BALANCE.energy.batteryCapacity + BALANCE.energy.pumpedStorageCapacity);
    expect(last.stateOfCharge).toBeCloseTo(combined, 6);
  });
});

describe('terrain energy bonuses', () => {
  /**
   * Drop the plant straight onto the tile, bypassing `placePlant`'s slope
   * check: the drop/head tests below only set the plant tile's own
   * elevation (not every neighbour), which the build-slope rule would
   * otherwise reject.
   */
  function placeDirect(state: SimState, index: number, plant: PlantType): void {
    state.layers.tileType[index] = TileType.Plant;
    state.layers.plantType[index] = plant;
  }

  it('flat maps reproduce the unbonused outputs', () => {
    const state = makeState();
    placePlant(state, at(3, 3), PlantType.WindTurbine);
    state.weather.windSpeed = 1;
    energyStep(state, { chargingDemand: 0 });
    expect(state.lastEnergy.wind).toBeCloseTo(BALANCE.energy.windPeakOutput);
  });

  it('wind turbines earn the elevation bonus', () => {
    const state = makeState();
    const tile = at(3, 3);
    state.layers.elevation[tile] = 7;
    // Keep the tile buildable for the placement helper: raise neighbours too.
    for (const n of neighbors4(tile, SIZE)) state.layers.elevation[n] = 7;
    placePlant(state, tile, PlantType.WindTurbine);
    state.weather.windSpeed = 1;
    energyStep(state, { chargingDemand: 0 });
    expect(state.lastEnergy.wind).toBeCloseTo(
      BALANCE.energy.windPeakOutput * (1 + BALANCE.terrain.windBonusPerLevel * 7),
    );
  });

  it('run-of-river earns the drop bonus', () => {
    const state = makeState();
    const tile = at(3, 3);
    const downstream = at(3, 4);
    state.layers.terrain[tile] = Terrain.River;
    state.layers.terrain[downstream] = Terrain.River;
    state.layers.elevation[tile] = 2; // drop of 2 to the downstream tile at 0
    placeDirect(state, tile, PlantType.RunOfRiver);
    state.weather.riverFlow = 1;
    energyStep(state, { chargingDemand: 0 });
    expect(state.lastEnergy.hydro).toBeCloseTo(
      BALANCE.energy.hydroPeakOutput * (1 + BALANCE.terrain.hydroDropBonus * 2),
    );
  });

  it('does not gain a drop bonus from a neighbouring sea tile at the river mouth', () => {
    const state = makeState();
    const tile = at(3, 3);
    const downstream = at(3, 4);
    const seaNeighbor = at(4, 3);
    state.layers.terrain[tile] = Terrain.River;
    state.layers.terrain[downstream] = Terrain.River;
    state.layers.terrain[seaNeighbor] = Terrain.Sea;
    // Same elevation as the river continuation: no natural drop here.
    // The sea is pinned to 0, well below — without excluding it from
    // riverDropAt this would fabricate a drop the river never had.
    state.layers.elevation[tile] = 2;
    state.layers.elevation[downstream] = 2;
    state.layers.elevation[seaNeighbor] = 0;
    placeDirect(state, tile, PlantType.RunOfRiver);
    state.weather.riverFlow = 1;
    energyStep(state, { chargingDemand: 0 });
    expect(state.lastEnergy.hydro).toBeCloseTo(BALANCE.energy.hydroPeakOutput);
  });

  it('pumped storage capacity grows with the nearby hilltop above the lake', () => {
    const state = makeState();
    const shore = at(3, 3);
    state.layers.terrain[at(3, 4)] = Terrain.Lake;
    // The shore tile itself is barely above the lake; the upper reservoir
    // sits on the hill two tiles away (within headRadius = 2).
    state.layers.elevation[shore] = 1;
    state.layers.elevation[at(5, 3)] = 5;
    state.lakeLevel = 1; // head = 5 - 1 = 4, from the hilltop
    placeDirect(state, shore, PlantType.PumpedStorage);
    const factor = 1 + BALANCE.terrain.headBonusPerLevel * 4;
    expect(totalPumpedStorageCapacity(state)).toBeCloseTo(
      BALANCE.energy.pumpedStorageCapacity * factor,
    );
    // The clamp uses the boosted capacity.
    state.pumpedStorageEnergy = BALANCE.energy.pumpedStorageCapacity * factor + 500;
    energyStep(state, { chargingDemand: 0 });
    expect(state.pumpedStorageEnergy).toBeLessThanOrEqual(
      BALANCE.energy.pumpedStorageCapacity * factor,
    );
  });

  it('ignores hills beyond the head radius', () => {
    const state = makeState();
    const shore = at(3, 3);
    state.layers.terrain[at(3, 4)] = Terrain.Lake;
    state.layers.elevation[shore] = 2;
    // Three tiles away: outside headRadius = 2, so it must not count.
    state.layers.elevation[at(6, 3)] = 7;
    state.lakeLevel = 1; // head = 2 - 1 = 1, from the shore tile itself
    placeDirect(state, shore, PlantType.PumpedStorage);
    expect(totalPumpedStorageCapacity(state)).toBeCloseTo(
      BALANCE.energy.pumpedStorageCapacity * (1 + BALANCE.terrain.headBonusPerLevel * 1),
    );
  });

  it('gives no head bonus on a flat map', () => {
    const state = makeState();
    const shore = at(3, 3);
    state.layers.terrain[at(3, 4)] = Terrain.Lake;
    placeDirect(state, shore, PlantType.PumpedStorage);
    expect(pumpedHeadAt(state, shore)).toBe(0);
    expect(totalPumpedStorageCapacity(state)).toBeCloseTo(BALANCE.energy.pumpedStorageCapacity);
  });
});

describe('tidal plants', () => {
  /** A generated map: elevation and water (river, lake, sea) but no zoning. */
  function generatedState(seed: number, size: number): SimState {
    const state = createSimState(seed, size);
    generateTerrain(state);
    generateWater(state);
    return state;
  }

  /** First coastal sea tile on the map — where a tidal plant may stand. */
  function firstCoastalSeaTile(state: SimState): number {
    for (let i = 0; i < state.layers.terrain.length; i++) {
      if (isCoastalSea(state, i)) return i;
    }
    throw new Error('no coastal sea tile on this map');
  }

  it('generates from tidal plants and follows the tide', () => {
    const state = generatedState(1, 64);
    const tile = firstCoastalSeaTile(state);
    state.money = 1_000_000;
    expect(placePlant(state, tile, PlantType.TidalPlant).rejected).toBeUndefined();

    // Slack water at tick 0, strong current a quarter period later.
    state.tick = 0;
    energyStep(state, { chargingDemand: 0 });
    expect(state.lastEnergy.tidal).toBeCloseTo(0, 5);

    state.tick = Math.round(TICKS_PER_DAY * (12.42 / 24) * 0.25);
    energyStep(state, { chargingDemand: 0 });
    expect(state.lastEnergy.tidal).toBeGreaterThan(BALANCE.energy.tidalPeakOutput * 0.7);
  });

  it('scales tidal output with the site factor', () => {
    const state = generatedState(2, 64);
    const tile = firstCoastalSeaTile(state);
    state.money = 1_000_000;
    placePlant(state, tile, PlantType.TidalPlant);
    state.tick = Math.round(TICKS_PER_DAY * (12.42 / 24) * 0.25);
    energyStep(state, { chargingDemand: 0 });
    const expected =
      BALANCE.energy.tidalPeakOutput * tidalSiteFactor(state, tile) * tideFactor(state.tick);
    expect(state.lastEnergy.tidal).toBeCloseTo(expected, 5);
  });

  it('census counts tidal plants and sums their site factors', () => {
    const state = generatedState(3, 64);
    const tile = firstCoastalSeaTile(state);
    state.money = 1_000_000;
    placePlant(state, tile, PlantType.TidalPlant);
    const census = censusPlants(state);
    expect(census.tidalPlants).toBe(1);
    expect(census.tidalCapacity).toBeCloseTo(tidalSiteFactor(state, tile), 6);
  });

  it("tidalCapacity sums each plant's own site factor, not count times one factor", () => {
    const state = makeState();
    state.money = 1_000_000;

    // Tile A: fully enclosed by land (all 8 neighbours land) — maximum
    // narrowness, the strongest possible current.
    const tileA = at(5, 5);
    state.layers.terrain[tileA] = Terrain.Sea;

    // Tile B: open water except for one land neighbour — just enough to
    // be coastal, but the weakest possible current.
    const tileB = at(20, 20);
    state.layers.terrain[tileB] = Terrain.Sea;
    for (const [dx, dy] of [
      [-1, -1],
      [0, -1],
      [1, -1],
      [-1, 0],
      [-1, 1],
      [0, 1],
      [1, 1],
    ]) {
      state.layers.terrain[at(20 + dx, 20 + dy)] = Terrain.Sea;
    }
    // (21, 20) is left as land, so tileB stays coastal.

    const factorA = tidalSiteFactor(state, tileA);
    const factorB = tidalSiteFactor(state, tileB);
    expect(factorA).not.toBeCloseTo(factorB, 2); // the sites must genuinely differ

    expect(placePlant(state, tileA, PlantType.TidalPlant).rejected).toBeUndefined();
    expect(placePlant(state, tileB, PlantType.TidalPlant).rejected).toBeUndefined();

    const census = censusPlants(state);
    expect(census.tidalPlants).toBe(2);
    // Sum of the two distinct factors — not 2 * either one.
    expect(census.tidalCapacity).toBeCloseTo(factorA + factorB, 6);
    expect(census.tidalCapacity).not.toBeCloseTo(2 * factorA, 2);
    expect(census.tidalCapacity).not.toBeCloseTo(2 * factorB, 2);
  });
});

describe('offshore wind', () => {
  /** A generated map: elevation and water (river, lake, sea) but no zoning. */
  function generatedState(seed: number, size: number): SimState {
    const state = createSimState(seed, size);
    generateTerrain(state);
    generateWater(state);
    return state;
  }

  /** First sea tile on this map. */
  function firstSeaTile(state: SimState): number {
    for (let i = 0; i < state.layers.terrain.length; i++) {
      if (state.layers.terrain[i] === Terrain.Sea) return i;
    }
    throw new Error('no sea tile on this map');
  }

  it('gives offshore turbines their bonus instead of the elevation bonus', () => {
    const state = generatedState(1, 64);
    state.money = 1_000_000;
    const sea = firstSeaTile(state);
    expect(placePlant(state, sea, PlantType.WindTurbine).rejected).toBeUndefined();
    const census = censusPlants(state);
    expect(census.windCapacity).toBeCloseTo(1 + BALANCE.sea.offshoreWindBonus, 5);
  });

  it('charges the offshore surcharge for building at sea', () => {
    const state = generatedState(1, 64);
    state.money = 1_000_000;
    const before = state.money;
    const sea = firstSeaTile(state);
    expect(placePlant(state, sea, PlantType.WindTurbine).rejected).toBeUndefined();
    const expected = Math.round(
      BALANCE.costs.plant[PlantType.WindTurbine] * BALANCE.sea.offshoreCostFactor,
    );
    expect(before - state.money).toBe(expected);
  });

  it('does not charge the offshore surcharge for a tidal plant', () => {
    const state = generatedState(1, 64);
    state.money = 1_000_000;
    const before = state.money;
    let tile = -1;
    for (let i = 0; i < state.layers.terrain.length; i++) {
      if (isCoastalSea(state, i)) {
        tile = i;
        break;
      }
    }
    expect(tile).toBeGreaterThanOrEqual(0);
    expect(placePlant(state, tile, PlantType.TidalPlant).rejected).toBeUndefined();
    expect(before - state.money).toBe(BALANCE.costs.plant[PlantType.TidalPlant]);
  });
});

describe('heating load', () => {
  const { comfortTemperature, heatingRange, weightByZone, insulationFactor } =
    BALANCE.seasons.heating;
  const base = BALANCE.energy.consumptionByZoneAndDensity[Zone.Residential][2];

  it('is zero above the comfort temperature', () => {
    expect(heatingConsumption(Zone.Residential, 2, comfortTemperature + 1, false)).toBe(0);
  });

  it('reaches the full zone weight at the bottom of the range', () => {
    const cold = comfortTemperature - heatingRange;
    expect(heatingConsumption(Zone.Residential, 2, cold, false)).toBeCloseTo(
      base * weightByZone[Zone.Residential],
      9,
    );
    expect(heatingConsumption(Zone.Commercial, 2, cold, false)).toBeCloseTo(
      BALANCE.energy.consumptionByZoneAndDensity[Zone.Commercial][2] *
        weightByZone[Zone.Commercial],
      9,
    );
  });

  it('is halved by insulation', () => {
    const cold = comfortTemperature - heatingRange;
    const plain = heatingConsumption(Zone.Residential, 3, cold, false);
    expect(heatingConsumption(Zone.Residential, 3, cold, true)).toBeCloseTo(
      plain * insulationFactor,
      9,
    );
  });

  it('is reported separately and counts toward the balance', () => {
    const state = makeState();
    setNoonClearSky(state);
    state.season = { ...state.season, temperature: comfortTemperature - heatingRange };
    placePlant(state, at(5, 5), PlantType.WindTurbine);
    addBuilding(state, at(6, 5), Zone.Residential, 2);
    buildPowerLines(state, [at(6, 6)]);
    energyStep(state, { chargingDemand: 0 });
    const heating = state.lastEnergy.heatingConsumption;
    expect(heating).toBeCloseTo(base * weightByZone[Zone.Residential], 6);
    expect(state.lastEnergy.buildingConsumption).toBeCloseTo(
      buildingConsumption(Zone.Residential, 2, timeOfDay(state.tick)),
      6,
    );
    // The wind turbine produces nothing (windSpeed 0); only rooftop PV
    // generates. The shortfall (buildings + heating - rooftop) is small,
    // so it is fully covered by the (expensive) import link rather than
    // showing up as a deficit — see "small deficits are fully covered by
    // imports" above. This still proves heating counts toward the balance.
    expect(state.lastEnergy.gridImport).toBeCloseTo(
      state.lastEnergy.buildingConsumption + heating - state.lastEnergy.rooftop,
      6,
    );
    expect(state.lastEnergy.deficit).toBe(0);
  });

  it('winter noon PV is weaker than summer noon PV under a clear sky', () => {
    const summer = makeState();
    setNoonClearSky(summer);
    summer.season = { ...summer.season, sunrise: 0.2, sunset: 0.8, solarStrength: 1 };
    placePlant(summer, at(5, 5), PlantType.SolarFarm);
    energyStep(summer, { chargingDemand: 0 });
    const winter = makeState();
    setNoonClearSky(winter);
    winter.season = { ...winter.season, sunrise: 0.3, sunset: 0.7, solarStrength: 0.45 };
    placePlant(winter, at(5, 5), PlantType.SolarFarm);
    energyStep(winter, { chargingDemand: 0 });
    expect(winter.lastEnergy.solar).toBeLessThan(summer.lastEnergy.solar * 0.5);
  });
});

describe('cooling load', () => {
  const { comfortTemperature, coolingRange, weightByZone, insulationFactor } =
    BALANCE.seasons.cooling;
  const base = BALANCE.energy.consumptionByZoneAndDensity[Zone.Residential][2];

  it('is zero below the cooling comfort temperature', () => {
    expect(coolingConsumption(Zone.Residential, 2, comfortTemperature - 1, false)).toBe(0);
  });

  it('reaches the full zone weight at the top of the range', () => {
    const hot = comfortTemperature + coolingRange;
    expect(coolingConsumption(Zone.Residential, 2, hot, false)).toBeCloseTo(
      base * weightByZone[Zone.Residential],
      9,
    );
    expect(coolingConsumption(Zone.Commercial, 2, hot, false)).toBeCloseTo(
      BALANCE.energy.consumptionByZoneAndDensity[Zone.Commercial][2] *
        weightByZone[Zone.Commercial],
      9,
    );
  });

  it('is halved by insulation', () => {
    const hot = comfortTemperature + coolingRange;
    const plain = coolingConsumption(Zone.Residential, 3, hot, false);
    expect(coolingConsumption(Zone.Residential, 3, hot, true)).toBeCloseTo(
      plain * insulationFactor,
      9,
    );
  });

  it('is reported separately and counts toward the balance', () => {
    const state = makeState();
    setNoonClearSky(state);
    state.season = { ...state.season, temperature: comfortTemperature + coolingRange };
    placePlant(state, at(5, 5), PlantType.WindTurbine);
    addBuilding(state, at(6, 5), Zone.Residential, 2);
    buildPowerLines(state, [at(6, 6)]);
    energyStep(state, { chargingDemand: 0 });
    const cooling = state.lastEnergy.coolingConsumption;
    expect(cooling).toBeCloseTo(base * weightByZone[Zone.Residential], 6);
    expect(state.lastEnergy.heatingConsumption).toBe(0);
    // Wind is 0 at noon clear sky; rooftop PV covers part of the load and
    // the small shortfall is imported, so the import equals the unmet
    // (buildings + cooling - rooftop). That proves cooling is in the balance.
    expect(state.lastEnergy.gridImport).toBeCloseTo(
      state.lastEnergy.buildingConsumption + cooling - state.lastEnergy.rooftop,
      6,
    );
    expect(state.lastEnergy.deficit).toBe(0);
  });
});

describe('service stations', () => {
  it('can only be placed next to a road', () => {
    const state = makeState();
    expect(placePlant(state, at(5, 5), PlantType.FireStation)).toEqual({ rejected: 'needsRoad' });
    buildRoads(state, [at(5, 6)]);
    expect(placePlant(state, at(5, 5), PlantType.FireStation)).toEqual({});
    expect(state.layers.plantType[at(5, 5)]).toBe(PlantType.FireStation);
    expect(placePlant(state, at(6, 6), PlantType.PoliceStation)).toEqual({});
  });

  it('charges the configured cost', () => {
    const state = makeState();
    buildRoads(state, [at(5, 6)]);
    const before = state.money;
    placePlant(state, at(5, 5), PlantType.PoliceStation);
    expect(state.money).toBe(before - BALANCE.costs.plant[PlantType.PoliceStation]);
  });

  it('is counted by the census and is not power infrastructure', () => {
    const state = makeState();
    buildRoads(state, [at(5, 6), at(7, 6)]);
    placePlant(state, at(5, 5), PlantType.FireStation);
    placePlant(state, at(7, 5), PlantType.PoliceStation);
    const census = censusPlants(state);
    expect(census.fireStations).toBe(1);
    expect(census.policeStations).toBe(1);
    expect(hasPowerInfrastructure(state)).toBe(false);
    expect(isStation(PlantType.FireStation)).toBe(true);
    expect(isStation(PlantType.Park)).toBe(false);
  });

  it('draws stationConsumption per tick while energised, nothing when unconnected', () => {
    const state = makeState();
    setNoonClearSky(state);
    buildRoads(state, [at(6, 7)]);
    placePlant(state, at(5, 5), PlantType.WindTurbine);
    placePlant(state, at(6, 6), PlantType.FireStation); // inside the turbine's own ring
    energyStep(state, { chargingDemand: 0 });
    expect(state.lastEnergy.buildingConsumption).toBeCloseTo(
      BALANCE.services.stationConsumption,
      6,
    );

    const far = makeState();
    setNoonClearSky(far);
    buildRoads(far, [at(25, 26)]);
    placePlant(far, at(5, 5), PlantType.WindTurbine);
    placePlant(far, at(25, 25), PlantType.PoliceStation); // far outside any ring
    energyStep(far, { chargingDemand: 0 });
    expect(far.lastEnergy.buildingConsumption).toBe(0);
  });

  it('places a bus depot next to a road for its price and rejects it elsewhere', () => {
    const state = createSimState(1, 16);
    state.layers.elevation.fill(0);
    const at = (x: number, y: number) => tileIndex(x, y, 16);
    expect(placePlant(state, at(5, 5), PlantType.BusDepot)).toEqual({ rejected: 'needsRoad' });
    buildRoads(state, [at(5, 6)]);
    const before = state.money;
    expect(placePlant(state, at(5, 5), PlantType.BusDepot)).toEqual({});
    expect(state.money).toBe(before - BALANCE.costs.plant[PlantType.BusDepot]);
    expect(state.layers.plantType[at(5, 5)]).toBe(PlantType.BusDepot);
  });
});

describe('hydrogen plants', () => {
  it('census counts hydrogen plants and they are supply sources', () => {
    const state = makeState();
    state.money = 1e9;
    placePlant(state, at(5, 5), PlantType.HydrogenPlant);
    expect(censusPlants(state).hydrogenPlants).toBe(1);
    addBuilding(state, at(6, 5), Zone.Residential, 1);
    energyStep(state, { chargingDemand: 0 });
    expect(state.layers.supplied[at(6, 5)]).not.toBe(SupplyStatus.NotConnected);
  });

  it('electrolyses only the surplus the export link cannot take', () => {
    const state = makeState();
    state.money = 1e9;
    placePlant(state, at(5, 5), PlantType.SolarFarm);
    placePlant(state, at(6, 5), PlantType.HydrogenPlant);
    setNoonClearSky(state);
    energyStep(state, { chargingDemand: 0 });
    // Export still comes first; only the would-be curtailment is electrolysed.
    const surplus = BALANCE.energy.solarPeakOutput;
    const beyondExport = surplus - BALANCE.market.exportCapacity;
    expect(state.lastEnergy.gridExport).toBeCloseTo(BALANCE.market.exportCapacity, 3);
    expect(state.lastEnergy.electrolysis).toBeCloseTo(beyondExport, 3);
    expect(state.hydrogenEnergy).toBeCloseTo(beyondExport * BALANCE.hydrogen.chargeEfficiency, 3);
    expect(state.lastEnergy.curtailment).toBeCloseTo(0, 3);
    expect(state.lastEnergy.hydrogenSold).toBe(0);
  });

  it('sells hydrogen once the tanks are full instead of curtailing', () => {
    const state = makeState();
    state.money = 1e9;
    placePlant(state, at(5, 5), PlantType.SolarFarm);
    placePlant(state, at(6, 5), PlantType.HydrogenPlant);
    setNoonClearSky(state);
    state.hydrogenEnergy = BALANCE.hydrogen.capacity;
    energyStep(state, { chargingDemand: 0 });
    const beyondExport = BALANCE.energy.solarPeakOutput - BALANCE.market.exportCapacity;
    expect(state.lastEnergy.electrolysis).toBeCloseTo(beyondExport, 3);
    expect(state.lastEnergy.hydrogenSold).toBeCloseTo(
      beyondExport * BALANCE.hydrogen.chargeEfficiency,
      3,
    );
    expect(state.hydrogenEnergy).toBe(BALANCE.hydrogen.capacity);
    expect(state.lastEnergy.curtailment).toBeCloseTo(0, 3);
  });

  it('the electrolyser input is capped by its power limit', () => {
    const state = makeState();
    state.money = 1e9;
    for (let i = 0; i < 3; i++) placePlant(state, at(5 + i, 5), PlantType.SolarFarm);
    placePlant(state, at(5, 6), PlantType.HydrogenPlant);
    setNoonClearSky(state);
    energyStep(state, { chargingDemand: 0 });
    const beyondExport = 3 * BALANCE.energy.solarPeakOutput - BALANCE.market.exportCapacity;
    expect(state.lastEnergy.electrolysis).toBeCloseTo(BALANCE.hydrogen.electrolyserPowerLimit, 3);
    expect(state.lastEnergy.curtailment).toBeCloseTo(
      beyondExport - BALANCE.hydrogen.electrolyserPowerLimit,
      3,
    );
  });

  it('re-electrifies hydrogen in a deficit before dispatching biogas', () => {
    const state = makeState();
    state.money = 1e9;
    placePlant(state, at(5, 5), PlantType.HydrogenPlant);
    placePlant(state, at(6, 5), PlantType.BiogasPlant);
    addBuilding(state, at(7, 5), Zone.Commercial, 3);
    state.tick = TICKS_PER_DAY / 2;
    state.weather.cloudCover = 1;
    state.weather.windSpeed = 0;
    state.hydrogenEnergy = 1_000;
    energyStep(state, { chargingDemand: 0 });
    const shortfall = state.lastEnergy.buildingConsumption - state.lastEnergy.rooftop;
    expect(shortfall).toBeGreaterThan(0);
    expect(state.lastEnergy.fuelCell).toBeCloseTo(shortfall, 3);
    expect(state.hydrogenEnergy).toBeCloseTo(1_000 - shortfall, 3);
    expect(state.lastEnergy.biogas).toBe(0);
    expect(state.lastEnergy.deficit).toBe(0);
  });

  it('the fuel cell is capped by its power limit, biogas covers the rest', () => {
    const state = makeState();
    state.money = 1e9;
    placePlant(state, at(5, 5), PlantType.HydrogenPlant);
    placePlant(state, at(6, 5), PlantType.BiogasPlant);
    state.tick = 0; // midnight, no solar
    state.weather.windSpeed = 0;
    state.hydrogenEnergy = 1_000;
    const demand = BALANCE.hydrogen.fuelCellPowerLimit + 50;
    energyStep(state, { chargingDemand: demand });
    expect(state.lastEnergy.fuelCell).toBeCloseTo(BALANCE.hydrogen.fuelCellPowerLimit, 3);
    expect(state.lastEnergy.biogas).toBeCloseTo(50, 3);
    expect(state.lastEnergy.deficit).toBe(0);
  });
});

describe('market trading', () => {
  /** Calm, overcast evening: regional scarcity, spot far above the sell threshold. */
  function setScarceEvening(state: SimState): void {
    state.tick = Math.round((19 / 24) * TICKS_PER_DAY);
    state.weather.cloudCover = 1;
    state.weather.windSpeed = 0;
  }

  /** Clear, windy noon: regional abundance, spot below the buy threshold. */
  function setCheapNoon(state: SimState): void {
    state.tick = TICKS_PER_DAY / 2;
    state.weather.cloudCover = 0;
    state.weather.windSpeed = 1;
    state.season = { ...state.season, sunrise: SUNRISE, sunset: SUNSET, solarStrength: 1 };
  }

  it('records the spot price factor every tick', () => {
    const state = makeState();
    energyStep(state, { chargingDemand: 0 });
    expect(state.lastEnergy.spotPrice).toBeGreaterThan(0);
  });

  it('sells stored energy above the reserve floor at scarcity prices', () => {
    const state = makeState();
    placePlant(state, at(5, 5), PlantType.Battery);
    setScarceEvening(state);
    state.storedEnergy = BALANCE.energy.batteryCapacity; // 100%
    state.marketTrading = true;
    energyStep(state, { chargingDemand: 0 });
    const sellable =
      BALANCE.energy.batteryCapacity -
      BALANCE.market.trading.sellFloor * BALANCE.energy.batteryCapacity;
    const expected = Math.min(
      BALANCE.market.exportCapacity,
      BALANCE.energy.batteryPowerLimit,
      sellable,
    );
    expect(state.lastEnergy.tradeSell).toBeCloseTo(expected, 3);
    expect(state.lastEnergy.gridExport).toBeCloseTo(expected, 3);
    expect(state.storedEnergy).toBeCloseTo(BALANCE.energy.batteryCapacity - expected, 3);
  });

  it('never sells below the reserve floor', () => {
    const state = makeState();
    placePlant(state, at(5, 5), PlantType.Battery);
    setScarceEvening(state);
    state.storedEnergy = BALANCE.market.trading.sellFloor * BALANCE.energy.batteryCapacity;
    state.marketTrading = true;
    energyStep(state, { chargingDemand: 0 });
    expect(state.lastEnergy.tradeSell).toBe(0);
  });

  it('buys cheap power into storage up to the buy ceiling', () => {
    const state = makeState();
    placePlant(state, at(5, 5), PlantType.Battery);
    setCheapNoon(state);
    state.storedEnergy = 0.2 * BALANCE.energy.batteryCapacity;
    state.marketTrading = true;
    energyStep(state, { chargingDemand: 0 });
    const expected = Math.min(
      BALANCE.market.importCapacity,
      BALANCE.energy.batteryPowerLimit,
      (BALANCE.market.trading.buyCeiling * BALANCE.energy.batteryCapacity - state.storedEnergy) /
        BALANCE.energy.batteryChargeEfficiency,
    );
    expect(state.lastEnergy.tradeBuy).toBeCloseTo(expected, 3);
    expect(state.lastEnergy.gridImport).toBeCloseTo(expected, 3);
  });

  it('never buys beyond the ceiling nor while own surplus is exported', () => {
    const state = makeState();
    placePlant(state, at(5, 5), PlantType.Battery);
    placePlant(state, at(6, 5), PlantType.SolarFarm);
    setCheapNoon(state);
    // Own solar surplus at noon: the battery charges from it and the rest
    // is exported, so buying on top would be nonsense.
    state.storedEnergy = 0.2 * BALANCE.energy.batteryCapacity;
    state.marketTrading = true;
    energyStep(state, { chargingDemand: 0 });
    expect(state.lastEnergy.gridExport).toBeGreaterThan(0);
    expect(state.lastEnergy.tradeBuy).toBe(0);
    // And a battery already at the ceiling stays untouched.
    const full = makeState();
    placePlant(full, at(5, 5), PlantType.Battery);
    setCheapNoon(full);
    full.storedEnergy = BALANCE.market.trading.buyCeiling * BALANCE.energy.batteryCapacity;
    full.marketTrading = true;
    energyStep(full, { chargingDemand: 0 });
    expect(full.lastEnergy.tradeBuy).toBe(0);
  });

  it('does not trade while the toggle is off', () => {
    const state = makeState();
    placePlant(state, at(5, 5), PlantType.Battery);
    setScarceEvening(state);
    state.storedEnergy = BALANCE.energy.batteryCapacity;
    energyStep(state, { chargingDemand: 0 });
    expect(state.lastEnergy.tradeSell).toBe(0);
    expect(state.lastEnergy.tradeBuy).toBe(0);
  });
});

describe('geothermal generation', () => {
  /** A map with one full-heat quality-2 hotspot carrying one plant. */
  function plantOnHotspot(): SimState {
    const state = createSimState(5, 16);
    state.layers.geothermal[40] = 2;
    state.layers.reservoirHeat[40] = 255;
    state.layers.tileType[40] = TileType.Plant;
    state.layers.plantType[40] = PlantType.GeothermalPlant;
    return state;
  }

  it('counts the plant with its quality and heat', () => {
    const census = censusPlants(plantOnHotspot());
    expect(census.geothermalPlants).toBe(1);
    // qualityFactor[2] = 1.0 at full heat.
    expect(census.geothermalCapacity).toBeCloseTo(1, 6);
  });

  it('scales with quality and with a cooled reservoir', () => {
    const state = plantOnHotspot();
    state.layers.geothermal[40] = 3;
    expect(censusPlants(state).geothermalCapacity).toBeCloseTo(1.3, 6);
    state.layers.reservoirHeat[40] = 128;
    expect(censusPlants(state).geothermalCapacity).toBeCloseTo(1.3 * (128 / 255), 6);
  });

  it('generates the same at midnight as at noon, in storm and in calm', () => {
    const outputs = [0, TICKS_PER_DAY / 2].flatMap((tick) =>
      [0, 1].map((cloudCover) => {
        const state = plantOnHotspot();
        state.tick = tick;
        state.weather.cloudCover = cloudCover;
        state.weather.windSpeed = cloudCover;
        energyStep(state, { chargingDemand: 0 });
        return state.lastEnergy.geothermal;
      }),
    );
    for (const output of outputs) {
      expect(output).toBeCloseTo(BALANCE.energy.geothermalPeakOutput, 6);
    }
  });
});
