import {
  BALANCE,
  ENERGY_HISTORY_SAMPLES,
  SAVE_VERSION,
  TICKS_PER_DAY,
} from '../shared/constants.ts';
import { neighbors4 } from '../shared/grid.ts';
import { Rng } from '../shared/rng.ts';
import type {
  DemandStats,
  DeliveryStats,
  LifetimeSample,
  EnergyHistoryPoint,
  SaveGame,
  SeasonState,
  Speed,
  TileDiff,
  TransitStats,
  Weather,
} from '../shared/types.ts';
import {
  DeliveryState,
  PlantType,
  StopState,
  SupplyStatus,
  Terrain,
  TileType,
  Zone,
} from '../shared/types.ts';
import { emptyPlantMap, type EconomyBreakdown } from './economy.ts';
import {
  discoverGeothermalFields,
  generateGeothermal,
  FULL_HEAT,
  type GeothermalField,
} from './geothermal.ts';
import { grantLegacyNetwork } from './powerGrid.ts';
import { isCoastalSea } from './sea.ts';
import { seasonState } from './seasons.ts';

/** Commute phases of a vehicle. */
export const VehiclePhase = {
  ParkedHome: 0,
  ToWork: 1,
  ParkedWork: 2,
  ToHome: 3,
} as const;
export type VehiclePhase = (typeof VehiclePhase)[keyof typeof VehiclePhase];

/** One simulated vehicle. Continuous position in tile space. */
export interface Vehicle {
  /** Stable id so the renderer can interpolate across updates. */
  id: number;
  /** Road tile next to the home building (-1 = unassigned). */
  homeRoad: number;
  /** Road tile next to the workplace (-1 = no workplace found). */
  workRoad: number;
  x: number;
  y: number;
  angle: number;
  phase: VehiclePhase;
  /** Road tiles of the current trip (empty while parked). */
  path: number[];
  pathIndex: number;
  /** Departure offset in ticks within the commute window. */
  departureOffset: number;
  /** Battery state of charge, 0..1. Drains while driving. */
  charge: number;
  /** Ticks spent on the current trip (congestion measurement). */
  tripTicks: number;
  /** Ticks the current trip would take with free-flowing traffic. */
  tripFreeFlowTicks: number;
  /** True while plugged in this tick (drives the charging load). */
  charging: boolean;
  /** Consecutive ticks spent waiting behind a full lane (gridlock breaker). */
  waitTicks: number;
  /** Day of the last decision to ride the bus instead of driving; -1 = drives. Not persisted. */
  riderDay: number;
}

/** Tour phases of a delivery van. */
export const VanPhase = { AtDepot: 0, Driving: 1, Unloading: 2 } as const;
export type VanPhase = (typeof VanPhase)[keyof typeof VanPhase];

/** One delivery van. Satisfies vehicles.ts' Mover. Not persisted. */
export interface Van {
  /** Stable id (shares nextVehicleId with cars). */
  id: number;
  /** Depot plant tile; -1 once the van is lost and awaits removal. */
  depot: number;
  /** Road tile next to the depot the van parks on. */
  depotRoad: number;
  x: number;
  y: number;
  angle: number;
  phase: VanPhase;
  /** Remaining stops of the tour (road tiles); the last one is depotRoad. */
  stops: number[];
  /** Road tiles from the current position to stops[0]. */
  path: number[];
  pathIndex: number;
  /** Battery state of charge, 0..1. */
  charge: number;
  /** True while plugged in at the depot this tick. */
  charging: boolean;
  /** Consecutive ticks spent waiting behind a full lane (gridlock breaker). */
  waitTicks: number;
  /** Remaining unload / turnaround ticks. */
  dwellTicks: number;
}

/** Tour phases of a bus. */
export const BusPhase = { AtDepot: 0, Driving: 1, Boarding: 2 } as const;
export type BusPhase = (typeof BusPhase)[keyof typeof BusPhase];

/** One electric bus. Satisfies vehicles.ts' Mover. Not persisted. */
export interface Bus {
  /** Stable id (shares nextVehicleId with cars and vans). */
  id: number;
  /** Depot plant tile; -1 once the bus is lost and awaits removal. */
  depot: number;
  /** Road tile next to the depot the bus parks on. */
  depotRoad: number;
  x: number;
  y: number;
  angle: number;
  phase: BusPhase;
  /** Remaining stops of the tour (road tiles); the last one is depotRoad. */
  stops: number[];
  /** Road tiles from the current position to stops[0]. */
  path: number[];
  pathIndex: number;
  /** Battery state of charge, 0..1. */
  charge: number;
  /** True while plugged in at the depot this tick. */
  charging: boolean;
  /** Consecutive ticks spent waiting behind a full lane (gridlock breaker). */
  waitTicks: number;
  /** Remaining boarding / turnaround ticks. */
  dwellTicks: number;
}

