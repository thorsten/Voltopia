import { BALANCE } from '../shared/constants.ts';
import { PlantType, RoadClass, TileType } from '../shared/types.ts';
import { countPowerLineTiles } from './powerLines.ts';
import type { BuildResult } from './roads.ts';
import type { SimState } from './state.ts';
import { countBusStops } from './transit.ts';

export interface EconomyBreakdown {
  taxIncome: number;
  gridUpkeep: number;
  plantUpkeep: number;
  /** Upkeep split per plant type (feeds the budget panel). */
  plantUpkeepByType: Record<PlantType, number>;
  /** Plants placed per type (feeds the budget panel). */
  plantCountByType: Record<PlantType, number>;
  roadTiles: number;
  /** Road tiles that are avenues (subset of roadTiles). */
  avenueTiles: number;
  biogasFuelCost: number;
  gridImportCost: number;
  gridExportRevenue: number;
  /** Revenue from hydrogen sold while the tanks were full. */
  hydrogenRevenue: number;
  /** Upkeep of the avenue tiles (part of gridUpkeep). */
  avenueUpkeep: number;
  /** Bus stops on the roads. */
  busStops: number;
  /** Upkeep of the bus stops (part of gridUpkeep). */
  busStopUpkeep: number;
}

/** Zero-initialised map over every plant type. */
export function emptyPlantMap(): Record<PlantType, number> {
  const map = {} as Record<PlantType, number>;
  for (const value of Object.values(PlantType)) map[value] = 0;
  return map;
}

/**
 * Tax multiplier for police coverage: 1 while the city is small, then a
 * blend of full tax for covered buildings and uncoveredTaxFactor for the
 * rest.
 *
 * `police` is a share of building tiles while tax is weighted by residents
 * and jobs, so the budget and the per-tile inspector agree exactly at 0 and
 * 1 coverage and approximate in between.
 */
export function policeTaxFactor(police: number, population: number): number {
  const { minPopulation, uncoveredTaxFactor } = BALANCE.services;
  if (population < minPopulation) return 1;
  return police + (1 - police) * uncoveredTaxFactor;
}

/**
 * One tick of the city budget: tax income from residents and jobs
 * (industrial jobs at their own rate) minus
 * upkeep for roads and plants (biogas additionally pays per energy unit
 * generated — dispatchable but expensive).
 */
export function economyStep(
  state: SimState,
  population: number,
  jobs: number,
  industrialJobs = 0,
): EconomyBreakdown {
  const { tileType, plantType, roadClass } = state.layers;
  const { incomePerResident, incomePerJob, incomePerIndustrialJob } = BALANCE.tax;

  // Industrial jobs (a share of `jobs`) pay the trade rate.
  const taxIncome =
    policeTaxFactor(state.lastServices.police, population) *
    state.taxRate *
    (population * incomePerResident +
      (jobs - industrialJobs) * incomePerJob +
      industrialJobs * incomePerIndustrialJob);

  let roadTiles = 0;
  let avenueTiles = 0;
  let plantUpkeep = 0;
  const plantUpkeepByType = emptyPlantMap();
  const plantCountByType = emptyPlantMap();
  for (let i = 0; i < tileType.length; i++) {
    if (tileType[i] === TileType.Road) {
      roadTiles++;
      if (roadClass[i] === RoadClass.Avenue) avenueTiles++;
    } else if (tileType[i] === TileType.Plant) {
      const plant = plantType[i] as PlantType;
      const upkeep = BALANCE.upkeepPerTick.plant[plant] ?? 0;
      plantUpkeep += upkeep;
      plantUpkeepByType[plant] += upkeep;
      plantCountByType[plant]++;
    }
  }
  const avenueUpkeep = avenueTiles * BALANCE.upkeepPerTick.avenuePerTile;
  const busStops = countBusStops(state);
  const busStopUpkeep = busStops * BALANCE.upkeepPerTick.busStop;
  // Grid upkeep: roads, avenues, power lines and bus stops share one line item.
  const gridUpkeep =
    (roadTiles - avenueTiles) * BALANCE.upkeepPerTick.roadPerTile +
    avenueUpkeep +
    countPowerLineTiles(state) * BALANCE.upkeepPerTick.powerLinePerTile +
    busStopUpkeep;
  const biogasFuelCost =
    state.lastEnergy.biogas * BALANCE.upkeepPerTick.biogasFuelCostPerEnergyUnit;
  // All link traffic of a tick trades at that tick's spot price.
  const spot = state.lastEnergy.spotPrice;
  const gridImportCost =
    state.lastEnergy.gridImport * BALANCE.market.importCostPerEnergyUnit * spot;
  const gridExportRevenue =
    state.lastEnergy.gridExport * BALANCE.market.exportRevenuePerEnergyUnit * spot;
  const hydrogenRevenue = state.lastEnergy.hydrogenSold * BALANCE.hydrogen.saleRevenuePerEnergyUnit;

  state.money +=
    taxIncome +
    gridExportRevenue +
    hydrogenRevenue -
    gridUpkeep -
    plantUpkeep -
    biogasFuelCost -
    gridImportCost;
  const breakdown: EconomyBreakdown = {
    taxIncome,
    gridUpkeep,
    plantUpkeep,
    plantUpkeepByType,
    plantCountByType,
    roadTiles,
    avenueTiles,
    biogasFuelCost,
    gridImportCost,
    gridExportRevenue,
    hydrogenRevenue,
    avenueUpkeep,
    busStops,
    busStopUpkeep,
  };
  state.lastEconomy = breakdown;
  return breakdown;
}

/** One-off, city-wide building insulation: halves the heating load. Not undoable. */
export function buyInsulation(state: SimState): BuildResult {
  if (state.insulation) return { rejected: 'alreadyInsulated' };
  const cost = BALANCE.costs.insulation;
  if (cost > state.money) return { rejected: 'notEnoughMoney' };
  state.money -= cost;
  state.insulation = true;
  return {};
}
