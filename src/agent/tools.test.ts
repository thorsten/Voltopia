import { describe, expect, it } from 'vitest';
import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import { tileIndex, tileX, tileY } from '../shared/grid.ts';
import type { SimCommand, SimEvent } from '../shared/messages.ts';
import { PlantType, Terrain, TileType, Zone, type GlobalStats } from '../shared/types.ts';
import { SimEngine } from '../sim/engine.ts';
import { discoverGeothermalFields } from '../sim/geothermal.ts';
import { isCoastalSea } from '../sim/sea.ts';
import { markDirty, slopeCostMultiplier } from '../sim/state.ts';
import { TileMirror } from './tileMirror.ts';
import {
  callTool,
  createAgentTools,
  MAX_ADVANCE_DAYS,
  type AgentContext,
  type AgentTool,
  type NewCityOptions,
} from './tools.ts';

const SIZE = 24;

/** Drives the tools against an in-process engine, mimicking the worker. */
function createHarness(seed = 11): {
  ctx: AgentContext;
  tools: AgentTool[];
  engine: SimEngine;
  newCities: NewCityOptions[];
  call: (name: string, input?: unknown) => Promise<Record<string, unknown>>;
} {
  const engine = new SimEngine(seed, SIZE);
  engine.applyCommand({ type: 'init', seed, size: SIZE });
  const tiles = new TileMirror(SIZE);
  let stats: GlobalStats | null = null;
  const absorb = (event: SimEvent | null): void => {
    if (!event || event.type !== 'tick') return;
    tiles.applyDiffs(event.diffs);
    stats = event.stats;
  };
  absorb(engine.tick());
  const newCities: NewCityOptions[] = [];
  const ctx: AgentContext = {
    tiles,
    getStats: () => stats,
    async sendCommand(command: SimCommand) {
      const events = engine.applyCommand(command);
      absorb(command.type === 'inspectTile' ? engine.snapshot() : engine.flush());
      const rejected = events.find((e) => e.type === 'rejected');
      return rejected && rejected.type === 'rejected' ? { rejected: rejected.reason } : {};
    },
    async waitForTick(target, signal) {
      while ((stats?.tick ?? 0) < target) {
        if (signal?.aborted) throw new Error('aborted');
        absorb(engine.tick());
      }
      return stats!;
    },
    async requestLifetime() {
      const [event] = engine.applyCommand({ type: 'requestLifetime' });
      return event && event.type === 'lifetimeData' ? event.samples : [];
    },
    startNewCity(options) {
      newCities.push(options);
    },
  };
  const tools = createAgentTools(ctx);
  return {
    ctx,
    tools,
    engine,
    newCities,
    call: (name, input = {}) => callTool(tools, name, input) as Promise<Record<string, unknown>>,
  };
}

function findLand(engine: SimEngine, minX = 2): { x: number; y: number } {
  const { terrain, elevation, forest } = engine.state.layers;
  for (let y = 2; y < SIZE - 2; y++) {
    for (let x = minX; x < SIZE - 2; x++) {
      // A 6x3 all-land block gives room for road + zone tests. The
      // one-tile margin around it must be land at the same level, so no
      // tile is sloped (slope surcharges would skew cost expectations).
      let ok = true;
      const level = elevation[tileIndex(x, y, SIZE)];
      for (let dy = -1; dy < 4 && ok; dy++) {
        for (let dx = -1; dx < 7; dx++) {
          const index = tileIndex(x + dx, y + dy, SIZE);
          if (terrain[index] !== Terrain.Land || elevation[index] !== level) {
            ok = false;
            break;
          }
        }
      }
      if (ok) {
        // Clear any woods so felling fees don't skew the cost checks either.
        for (let dy = -1; dy < 4; dy++) {
          for (let dx = -1; dx < 7; dx++) forest[tileIndex(x + dx, y + dy, SIZE)] = 0;
        }
        return { x, y };
      }
    }
  }
  throw new Error('no land block');
}

/** Any sea tile with a land 4-neighbour — where a tidal plant may stand. */
function findCoastalSeaTile(engine: SimEngine): { x: number; y: number } {
  const { size } = engine.state;
  for (let i = 0; i < size * size; i++) {
    if (isCoastalSea(engine.state, i)) return { x: tileX(i, size), y: tileY(i, size) };
  }
  throw new Error('no coastal sea tile');
}