/** A reversible build action for the undo tool. */
export interface UndoEntry {
  /** Money to restore (refunds the cost of the undone action). */
  moneyDelta: number;
  /** Tile snapshots to restore, keyed by index. */
  tiles: Array<{
    index: number;
    tileType: number;
    roadMask: number;
    roadClass: number;
    powerLine: number;
    zone: number;
    density: number;
    variant: number;
    plantType: number;
    busStop: number;
    forest: number;
  }>;
}

export interface TileLayers {
  tileType: Uint8Array;
  roadMask: Uint8Array;
  /** RoadClass per road tile (persisted). */
  roadClass: Uint8Array;
  zone: Uint8Array;
  density: Uint8Array;
  variant: Uint8Array;
  supplied: Uint8Array;
  plantType: Uint8Array;
  /** Immutable ground type (land / river / lake), generated per map. */
  terrain: Uint8Array;
  /** Elevation level 0..7, generated per map. Immutable afterwards. */
  elevation: Uint8Array;
  /** Forest growth stage per tile: 0 = none, 1..BALANCE.forest.maxStage. */
  forest: Uint8Array;
  /** Geothermal hotspot quality per tile: 0 = none, 1..3. Immutable after generation. */
  geothermal: Uint8Array;
  /** Quantised reservoir temperature 0..255 (all tiles of a field share one value). */
  reservoirHeat: Uint8Array;
  /** Power line mask per tile (0 = none, else LINE_PRESENT | connection bits). */
  powerLine: Uint8Array;
  /** 1 when the tile is within lineSupplyRadius of an energised line or supply plant. Derived, not persisted. */
  energized: Uint8Array;
  /** Service coverage bitmask (SERVICE_FIRE | SERVICE_POLICE). Derived, not persisted. */
  services: Uint8Array;
  /** Ticks since the building on this tile last changed (not persisted). */
  buildingAge: Uint32Array;
  /** Consecutive ticks without full supply (not persisted). */
  troubledTicks: Uint32Array;
  /** Smoothed lane occupancy 0..255 per road tile. Derived, not persisted. */
  trafficLoad: Uint8Array;
  /** Ticks since the last delivery per retail building, saturating. Derived, not persisted. */
  deliveryAge: Uint16Array;
  /** 1 on road tiles that carry a bus stop (persisted). */
  busStop: Uint8Array;
  /** Ticks since a bus last halted at this stop, saturating. Derived, not persisted. */
  stopAge: Uint16Array;
  /** 1 on road tiles within stopRadius of a served bus stop. Derived, not persisted. */
  transitCover: Uint8Array;
}

