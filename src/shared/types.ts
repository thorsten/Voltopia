/** Core enums and data shapes shared between simulation, rendering and UI. */

export const TileType = {
  Empty: 0,
  Road: 1,
  Plant: 2,
} as const;
export type TileType = (typeof TileType)[keyof typeof TileType];

/** Road class of a TileType.Road tile: avenues carry more cars, faster. */
export const RoadClass = { Street: 0, Avenue: 1 } as const;
export type RoadClass = (typeof RoadClass)[keyof typeof RoadClass];

/** Number of overlay/diff buckets the 0..255 load is quantised into. */
export const TRAFFIC_LEVELS = 8;

/** 0..TRAFFIC_LEVELS-1 bucket of a load value. */
export function trafficLevel(load: number): number {
  return Math.min(TRAFFIC_LEVELS - 1, Math.floor((load / 256) * TRAFFIC_LEVELS));
}

/** Immutable ground type per tile, generated once per map. */
export const Terrain = {
  Land: 0,
  River: 1,
  Lake: 2,
  Sea: 3,
} as const;
export type Terrain = (typeof Terrain)[keyof typeof Terrain];

export const Zone = {
  None: 0,
  Residential: 1,
  Commercial: 2,
  Retail: 3,
} as const;
export type Zone = (typeof Zone)[keyof typeof Zone];

export const PlantType = {
  None: 0,
  SolarFarm: 1,
  WindTurbine: 2,
  Battery: 3,
  BiogasPlant: 4,
  ChargingHub: 5,
  Park: 6,
  RunOfRiver: 7,
  PumpedStorage: 8,
  FireStation: 9,
  PoliceStation: 10,
  LogisticsDepot: 11,
  BusDepot: 12,
  HydrogenPlant: 13,
  TidalPlant: 14,
  GeothermalPlant: 15,
} as const;
export type PlantType = (typeof PlantType)[keyof typeof PlantType];

/** Delivery status of a retail building (TileDiff.deliveryState, overlay). */
export const DeliveryState = { Supplied: 0, Due: 1, Unsupplied: 2 } as const;
export type DeliveryState = (typeof DeliveryState)[keyof typeof DeliveryState];

/** deliveryAge saturates here (Uint16). */
export const MAX_DELIVERY_AGE = 65535;

/** Service status of a bus stop (TileDiff.stopState, overlay). */
export const StopState = { Served: 0, Due: 1, Unserved: 2 } as const;
export type StopState = (typeof StopState)[keyof typeof StopState];

/** stopAge saturates here (Uint16). */
export const MAX_STOP_AGE = 65535;

export const SupplyStatus = {
  NotConnected: 0,
  Undersupplied: 1,
  Supplied: 2,
} as const;
export type SupplyStatus = (typeof SupplyStatus)[keyof typeof SupplyStatus];

export type Speed = 0 | 1 | 3;

export const OverlayMode = {
  None: 0,
  Supply: 1,
  Demand: 2,
  Services: 3,
  Traffic: 4,
  Deliveries: 5,
  Transit: 6,
} as const;
export type OverlayMode = (typeof OverlayMode)[keyof typeof OverlayMode];

/** Which mesh renders a VehicleState. */
export const VehicleKind = { Car: 0, Van: 1, Bus: 2 } as const;
export type VehicleKind = (typeof VehicleKind)[keyof typeof VehicleKind];

export interface Weather {
  /** 0 = clear sky, 1 = fully overcast. Reduces photovoltaic generation. */
  cloudCover: number;
  /** 0 = calm, 1 = strongest wind. Drives wind turbine generation. */
  windSpeed: number;
  /** 0 = dry riverbed, 1 = river in full flow. Drives run-of-river output. */
  riverFlow: number;
  /** 0 = bare ground, 1 = full snow cover. Fed by sub-zero precipitation, melts into the river. */
  snowpack: number;
}

/** Tide at this tick: water level, current strength and direction. */
export interface TideState {
  /** Water level, -1 (low water) .. 1 (high water). */
  level: number;
  /** Current strength, 0..1 — tidal generation scales with this. */
  factor: number;
  /** True while the water is rising (flood), false while it falls (ebb). */
  rising: boolean;
}

/** Seasons in year order; the year starts with the first spring day. */
export const SEASON_ORDER = ['spring', 'summer', 'autumn', 'winter'] as const;
export type SeasonId = (typeof SEASON_ORDER)[number];

