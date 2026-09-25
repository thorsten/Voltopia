/**
 * Agent tools: a machine-facing API over the running game. Each tool has
 * a name, a description and a JSON schema (WebMCP / MCP conventions) plus
 * an `execute` that returns plain JSON. Registration with the browser's
 * `modelContext` and the `window.voltopia` fallback live in webmcp.ts;
 * this module has no DOM dependency so it can be tested against a
 * headless engine.
 */
import { BALANCE, GRID_SIZE, TICKS_PER_DAY } from '../shared/constants.ts';
import { lShapedPath, neighbors4, rectTiles, tileIndex, tileX, tileY } from '../shared/grid.ts';
import type { SimCommand } from '../shared/messages.ts';
import {
  PlantType,
  StopState,
  SupplyStatus,
  Terrain,
  TileType,
  Zone,
  type GlobalStats,
  type LifetimeSample,
  type Speed,
  type TileInfo,
} from '../shared/types.ts';
import { englishText, rejectionKey, type TranslationKey } from '../ui/i18n.tsx';
import type { TileMirror } from './tileMirror.ts';

/** Outcome of a command once the worker has applied it. */
export interface CommandOutcome {
  /** Rejection code (see i18n `rejection.*`), absent when accepted. */
  rejected?: string;
}

export interface NewCityOptions {
  size: number;
  startingMoney: number;
  seed: number | null;
}

/** What the tools need from the host (bridge in the app, engine in tests). */
export interface AgentContext {
  tiles: TileMirror;
  getStats(): GlobalStats | null;
  sendCommand(command: SimCommand): Promise<CommandOutcome>;
  /** Resolves with the stats of the first tick at or after `targetTick`. */
  waitForTick(targetTick: number, signal?: AbortSignal): Promise<GlobalStats>;
  requestLifetime(): Promise<LifetimeSample[]>;
  /** Start a brand-new city (the app reloads the page). */
  startNewCity(options: NewCityOptions): void;
}

/** JSON-schema-ish input description; kept loose on purpose. */
export type JsonSchema = Record<string, unknown>;

export interface AgentTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: {
    readOnlyHint?: boolean;
    consequentialHint?: boolean;
  };
  execute(input: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>;
}

/** Thrown by tools on bad input; surfaced to the agent as `{ ok: false }`. */
export class ToolInputError extends Error {}

// ---------------------------------------------------------------------------
// Names shared with agents (stable, lower-case words).

export const ZONE_NAMES = {
  residential: Zone.Residential,
  commercial: Zone.Commercial,
  retail: Zone.Retail,
} as const;
export type ZoneName = keyof typeof ZONE_NAMES;

export const PLANT_NAMES = {
  solar: PlantType.SolarFarm,
  wind: PlantType.WindTurbine,
  battery: PlantType.Battery,
  biogas: PlantType.BiogasPlant,
  charging_hub: PlantType.ChargingHub,
  park: PlantType.Park,
  run_of_river: PlantType.RunOfRiver,
  pumped_storage: PlantType.PumpedStorage,
  hydrogen: PlantType.HydrogenPlant,
  tidal: PlantType.TidalPlant,
  geothermal: PlantType.GeothermalPlant,
  logistics_depot: PlantType.LogisticsDepot,
  bus_depot: PlantType.BusDepot,
} as const;
export type PlantName = keyof typeof PLANT_NAMES;

const PLANT_NAME_BY_TYPE = new Map<PlantType, PlantName | 'none'>([
  [PlantType.None, 'none'],
  ...(Object.entries(PLANT_NAMES) as [PlantName, PlantType][]).map(
    ([name, type]) => [type, name] as [PlantType, PlantName],
  ),
]);
const ZONE_NAME_BY_TYPE = new Map<Zone, ZoneName | 'none'>([
  [Zone.None, 'none'],
  ...(Object.entries(ZONE_NAMES) as [ZoneName, Zone][]).map(
    ([name, zone]) => [zone, name] as [Zone, ZoneName],
  ),
]);
const TERRAIN_NAME: Record<Terrain, string> = {
  [Terrain.Land]: 'land',
  [Terrain.River]: 'river',
  [Terrain.Lake]: 'lake',
  [Terrain.Sea]: 'sea',
};
const TILE_TYPE_NAME: Record<TileType, string> = {
  [TileType.Empty]: 'empty',
  [TileType.Road]: 'road',
  [TileType.Plant]: 'plant',
};
const SUPPLY_NAME: Record<SupplyStatus, string> = {
  [SupplyStatus.NotConnected]: 'not_connected',
  [SupplyStatus.Undersupplied]: 'undersupplied',
  [SupplyStatus.Supplied]: 'supplied',
};
const STOP_STATE_NAME: Record<StopState, string> = {
  [StopState.Served]: 'served',
  [StopState.Due]: 'due',
  [StopState.Unserved]: 'unserved',
};

const PLANT_TOOL_KEY: Record<PlantName, TranslationKey> = {
  solar: 'tool.plant-solar',
  wind: 'tool.plant-wind',
  battery: 'tool.plant-battery',
  biogas: 'tool.plant-biogas',
  charging_hub: 'tool.plant-hub',
  park: 'tool.plant-park',
  run_of_river: 'tool.plant-hydro',
  pumped_storage: 'tool.plant-pumped',
  hydrogen: 'tool.plant-hydrogen',
  tidal: 'tool.plant-tidal',
  geothermal: 'tool.plant-geothermal',
  logistics_depot: 'tool.plant-depot',
  bus_depot: 'tool.plant-busdepot',
};

const PLANT_PLACEMENT: Record<PlantName, string> = {
  solar: 'any empty land tile',
  wind: 'any empty land tile',
  battery: 'any empty land tile',
  biogas: 'any empty land tile',
  charging_hub: 'any empty land tile; serves EVs within its radius',
  park: 'any empty land tile; raises happiness of buildings within its radius',
  run_of_river: 'an empty river tile',
  pumped_storage: 'an empty land tile with a lake tile as direct (4-)neighbour',
  hydrogen:
    'any empty land tile; electrolyses surplus beyond the export link, re-electrifies in a lull, sells overflow',
  tidal:
    'an empty sea tile touching land; output follows the tide and rises in narrow water and at the river mouth',
  geothermal:
    'an empty land tile carrying a geothermal hotspot; constant output, but a field only sustains so many wells before its reservoir cools',
  logistics_depot:
    'an empty land tile with a road as direct (4-)neighbour; vans serve shops within route reach',
  bus_depot:
    'an empty land tile with a road as direct (4-)neighbour; buses serve bus stops within route reach',
};

