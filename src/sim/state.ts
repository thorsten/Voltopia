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
  DisasterEvent,
  IslandStats,
  LifetimeSample,
  EnergyHistoryPoint,
  RailStats,
  SaveGame,
  SavedDisasters,
  SeasonState,
  Speed,
  TileDiff,
  TransitStats,
  Weather,
} from '../shared/types.ts';
import {
  DeliveryState,
  DisasterKind,
  MAX_RAIL_AGE,
  PlantType,
  StopState,
  SupplyStatus,
  Terrain,
  TileType,
  Zone,
} from '../shared/types.ts';
import { callBudgetTicks } from './demandResponse.ts';
import { emptyPlantMap, type EconomyBreakdown } from './economy.ts';
import {
  discoverGeothermalFields,
  generateGeothermal,
  FULL_HEAT,
  type GeothermalField,
} from './geothermal.ts';
import { poolForIsland, syncIslandPools, type IslandPool } from './islandPools.ts';
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
  /**
   * Tile the car is plugged in at (its home road or a charging hub),
   * -1 while not charging: the island that carries its load. Not
   * persisted.
   */
  chargeTile: number;
  /** Consecutive ticks spent waiting behind a full lane (gridlock breaker). */
  waitTicks: number;
  /** Day of the last decision to ride the bus instead of driving; -1 = drives. Not persisted. */
  riderDay: number;
}

/** Tour phases of a delivery van. */
export const VanPhase = { AtDepot: 0, Driving: 1, Unloading: 2, Loading: 3 } as const;
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
  /**
   * Road tile of this tour's factory pickup, -1 when the goods were
   * imported or once the van has loaded (so a later discarded stop can
   * never relabel the tour).
   */
  pickup: number;
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

/** What a train carries. */
export const TrainKind = { Passenger: 0, Freight: 1 } as const;
export type TrainKind = (typeof TrainKind)[keyof typeof TrainKind];

/** Tour phases of a train. Parked covers the turnaround wait at the yard. */
export const TrainPhase = { Parked: 0, Running: 1, Dwelling: 2 } as const;
export type TrainPhase = (typeof TrainPhase)[keyof typeof TrainPhase];

/** One electric train (persisted without `stalled`). Not a Mover: it runs on tracks. */
export interface Train {
  /** Stable id (shares nextVehicleId with cars, vans and buses). */
  id: number;
  kind: TrainKind;
  /** Yard plant tile; -1 once the train is lost and awaits removal. */
  yard: number;
  /** Track tile beside the yard the train parks on. */
  yardTrack: number;
  x: number;
  y: number;
  angle: number;
  phase: TrainPhase;
  /** Remaining halts of the tour (track tiles beside plants); the last one is yardTrack. */
  stops: number[];
  /** Track tile of this tour's loading halt (freight), -1 when none or once loaded. */
  pickup: number;
  /** Track tiles from the current position to stops[0]. */
  path: number[];
  pathIndex: number;
  /** Remaining dwell / turnaround ticks. */
  dwellTicks: number;
  /** Stood still this tick for lack of power (transient). */
  stalled: boolean;
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
    rail: number;
    forest: number;
    damage: number;
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
  /** Damage points per tile: 0 = intact, 1..255 = out of service (persisted). */
  damage: Uint8Array;
  /**
   * Energy held on a storage plant tile (battery / pumped / hydrogen
   * energy units, heat units on a heat store); 0 everywhere else.
   * Persisted. A damaged plant's level is frozen, not lost: it survives
   * a save and comes back when the plant is repaired. Bulldozing clears
   * it, and undo rebuilds the plant empty.
   */
  stored: Float32Array;
  /**
   * Last `stored` share reported as a diff, quantised to 1/64 of the
   * tile's capacity. Derived, not persisted: it only decides when a
   * storage tile is marked dirty (see energyStep).
   */
  lastStoredStep: Uint8Array;
  /** Power line mask per tile (0 = none, else LINE_PRESENT | connection bits). */
  powerLine: Uint8Array;
  /** 1 when the tile is within lineSupplyRadius of an energised line or supply plant. Derived, not persisted. */
  energized: Uint8Array;
  /**
   * Island number 1.. of the grid component this tile is energised by;
   * 0 = none. Derived, not persisted. Uint16Array caps islands at 65 535,
   * far above any 128x128 map's possible components.
   */
  island: Uint16Array;
  /**
   * `island` as it was the last time `syncIslandPools` ran (a snapshot
   * `recomputeGrid` takes just before overwriting `island`, but only
   * when the labelling it is about to replace is the one the pools
   * were synced to — several recomputes can happen between two syncs,
   * and the snapshot must keep describing the synced labelling through
   * all of them). Lets `syncIslandPools` map ownership by tile overlap
   * rather than by a vanished key's old tile. Derived, not persisted.
   */
  prevIsland: Uint16Array;
  /** Service coverage bitmask (SERVICE_FIRE | SERVICE_POLICE). Derived, not persisted. */
  services: Uint8Array;
  /** District heating: HEATED_NONE / HEATED_TRUNK / HEATED_SERVED. Derived, not persisted. */
  heated: Uint8Array;
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
  /** Track mask per tile (0 = none, else LINE_PRESENT | connection bits). Persisted. */
  rail: Uint8Array;
  /** Track network number 1.. of this track tile; 0 = no track. Derived, not persisted. */
  railNetwork: Uint16Array;
  /** Ticks since a passenger train last halted at this station, saturating. Derived. */
  stationAge: Uint16Array;
  /** Ticks since a freight train last unloaded at this terminal, saturating. Derived. */
  terminalAge: Uint16Array;
  /** Nearest served station's tile for road tiles within stationRadius, -1 elsewhere. Derived. */
  railStation: Int32Array;
  /** Ticks since a freight train unloaded in reach of this depot, saturating. Derived. */
  railGoodsAge: Uint16Array;
}

