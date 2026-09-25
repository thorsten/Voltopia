/** Tests for the tile inspector data. */
import { describe, expect, it } from 'vitest';
import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import { neighbors4, tileIndex } from '../shared/grid.ts';
import { DeliveryState, RoadClass, StopState, TileType } from '../shared/types.ts';
import { syncFleet } from './deliveries.ts';
import { economyStep } from './economy.ts';
import { buildingConsumption, placePlant } from './energy.ts';
import { discoverGeothermalFields } from './geothermal.ts';
import { inspectTile } from './inspect.ts';
import { buildPowerLines } from './powerLines.ts';
import { buildRoads, bulldozeTiles } from './roads.ts';
import { SERVICE_FIRE, SERVICE_POLICE } from './services.ts';
import { createSimState, PlantType, SupplyStatus, Terrain, Zone } from './state.ts';
import { buildBusStops, syncBusFleet } from './transit.ts';
import { paintZones } from './zones.ts';

const SIZE = 32;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);

/** A residential building of the given density next to a road. */
function cityWithBuilding(density: number) {
  const state = createSimState(7, SIZE);
  buildRoads(state, [at(4, 5), at(5, 5), at(6, 5)]);
  paintZones(state, [at(5, 6)], Zone.Residential);
  state.layers.density[at(5, 6)] = density;
  state.layers.supplied[at(5, 6)] = SupplyStatus.Supplied;
  return state;
}