/** Deterministic seasonal signal for one tick (no random component). */
export interface SeasonState {
  /** 0..1 through the year, 0 = first spring day, continuous within a day. */
  phase: number;
  season: SeasonId;
  /** 1..daysPerSeason */
  dayOfSeason: number;
  /** 1-based year counter. */
  year: number;
  /** Air temperature in °C incl. diurnal cycle and cloud damping. */
  temperature: number;
  /** Sunrise/sunset as fractions of the day (season-dependent day length). */
  sunrise: number;
  sunset: number;
  /** 0..1 sun elevation factor: 1 at the longest day. */
  solarStrength: number;
  /** Added to the weather-front base means (winter: more cloud and wind). */
  cloudBias: number;
  windBias: number;
}

export interface EnergyHistoryPoint {
  /** Total generation in energy units per tick. */
  generation: number;
  /** Total consumption in energy units per tick. */
  consumption: number;
  /** Combined state of charge of batteries and pumped storage, 0..1. */
  stateOfCharge: number;
  /** Average spot price factor over the sample window. */
  price: number;
}

export interface EnergyStats {
  generation: {
    solar: number;
    wind: number;
    biogas: number;
    rooftop: number;
    hydro: number;
    /** Fuel-cell output re-electrified from stored hydrogen. */
    hydrogen: number;
    /** Tidal plant output this tick. */
    tidal: number;
    /** Geothermal baseload output this tick. */
    geothermal: number;
  };
  consumption: {
    buildings: number;
    charging: number;
    heating: number;
    cooling: number;
    /** Surplus electricity consumed by electrolysers (stored or sold). */
    electrolysis: number;
  };
  /** Absolute stored energy across all batteries. */
  storedEnergy: number;
  /** Total installed battery capacity. */
  storageCapacity: number;
  /** Energy stored in pumped storage plants (second pool). */
  pumpedStoredEnergy: number;
  /** Installed pumped storage capacity. */
  pumpedCapacity: number;
  /** Hydrogen stored across all hydrogen plants (third pool). */
  hydrogenStoredEnergy: number;
  /** Installed hydrogen tank capacity. */
  hydrogenCapacity: number;
  /** Hydrogen sold this tick because the tanks were full. */
  hydrogenSold: number;
  /** Spot price factor this tick (1 = the base link prices). */
  spotPrice: number;
  /** Stored energy sold into the link by market trading this tick. */
  tradeSell: number;
  /** Cheap energy bought into storage by market trading this tick. */
  tradeBuy: number;
  /** Dispatchable biogas output available per tick (0 without a plant). */
  biogasCapacity: number;
  /** Generation that had to be curtailed this tick (storage full, no demand). */
  curtailment: number;
  /** Consumption that could not be served this tick. */
  deficit: number;
  /** Energy bought from the transmission link this tick (expensive). */
  gridImport: number;
  /** Surplus sold to the transmission link this tick. */
  gridExport: number;
  /** Sampled history of the last in-game day, oldest first. */
  history: EnergyHistoryPoint[];
  /**
   * Running average of the sample currently being accumulated — what the
   * next `history` entry will be so far. Lets the graph draw its leading
   * edge up to "now" and have it land exactly on the next sample.
   */
  pending: EnergyHistoryPoint;
}

/** One per in-game day: averages/totals for the lifetime statistics. */
export interface LifetimeSample {
  day: number;
  population: number;
  jobs: number;
  /** 0..1 */
  happiness: number;
  /** Average energy generation per tick over the day. */
  avgGeneration: number;
  /** Average consumption per tick over the day. */
  avgConsumption: number;
  money: number;
  /** Daily mean air temperature in °C (absent in samples from before seasons). */
  temperature?: number;
  /** Average heating consumption per tick over the day (absent in older samples). */
  heating?: number;
  /** Average cooling consumption per tick over the day (absent in older samples). */
  cooling?: number;
}

export interface GoalState {
  id: string;
  achieved: boolean;
}

/** Rough tile counts for the HUD and the tutorial. */
export interface TileCounts {
  roadTiles: number;
  avenueTiles: number;
  zonedTiles: number;
  plantTiles: number;
  buildingTiles: number;
  powerLineTiles: number;
  /** Logistics depots only; bus depots are tracked separately in TransitStats. */
  depots: number;
}