export interface SimState {
  seed: number;
  size: number;
  rng: Rng;
  tick: number;
  speed: Speed;
  money: number;
  taxRate: number;
  smartCharging: boolean;
  /** Storage trades on the spot market: sell at scarcity, buy cheap. */
  marketTrading: boolean;
  /** Building insulation upgrade bought (halves the heating load). */
  insulation: boolean;
  /** Day number on which year 1 started; 0 for new games. */
  seasonOriginDay: number;
  /** Seasonal signal for the current tick, recomputed in stepTick. */
  season: SeasonState;
  happiness: number;
  storedEnergy: number;
  /** Energy stored in pumped storage plants (separate pool from batteries). */
  pumpedStorageEnergy: number;
  /** Hydrogen stored in hydrogen plants (third pool, filled from surplus). */
  hydrogenEnergy: number;
  /** Incremented whenever plants or power lines change; drives recomputeGrid. */
  gridVersion: number;
  /** gridVersion the energized layer was last computed for (-1 = never). */
  gridComputedVersion: number;
  weather: Weather;
  /** Elevation of the lake surface (derived; recomputed on load). */
  lakeLevel: number;
  layers: TileLayers;
  /** Hotspot fields, derived from the geothermal layer; never persisted. */
  geothermalFields: GeothermalField[];
  vehicles: Vehicle[];
  vans: Van[];
  buses: Bus[];
  undoStack: UndoEntry[];
  energyHistory: EnergyHistoryPoint[];
  /** Running sums since the last history sample (not persisted). */
  energyHistoryAccum: {
    generation: number;
    consumption: number;
    soc: number;
    price: number;
    ticks: number;
  };
  /** Tile indices changed since the last diff collection. */
  dirty: Set<number>;
  /**
   * Non-tile state (money, tax rate, upgrades) changed since the last
   * event, so the HUD needs fresh stats even without a tile diff.
   * Transient: never persisted.
   */
  statsDirty: boolean;
  /** Demand computed during the last tick, shown in the HUD. */
  lastDemand: DemandStats;
  /** Coverage shares (0..1) from the last recomputeServices; transient. */
  lastServices: { fire: number; police: number };
  /** Figures from the last deliveriesStep; transient. */
  lastDeliveries: DeliveryStats;
  /** Figures from the last transitStep; transient. */
  lastTransit: TransitStats;
  /** Achieved goal ids (persisted with the save game). */
  goalsAchieved: Set<string>;
  /** Goal progress counters; the season streaks are persisted, the rest is transient. */
  goalProgress: {
    cleanDayTicks: number;
    exportedTotal: number;
    winterTicks: number;
    summerTicks: number;
    freeFlowTicks: number;
    wellStockedTicks: number;
    transitTicks: number;
    geothermalTicks: number;
  };
  /** Monotonic id source for vehicles (not persisted). */
  nextVehicleId: number;
  /**
   * Smoothed ratio of actual to free-flow commute time (1 = no jams).
   * Feeds the commute happiness penalty.
   */
  commuteCongestion: number;
  /** Daily lifetime statistics (persisted) plus running day sums. */
  lifetime: {
    samples: LifetimeSample[];
    daySums: {
      generation: number;
      consumption: number;
      heating: number;
      cooling: number;
      temperature: number;
      ticks: number;
    };
  };
  /** Budget breakdown of the last tick (for the budget panel). */
  lastEconomy: EconomyBreakdown;
  /** Tile selected in the inspector, -1 when none. */
  inspectedTile: number;
  /** Set by the energy step; consumed by growth/happiness. */
  lastEnergy: {
    solar: number;
    wind: number;
    biogas: number;
    hydro: number;
    tidal: number;
    geothermal: number;
    rooftop: number;
    buildingConsumption: number;
    chargingConsumption: number;
    heatingConsumption: number;
    coolingConsumption: number;
    curtailment: number;
    deficit: number;
    gridImport: number;
    gridExport: number;
    /** Electrolyser input this tick (stored or sold as hydrogen). */
    electrolysis: number;
    /** Fuel-cell output re-electrified from the hydrogen pool this tick. */
    fuelCell: number;
    /** Hydrogen units sold this tick because the tanks were full. */
    hydrogenSold: number;
    /** Spot price factor applied to this tick's link traffic. */
    spotPrice: number;
    /** Stored energy sold / bought by market trading this tick. */
    tradeSell: number;
    tradeBuy: number;
  };
}

export function createTileLayers(size: number): TileLayers {
  const tiles = size * size;
  return {
    tileType: new Uint8Array(tiles),
    roadMask: new Uint8Array(tiles),
    roadClass: new Uint8Array(tiles),
    zone: new Uint8Array(tiles),
    density: new Uint8Array(tiles),
    variant: new Uint8Array(tiles),
    supplied: new Uint8Array(tiles),
    plantType: new Uint8Array(tiles),
    terrain: new Uint8Array(tiles),
    elevation: new Uint8Array(tiles),
    forest: new Uint8Array(tiles),
    geothermal: new Uint8Array(tiles),
    reservoirHeat: new Uint8Array(tiles),
    powerLine: new Uint8Array(tiles),
    energized: new Uint8Array(tiles),
    services: new Uint8Array(tiles),
    buildingAge: new Uint32Array(tiles),
    troubledTicks: new Uint32Array(tiles),
    trafficLoad: new Uint8Array(tiles),
    deliveryAge: new Uint16Array(tiles),
    busStop: new Uint8Array(tiles),
    stopAge: new Uint16Array(tiles),
    transitCover: new Uint8Array(tiles),
  };
}

