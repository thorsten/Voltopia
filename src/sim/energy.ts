import { BALANCE, TICKS_PER_DAY, TICKS_PER_HISTORY_SAMPLE } from '../shared/constants.ts';
import { HEATED_SERVED, PlantType, Terrain, Zone } from '../shared/types.ts';
import { clearForest, fellingCost, windForestFactor } from './forest.ts';
import { FULL_HEAT } from './geothermal.ts';
import { chargeHeatStore, IDLE_HEAT, type HeatTickResult } from './heat.ts';
import { isIsolatedPlant, isSupplySource, recomputeGrid } from './powerGrid.ts';
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
import { dispatchDemandResponse } from './demandResponse.ts';
import { spotPriceFactor } from './market.ts';
import { timeOfDay } from './tick.ts';
import { currentSolarFactor, currentWindFactor, riverFlowFactor } from './weather.ts';

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
}

export function censusPlants(state: SimState): PlantCensus {
  const { tileType, plantType, geothermal, reservoirHeat, damage } = state.layers;
  const census: PlantCensus = {
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
  };
  for (let i = 0; i < tileType.length; i++) {
    if (tileType[i] !== TileType.Plant) continue;
    // A damaged plant is out of service: no generation, no storage
    // capacity, no coverage. It heals through repairStep.
    if (damage[i] !== 0) continue;
    const plant = plantType[i] as PlantType;
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
      case PlantType.None:
        break;
    }
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
  /** Additional charging consumption (EVs), served after buildings. */
  chargingDemand: number;
  /** This tick's district-heating balance (IDLE_HEAT when absent). */
  heat?: HeatTickResult;
}

/** Absorb surplus into a storage pool within its power limit and headroom. */
function chargePool(
  stored: number,
  capacity: number,
  powerLimit: number,
  efficiency: number,
  surplus: number,
): { stored: number; absorbed: number } {
  const headroom = Math.max(0, capacity - stored);
  const absorbed = Math.max(0, Math.min(surplus, powerLimit, headroom / efficiency));
  return { stored: stored + absorbed * efficiency, absorbed };
}

/** Release stored energy toward a shortfall within the power limit. */
function dischargePool(
  stored: number,
  powerLimit: number,
  shortfall: number,
): { stored: number; released: number } {
  const released = Math.max(0, Math.min(shortfall, powerLimit, stored));
  return { stored: stored - released, released };
}

/**
 * One tick of the energy balance:
 * 1. renewable generation (solar + wind + rooftop + hydro + tidal + geothermal) covers
 *    consumption (buildings, heating, cooling, charging),
 * 2. surplus charges batteries, then pumped storage, then the heat store
 *    through the heat pumps (only while the nights are cold), anything
 *    beyond is exported over the transmission link; electrolysers absorb
 *    what the link cannot take (selling hydrogen once the tanks are
 *    full) and only the rest is curtailed,
 * 3. deficit discharges batteries, then pumped storage, then the
 *    hydrogen fuel cells, then dispatches biogas, then sheds contracted
 *    business load (demand response), then imports over the
 *    transmission link,
 * 4. remaining deficit becomes undersupply: a matching share of connected
 *    (energised) buildings is flagged undersupplied (deterministic flicker).
 */