describe('inspectTile', () => {
  it('returns null outside the grid', () => {
    const state = createSimState(1, SIZE);
    expect(inspectTile(state, -1)).toBeNull();
    expect(inspectTile(state, SIZE * SIZE)).toBeNull();
  });

  it('reports road upkeep per tile', () => {
    const state = createSimState(1, SIZE);
    buildRoads(state, [at(2, 2)]);
    const info = inspectTile(state, at(2, 2))!;
    expect(info.upkeepPerTick).toBeCloseTo(BALANCE.upkeepPerTick.roadPerTile, 9);
    expect(info.consumption).toBe(0);
  });

  it('reports plant upkeep and generation', () => {
    const state = createSimState(1, SIZE);
    placePlant(state, at(10, 10), PlantType.WindTurbine);
    state.weather.windSpeed = 1;
    const info = inspectTile(state, at(10, 10))!;
    expect(info.upkeepPerTick).toBeCloseTo(BALANCE.upkeepPerTick.plant[PlantType.WindTurbine], 9);
    expect(info.generation).toBeGreaterThan(0);
    expect(info.peakGeneration).toBe(BALANCE.energy.windPeakOutput);
  });

  it('a supply plant counts as grid-connected only once a line is attached', () => {
    const state = createSimState(1, SIZE);
    state.money = 1e9;
    placePlant(state, at(10, 10), PlantType.Battery);
    // Standalone: the plant energises its own ring, but nothing ties it
    // to the network, so the inspector must not claim a connection.
    expect(inspectTile(state, at(10, 10))!.connected).toBe(false);

    buildPowerLines(state, [at(11, 10), at(12, 10)]);
    expect(inspectTile(state, at(10, 10))!.connected).toBe(true);

    bulldozeTiles(state, [at(11, 10)]);
    expect(inspectTile(state, at(10, 10))!.connected).toBe(false);
  });

  it('reports the ring a tile projects: plants, hubs, parks and live lines', () => {
    const state = createSimState(1, SIZE);
    state.money = 1e9;
    placePlant(state, at(10, 10), PlantType.WindTurbine);
    placePlant(state, at(20, 10), PlantType.Park);
    placePlant(state, at(20, 20), PlantType.ChargingHub);
    expect(inspectTile(state, at(10, 10))!.ringRadius).toBe(BALANCE.energy.lineSupplyRadius);
    expect(inspectTile(state, at(20, 10))!.ringRadius).toBe(BALANCE.happiness.parkRadius);
    expect(inspectTile(state, at(20, 20))!.ringRadius).toBe(BALANCE.vehicles.hubRadius);
    expect(inspectTile(state, at(5, 5))!.ringRadius).toBe(0);

    // A line fed by the turbine projects the supply ring; a stray one does not.
    buildPowerLines(state, [at(11, 10), at(12, 10)]);
    buildPowerLines(state, [at(25, 25), at(26, 25)]);
    expect(inspectTile(state, at(12, 10))!.ringRadius).toBe(BALANCE.energy.lineSupplyRadius);
    expect(inspectTile(state, at(26, 25))!.ringRadius).toBe(0);
  });

  it('a lot beyond a plant ring connects through an energised line and drops when it is cut', () => {
    const state = createSimState(7, SIZE);
    state.money = 1e9;
    placePlant(state, at(2, 10), PlantType.WindTurbine);
    const road = Array.from({ length: 13 }, (_, i) => at(3 + i, 12));
    buildRoads(state, road);
    paintZones(state, [at(14, 11)], Zone.Residential);
    const lot = at(14, 11);
    state.layers.density[lot] = 1;
    expect(inspectTile(state, lot)!.connected).toBe(false);
    expect(inspectTile(state, lot)!.growthBlockers).toContain('notConnected');

    buildPowerLines(state, [at(3, 10), at(3, 11), ...road]);
    expect(inspectTile(state, lot)!.connected).toBe(true);
    expect(inspectTile(state, lot)!.growthBlockers).not.toContain('notConnected');

    // Cut next to the plant: the rest of the line is dead.
    bulldozeTiles(state, [at(3, 11)]);
    expect(inspectTile(state, lot)!.connected).toBe(false);
  });

  it('splits stored energy across battery tiles', () => {
    const state = createSimState(1, SIZE);
    placePlant(state, at(8, 8), PlantType.Battery);
    placePlant(state, at(9, 9), PlantType.Battery);
    state.storedEnergy = 2_000;
    const info = inspectTile(state, at(8, 8))!;
    expect(info.storedEnergy).toBeCloseTo(1_000, 6);
    expect(info.storageCapacity).toBe(BALANCE.energy.batteryCapacity);
  });

  it('reports a hydrogen plant tile: tank share and fuel-cell output', () => {
    const state = createSimState(1, SIZE);
    state.money = 1e9;
    placePlant(state, at(8, 8), PlantType.HydrogenPlant);
    placePlant(state, at(10, 10), PlantType.HydrogenPlant);
    state.hydrogenEnergy = 5_000;
    state.lastEnergy.fuelCell = 40;
    const info = inspectTile(state, at(8, 8))!;
    expect(info.storedEnergy).toBeCloseTo(2_500, 6);
    expect(info.storageCapacity).toBe(BALANCE.hydrogen.capacity);
    expect(info.generation).toBeCloseTo(20, 6);
  });

  it('charges biogas fuel cost on the plant tile it is generated by', () => {
    const state = createSimState(1, SIZE);
    placePlant(state, at(12, 12), PlantType.BiogasPlant);
    state.lastEnergy.biogas = 60;
    const info = inspectTile(state, at(12, 12))!;
    expect(info.generation).toBeCloseTo(60, 6);
    expect(info.fuelCostPerTick).toBeCloseTo(
      60 * BALANCE.upkeepPerTick.biogasFuelCostPerEnergyUnit,
      6,
    );
  });

  it('reports building consumption following the load profile', () => {
    const state = cityWithBuilding(2);
    state.tick = TICKS_PER_DAY / 2; // noon
    const info = inspectTile(state, at(5, 6))!;
    expect(info.consumption).toBeCloseTo(buildingConsumption(Zone.Residential, 2, 0.5), 9);
    expect(info.peakConsumption).toBe(
      BALANCE.energy.consumptionByZoneAndDensity[Zone.Residential][2],
    );
    expect(info.loadFactor).toBeGreaterThan(0);
    expect(info.population).toBe(BALANCE.growth.populationByDensity[2]);
    expect(info.upkeepPerTick).toBe(0); // buildings cost no money upkeep
  });

  it('reports the tax a building contributes at the current rate', () => {
    const state = cityWithBuilding(1);
    state.taxRate = 0.2;
    const info = inspectTile(state, at(5, 6))!;
    expect(info.taxPerTick).toBeCloseTo(
      0.2 * BALANCE.growth.populationByDensity[1] * BALANCE.tax.incomePerResident,
      9,
    );
  });

  it('lists why a zoned tile is not growing', () => {
    const state = createSimState(3, SIZE);
    paintZones(state, [at(20, 20)], Zone.Commercial);
    state.lastDemand = { residential: 0, commercial: -0.5, retail: 0 };
    const info = inspectTile(state, at(20, 20))!;
    expect(info.growthBlockers).toContain('noRoad');
    expect(info.growthBlockers).toContain('lowDemand');
    expect(info.demand).toBeCloseTo(-0.5, 6);
  });

  it('reports no blockers for a ready lot and maxDensity at level 3', () => {
    const ready = cityWithBuilding(0);
    ready.lastDemand = { residential: 1, commercial: 1, retail: 1 };
    expect(inspectTile(ready, at(5, 6))!.growthBlockers).toEqual([]);

    const full = cityWithBuilding(3);
    full.lastDemand = { residential: 1, commercial: 1, retail: 1 };
    expect(inspectTile(full, at(5, 6))!.growthBlockers).toContain('maxDensity');
  });

  it('flags water tiles as unbuildable', () => {
    const state = createSimState(1, SIZE);
    state.layers.terrain[at(3, 3)] = Terrain.Lake;
    state.layers.zone[at(3, 3)] = Zone.Retail;
    expect(inspectTile(state, at(3, 3))!.growthBlockers).toContain('notLand');
  });

  it('reports elevation, slope and the plant terrain bonus', () => {
    const state = createSimState(1, SIZE);
    const tile = at(3, 3);
    state.layers.elevation[tile] = 4;
    for (const n of neighbors4(tile, SIZE)) state.layers.elevation[n] = 4;
    placePlant(state, tile, PlantType.WindTurbine);
    const info = inspectTile(state, tile)!;
    expect(info.elevation).toBe(4);
    expect(info.slope).toBe(0);
    expect(info.terrainBonus).toBeCloseTo(1 + BALANCE.terrain.windBonusPerLevel * 4);
  });

  it('reports the hotspot and its field on a hotspot tile', () => {
    const state = createSimState(3, 16);
    for (const index of [34, 35, 50, 51]) {
      state.layers.geothermal[index] = 2;
      state.layers.reservoirHeat[index] = 204; // 80 %
    }
    discoverGeothermalFields(state);
    state.layers.tileType[34] = TileType.Plant;
    state.layers.plantType[34] = PlantType.GeothermalPlant;

    const info = inspectTile(state, 35)!;
    expect(info.hotspot).toEqual({ quality: 2, heat: 204 / 255, wells: 1, capacity: 2 });
    expect(inspectTile(state, 0)!.hotspot).toBeUndefined();
  });

  it('shows a geothermal plant generating at its quality and heat', () => {
    const state = createSimState(3, 16);
    state.layers.geothermal[34] = 3;
    state.layers.reservoirHeat[34] = 255;
    discoverGeothermalFields(state);
    state.layers.tileType[34] = TileType.Plant;
    state.layers.plantType[34] = PlantType.GeothermalPlant;
    const info = inspectTile(state, 34)!;
    expect(info.generation).toBeCloseTo(BALANCE.energy.geothermalPeakOutput * 1.3, 6);
    expect(info.peakGeneration).toBeCloseTo(BALANCE.energy.geothermalPeakOutput * 1.3, 6);
  });

  it('reports the offshore turbine bonus matching its generation', () => {
    const state = createSimState(1, SIZE);
    const tile = at(3, 3);
    state.layers.terrain[tile] = Terrain.Sea;
    expect(placePlant(state, tile, PlantType.WindTurbine).rejected).toBeUndefined();
    const info = inspectTile(state, tile)!;
    const expectedBonus = 1 + BALANCE.sea.offshoreWindBonus;
    // The panel's terrain-bonus row and its generation numbers must agree
    // — both come from the same offshore factor, not two different ones.
    expect(info.terrainBonus).toBeCloseTo(expectedBonus, 5);
    expect(info.peakGeneration).toBeCloseTo(BALANCE.energy.windPeakOutput * expectedBonus, 5);
  });
});