export function createSimState(
  seed: number,
  size: number,
  startingMoney: number = BALANCE.startingMoney,
): SimState {
  return {
    seed,
    size,
    rng: new Rng(seed),
    tick: 0,
    speed: 1,
    money: startingMoney,
    taxRate: BALANCE.tax.defaultRate,
    smartCharging: false,
    marketTrading: false,
    insulation: false,
    seasonOriginDay: 0,
    season: seasonState({ day: 0, timeOfDay: 0, seasonOriginDay: 0, cloudCover: 0.3 }),
    happiness: BALANCE.happiness.base,
    storedEnergy: 0,
    pumpedStorageEnergy: 0,
    hydrogenEnergy: 0,
    gridVersion: 0,
    gridComputedVersion: -1,
    weather: {
      cloudCover: 0.3,
      windSpeed: 0.5,
      riverFlow: BALANCE.water.initialFlow,
      snowpack: 0,
    },
    lakeLevel: 0,
    layers: createTileLayers(size),
    geothermalFields: [],
    vehicles: [],
    vans: [],
    buses: [],
    undoStack: [],
    energyHistory: [],
    energyHistoryAccum: { generation: 0, consumption: 0, soc: 0, price: 0, ticks: 0 },
    dirty: new Set(),
    statsDirty: false,
    lastDemand: { residential: 0, commercial: 0, retail: 0 },
    lastServices: { fire: 0, police: 0 },
    lastDeliveries: { suppliedShare: 1, shops: 0, driving: 0, depots: 0 },
    lastTransit: { riderShare: 0, riders: 0, driving: 0, stops: 0, stopsServed: 0, depots: 0 },
    goalsAchieved: new Set(),
    goalProgress: {
      cleanDayTicks: 0,
      exportedTotal: 0,
      winterTicks: 0,
      summerTicks: 0,
      freeFlowTicks: 0,
      wellStockedTicks: 0,
      transitTicks: 0,
      geothermalTicks: 0,
    },
    nextVehicleId: 1,
    commuteCongestion: 1,
    lifetime: {
      samples: [],
      daySums: { generation: 0, consumption: 0, heating: 0, cooling: 0, temperature: 0, ticks: 0 },
    },
    lastEconomy: {
      taxIncome: 0,
      gridUpkeep: 0,
      plantUpkeep: 0,
      hydrogenRevenue: 0,
      plantUpkeepByType: emptyPlantMap(),
      plantCountByType: emptyPlantMap(),
      roadTiles: 0,
      avenueTiles: 0,
      biogasFuelCost: 0,
      gridImportCost: 0,
      gridExportRevenue: 0,
      avenueUpkeep: 0,
      busStops: 0,
      busStopUpkeep: 0,
    },
    inspectedTile: -1,
    lastEnergy: {
      solar: 0,
      wind: 0,
      biogas: 0,
      hydro: 0,
      tidal: 0,
      geothermal: 0,
      rooftop: 0,
      buildingConsumption: 0,
      chargingConsumption: 0,
      heatingConsumption: 0,
      coolingConsumption: 0,
      curtailment: 0,
      deficit: 0,
      gridImport: 0,
      gridExport: 0,
      electrolysis: 0,
      fuelCell: 0,
      hydrogenSold: 0,
      spotPrice: 1,
      tradeSell: 0,
      tradeBuy: 0,
    },
  };
}

export function markDirty(state: SimState, index: number): void {
  state.dirty.add(index);
}

/** Plants or lines changed: the energized layer must be recomputed. */
export function bumpGridVersion(state: SimState): void {
  state.gridVersion++;
}

/** Snapshot one tile's buildable layers for undo. */
export function snapshotTile(state: SimState, index: number): UndoEntry['tiles'][number] {
  const { layers } = state;
  return {
    index,
    tileType: layers.tileType[index],
    roadMask: layers.roadMask[index],
    roadClass: layers.roadClass[index],
    powerLine: layers.powerLine[index],
    zone: layers.zone[index],
    density: layers.density[index],
    variant: layers.variant[index],
    plantType: layers.plantType[index],
    busStop: layers.busStop[index],
    forest: layers.forest[index],
  };
}

/** The given tiles plus their 4-neighbours (deduplicated). */
export function withNeighbors(state: SimState, tiles: number[]): Set<number> {
  const affected = new Set<number>();
  for (const index of tiles) {
    affected.add(index);
    for (const neighbor of neighbors4(index, state.size)) affected.add(neighbor);
  }
  return affected;
}

