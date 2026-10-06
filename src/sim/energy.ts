import { BALANCE, TICKS_PER_HISTORY_SAMPLE } from '../shared/constants.ts';
import { HEATED_SERVED, PlantType, Terrain, Zone, type IslandStats } from '../shared/types.ts';
import { clearForest, fellingCost, windForestFactor } from './forest.ts';
import { FULL_HEAT } from './geothermal.ts';
import { IDLE_HEAT, nightNeedsHeat, type HeatTickResult } from './heat.ts';
import { balanceIsland, type IslandResult } from './islandBalance.ts';
import { isIsolatedPlant, isolatedPlants, isSupplySource, recomputeGrid } from './powerGrid.ts';
import { poolForIsland, syncIslandPools } from './islandPools.ts';
import { meteredCoverage } from './smartMeters.ts';
import type { BuildResult } from './roads.ts';
import { tideFactor, tidalSiteFactor, windTurbineFactor } from './sea.ts';
import { coolingDegree, heatingDegree } from '../shared/heating.ts';
import {
  BuildIntent,
  buildRejection,
  bumpGridVersion,
  markDirty,
  pumpedHeadAt,
  pushEnergyHistory,
  riverDropAt,
  slopeCostMultiplier,
  snapshotTile,
  SupplyStatus,
  TileType,
  type SimState,
  type UndoEntry,
} from './state.ts';
import {
  chargeTiles,
  dischargeTiles,
  poolOf,
  storageCapacityAt,
  storageTilesByIsland,
} from './storage.ts';
import { spotPriceFactor } from './market.ts';
import { timeOfDay } from './tick.ts';
import { currentSolarFactor, currentWindFactor, riverFlowFactor } from './weather.ts';

/**
 * Quantisation of a storage tile's level in its tile diff: the level
 * moves every tick, so a tile is only re-sent once its share of capacity
 * crosses one of these steps. Fine enough that the battery fill bar
 * still rises smoothly, coarse enough that a steady city sends nothing.
 */
const SOC_STEPS = 64;

/** True once any power-related plant exists (parks don't count). */
export function hasPowerInfrastructure(state: SimState): boolean {
  const { tileType, plantType } = state.layers;
  for (let i = 0; i < tileType.length; i++) {
    if (tileType[i] !== TileType.Plant) continue;
    const plant = plantType[i] as PlantType;
    if (isSupplySource(plant) || plant === PlantType.ChargingHub) {
      return true;
    }
  }
  return false;
}

/** Fire and police stations: consumers with a coverage ring, not supply. */
export function isStation(plant: PlantType): boolean {
  return plant === PlantType.FireStation || plant === PlantType.PoliceStation;
}

/** Place a plant on an empty tile, charging its construction cost. */
export function placePlant(state: SimState, tile: number, plant: PlantType): BuildResult {
  const { layers } = state;
  if (plant === PlantType.None) return { rejected: 'noPlantSelected' };
  const rejection = buildRejection(state, tile, BuildIntent.Plant, plant);
  if (rejection) return { rejected: rejection };
  // A tidal plant can only ever stand on a sea tile, so — unlike a wind
  // turbine — it has no "choice" of going offshore: its marine cost is
  // already priced into the base cost, so it is exempt from the offshore
  // surcharge (and from the slope multiplier, since a sea tile has no
  // buildable slope of its own).
  const isTidal = plant === PlantType.TidalPlant;
  const offshore = !isTidal && state.layers.terrain[tile] === Terrain.Sea;
  const costMultiplier = isTidal
    ? 1
    : offshore
      ? BALANCE.sea.offshoreCostFactor
      : slopeCostMultiplier(state, tile);
  const cost = Math.round(BALANCE.costs.plant[plant] * costMultiplier) + fellingCost(state, tile);
  if (cost > state.money) {
    return { rejected: 'notEnoughMoney' };
  }

  const undo: UndoEntry = { moneyDelta: cost, tiles: [snapshotTile(state, tile)] };

  state.money -= cost;
  layers.tileType[tile] = TileType.Plant;
  layers.zone[tile] = Zone.None;
  layers.plantType[tile] = plant;
  // A fresh plant starts empty, whatever a demolished predecessor held.
  layers.stored[tile] = 0;
  clearForest(state, tile);
  markDirty(state, tile);
  bumpGridVersion(state);
  refreshPlantSupply(state, tile);
  state.undoStack.push(undo);
  return {};
}