describe('economyStep breakdown by plant type', () => {
  it('splits upkeep and counts per plant type', () => {
    const state = createSimState(1, SIZE);
    placePlant(state, at(4, 4), PlantType.SolarFarm);
    placePlant(state, at(6, 4), PlantType.SolarFarm);
    placePlant(state, at(8, 4), PlantType.WindTurbine);
    buildRoads(state, [at(1, 1), at(2, 1)]);

    const breakdown = economyStep(state, 0, 0);
    expect(breakdown.plantCountByType[PlantType.SolarFarm]).toBe(2);
    expect(breakdown.plantCountByType[PlantType.WindTurbine]).toBe(1);
    expect(breakdown.plantUpkeepByType[PlantType.SolarFarm]).toBeCloseTo(
      2 * BALANCE.upkeepPerTick.plant[PlantType.SolarFarm],
      9,
    );
    expect(breakdown.roadTiles).toBe(2);
    // The split must add up to the total upkeep.
    const summed = Object.values(breakdown.plantUpkeepByType).reduce((a, b) => a + b, 0);
    expect(summed).toBeCloseTo(breakdown.plantUpkeep, 9);
    expect(state.lastEconomy).toBe(breakdown);
  });
});

describe('services in the inspector', () => {
  it('reports coverage per building and the noFireCoverage blocker at density 2', () => {
    const state = cityWithBuilding(2);
    state.layers.buildingAge[at(5, 6)] = BALANCE.growth.densifyMinAge;
    let info = inspectTile(state, at(5, 6))!;
    expect(info.fireCovered).toBe(false);
    expect(info.policeCovered).toBe(false);
    expect(info.growthBlockers).toContain('noFireCoverage');

    state.layers.services[at(5, 6)] = SERVICE_FIRE | SERVICE_POLICE;
    info = inspectTile(state, at(5, 6))!;
    expect(info.fireCovered).toBe(true);
    expect(info.policeCovered).toBe(true);
    expect(info.growthBlockers).not.toContain('noFireCoverage');
  });

  it('does not raise the fire blocker below density 2', () => {
    const state = cityWithBuilding(1);
    expect(inspectTile(state, at(5, 6))!.growthBlockers).not.toContain('noFireCoverage');
  });

  it('applies the police tax factor per tile', () => {
    const state = cityWithBuilding(3); // 26 residents on one tile: below minPopulation city-wide
    const full = inspectTile(state, at(5, 6))!.taxPerTick;
    // Pretend the city is big: taxPerTick follows the same rule as the budget.
    for (let i = 0; i < 5; i++) {
      state.layers.zone[at(10 + i, 6)] = Zone.Residential;
      state.layers.density[at(10 + i, 6)] = 3;
    }
    const uncovered = inspectTile(state, at(5, 6))!.taxPerTick;
    expect(uncovered).toBeCloseTo(full * BALANCE.services.uncoveredTaxFactor, 9);
    state.layers.services[at(5, 6)] = SERVICE_POLICE;
    expect(inspectTile(state, at(5, 6))!.taxPerTick).toBeCloseTo(full, 9);
  });

  it('reports a station ring and whether it is active', () => {
    const state = createSimState(1, SIZE);
    buildRoads(state, [at(10, 11)]);
    placePlant(state, at(10, 10), PlantType.PoliceStation);
    let info = inspectTile(state, at(10, 10))!;
    expect(info.ringRadius).toBe(BALANCE.services.police.radius);
    expect(info.stationActive).toBe(false);
    placePlant(state, at(11, 10), PlantType.WindTurbine);
    info = inspectTile(state, at(10, 10))!;
    expect(info.stationActive).toBe(true);
  });

  it('reports a station load once it is energised', () => {
    const state = createSimState(1, SIZE);
    buildRoads(state, [at(10, 11)]);
    placePlant(state, at(10, 10), PlantType.PoliceStation);
    let info = inspectTile(state, at(10, 10))!;
    expect(info.consumption).toBe(0);
    expect(info.peakConsumption).toBe(BALANCE.services.stationConsumption);
    placePlant(state, at(11, 10), PlantType.WindTurbine);
    info = inspectTile(state, at(10, 10))!;
    expect(info.consumption).toBe(BALANCE.services.stationConsumption);
  });
});

