import { TICKS_PER_DAY } from '../shared/constants.ts';
import { PlantType, RoadClass } from '../shared/types.ts';
import type { EnergyHistoryPoint, GlobalStats } from '../shared/types.ts';
import { deliveriesStep, deliveryStats } from './deliveries.ts';
import { economyStep } from './economy.ts';
import { energyStep } from './energy.ts';
import { reservoirStep } from './geothermal.ts';
import { goalsStep, goalStates } from './goals.ts';
import { inspectTile } from './inspect.ts';
import { computeDemand, decayStep, growthStep } from './growth.ts';
import { forestShare, forestStep } from './forest.ts';
import { happinessStep } from './happiness.ts';
import { countPowerLineTiles } from './powerLines.ts';
import { tideState } from './sea.ts';
import { seasonState } from './seasons.ts';
import { recomputeServices, serviceCoverage } from './services.ts';
import { updateTrafficLoad } from './traffic.ts';
import { transitStep, transitStats } from './transit.ts';
import { chargingDemand, drivingVehicleCount, vehiclesStep } from './vehicles.ts';
import { updateWeather } from './weather.ts';
import {
  countPopulationAndJobs,
  TileType,
  totalBiogasCapacity,
  totalHydrogenCapacity,
  totalPumpedStorageCapacity,
  totalStorageCapacity,
  Zone,
  type SimState,
} from './state.ts';

/** 0..1, 0 = midnight, 0.5 = noon. */
export function timeOfDay(tick: number): number {
  return (tick % TICKS_PER_DAY) / TICKS_PER_DAY;
}

export function dayNumber(tick: number): number {
  return Math.floor(tick / TICKS_PER_DAY);
}

/** Advance the simulation by exactly one tick. */
export function stepTick(state: SimState): void {
  state.tick++;
  // Season first: weather biases, snow, heating and cooling all read it this tick.
  state.season = seasonState({
    day: dayNumber(state.tick),
    timeOfDay: timeOfDay(state.tick),
    seasonOriginDay: state.seasonOriginDay,
    cloudCover: state.weather.cloudCover,
  });
  updateWeather(state);
  const occupancy = vehiclesStep(state);
  deliveriesStep(state, occupancy);
  state.lastDeliveries = deliveryStats(state);
  transitStep(state, occupancy);
  state.lastTransit = transitStats(state);
  updateTrafficLoad(state, occupancy);
  // Reservoirs first: this tick's generation reads the heat they leave.
  reservoirStep(state);
  energyStep(state, { chargingDemand: chargingDemand(state) });
  recomputeServices(state);
  state.lastServices = serviceCoverage(state);
  state.lastDemand = computeDemand(state);
  growthStep(state, state.lastDemand);
  decayStep(state);
  forestStep(state);
  const { population, jobs } = countPopulationAndJobs(state);
  economyStep(state, population, jobs);
  happinessStep(state, population);
  goalsStep(state);
  recordLifetime(state, population, jobs);
}

/** Cap on stored daily samples (oldest are dropped beyond this). */
const MAX_LIFETIME_SAMPLES = 365;

/** Accumulate day sums; at each day rollover, store one daily sample. */
function recordLifetime(state: SimState, population: number, jobs: number): void {
  const e = state.lastEnergy;
  const sums = state.lifetime.daySums;
  sums.generation += e.solar + e.wind + e.rooftop + e.hydro + e.tidal + e.biogas;
  sums.consumption +=
    e.buildingConsumption + e.chargingConsumption + e.heatingConsumption + e.coolingConsumption;
  sums.heating += e.heatingConsumption;
  sums.cooling += e.coolingConsumption;
  sums.temperature += state.season.temperature;
  sums.ticks++;

  if (state.tick % TICKS_PER_DAY !== 0) return;
  const ticks = Math.max(1, sums.ticks);
  state.lifetime.samples.push({
    day: dayNumber(state.tick) - 1,
    population,
    jobs,
    happiness: state.happiness,
    avgGeneration: sums.generation / ticks,
    avgConsumption: sums.consumption / ticks,
    money: state.money,
    temperature: sums.temperature / ticks,
    heating: sums.heating / ticks,
    cooling: sums.cooling / ticks,
  });
  if (state.lifetime.samples.length > MAX_LIFETIME_SAMPLES) {
    state.lifetime.samples.shift();
  }
  sums.generation = 0;
  sums.consumption = 0;
  sums.heating = 0;
  sums.cooling = 0;
  sums.temperature = 0;
  sums.ticks = 0;
}