export interface DemandStats {
  residential: number;
  commercial: number;
  retail: number;
}

/**
 * Per-tick city budget, broken down for the budget panel.
 * All values are money per tick (multiply by TICKS_PER_DAY for a day).
 */
export interface BudgetStats {
  taxIncome: number;
  gridExportRevenue: number;
  /** Revenue from hydrogen sold while the tanks were full. */
  hydrogenRevenue: number;
  gridUpkeep: number;
  /** Total plant upkeep (sum over plantUpkeepByType). */
  plantUpkeep: number;
  /** Upkeep per plant type, indexed by PlantType. */
  plantUpkeepByType: Record<PlantType, number>;
  /** Plants placed per type, indexed by PlantType. */
  plantCountByType: Record<PlantType, number>;
  roadTiles: number;
  avenueTiles: number;
  avenueUpkeep: number;
  /** Bus stops on the roads. */
  busStops: number;
  /** Upkeep of the bus stops (part of gridUpkeep). */
  busStopUpkeep: number;
  biogasFuelCost: number;
  gridImportCost: number;
  /** Income - expenses for this tick. */
  net: number;
}

/** Why a zoned tile is not growing right now. */
export type GrowthBlocker =
  | 'noRoad'
  | 'lowDemand'
  | 'notConnected'
  | 'undersupplied'
  | 'tooYoung'
  | 'maxDensity'
  | 'cityUnhappy'
  | 'notLand'
  | 'noFireCoverage'
  | 'noDeliveries';

/** Fleet figures of one logistics depot (inspector). */
export interface DepotInfo {
  vansTotal: number;
  vansDriving: number;
  vansCharging: number;
  /** Retail buildings a tour from this depot can reach. */
  shopsInReach: number;
}

/** City-wide delivery figures. */
export interface DeliveryStats {
  /** Supplied shops over all shops, 0..1 (1 when there are none). */
  suppliedShare: number;
  /** Retail buildings. */
  shops: number;
  /** Vans on the road. */
  driving: number;
  depots: number;
}

/** Fleet figures of one bus depot (inspector). */
export interface BusDepotInfo {
  busesTotal: number;
  busesDriving: number;
  busesCharging: number;
  /** Bus stops a tour from this depot can reach. */
  stopsInReach: number;
}

/** City-wide public transit figures. */
export interface TransitStats {
  /** Riders over commuters with a workplace, 0..1 (0 when there are none). */
  riderShare: number;
  riders: number;
  /** Buses on the road. */
  driving: number;
  stops: number;
  stopsServed: number;
  depots: number;
}

/**
 * Everything the tile inspector shows for the selected tile.
 * Recomputed every tick while a tile is selected.
 */
