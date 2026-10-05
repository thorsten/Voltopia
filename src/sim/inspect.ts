/**
 * Per-tile inspector.
 *
 * Collects everything the UI shows when the player clicks a tile with the
 * select tool: money upkeep, tax contribution, energy consumption and
 * generation, demand for the tile's zone, and why it is (not) growing.
 * Recomputed from scratch every tick while a tile is selected, so the
 * numbers track the running simulation.
 */
import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import { neighbors4, tileX, tileY } from '../shared/grid.ts';
import { HEATED_SERVED } from '../shared/types.ts';
import type { GrowthBlocker, TileInfo } from '../shared/types.ts';
import { PlantType, RoadClass, SupplyStatus, Terrain, TileType, Zone } from '../shared/types.ts';
import { deliveryState, depotInfo, isShopSupplied } from './deliveries.ts';
import { disasterKindAt } from './disasters.ts';
import { policeTaxFactor } from './economy.ts';
import {
  buildingConsumption,
  censusPlants,
  isStation,
  isTileConnected,
  loadProfileFactor,
} from './energy.ts';
import { FULL_HEAT, fieldAt } from './geothermal.ts';
import { demandFor, energySystemActive, hasRoadAccess } from './growth.ts';
import { heatPumpCop, plantReach } from './heat.ts';
import { isSupplySource, islandOf, isTiedToGrid } from './powerGrid.ts';
import { tideFactor, tidalSiteFactor, windTurbineFactor } from './sea.ts';
import { SERVICE_FIRE, SERVICE_POLICE } from './services.ts';
import {
  countPopulationAndJobs,
  pumpedHeadAt,
  riverDropAt,
  slopeAt,
  storageCapacityAt,
  type SimState,
} from './state.ts';
import { laneCapacity } from './traffic.ts';
import { busDepotInfo, isBusStop, stopState } from './transit.ts';
import { currentSolarFactor, currentWindFactor, riverFlowFactor } from './weather.ts';

/** Generation of one plant tile this tick, and at ideal conditions. */
function plantGeneration(
  state: SimState,
  plant: PlantType,
  index: number,
): { generation: number; peak: number } {
  const e = BALANCE.energy;
  switch (plant) {
    case PlantType.SolarFarm:
      return { generation: e.solarPeakOutput * currentSolarFactor(state), peak: e.solarPeakOutput };
    case PlantType.WindTurbine: {
      const bonus = windTurbineFactor(
        state,
        index,
        1 + BALANCE.terrain.windBonusPerLevel * state.layers.elevation[index],
      );
      return {
        generation: e.windPeakOutput * currentWindFactor(state) * bonus,
        peak: e.windPeakOutput * bonus,
      };
    }
    case PlantType.RunOfRiver: {
      const bonus = 1 + BALANCE.terrain.hydroDropBonus * riverDropAt(state, index);
      return {
        generation: e.hydroPeakOutput * riverFlowFactor(state) * bonus,
        peak: e.hydroPeakOutput * bonus,
      };
    }
    case PlantType.BiogasPlant: {
      // Biogas is dispatched city-wide; show this plant's equal share.
      const plants = censusPlants(state).biogasPlants;
      return {
        generation: plants > 0 ? state.lastEnergy.biogas / plants : 0,
        peak: e.biogasMaxOutput,
      };
    }
    case PlantType.HydrogenPlant: {
      // The fuel cell dispatches city-wide too; equal share per plant.
      const plants = censusPlants(state).hydrogenPlants;
      return {
        generation: plants > 0 ? state.lastEnergy.fuelCell / plants : 0,
        peak: BALANCE.hydrogen.fuelCellPowerLimit,
      };
    }
    case PlantType.TidalPlant: {
      const bonus = tidalSiteFactor(state, index);
      return {
        generation: e.tidalPeakOutput * tideFactor(state.tick) * bonus,
        peak: e.tidalPeakOutput * bonus,
      };
    }
    case PlantType.GeothermalPlant: {
      // Quantised reservoirHeat, not the field's float `heat` — see energy.ts's
      // censusPlants for why that's deliberate.
      const factor =
        BALANCE.geothermal.qualityFactor[state.layers.geothermal[index]] *
        (state.layers.reservoirHeat[index] / FULL_HEAT);
      return {
        generation: e.geothermalPeakOutput * factor,
        // A geothermal plant is always at its peak — the peak is what moves.
        peak: e.geothermalPeakOutput * factor,
      };
    }
    default:
      return { generation: 0, peak: 0 };
  }
}