/** Collect and clear the pending tile diffs. */
export function collectDiffs(state: SimState): TileDiff[] {
  const { layers } = state;
  const diffs: TileDiff[] = [];
  for (const index of state.dirty) {
    diffs.push({
      index,
      tileType: layers.tileType[index] as TileDiff['tileType'],
      roadMask: layers.roadMask[index],
      roadClass: layers.roadClass[index],
      trafficLoad: layers.trafficLoad[index],
      powerLine: layers.powerLine[index],
      zone: layers.zone[index] as TileDiff['zone'],
      density: layers.density[index],
      variant: layers.variant[index],
      supplied: layers.supplied[index] as TileDiff['supplied'],
      services: layers.services[index],
      plantType: layers.plantType[index] as TileDiff['plantType'],
      terrain: layers.terrain[index] as TileDiff['terrain'],
      elevation: layers.elevation[index],
      forest: layers.forest[index],
      geothermal: layers.geothermal[index],
      reservoirHeat: layers.reservoirHeat[index],
      deliveryState: deliveryStateOfAge(layers.deliveryAge[index]),
      busStop: layers.busStop[index],
      stopState:
        layers.busStop[index] !== 0 ? stopStateOfAge(layers.stopAge[index]) : StopState.Served,
      transitCover: layers.transitCover[index],
    });
  }
  state.dirty.clear();
  return diffs;
}

/** Mark every tile dirty, e.g. after loading a save game. */
export function markAllDirty(state: SimState): void {
  for (let i = 0; i < state.size * state.size; i++) {
    state.dirty.add(i);
  }
}

/** What a placement is trying to do; decides which terrain accepts it. */
export const BuildIntent = { Road: 0, Zone: 1, Plant: 2, PowerLine: 3 } as const;
export type BuildIntent = (typeof BuildIntent)[keyof typeof BuildIntent];

/** Lake surface level: the (uniform) elevation of the lake tiles. */
export function computeLakeLevel(state: SimState): number {
  const { terrain, elevation } = state.layers;
  for (let i = 0; i < terrain.length; i++) {
    if (terrain[i] === Terrain.Lake) return elevation[i];
  }
  return 0;
}

/** True when any 4-neighbour is a lake tile. */
export function isLakeShore(state: SimState, index: number): boolean {
  const { terrain } = state.layers;
  return neighbors4(index, state.size).some((n) => terrain[n] === Terrain.Lake);
}

/** Steepness of a tile: the largest level difference to a 4-neighbour. */
export function slopeAt(state: SimState, index: number): number {
  const { elevation } = state.layers;
  let slope = 0;
  for (const n of neighbors4(index, state.size)) {
    slope = Math.max(slope, Math.abs(elevation[index] - elevation[n]));
  }
  return slope;
}

/** Building on a slope costs extra earthworks. */
export function slopeCostMultiplier(state: SimState, index: number): number {
  return slopeAt(state, index) > 0 ? BALANCE.terrain.slopeCostFactor : 1;
}

/** Ticks a shop stays supplied after a delivery. */
export function supplyWindowTicks(): number {
  return Math.round(BALANCE.deliveries.supplyWindowDays * TICKS_PER_DAY);
}

/** Ticks after which a shop counts as due for a delivery. */
export function dueTicks(): number {
  return Math.round(BALANCE.deliveries.dueAfterDays * TICKS_PER_DAY);
}

/** Delivery bucket of a shop given its ticks since the last delivery. */
export function deliveryStateOfAge(age: number): DeliveryState {
  if (age > supplyWindowTicks()) return DeliveryState.Unsupplied;
  if (age > dueTicks()) return DeliveryState.Due;
  return DeliveryState.Supplied;
}

/** Ticks a bus stop stays served after a bus halted there. */
export function stopServiceTicks(): number {
  return Math.round(BALANCE.transit.serviceWindowDays * TICKS_PER_DAY);
}

/** Ticks after which a bus stop counts as due for a bus. */
export function stopDueTicks(): number {
  return Math.round(BALANCE.transit.dueAfterDays * TICKS_PER_DAY);
}

/** Service bucket of a stop given its ticks since the last bus. */
export function stopStateOfAge(age: number): StopState {
  if (age > stopServiceTicks()) return StopState.Unserved;
  if (age > stopDueTicks()) return StopState.Due;
  return StopState.Served;
}

/** Levels of drop from a river tile to its lowest water 4-neighbour.
 *  The sea is excluded even though it is not land: it is pinned to
 *  elevation 0, and counting it here would re-price the river mouth
 *  as a steeper drop than the river itself ever had — the estuary is
 *  what the tidal plant models, not an extra bonus for run-of-river. */