export const MAP_LAYERS = ['overview', 'terrain', 'supply', 'density', 'power', 'transit'] as const;
export type MapLayer = (typeof MAP_LAYERS)[number];

export const FIND_KINDS = [
  'empty_land',
  'river',
  'lake_shore',
  'coastal_sea',
  'geothermal_hotspot',
  'road',
  'power_line',
  'plant',
  'zoned_empty',
  'building',
  'not_connected_building',
  'undersupplied_building',
  'bus_stop',
] as const;
export type FindKind = (typeof FIND_KINDS)[number];

/** Longest fast-forward a single `advance_time` call may run. */
export const MAX_ADVANCE_DAYS = 3;

// ---------------------------------------------------------------------------
// Input helpers.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readInt(input: Record<string, unknown>, key: string, fallback?: number): number {
  const value = input[key];
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ToolInputError(`"${key}" must be an integer`);
  }
  return value;
}

function readPoint(
  input: Record<string, unknown>,
  key: string,
  tiles: TileMirror,
): { x: number; y: number } {
  const value = input[key];
  if (!isRecord(value)) throw new ToolInputError(`"${key}" must be an object { x, y }`);
  const x = readInt(value, 'x');
  const y = readInt(value, 'y');
  if (!tiles.inBounds(x, y)) {
    throw new ToolInputError(
      `"${key}" (${x}, ${y}) is outside the ${tiles.size}×${tiles.size} grid`,
    );
  }
  return { x, y };
}