export interface TileInfo {
  index: number;
  x: number;
  y: number;
  tileType: TileType;
  terrain: Terrain;
  zone: Zone;
  density: number;
  plantType: PlantType;
  supplied: SupplyStatus;
  /**
   * Reached by the power network (lines or a plant ring); for a supply
   * plant, whether a power line is attached to it.
   */
  connected: boolean;
  /**
   * Radius in tiles of the ring this tile projects on the map: the supply
   * ring of a plant or an energised power line, a park's happiness ring,
   * a hub's service ring. 0 when the tile projects nothing.
   */
  ringRadius: number;
  /** Money upkeep of this tile per tick (roads and plants only). */
  upkeepPerTick: number;
  /** Fuel cost per tick attributed to this tile (biogas only). */
  fuelCostPerTick: number;
  /** Tax this tile contributes per tick at the current rate. */
  taxPerTick: number;
  /** Energy consumed by the building on this tile, this tick. */
  consumption: number;
  /** Consumption at load factor 1 (the tile's peak load). */
  peakConsumption: number;
  /** Current hourly load profile factor, 0..1-ish. */
  loadFactor: number;
  /** Energy generated by this tile this tick (plants + rooftop PV). */
  generation: number;
  /** Nameplate generation of this tile at ideal conditions. */
  peakGeneration: number;
  /** Storage pools: this tile's share of stored energy / capacity. */
  storedEnergy: number;
  storageCapacity: number;
  population: number;
  jobs: number;
  /** Demand for this tile's zone, -1..1. */
  demand: number;
  /** Ticks since the building last changed. */
  buildingAge: number;
  /** Consecutive ticks without full supply (decay counter). */
  troubledTicks: number;
  /** Building inside a powered fire station's ring. */
  fireCovered: boolean;
  /** Building inside a powered police station's ring. */
  policeCovered: boolean;
  /** For fire/police stations: connected to the grid and covering its ring. */
  stationActive: boolean;
  /** Road class of a road tile (Street for everything else). */
  roadClass: RoadClass;
  /** Smoothed traffic load 0..255 (0 off-road). */
  trafficLoad: number;
  /** Cars per lane this tile holds (0 off-road). */
  laneCapacity: number;
  /** Delivery bucket of a retail building (Supplied elsewhere). */
  deliveryState: DeliveryState;
  /** Ticks since the last delivery (0 off retail). */
  deliveryAgeTicks: number;
  /** Fleet figures when this tile is a logistics depot. */
  depot: DepotInfo | null;
  /** A bus stop is marked on this road tile. */
  busStop: boolean;
  /** Service status of the stop (Served when there is none). */
  stopState: StopState;
  /** Ticks since a bus last halted here (0 without a stop). */
  stopAgeTicks: number;
  /** Road tile within reach of a served bus stop. */
  transitCovered: boolean;
  /** Fleet of a bus depot tile, null elsewhere. */
  busDepot: BusDepotInfo | null;
  growthBlockers: GrowthBlocker[];
  /** Elevation level 0..7 of this tile. */
  elevation: number;
  /** Largest level difference to a neighbour (>= 2 is unbuildable). */
  slope: number;
  /** Forest growth stage on this tile: 0 = none, 1..maxStage. */
  forest: number;
  /** Terrain bonus factor on this tile's plant output/capacity (1 = none). */
  terrainBonus: number;
}

export interface GlobalStats {
  /** World seed (identifies the city, e.g. for per-city UI flags). */
  seed: number;
  tick: number;
  money: number;
  population: number;
  jobs: number;
  /** 0..1 average citizen happiness. */
  happiness: number;
  /** Demand per zone type, -1..1 (positive = zone wants to grow). */
  demand: DemandStats;
  /** 0..1, 0 = midnight, 0.5 = noon. */
  timeOfDay: number;
  /** Day counter since city founding. */
  day: number;
  weather: Weather;
  season: SeasonState;
  energy: EnergyStats;
  /** Current tax rate, 0..MAX_TAX_RATE. */
  taxRate: number;
  speed: Speed;
  /** Whether smart charging (charging follows surplus) is enabled. */
  smartCharging: boolean;
  /** Whether storage trades on the spot market (sell dear, buy cheap). */
  marketTrading: boolean;
  /** Whether the building insulation upgrade has been bought. */
  insulation: boolean;
  /** Share of buildings with fire / police coverage, 0..1. */
  services: { fire: number; police: number };
  /** Share of the land that is wooded, weighted by growth stage (0..1). */
  forestShare: number;
  /** Tide at this tick: water level, current strength and direction. */
  tide: TideState;
  /** Commute health: mean commute time over free flow, cars on the road, avenue share of roads. */
  traffic: {
    congestion: number;
    driving: number;
    avenueShare: number;
  };
  /** City-wide delivery figures. */
  deliveries: DeliveryStats;
  /** City-wide public transit figures. */
  transit: TransitStats;
  goals: GoalState[];
  counts: TileCounts;
  /** Per-tick budget breakdown for the budget panel. */
  budget: BudgetStats;
  /** Details of the inspected tile, null when none selected. */
  inspected: TileInfo | null;
}

/** Service coverage bits for `TileDiff.services` / `GlobalStats.services`. */
export const SERVICE_FIRE = 1;
export const SERVICE_POLICE = 2;