describe('agent tools: reading', () => {
  it('lists every tool with a schema and description', () => {
    const { tools } = createHarness();
    const names = tools.map((t) => t.name);
    expect(names).toEqual([
      'get_game_overview',
      'get_build_catalog',
      'get_energy_report',
      'get_map',
      'inspect_tile',
      'find_tiles',
      'get_lifetime_stats',
      'build_road',
      'build_power_line',
      'build_bus_stop',
      'paint_zone',
      'place_plant',
      'bulldoze',
      'undo',
      'set_speed',
      'set_tax_rate',
      'set_smart_charging',
      'plant_forest',
      'set_market_trading',
      'buy_insulation',
      'advance_time',
      'save_game',
      'start_new_city',
    ]);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe('object');
    }
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name);
    expect(readOnly).toHaveLength(7);
  });

  it('get_game_overview reports funds, clock, goals and counts', async () => {
    const { call } = createHarness();
    const overview = await call('get_game_overview');
    expect(overview.gridSize).toBe(SIZE);
    expect(overview.money).toBe(BALANCE.startingMoney);
    expect(overview.population).toBe(0);
    expect(overview.speed).toBe(1);
    expect(overview.taxRate).toBe(BALANCE.tax.defaultRate);
    const goals = overview.goals as Array<{ id: string; title: string; achieved: boolean }>;
    expect(goals.length).toBeGreaterThan(5);
    expect(goals.every((g) => g.title.length > 0 && g.achieved === false)).toBe(true);
    expect((overview.season as { season: string }).season).toBe('spring');
  });

  it('get_build_catalog lists costs and plant placement rules', async () => {
    const { call } = createHarness();
    const catalog = await call('get_build_catalog');
    expect((catalog.costs as { roadPerTile: number }).roadPerTile).toBe(BALANCE.costs.roadPerTile);
    const plants = catalog.plants as Array<{ name: string; cost: number; placement: string }>;
    expect(plants.map((p) => p.name)).toContain('pumped_storage');
    const solar = plants.find((p) => p.name === 'solar')!;
    expect(solar.cost).toBe(BALANCE.costs.plant[PlantType.SolarFarm]);
    expect(plants.find((p) => p.name === 'run_of_river')!.placement).toContain('river');
  });

  it('get_energy_report exposes the energy stats', async () => {
    const { call } = createHarness();
    const report = await call('get_energy_report');
    expect(report.generation).toBeDefined();
    expect(report.consumption).toBeDefined();
    expect(Array.isArray(report.history)).toBe(true);
  });

  it('get_map renders the whole grid and windows of it', async () => {
    const { call, engine } = createHarness();
    const full = await call('get_map');
    const rows = full.rows as string[];
    expect(rows).toHaveLength(SIZE);
    expect(rows.every((row) => row.length === SIZE)).toBe(true);
    expect(full.legend).toContain('river');
    // The terrain layer matches the engine's terrain.
    const terrain = await call('get_map', { layer: 'terrain' });
    const terrainRows = terrain.rows as string[];
    for (let i = 0; i < SIZE * SIZE; i++) {
      const glyph = terrainRows[Math.floor(i / SIZE)][i % SIZE];
      const t = engine.state.layers.terrain[i];
      const expected =
        engine.state.layers.geothermal[i] !== 0
          ? '^'
          : t === Terrain.River
            ? '~'
            : t === Terrain.Lake
              ? '#'
              : t === Terrain.Sea
                ? '%'
                : '.';
      expect(glyph).toBe(expected);
    }
    // The map always carves at least one geothermal hotspot, so the ^ branch is exercised for real.
    expect(engine.state.layers.geothermal.some((g) => g !== 0)).toBe(true);
    // The map always carves a sea band, so the fix-up above is exercised for real.
    expect(engine.state.layers.terrain.some((t) => t === Terrain.Sea)).toBe(true);
    const window = await call('get_map', { origin: { x: 20, y: 21 }, width: 10, height: 10 });
    expect(window.width).toBe(4);
    expect(window.height).toBe(3);
    expect((window.rows as string[])[0]).toHaveLength(4);
    expect(await call('get_map', { layer: 'nope' })).toMatchObject({
      ok: false,
      error: 'invalidInput',
    });
    expect(await call('get_map', { origin: { x: 99, y: 0 } })).toMatchObject({ ok: false });
  });

  it('get_map marks the sea on every layer, not just terrain', async () => {
    const { call, engine } = createHarness();
    const size = engine.state.size;
    const seaTiles: number[] = [];
    for (let i = 0; i < size * size; i++) {
      if (engine.state.layers.terrain[i] === Terrain.Sea) seaTiles.push(i);
    }
    expect(seaTiles.length).toBeGreaterThan(0);

    for (const layer of ['overview', 'supply', 'density', 'power', 'transit'] as const) {
      const map = await call('get_map', { layer });
      const rows = map.rows as string[];
      for (const i of seaTiles) {
        const glyph = rows[Math.floor(i / size)][i % size];
        expect(glyph, `layer ${layer} at tile ${i}`).toBe('%');
      }
      expect(map.legend as string, `legend for ${layer}`).toContain('% sea');
    }
  });

  it('find_tiles finds river, lake shore and empty land, nearest first', async () => {
    const { call, engine } = createHarness();
    const river = await call('find_tiles', { kind: 'river', limit: 5 });
    expect(river.total).toBeGreaterThan(0);
    expect((river.tiles as unknown[]).length).toBeLessThanOrEqual(5);
    for (const { x, y } of river.tiles as Array<{ x: number; y: number }>) {
      expect(engine.state.layers.terrain[tileIndex(x, y, SIZE)]).toBe(Terrain.River);
    }
    const shore = await call('find_tiles', { kind: 'lake_shore' });
    expect(shore.total).toBeGreaterThan(0);
    const coastalSea = await call('find_tiles', { kind: 'coastal_sea' });
    expect(coastalSea.total).toBeGreaterThan(0);
    for (const { x, y } of coastalSea.tiles as Array<{ x: number; y: number }>) {
      expect(isCoastalSea(engine.state, tileIndex(x, y, SIZE))).toBe(true);
    }
    const hotspots = await call('find_tiles', { kind: 'geothermal_hotspot' });
    expect(hotspots.total).toBeGreaterThan(0);
    for (const { x, y } of hotspots.tiles as Array<{ x: number; y: number }>) {
      expect(engine.state.layers.geothermal[tileIndex(x, y, SIZE)]).not.toBe(0);
    }
    const land = await call('find_tiles', { kind: 'empty_land', near: { x: 5, y: 5 }, limit: 3 });
    const tiles = land.tiles as Array<{ x: number; y: number }>;
    expect(tiles).toHaveLength(3);
    const d = (p: { x: number; y: number }) => Math.max(Math.abs(p.x - 5), Math.abs(p.y - 5));
    expect(d(tiles[0])).toBeLessThanOrEqual(d(tiles[2]));
    expect(await call('find_tiles', { kind: 'unicorns' })).toMatchObject({ ok: false });
  });

  it('get_lifetime_stats returns one sample per day', async () => {
    const { call } = createHarness();
    expect(await call('get_lifetime_stats')).toMatchObject({ days: 0, samples: [] });
    await call('advance_time', { days: 1 });
    const after = await call('get_lifetime_stats');
    expect(after.days).toBe(1);
  });
});