export function riverDropAt(state: SimState, index: number): number {
  const { terrain, elevation } = state.layers;
  let lowest = elevation[index];
  for (const n of neighbors4(index, state.size)) {
    if (terrain[n] !== Terrain.Land && terrain[n] !== Terrain.Sea) {
      lowest = Math.min(lowest, elevation[n]);
    }
  }
  return elevation[index] - lowest;
}

/** Head of a pumped-storage site: the highest ground within
 *  headRadius above the lake surface (the upper reservoir sits on
 *  the neighbouring hill). */
export function pumpedHeadAt(state: SimState, index: number): number {
  const { elevation } = state.layers;
  const size = state.size;
  const x = index % size;
  const y = Math.floor(index / size);
  const r = BALANCE.terrain.headRadius;
  let highest = elevation[index];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      highest = Math.max(highest, elevation[ny * size + nx]);
    }
  }
  return Math.max(0, highest - state.lakeLevel);
}

/**
 * Why a tile cannot be built on with the given intent, or null when it
 * can. Land accepts everything (except run-of-river, which needs the
 * river); river tiles accept bridges and run-of-river plants; lakes
 * accept nothing. The sea accepts a tidal plant on its coastal shore and
 * offshore wind turbines anywhere, and nothing else (no roads, bridges,
 * or run-of-river). Pumped storage additionally needs a lake shore.
 * Power lines are accepted on any terrain and on roads, but not on
 * buildings or plants; zones and plants are rejected on line tiles.
 */
export function buildRejection(
  state: SimState,
  index: number,
  intent: BuildIntent,
  plant: PlantType = PlantType.None,
): string | null {
  const { layers } = state;
  if (intent === BuildIntent.PowerLine) {
    // Lines share tiles with roads and water but never with buildings or plants.
    if (layers.density[index] !== 0 || layers.tileType[index] === TileType.Plant) {
      return 'needsLineSite';
    }
    if (slopeAt(state, index) > BALANCE.terrain.maxBuildSlope) return 'tooSteep';
    return null;
  }
  if (layers.tileType[index] !== TileType.Empty || layers.density[index] !== 0) {
    return 'tileOccupied';
  }
  // Zones and plants would collide with a line; roads may share the tile.
  if (intent !== BuildIntent.Road && layers.powerLine[index] !== 0) {
    return 'tileOccupied';
  }
  const terrain = layers.terrain[index] as Terrain;
  const wantsRiver = intent === BuildIntent.Plant && plant === PlantType.RunOfRiver;
  const wantsTidal = intent === BuildIntent.Plant && plant === PlantType.TidalPlant;
  const offshoreWind = intent === BuildIntent.Plant && plant === PlantType.WindTurbine;
  const wantsGeothermal = intent === BuildIntent.Plant && plant === PlantType.GeothermalPlant;
  if (terrain === Terrain.Sea) {
    // The sea carries tidal plants on its shore and offshore turbines;
    // roads stop at the coast (bridges cross the river, not the sea).
    if (wantsTidal) return isCoastalSea(state, index) ? null : 'needsCoast';
    if (offshoreWind) return null;
    return 'cannotBuildOnWater';
  }
  if (wantsTidal) return 'needsSeaTile';
  if (terrain === Terrain.Lake) return 'cannotBuildOnWater';
  if (terrain === Terrain.River && !(intent === BuildIntent.Road || wantsRiver)) {
    return 'cannotBuildOnWater';
  }
  if (wantsRiver && terrain !== Terrain.River) return 'needsRiverTile';
  // Steep tiles reject everything the water rules did not already veto.
  if (slopeAt(state, index) > BALANCE.terrain.maxBuildSlope) return 'tooSteep';
  if (terrain === Terrain.River) return null; // bridge or run-of-river
  // Hot rock only: the well has to reach the reservoir underneath.
  if (wantsGeothermal && layers.geothermal[index] === 0) return 'needsHotspot';
  if (
    intent === BuildIntent.Plant &&
    plant === PlantType.PumpedStorage &&
    !isLakeShore(state, index)
  ) {
    return 'needsLakeShore';
  }
  if (
    intent === BuildIntent.Plant &&
    (plant === PlantType.FireStation ||
      plant === PlantType.PoliceStation ||
      plant === PlantType.LogisticsDepot ||
      plant === PlantType.BusDepot) &&
    !neighbors4(index, state.size).some((n) => layers.tileType[n] === TileType.Road)
  ) {
    return 'needsRoad';
  }
  return null;
}

