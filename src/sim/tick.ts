import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import { PlantType, RoadClass, RoadLane } from '../shared/types.ts';
import type { EnergyHistoryPoint, GlobalStats } from '../shared/types.ts';
import { callHoursLeft, demandResponseStep } from './demandResponse.ts';
import { deliveriesStep, deliveryStats } from './deliveries.ts';
import { disasterStats, disastersStep, repairStep } from './disasters.ts';
import { economyStep } from './economy.ts';
import { financeStep } from './finance.ts';
import {
  policiesStep,
  policyDailyCost,
  policyHappiness,
  smartMeterCityCost,
  smartMeterInstallsPerDay,
} from './policies.ts';
import { energyStep } from './energy.ts';
import { reservoirStep } from './geothermal.ts';
import { heatStep } from './heat.ts';
import { meteredCoverage, smartMetersStep } from './smartMeters.ts';
import { goalsStep, goalStates } from './goals.ts';
import { inspectTile } from './inspect.ts';
import { computeDemand, decayStep, growthStep } from './growth.ts';
import { forestShare, forestStep } from './forest.ts';
import { happinessStep } from './happiness.ts';
import { countPowerLineTiles } from './powerLines.ts';
import { railStats } from './rail.ts';
import { tideState } from './sea.ts';
import { scenarioDef } from './scenarios/registry.ts';
import { scenarioStep } from './scenarios/step.ts';
import { seasonState } from './seasons.ts';
import { storedByKind } from './storage.ts';
import { recomputeServices, serviceCoverage } from './services.ts';
import { updateTrafficLoad } from './traffic.ts';
import { transitStep, transitStats } from './transit.ts';
import { tractionDemandByIsland, trainsStep } from './trains.ts';
import { chargingDemandByIsland, drivingVehicleCount, vehiclesStep } from './vehicles.ts';
import { scenarioStats } from './scenarios/stats.ts';
import { updateWeather } from './weather.ts';
import {
  countPopulationAndJobs,
  TileType,
  totalBiogasCapacity,
  totalHeatCapacityOnIsland,
  totalHydrogenCapacityOnIsland,
  totalPumpedStorageCapacityOnIsland,
  totalStorageCapacityOnIsland,
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
  // Before generation and connectivity: this tick's damage must already
  // be in effect when the energy balance is computed.
  disastersStep(state);
  const occupancy = vehiclesStep(state);
  deliveriesStep(state, occupancy);
  state.lastDeliveries = deliveryStats(state);
  transitStep(state, occupancy);
  state.lastTransit = transitStats(state);
  state.lastRail = railStats(state, trainsStep(state));
  updateTrafficLoad(state, occupancy);
  // Reservoirs first: this tick's generation reads the heat they leave.
  reservoirStep(state);
  // The heat network before the balance: served buildings leave the
  // heating load, the pumps join it, and the cascade may fill the store.
  const heat = heatStep(state);
  energyStep(state, {
    chargingByIsland: chargingDemandByIsland(state),
    tractionByIsland: tractionDemandByIsland(state),
    heat,
  });
  recomputeServices(state);
  state.lastServices = serviceCoverage(state);
  state.lastDemand = computeDemand(state);
  growthStep(state, state.lastDemand);
  decayStep(state);
  forestStep(state);
  const { population, jobs, industrialJobs } = countPopulationAndJobs(state);
  // After growth and decay, before economy, goals and the stats:
  // smartMetersStep refreshes state.lastBuildingCount (the tick's one
  // building scan) and everything downstream reads coverage off it. The
  // steps above — vehicles and the energy balance — read last tick's
  // count, one tick of lag the mechanic does not notice.
  smartMetersStep(state);
  // The contract bills what the energy step shed this tick.
  demandResponseStep(state);
  economyStep(state, population, jobs, industrialJobs);
  policiesStep(state);
  // After the income of this tick has landed: repairs are paid out of it.
  repairStep(state);
  // After every operating flow of the tick: the day's income feeds the rating.
  financeStep(state, operatingNet(state));
  happinessStep(state, population);
  goalsStep(state);
  if (state.scenario) scenarioStep(state, scenarioDef(state.scenario.id));
  recordLifetime(state, population, jobs);
}