describe('traffic in the inspector', () => {
  it('reports class, load and lane capacity of a road tile', () => {
    const state = createSimState(1, SIZE);
    state.layers.elevation.fill(0);
    buildRoads(state, [at(2, 2)]);
    buildRoads(state, [at(3, 2)], true);
    state.layers.trafficLoad[at(3, 2)] = 200;
    const street = inspectTile(state, at(2, 2))!;
    const avenue = inspectTile(state, at(3, 2))!;
    expect(street.roadClass).toBe(RoadClass.Street);
    expect(street.laneCapacity).toBe(BALANCE.vehicles.maxPerRoadTile);
    expect(avenue.roadClass).toBe(RoadClass.Avenue);
    expect(avenue.laneCapacity).toBe(BALANCE.vehicles.avenueMaxPerTile);
    expect(avenue.trafficLoad).toBe(200);
    expect(inspectTile(state, at(9, 9))!.laneCapacity).toBe(0);
  });
});

describe('deliveries in the inspector', () => {
  it('reports the delivery state and age of a shop and the noDeliveries blocker', () => {
    const state = createSimState(1, SIZE);
    buildRoads(state, [at(5, 5)]);
    state.layers.zone[at(5, 6)] = Zone.Retail;
    state.layers.density[at(5, 6)] = 1;
    state.layers.buildingAge[at(5, 6)] = BALANCE.growth.densifyMinAge;
    expect(inspectTile(state, at(5, 6))!.growthBlockers).not.toContain('noDeliveries');
    state.layers.deliveryAge[at(5, 6)] = BALANCE.deliveries.supplyWindowDays * TICKS_PER_DAY + 1;
    const info = inspectTile(state, at(5, 6))!;
    expect(info.deliveryState).toBe(DeliveryState.Unsupplied);
    expect(info.deliveryAgeTicks).toBe(BALANCE.deliveries.supplyWindowDays * TICKS_PER_DAY + 1);
    expect(info.growthBlockers).toContain('noDeliveries');
    expect(info.depot).toBeNull();
  });

  it("reports a depot's fleet and the shops in reach", () => {
    const state = createSimState(1, SIZE);
    buildRoads(
      state,
      Array.from({ length: 10 }, (_, i) => at(i + 2, 10)),
    );
    placePlant(state, at(2, 9), PlantType.LogisticsDepot);
    state.layers.zone[at(6, 11)] = Zone.Retail;
    state.layers.density[at(6, 11)] = 1;
    syncFleet(state);
    state.vans[0].charging = true;
    const info = inspectTile(state, at(2, 9))!;
    expect(info.depot).toEqual({
      vansTotal: BALANCE.deliveries.vansPerDepot,
      vansDriving: 0,
      vansCharging: 1,
      shopsInReach: 1,
    });
    expect(info.upkeepPerTick).toBe(BALANCE.upkeepPerTick.plant[PlantType.LogisticsDepot]);
  });

  it('reports a bus stop, its service state, coverage and ring', () => {
    const state = createSimState(1, SIZE);
    buildRoads(state, [at(4, 5), at(5, 5), at(6, 5)]);
    buildBusStops(state, [at(5, 5)]);
    state.layers.transitCover[at(5, 5)] = 1;
    const stop = inspectTile(state, at(5, 5))!;
    expect(stop.busStop).toBe(true);
    expect(stop.stopState).toBe(StopState.Served);
    expect(stop.stopAgeTicks).toBe(0);
    expect(stop.transitCovered).toBe(true);
    expect(stop.ringRadius).toBe(BALANCE.transit.stopRadius);
    expect(stop.upkeepPerTick).toBeCloseTo(
      BALANCE.upkeepPerTick.roadPerTile + BALANCE.upkeepPerTick.busStop,
      9,
    );
    state.layers.stopAge[at(5, 5)] = BALANCE.transit.serviceWindowDays * TICKS_PER_DAY + 1;
    expect(inspectTile(state, at(5, 5))!.stopState).toBe(StopState.Unserved);
    const plain = inspectTile(state, at(4, 5))!;
    expect(plain.busStop).toBe(false);
    expect(plain.ringRadius).toBe(0);
    expect(plain.busDepot).toBeNull();
  });

  it("reports a bus depot's fleet and the stops in reach", () => {
    const state = createSimState(1, SIZE);
    buildRoads(
      state,
      Array.from({ length: 10 }, (_, i) => at(i + 2, 10)),
    );
    placePlant(state, at(2, 9), PlantType.BusDepot);
    buildBusStops(state, [at(6, 10)]);
    syncBusFleet(state);
    state.buses[0].charging = true;
    const info = inspectTile(state, at(2, 9))!;
    expect(info.busDepot).toEqual({
      busesTotal: BALANCE.transit.busesPerDepot,
      busesDriving: 0,
      busesCharging: 1,
      stopsInReach: 1,
    });
    expect(info.upkeepPerTick).toBe(BALANCE.upkeepPerTick.plant[PlantType.BusDepot]);
  });
});