export function isBuildable(
  state: SimState,
  index: number,
  intent: BuildIntent,
  plant: PlantType = PlantType.None,
): boolean {
  return buildRejection(state, index, intent, plant) === null;
}

function copyBuffer(view: Uint8Array | Uint32Array): ArrayBuffer {
  return view.slice().buffer as ArrayBuffer;
}

export function serializeState(state: SimState): SaveGame {
  const { layers } = state;
  return {
    version: SAVE_VERSION,
    seed: state.seed,
    size: state.size,
    tick: state.tick,
    money: state.money,
    taxRate: state.taxRate,
    smartCharging: state.smartCharging,
    marketTrading: state.marketTrading,
    storedEnergy: state.storedEnergy,
    goals: [...state.goalsAchieved],
    lifetime: state.lifetime.samples.map((sample) => ({ ...sample })),
    riverFlow: state.weather.riverFlow,
    pumpedStorageEnergy: state.pumpedStorageEnergy,
    hydrogenEnergy: state.hydrogenEnergy,
    seasonOriginDay: state.seasonOriginDay,
    snowpack: state.weather.snowpack,
    insulation: state.insulation,
    winterTicks: state.goalProgress.winterTicks,
    summerTicks: state.goalProgress.summerTicks,
    freeFlowTicks: state.goalProgress.freeFlowTicks,
    wellStockedTicks: state.goalProgress.wellStockedTicks,
    transitTicks: state.goalProgress.transitTicks,
    layers: {
      tileType: copyBuffer(layers.tileType),
      roadMask: copyBuffer(layers.roadMask),
      zone: copyBuffer(layers.zone),
      density: copyBuffer(layers.density),
      variant: copyBuffer(layers.variant),
      supplied: copyBuffer(layers.supplied),
      plantType: copyBuffer(layers.plantType),
      terrain: copyBuffer(layers.terrain),
      powerLine: copyBuffer(layers.powerLine),
      elevation: copyBuffer(layers.elevation),
      forest: copyBuffer(layers.forest),
      roadClass: copyBuffer(layers.roadClass),
      busStop: copyBuffer(layers.busStop),
      geothermal: copyBuffer(layers.geothermal),
      reservoirHeat: copyBuffer(layers.reservoirHeat),
    },
  };
}

export function deserializeState(save: SaveGame): SimState {
  const state = createSimState(save.seed, save.size);
  state.tick = save.tick;
  state.money = save.money;
  state.taxRate = save.taxRate;
  state.smartCharging = save.smartCharging;
  state.marketTrading = save.marketTrading ?? false;
  state.storedEnergy = save.storedEnergy;
  state.goalsAchieved = new Set(save.goals ?? []);
  state.lifetime.samples = (save.lifetime ?? []).map((sample) => ({ ...sample }));
  state.layers.tileType.set(new Uint8Array(save.layers.tileType));
  state.layers.roadMask.set(new Uint8Array(save.layers.roadMask));
  state.layers.zone.set(new Uint8Array(save.layers.zone));
  state.layers.density.set(new Uint8Array(save.layers.density));
  state.layers.variant.set(new Uint8Array(save.layers.variant));
  state.layers.supplied.set(new Uint8Array(save.layers.supplied));
  state.layers.plantType.set(new Uint8Array(save.layers.plantType));
  state.pumpedStorageEnergy = save.pumpedStorageEnergy ?? 0;
  state.hydrogenEnergy = save.hydrogenEnergy ?? 0;
  state.weather.riverFlow = save.riverFlow ?? BALANCE.water.dryBaselineFlow;
  // Hand-edited JSON exports may hold out-of-range values; keep the
  // season readable (whole days, snow cover 0..1).
  state.weather.snowpack = Math.min(1, Math.max(0, save.snowpack ?? 0));
  state.insulation = save.insulation ?? false;
  state.goalProgress.winterTicks = save.winterTicks ?? 0;
  state.goalProgress.summerTicks = save.summerTicks ?? 0;
  state.goalProgress.freeFlowTicks = save.freeFlowTicks ?? 0;
  state.goalProgress.wellStockedTicks = save.wellStockedTicks ?? 0;
  state.goalProgress.transitTicks = save.transitTicks ?? 0;
  // Saves from before seasons start their year on the day they are loaded.
  state.seasonOriginDay = Math.floor(save.seasonOriginDay ?? save.tick / TICKS_PER_DAY);
  state.season = seasonState({
    day: Math.floor(save.tick / TICKS_PER_DAY),
    timeOfDay: (save.tick % TICKS_PER_DAY) / TICKS_PER_DAY,
    seasonOriginDay: state.seasonOriginDay,
    cloudCover: state.weather.cloudCover,
  });
  if (save.layers.terrain) state.layers.terrain.set(new Uint8Array(save.layers.terrain));
  if (save.layers.powerLine) {
    state.layers.powerLine.set(new Uint8Array(save.layers.powerLine));
  } else {
    grantLegacyNetwork(state);
  }
  if (save.layers.elevation) state.layers.elevation.set(new Uint8Array(save.layers.elevation));
  if (save.layers.forest) state.layers.forest.set(new Uint8Array(save.layers.forest));
  if (save.layers.roadClass) state.layers.roadClass.set(new Uint8Array(save.layers.roadClass));
  if (save.layers.busStop) state.layers.busStop.set(new Uint8Array(save.layers.busStop));
  if (save.layers.geothermal) {
    state.layers.geothermal.set(new Uint8Array(save.layers.geothermal));
    if (save.layers.reservoirHeat) {
      state.layers.reservoirHeat.set(new Uint8Array(save.layers.reservoirHeat));
    } else {
      // A half-old save: hotspots but no reservoir — start them full.
      for (let i = 0; i < state.layers.geothermal.length; i++) {
        if (state.layers.geothermal[i] !== 0) state.layers.reservoirHeat[i] = FULL_HEAT;
      }
    }
  } else {
    // Saves from before geothermal: the generator is a pure function of
    // seed, terrain and elevation, all of which this save carries, so the
    // city gains exactly the hotspots a fresh map of this seed would have.
    generateGeothermal(state);
  }
  discoverGeothermalFields(state);
  state.lakeLevel = computeLakeLevel(state);
  // Advance the RNG deterministically past the founding state so a loaded
  // game does not replay the exact random sequence from tick zero.
  state.rng.setState(save.seed ^ save.tick);
  markAllDirty(state);
  return state;
}