/** Cap on stored daily samples (oldest are dropped beyond this). */
const MAX_LIFETIME_SAMPLES = 365;

/** Accumulate day sums; at each day rollover, store one daily sample. */
function recordLifetime(state: SimState, population: number, jobs: number): void {
  const e = state.lastEnergy;
  const sums = state.lifetime.daySums;
  sums.generation += e.solar + e.wind + e.rooftop + e.hydro + e.tidal + e.geothermal + e.biogas;
  sums.consumption +=
    e.buildingConsumption +
    e.chargingConsumption +
    e.tractionConsumption +
    e.heatingConsumption +
    e.coolingConsumption +
    e.heatPumpConsumption;
  sums.heating += e.heatingConsumption + e.heatPumpConsumption;
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

interface TileCounts {
  roadTiles: number;
  avenueTiles: number;
  zonedTiles: number;
  plantTiles: number;
  buildingTiles: number;
  powerLineTiles: number;
  railTiles: number;
  /** Logistics depots only; bus depots are tracked separately in transitStats. */
  depots: number;
}

function countTiles(state: SimState): { counts: TileCounts; avenueShare: number } {
  const { tileType, zone, density, roadClass, roadLane, plantType } = state.layers;
  // Pedestrian streets are closed to cars, so they stay out of the avenue share.
  let motorRoadTiles = 0;
  let motorAvenueTiles = 0;
  const counts: TileCounts = {
    roadTiles: 0,
    avenueTiles: 0,
    zonedTiles: 0,
    plantTiles: 0,
    buildingTiles: 0,
    powerLineTiles: countPowerLineTiles(state),
    // From this tick's rail census, so the stats cost no second scan.
    railTiles: state.lastRail.trackTiles,
    depots: 0,
  };
  for (let i = 0; i < tileType.length; i++) {
    if (tileType[i] === TileType.Road) {
      counts.roadTiles++;
      if (roadClass[i] === RoadClass.Avenue) counts.avenueTiles++;
      if (roadLane[i] !== RoadLane.Pedestrian) {
        motorRoadTiles++;
        if (roadClass[i] === RoadClass.Avenue) motorAvenueTiles++;
      }
    } else if (tileType[i] === TileType.Plant) {
      counts.plantTiles++;
      if (plantType[i] === PlantType.LogisticsDepot) counts.depots++;
    } else {
      if (zone[i] !== Zone.None) counts.zonedTiles++;
      if (density[i] > 0) counts.buildingTiles++;
    }
  }
  return { counts, avenueShare: motorRoadTiles > 0 ? motorAvenueTiles / motorRoadTiles : 0 };
}

export function buildStats(state: SimState): GlobalStats {
  const { population, jobs } = countPopulationAndJobs(state);
  const e = state.lastEnergy;
  const { counts, avenueShare } = countTiles(state);
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
        geothermal: e.geothermal,
      },
      consumption: {
        buildings: e.buildingConsumption,
        charging: e.chargingConsumption,
        traction: e.tractionConsumption,
        heating: e.heatingConsumption,
        cooling: e.coolingConsumption,
        electrolysis: e.electrolysis,
        heatPumps: e.heatPumpConsumption,
        flexDeferred: e.flexDeferred,
        flexRecovered: e.flexRecovered,
        flexBacklog: e.flexBacklog,
        shed: e.shed,
      },
      // Only intact storage on a grid island counts toward the city-wide
      // SoC figures (layers.island[i] !== 0, damage[i] === 0) — the same
      // two filters the energy history's SoC applies, so the panel's
      // bars and the graph's line never disagree.
      storedEnergy: storedByKind(state, PlantType.Battery, true),
      storageCapacity: totalStorageCapacityOnIsland(state),
      pumpedStoredEnergy: storedByKind(state, PlantType.PumpedStorage, true),
      pumpedCapacity: totalPumpedStorageCapacityOnIsland(state),
      hydrogenStoredEnergy: storedByKind(state, PlantType.HydrogenPlant, true),
      hydrogenCapacity: totalHydrogenCapacityOnIsland(state),
      hydrogenSold: e.hydrogenSold,
      networkHeat: e.networkHeat,
      heatFallback: e.heatFallback,
      heatStoreCharge: e.heatStoreCharge,
      heatStored: storedByKind(state, PlantType.HeatStore, true),
      heatCapacity: totalHeatCapacityOnIsland(state),
      heatCop: e.heatCop,
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
    islands: state.lastIslands.map((island) => ({ ...island })),
    taxRate: state.taxRate,
    speed: state.speed,
    smartMeters: {
      active: state.smartMeters.active,
      metered: state.smartMeters.metered,
      buildings: state.lastBuildingCount,
      coverage: meteredCoverage(state),
      costPerMeter: smartMeterCityCost(state),
      installsPerDay: smartMeterInstallsPerDay(state),
    },
    demandResponse: {
      active: state.demandResponse.active,
      pool: e.shedPool,
      shed: e.shed,
      callHoursLeft: callHoursLeft(state),
      contractedBuildings: e.contractedBuildings,
      retainerPerBuildingPerDay: BALANCE.demandResponse.retainerPerBuildingPerDay,
      activationPrice: BALANCE.demandResponse.activationPricePerEnergyUnit,
    },
    marketTrading: state.marketTrading,
    insulation: state.insulation,
    policies: {
      active: { ...state.policies },
      dailyCost: policyDailyCost(state),
      happiness: policyHappiness(state),
    },
    services: { ...state.lastServices },
    disasters: disasterStats(state),
    forestShare: forestShare(state),
    tide: tideState(state.tick),
    traffic: {
      congestion: state.commuteCongestion,
      driving: drivingVehicleCount(state),
      avenueShare,
    },
    deliveries: { ...state.lastDeliveries },
    transit: { ...state.lastTransit },
    rail: { ...state.lastRail },
    goals: goalStates(state),
    ...(state.scenario ? { scenario: scenarioStats(state) } : {}),
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
    return last
      ? { ...last }
      : { generation: 0, consumption: 0, unshifted: 0, stateOfCharge: 0, price: 1 };
  }
  return {
    generation: accum.generation / accum.ticks,
    consumption: accum.consumption / accum.ticks,
    unshifted: accum.unshifted / accum.ticks,
    stateOfCharge: accum.soc / accum.ticks,
    price: accum.price / accum.ticks,
  };
}