function countTiles(state: SimState): {
  roadTiles: number;
  avenueTiles: number;
  zonedTiles: number;
  plantTiles: number;
  buildingTiles: number;
  powerLineTiles: number;
  /** Logistics depots only; bus depots are tracked separately in transitStats. */
  depots: number;
} {
  const { tileType, zone, density, roadClass, plantType } = state.layers;
  const counts = {
    roadTiles: 0,
    avenueTiles: 0,
    zonedTiles: 0,
    plantTiles: 0,
    buildingTiles: 0,
    powerLineTiles: countPowerLineTiles(state),
    depots: 0,
  };
  for (let i = 0; i < tileType.length; i++) {
    if (tileType[i] === TileType.Road) {
      counts.roadTiles++;
      if (roadClass[i] === RoadClass.Avenue) counts.avenueTiles++;
    } else if (tileType[i] === TileType.Plant) {
      counts.plantTiles++;
      if (plantType[i] === PlantType.LogisticsDepot) counts.depots++;
    } else {
      if (zone[i] !== Zone.None) counts.zonedTiles++;
      if (density[i] > 0) counts.buildingTiles++;
    }
  }
  return counts;
}

export function buildStats(state: SimState): GlobalStats {
  const { population, jobs } = countPopulationAndJobs(state);
  const e = state.lastEnergy;
  const counts = countTiles(state);
  return {
    seed: state.seed,
    tick: state.tick,
    money: state.money,
    population,
    jobs,
    happiness: state.happiness,
    demand: { ...state.lastDemand },
    timeOfDay: timeOfDay(state.tick),
    day: dayNumber(state.tick),
    weather: { ...state.weather },
    season: { ...state.season },
    energy: {
      generation: {
        solar: e.solar,
        wind: e.wind,
        biogas: e.biogas,
        rooftop: e.rooftop,
        hydro: e.hydro,
        tidal: e.tidal,
        hydrogen: e.fuelCell,
        geothermal: 0,
      },
      consumption: {
        buildings: e.buildingConsumption,
        charging: e.chargingConsumption,
        heating: e.heatingConsumption,
        cooling: e.coolingConsumption,
        electrolysis: e.electrolysis,
      },
      storedEnergy: state.storedEnergy,
      storageCapacity: totalStorageCapacity(state),
      pumpedStoredEnergy: state.pumpedStorageEnergy,
      pumpedCapacity: totalPumpedStorageCapacity(state),
      hydrogenStoredEnergy: state.hydrogenEnergy,
      hydrogenCapacity: totalHydrogenCapacity(state),
      hydrogenSold: e.hydrogenSold,
      spotPrice: e.spotPrice,
      tradeSell: e.tradeSell,
      tradeBuy: e.tradeBuy,
      biogasCapacity: totalBiogasCapacity(state),
      curtailment: e.curtailment,
      deficit: e.deficit,
      gridImport: e.gridImport,
      gridExport: e.gridExport,
      history: state.energyHistory.slice(),
      pending: pendingHistoryPoint(state),
    },
    taxRate: state.taxRate,
    speed: state.speed,
    smartCharging: state.smartCharging,
    marketTrading: state.marketTrading,
    insulation: state.insulation,
    services: { ...state.lastServices },
    forestShare: forestShare(state),
    tide: tideState(state.tick),
    traffic: {
      congestion: state.commuteCongestion,
      driving: drivingVehicleCount(state),
      avenueShare: counts.roadTiles > 0 ? counts.avenueTiles / counts.roadTiles : 0,
    },
    deliveries: { ...state.lastDeliveries },
    transit: { ...state.lastTransit },
    goals: goalStates(state),
    counts,
    budget: buildBudget(state),
    inspected: state.inspectedTile >= 0 ? inspectTile(state, state.inspectedTile) : null,
  };
}

/**
 * Average of the history sample under construction. Right after a sample
 * was flushed nothing has accumulated yet, so fall back to that sample —
 * the value the graph's leading edge is sitting on anyway.
 */
export function pendingHistoryPoint(state: SimState): EnergyHistoryPoint {
  const accum = state.energyHistoryAccum;
  if (accum.ticks === 0) {
    const last = state.energyHistory[state.energyHistory.length - 1];
    return last ? { ...last } : { generation: 0, consumption: 0, stateOfCharge: 0, price: 1 };
  }
  return {
    generation: accum.generation / accum.ticks,
    consumption: accum.consumption / accum.ticks,
    stateOfCharge: accum.soc / accum.ticks,
    price: accum.price / accum.ticks,
  };
}

/** Last tick's budget, flattened for the budget panel. */
function buildBudget(state: SimState): GlobalStats['budget'] {
  const b = state.lastEconomy;
  return {
    taxIncome: b.taxIncome,
    gridExportRevenue: b.gridExportRevenue,
    hydrogenRevenue: b.hydrogenRevenue,
    gridUpkeep: b.gridUpkeep,
    plantUpkeep: b.plantUpkeep,
    plantUpkeepByType: { ...b.plantUpkeepByType },
    plantCountByType: { ...b.plantCountByType },
    roadTiles: b.roadTiles,
    avenueTiles: b.avenueTiles,
    avenueUpkeep: b.avenueUpkeep,
    busStops: b.busStops,
    busStopUpkeep: b.busStopUpkeep,
    biogasFuelCost: b.biogasFuelCost,
    gridImportCost: b.gridImportCost,
    net:
      b.taxIncome +
      b.gridExportRevenue +
      b.hydrogenRevenue -
      b.gridUpkeep -
      b.plantUpkeep -
      b.biogasFuelCost -
      b.gridImportCost,
  };
}