interface PlantCensus {
  solarFarms: number;
  windTurbines: number;
  batteries: number;
  biogasPlants: number;
  chargingHubs: number;
  parks: number;
  runOfRiverPlants: number;
  pumpedStoragePlants: number;
  fireStations: number;
  policeStations: number;
  logisticsDepots: number;
  busDepots: number;
  hydrogenPlants: number;
  tidalPlants: number;
  /** Sum of wind turbines' elevation bonus factors (== count on flat maps). */
  windCapacity: number;
  /** Sum of run-of-river plants' drop bonus factors (== count on flat maps). */
  hydroCapacity: number;
  /** Sum of pumped-storage plants' head bonus factors (== count on flat maps). */
  pumpedCapacity: number;
  /** Sum of tidal plants' site factors (narrowness and estuary bonus). */
  tidalCapacity: number;
  geothermalPlants: number;
  /** Sum of geothermal plants' quality factor × reservoir heat. */
  geothermalCapacity: number;
  heatPlants: number;
  heatStores: number;
  /** Substations: each one is an import and an export link for its island. */
  substations: number;
}

function emptyCensus(): PlantCensus {
  return {
    solarFarms: 0,
    windTurbines: 0,
    batteries: 0,
    biogasPlants: 0,
    chargingHubs: 0,
    parks: 0,
    runOfRiverPlants: 0,
    pumpedStoragePlants: 0,
    fireStations: 0,
    policeStations: 0,
    logisticsDepots: 0,
    busDepots: 0,
    hydrogenPlants: 0,
    tidalPlants: 0,
    windCapacity: 0,
    hydroCapacity: 0,
    pumpedCapacity: 0,
    tidalCapacity: 0,
    geothermalPlants: 0,
    geothermalCapacity: 0,
    heatPlants: 0,
    heatStores: 0,
    substations: 0,
  };
}

/** Count one intact plant tile into a census. */
function countPlantInto(census: PlantCensus, state: SimState, i: number, plant: PlantType): void {
  const { geothermal, reservoirHeat } = state.layers;
  switch (plant) {
    case PlantType.SolarFarm:
      census.solarFarms++;
      break;
    case PlantType.WindTurbine:
      census.windTurbines++;
      // Offshore: free wind, no shelter, no height to gain. On land:
      // height helps, sheltering woods hurt (turbulence and lower wind).
      census.windCapacity += windTurbineFactor(
        state,
        i,
        (1 + BALANCE.terrain.windBonusPerLevel * state.layers.elevation[i]) *
          windForestFactor(state, i),
      );
      break;
    case PlantType.Battery:
      census.batteries++;
      break;
    case PlantType.BiogasPlant:
      census.biogasPlants++;
      break;
    case PlantType.ChargingHub:
      census.chargingHubs++;
      break;
    case PlantType.Park:
      census.parks++;
      break;
    case PlantType.RunOfRiver:
      census.runOfRiverPlants++;
      census.hydroCapacity += 1 + BALANCE.terrain.hydroDropBonus * riverDropAt(state, i);
      break;
    case PlantType.PumpedStorage:
      census.pumpedStoragePlants++;
      census.pumpedCapacity += 1 + BALANCE.terrain.headBonusPerLevel * pumpedHeadAt(state, i);
      break;
    case PlantType.FireStation:
      census.fireStations++;
      break;
    case PlantType.PoliceStation:
      census.policeStations++;
      break;
    case PlantType.LogisticsDepot:
      census.logisticsDepots++;
      break;
    case PlantType.BusDepot:
      census.busDepots++;
      break;
    case PlantType.HydrogenPlant:
      census.hydrogenPlants++;
      break;
    case PlantType.TidalPlant:
      census.tidalPlants++;
      census.tidalCapacity += tidalSiteFactor(state, i);
      break;
    case PlantType.GeothermalPlant:
      census.geothermalPlants++;
      // Reads the quantised reservoirHeat layer, not the field's authoritative
      // float `heat` — the gap is bounded by one step of 1/FULL_HEAT, and it's
      // deliberate: energy, inspector, agent API and renderer all then agree on
      // the same number.
      census.geothermalCapacity +=
        BALANCE.geothermal.qualityFactor[geothermal[i]] * (reservoirHeat[i] / FULL_HEAT);
      break;
    case PlantType.HeatPlant:
      census.heatPlants++;
      break;
    case PlantType.HeatStore:
      census.heatStores++;
      break;
    case PlantType.Substation:
      census.substations++;
      break;
    case PlantType.None:
      break;
  }
}