/** Per-tile fields the renderer needs; sent as diffs for changed tiles only. */
export interface TileDiff {
  index: number;
  tileType: TileType;
  /** 4-bit connection mask for roads (N=1, E=2, S=4, W=8). */
  roadMask: number;
  /** RoadClass of a road tile (0 elsewhere). */
  roadClass: number;
  /** Smoothed traffic load 0..255 of a road tile (0 elsewhere). */
  trafficLoad: number;
  /** Power line mask: 0 = none, else LINE_PRESENT | connection bits (N=1, E=2, S=4, W=8). */
  powerLine: number;
  zone: Zone;
  /** 0 = no building, 1..3 = density level. */
  density: number;
  /** Seeded per-tile variation for procedural building shapes. */
  variant: number;
  supplied: SupplyStatus;
  /** Service coverage bitmask: 1 = fire, 2 = police. */
  services: number;
  plantType: PlantType;
  terrain: Terrain;
  /** Elevation level 0..7 (immutable after map generation). */
  elevation: number;
  /** Forest growth stage on this tile: 0 = none, 1..maxStage. */
  forest: number;
  /** Geothermal hotspot quality on this tile: 0 = none, 1..3. */
  geothermal: number;
  /** Quantised reservoir temperature 0..255 of this tile's field (0 off a hotspot). */
  reservoirHeat: number;
  /** DeliveryState of a retail building (0 elsewhere). */
  deliveryState: number;
  /** 1 when a bus stop is marked on this road tile. */
  busStop: number;
  /** StopState of a bus stop (0 elsewhere). */
  stopState: number;
  /** 1 when this road tile is covered by a served bus stop. */
  transitCover: number;
}

/** Position and heading of one vehicle, interpolated by the renderer. */
export interface VehicleState {
  /** Stable id so the renderer can track vehicles across updates. */
  id: number;
  /** Tile-space continuous position. */
  x: number;
  y: number;
  /** Heading angle in radians (0 = +x). */
  angle: number;
  /** Which mesh draws it. */
  kind: VehicleKind;
}

export interface SaveGame {
  version: number;
  seed: number;
  size: number;
  tick: number;
  money: number;
  taxRate: number;
  smartCharging: boolean;
  storedEnergy: number;
  /** Achieved goal ids (absent in older saves). */
  goals?: string[];
  /** Daily lifetime statistics (absent in older saves). */
  lifetime?: LifetimeSample[];
  /** River flow 0..1 (absent in older saves → dry baseline). */
  riverFlow?: number;
  /** Energy stored in pumped storage plants (absent in older saves). */
  pumpedStorageEnergy?: number;
  /** Hydrogen stored in hydrogen plants (absent in older saves). */
  hydrogenEnergy?: number;
  /** Whether storage trades on the spot market (absent in older saves). */
  marketTrading?: boolean;
  /** Day number on which year 1 started (absent in older saves → the save's current day). */
  seasonOriginDay?: number;
  /** Snow cover 0..1 (absent in older saves → 0). */
  snowpack?: number;
  /** Building insulation bought (absent in older saves → false). */
  insulation?: boolean;
  /** Consecutive deficit-free winter ticks so far (absent in older saves → 0). */
  winterTicks?: number;
  /** Consecutive deficit-free summer ticks so far (absent in older saves → 0). */
  summerTicks?: number;
  /** Consecutive flowing-commute ticks so far (absent in older saves → 0). */
  freeFlowTicks?: number;
  /** Consecutive well-stocked ticks so far (absent in older saves → 0). */
  wellStockedTicks?: number;
  /** Consecutive modal-shift ticks so far (absent in older saves → 0). */
  transitTicks?: number;
  /** Raw copies of the tile layers. */
  layers: {
    tileType: ArrayBuffer;
    roadMask: ArrayBuffer;
    zone: ArrayBuffer;
    density: ArrayBuffer;
    variant: ArrayBuffer;
    supplied: ArrayBuffer;
    plantType: ArrayBuffer;
    /** Terrain layer; absent in older saves (all land). */
    terrain?: ArrayBuffer;
    /** Power line layer; absent in saves from before power lines. */
    powerLine?: ArrayBuffer;
    /** Elevation layer; absent in older saves (flat map). */
    elevation?: ArrayBuffer;
    /** Road class layer; absent in older saves (all streets). */
    roadClass?: ArrayBuffer;
    /** Bus stop layer; absent in saves from before transit. */
    busStop?: ArrayBuffer;
    /** Forest layer; absent in saves from before woods (treeless map). */
    forest?: ArrayBuffer;
    /** Geothermal hotspot layer; absent in saves from before geothermal power. */
    geothermal?: ArrayBuffer;
    /** Quantised reservoir heat layer; absent in saves from before geothermal power. */
    reservoirHeat?: ArrayBuffer;
  };
}