export interface SimState {
  seed: number;
  size: number;
  rng: Rng;
  tick: number;
  speed: Speed;
  money: number;
  taxRate: number;
  /** Storage trades on the spot market: sell at scarcity, buy cheap. */
  marketTrading: boolean;
  /** Building insulation upgrade bought (halves the heating load). */
  insulation: boolean;
  /**
   * Smart-meter rollout: crews installing, meters in place, and the crew
   * time carried between ticks (in ticks: installsPerDay per tick,
   * TICKS_PER_DAY buys one meter). Transient, like any sub-tick carry.
   */
  smartMeters: {
    active: boolean;
    metered: number;
    installCarry: number;
  };
  /**
   * Buildings counted at the last `refreshBuildingCount` — the coverage
   * denominator for the whole tick. Counting them is a full-grid scan,
   * and `isSmartVehicle` asks for coverage once per parked vehicle, van
   * and bus, so the count is cached once per tick instead. Transient:
   * not persisted, recomputed from the layers on load.
   */
  lastBuildingCount: number;
  /** Smart-meter install cost paid last tick (budget line). */
  lastSmartMeterCost: number;
  /**
   * Demand-response contract with the commercial, retail and industrial
   * zones: whether it is in force. The call budget lives per island, on
   * `islandPools`.
   */
  demandResponse: {
    active: boolean;
  };
  /** Retainer plus activation premiums paid last tick (budget line). */
  lastDemandResponseCost: number;
  /** Day number on which year 1 started; 0 for new games. */
  seasonOriginDay: number;
  /** Seasonal signal for the current tick, recomputed in stepTick. */
  season: SeasonState;
  happiness: number;
  /** Incremented whenever plants or power lines change; drives recomputeGrid. */
  gridVersion: number;
  /** gridVersion the energized layer was last computed for (-1 = never). */
  gridComputedVersion: number;
  /** islandKeys[n] = lowest tile index of island n (its stable key); islandKeys[0] = -1. Rebuilt by recomputeGrid. */
  islandKeys: number[];
  /**
   * `islandKeys` as it was the last time `syncIslandPools` ran, paired
   * with `layers.prevIsland` — together they are the labelling
   * `syncIslandPools` maps the new one against. Not persisted.
   */
  prevIslandKeys: number[];
  /**
   * Per-island pools (flex backlog, demand-response call budget), keyed
   * by the island's stable key (its lowest tile index). Kept in sync
   * with the current islands by `syncIslandPools` (see islandPools.ts).
   * Persisted.
   */
  islandPools: Map<number, IslandPool>;
  /** gridComputedVersion islandPools was last synced for (-1 = never). */
  poolsSyncedVersion: number;
  weather: Weather;
  /** Elevation of the lake surface (derived; recomputed on load). */
  lakeLevel: number;
  layers: TileLayers;
  /** Hotspot fields, derived from the geothermal layer; never persisted. */
  geothermalFields: GeothermalField[];
  /**
   * Disasters in flight. Pending events are warnings with a countdown,
   * active ones are striking right now. Persisted: the RNG is reseeded on
   * load, so an event cannot be re-derived from (seed, tick).
   */
  disasters: {
    pending: DisasterEvent[];
    active: DisasterEvent[];
    nextId: number;
    cooldownTicks: number;
  };
  /** Disaster intensity: 0 = off, 0.5 mild, 1 normal, 1.6 harsh. */
  disasterScale: number;
  /** Money spent on repairs last tick (feeds the budget panel). */
  lastRepairCost: number;
  vehicles: Vehicle[];
  vans: Van[];
  /**
   * Goods tours of the running day and of the day before (localGoods
   * goal). Single-day counters: transient by the goalProgress rule.
   * `partialDay` is set from the saved tick's parity on load, so a
   * reload mid-day forfeits that day's attempt: at the next rollover
   * it is copied into `lastDay.partial`, which the goal requires to be
   * false.
   */
  goods: {
    localToursToday: number;
    importedToursToday: number;
    /** True while today began from a mid-day reload. Not persisted. */
    partialDay: boolean;
    lastDay: {
      local: number;
      imported: number;
      /** True when that day began from a mid-day reload. */
      partial: boolean;
    };
  };
  /** Import fees paid this tick (budget line). */
  lastGoodsImportCost: number;
  buses: Bus[];
  trains: Train[];
  /** Bumped by every track build or removal; the network labelling is recomputed when it differs from railComputedVersion. */
  railVersion: number;
  railComputedVersion: number;
  /** railNetworkKeys[n] = lowest tile index of network n; railNetworkKeys[0] = -1. */
  railNetworkKeys: number[];
  undoStack: UndoEntry[];
  energyHistory: EnergyHistoryPoint[];
  /** Running sums since the last history sample (not persisted). */
  energyHistoryAccum: {
    generation: number;
    consumption: number;
    /** Consumption before load shifting (smart meters). */
    unshifted: number;
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
  lastRail: RailStats;
  /** Achieved goal ids (persisted with the save game). */
  goalsAchieved: Set<string>;
  /**
   * Goal progress counters; the season streaks are persisted, the rest is
   * transient. The rule: a counter is persisted when losing it costs a whole
   * season, and left transient when losing it costs at most one in-game day.
   * `winterTicks`, `summerTicks`, `freeFlowTicks`, `wellStockedTicks` and
   * `transitTicks` are season-length, so they are persisted. `cleanDayTicks`
   * and `geothermalTicks` are single-day streaks, so a reload resetting them
   * is an accepted cost, not an oversight — they stay transient. `stormTicks`
   * is shorter still (one storm, not even a full day), so it stays
   * transient for the same reason. `flexTicks` is the exception that
   * proves the rule: it is cumulative, not a streak, so the ticks a
   * reload would drop are gone for good — it is persisted.
   */
  goalProgress: {
    cleanDayTicks: number;
    exportedTotal: number;
    winterTicks: number;
    summerTicks: number;
    freeFlowTicks: number;
    wellStockedTicks: number;
    transitTicks: number;
    /** Consecutive railCity ticks; persisted like transitTicks. */
    railTicks: number;
    geothermalTicks: number;
    stormTicks: number;
    warmWinterTicks: number;
    flexTicks: number;
    /** Cumulative energy shed under the contract (loadManager); persisted like flexTicks. */
    shedTotal: number;
    /** Deficit ticks seen today, for the districtGrid goal; persisted like warmWinterTicks. */
    districtDeficitTicks: number;
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
  /**
   * Per-island figures of the last energy step, in island order. Set by
   * `energyStep`, published as `GlobalStats.islands`. Transient: derived
   * from the tiles every tick, never persisted.
   */
  lastIslands: IslandStats[];
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
    /** Catenary draw of the running trains this tick. */
    tractionConsumption: number;
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
    /** Electricity the heat pumps drew this tick (serving plus charging). */
    heatPumpConsumption: number;
    /** Heat units delivered to served buildings this tick. */
    networkHeat: number;
    /** Heat units that fell back to the buildings' own electric heating. */
    heatFallback: number;
    /** Electricity absorbed into the heat store this tick. */
    heatStoreCharge: number;
    /** Heat pump COP in force this tick. */
    heatCop: number;
    /** Spot price factor applied to this tick's link traffic. */
    spotPrice: number;
    /** Stored energy sold / bought by market trading this tick. */
    tradeSell: number;
    tradeBuy: number;
    /** Flexible load deferred into the backlog this tick (smart meters). */
    flexDeferred: number;
    /** Backlog served from renewable surplus this tick. */
    flexRecovered: number;
    /** Deferred flexible energy still waiting after this tick. */
    flexBacklog: number;
    /** Backlog served regardless of the weather this tick (comfort bound). */
    flexOverflow: number;
    /** What consumption would have been without shifting. */
    unshifted: number;
    /** Energy shed under the demand-response contract this tick. */
    shed: number;
    /** What the contract could have shed this tick (0 while it is off). */
    shedPool: number;
    /** Connected commercial, retail and industrial buildings (the contract's partners). */
    contractedBuildings: number;
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
    damage: new Uint8Array(tiles),
    stored: new Float32Array(tiles),
    lastStoredStep: new Uint8Array(tiles),
    powerLine: new Uint8Array(tiles),
    energized: new Uint8Array(tiles),
    island: new Uint16Array(tiles),
    prevIsland: new Uint16Array(tiles),
    services: new Uint8Array(tiles),
    heated: new Uint8Array(tiles),
    buildingAge: new Uint32Array(tiles),
    troubledTicks: new Uint32Array(tiles),
    trafficLoad: new Uint8Array(tiles),
    deliveryAge: new Uint16Array(tiles),
    busStop: new Uint8Array(tiles),
    stopAge: new Uint16Array(tiles),
    transitCover: new Uint8Array(tiles),
    rail: new Uint8Array(tiles),
    railNetwork: new Uint16Array(tiles),
    stationAge: new Uint16Array(tiles).fill(MAX_RAIL_AGE),
    terminalAge: new Uint16Array(tiles).fill(MAX_RAIL_AGE),
    railStation: new Int32Array(tiles).fill(-1),
    railGoodsAge: new Uint16Array(tiles).fill(MAX_RAIL_AGE),
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
    marketTrading: false,
    insulation: false,
    smartMeters: { active: false, metered: 0, installCarry: 0 },
    // A fresh map has no buildings; stepTick refreshes this every tick.
    lastBuildingCount: 0,
    lastSmartMeterCost: 0,
    demandResponse: { active: false },
    lastDemandResponseCost: 0,
    seasonOriginDay: 0,
    season: seasonState({ day: 0, timeOfDay: 0, seasonOriginDay: 0, cloudCover: 0.3 }),
    happiness: BALANCE.happiness.base,
    gridVersion: 0,
    gridComputedVersion: -1,
    islandKeys: [-1],
    prevIslandKeys: [-1],
    islandPools: new Map(),
    poolsSyncedVersion: -1,
    weather: {
      cloudCover: 0.3,
      windSpeed: 0.5,
      riverFlow: BALANCE.water.initialFlow,
      snowpack: 0,
      gust: 0,
    },
    lakeLevel: 0,
    layers: createTileLayers(size),
    geothermalFields: [],
    disasters: { pending: [], active: [], nextId: 1, cooldownTicks: 0 },
    // Off by default so a bare createSimState() — every unrelated sim test,
    // every headless SimEngine — never silently runs with disasters on.
    // A real new city gets normal intensity from the engine's fresh-city
    // branch instead (see applyCommand('init') in engine.ts).
    disasterScale: 0,
    lastRepairCost: 0,
    vehicles: [],
    vans: [],
    goods: {
      localToursToday: 0,
      importedToursToday: 0,
      partialDay: false,
      lastDay: { local: 0, imported: 0, partial: false },
    },
    lastGoodsImportCost: 0,
    buses: [],
    trains: [],
    railVersion: 0,
    railComputedVersion: -1,
    railNetworkKeys: [-1],
    undoStack: [],
    energyHistory: [],
    energyHistoryAccum: { generation: 0, consumption: 0, unshifted: 0, soc: 0, price: 0, ticks: 0 },
    dirty: new Set(),
    statsDirty: false,
    lastDemand: { residential: 0, commercial: 0, retail: 0, industrial: 0 },
    lastServices: { fire: 0, police: 0 },
    lastDeliveries: {
      suppliedShare: 1,
      shops: 0,
      driving: 0,
      depots: 0,
      factories: 0,
      localShare: 1,
      depotsRailSupplied: 0,
    },
    lastTransit: {
      riderShare: 0,
      riders: 0,
      busRiders: 0,
      railRiders: 0,
      driving: 0,
      stops: 0,
      stopsServed: 0,
      depots: 0,
    },
    lastRail: {
      networks: 0,
      trackTiles: 0,
      stations: 0,
      stationsServed: 0,
      terminals: 0,
      terminalsLoading: 0,
      terminalsUnloading: 0,
      yards: 0,
      trainsRunning: 0,
      trainsStalled: 0,
    },
    goalsAchieved: new Set(),
    goalProgress: {
      cleanDayTicks: 0,
      exportedTotal: 0,
      winterTicks: 0,
      summerTicks: 0,
      freeFlowTicks: 0,
      wellStockedTicks: 0,
      transitTicks: 0,
      railTicks: 0,
      geothermalTicks: 0,
      stormTicks: 0,
      warmWinterTicks: 0,
      flexTicks: 0,
      shedTotal: 0,
      districtDeficitTicks: 0,
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
    lastIslands: [],
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
      tractionConsumption: 0,
      heatingConsumption: 0,
      coolingConsumption: 0,
      curtailment: 0,
      deficit: 0,
      gridImport: 0,
      gridExport: 0,
      electrolysis: 0,
      fuelCell: 0,
      hydrogenSold: 0,
      heatPumpConsumption: 0,
      networkHeat: 0,
      heatFallback: 0,
      heatStoreCharge: 0,
      heatCop: 1,
      spotPrice: 1,
      tradeSell: 0,
      tradeBuy: 0,
      flexDeferred: 0,
      flexRecovered: 0,
      flexBacklog: 0,
      flexOverflow: 0,
      unshifted: 0,
      shed: 0,
      shedPool: 0,
      contractedBuildings: 0,
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
    rail: layers.rail[index],
    forest: layers.forest[index],
    damage: layers.damage[index],
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

/** A storage tile's level as a share 0..1 of its capacity; 0 elsewhere. */
function storedShareAt(state: SimState, index: number): number {
  const capacity = storageCapacityAt(state, index);
  return capacity > 0 ? state.layers.stored[index] / capacity : 0;
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
      heated: layers.heated[index],
      island: layers.island[index],
      plantType: layers.plantType[index] as TileDiff['plantType'],
      terrain: layers.terrain[index] as TileDiff['terrain'],
      elevation: layers.elevation[index],
      forest: layers.forest[index],
      geothermal: layers.geothermal[index],
      reservoirHeat: layers.reservoirHeat[index],
      damage: layers.damage[index],
      stored: storedShareAt(state, index),
      ageStage: ageStageOf(layers.buildingAge[index]),
      deliveryState: deliveryStateOfAge(layers.deliveryAge[index]),
      busStop: layers.busStop[index],
      stopState:
        layers.busStop[index] !== 0 ? stopStateOfAge(layers.stopAge[index]) : StopState.Served,
      transitCover: layers.transitCover[index],
      rail: layers.rail[index],
      railCover: layers.railStation[index] >= 0 ? 1 : 0,
      stationState:
        layers.tileType[index] === TileType.Plant &&
        layers.plantType[index] === PlantType.TrainStation
          ? stationStateOfAge(layers.stationAge[index])
          : StopState.Served,
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

/** Ticks a station stays served after a train halted there. */
export function stationServiceTicks(): number {
  return Math.round(BALANCE.rail.serviceWindowDays * TICKS_PER_DAY);
}

/** Ticks after which a station or terminal counts as due for a train. */
export function stationDueTicks(): number {
  return Math.round(BALANCE.rail.dueAfterDays * TICKS_PER_DAY);
}

/** Service bucket of a station given its ticks since the last train. */
export function stationStateOfAge(age: number): StopState {
  if (age > stationServiceTicks()) return StopState.Unserved;
  if (age > stationDueTicks()) return StopState.Due;
  return StopState.Served;
}

/**
 * Visual age bucket of a building given its ticks since the last rebuild
 * (placement, densify or decay): 0 = new, 1 = lived-in, 2 = weathered.
 * Render only; nothing in the sim reads it.
 */
export function ageStageOf(buildingAge: number): number {
  const [livedIn, weathered] = BALANCE.growth.ageStageTicks;
  if (buildingAge >= weathered) return 2;
  if (buildingAge >= livedIn) return 1;
  return 0;
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
 * What the storage plant built on this tile can hold, damaged or not:
 * 0 unless the tile carries a battery, pumped-storage plant, hydrogen
 * plant or heat store.
 *
 * This is the bound a tile's level is clamped against — a wreck's
 * contents are frozen, not lost, so clamping against its (zero) working
 * capacity would empty it. Use `storageCapacityAt` for everything that
 * decides what the grid can charge, draw or count.
 */
export function installedStorageCapacityAt(state: SimState, index: number): number {
  const { tileType, plantType } = state.layers;
  if (tileType[index] !== TileType.Plant) return 0;
  switch (plantType[index] as PlantType) {
    case PlantType.Battery:
      return BALANCE.energy.batteryCapacity;
    case PlantType.PumpedStorage:
      return (
        BALANCE.energy.pumpedStorageCapacity *
        (1 + BALANCE.terrain.headBonusPerLevel * pumpedHeadAt(state, index))
      );
    case PlantType.HydrogenPlant:
      return BALANCE.hydrogen.capacity;
    case PlantType.HeatStore:
      return BALANCE.heat.storeCapacity;
    default:
      return 0;
  }
}

/**
 * What the storage plant on this tile can hold right now: its installed
 * capacity, or 0 while it is damaged. A damaged plant is out of the
 * balance entirely — nothing charges it, draws from it or counts it —
 * and its level stays frozen until it is repaired.
 *
 * Lives here rather than in storage.ts because `collectDiffs` needs it
 * and storage.ts reads it from here (and re-exports it for everyone
 * else), which keeps the import one-way.
 */
export function storageCapacityAt(state: SimState, index: number): number {
  if (state.layers.damage[index] !== 0) return 0;
  return installedStorageCapacityAt(state, index);
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
  // A damaged tile is a building site only after the repair crews are
  // done; the bulldozer may still clear it.
  if (layers.damage[index] !== 0) return 'damaged';
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

function savedEvent(event: DisasterEvent, active: boolean): SavedDisasters['events'][number] {
  return {
    id: event.id,
    kind: event.kind,
    severity: event.severity,
    startTick: event.startTick,
    endTick: event.endTick,
    origin: event.origin,
    tiles: [...event.tiles],
    intensity: [...event.intensity],
    active,
  };
}

/**
 * The `stored` layer as sparse [index, value, …] pairs. Sparse because
 * only storage plants hold anything: a 128x128 map would otherwise waste
 * 16 384 zeroes per save.
 */
function storedPairs(state: SimState): number[] {
  const { stored } = state.layers;
  const pairs: number[] = [];
  for (let i = 0; i < stored.length; i++) {
    if (stored[i] > 0) pairs.push(i, stored[i]);
  }
  return pairs;
}

/**
 * A save from before `stored` carried one number per storage kind.
 * Spread it over the intact plants of that kind in proportion to their
 * capacity: the city reloads with the same total and the same share on
 * every tile, which is what the old pooled cascade effectively had.
 *
 * Walks the layers itself rather than calling storage.ts' identical
 * `storageTilesOfKind`: storage.ts reads `storageCapacityAt` from here,
 * and importing it back would close the cycle.
 */
function spreadLegacyPool(state: SimState, plant: PlantType, total: number | undefined): void {
  if (!total || !Number.isFinite(total) || total <= 0) return;
  const { tileType, plantType, damage } = state.layers;
  const tiles: number[] = [];
  let capacity = 0;
  // Intact plants only: the old pool was clamped to the working capacity,
  // so none of it was ever held by a wreck.
  for (let i = 0; i < tileType.length; i++) {
    if (tileType[i] !== TileType.Plant || plantType[i] !== plant || damage[i] !== 0) continue;
    tiles.push(i);
    capacity += installedStorageCapacityAt(state, i);
  }
  if (capacity <= 0) return;
  const share = Math.min(1, total / capacity);
  for (const t of tiles) state.layers.stored[t] = installedStorageCapacityAt(state, t) * share;
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
    marketTrading: state.marketTrading,
    stored: storedPairs(state),
    goals: [...state.goalsAchieved],
    lifetime: state.lifetime.samples.map((sample) => ({ ...sample })),
    riverFlow: state.weather.riverFlow,
    seasonOriginDay: state.seasonOriginDay,
    snowpack: state.weather.snowpack,
    insulation: state.insulation,
    smartMeters: { active: state.smartMeters.active, metered: state.smartMeters.metered },
    islandPools: [...state.islandPools].map(([key, p]) => [key, p.flexBacklog, p.callBudget]),
    winterTicks: state.goalProgress.winterTicks,
    summerTicks: state.goalProgress.summerTicks,
    freeFlowTicks: state.goalProgress.freeFlowTicks,
    wellStockedTicks: state.goalProgress.wellStockedTicks,
    transitTicks: state.goalProgress.transitTicks,
    railTicks: state.goalProgress.railTicks,
    warmWinterTicks: state.goalProgress.warmWinterTicks,
    flexTicks: state.goalProgress.flexTicks,
    demandResponse: { active: state.demandResponse.active },
    shedTotal: state.goalProgress.shedTotal,
    districtDeficitTicks: state.goalProgress.districtDeficitTicks,
    disasterScale: state.disasterScale,
    disasters: {
      nextId: state.disasters.nextId,
      cooldownTicks: state.disasters.cooldownTicks,
      events: [
        ...state.disasters.pending.map((event) => savedEvent(event, false)),
        ...state.disasters.active.map((event) => savedEvent(event, true)),
      ],
    },
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
      damage: copyBuffer(layers.damage),
      rail: copyBuffer(layers.rail),
    },
    trains: state.trains
      .filter((train) => train.yard >= 0)
      .map((train) => ({
        id: train.id,
        kind: train.kind,
        yard: train.yard,
        yardTrack: train.yardTrack,
        x: train.x,
        y: train.y,
        angle: train.angle,
        phase: train.phase,
        stops: [...train.stops],
        pickup: train.pickup,
        path: [...train.path],
        pathIndex: train.pathIndex,
        dwellTicks: train.dwellTicks,
      })),
  };
}

/** Island number with the most energised tiles; 0 when the grid has none. */
function largestIslandNumber(state: SimState): number {
  if (state.islandKeys.length <= 1) return 0;
  const counts = Array.from<number>({ length: state.islandKeys.length }).fill(0);
  for (const n of state.layers.island) counts[n]++;
  let best = 1;
  for (let n = 2; n < counts.length; n++) {
    if (counts[n] > counts[best]) best = n;
  }
  return best;
}

export function deserializeState(save: SaveGame): SimState {
  const state = createSimState(save.seed, save.size);
  state.tick = save.tick;
  state.money = save.money;
  state.taxRate = save.taxRate;
  state.marketTrading = save.marketTrading ?? false;
  state.goalsAchieved = new Set(save.goals ?? []);
  state.lifetime.samples = (save.lifetime ?? []).map((sample) => ({ ...sample }));
  state.layers.tileType.set(new Uint8Array(save.layers.tileType));
  state.layers.roadMask.set(new Uint8Array(save.layers.roadMask));
  state.layers.zone.set(new Uint8Array(save.layers.zone));
  state.layers.density.set(new Uint8Array(save.layers.density));
  state.layers.variant.set(new Uint8Array(save.layers.variant));
  state.layers.supplied.set(new Uint8Array(save.layers.supplied));
  state.layers.plantType.set(new Uint8Array(save.layers.plantType));
  state.weather.riverFlow = save.riverFlow ?? BALANCE.water.dryBaselineFlow;
  // Hand-edited JSON exports may hold out-of-range values; keep the
  // season readable (whole days, snow cover 0..1).
  state.weather.snowpack = Math.min(1, Math.max(0, save.snowpack ?? 0));
  state.insulation = save.insulation ?? false;
  // Rollout: new saves carry it; legacy saves with smart charging on get
  // every building metered so the city keeps the effect it had. Clamp
  // against hand-edited JSON exports holding out-of-range or non-finite
  // values, the same way the snowpack read above does.
  {
    const buildings = countBuildings(state);
    // The coverage denominator for the first tick after the load: the
    // cache is transient, so it has to be recomputed here rather than
    // restored (stepTick keeps it current from then on).
    state.lastBuildingCount = buildings;
    if (save.smartMeters) {
      const metered = Number.isFinite(save.smartMeters.metered) ? save.smartMeters.metered : 0;
      state.smartMeters = {
        active: save.smartMeters.active,
        metered: Math.min(buildings, Math.max(0, metered)),
        installCarry: 0,
      };
    } else {
      state.smartMeters = {
        active: save.smartCharging === true,
        metered: save.smartCharging === true ? buildings : 0,
        installCarry: 0,
      };
    }
  }
  state.goalProgress.winterTicks = save.winterTicks ?? 0;
  state.goalProgress.summerTicks = save.summerTicks ?? 0;
  state.goalProgress.freeFlowTicks = save.freeFlowTicks ?? 0;
  state.goalProgress.wellStockedTicks = save.wellStockedTicks ?? 0;
  state.goalProgress.transitTicks = save.transitTicks ?? 0;
  state.goalProgress.railTicks = save.railTicks ?? 0;
  state.goalProgress.warmWinterTicks = save.warmWinterTicks ?? 0;
  state.goalProgress.flexTicks = save.flexTicks ?? 0;
  state.goalProgress.shedTotal =
    typeof save.shedTotal === 'number' && Number.isFinite(save.shedTotal)
      ? Math.max(0, save.shedTotal)
      : 0;
  state.goalProgress.districtDeficitTicks = save.districtDeficitTicks ?? 0;
  state.demandResponse = { active: save.demandResponse?.active === true };
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
  if (save.layers.rail) state.layers.rail.set(new Uint8Array(save.layers.rail));
  if (save.layers.damage) state.layers.damage.set(new Uint8Array(save.layers.damage));
  // A save from before disasters keeps its calm: the city only faces them
  // when it was founded with an intensity (see NewGameOptions).
  state.disasterScale = save.disasterScale ?? 0;
  if (save.disasters) {
    state.disasters.nextId = save.disasters.nextId;
    state.disasters.cooldownTicks = save.disasters.cooldownTicks;
    for (const saved of save.disasters.events) {
      const event: DisasterEvent = {
        id: saved.id,
        kind: saved.kind as DisasterKind,
        severity: saved.severity,
        startTick: saved.startTick,
        endTick: saved.endTick,
        origin: saved.origin,
        tiles: [...saved.tiles],
        intensity: [...saved.intensity],
      };
      if (saved.active) state.disasters.active.push(event);
      else state.disasters.pending.push(event);
    }
  }
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
    // A save old enough to also lack `terrain`/`elevation` (both optional,
    // handled above) generates hotspots against a flat, all-land map instead,
    // which can scatter fields across an already-built city. That's bounded —
    // occupied tiles stay unbuildable — and is the price of guaranteeing a
    // given seed always yields the same hotspots.
    generateGeothermal(state);
  }
  discoverGeothermalFields(state);
  state.lakeLevel = computeLakeLevel(state);
  // Storage levels last: plantType and the lake level decide what a tile
  // can hold, so they must already be restored. The bound is the
  // installed capacity, damage ignored — a wrecked plant keeps the level
  // it was frozen at and gets it back on repair.
  if (save.stored) {
    const pairs = save.stored;
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      const tile = pairs[i];
      const value = pairs[i + 1];
      if (!Number.isInteger(tile) || tile < 0 || tile >= state.layers.stored.length) continue;
      if (!Number.isFinite(value) || value <= 0) continue;
      state.layers.stored[tile] = Math.min(value, installedStorageCapacityAt(state, tile));
    }
  } else {
    spreadLegacyPool(state, PlantType.Battery, save.storedEnergy);
    spreadLegacyPool(state, PlantType.PumpedStorage, save.pumpedStorageEnergy);
    spreadLegacyPool(state, PlantType.HydrogenPlant, save.hydrogenEnergy);
    spreadLegacyPool(state, PlantType.HeatStore, save.heatStored);
  }
  // Per-island pools, restored last: a save written by this version
  // carries them directly, keyed by tile index — bad entries are skipped
  // one at a time, never poisoning the rest, and this branch stays lazy
  // about the grid (like `islandKeys` itself) rather than forcing a
  // recompute on every load; the next thing that needs the grid (a real
  // tick, or a direct recomputeGrid/syncIslandPools call) resolves it.
  // An older save (or one whose islandPools field was dropped as
  // malformed by the JSON loader) starts fresh pools for every current
  // island via `syncIslandPools`, and, if it still carries the legacy
  // global fields, applies them to the largest island (most tiles) — the
  // pacing a single-island city had. `poolsSyncedVersion` is deliberately
  // left stale in the first branch: if a skipped entry left a current
  // island without a pool, the next `syncIslandPools` (the first tick's
  // energyStep) fills it in rather than the game crashing on it.
  if (save.islandPools) {
    const pools = new Map<number, IslandPool>();
    for (const [key, flexBacklog, callBudget] of save.islandPools) {
      if (!Number.isInteger(key) || key < 0) continue;
      if (!Number.isFinite(flexBacklog) || !Number.isFinite(callBudget)) continue;
      pools.set(key, {
        flexBacklog: Math.max(0, flexBacklog),
        callBudget: Math.min(callBudgetTicks(), Math.max(0, callBudget)),
      });
    }
    state.islandPools = pools;
  } else {
    syncIslandPools(state);
    const legacyBacklog =
      typeof save.flexBacklog === 'number' && Number.isFinite(save.flexBacklog)
        ? Math.max(0, save.flexBacklog)
        : undefined;
    const legacyBudget = save.demandResponse?.callBudget;
    const validBudget =
      typeof legacyBudget === 'number' && Number.isFinite(legacyBudget)
        ? Math.min(callBudgetTicks(), Math.max(0, legacyBudget))
        : undefined;
    if (legacyBacklog !== undefined || validBudget !== undefined) {
      const n = largestIslandNumber(state);
      if (n !== 0) {
        const pool = poolForIsland(state, n);
        if (legacyBacklog !== undefined) pool.flexBacklog = legacyBacklog;
        if (validBudget !== undefined) pool.callBudget = validBudget;
      }
    }
  }
  // Advance the RNG deterministically past the founding state so a loaded
  // game does not replay the exact random sequence from tick zero.
  state.rng.setState(save.seed ^ save.tick);
  // A reload lands mid-day whenever the saved tick is not a day boundary;
  // the morning's imported tours (if any) are gone, so today's localGoods
  // attempt is tainted (see the `goods` doc comment above).
  state.goods.partialDay = state.tick % TICKS_PER_DAY !== 0;
  if (save.trains) {
    state.trains = save.trains.map((t) => ({
      id: t.id,
      kind: t.kind as TrainKind,
      yard: t.yard,
      yardTrack: t.yardTrack,
      x: t.x,
      y: t.y,
      angle: t.angle,
      phase: t.phase as TrainPhase,
      stops: [...t.stops],
      pickup: t.pickup,
      path: [...t.path],
      pathIndex: t.pathIndex,
      dwellTicks: t.dwellTicks,
      stalled: false,
    }));
    for (const t of state.trains) state.nextVehicleId = Math.max(state.nextVehicleId, t.id + 1);
  }
  markAllDirty(state);
  return state;
}

/** Count population and jobs from the current building layers. */
export function countPopulationAndJobs(state: SimState): {
  population: number;
  /** All jobs, industrial ones included. */
  jobs: number;
  /** The industrial share of `jobs`: taxed at the trade rate. */
  industrialJobs: number;
} {
  const { zone, density, tileType } = state.layers;
  let population = 0;
  let jobs = 0;
  let industrialJobs = 0;
  for (let i = 0; i < zone.length; i++) {
    if (tileType[i] !== TileType.Empty) continue;
    const d = density[i];
    if (d === 0) continue;
    const z = zone[i] as Zone;
    if (z === Zone.Residential) {
      population += BALANCE.growth.populationByDensity[d];
    } else if (z === Zone.Commercial || z === Zone.Retail || z === Zone.Industrial) {
      const n = BALANCE.growth.jobsByZoneAndDensity[z][d];
      jobs += n;
      if (z === Zone.Industrial) industrialJobs += n;
    }
  }
  return { population, jobs, industrialJobs };
}

/** Buildings standing on zoned land (density > 0). */
export function countBuildings(state: SimState): number {
  const { density, tileType } = state.layers;
  let n = 0;
  for (let i = 0; i < density.length; i++) {
    if (tileType[i] === TileType.Empty && density[i] > 0) n++;
  }
  return n;
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

/**
 * Battery capacity counting only intact plants on a grid island
 * (`layers.island[i] !== 0`) — see `totalHeatCapacityOnIsland` for why
 * `buildStats` needs both filters.
 */
export function totalStorageCapacityOnIsland(state: SimState): number {
  const { tileType, plantType, damage, island } = state.layers;
  let count = 0;
  for (let i = 0; i < tileType.length; i++) {
    if (tileType[i] !== TileType.Plant || damage[i] !== 0 || island[i] === 0) continue;
    if (plantType[i] === PlantType.Battery) count++;
  }
  return count * BALANCE.energy.batteryCapacity;
}

/** Biogas output the city could dispatch per tick if every plant ran flat out. */
export function totalBiogasCapacity(state: SimState): number {
  return countPlants(state, PlantType.BiogasPlant) * BALANCE.energy.biogasMaxOutput;
}

/** Hydrogen tank capacity counting only intact plants on a grid island. */
export function totalHydrogenCapacityOnIsland(state: SimState): number {
  const { tileType, plantType, damage, island } = state.layers;
  let count = 0;
  for (let i = 0; i < tileType.length; i++) {
    if (tileType[i] !== TileType.Plant || damage[i] !== 0 || island[i] === 0) continue;
    if (plantType[i] === PlantType.HydrogenPlant) count++;
  }
  return count * BALANCE.hydrogen.capacity;
}

/**
 * Installed heat store capacity counting only intact plants on a grid
 * island (`layers.island[i] !== 0`). A heat store is not a supply source
 * (it cannot turn back into electricity), so one built with no line and
 * no building in reach stays on island 0 forever; and a damaged store is
 * skipped by `storageTilesOfKind`, so counting its capacity would halve
 * the SoC bar after a storm. Both filters keep the panel's SoC bars in
 * step with the energy history's SoC, which applies them too.
 */
export function totalHeatCapacityOnIsland(state: SimState): number {
  const { tileType, plantType, damage, island } = state.layers;
  let stores = 0;
  for (let i = 0; i < tileType.length; i++) {
    if (tileType[i] !== TileType.Plant || damage[i] !== 0 || island[i] === 0) continue;
    if (plantType[i] === PlantType.HeatStore) stores++;
  }
  return stores * BALANCE.heat.storeCapacity;
}

/** Pumped-storage capacity counting only intact plants on a grid island. */
export function totalPumpedStorageCapacityOnIsland(state: SimState): number {
  const { tileType, plantType, damage, island } = state.layers;
  let capacity = 0;
  for (let i = 0; i < tileType.length; i++) {
    if (tileType[i] !== TileType.Plant || plantType[i] !== PlantType.PumpedStorage) continue;
    if (damage[i] !== 0 || island[i] === 0) continue;
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