/** What this plant tile holds, straight off the tile (0 unless it stores). */
function plantStorage(state: SimState, index: number): { stored: number; capacity: number } {
  const capacity = storageCapacityAt(state, index);
  return capacity > 0
    ? { stored: state.layers.stored[index], capacity }
    : { stored: 0, capacity: 0 };
}

/** Reasons a zoned tile is not spawning or densifying right now. */
function growthBlockers(state: SimState, index: number, connected: boolean): GrowthBlocker[] {
  const { layers } = state;
  const zone = layers.zone[index] as Zone;
  if (zone === Zone.None || layers.tileType[index] !== TileType.Empty) return [];

  const blockers: GrowthBlocker[] = [];
  const density = layers.density[index];
  if (layers.terrain[index] !== Terrain.Land) blockers.push('notLand');
  if (!hasRoadAccess(state, index)) blockers.push('noRoad');
  if (demandFor(state.lastDemand, zone) < BALANCE.growth.growthDemandThreshold) {
    blockers.push('lowDemand');
  }
  if (state.happiness < BALANCE.happiness.growthMinimum) blockers.push('cityUnhappy');
  if (density === 0) {
    if (layers.supplied[index] === SupplyStatus.Undersupplied) blockers.push('undersupplied');
  } else if (density >= 3) {
    blockers.push('maxDensity');
  } else {
    if (layers.buildingAge[index] < BALANCE.growth.densifyMinAge) blockers.push('tooYoung');
    if (density === 2 && (layers.services[index] & SERVICE_FIRE) === 0) {
      blockers.push('noFireCoverage');
    }
    if (zone === Zone.Retail && !isShopSupplied(state, index)) blockers.push('noDeliveries');
    if (energySystemActive(state) && layers.supplied[index] !== SupplyStatus.Supplied) {
      blockers.push(connected ? 'undersupplied' : 'notConnected');
    }
  }
  return blockers;
}

/** The ring a tile projects on the map (see TileInfo.ringRadius). */
function ringRadius(state: SimState, index: number, connected: boolean): number {
  const { tileType, plantType, powerLine } = state.layers;
  if (tileType[index] === TileType.Plant) {
    const plant = plantType[index] as PlantType;
    if (plant === PlantType.Park) return BALANCE.happiness.parkRadius;
    if (plant === PlantType.ChargingHub) return BALANCE.vehicles.hubRadius;
    if (plant === PlantType.FireStation) return BALANCE.services.fire.radius;
    if (plant === PlantType.PoliceStation) return BALANCE.services.police.radius;
    if (isSupplySource(plant)) return BALANCE.energy.lineSupplyRadius;
    return 0;
  }
  if (isBusStop(state, index)) return BALANCE.transit.stopRadius;
  // A dead line (not reached from any plant) supplies nothing.
  if (powerLine[index] !== 0 && connected) return BALANCE.energy.lineSupplyRadius;
  return 0;
}

/** A heat plant's own network: reach and the buildings beside it. */
function heatPlantInfo(state: SimState, index: number, connected: boolean) {
  const { layers } = state;
  const reach = plantReach(state, index);
  const served = new Set<number>();
  for (const road of reach) {
    for (const neighbor of neighbors4(road, state.size)) {
      if (layers.tileType[neighbor] !== TileType.Empty || layers.density[neighbor] === 0) continue;
      // Agrees with recomputeHeated's gate: a damaged or unconnected
      // building is dark, so it does not count as served.
      if (layers.damage[neighbor] !== 0 || layers.energized[neighbor] !== 1) continue;
      served.add(neighbor);
    }
  }
  return {
    reach: reach.length,
    served: served.size,
    cop: heatPumpCop(state.season.temperature),
    active: connected && layers.damage[index] === 0,
  };
}