export function censusPlants(state: SimState): PlantCensus {
  const { tileType, plantType, damage } = state.layers;
  const census = emptyCensus();
  for (let i = 0; i < tileType.length; i++) {
    if (tileType[i] !== TileType.Plant) continue;
    // A damaged plant is out of service: no generation, no storage
    // capacity, no coverage. It heals through repairStep.
    if (damage[i] !== 0) continue;
    countPlantInto(census, state, i, plantType[i] as PlantType);
  }
  return census;
}

/**
 * One census per island, index 0 holding the plants on no island at all
 * (a heat store out of any supply ring, a plant on a damaged line), in
 * a single pass over the map — the per-island balance would otherwise
 * walk the whole grid once per island.
 */
function censusByIsland(state: SimState, islands: number): PlantCensus[] {
  const { tileType, plantType, damage, island } = state.layers;
  const census = Array.from({ length: islands }, emptyCensus);
  for (let i = 0; i < tileType.length; i++) {
    if (tileType[i] !== TileType.Plant) continue;
    if (damage[i] !== 0) continue;
    countPlantInto(census[island[i]], state, i, plantType[i] as PlantType);
  }
  return census;
}

/** Interpolated hourly load profile factor for a zone at a time of day. */
export function loadProfileFactor(zone: Zone, time: number): number {
  const profile = BALANCE.energy.loadProfileByZone[zone];
  if (!profile) return 0;
  const hour = (time * 24) % 24;
  const lower = Math.floor(hour) % 24;
  const upper = (lower + 1) % 24;
  const blend = hour - Math.floor(hour);
  return profile[lower] * (1 - blend) + profile[upper] * blend;
}

/** Base consumption of one building tile at a given time of day. */
export function buildingConsumption(zone: Zone, density: number, time: number): number {
  const base = BALANCE.energy.consumptionByZoneAndDensity[zone]?.[density] ?? 0;
  return base * loadProfileFactor(zone, time);
}

/**
 * Electric heating (heat pumps) of one building tile: grows linearly
 * with the cold below the comfort temperature, scaled by the zone's
 * heating weight; building insulation halves it.
 */
export function heatingConsumption(
  zone: Zone,
  density: number,
  temperature: number,
  insulation: boolean,
): number {
  const { weightByZone, insulationFactor } = BALANCE.seasons.heating;
  const base = BALANCE.energy.consumptionByZoneAndDensity[zone]?.[density] ?? 0;
  const weight = weightByZone[zone] ?? 0;
  return base * heatingDegree(temperature) * weight * (insulation ? insulationFactor : 1);
}

/**
 * Electric cooling (heat pumps in reverse) of one building tile: grows
 * linearly with the heat above the comfort temperature, scaled by the
 * zone's cooling weight; building insulation halves it.
 */
export function coolingConsumption(
  zone: Zone,
  density: number,
  temperature: number,
  insulation: boolean,
): number {
  const { weightByZone, insulationFactor } = BALANCE.seasons.cooling;
  const base = BALANCE.energy.consumptionByZoneAndDensity[zone]?.[density] ?? 0;
  const weight = weightByZone[zone] ?? 0;
  return base * coolingDegree(temperature) * weight * (insulation ? insulationFactor : 1);
}

/**
 * Grid connection of a single tile, computed on demand for the inspector
 * (the tick loop reads the same energized layer in bulk).
 */
export function isTileConnected(state: SimState, index: number): boolean {
  recomputeGrid(state);
  return state.layers.energized[index] === 1;
}