/**
 * Last tick's operating income: tax, export and hydrogen revenue minus
 * upkeep and running costs. Excludes credit flows, interest and the grid
 * fee; the budget net and the credit rating both read it.
 */
export function operatingNet(state: SimState): number {
  const b = state.lastEconomy;
  return (
    b.taxIncome +
    b.gridExportRevenue +
    b.hydrogenRevenue -
    b.gridUpkeep -
    b.plantUpkeep -
    b.biogasFuelCost -
    b.gridImportCost -
    state.lastRepairCost -
    state.lastSmartMeterCost -
    state.lastDemandResponseCost -
    state.lastGoodsImportCost -
    state.lastPolicyCost
  );
}

/** Last tick's budget, flattened for the budget panel. */
function buildBudget(state: SimState): GlobalStats['budget'] {
  const b = state.lastEconomy;
  const f = state.lastFinance;
  const interest = f.interest + f.overdraftInterest;
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
    repair: state.lastRepairCost,
    smartMeters: state.lastSmartMeterCost,
    demandResponse: state.lastDemandResponseCost,
    goodsImport: state.lastGoodsImportCost,
    policies: state.lastPolicyCost,
    gridImportCost: b.gridImportCost,
    gridFees: f.gridFeeIncome,
    interest,
    repayment: f.principal,
    // Repayment is cash flow, not part of the net.
    net: operatingNet(state) + f.gridFeeIncome - interest,
  };
}