function readEnum<T extends string>(
  input: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  fallback?: T,
): T {
  const value = input[key];
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ToolInputError(`"${key}" must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

/** Tiles of an L-shaped path from→to, or the explicit `tiles` list. */
function readPathTiles(input: Record<string, unknown>, tiles: TileMirror): number[] {
  if (Array.isArray(input.tiles)) {
    return input.tiles.map((point, i) => {
      if (!isRecord(point)) throw new ToolInputError(`"tiles[${i}]" must be { x, y }`);
      const { x, y } = readPoint({ p: point }, 'p', tiles);
      return tileIndex(x, y, tiles.size);
    });
  }
  const from = readPoint(input, 'from', tiles);
  const to = 'to' in input ? readPoint(input, 'to', tiles) : from;
  return lShapedPath(from.x, from.y, to.x, to.y, tiles.size);
}

function readRectTiles(input: Record<string, unknown>, tiles: TileMirror): number[] {
  const from = readPoint(input, 'from', tiles);
  const to = 'to' in input ? readPoint(input, 'to', tiles) : from;
  return rectTiles(from.x, from.y, to.x, to.y, tiles.size);
}

const POINT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    x: { type: 'integer', description: '0-based column, 0 = west edge' },
    y: { type: 'integer', description: '0-based row, 0 = north edge' },
  },
  required: ['x', 'y'],
};

const PATH_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    from: {
      ...POINT_SCHEMA,
      description: 'Start tile of an L-shaped path (horizontal leg first).',
    },
    to: { ...POINT_SCHEMA, description: 'End tile; omit for a single tile.' },
    tiles: {
      type: 'array',
      items: POINT_SCHEMA,
      description: 'Explicit tile list instead of from/to (any shape).',
    },
  },
};

const RECT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    from: { ...POINT_SCHEMA, description: 'One corner of the rectangle.' },
    to: { ...POINT_SCHEMA, description: 'Opposite corner; omit for a single tile.' },
  },
  required: ['from'],
};

// ---------------------------------------------------------------------------
// Result helpers.

function round(value: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function rejectionMessage(code: string): string {
  const key = rejectionKey(code);
  return key ? englishText(key) : code;
}

function outcomeResult(outcome: CommandOutcome, extra: Record<string, unknown> = {}): unknown {
  if (outcome.rejected) {
    return { ok: false, error: outcome.rejected, message: rejectionMessage(outcome.rejected) };
  }
  return { ok: true, ...extra };
}

function requireStats(ctx: AgentContext): GlobalStats {
  const stats = ctx.getStats();
  if (!stats) throw new ToolInputError('The simulation has not produced stats yet — retry shortly');
  return stats;
}

function describeTile(ctx: AgentContext, index: number): Record<string, unknown> {
  const { tiles } = ctx;
  const t = tiles.at(tileX(index, tiles.size), tileY(index, tiles.size));
  return {
    x: t.x,
    y: t.y,
    terrain: TERRAIN_NAME[t.terrain],
    tileType: TILE_TYPE_NAME[t.tileType],
    zone: ZONE_NAME_BY_TYPE.get(t.zone) ?? 'none',
    density: t.density,
    plant: PLANT_NAME_BY_TYPE.get(t.plantType) ?? 'none',
    hasRoad: t.tileType === TileType.Road,
    hasPowerLine: t.powerLine !== 0,
    supply: SUPPLY_NAME[t.supplied],
  };
}

function isLakeShore(tiles: TileMirror, index: number): boolean {
  return neighbors4(index, tiles.size).some((n) => tiles.terrain[n] === Terrain.Lake);
}

/** True on a sea tile that touches land — where a tidal plant may stand. */
function isCoastalSeaTile(tiles: TileMirror, index: number): boolean {
  if (tiles.terrain[index] !== Terrain.Sea) return false;
  return neighbors4(index, tiles.size).some((n) => tiles.terrain[n] === Terrain.Land);
}

/** True on a tile that carries a geothermal hotspot. */
function isHotspotTile(tiles: TileMirror, index: number): boolean {
  return tiles.geothermal[index] !== 0;
}

function overviewGlyph(tiles: TileMirror, i: number): string {
  const terrain = tiles.terrain[i];
  if (tiles.tileType[i] === TileType.Road) return tiles.busStop[i] !== 0 ? 'o' : '+';
  if (tiles.tileType[i] === TileType.Plant) {
    const glyph: Record<PlantName, string> = {
      solar: 'V',
      wind: 'W',
      battery: 'B',
      biogas: 'G',
      charging_hub: 'H',
      park: 'P',
      run_of_river: 'F',
      pumped_storage: 'U',
      hydrogen: 'Y',
      logistics_depot: 'D',
      bus_depot: 'T',
      tidal: 'X',
      geothermal: 'E',
    };
    const name = PLANT_NAME_BY_TYPE.get(tiles.plantType[i] as PlantType);
    return name && name !== 'none' ? glyph[name] : '?';
  }
  if (terrain === Terrain.River) return '~';
  if (terrain === Terrain.Lake) return '#';
  if (terrain === Terrain.Sea) return '%';
  if (tiles.powerLine[i] !== 0 && tiles.zone[i] === Zone.None) return '=';
  const zone = tiles.zone[i];
  const built = tiles.density[i] > 0;
  if (zone === Zone.Residential) return built ? 'R' : 'r';
  if (zone === Zone.Commercial) return built ? 'C' : 'c';
  if (zone === Zone.Retail) return built ? 'S' : 's';
  return '.';
}

const OVERVIEW_LEGEND =
  '. empty land, ~ river, # lake, % sea, + road (or bridge), o road with a bus stop, ' +
  '= power line on empty land, ' +
  'r/c/s zoned but unbuilt (residential/commercial/retail), R/C/S building, ' +
  'plants: V solar, W wind, B battery, G biogas, H charging hub, P park, ' +
  'F run-of-river, U pumped storage, X tidal, E geothermal, D logistics depot, T bus depot. ' +
  'Roads may also carry a power line (see the power layer).';

function layerGlyph(tiles: TileMirror, i: number, layer: MapLayer): string {
  const terrain = tiles.terrain[i];
  switch (layer) {
    case 'overview':
      return overviewGlyph(tiles, i);
    case 'terrain':
      if (tiles.geothermal[i] !== 0) return '^';
      return terrain === Terrain.River
        ? '~'
        : terrain === Terrain.Lake
          ? '#'
          : terrain === Terrain.Sea
            ? '%'
            : '.';
    case 'supply': {
      if (terrain === Terrain.River) return '~';
      if (terrain === Terrain.Lake) return '#';
      if (terrain === Terrain.Sea) return '%';
      if (tiles.density[i] === 0) return '.';
      return String(tiles.supplied[i]);
    }
    case 'density': {
      if (terrain === Terrain.River) return '~';
      if (terrain === Terrain.Lake) return '#';
      if (terrain === Terrain.Sea) return '%';
      return tiles.density[i] > 0 ? String(tiles.density[i]) : '.';
    }
    case 'power': {
      if (tiles.tileType[i] === TileType.Plant) return 'P';
      if (tiles.powerLine[i] !== 0) return '=';
      if (tiles.tileType[i] === TileType.Road) return '+';
      if (terrain === Terrain.River) return '~';
      if (terrain === Terrain.Lake) return '#';
      if (terrain === Terrain.Sea) return '%';
      return '.';
    }
    case 'transit': {
      if (tiles.tileType[i] === TileType.Plant) {
        return tiles.plantType[i] === PlantType.BusDepot ? 'T' : 'P';
      }
      if (tiles.tileType[i] === TileType.Road) {
        if (tiles.busStop[i] !== 0) {
          return tiles.stopState[i] === StopState.Served
            ? 'o'
            : tiles.stopState[i] === StopState.Due
              ? 'd'
              : 'x';
        }
        return tiles.transitCover[i] !== 0 ? '+' : '-';
      }
      if (terrain === Terrain.River) return '~';
      if (terrain === Terrain.Lake) return '#';
      if (terrain === Terrain.Sea) return '%';
      return '.';
    }
  }
}

const LAYER_LEGEND: Record<MapLayer, string> = {
  overview: OVERVIEW_LEGEND,
  terrain: '. land, ~ river, # lake, % sea, ^ land with a geothermal hotspot',
  supply:
    '. no building, 0 building not connected to any plant, 1 building undersupplied, ' +
    '2 building fully supplied, ~ river, # lake, % sea',
  density: '. no building, 1-3 building density level, ~ river, # lake, % sea',
  power:
    '. nothing, = power line (over land, road or water), + road without line, P plant, ~ river, # lake, % sea',
  transit:
    'o served bus stop, d stop due for a bus, x unserved stop, + road covered by a served stop, ' +
    '- road not covered, T bus depot, P other plant, ~ river, # lake, % sea, . other',
};

// ---------------------------------------------------------------------------

/** Build the tool list bound to a context. */
export function createAgentTools(ctx: AgentContext): AgentTool[] {
  const { tiles } = ctx;
  const size = tiles.size;

  const tools: AgentTool[] = [
    {
      name: 'get_game_overview',
      description:
        'Current state of the city: funds, population, jobs, happiness, zone demand, clock and ' +
        'season, weather, energy balance summary, budget per tick, tax rate, upgrades, goals, ' +
        'tile counts and grid size. Call this first and after every advance_time.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      async execute() {
        const s = requireStats(ctx);
        const e = s.energy;
        return {
          gridSize: size,
          seed: s.seed,
          tick: s.tick,
          day: s.day,
          timeOfDay: round(s.timeOfDay, 3),
          hour: round(s.timeOfDay * 24, 1),
          speed: s.speed,
          money: Math.round(s.money),
          population: s.population,
          jobs: s.jobs,
          happiness: round(s.happiness, 2),
          demand: {
            residential: round(s.demand.residential, 2),
            commercial: round(s.demand.commercial, 2),
            retail: round(s.demand.retail, 2),
          },
          season: {
            season: s.season.season,
            dayOfSeason: s.season.dayOfSeason,
            daysPerSeason: BALANCE.seasons.daysPerSeason,
            year: s.season.year,
            temperatureC: round(s.season.temperature),
            solarStrength: round(s.season.solarStrength, 2),
          },
          weather: {
            cloudCover: round(s.weather.cloudCover, 2),
            windSpeed: round(s.weather.windSpeed, 2),
            riverFlow: round(s.weather.riverFlow, 2),
            snowpack: round(s.weather.snowpack, 2),
          },
          tide: {
            level: round(s.tide.level, 2),
            factor: round(s.tide.factor, 2),
            rising: s.tide.rising,
          },
          energyPerTick: {
            generation: {
              solar: round(e.generation.solar),
              wind: round(e.generation.wind),
              hydro: round(e.generation.hydro),
              biogas: round(e.generation.biogas),
              rooftop: round(e.generation.rooftop),
              fuelCell: round(e.generation.hydrogen),
            },
            consumption: {
              buildings: round(e.consumption.buildings),
              charging: round(e.consumption.charging),
              heating: round(e.consumption.heating),
              electrolysis: round(e.consumption.electrolysis),
            },
            deficit: round(e.deficit),
            curtailment: round(e.curtailment),
            gridImport: round(e.gridImport),
            gridExport: round(e.gridExport),
            spotPrice: round(e.spotPrice, 3),
            tradeSell: round(e.tradeSell),
            tradeBuy: round(e.tradeBuy),
            batteries: { stored: Math.round(e.storedEnergy), capacity: e.storageCapacity },
            pumpedStorage: { stored: Math.round(e.pumpedStoredEnergy), capacity: e.pumpedCapacity },
            hydrogen: {
              stored: Math.round(e.hydrogenStoredEnergy),
              capacity: e.hydrogenCapacity,
              soldPerTick: round(e.hydrogenSold),
            },
            biogasCapacity: e.biogasCapacity,
          },
          budgetPerTick: {
            taxIncome: round(s.budget.taxIncome, 3),
            gridUpkeep: round(s.budget.gridUpkeep, 3),
            plantUpkeep: round(s.budget.plantUpkeep, 3),
            biogasFuelCost: round(s.budget.biogasFuelCost, 3),
            gridImportCost: round(s.budget.gridImportCost, 3),
            gridExportRevenue: round(s.budget.gridExportRevenue, 3),
            hydrogenRevenue: round(s.budget.hydrogenRevenue, 3),
            net: round(s.budget.net, 3),
            ticksPerDay: TICKS_PER_DAY,
          },
          deliveries: {
            suppliedShare: round(s.deliveries.suppliedShare, 2),
            shops: s.deliveries.shops,
            vansDriving: s.deliveries.driving,
            depots: s.deliveries.depots,
          },
          transit: {
            riderShare: round(s.transit.riderShare, 2),
            riders: s.transit.riders,
            busesDriving: s.transit.driving,
            stops: s.transit.stops,
            stopsServed: s.transit.stopsServed,
            depots: s.transit.depots,
          },
          taxRate: s.taxRate,
          maxTaxRate: BALANCE.tax.maxRate,
          smartCharging: s.smartCharging,
          marketTrading: s.marketTrading,
          forestShare: round(s.forestShare, 3),
          insulation: s.insulation,
          goals: s.goals.map((goal) => ({
            id: goal.id,
            achieved: goal.achieved,
            title: englishText(`goal.${goal.id}.title` as TranslationKey),
            description: englishText(`goal.${goal.id}.body` as TranslationKey),
          })),
          counts: s.counts,
        };
      },
    },
    {
      name: 'get_build_catalog',
      description:
        'Static rules of the game: what can be built, what it costs (money), upkeep per tick, ' +
        'placement rules, the power-line supply radius and how the grid works. Read once.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      async execute() {
        const costs = BALANCE.costs;
        return {
          coordinates: 'Tiles are { x, y }, 0-based, x grows east, y grows south.',
          gridSize: size,
          ticksPerDay: TICKS_PER_DAY,
          rules: [
            'Roads connect the city; buildings only appear on zoned tiles next to a road.',
            'Zones (residential, commercial, retail) grow on their own when demand is positive ' +
              'and the tile is fully supplied with energy; buildings densify up to level 3.',
            `Plants supply only what power lines connect to them. Every energised line tile and every ` +
              `supply plant connects buildings within ${BALANCE.energy.lineSupplyRadius} tiles ` +
              '(chessboard distance). Lines run over empty land, roads and water, not over buildings or plants.',
            'A line that does not touch a supply plant carries nothing.',
            'Solar follows sun and cloud, wind follows wind speed, run-of-river follows river flow. ' +
              'Batteries store surplus; biogas is dispatchable but burns fuel that costs money.',
            'Deficits discharge storage, then dispatch biogas, then import from the expensive grid; ' +
              'beyond that buildings go dark, happiness drops and growth stops.',
            'Winter (short days, cold) adds an electric heating load; insulation halves it.',
            'Home EV charging peaks in the evening; charging hubs shift it to midday.',
            'Roads across the river are bridges (pricier); lines across water are crossings (pricier).',
            'Bus stops marked on roads plus a bus depot put electric buses on the roads; a commuter ' +
              `with a served stop within ${BALANCE.transit.stopRadius} tiles of home and of work ` +
              'leaves the car at home.',
          ],
          costs: {
            roadPerTile: costs.roadPerTile,
            bridgePerTile: costs.bridgePerTile,
            powerLinePerTile: costs.powerLinePerTile,
            powerLineWaterPerTile: costs.powerLineWaterPerTile,
            zonePerTile: costs.zonePerTile,
            insulation: costs.insulation,
            busStop: costs.busStop,
          },
          upkeepPerTick: {
            roadPerTile: BALANCE.upkeepPerTick.roadPerTile,
            powerLinePerTile: BALANCE.upkeepPerTick.powerLinePerTile,
            biogasFuelCostPerEnergyUnit: BALANCE.upkeepPerTick.biogasFuelCostPerEnergyUnit,
            busStop: BALANCE.upkeepPerTick.busStop,
          },
          plants: (Object.keys(PLANT_NAMES) as PlantName[]).map((name) => {
            const type = PLANT_NAMES[name];
            return {
              name,
              label: englishText(PLANT_TOOL_KEY[name]),
              description: englishText(`${PLANT_TOOL_KEY[name]}.desc` as TranslationKey),
              cost: costs.plant[type],
              upkeepPerTick: BALANCE.upkeepPerTick.plant[type],
              placement: PLANT_PLACEMENT[name],
              ...plantFigures(type),
            };
          }),
          tax: {
            maxRate: BALANCE.tax.maxRate,
            happinessNeutralRate: BALANCE.tax.happinessNeutralRate,
          },
          speeds: [0, 1, 3],
        };
      },
    },
    {
      name: 'get_energy_report',
      description:
        'Full energy statistics for the current tick: generation per source, consumption per ' +
        'category, storage, curtailment, deficit, grid import/export, and the sampled history of ' +
        'the last in-game day (oldest first).',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      async execute() {
        const s = requireStats(ctx);
        return {
          tick: s.tick,
          hour: round(s.timeOfDay * 24, 1),
          ...s.energy,
          history: s.energy.history.map((point) => ({
            generation: round(point.generation),
            consumption: round(point.consumption),
            stateOfCharge: round(point.stateOfCharge, 2),
          })),
        };
      },
    },
    {
      name: 'get_map',
      description:
        'ASCII map of the grid (or a window of it), one character per tile, rows from north to ' +
        'south. Choose a layer: overview (default), terrain, supply, density, power or transit. The ' +
        'result includes the legend. Row i of "rows" is y = origin.y + i; character j is x = origin.x + j.',
      inputSchema: {
        type: 'object',
        properties: {
          layer: { type: 'string', enum: [...MAP_LAYERS], description: 'Which layer to render.' },
          origin: { ...POINT_SCHEMA, description: 'Top-left tile of the window (default 0,0).' },
          width: { type: 'integer', description: 'Window width in tiles (default: whole grid).' },
          height: { type: 'integer', description: 'Window height in tiles (default: whole grid).' },
        },
      },
      annotations: { readOnlyHint: true },
      async execute(input) {
        const layer = readEnum(input, 'layer', MAP_LAYERS, 'overview');
        const origin = 'origin' in input ? readPoint(input, 'origin', tiles) : { x: 0, y: 0 };
        const width = Math.min(readInt(input, 'width', size - origin.x), size - origin.x);
        const height = Math.min(readInt(input, 'height', size - origin.y), size - origin.y);
        if (width <= 0 || height <= 0)
          throw new ToolInputError('width and height must be positive');
        const rows: string[] = [];
        for (let y = origin.y; y < origin.y + height; y++) {
          let row = '';
          for (let x = origin.x; x < origin.x + width; x++) {
            row += layerGlyph(tiles, tileIndex(x, y, size), layer);
          }
          rows.push(row);
        }
        return { layer, origin, width, height, legend: LAYER_LEGEND[layer], rows };
      },
    },
    {
      name: 'inspect_tile',
      description:
        'Everything about one tile: terrain, road, power line, zone, building density, plant, ' +
        'supply status, bus stop and coverage, plus live figures (upkeep, tax, consumption, ' +
        'generation, storage, residents, jobs, demand) and the reasons the tile is not growing. ' +
        'On a geothermal hotspot or a geothermal plant, a "hotspot" field reports the field\'s ' +
        'quality, reservoir heat (0..1) and how many of its wells its capacity sustains — heat ' +
        "and every well's output fall once wells drilled exceed that capacity.",
      inputSchema: {
        type: 'object',
        properties: { x: { type: 'integer' }, y: { type: 'integer' } },
        required: ['x', 'y'],
      },
      annotations: { readOnlyHint: true },
      async execute(input) {
        const { x, y } = readPoint({ p: input }, 'p', tiles);
        const index = tileIndex(x, y, size);
        const previous = ctx.getStats()?.inspected?.index ?? null;
        await ctx.sendCommand({ type: 'inspectTile', tile: index });
        const info = ctx.getStats()?.inspected;
        // Hand the inspector back to whatever the player had selected.
        if (previous !== index) void ctx.sendCommand({ type: 'inspectTile', tile: previous });
        if (!info || info.index !== index) {
          return {
            ok: false,
            error: 'noInspection',
            message: 'Tile details are not available yet',
          };
        }
        return { ok: true, ...describeTile(ctx, index), ...liveFigures(info) };
      },
    },
    {
      name: 'find_tiles',
      description:
        'Coordinates of tiles matching a kind: empty_land, river, lake_shore (land next to the ' +
        'lake, for pumped storage), coastal_sea (empty sea tile touching land, for tidal plants), ' +
        'geothermal_hotspot (empty land tile carrying a hotspot, for geothermal plants), ' +
        'road, power_line, plant, zoned_empty, building, not_connected_building, ' +
        'undersupplied_building, bus_stop. Optionally nearest to a point first.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: [...FIND_KINDS] },
          near: { ...POINT_SCHEMA, description: 'Sort by distance to this tile.' },
          limit: { type: 'integer', description: 'Max results (default 50).' },
        },
        required: ['kind'],
      },
      annotations: { readOnlyHint: true },
      async execute(input) {
        const kind = readEnum(input, 'kind', FIND_KINDS);
        const near = 'near' in input ? readPoint(input, 'near', tiles) : null;
        const limit = Math.max(1, readInt(input, 'limit', 50));
        const matches: number[] = [];
        for (let i = 0; i < size * size; i++) {
          if (matchesKind(tiles, i, kind)) matches.push(i);
        }
        if (near) {
          const dist = (i: number): number =>
            Math.max(Math.abs(tileX(i, size) - near.x), Math.abs(tileY(i, size) - near.y));
          matches.sort((a, b) => dist(a) - dist(b));
        }
        return {
          kind,
          total: matches.length,
          tiles: matches.slice(0, limit).map((i) => ({ x: tileX(i, size), y: tileY(i, size) })),
        };
      },
    },
    {
      name: 'get_lifetime_stats',
      description:
        'One sample per in-game day since the city was founded: population, jobs, happiness, ' +
        'average generation and consumption per tick, money, mean temperature, heating load.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      async execute() {
        const samples = await ctx.requestLifetime();
        return {
          days: samples.length,
          samples: samples.map((sample) => ({
            ...sample,
            happiness: round(sample.happiness, 2),
            avgGeneration: round(sample.avgGeneration),
            avgConsumption: round(sample.avgConsumption),
            money: Math.round(sample.money),
            ...(sample.temperature !== undefined ? { temperature: round(sample.temperature) } : {}),
            ...(sample.heating !== undefined ? { heating: round(sample.heating) } : {}),
          })),
        };
      },
    },

    // ----------------------------------------------------------------- write
    {
      name: 'build_road',
      description:
        'Build a road along an L-shaped path from one tile to another (horizontal leg first), ' +
        'or on an explicit tile list. Existing roads on the path are kept and not charged. River ' +
        'tiles become bridges. Rejected as a whole when funds are short.',
      inputSchema: PATH_SCHEMA,
      async execute(input) {
        const path = readPathTiles(input, tiles);
        const before = requireStats(ctx).money;
        const outcome = await ctx.sendCommand({ type: 'buildRoad', tiles: path });
        return outcomeResult(outcome, { tiles: path.length, ...spent(ctx, before) });
      },
    },
    {
      name: 'build_power_line',
      description:
        'Build a power line along an L-shaped path (or explicit tiles). Lines may run over empty ' +
        'land, roads and water but not over buildings or plants; the whole path is rejected if ' +
        'any tile is blocked. Lines must touch a supply plant (or a line that does) to carry power.',
      inputSchema: PATH_SCHEMA,
      async execute(input) {
        const path = readPathTiles(input, tiles);
        const before = requireStats(ctx).money;
        const outcome = await ctx.sendCommand({ type: 'buildPowerLine', tiles: path });
        return outcomeResult(outcome, { tiles: path.length, ...spent(ctx, before) });
      },
    },
    {
      name: 'build_bus_stop',
      description:
        'Mark bus stops along an L-shaped path (or explicit tiles). Only road tiles take a stop; ' +
        'tiles that already have one are kept and not charged. A path with no road tile at all ' +
        'is rejected (needsRoadTile). Stops need a bus depot in route reach to be served.',
      inputSchema: PATH_SCHEMA,
      async execute(input) {
        const path = readPathTiles(input, tiles);
        const before = requireStats(ctx).money;
        const outcome = await ctx.sendCommand({ type: 'buildBusStop', tiles: path });
        return outcomeResult(outcome, { tiles: path.length, ...spent(ctx, before) });
      },
    },
    {
      name: 'paint_zone',
      description:
        'Zone every empty land tile in a rectangle as residential, commercial or retail. ' +
        'Buildings only grow on zoned tiles that touch a road and are supplied with energy.',
      inputSchema: {
        ...RECT_SCHEMA,
        properties: {
          ...(RECT_SCHEMA.properties as Record<string, unknown>),
          zone: { type: 'string', enum: Object.keys(ZONE_NAMES) },
        },
        required: ['zone', 'from'],
      },
      async execute(input) {
        const zone = readEnum(input, 'zone', Object.keys(ZONE_NAMES) as ZoneName[]);
        const rect = readRectTiles(input, tiles);
        const before = requireStats(ctx).money;
        const outcome = await ctx.sendCommand({
          type: 'paintZone',
          tiles: rect,
          zone: ZONE_NAMES[zone],
        });
        return outcomeResult(outcome, { tiles: rect.length, ...spent(ctx, before) });
      },
    },
    {
      name: 'place_plant',
      description:
        'Place a plant on one tile: solar, wind, battery, biogas, charging_hub, park, ' +
        'run_of_river (river tile), pumped_storage (land tile next to the lake), hydrogen, ' +
        'tidal (coastal sea tile), geothermal (hotspot tile), logistics_depot, bus_depot. ' +
        'See get_build_catalog for costs and roles.',
      inputSchema: {
        type: 'object',
        properties: {
          plant: { type: 'string', enum: Object.keys(PLANT_NAMES) },
          x: { type: 'integer' },
          y: { type: 'integer' },
        },
        required: ['plant', 'x', 'y'],
      },
      async execute(input) {
        const plant = readEnum(input, 'plant', Object.keys(PLANT_NAMES) as PlantName[]);
        const { x, y } = readPoint({ p: input }, 'p', tiles);
        const before = requireStats(ctx).money;
        const outcome = await ctx.sendCommand({
          type: 'placePlant',
          tile: tileIndex(x, y, size),
          plant: PLANT_NAMES[plant],
        });
        return outcomeResult(outcome, { plant, x, y, ...spent(ctx, before) });
      },
    },
    {
      name: 'bulldoze',
      description:
        'Clear every tile in a rectangle: removes roads, power lines, zones, buildings and plants ' +
        '(no refund). Use undo to revert the last build action instead.',
      inputSchema: RECT_SCHEMA,
      async execute(input) {
        const rect = readRectTiles(input, tiles);
        const outcome = await ctx.sendCommand({ type: 'bulldoze', tiles: rect });
        return outcomeResult(outcome, { tiles: rect.length });
      },
    },
    {
      name: 'undo',
      description:
        'Undo the most recent build action (road, line, zone, plant or bulldoze) and refund it.',
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        const before = requireStats(ctx).money;
        const outcome = await ctx.sendCommand({ type: 'undo' });
        return outcomeResult(outcome, {
          refunded: Math.round((ctx.getStats()?.money ?? before) - before),
        });
      },
    },
    {
      name: 'set_speed',
      description: 'Set the simulation speed: 0 pauses, 1 is normal (4 ticks/s), 3 is fast.',
      inputSchema: {
        type: 'object',
        properties: { speed: { type: 'integer', enum: [0, 1, 3] } },
        required: ['speed'],
      },
      async execute(input) {
        const speed = readInt(input, 'speed');
        if (speed !== 0 && speed !== 1 && speed !== 3) {
          throw new ToolInputError('"speed" must be 0, 1 or 3');
        }
        const outcome = await ctx.sendCommand({ type: 'setSpeed', speed: speed as Speed });
        return outcomeResult(outcome, { speed });
      },
    },
    {
      name: 'set_tax_rate',
      description: `Set the tax rate, 0 to ${BALANCE.tax.maxRate}. Above ${BALANCE.tax.happinessNeutralRate} happiness starts to suffer.`,
      inputSchema: {
        type: 'object',
        properties: { rate: { type: 'number', minimum: 0, maximum: BALANCE.tax.maxRate } },
        required: ['rate'],
      },
      async execute(input) {
        const rate = input.rate;
        if (typeof rate !== 'number' || !Number.isFinite(rate)) {
          throw new ToolInputError('"rate" must be a number');
        }
        const outcome = await ctx.sendCommand({ type: 'setTaxRate', rate });
        return outcomeResult(outcome, { taxRate: ctx.getStats()?.taxRate ?? rate });
      },
    },
    {
      name: 'set_smart_charging',
      description: 'Enable or disable smart charging (EV charging follows the generation surplus).',
      inputSchema: {
        type: 'object',
        properties: { enabled: { type: 'boolean' } },
        required: ['enabled'],
      },
      async execute(input) {
        if (typeof input.enabled !== 'boolean')
          throw new ToolInputError('"enabled" must be boolean');
        const outcome = await ctx.sendCommand({ type: 'setSmartCharging', enabled: input.enabled });
        return outcomeResult(outcome, { smartCharging: input.enabled });
      },
    },
    {
      name: 'plant_forest',
      description: `Plant woods on a rectangle of empty land (${BALANCE.forest.plantCost} per tile). Saplings grow over a few days, raise happiness nearby, and slow the wind for turbines standing in them.`,
      inputSchema: { ...RECT_SCHEMA, required: ['from'] },
      async execute(input) {
        const rect = readRectTiles(input, tiles);
        const before = requireStats(ctx).money;
        const outcome = await ctx.sendCommand({ type: 'plantForest', tiles: rect });
        return outcomeResult(outcome, { tiles: rect.length, ...spent(ctx, before) });
      },
    },
    {
      name: 'set_market_trading',
      description:
        'Enable or disable spot-market trading: storage sells its top charge at scarcity prices and buys cheap regional surplus.',
      inputSchema: {
        type: 'object',
        properties: { enabled: { type: 'boolean' } },
        required: ['enabled'],
      },
      async execute(input) {
        if (typeof input.enabled !== 'boolean')
          throw new ToolInputError('"enabled" must be boolean');
        const outcome = await ctx.sendCommand({ type: 'setMarketTrading', enabled: input.enabled });
        return outcomeResult(outcome, { marketTrading: input.enabled });
      },
    },
    {
      name: 'buy_insulation',
      description: `Buy the one-off building insulation upgrade (${BALANCE.costs.insulation} money) that halves the heating load.`,
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        const before = requireStats(ctx).money;
        const outcome = await ctx.sendCommand({ type: 'buyInsulation' });
        return outcomeResult(outcome, spent(ctx, before));
      },
    },
    {
      name: 'advance_time',
      description:
        `Run the simulation for a number of ticks or days (max ${MAX_ADVANCE_DAYS} days, ` +
        `${TICKS_PER_DAY} ticks per day) and return when done. Runs at fast speed if the game is ` +
        'paused and restores the previous speed afterwards. Returns the resulting overview summary.',
      inputSchema: {
        type: 'object',
        properties: {
          ticks: { type: 'integer', minimum: 1 },
          days: {
            type: 'number',
            minimum: 0,
            description: 'Alternative to ticks (fractions allowed).',
          },
        },
      },
      async execute(input, options) {
        const days = typeof input.days === 'number' ? input.days : 0;
        const ticks =
          (typeof input.ticks === 'number' ? Math.floor(input.ticks) : 0) +
          Math.round(days * TICKS_PER_DAY);
        if (!Number.isFinite(ticks) || ticks <= 0) {
          throw new ToolInputError('Give "ticks" (>= 1) or "days" (> 0)');
        }
        if (ticks > MAX_ADVANCE_DAYS * TICKS_PER_DAY) {
          throw new ToolInputError(
            `At most ${MAX_ADVANCE_DAYS} days (${MAX_ADVANCE_DAYS * TICKS_PER_DAY} ticks) per call`,
          );
        }
        const start = requireStats(ctx);
        const previousSpeed = start.speed;
        if (previousSpeed === 0) await ctx.sendCommand({ type: 'setSpeed', speed: 3 });
        try {
          const end = await ctx.waitForTick(start.tick + ticks, options?.signal);
          return {
            ok: true,
            ticksAdvanced: end.tick - start.tick,
            day: end.day,
            hour: round(end.timeOfDay * 24, 1),
            money: Math.round(end.money),
            population: end.population,
            jobs: end.jobs,
            happiness: round(end.happiness, 2),
            deficit: round(end.energy.deficit),
            goalsAchieved: end.goals.filter((g) => g.achieved).map((g) => g.id),
          };
        } finally {
          if (previousSpeed === 0) await ctx.sendCommand({ type: 'setSpeed', speed: 0 });
        }
      },
    },
    {
      name: 'save_game',
      description: 'Save the city to the autosave slot now (the game also autosaves periodically).',
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        const outcome = await ctx.sendCommand({ type: 'requestSave' });
        return outcomeResult(outcome);
      },
    },
    {
      name: 'start_new_city',
      description:
        'Abandon the current city and start a new one (the page reloads; the old autosave is ' +
        'replaced). Optional map size (48, 64 or 96), difficulty (easy, normal, hard) and seed.',
      inputSchema: {
        type: 'object',
        properties: {
          size: { type: 'integer', enum: [48, 64, 96] },
          difficulty: { type: 'string', enum: ['easy', 'normal', 'hard'] },
          seed: { type: 'integer', description: 'Fixed world seed; omit for a random map.' },
        },
      },
      annotations: { consequentialHint: true },
      async execute(input) {
        const mapSize = readInt(input, 'size', GRID_SIZE);
        if (![48, 64, 96].includes(mapSize))
          throw new ToolInputError('"size" must be 48, 64 or 96');
        const difficulty = readEnum(
          input,
          'difficulty',
          ['easy', 'normal', 'hard'] as const,
          'normal',
        );
        const startingMoney = { easy: 40_000, normal: BALANCE.startingMoney, hard: 15_000 }[
          difficulty
        ];
        const seed = 'seed' in input ? readInt(input, 'seed') : null;
        ctx.startNewCity({ size: mapSize, startingMoney, seed });
        return {
          ok: true,
          size: mapSize,
          difficulty,
          seed,
          note: 'The page is reloading with the new city.',
        };
      },
    },
  ];
  return tools;
}

function spent(ctx: AgentContext, before: number): { spent: number; money: number } {
  const money = ctx.getStats()?.money ?? before;
  return { spent: Math.round(before - money), money: Math.round(money) };
}

function plantFigures(type: PlantType): Record<string, number> {
  const e = BALANCE.energy;
  switch (type) {
    case PlantType.SolarFarm:
      return { peakOutputPerTick: e.solarPeakOutput };
    case PlantType.WindTurbine:
      return { peakOutputPerTick: e.windPeakOutput };
    case PlantType.BiogasPlant:
      return { maxOutputPerTick: e.biogasMaxOutput };
    case PlantType.RunOfRiver:
      return { peakOutputPerTick: e.hydroPeakOutput };
    case PlantType.TidalPlant:
      return { peakOutputPerTick: e.tidalPeakOutput };
    case PlantType.GeothermalPlant:
      return { peakOutputPerTick: e.geothermalPeakOutput };
    case PlantType.Battery:
      return { capacity: e.batteryCapacity, powerLimitPerTick: e.batteryPowerLimit };
    case PlantType.PumpedStorage:
      return { capacity: e.pumpedStorageCapacity, powerLimitPerTick: e.pumpedStoragePowerLimit };
    case PlantType.ChargingHub:
      return { serviceRadius: BALANCE.vehicles.hubRadius };
    case PlantType.Park:
      return { happinessRadius: BALANCE.happiness.parkRadius };
    case PlantType.LogisticsDepot:
      return {
        vans: BALANCE.deliveries.vansPerDepot,
        routeReachTiles: BALANCE.deliveries.maxRouteTiles,
      };
    case PlantType.BusDepot:
      return {
        buses: BALANCE.transit.busesPerDepot,
        routeReachTiles: BALANCE.transit.maxRouteTiles,
        stopRadius: BALANCE.transit.stopRadius,
      };
    default:
      return {};
  }
}

function liveFigures(info: TileInfo): Record<string, unknown> {
  return {
    connected: info.connected,
    ringRadius: info.ringRadius,
    ...(info.hotspot ? { hotspot: info.hotspot } : {}),
    upkeepPerTick: round(info.upkeepPerTick, 4),
    fuelCostPerTick: round(info.fuelCostPerTick, 4),
    taxPerTick: round(info.taxPerTick, 4),
    consumption: round(info.consumption, 2),
    peakConsumption: round(info.peakConsumption, 2),
    loadFactor: round(info.loadFactor, 2),
    generation: round(info.generation, 2),
    peakGeneration: round(info.peakGeneration, 2),
    storedEnergy: Math.round(info.storedEnergy),
    storageCapacity: info.storageCapacity,
    population: info.population,
    jobs: info.jobs,
    demand: round(info.demand, 2),
    buildingAge: info.buildingAge,
    troubledTicks: info.troubledTicks,
    growthBlockers: info.growthBlockers,
    deliveryState: info.deliveryState,
    deliveryAgeDays: round(info.deliveryAgeTicks / TICKS_PER_DAY, 2),
    depot: info.depot,
    busStop: info.busStop,
    stopState: info.busStop ? STOP_STATE_NAME[info.stopState] : null,
    stopAgeHours: info.busStop ? round((info.stopAgeTicks / TICKS_PER_DAY) * 24, 1) : null,
    transitCovered: info.transitCovered,
    busDepot: info.busDepot,
  };
}

function matchesKind(tiles: TileMirror, i: number, kind: FindKind): boolean {
  const terrain = tiles.terrain[i];
  const empty = tiles.tileType[i] === TileType.Empty && tiles.density[i] === 0;
  switch (kind) {
    case 'empty_land':
      return terrain === Terrain.Land && empty && tiles.powerLine[i] === 0;
    case 'river':
      return terrain === Terrain.River && tiles.tileType[i] === TileType.Empty;
    case 'lake_shore':
      return terrain === Terrain.Land && empty && isLakeShore(tiles, i);
    case 'coastal_sea':
      return tiles.tileType[i] === TileType.Empty && isCoastalSeaTile(tiles, i);
    case 'geothermal_hotspot':
      return terrain === Terrain.Land && empty && isHotspotTile(tiles, i);
    case 'road':
      return tiles.tileType[i] === TileType.Road;
    case 'power_line':
      return tiles.powerLine[i] !== 0;
    case 'plant':
      return tiles.tileType[i] === TileType.Plant;
    case 'zoned_empty':
      return tiles.zone[i] !== Zone.None && tiles.density[i] === 0;
    case 'building':
      return tiles.density[i] > 0;
    case 'not_connected_building':
      return tiles.density[i] > 0 && tiles.supplied[i] === SupplyStatus.NotConnected;
    case 'undersupplied_building':
      return tiles.density[i] > 0 && tiles.supplied[i] === SupplyStatus.Undersupplied;
    case 'bus_stop':
      return tiles.busStop[i] !== 0;
  }
}

/**
 * Run a tool by name with input validation errors turned into a result
 * object, so agents never see a thrown exception for bad input.
 */
export async function callTool(
  tools: AgentTool[],
  name: string,
  input: unknown,
  options?: { signal?: AbortSignal },
): Promise<unknown> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    return { ok: false, error: 'unknownTool', message: `No tool named "${name}"` };
  }
  try {
    return await tool.execute(isRecord(input) ? input : {}, options);
  } catch (error) {
    if (error instanceof ToolInputError) {
      return { ok: false, error: 'invalidInput', message: error.message };
    }
    throw error;
  }
}