export interface EnergyTickInput {
  /**
   * Charging load per island this tick (index = island number, 0 = not
   * energised), served after buildings; see `chargingDemandByIsland`.
   */
  chargingByIsland: Float64Array;
  /** This tick's district-heating balance (IDLE_HEAT when absent). */
  heat?: HeatTickResult;
}

/**
 * One tick of the energy balance. Every grid island is balanced on its
 * own — a plant feeds only the island it stands on, and import, export
 * and spot trading need a substation there (see `balanceIsland` for the
 * cascade one island runs). This step is the orchestrator: it labels
 * demand, charging, heat and the plant census by island, hands each
 * island its own storage tiles, substations and pool, applies the
 * storage deltas back onto the tiles, flickers buildings under their
 * own island's deficit and sums the islands into the city-wide
 * `state.lastEnergy`. `state.lastIslands` keeps the per-island figures.
 */
export function energyStep(state: SimState, input: EnergyTickInput): void {
  const { layers } = state;
  recomputeGrid(state);
  syncIslandPools(state);
  const islands = state.islandKeys.length; // index 0 = unconnected
  const time = timeOfDay(state.tick);
  const heat = input.heat ?? { ...IDLE_HEAT };
  const temperature = state.season.temperature;
  const solarFactorNow = currentSolarFactor(state);
  const windFactorNow = currentWindFactor(state);
  const riverFlowNow = riverFlowFactor(state);
  const tideNow = tideFactor(state.tick);

  // Per-island accumulators, gathered from the tiles in the two loops
  // below (index 0 collects whatever is not energised).
  const census = censusByIsland(state, islands);
  const storage = storageTilesByIsland(state, islands);
  const buildingDemand = new Float64Array(islands);
  const heatingDemand = new Float64Array(islands);
  const coolingDemand = new Float64Array(islands);
  const rooftop = new Float64Array(islands);
  const businessDemand = new Float64Array(islands);
  const industrialDemand = new Float64Array(islands);
  const contracted = new Int32Array(islands);
  // Heat demand of the network-served buildings, per island: the share
  // of the network's fallback that lands back on their own heating.
  const servedHeat = new Float64Array(islands);
  const buildings = new Int32Array(islands);
  const tileCount = new Int32Array(islands);
  for (let i = 0; i < layers.island.length; i++) tileCount[layers.island[i]]++;

  // Service stations draw a fixed load while connected to the grid.
  for (let i = 0; i < layers.tileType.length; i++) {
    if (layers.tileType[i] !== TileType.Plant) continue;
    if (layers.damage[i] !== 0) continue;
    if (!isStation(layers.plantType[i] as PlantType)) continue;
    if (layers.energized[i] === 1) {
      buildingDemand[layers.island[i]] += BALANCE.services.stationConsumption;
    }
  }

  // Consumption of all connected buildings, plus their rooftop PV
  // feed-in (rooftop capacity grows automatically with density).
  const connectedByIsland: number[][] = Array.from({ length: islands }, (): number[] => []);
  for (let i = 0; i < layers.tileType.length; i++) {
    if (layers.tileType[i] !== TileType.Empty || layers.density[i] === 0) continue;
    // A damaged building draws nothing and reads as cut off, so the
    // existing troubled-supply path (happiness, decay) covers it.
    if (layers.damage[i] !== 0) {
      setSupplied(state, i, SupplyStatus.NotConnected);
      continue;
    }
    const connected = layers.energized[i] === 1;
    if (!connected) {
      setSupplied(state, i, SupplyStatus.NotConnected);
      continue;
    }
    const n = layers.island[i];
    connectedByIsland[n].push(i);
    buildings[n]++;
    const zone = layers.zone[i] as Zone;
    const density = layers.density[i];
    const base = buildingConsumption(zone, density, time);
    buildingDemand[n] += base;
    if (zone === Zone.Commercial || zone === Zone.Retail) {
      businessDemand[n] += base;
      contracted[n]++;
    } else if (zone === Zone.Industrial) {
      industrialDemand[n] += base;
      contracted[n]++;
    }
    const heating = heatingConsumption(zone, density, temperature, state.insulation);
    // A served building gets its heat from the network; its own
    // electric heating only runs for the fallback share (added below).
    if (layers.heated[i] === HEATED_SERVED) servedHeat[n] += heating;
    else heatingDemand[n] += heating;
    coolingDemand[n] += coolingConsumption(zone, density, temperature, state.insulation);
    rooftop[n] += (BALANCE.energy.rooftopSolarPeakByDensity[density] ?? 0) * solarFactorNow;
  }

  // Supply plants: flag the ones that serve nothing (icon + overlay).
  const isolated = isolatedPlants(state);
  for (let i = 0; i < layers.tileType.length; i++) {
    if (layers.tileType[i] !== TileType.Plant) continue;
    if (!isSupplySource(layers.plantType[i] as PlantType)) continue;
    setSupplied(state, i, isolated[i] === 1 ? SupplyStatus.NotConnected : SupplyStatus.Supplied);
  }

  // The heat network spans islands: its pump power and the heat it could
  // not deliver are split over them by their share of the heat plants
  // and of the served heat demand. Only the islands count: a heat plant
  // off the grid runs nothing, so it must not hold a slice of the pump
  // load out of the balance.
  let heatPlantsTotal = 0;
  for (let n = 1; n < islands; n++) heatPlantsTotal += census[n].heatPlants;
  const fallbackShare = heat.demand > 0 ? heat.fallback / heat.demand : 0;

  // The spot factor depends only on the state (clock and weather), so
  // reading it before the cascade changes nothing for trading below.
  const spotPrice = spotPriceFactor(state);
  const coverage = meteredCoverage(state);
  const results: IslandResult[] = [];
  const perIsland: IslandStats[] = [];
  let storedTotal = 0;
  let capacityTotal = 0;
  for (let n = 1; n < islands; n++) {
    const c = census[n];
    const batteryTiles = storage.battery[n];
    const pumpedTiles = storage.pumped[n];
    const hydrogenTiles = storage.hydrogen[n];
    const heatStoreTiles = storage.heatStore[n];
    // `poolOf` also clamps a tile that holds more than it can.
    const battery = poolOf(state, batteryTiles);
    const pumped = poolOf(state, pumpedTiles);
    const hydrogen = poolOf(state, hydrogenTiles);
    const heatStore = poolOf(state, heatStoreTiles);
    const pumpShare = heatPlantsTotal > 0 ? c.heatPlants / heatPlantsTotal : 0;
    const result = balanceIsland(
      {
        timeOfDay: time,
        season: state.season,
        spotPrice,
        marketTrading: state.marketTrading,
        demandResponseActive: state.demandResponse.active,
        coverage,
        generation: {
          solar: c.solarFarms * BALANCE.energy.solarPeakOutput * solarFactorNow,
          wind: c.windCapacity * BALANCE.energy.windPeakOutput * windFactorNow,
          rooftop: rooftop[n],
          hydro: c.hydroCapacity * BALANCE.energy.hydroPeakOutput * riverFlowNow,
          tidal: c.tidalCapacity * BALANCE.energy.tidalPeakOutput * tideNow,
          // Baseload: no weather, no daylight, no tide — only the reservoir.
          geothermal: c.geothermalCapacity * BALANCE.energy.geothermalPeakOutput,
        },
        biogasCapacity: c.biogasPlants * BALANCE.energy.biogasMaxOutput,
        demand: {
          buildings: buildingDemand[n],
          // Heat the network could not deliver is heated electrically
          // on site, by the buildings it failed on.
          heating: heatingDemand[n] + servedHeat[n] * fallbackShare,
          cooling: coolingDemand[n],
          charging: Math.max(0, input.chargingByIsland[n] ?? 0),
          heatPumps: heat.pumpPower * pumpShare,
        },
        businessDemand: businessDemand[n],
        industrialDemand: industrialDemand[n],
        contractedBuildings: contracted[n],
        battery: {
          ...battery,
          powerLimit: c.batteries * BALANCE.energy.batteryPowerLimit,
          efficiency: BALANCE.energy.batteryChargeEfficiency,
        },
        pumped: {
          ...pumped,
          powerLimit: c.pumpedCapacity * BALANCE.energy.pumpedStoragePowerLimit,
          efficiency: BALANCE.energy.pumpedStorageChargeEfficiency,
        },
        hydrogen: {
          ...hydrogen,
          electrolyserLimit: c.hydrogenPlants * BALANCE.hydrogen.electrolyserPowerLimit,
          fuelCellLimit: c.hydrogenPlants * BALANCE.hydrogen.fuelCellPowerLimit,
          efficiency: BALANCE.hydrogen.chargeEfficiency,
        },
        heatStore: {
          headroom: Math.max(0, heatStore.capacity - heatStore.stored),
          pumpPowerLeft: heat.pumpPowerLeft * pumpShare,
          cop: heat.cop,
          nightNeedsHeat: nightNeedsHeat(temperature),
        },
        substations: c.substations,
      },
      poolForIsland(state, n),
    );
    results.push(result);

    // Apply the signed storage deltas to this island's tiles: the
    // balance worked on copies of the pools, the tiles are ours.
    if (result.batteryDelta > 0) chargeTiles(state, batteryTiles, result.batteryDelta);
    else dischargeTiles(state, batteryTiles, -result.batteryDelta);
    if (result.pumpedDelta > 0) chargeTiles(state, pumpedTiles, result.pumpedDelta);
    else dischargeTiles(state, pumpedTiles, -result.pumpedDelta);
    if (result.hydrogenDelta > 0) chargeTiles(state, hydrogenTiles, result.hydrogenDelta);
    else dischargeTiles(state, hydrogenTiles, -result.hydrogenDelta);
    // The store takes heat, not electricity: one unit in, `cop` out.
    chargeTiles(state, heatStoreTiles, result.heatStoreCharge * heat.cop);

    const stored = battery.stored + result.batteryDelta + pumped.stored + result.pumpedDelta;
    const capacity = battery.capacity + pumped.capacity;
    storedTotal += stored;
    capacityTotal += capacity;
    perIsland.push({
      number: n,
      key: state.islandKeys[n],
      tiles: tileCount[n],
      buildings: buildings[n],
      substations: c.substations,
      generation:
        result.solar +
        result.wind +
        result.rooftop +
        result.hydro +
        result.tidal +
        result.geothermal +
        result.biogas +
        result.fuelCell,
      consumption: result.consumptionThisTick,
      stored,
      capacity,
      deficit: result.deficit,
      curtailment: result.curtailment,
      gridImport: result.gridImport,
      gridExport: result.gridExport,
      importCost: result.gridImport * BALANCE.market.importCostPerEnergyUnit * spotPrice,
    });

    // Flag a deterministic, tick-varying share of this island's
    // connected buildings as undersupplied so they visibly flicker
    // while their own grid is short — a healthy island never flickers
    // because another one is dark.
    const deficitShare =
      result.consumptionThisTick > 0 ? result.deficit / result.consumptionThisTick : 0;
    for (const index of connectedByIsland[n]) {
      const undersupplied = deficitShare > 0 && hashTileTick(index, state.tick) < deficitShare;
      setSupplied(state, index, undersupplied ? SupplyStatus.Undersupplied : SupplyStatus.Supplied);
    }
  }
  state.lastIslands = perIsland;

  // The city's figures are the islands' sums; only the heat network's
  // own lines and the spot price are city-wide to begin with.
  const sum = (field: (r: IslandResult) => number): number =>
    results.reduce((total, r) => total + field(r), 0);
  state.lastEnergy = {
    solar: sum((r) => r.solar),
    wind: sum((r) => r.wind),
    biogas: sum((r) => r.biogas),
    hydro: sum((r) => r.hydro),
    tidal: sum((r) => r.tidal),
    geothermal: sum((r) => r.geothermal),
    rooftop: sum((r) => r.rooftop),
    buildingConsumption: sum((r) => r.buildingConsumption),
    chargingConsumption: sum((r) => r.chargingConsumption),
    // Trains do not run yet (see trains.ts, Task 2): no catenary draw.
    tractionConsumption: 0,
    heatingConsumption: sum((r) => r.heatingConsumption),
    coolingConsumption: sum((r) => r.coolingConsumption),
    curtailment: sum((r) => r.curtailment),
    deficit: sum((r) => r.deficit),
    gridImport: sum((r) => r.gridImport),
    gridExport: sum((r) => r.gridExport),
    electrolysis: sum((r) => r.electrolysis),
    fuelCell: sum((r) => r.fuelCell),
    hydrogenSold: sum((r) => r.hydrogenSold),
    heatPumpConsumption: sum((r) => r.heatPumpConsumption),
    networkHeat: heat.networkHeat,
    heatFallback: heat.fallback,
    heatStoreCharge: sum((r) => r.heatStoreCharge),
    heatCop: heat.cop,
    spotPrice,
    tradeSell: sum((r) => r.tradeSell),
    tradeBuy: sum((r) => r.tradeBuy),
    flexDeferred: sum((r) => r.flexDeferred),
    flexRecovered: sum((r) => r.flexRecovered),
    flexBacklog: sum((r) => r.flexBacklog),
    flexOverflow: sum((r) => r.flexOverflow),
    unshifted: sum((r) => r.unshifted),
    shed: sum((r) => r.shed),
    shedPool: sum((r) => r.shedPool),
    contractedBuildings: sum((r) => r.contractedBuildings),
  };

  // A storage tile's diff carries its level as a share of capacity. Mark
  // it dirty only when that share crosses a 1/64 step: the level moves
  // every tick, and a diff per storage tile per tick would be pure churn.
  for (const kind of [storage.battery, storage.pumped, storage.hydrogen, storage.heatStore]) {
    for (const tiles of kind) {
      for (const tile of tiles) {
        const capacity = storageCapacityAt(state, tile);
        const step =
          capacity > 0
            ? Math.min(SOC_STEPS, Math.floor((SOC_STEPS * layers.stored[tile]) / capacity))
            : 0;
        if (step !== layers.lastStoredStep[tile]) {
          layers.lastStoredStep[tile] = step;
          markDirty(state, tile);
        }
      }
    }
  }

  // Average across the sample window instead of snapshotting the last
  // tick: a single tick can catch a cloud passing or a load spike, which
  // made the day graph noticeably jagged. Averaging is the same running-
  // sums-then-flush pattern as `recordLifetime` in tick.ts.
  const soc = capacityTotal > 0 ? storedTotal / capacityTotal : 0;
  const accum = state.energyHistoryAccum;
  const e = state.lastEnergy;
  accum.generation +=
    e.solar + e.wind + e.rooftop + e.hydro + e.tidal + e.geothermal + e.biogas + e.fuelCell;
  accum.consumption += sum((r) => r.consumptionThisTick);
  accum.unshifted += e.unshifted;
  accum.soc += soc;
  accum.price += spotPrice;
  accum.ticks++;

  if (state.tick % TICKS_PER_HISTORY_SAMPLE === 0) {
    pushEnergyHistory(state, {
      generation: accum.generation / accum.ticks,
      consumption: accum.consumption / accum.ticks,
      unshifted: accum.unshifted / accum.ticks,
      stateOfCharge: accum.soc / accum.ticks,
      price: accum.price / accum.ticks,
    });
    accum.generation = 0;
    accum.consumption = 0;
    accum.unshifted = 0;
    accum.soc = 0;
    accum.price = 0;
    accum.ticks = 0;
  }
}

/** Deterministic pseudo-random value 0..1 per (tile, tick). */
function hashTileTick(index: number, tick: number): number {
  let h = (index * 2654435761 + tick * 40503) >>> 0;
  h ^= h >>> 13;
  h = (h * 0x5bd1e995) >>> 0;
  return (h >>> 8) / 16777216;
}

function setSupplied(state: SimState, index: number, status: SupplyStatus): void {
  if (state.layers.supplied[index] !== status) {
    state.layers.supplied[index] = status;
    markDirty(state, index);
  }
}

/**
 * A supply plant's `supplied` flag means "serves something": NotConnected
 * when the plant is isolated (no line and no building in the ring of any
 * plant of its park), Supplied otherwise. Buildings keep the usual
 * meaning; other plants are untouched. The tick refreshes every plant at
 * once through `isolatedPlants`; this is the single-tile form for placing.
 */
function refreshPlantSupply(state: SimState, index: number): void {
  if (!isSupplySource(state.layers.plantType[index] as PlantType)) return;
  setSupplied(
    state,
    index,
    isIsolatedPlant(state, index) ? SupplyStatus.NotConnected : SupplyStatus.Supplied,
  );
}