/** Count population and jobs from the current building layers. */
export function countPopulationAndJobs(state: SimState): {
  population: number;
  jobs: number;
} {
  const { zone, density, tileType } = state.layers;
  let population = 0;
  let jobs = 0;
  for (let i = 0; i < zone.length; i++) {
    if (tileType[i] !== TileType.Empty) continue;
    const d = density[i];
    if (d === 0) continue;
    const z = zone[i] as Zone;
    if (z === Zone.Residential) {
      population += BALANCE.growth.populationByDensity[d];
    } else if (z === Zone.Commercial || z === Zone.Retail) {
      jobs += BALANCE.growth.jobsByZoneAndDensity[z][d];
    }
  }
  return { population, jobs };
}

/** Number of plants of a given type currently placed. */
export function countPlants(state: SimState, plant: PlantType): number {
  const { tileType, plantType } = state.layers;
  let count = 0;
  for (let i = 0; i < tileType.length; i++) {
    if (tileType[i] === TileType.Plant && plantType[i] === plant) count++;
  }
  return count;
}

export function totalStorageCapacity(state: SimState): number {
  return countPlants(state, PlantType.Battery) * BALANCE.energy.batteryCapacity;
}

/** Biogas output the city could dispatch per tick if every plant ran flat out. */
export function totalBiogasCapacity(state: SimState): number {
  return countPlants(state, PlantType.BiogasPlant) * BALANCE.energy.biogasMaxOutput;
}

export function totalHydrogenCapacity(state: SimState): number {
  return countPlants(state, PlantType.HydrogenPlant) * BALANCE.hydrogen.capacity;
}

export function totalPumpedStorageCapacity(state: SimState): number {
  const { tileType, plantType } = state.layers;
  let capacity = 0;
  for (let i = 0; i < tileType.length; i++) {
    if (tileType[i] !== TileType.Plant || plantType[i] !== PlantType.PumpedStorage) continue;
    capacity +=
      (1 + BALANCE.terrain.headBonusPerLevel * pumpedHeadAt(state, i)) *
      BALANCE.energy.pumpedStorageCapacity;
  }
  return capacity;
}

/** Append an energy history sample, keeping one in-game day of samples. */
export function pushEnergyHistory(state: SimState, point: EnergyHistoryPoint): void {
  state.energyHistory.push(point);
  if (state.energyHistory.length > ENERGY_HISTORY_SAMPLES) {
    state.energyHistory.shift();
  }
}

export { SupplyStatus, TileType, Zone, PlantType, Terrain };