describe('agent tools: building', () => {
  it('builds a road, zones next to it, places a plant and lines, then inspects', async () => {
    const { call, engine } = createHarness();
    const { x, y } = findLand(engine);
    // Sloped tiles carry the terrain surcharge, so price tiles like the sim does.
    const priced = (base: number, row: number, count: number) => {
      let sum = 0;
      for (let dx = 0; dx < count; dx++) {
        const index = tileIndex(x + dx, row, SIZE);
        sum += Math.round(base * slopeCostMultiplier(engine.state, index));
      }
      return sum;
    };
    const road = await call('build_road', { from: { x, y }, to: { x: x + 5, y } });
    expect(road).toMatchObject({
      ok: true,
      tiles: 6,
      spent: priced(BALANCE.costs.roadPerTile, y, 6),
    });
    expect(engine.state.layers.tileType[tileIndex(x + 3, y, SIZE)]).toBe(TileType.Road);

    const zone = await call('paint_zone', {
      zone: 'residential',
      from: { x, y: y + 1 },
      to: { x: x + 5, y: y + 1 },
    });
    expect(zone).toMatchObject({
      ok: true,
      tiles: 6,
      spent: priced(BALANCE.costs.zonePerTile, y + 1, 6),
    });
    expect(engine.state.layers.zone[tileIndex(x + 2, y + 1, SIZE)]).toBe(Zone.Residential);

    const plant = await call('place_plant', { plant: 'solar', x, y: y + 2 });
    expect(plant).toMatchObject({
      ok: true,
      spent: priced(BALANCE.costs.plant[PlantType.SolarFarm], y + 2, 1),
    });
    expect(engine.state.layers.plantType[tileIndex(x, y + 2, SIZE)]).toBe(PlantType.SolarFarm);

    const line = await call('build_power_line', {
      tiles: [
        { x: x + 1, y: y + 2 },
        { x: x + 2, y: y + 2 },
      ],
    });
    expect(line).toMatchObject({ ok: true, tiles: 2 });
    expect(engine.state.layers.powerLine[tileIndex(x + 2, y + 2, SIZE)]).not.toBe(0);

    const map = await call('get_map', { origin: { x, y }, width: 6, height: 3 });
    expect(map.rows).toEqual(['++++++', 'rrrrrr', 'V==...']);

    const info = await call('inspect_tile', { x, y: y + 2 });
    expect(info).toMatchObject({ ok: true, plant: 'solar', terrain: 'land', tileType: 'plant' });
    expect(info.peakGeneration).toBe(BALANCE.energy.solarPeakOutput);
    // Inspecting from a tool does not leave the inspector on that tile.
    expect(engine.state.inspectedTile).toBe(-1);

    const zoned = await call('inspect_tile', { x: x + 1, y: y + 1 });
    expect(zoned).toMatchObject({ ok: true, zone: 'residential', density: 0 });
    expect(Array.isArray(zoned.growthBlockers)).toBe(true);
  });

  it('surfaces sim rejections with the code and an English message', async () => {
    const { call, engine } = createHarness();
    const { x, y } = findLand(engine);
    const bad = await call('place_plant', { plant: 'run_of_river', x, y });
    expect(bad).toMatchObject({ ok: false, error: 'needsRiverTile' });
    expect(bad.message).toContain('river');
    engine.state.money = 1;
    const poor = await call('build_road', { from: { x, y }, to: { x: x + 5, y } });
    expect(poor).toMatchObject({ ok: false, error: 'notEnoughMoney', message: 'Not enough money' });
  });

  it('rejects malformed input without throwing', async () => {
    const { call } = createHarness();
    expect(await call('build_road', {})).toMatchObject({ ok: false, error: 'invalidInput' });
    expect(await call('build_road', { from: { x: -1, y: 0 } })).toMatchObject({ ok: false });
    expect(await call('build_road', { tiles: [{ x: 1 }] })).toMatchObject({ ok: false });
    expect(await call('paint_zone', { zone: 'industrial', from: { x: 1, y: 1 } })).toMatchObject({
      ok: false,
    });
    expect(await call('place_plant', { plant: 'coal', x: 1, y: 1 })).toMatchObject({ ok: false });
    expect(await call('place_plant', { plant: 'solar', x: 1.5, y: 1 })).toMatchObject({
      ok: false,
    });
    expect(await call('set_speed', { speed: 2 })).toMatchObject({ ok: false });
    expect(await call('set_tax_rate', { rate: 'high' })).toMatchObject({ ok: false });
    expect(await call('set_smart_charging', { enabled: 'yes' })).toMatchObject({ ok: false });
    expect(await call('advance_time', {})).toMatchObject({ ok: false });
    expect(await call('advance_time', { days: MAX_ADVANCE_DAYS + 1 })).toMatchObject({ ok: false });
    expect(await call('start_new_city', { size: 50 })).toMatchObject({ ok: false });
    expect(await call('no_such_tool')).toMatchObject({ ok: false, error: 'unknownTool' });
    expect(await callTool([], 'x', 'not an object')).toMatchObject({ ok: false });
  });

  it('bulldozes a rectangle and undo refunds the last action', async () => {
    const { call, engine } = createHarness();
    const { x, y } = findLand(engine);
    await call('build_road', { from: { x, y }, to: { x: x + 5, y } });
    const before = engine.state.money;
    await call('place_plant', { plant: 'wind', x, y: y + 1 });
    const undo = await call('undo');
    expect(undo).toMatchObject({ ok: true, refunded: BALANCE.costs.plant[PlantType.WindTurbine] });
    expect(engine.state.money).toBe(before);
    const cleared = await call('bulldoze', { from: { x, y }, to: { x: x + 5, y } });
    expect(cleared).toMatchObject({ ok: true, tiles: 6 });
    expect(engine.state.layers.tileType[tileIndex(x, y, SIZE)]).toBe(TileType.Empty);
    expect(await call('undo')).toMatchObject({ ok: true });
    expect(engine.state.layers.tileType[tileIndex(x, y, SIZE)]).toBe(TileType.Road);
  });

  it('sets speed, tax rate, smart charging and buys insulation', async () => {
    const { call, engine } = createHarness();
    expect(await call('set_speed', { speed: 3 })).toMatchObject({ ok: true, speed: 3 });
    expect(engine.state.speed).toBe(3);
    expect(await call('set_tax_rate', { rate: 0.9 })).toMatchObject({
      ok: true,
      taxRate: BALANCE.tax.maxRate,
    });
    expect(await call('set_smart_charging', { enabled: true })).toMatchObject({ ok: true });
    expect(engine.state.smartCharging).toBe(true);
    expect(await call('set_market_trading', { enabled: true })).toMatchObject({ ok: true });
    expect(engine.state.marketTrading).toBe(true);
    const wood = findLand(engine, 12);
    expect(
      await call('plant_forest', { from: wood, to: { x: wood.x + 1, y: wood.y } }),
    ).toMatchObject({ ok: true, tiles: 2 });
    expect(engine.state.layers.forest[tileIndex(wood.x, wood.y, SIZE)]).toBe(1);
    expect(await call('buy_insulation')).toMatchObject({
      ok: true,
      spent: BALANCE.costs.insulation,
    });
    expect(await call('buy_insulation')).toMatchObject({ ok: false, error: 'alreadyInsulated' });
  });

  it('advance_time runs the requested ticks and restores a paused game', async () => {
    const { call, engine } = createHarness();
    await call('set_speed', { speed: 0 });
    const start = engine.state.tick;
    const result = await call('advance_time', { ticks: 10 });
    expect(result).toMatchObject({ ok: true, ticksAdvanced: 10 });
    expect(engine.state.tick).toBe(start + 10);
    expect(engine.state.speed).toBe(0);
    const day = await call('advance_time', { days: 0.5 });
    expect(day.ticksAdvanced).toBe(TICKS_PER_DAY / 2);
    expect(await call('save_game')).toMatchObject({ ok: true });
  });

  it('start_new_city hands validated options to the host', async () => {
    const { call, newCities } = createHarness();
    const result = await call('start_new_city', { size: 48, difficulty: 'hard', seed: 7 });
    expect(result).toMatchObject({ ok: true, size: 48, difficulty: 'hard', seed: 7 });
    expect(newCities).toEqual([{ size: 48, startingMoney: 15_000, seed: 7 }]);
    await call('start_new_city');
    expect(newCities[1]).toEqual({ size: 64, startingMoney: BALANCE.startingMoney, seed: null });
  });

  it('places a logistics depot next to a road and reports deliveries', async () => {
    const { call, engine } = createHarness();
    const { x, y } = findLand(engine);
    await call('build_road', { from: { x, y }, to: { x: x + 3, y } });
    const depot = await call('place_plant', { plant: 'logistics_depot', x, y: y + 1 });
    expect(depot).toMatchObject({ ok: true });
    expect(engine.state.layers.plantType[tileIndex(x, y + 1, SIZE)]).toBe(PlantType.LogisticsDepot);
    await call('advance_time', { ticks: 1 });
    const overview = await call('get_game_overview');
    expect(overview.deliveries).toMatchObject({ shops: 0, depots: 1 });
    const info = await call('inspect_tile', { x, y: y + 1 });
    expect(info).toMatchObject({ ok: true, plant: 'logistics_depot' });
    expect(info.depot).toMatchObject({ vansTotal: BALANCE.deliveries.vansPerDepot });
  });

  it('marks bus stops, places a bus depot and reports transit', async () => {
    const { call, engine } = createHarness();
    const { x, y } = findLand(engine);
    await call('build_road', { from: { x, y }, to: { x: x + 5, y } });
    const stops = await call('build_bus_stop', { from: { x: x + 1, y }, to: { x: x + 4, y } });
    expect(stops).toMatchObject({ ok: true, tiles: 4 });
    expect(engine.state.layers.busStop[tileIndex(x + 4, y, SIZE)]).toBe(1);
    const offRoad = await call('build_bus_stop', { from: { x, y: y + 2 } });
    expect(offRoad).toMatchObject({ ok: false, error: 'needsRoadTile' });
    const depot = await call('place_plant', { plant: 'bus_depot', x, y: y + 1 });
    expect(depot).toMatchObject({ ok: true });
    expect(engine.state.layers.plantType[tileIndex(x, y + 1, SIZE)]).toBe(PlantType.BusDepot);
    await call('advance_time', { ticks: 1 });
    const overview = await call('get_game_overview');
    expect(overview.transit).toMatchObject({ stops: 4, stopsServed: 4, depots: 1 });
    const map = await call('get_map', { layer: 'transit', origin: { x, y }, width: 6, height: 2 });
    expect((map.rows as string[])[0]).toBe('+oooo+');
    expect((map.rows as string[])[1]).toBe('T.....');
    const found = await call('find_tiles', { kind: 'bus_stop' });
    expect(found.total).toBe(4);
    const info = await call('inspect_tile', { x: x + 1, y });
    expect(info).toMatchObject({
      ok: true,
      busStop: true,
      stopState: 'served',
      transitCovered: true,
    });
    const depotInfo = await call('inspect_tile', { x, y: y + 1 });
    expect(depotInfo.busDepot).toMatchObject({ busesTotal: BALANCE.transit.busesPerDepot });
    const plainRoad = await call('inspect_tile', { x, y });
    expect(plainRoad).toMatchObject({
      ok: true,
      busStop: false,
      stopState: null,
      stopAgeHours: null,
    });
  });

  it('places a tidal plant on the coast', async () => {
    const { call, engine } = createHarness();
    const tile = findCoastalSeaTile(engine);
    const result = await call('place_plant', { plant: 'tidal', x: tile.x, y: tile.y });
    expect(result).toMatchObject({ ok: true });
    expect(engine.state.layers.plantType[tileIndex(tile.x, tile.y, SIZE)]).toBe(
      PlantType.TidalPlant,
    );
  });

  it('builds a geothermal plant on a hotspot and rejects it off the hotspot', async () => {
    const { call, engine } = createHarness();
    const { x, y } = findLand(engine);
    const hotspot = tileIndex(x, y, SIZE);
    const elsewhere = tileIndex(x + 1, y, SIZE);
    // A hand-placed hotspot, independent of whatever the map generator drew.
    engine.state.layers.geothermal[elsewhere] = 0;
    engine.state.layers.geothermal[hotspot] = 2;
    engine.state.layers.reservoirHeat[hotspot] = 255;
    discoverGeothermalFields(engine.state);

    const built = await call('place_plant', { plant: 'geothermal', x, y });
    expect(built).toMatchObject({ ok: true });
    expect(engine.state.layers.plantType[hotspot]).toBe(PlantType.GeothermalPlant);

    const refused = await call('place_plant', { plant: 'geothermal', x: x + 1, y });
    expect(refused).toMatchObject({ ok: false, error: 'needsHotspot' });
  });

  it('inspect_tile reports the hotspot field so an agent can watch its reservoir', async () => {
    const { call, engine } = createHarness();
    const { x, y } = findLand(engine);
    const hotspot = tileIndex(x, y, SIZE);
    engine.state.layers.geothermal[hotspot] = 2;
    engine.state.layers.reservoirHeat[hotspot] = 255;
    discoverGeothermalFields(engine.state);

    await call('place_plant', { plant: 'geothermal', x, y });
    const info = await call('inspect_tile', { x, y });
    expect(info).toMatchObject({
      ok: true,
      plant: 'geothermal',
      hotspot: { quality: 2, heat: 1, wells: 1, capacity: 1 },
    });
  });

  it('finds a hand-placed geothermal hotspot once its diff reaches the tile mirror', async () => {
    const { call, engine } = createHarness();
    const { x, y } = findLand(engine);
    const hotspot = tileIndex(x, y, SIZE);
    engine.state.layers.geothermal[hotspot] = 2;
    // Writing the layer directly (as opposed to the real generator, which
    // marks its own tiles dirty) does not queue a diff by itself — mark it
    // dirty so the next tick actually reaches the agent's tile mirror. Go
    // through the advance_time tool (not a raw engine.tick()) so the tick
    // is absorbed into the harness's own tile mirror, exactly as a real
    // agent session would see it.
    markDirty(engine.state, hotspot);
    await call('advance_time', { ticks: 1 });

    const found = await call('find_tiles', { kind: 'geothermal_hotspot' });
    expect(found.tiles).toContainEqual({ x, y });
  });
});