export function energyStep(state: SimState, input: EnergyTickInput): void {
  const { layers } = state;
  recomputeGrid(state);
  const census = censusPlants(state);
  const time = timeOfDay(state.tick);
  const heat = input.heat ?? { ...IDLE_HEAT };

  const solar = census.solarFarms * BALANCE.energy.solarPeakOutput * currentSolarFactor(state);
  const wind = census.windCapacity * BALANCE.energy.windPeakOutput * currentWindFactor(state);
  const hydro = census.hydroCapacity * BALANCE.energy.hydroPeakOutput * riverFlowFactor(state);
  const tidal = census.tidalCapacity * BALANCE.energy.tidalPeakOutput * tideFactor(state.tick);
  // Baseload: no weather, no daylight, no tide — only the reservoir.
  const geothermal = census.geothermalCapacity * BALANCE.energy.geothermalPeakOutput;

  // Consumption of all connected buildings, plus their rooftop PV
  // feed-in (rooftop capacity grows automatically with density).
  const solarFactorNow = currentSolarFactor(state);
  const temperature = state.season.temperature;
  let buildingDemand = 0;
  let heatingDemand = 0;
  let coolingDemand = 0;
  let rooftop = 0;
  // Base load of the connected businesses — the demand-response pool.
  let businessDemand = 0;
  let contractedBuildings = 0;

  // Service stations draw a fixed load while connected to the grid.
  for (let i = 0; i < layers.tileType.length; i++) {
    if (layers.tileType[i] !== TileType.Plant) continue;
    if (layers.damage[i] !== 0) continue;
    if (!isStation(layers.plantType[i] as PlantType)) continue;
    if (layers.energized[i] === 1) buildingDemand += BALANCE.services.stationConsumption;
  }

  const connectedBuildings: number[] = [];
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
    connectedBuildings.push(i);
    const zone = layers.zone[i] as Zone;
    const density = layers.density[i];
    buildingDemand += buildingConsumption(zone, density, time);
    if (zone === Zone.Commercial || zone === Zone.Retail) {
      businessDemand += buildingConsumption(zone, density, time);
      contractedBuildings++;
    }
    // A served building gets its heat from the network; its own
    // electric heating only runs for the fallback share (added below).
    if (layers.heated[i] !== HEATED_SERVED) {
      heatingDemand += heatingConsumption(zone, density, temperature, state.insulation);
    }
    coolingDemand += coolingConsumption(zone, density, temperature, state.insulation);
    rooftop += (BALANCE.energy.rooftopSolarPeakByDensity[density] ?? 0) * solarFactorNow;
  }

  // Supply plants: flag the ones that serve nothing (icon + overlay).
  for (let i = 0; i < layers.tileType.length; i++) {
    if (layers.tileType[i] !== TileType.Plant) continue;
    refreshPlantSupply(state, i);
  }

  // Heat the network could not deliver is heated electrically on site.
  heatingDemand += heat.fallback;

  const chargingDemand = Math.max(0, input.chargingDemand);
  const generation = solar + wind + rooftop + hydro + tidal + geothermal;

  // Smart meters: a share of metered household load and on-site electric
  // heating waits for renewable surplus (see smartMeters.ts). Cooling,
  // charging and the network pumps stay inflexible. With no coverage
  // every term is 0 and the step is unchanged.
  const unshifted =
    buildingDemand + heatingDemand + coolingDemand + chargingDemand + heat.pumpPower;
  const coverage = meteredCoverage(state);
  const { householdFlexShare, heatingFlexShare, backlogHours, maxDrainShare } = BALANCE.smartMeters;
  const flexible =
    coverage * (householdFlexShare * buildingDemand + heatingFlexShare * heatingDemand);
  const inflexible = unshifted - flexible;
  const renewableSurplus = generation - inflexible;
  let servedNow = 0;
  let recovered = 0;
  let deferred = flexible;
  if (renewableSurplus > 0) {
    servedNow = Math.min(flexible, renewableSurplus);
    recovered = Math.min(state.flexBacklog, renewableSurplus - servedNow);
    deferred = flexible - servedNow;
  }
  // The backlog may only drain so fast. The comfort bound below scales
  // with the current pool, so anything that shrinks the pool at once —
  // insulation halving the heating load, a heat plant coming online,
  // storm damage, a mass bulldoze — would leave the whole backlog above
  // the new bound and serve it in a single tick, a city-wide deficit out
  // of nowhere. Capped, the backlog may sit above the bound for a while
  // and empties over several ticks instead.
  const drainCap = maxDrainShare * unshifted;
  recovered = Math.min(recovered, drainCap);
  // Comfort bound: past a few hours of deferred demand the pool is served
  // regardless of the weather.
  const backlogCapacity = flexible * backlogHours * (TICKS_PER_DAY / 24);
  const overflow = Math.min(
    Math.max(0, state.flexBacklog + deferred - recovered - backlogCapacity),
    Math.max(0, drainCap - recovered),
  );
  state.flexBacklog = Math.max(0, state.flexBacklog + deferred - recovered - overflow);
  // No load at all (an empty city, or every building disconnected): there
  // is nothing to drain into, and the cap would hold the backlog forever.
  if (unshifted === 0) state.flexBacklog = 0;
  const totalDemand = inflexible + servedNow + recovered + overflow;
  // Report both lines as what was actually served this tick. The shift is
  // split in proportion to what each line contributed to the pool —
  // charging all of it to the household line would print a negative
  // figure on a cold night, where heating alone is the larger share.
  const householdFlex = householdFlexShare * buildingDemand;
  const householdShare =
    flexible > 0 ? householdFlex / (householdFlex + heatingFlexShare * heatingDemand) : 0;
  const shift = -deferred + recovered + overflow;
  buildingDemand += householdShare * shift;
  heatingDemand += (1 - householdShare) * shift;

  const storageCapacity = census.batteries * BALANCE.energy.batteryCapacity;
  const powerLimit = census.batteries * BALANCE.energy.batteryPowerLimit;
  state.storedEnergy = Math.min(state.storedEnergy, storageCapacity);
  const pumpedCapacity = census.pumpedCapacity * BALANCE.energy.pumpedStorageCapacity;
  const pumpedPowerLimit = census.pumpedCapacity * BALANCE.energy.pumpedStoragePowerLimit;
  state.pumpedStorageEnergy = Math.min(state.pumpedStorageEnergy, pumpedCapacity);
  const hydrogenCapacity = census.hydrogenPlants * BALANCE.hydrogen.capacity;
  const electrolyserLimit = census.hydrogenPlants * BALANCE.hydrogen.electrolyserPowerLimit;
  const fuelCellLimit = census.hydrogenPlants * BALANCE.hydrogen.fuelCellPowerLimit;
  state.hydrogenEnergy = Math.min(state.hydrogenEnergy, hydrogenCapacity);

  let curtailment = 0;
  let biogas = 0;
  let deficit = 0;
  let gridImport = 0;
  let gridExport = 0;
  let electrolysis = 0;
  let fuelCell = 0;
  let hydrogenSold = 0;
  let batteryPowerUsed = 0;
  let pumpedPowerUsed = 0;
  let heatStoreCharge = 0;
  let shed = 0;
  let shedPool = 0;

  // The spot factor depends only on the state (clock and weather), so
  // reading it before the cascade changes nothing for trading below.
  const spotPrice = spotPriceFactor(state);
  const net = generation - totalDemand;
  if (net >= 0) {
    shedPool = dispatchDemandResponse(state, businessDemand, 0, spotPrice).pool;
    const battery = chargePool(
      state.storedEnergy,
      storageCapacity,
      powerLimit,
      BALANCE.energy.batteryChargeEfficiency,
      net,
    );
    state.storedEnergy = battery.stored;
    batteryPowerUsed = battery.absorbed;
    const pumped = chargePool(
      state.pumpedStorageEnergy,
      pumpedCapacity,
      pumpedPowerLimit,
      BALANCE.energy.pumpedStorageChargeEfficiency,
      net - battery.absorbed,
    );
    state.pumpedStorageEnergy = pumped.stored;
    pumpedPowerUsed = pumped.absorbed;
    // The heat store drinks after the electric storages and before the
    // link: a cheap one-way sink that shifts the heating peak.
    heatStoreCharge = chargeHeatStore(state, heat, net - battery.absorbed - pumped.absorbed);
    const remaining = net - battery.absorbed - pumped.absorbed - heatStoreCharge;
    // Sell what storage cannot absorb over the link, then electrolyse
    // what the link cannot take; only the rest is curtailed.
    gridExport = Math.min(remaining, BALANCE.market.exportCapacity);
    const beyondExport = remaining - gridExport;
    const hydrogen = chargePool(
      state.hydrogenEnergy,
      hydrogenCapacity,
      electrolyserLimit,
      BALANCE.hydrogen.chargeEfficiency,
      beyondExport,
    );
    state.hydrogenEnergy = hydrogen.stored;
    // Full tanks keep the electrolysers running and sell the output.
    const saleInput = Math.min(
      beyondExport - hydrogen.absorbed,
      electrolyserLimit - hydrogen.absorbed,
    );
    hydrogenSold = saleInput * BALANCE.hydrogen.chargeEfficiency;
    electrolysis = hydrogen.absorbed + saleInput;
    curtailment = beyondExport - electrolysis;
  } else {
    let shortfall = -net;
    const battery = dischargePool(state.storedEnergy, powerLimit, shortfall);
    state.storedEnergy = battery.stored;
    shortfall -= battery.released;
    batteryPowerUsed = battery.released;
    const pumped = dischargePool(state.pumpedStorageEnergy, pumpedPowerLimit, shortfall);
    state.pumpedStorageEnergy = pumped.stored;
    shortfall -= pumped.released;
    pumpedPowerUsed = pumped.released;
    const hydrogen = dischargePool(state.hydrogenEnergy, fuelCellLimit, shortfall);
    state.hydrogenEnergy = hydrogen.stored;
    fuelCell = hydrogen.released;
    shortfall -= fuelCell;
    biogas = Math.min(shortfall, census.biogasPlants * BALANCE.energy.biogasMaxOutput);
    shortfall -= biogas;
    // The demand-response contract sheds business load when a call is
    // cheaper than importing or the link alone cannot carry the rest.
    const call = dispatchDemandResponse(state, businessDemand, shortfall, spotPrice);
    shedPool = call.pool;
    shed = call.shed;
    shortfall -= shed;
    // Expensive imports over the limited transmission link come last.
    gridImport = Math.min(shortfall, BALANCE.market.importCapacity);
    shortfall -= gridImport;
    deficit = shortfall;
  }

  // Spot-market trading: with the toggle on, the storage pools work the
  // link. At scarcity prices they sell the charge above a reserve floor;
  // at abundance prices they buy up to a modest ceiling. The bands are
  // disjoint (buyCeiling < sellFloor), so the same energy can never be
  // bought low and sold high — selling monetises the city's own shifted
  // surplus, buying pre-empts expensive imports.
  let tradeSell = 0;
  let tradeBuy = 0;
  if (state.marketTrading) {
    const trading = BALANCE.market.trading;
    if (spotPrice >= trading.sellThreshold && deficit === 0 && gridImport === 0) {
      let exportRoom = BALANCE.market.exportCapacity - gridExport;
      const sellFrom = (stored: number, floor: number, power: number): number => {
        const sold = Math.min(exportRoom, power, Math.max(0, stored - floor));
        exportRoom -= sold;
        return sold;
      };
      const fromBattery = sellFrom(
        state.storedEnergy,
        trading.sellFloor * storageCapacity,
        powerLimit - batteryPowerUsed,
      );
      state.storedEnergy -= fromBattery;
      const fromPumped = sellFrom(
        state.pumpedStorageEnergy,
        trading.sellFloor * pumpedCapacity,
        pumpedPowerLimit - pumpedPowerUsed,
      );
      state.pumpedStorageEnergy -= fromPumped;
      tradeSell = fromBattery + fromPumped;
      gridExport += tradeSell;
    } else if (spotPrice <= trading.buyThreshold && curtailment === 0 && gridExport === 0) {
      let importRoom = BALANCE.market.importCapacity - gridImport;
      const buyInto = (stored: number, ceiling: number, power: number, efficiency: number) => {
        const bought = Math.min(power, importRoom, Math.max(0, (ceiling - stored) / efficiency));
        importRoom -= bought;
        return { stored: stored + bought * efficiency, bought };
      };
      const battery = buyInto(
        state.storedEnergy,
        trading.buyCeiling * storageCapacity,
        powerLimit - batteryPowerUsed,
        BALANCE.energy.batteryChargeEfficiency,
      );
      state.storedEnergy = battery.stored;
      const pumped = buyInto(
        state.pumpedStorageEnergy,
        trading.buyCeiling * pumpedCapacity,
        pumpedPowerLimit - pumpedPowerUsed,
        BALANCE.energy.pumpedStorageChargeEfficiency,
      );
      state.pumpedStorageEnergy = pumped.stored;
      tradeBuy = battery.bought + pumped.bought;
      gridImport += tradeBuy;
    }
  }

  // Shed load was never served: it leaves the businesses' line and the
  // tick's consumption, so the dashed unshifted curve shows it as a gap.
  buildingDemand -= shed;
  const consumptionThisTick = totalDemand - shed;

  // Flag a deterministic, tick-varying share of connected buildings as
  // undersupplied so they visibly flicker while the grid is short.
  const deficitShare = consumptionThisTick > 0 ? deficit / consumptionThisTick : 0;
  for (const index of connectedBuildings) {
    const undersupplied = deficitShare > 0 && hashTileTick(index, state.tick) < deficitShare;
    setSupplied(state, index, undersupplied ? SupplyStatus.Undersupplied : SupplyStatus.Supplied);
  }

  state.lastEnergy = {
    solar,
    wind,
    biogas,
    hydro,
    tidal,
    geothermal,
    rooftop,
    buildingConsumption: buildingDemand,
    chargingConsumption: chargingDemand,
    heatingConsumption: heatingDemand,
    coolingConsumption: coolingDemand,
    curtailment,
    deficit,
    gridImport,
    gridExport,
    electrolysis,
    fuelCell,
    hydrogenSold,
    heatPumpConsumption: heat.pumpPower + heatStoreCharge,
    networkHeat: heat.networkHeat,
    heatFallback: heat.fallback,
    heatStoreCharge,
    heatCop: heat.cop,
    spotPrice,
    tradeSell,
    tradeBuy,
    flexDeferred: deferred,
    flexRecovered: recovered,
    flexBacklog: state.flexBacklog,
    flexOverflow: overflow,
    unshifted,
    shed,
    shedPool,
    contractedBuildings,
  };

  // Average across the sample window instead of snapshotting the last
  // tick: a single tick can catch a cloud passing or a load spike, which
  // made the day graph noticeably jagged. Averaging is the same running-
  // sums-then-flush pattern as `recordLifetime` in tick.ts.
  const totalCapacity = storageCapacity + pumpedCapacity;
  const soc =
    totalCapacity > 0 ? (state.storedEnergy + state.pumpedStorageEnergy) / totalCapacity : 0;
  const accum = state.energyHistoryAccum;
  accum.generation += generation + biogas + fuelCell;
  accum.consumption += consumptionThisTick;
  accum.unshifted += unshifted;
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
 * when the plant is isolated (no line, no building in its ring), Supplied
 * otherwise. Buildings keep the usual meaning; other plants are untouched.
 */
function refreshPlantSupply(state: SimState, index: number): void {
  if (!isSupplySource(state.layers.plantType[index] as PlantType)) return;
  setSupplied(
    state,
    index,
    isIsolatedPlant(state, index) ? SupplyStatus.NotConnected : SupplyStatus.Supplied,
  );
}