/** Full inspector snapshot for one tile, or null when out of bounds. */
export function inspectTile(state: SimState, index: number): TileInfo | null {
  const { layers } = state;
  if (index < 0 || index >= layers.tileType.length) return null;

  const tileType = layers.tileType[index] as TileType;
  const zone = layers.zone[index] as Zone;
  const plant = layers.plantType[index] as PlantType;
  const density = layers.density[index];
  const time = (state.tick % TICKS_PER_DAY) / TICKS_PER_DAY;
  const isBuilding = tileType === TileType.Empty && density > 0;
  // A supply plant always energises its own ring, so the energized layer
  // says nothing about whether it is tied into the network. For those,
  // "connected" means a power line is attached to it or to a plant of
  // its park; every other tile asks whether the network reaches it.
  const connected =
    tileType === TileType.Plant && isSupplySource(plant)
      ? isTiedToGrid(state, index)
      : isTileConnected(state, index);

  const isStationPlant = tileType === TileType.Plant && isStation(plant);
  const loadFactor = isBuilding ? loadProfileFactor(zone, time) : 0;
  const consumption = isBuilding
    ? buildingConsumption(zone, density, time)
    : isStationPlant && connected
      ? BALANCE.services.stationConsumption
      : 0;
  const peakConsumption = isBuilding
    ? (BALANCE.energy.consumptionByZoneAndDensity[zone]?.[density] ?? 0)
    : isStationPlant
      ? BALANCE.services.stationConsumption
      : 0;

  const rooftopPeak = isBuilding ? (BALANCE.energy.rooftopSolarPeakByDensity[density] ?? 0) : 0;
  const rooftop = connected ? rooftopPeak * currentSolarFactor(state) : 0;
  const plantOutput =
    tileType === TileType.Plant ? plantGeneration(state, plant, index) : { generation: 0, peak: 0 };
  const storage =
    tileType === TileType.Plant ? plantStorage(state, index) : { stored: 0, capacity: 0 };

  const population =
    isBuilding && zone === Zone.Residential ? BALANCE.growth.populationByDensity[density] : 0;
  const jobs = isBuilding ? (BALANCE.growth.jobsByZoneAndDensity[zone]?.[density] ?? 0) : 0;

  const upkeepPerTick =
    tileType === TileType.Road
      ? BALANCE.upkeepPerTick.roadPerTile +
        (layers.busStop[index] !== 0 ? BALANCE.upkeepPerTick.busStop : 0)
      : tileType === TileType.Plant
        ? (BALANCE.upkeepPerTick.plant[plant] ?? 0)
        : 0;
  const fuelCostPerTick =
    plant === PlantType.BiogasPlant
      ? plantOutput.generation * BALANCE.upkeepPerTick.biogasFuelCostPerEnergyUnit
      : 0;

  const cityPopulation = countPopulationAndJobs(state).population;
  const tileTaxFactor =
    isBuilding && (layers.services[index] & SERVICE_POLICE) === 0
      ? policeTaxFactor(0, cityPopulation)
      : 1;

  const elevation = layers.elevation[index];
  const slope = slopeAt(state, index);
  const terrainBonus =
    tileType === TileType.Plant
      ? plant === PlantType.WindTurbine
        ? windTurbineFactor(state, index, 1 + BALANCE.terrain.windBonusPerLevel * elevation)
        : plant === PlantType.RunOfRiver
          ? 1 + BALANCE.terrain.hydroDropBonus * riverDropAt(state, index)
          : plant === PlantType.PumpedStorage
            ? 1 + BALANCE.terrain.headBonusPerLevel * pumpedHeadAt(state, index)
            : plant === PlantType.TidalPlant
              ? tidalSiteFactor(state, index)
              : 1
      : 1;

  const n = islandOf(state, index);
  const islandStats = state.lastIslands.find((i) => i.number === n);

  const field = fieldAt(state, index);
  const hotspot = field
    ? {
        quality: field.quality,
        heat: field.heat,
        wells: field.tiles.filter(
          (tile) =>
            layers.tileType[tile] === TileType.Plant &&
            layers.plantType[tile] === PlantType.GeothermalPlant,
        ).length,
        capacity: field.capacity,
      }
    : undefined;

  return {
    index,
    x: tileX(index, state.size),
    y: tileY(index, state.size),
    tileType,
    terrain: layers.terrain[index] as Terrain,
    zone,
    density,
    plantType: plant,
    supplied: layers.supplied[index] as SupplyStatus,
    connected,
    ringRadius: ringRadius(state, index, connected),
    ...(hotspot ? { hotspot } : {}),
    upkeepPerTick,
    fuelCostPerTick,
    taxPerTick:
      tileTaxFactor *
      state.taxRate *
      (population * BALANCE.tax.incomePerResident +
        jobs *
          (zone === Zone.Industrial
            ? BALANCE.tax.incomePerIndustrialJob
            : BALANCE.tax.incomePerJob)),
    consumption,
    peakConsumption,
    loadFactor,
    generation: plantOutput.generation + rooftop,
    peakGeneration: plantOutput.peak + rooftopPeak,
    storedEnergy: storage.stored,
    storageCapacity: storage.capacity,
    population,
    jobs,
    demand: demandFor(state.lastDemand, zone),
    buildingAge: layers.buildingAge[index],
    troubledTicks: layers.troubledTicks[index],
    damage: layers.damage[index],
    disaster: disasterKindAt(state, index),
    fireCovered: isBuilding && (layers.services[index] & SERVICE_FIRE) !== 0,
    policeCovered: isBuilding && (layers.services[index] & SERVICE_POLICE) !== 0,
    heated: isBuilding && layers.heated[index] === HEATED_SERVED,
    ...(tileType === TileType.Plant && plant === PlantType.HeatPlant
      ? { heatPlant: heatPlantInfo(state, index, connected) }
      : {}),
    ...(islandStats
      ? {
          island: {
            number: n,
            key: islandStats.key,
            generation: islandStats.generation,
            consumption: islandStats.consumption,
            deficit: islandStats.deficit,
            substations: islandStats.substations,
          },
        }
      : {}),
    ...(tileType === TileType.Plant && plant === PlantType.Substation && islandStats
      ? {
          substation: {
            island: n,
            gridImport: islandStats.gridImport,
            gridExport: islandStats.gridExport,
            importCapacity: islandStats.substations * BALANCE.market.importCapacity,
            exportCapacity: islandStats.substations * BALANCE.market.exportCapacity,
          },
        }
      : {}),
    stationActive: tileType === TileType.Plant && isStation(plant) && connected,
    roadClass: (tileType === TileType.Road
      ? layers.roadClass[index]
      : RoadClass.Street) as RoadClass,
    trafficLoad: tileType === TileType.Road ? layers.trafficLoad[index] : 0,
    laneCapacity: tileType === TileType.Road ? laneCapacity(state, index) : 0,
    deliveryState: deliveryState(state, index),
    deliveryAgeTicks: isBuilding && zone === Zone.Retail ? layers.deliveryAge[index] : 0,
    depot:
      tileType === TileType.Plant && plant === PlantType.LogisticsDepot
        ? depotInfo(state, index)
        : null,
    busStop: isBusStop(state, index),
    stopState: stopState(state, index),
    stopAgeTicks: isBusStop(state, index) ? layers.stopAge[index] : 0,
    transitCovered: tileType === TileType.Road && layers.transitCover[index] === 1,
    busDepot:
      tileType === TileType.Plant && plant === PlantType.BusDepot
        ? busDepotInfo(state, index)
        : null,
    growthBlockers: growthBlockers(state, index, connected),
    elevation,
    slope,
    forest: layers.forest[index],
    terrainBonus,
  };
}
