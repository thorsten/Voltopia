import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { OSM_IMPORT } from '../import/config.ts';
import { resetSearchGate } from '../import/fetch.ts';
import { squareBbox } from '../import/geo.ts';
import { parseOsm } from '../import/osm.ts';
import { marginTiles, rasteriseTown } from '../import/rasterise.ts';
import {
  BALANCE,
  MAP_SIZES,
  OVERPASS_LONG_RAMP_TILES,
  TICKS_PER_DAY,
  TICKS_PER_HISTORY_SAMPLE,
} from '../shared/constants.ts';
import { tileIndex, tileX, tileY } from '../shared/grid.ts';
import { daysPerYear } from '../sim/seasons.ts';
import type { SimCommand, SimEvent } from '../shared/messages.ts';
import {
  DisasterKind,
  PlantType,
  RoadLane,
  Terrain,
  TileType,
  POLICY_IDS,
  Zone,
  type GlobalStats,
  type SaveGame,
} from '../shared/types.ts';
import { addDamage } from '../sim/disasters.ts';
import { placePlant } from '../sim/energy.ts';
import { scenarioDef } from '../sim/scenarios/registry.ts';
import { SimEngine } from '../sim/engine.ts';
import { discoverGeothermalFields } from '../sim/geothermal.ts';
import { buildPowerLines } from '../sim/powerLines.ts';
import { isCoastalSea } from '../sim/sea.ts';
import { markDirty, slopeAt, slopeCostMultiplier } from '../sim/state.ts';
import { createMemoryStorage } from '../storage/memory.ts';
import type { SaveSummary } from '../storage/storage.ts';
import { dayOfTick, populationOfSave } from '../storage/summary.ts';
import { DIFFICULTIES } from '../ui/newGame.ts';
import { TileMirror } from './tileMirror.ts';
import {
  callTool,
  createAgentSaves,
  createAgentTools,
  MAX_ADVANCE_DAYS,
  type AgentContext,
  type AgentTool,
  type NewCityOptions,
} from './tools.ts';

const SIZE = 24;
/** Share codes only carry the selectable map sizes. */
const SHARE_SIZE = MAP_SIZES[0];

/** Drives the tools against an in-process engine, mimicking the worker. */
function createHarness(
  seed = 11,
  sandbox = false,
  size = SIZE,
): {
  ctx: AgentContext;
  tools: AgentTool[];
  engine: SimEngine;
  newCities: NewCityOptions[];
  storage: ReturnType<typeof createMemoryStorage>;
  /** Saves `load_save` made the running city, in order. */
  loaded: SaveGame[];
  startedScenarios: string[];
  call: (name: string, input?: unknown) => Promise<Record<string, unknown>>;
} {
  const engine = new SimEngine(seed, size);
  engine.applyCommand({ type: 'init', seed, size, ...(sandbox ? { sandbox: true } : {}) });
  const tiles = new TileMirror(size);
  let stats: GlobalStats | null = null;
  const absorb = (event: SimEvent | null): void => {
    if (!event || event.type !== 'tick') return;
    tiles.applyDiffs(event.diffs);
    stats = event.stats;
  };
  absorb(engine.tick());
  const newCities: NewCityOptions[] = [];
  let clock = 1_000;
  const storage = createMemoryStorage(() => clock++);
  const loaded: SaveGame[] = [];
  let nextId = 1;
  const startedScenarios: string[] = [];
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
      return event && event.type === 'lifetimeData'
        ? { samples: event.samples, seasonOriginDay: event.seasonOriginDay }
        : { samples: [], seasonOriginDay: 0 };
    },
    startNewCity(options) {
      newCities.push(options);
    },
    saves: createAgentSaves({
      storage,
      async snapshot() {
        const [event] = engine.applyCommand({ type: 'requestSave' });
        if (!event || event.type !== 'saveData') throw new Error('no save data');
        return event.save;
      },
      population: () => stats?.population ?? null,
      async replaceCity(save) {
        loaded.push(save);
      },
      newId: () => `save-${nextId++}`,
      shareBaseUrl: () => 'http://test/',
    }),
    startScenario(id) {
      startedScenarios.push(id);
    },
  };
  const tools = createAgentTools(ctx);
  return {
    ctx,
    tools,
    engine,
    newCities,
    storage,
    loaded,
    startedScenarios,
    call: (name, input = {}) => callTool(tools, name, input) as Promise<Record<string, unknown>>,
  };
}

function findLand(engine: SimEngine, minX = 2): { x: number; y: number } {
  const { size, layers } = engine.state;
  const { terrain, elevation, forest } = layers;
  for (let y = 2; y < size - 2; y++) {
    for (let x = minX; x < size - 2; x++) {
      // A 6x3 all-land block gives room for road + zone tests. The
      // one-tile margin around it must be land at the same level, so no
      // tile is sloped (slope surcharges would skew cost expectations).
      let ok = true;
      const level = elevation[tileIndex(x, y, size)];
      for (let dy = -1; dy < 4 && ok; dy++) {
        for (let dx = -1; dx < 7; dx++) {
          const index = tileIndex(x + dx, y + dy, size);
          if (terrain[index] !== Terrain.Land || elevation[index] !== level) {
            ok = false;
            break;
          }
        }
      }
      if (ok) {
        // Clear any woods so felling fees don't skew the cost checks either.
        for (let dy = -1; dy < 4; dy++) {
          for (let dx = -1; dx < 7; dx++) forest[tileIndex(x + dx, y + dy, size)] = 0;
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
      'get_annual_report',
      'get_disasters',
      'build_road',
      'build_power_line',
      'build_bus_stop',
      'build_overpass',
      'build_lanes',
      'build_rail',
      'paint_zone',
      'place_plant',
      'bulldoze',
      'undo',
      'set_speed',
      'set_tax_rate',
      'set_smart_meter_rollout',
      'set_demand_response',
      'plant_forest',
      'set_market_trading',
      'buy_insulation',
      'set_policy',
      'take_credit',
      'repay_credit',
      'set_grid_fee',
      'advance_time',
      'save_game',
      'list_saves',
      'save_to_slot',
      'load_save',
      'delete_save',
      'share_city',
      'open_shared_city',
      'start_new_city',
      'search_places',
      'import_town',
      'list_scenarios',
      'start_scenario',
    ]);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe('object');
    }
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name);
    expect(readOnly).toHaveLength(13);
    expect(readOnly).toContain('share_city');
    const consequential = tools.filter((t) => t.annotations?.consequentialHint).map((t) => t.name);
    expect(consequential).toEqual(
      expect.arrayContaining(['take_credit', 'repay_credit', 'set_grid_fee']),
    );
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
    expect(catalog.speeds).toEqual([0, 1, 3, 6]);
    const plants = catalog.plants as Array<{ name: string; cost: number; placement: string }>;
    expect(plants.map((p) => p.name)).toContain('pumped_storage');
    const solar = plants.find((p) => p.name === 'solar')!;
    expect(solar.cost).toBe(BALANCE.costs.plant[PlantType.SolarFarm]);
    expect(plants.find((p) => p.name === 'run_of_river')!.placement).toContain('river');
    // The link capacities come from BALANCE, in the placement rule and in
    // the shared tooltip text alike — no figure spelled out in prose, and
    // no unfilled placeholder reaching the agent.
    const substation = plants.find((p) => p.name === 'substation') as unknown as {
      placement: string;
      description: string;
    };
    expect(substation.placement).toContain(`${BALANCE.market.importCapacity} in`);
    expect(substation.placement).toContain(`${BALANCE.market.exportCapacity} out`);
    expect(substation.description).toContain(`${BALANCE.market.importCapacity} in`);
    expect(substation.description).not.toContain('{');
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

  it('get_lifetime_stats returns one sample per day with the energy figures', async () => {
    const { call } = createHarness();
    expect(await call('get_lifetime_stats')).toMatchObject({ days: 0, samples: [] });
    await call('advance_time', { days: 1 });
    const after = (await call('get_lifetime_stats')) as {
      days: number;
      samples: Record<string, number>[];
    };
    expect(after.days).toBe(1);
    expect(after.samples[0]).toHaveProperty('deficitTicks');
    expect(after.samples[0]).toHaveProperty('gridImport');
    expect(after.samples[0]).toHaveProperty('biogas');
    expect(after.samples[0]).toHaveProperty('money');
  });

  it('get_annual_report folds the days into years, the last one running', async () => {
    const { call } = createHarness();
    expect(await call('get_annual_report')).toMatchObject({
      daysPerYear: daysPerYear(),
      years: [],
    });
    await call('advance_time', { days: 2 });
    const report = (await call('get_annual_report')) as { years: Record<string, unknown>[] };
    expect(report.years).toHaveLength(1);
    expect(report.years[0]).toMatchObject({ year: 1, days: 2, complete: false });
    expect(report.years[0]).toHaveProperty('moneyEnd');
    const share = report.years[0].renewableShare as number;
    expect(share).toBeGreaterThanOrEqual(0);
    expect(share).toBeLessThanOrEqual(1);
  });

  it('get_annual_report derives the renewable share from renewable, biogas and import', async () => {
    const { call, engine } = createHarness();
    // Fuel-cell-heavy day: renewable above avgGeneration (fuel cells are not generation).
    engine.state.lifetime.samples = [0, 1].map((day) => ({
      day,
      population: 10,
      jobs: 5,
      happiness: 0.5,
      avgGeneration: 2,
      avgConsumption: 3,
      money: 1000,
      renewable: 3,
      biogas: 0.5,
      gridImport: 1,
      gridExport: 0,
      curtailment: 0,
      deficitTicks: 0,
    }));
    const { samples } = (await call('get_lifetime_stats')) as {
      samples: { renewable: number; biogas: number; gridImport: number }[];
    };
    const total = (pick: (s: (typeof samples)[number]) => number) =>
      samples.reduce((acc, s) => acc + pick(s), 0);
    const renewable = total((s) => s.renewable);
    const expected = renewable / (renewable + total((s) => s.biogas) + total((s) => s.gridImport));
    expect(expected).toBeCloseTo(3 / 4.5, 6);
    const report = (await call('get_annual_report')) as { years: { renewableShare: number }[] };
    expect(report.years[0].renewableShare).toBeCloseTo(expected, 3);
  });

  it('get_annual_report drops money in a sandbox city', async () => {
    const { call } = createHarness(11, true);
    await call('advance_time', { days: 1 });
    const report = (await call('get_annual_report')) as { years: Record<string, unknown>[] };
    expect(report.years[0]).not.toHaveProperty('moneyEnd');
    expect(report.years[0]).not.toHaveProperty('moneyDelta');
  });

  it('get_disasters reports intensity, warnings and active events', async () => {
    const { call, engine } = createHarness();
    engine.state.disasters.pending.push({
      id: 5,
      kind: DisasterKind.Flood,
      severity: 0.8,
      startTick: engine.state.tick + 120,
      endTick: engine.state.tick + 400,
      origin: 0,
      tiles: [0, 1],
      intensity: [1, 2],
    });
    // Pushing straight onto engine.state (bypassing the normal schedule()
    // path) marks nothing dirty, so the harness's cached GlobalStats would
    // still show no pending events. inspect_tile is the one tool whose
    // sendCommand branch forces a fresh, un-ticked snapshot (see the
    // harness's sendCommand above) — exactly what's needed here, since
    // advancing a tick would shift ticksAway off the expected 120.
    await call('inspect_tile', { x: 0, y: 0 });
    const result = (await call('get_disasters')) as {
      intensity: number;
      warnings: Array<{ kind: string; ticksAway: number; tiles: number }>;
      active: unknown[];
      damagedTiles: number;
    };
    expect(result.intensity).toBeGreaterThan(0);
    expect(result.warnings[0].kind).toBe('flood');
    expect(result.warnings[0].ticksAway).toBe(120);
    expect(result.active).toHaveLength(0);
    expect(result.damagedTiles).toBe(0);
  });

  it('find_tiles finds damaged tiles', async () => {
    const { call, engine } = createHarness();
    const index = tileIndex(5, 5, SIZE);
    addDamage(engine.state, index, 50);
    // addDamage marks the tile dirty itself; the tick carries it into the mirror.
    await call('advance_time', { ticks: 1 });
    const found = (await call('find_tiles', { kind: 'damaged' })) as {
      tiles: Array<{ x: number; y: number }>;
    };
    expect(found.tiles).toContainEqual({ x: 5, y: 5 });
  });

  it('inspect_tile reports the damage', async () => {
    const { call, engine } = createHarness();
    addDamage(engine.state, tileIndex(6, 6, SIZE), 42);
    // No advance_time here: a real tick also runs repairStep, which would
    // heal a point straight back off before this assertion ever sees it.
    // inspect_tile's own sendCommand already forces an un-ticked snapshot
    // (see 'get_disasters' above), which is all the diff needs to reach
    // both the tile mirror and the inspected-tile figures.
    const info = (await call('inspect_tile', { x: 6, y: 6 })) as { damage: number };
    expect(info.damage).toBe(42);
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

    // Spent grant pot: the plant costs its gross price.
    engine.state.finance.grantUsedThisYear = BALANCE.finance.grant.annualPot;
    // An un-ticked snapshot refreshes the stats the grant is measured against.
    await call('inspect_tile', { x, y });
    const plant = await call('place_plant', { plant: 'solar', x, y: y + 2 });
    expect(plant).toMatchObject({
      ok: true,
      spent: priced(BALANCE.costs.plant[PlantType.SolarFarm], y + 2, 1),
      grant: 0,
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

  it('paints the industrial zone and reports it on the map and in the overview', async () => {
    const { call, engine } = createHarness();
    const { x, y } = findLand(engine);
    await call('build_road', { from: { x, y }, to: { x: x + 5, y } });
    const result = await call('paint_zone', {
      zone: 'industrial',
      from: { x, y: y + 1 },
      to: { x: x + 5, y: y + 1 },
    });
    expect(result).toMatchObject({ ok: true });
    expect(engine.state.layers.zone[tileIndex(x + 2, y + 1, SIZE)]).toBe(Zone.Industrial);
    const map = await call('get_map');
    expect((map.rows as string[])[y + 1]).toContain('i');
    const overview = await call('get_game_overview');
    expect(typeof (overview.demand as { industrial: number }).industrial).toBe('number');
    expect((overview.deliveries as { factories: number }).factories).toBe(0);
    expect((overview.deliveries as { localShare: number }).localShare).toBe(1);
    expect((overview.budgetPerTick as { goodsImport: number }).goodsImport).toBe(0);
    const found = await call('find_tiles', { kind: 'factory', near: { x: x + 2, y: y + 1 } });
    expect(found.tiles).toHaveLength(0);
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
    expect(await call('paint_zone', { zone: 'farmland', from: { x: 1, y: 1 } })).toMatchObject({
      ok: false,
    });
    expect(await call('place_plant', { plant: 'coal', x: 1, y: 1 })).toMatchObject({ ok: false });
    expect(await call('place_plant', { plant: 'solar', x: 1.5, y: 1 })).toMatchObject({
      ok: false,
    });
    expect(await call('set_speed', { speed: 2 })).toMatchObject({ ok: false });
    expect(await call('set_tax_rate', { rate: 'high' })).toMatchObject({ ok: false });
    expect(await call('set_smart_meter_rollout', { active: 'yes' })).toMatchObject({ ok: false });
    expect(await call('set_demand_response', { active: 'yes' })).toMatchObject({ ok: false });
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
    engine.state.finance.grantUsedThisYear = BALANCE.finance.grant.annualPot;
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
    expect(await call('set_speed', { speed: 6 })).toMatchObject({ ok: true, speed: 6 });
    expect(engine.state.speed).toBe(6);
    expect(await call('set_tax_rate', { rate: 0.9 })).toMatchObject({
      ok: true,
      taxRate: BALANCE.tax.maxRate,
    });
    expect(await call('set_smart_meter_rollout', { active: true })).toMatchObject({ ok: true });
    expect(engine.state.smartMeters.active).toBe(true);
    const overview = await call('get_game_overview');
    expect(overview.smartMeters).toMatchObject({ active: true });
    expect(overview).not.toHaveProperty('smartCharging');
    expect(await call('set_demand_response', { active: true })).toMatchObject({ ok: true });
    expect(engine.state.demandResponse.active).toBe(true);
    const contracted = await call('get_game_overview');
    expect(contracted.demandResponse).toMatchObject({ active: true, contractedBuildings: 0 });
    expect((contracted.demandResponse as Record<string, unknown>).callHoursLeft).toBe(
      BALANCE.demandResponse.maxCallHoursPerDay,
    );
    // Advance one history-sample window so a sample exists to inspect.
    await call('advance_time', { ticks: TICKS_PER_HISTORY_SAMPLE });
    const report = await call('get_energy_report');
    expect((report.history as Array<Record<string, unknown>>)[0]).toHaveProperty('unshifted');
    expect(report.consumption).toHaveProperty('shed');
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

  it('save_to_slot creates named saves that list_saves reports', async () => {
    const { call, engine, storage } = createHarness();
    expect(await call('list_saves')).toEqual({ saves: [] });
    const first = await call('save_to_slot', { name: '  Testville  ' });
    expect(first).toMatchObject({
      ok: true,
      save: {
        id: 'save-1',
        name: 'Testville',
        day: 1,
        money: BALANCE.startingMoney,
        size: SIZE,
        compatible: true,
      },
    });
    // Without a name the save gets the UI's default name.
    const second = await call('save_to_slot');
    expect(second).toMatchObject({ ok: true, save: { id: 'save-2', name: 'Voltopia – day 1' } });
    const { saves } = (await call('list_saves')) as { saves: { id: string }[] };
    expect(saves.map((save) => save.id)).toEqual(['save-2', 'save-1']);
    expect((await storage.load('save-1'))?.tick).toBe(engine.state.tick);
    // The autosave is never a slot.
    expect((await storage.list()).some((save) => save.id === 'autosave')).toBe(false);
  });

  it('save_to_slot with an id overwrites and keeps the name unless given', async () => {
    const { call, engine, storage } = createHarness();
    await call('save_to_slot', { name: 'Testville' });
    await call('set_speed', { speed: 0 });
    await call('advance_time', { ticks: 5 });
    const overwritten = await call('save_to_slot', { id: 'save-1' });
    expect(overwritten).toMatchObject({ ok: true, save: { id: 'save-1', name: 'Testville' } });
    expect((await storage.load('save-1'))?.tick).toBe(engine.state.tick);
    const renamed = await call('save_to_slot', { id: 'save-1', name: 'Testville 2' });
    expect(renamed).toMatchObject({ ok: true, save: { id: 'save-1', name: 'Testville 2' } });
    expect(await storage.list()).toHaveLength(1);
  });

  it('save_to_slot rejects unknown ids and bad names', async () => {
    const { call, storage } = createHarness();
    for (const input of [
      { id: 'nope' },
      { id: 'autosave' },
      { id: 7 },
      { name: '   ' },
      { name: 3 },
      { name: 'x'.repeat(81) },
    ]) {
      expect(await call('save_to_slot', input)).toMatchObject({
        ok: false,
        error: 'invalidInput',
      });
    }
    expect(await storage.list()).toEqual([]);
  });

  it('load_save replaces the city with a listed, compatible save', async () => {
    const { call, engine, loaded, storage } = createHarness();
    await call('save_to_slot', { name: 'Testville' });
    const result = await call('load_save', { id: 'save-1' });
    expect(result).toMatchObject({ ok: true, id: 'save-1', name: 'Testville' });
    expect(loaded).toHaveLength(1);
    expect(loaded[0].tick).toBe(engine.state.tick);

    expect(await call('load_save', { id: 'nope' })).toMatchObject({
      ok: false,
      error: 'invalidInput',
    });
    expect(await call('load_save')).toMatchObject({ ok: false, error: 'invalidInput' });

    const old = await storage.load('save-1');
    await storage.save({ ...old!, version: old!.version - 1 }, 'old', 'Old city');
    expect(await call('load_save', { id: 'old' })).toMatchObject({
      ok: false,
      error: 'incompatibleSave',
    });
    expect(loaded).toHaveLength(1);
  });

  it('delete_save removes a listed save and rejects unknown ids', async () => {
    const { call, storage } = createHarness();
    await call('save_to_slot', { name: 'Testville' });
    expect(await call('delete_save', { id: 'save-1' })).toEqual({
      ok: true,
      id: 'save-1',
      name: 'Testville',
    });
    expect(await storage.list()).toEqual([]);
    expect(await call('delete_save', { id: 'save-1' })).toMatchObject({
      ok: false,
      error: 'invalidInput',
    });
  });

  it('share_city packs the running city into a link that open_shared_city adds as a save', async () => {
    const { call, engine, loaded, storage } = createHarness(11, false, SHARE_SIZE);
    const { x, y } = findLand(engine);
    await call('build_road', { from: { x, y }, to: { x: x + 5, y } });
    await call('paint_zone', {
      from: { x, y: y + 1 },
      to: { x: x + 5, y: y + 1 },
      zone: 'residential',
    });
    await call('advance_time', { days: 1 });
    const [event] = engine.applyCommand({ type: 'requestSave' });
    if (!event || event.type !== 'saveData') throw new Error('no save data');
    const original = event.save;

    const shared = (await call('share_city')) as { ok: boolean; url: string; bytes: number };
    expect(shared.ok).toBe(true);
    expect(shared.url.startsWith('http://test/#city=')).toBe(true);
    expect(shared.bytes).toBe(shared.url.length);

    const opened = await call('open_shared_city', { url: `  ${shared.url}  ` });
    const today = new Date().toISOString().slice(0, 10);
    expect(opened).toMatchObject({
      ok: true,
      id: 'save-1',
      name: `Shared city – ${today}`,
      save: { id: 'save-1', size: SHARE_SIZE },
    });
    const { saves } = (await call('list_saves')) as { saves: SaveSummary[] };
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({
      id: 'save-1',
      size: SHARE_SIZE,
      day: dayOfTick(original.tick),
      population: populationOfSave(original),
      compatible: true,
    });
    // Opening only adds a save: the running city is untouched.
    expect(loaded).toEqual([]);

    expect(await call('load_save', { id: 'save-1' })).toMatchObject({ ok: true });
    expect(loaded).toHaveLength(1);
    const city = loaded[0];
    for (const key of Object.keys(original) as (keyof SaveGame)[]) {
      if (key === 'layers' || key === 'lifetime') continue;
      expect(city[key], key).toEqual(original[key]);
    }
    expect(city.lifetime).toBeUndefined();
    for (const [name, layer] of Object.entries(original.layers)) {
      const copy = city.layers[name as keyof SaveGame['layers']];
      expect(new Uint8Array(copy!), name).toEqual(new Uint8Array(layer));
    }
    expect((await storage.load('save-1'))?.tick).toBe(original.tick);
  });

  it('open_shared_city also takes a bare code and rejects garbage', async () => {
    const { call } = createHarness(11, false, SHARE_SIZE);
    const { url } = (await call('share_city')) as { url: string };
    const code = url.slice(url.indexOf('#city=') + '#city='.length);
    expect(await call('open_shared_city', { url: code })).toMatchObject({ ok: true });
    for (const url of ['hello', 'http://test/#city=', 'http://test/#city=!!!not-a-code!!!']) {
      const result = await call('open_shared_city', { url });
      expect(result, url).toMatchObject({ ok: false, error: 'invalidShareLink' });
      expect(['format', 'version', 'corrupt', 'tooLarge']).toContain(result.reason);
    }
    expect(
      await call('open_shared_city', { url: 'http://test/#city=AAAAAAAAAAAAAAAAAAAA' }),
    ).toMatchObject({ ok: false, error: 'invalidShareLink' });
    expect(await call('open_shared_city', {})).toMatchObject({ ok: false, error: 'invalidInput' });
    expect((await call('list_saves')).saves).toHaveLength(1);
  });

  it('share_city refuses while a scenario runs', async () => {
    const { call, engine, ctx } = createHarness();
    engine.applyCommand({ type: 'init', seed: 1, size: 16, scenario: 'island' });
    await ctx.waitForTick(ctx.getStats()!.tick + 1);
    expect(await call('share_city')).toMatchObject({ ok: false, error: 'scenarioRunning' });
  });

  it('start_new_city hands validated options to the host', async () => {
    const { call, newCities } = createHarness();
    const result = await call('start_new_city', { size: 48, difficulty: 'hard', seed: 7 });
    expect(result).toMatchObject({ ok: true, size: 48, difficulty: 'hard', seed: 7 });
    // Disaster intensity defaults to "normal" (scale 1) when the caller
    // does not choose one, exactly like the new-game dialog.
    expect(newCities).toEqual([{ size: 48, startingMoney: 15_000, seed: 7, disasterScale: 1 }]);
    await call('start_new_city');
    expect(newCities[1]).toEqual({
      size: 64,
      startingMoney: BALANCE.startingMoney,
      seed: null,
      disasterScale: 1,
    });
  });

  it('start_new_city maps a chosen disaster level to the host options', async () => {
    const { call, newCities } = createHarness();
    const result = await call('start_new_city', { disasters: 'harsh' });
    expect(result).toMatchObject({ ok: true, disasters: 'harsh' });
    expect(newCities[0]).toMatchObject({ disasterScale: 1.6 });

    await call('start_new_city', { disasters: 'off' });
    expect(newCities[1]).toMatchObject({ disasterScale: 0 });

    expect(await call('start_new_city', { disasters: 'catastrophic' })).toMatchObject({
      ok: false,
      error: 'invalidInput',
    });
  });

  it('start_new_city passes a sandbox city to the host', async () => {
    const { call, newCities } = createHarness();
    const result = await call('start_new_city', { sandbox: true });
    expect(result).toMatchObject({ ok: true, sandbox: true, disasters: 'off' });
    // Disasters default to off in a sandbox, but stay a free choice.
    expect(newCities[0]).toEqual({
      size: 64,
      startingMoney: BALANCE.startingMoney,
      seed: null,
      disasterScale: 0,
      sandbox: true,
    });
    await call('start_new_city', { sandbox: true, disasters: 'mild' });
    expect(newCities[1]).toMatchObject({ disasterScale: 0.5, sandbox: true });
    expect(await call('start_new_city', { sandbox: 'yes' })).toMatchObject({
      ok: false,
      error: 'invalidInput',
    });
  });

  it('start_new_city takes difficulty money and sizes from the new-game dialog', async () => {
    const { call, newCities } = createHarness();
    await call('start_new_city', { difficulty: 'easy' });
    expect(newCities[0]).toMatchObject({ startingMoney: DIFFICULTIES[0].startingMoney });
    expect(await call('start_new_city', { size: 128 })).toMatchObject({ ok: true, size: 128 });
    expect(newCities[1]).toMatchObject({ size: 128 });
  });

  it('reports a sandbox city in the overview, build results and credit refusals', async () => {
    const { call, engine } = createHarness(11, true);
    expect(await call('get_game_overview')).toMatchObject({ sandbox: true });
    const { x, y } = findLand(engine);
    const road = await call('build_road', { from: { x, y }, to: { x: x + 5, y } });
    expect(road).toMatchObject({ ok: true, sandbox: true });
    expect(road).not.toHaveProperty('spent');
    expect(await call('take_credit', { kind: 'loan', amount: 5000 })).toMatchObject({
      ok: false,
      error: 'sandbox',
    });
  });

  it('marks sandbox in advance_time and leaves money out of lifetime samples', async () => {
    const { call } = createHarness(11, true);
    const advanced = await call('advance_time', { days: 1 });
    expect(advanced).toMatchObject({ ok: true, sandbox: true });
    expect(advanced).not.toHaveProperty('money');
    const lifetime = (await call('get_lifetime_stats')) as { samples: object[] };
    expect(lifetime.samples.length).toBeGreaterThan(0);
    for (const sample of lifetime.samples) expect(sample).not.toHaveProperty('money');
  });

  it('reports money in advance_time and lifetime samples outside sandbox', async () => {
    const { call } = createHarness();
    const advanced = await call('advance_time', { days: 1 });
    expect(advanced).toHaveProperty('money');
    expect(advanced).not.toHaveProperty('sandbox');
    const lifetime = (await call('get_lifetime_stats')) as { samples: object[] };
    expect(lifetime.samples[0]).toHaveProperty('money');
  });

  it('reports a normal city as not sandbox', async () => {
    const { call } = createHarness();
    expect(await call('get_game_overview')).toMatchObject({ sandbox: false });
  });

  it('list_scenarios names every shipped scenario with its conditions', async () => {
    const { call } = createHarness();
    const result = (await call('list_scenarios', {})) as {
      scenarios: {
        id: string;
        win: unknown[];
        disasterScale: number;
        rules: { importCapacityFactor: number; startSeason: string };
      }[];
    };
    expect(result.scenarios.map((s) => s.id)).toEqual([
      'island',
      'dunkelflaute',
      'oldTown',
      'stormSeason',
    ]);
    expect(result.scenarios[0].win.length).toBeGreaterThan(0);
    const byId = new Map(result.scenarios.map((s) => [s.id, s]));
    expect(byId.get('island')!.rules).toEqual(scenarioDef('island').rules);
    expect(byId.get('island')!.rules.importCapacityFactor).toBe(0);
    expect(byId.get('dunkelflaute')!.rules.startSeason).toBe(
      scenarioDef('dunkelflaute').rules.startSeason,
    );
    expect(byId.get('stormSeason')!.disasterScale).toBe(
      BALANCE.scenarios.stormSeason.disasterScale,
    );
  });

  it('set_policy toggles an ordinance and the overview reports it', async () => {
    const { call } = createHarness();
    await call('set_policy', { id: 'speedLimit', active: true });
    const overview = await call('get_game_overview', {});
    expect((overview.policies as { active: Record<string, boolean> }).active.speedLimit).toBe(true);
    expect((overview.policies as { dailyCost: number }).dailyCost).toBe(
      BALANCE.policies.speedLimit.dailyCost,
    );
    const bad = await call('set_policy', { id: 'nope', active: true });
    expect(bad).toMatchObject({ ok: false, error: 'invalidInput' });
    const missing = await call('set_policy', { id: 'speedLimit' });
    expect(missing).toMatchObject({ ok: false, error: 'invalidInput' });
  });

  it('take_credit borrows, the overview shows the debt, repay_credit pays it off', async () => {
    const { call } = createHarness();
    const amount = BALANCE.finance.credit.loan.amounts[0];
    const taken = await call('take_credit', { kind: 'loan', amount });
    expect(taken).toMatchObject({
      ok: true,
      kind: 'loan',
      amount,
      money: BALANCE.startingMoney + amount,
      debt: amount,
      rating: 'A',
    });
    const credit = taken.credit as { id: number; ratePerYear: number; termDays: number };
    expect(credit.ratePerYear).toBe(BALANCE.finance.credit.loan.ratePerYear);
    expect(credit.termDays).toBe(BALANCE.finance.credit.loan.termDays);

    const finance = (await call('get_game_overview')).finance as {
      debt: number;
      rating: string;
      credits: Array<{ id: number; kind: string; outstanding: number; repayable: boolean }>;
      offers: Array<{ kind: string }>;
      gridFee: number;
      grantRemaining: number;
    };
    expect(finance.debt).toBe(amount);
    expect(finance.rating).toBe('A');
    expect(finance.credits).toEqual([
      expect.objectContaining({
        id: credit.id,
        kind: 'loan',
        outstanding: amount,
        repayable: true,
      }),
    ]);
    expect(finance.offers.map((o) => o.kind)).toEqual(['loan', 'bond']);
    expect(finance.gridFee).toBe(0);
    expect(finance.grantRemaining).toBe(BALANCE.finance.grant.annualPot);

    const repaid = await call('repay_credit', { id: credit.id });
    expect(repaid).toMatchObject({ ok: true, debt: 0 });
    expect(repaid.repaid).toBe(amount);
    expect(await call('repay_credit', { id: credit.id })).toMatchObject({
      ok: false,
      error: 'unknownCredit',
    });
  });

  it('take_credit and repay_credit reject bad input and refused credit', async () => {
    const { call, engine } = createHarness();
    expect(await call('take_credit', { kind: 'loan', amount: 1234 })).toMatchObject({
      ok: false,
      error: 'invalidAmount',
    });
    expect(await call('take_credit', { kind: 'mortgage', amount: 5_000 })).toMatchObject({
      ok: false,
      error: 'invalidInput',
    });
    expect(await call('take_credit', { kind: 'loan' })).toMatchObject({
      ok: false,
      error: 'invalidInput',
    });
    // A new city's income base caps the debt below the smallest bond.
    expect(
      await call('take_credit', { kind: 'bond', amount: BALANCE.finance.credit.bond.amounts[0] }),
    ).toMatchObject({ ok: false, error: 'creditLimit' });
    expect(await call('repay_credit', { id: 'x' })).toMatchObject({
      ok: false,
      error: 'invalidInput',
    });
    engine.state.finance.credits.push({
      id: 99,
      kind: 'bond',
      principal: 50_000,
      outstanding: 50_000,
      ratePerYear: 0.05,
      startTick: 0,
      termTicks: TICKS_PER_DAY * 40,
    });
    expect(await call('repay_credit', { id: 99 })).toMatchObject({
      ok: false,
      error: 'notRepayable',
    });
  });

  it('set_grid_fee clamps to the allowed range and reports the fee', async () => {
    const { call } = createHarness();
    expect(await call('set_grid_fee', { rate: 0.005 })).toMatchObject({ ok: true, gridFee: 0.005 });
    expect(await call('set_grid_fee', { rate: 1 })).toMatchObject({
      ok: true,
      gridFee: BALANCE.finance.gridFee.maxRate,
    });
    const overview = await call('get_game_overview');
    expect((overview.finance as { gridFee: number }).gridFee).toBe(BALANCE.finance.gridFee.maxRate);
    expect(await call('set_grid_fee', { rate: -1 })).toMatchObject({ ok: true, gridFee: 0 });
    expect(await call('set_grid_fee', { rate: 'high' })).toMatchObject({
      ok: false,
      error: 'invalidInput',
    });
  });

  it('get_build_catalog lists credit products, grant shares and the grid-fee range', async () => {
    const { call } = createHarness();
    const catalog = await call('get_build_catalog');
    const finance = catalog.finance as {
      credit: Record<string, { amounts: number[]; ratePerYear: number; termDays: number }>;
      rating: { spread: Record<string, number | null> };
      grant: { annualPot: number; shareByPlant: Record<string, number> };
      gridFee: { maxRate: number; happinessWeight: number };
    };
    expect(finance.credit.loan.amounts).toEqual([...BALANCE.finance.credit.loan.amounts]);
    expect(finance.credit.bond.termDays).toBe(BALANCE.finance.credit.bond.termDays);
    expect(finance.rating.spread).toEqual({ ...BALANCE.finance.rating.spread, D: null });
    expect(finance.grant.annualPot).toBe(BALANCE.finance.grant.annualPot);
    expect(finance.grant.shareByPlant.solar).toBe(
      BALANCE.finance.grant.shareByPlant[PlantType.SolarFarm],
    );
    expect(finance.grant.shareByPlant.biogas).toBeUndefined();
    expect(finance.gridFee.maxRate).toBe(BALANCE.finance.gridFee.maxRate);
    expect(finance.gridFee.happinessWeight).toBe(BALANCE.finance.gridFee.happinessWeight);
    const plants = catalog.plants as Array<{ name: string; grantShare: number }>;
    expect(plants.find((p) => p.name === 'battery')!.grantShare).toBe(
      BALANCE.finance.grant.shareByPlant[PlantType.Battery],
    );
    expect(plants.find((p) => p.name === 'biogas')!.grantShare).toBe(0);
  });

  it('place_plant reports the grant the pot paid', async () => {
    const { call, engine } = createHarness();
    const { x, y } = findLand(engine);
    const gross = BALANCE.costs.plant[PlantType.SolarFarm];
    const grant = Math.round(gross * BALANCE.finance.grant.shareByPlant[PlantType.SolarFarm]!);
    const result = await call('place_plant', { plant: 'solar', x, y });
    expect(result).toMatchObject({ ok: true, spent: gross - grant, grant });
  });

  it('place_plant never reports a negative grant when the pot refills for a new year', async () => {
    const { call, engine } = createHarness();
    const { x, y } = findLand(engine);
    // Last year's pot is spent; the stats still show it empty.
    engine.state.finance.grantUsedThisYear = BALANCE.finance.grant.annualPot;
    await call('inspect_tile', { x, y });
    // The year has moved on: placing rolls the pot over to full.
    engine.state.finance.grantYear = engine.state.season.year - 1;
    const result = await call('place_plant', { plant: 'biogas', x, y });
    expect(result).toMatchObject({ ok: true, grant: 0 });
    expect(engine.state.finance.grantUsedThisYear).toBe(0);
  });

  it('get_build_catalog lists the ordinances with their cost and effect', async () => {
    const { call } = createHarness();
    const catalog = await call('get_build_catalog', {});
    const policies = catalog.policies as Record<string, { dailyCost: number; happiness: number }>;
    expect(Object.keys(policies).sort()).toEqual([...POLICY_IDS].sort());
    expect(policies.speedLimit.dailyCost).toBe(BALANCE.policies.speedLimit.dailyCost);
  });

  it('start_scenario hands the id to the host and rejects unknown or missing ids', async () => {
    const { call, startedScenarios } = createHarness();
    expect(await call('start_scenario', { id: 'island' })).toMatchObject({ ok: true });
    expect(startedScenarios).toEqual(['island']);
    expect(await call('start_scenario', { id: 'nope' })).toMatchObject({
      ok: false,
      error: 'invalidInput',
    });
    expect(await call('start_scenario', {})).toMatchObject({ ok: false, error: 'invalidInput' });
    expect(startedScenarios).toEqual(['island']);
  });

  it('get_game_overview carries the scenario block when one runs', async () => {
    const { call, engine, ctx } = createHarness();
    expect((await call('get_game_overview', {})).scenario).toBeUndefined();
    engine.applyCommand({ type: 'init', seed: 1, size: 16, scenario: 'island' });
    await ctx.waitForTick(ctx.getStats()!.tick + 1);
    const overview = (await call('get_game_overview', {})) as {
      scenario: { conditions: object[]; endedDay?: number };
    };
    expect(overview.scenario).toMatchObject({
      id: 'island',
      status: 'running',
      day: 0,
      rules: { importCapacityFactor: 0, startSeason: 'spring' },
    });
    expect(overview.scenario.endedDay).toBeUndefined();
    expect(overview.scenario.conditions[0]).toHaveProperty('met');

    const run = engine.state.scenario!;
    run.status = 'failed';
    run.endedTick = engine.state.tick;
    await ctx.waitForTick(ctx.getStats()!.tick + 1);
    expect((await call('get_game_overview', {})).scenario).toMatchObject({
      status: 'failed',
      endedDay: 0,
    });
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

  it('build_lanes paints lanes along a path, reports rejections and shows up in inspect_tile', async () => {
    const { call, engine } = createHarness();
    engine.state.layers.elevation.fill(0);
    engine.state.money = 1e6;
    const { x, y } = findLand(engine);
    await call('build_road', { from: { x, y }, to: { x: x + 4, y } });
    const off = await call('build_lanes', {
      from: { x, y: y + 3 },
      to: { x: x + 2, y: y + 3 },
      kind: 'bike',
    });
    expect(off).toMatchObject({ ok: false, error: 'needsExistingRoad' });
    const bike = await call('build_lanes', { from: { x, y }, to: { x: x + 4, y }, kind: 'bike' });
    expect(bike).toMatchObject({ ok: true });
    expect(engine.state.layers.roadLane[tileIndex(x + 2, y, SIZE)]).toBe(RoadLane.Bike);
    const ped = await call('build_lanes', { tiles: [{ x: x + 2, y }], kind: 'pedestrian' });
    expect(ped).toMatchObject({ ok: true });
    const info = await call('inspect_tile', { x: x + 2, y });
    expect(info).toMatchObject({ lane: 'pedestrian' });
    const bad = await call('build_lanes', { tiles: [{ x: x + 2, y }], kind: 'tram' });
    expect(bad).toMatchObject({ ok: false });
  });

  it('build_overpass upgrades a level crossing and reports the rejection otherwise', async () => {
    const { call, engine } = createHarness();
    engine.state.layers.elevation.fill(0);
    engine.state.money = 1e6;
    const { x, y } = findLand(engine);
    await call('build_road', { from: { x, y }, to: { x, y: y + 4 } });
    await call('build_rail', { from: { x: x - 2, y: y + 2 }, to: { x: x + 2, y: y + 2 } });
    const plain = await call('build_overpass', { x, y });
    expect(plain).toMatchObject({ ok: false, error: 'needsLevelCrossing' });
    const built = await call('build_overpass', { x, y: y + 2 });
    expect(built).toMatchObject({ ok: true });
    expect(engine.state.layers.overpass[tileIndex(x, y + 2, SIZE)]).toBe(OVERPASS_LONG_RAMP_TILES);
    const info = await call('inspect_tile', { x, y: y + 2 });
    expect(info.rail).toMatchObject({ overpass: true });
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
    expect(overview.transit).toHaveProperty('walkRiders');
    expect(overview.transit).toHaveProperty('bikeRiders');
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

  it('places a substation, shows it as N on the overview map, and finds it by kind', async () => {
    const { call, engine } = createHarness();
    const { x, y } = findLand(engine);
    const result = await call('place_plant', { plant: 'substation', x, y });
    expect(result).toMatchObject({ ok: true });
    expect(engine.state.layers.plantType[tileIndex(x, y, SIZE)]).toBe(PlantType.Substation);

    const map = await call('get_map', { origin: { x, y }, width: 1, height: 1 });
    const rows = map.rows as string[];
    expect(rows[0]).toBe('N');

    const found = await call('find_tiles', { kind: 'substation' });
    expect(found.total).toBeGreaterThan(0);
    const tiles = found.tiles as Array<{ x: number; y: number }>;
    expect(tiles.some((t) => t.x === x && t.y === y)).toBe(true);
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

  it('builds a heat plant and a heat store, and reports the heat figures', async () => {
    const { call, engine } = createHarness();
    const { x, y } = findLand(engine);
    const plant = await call('place_plant', { plant: 'heat_plant', x, y });
    expect(plant).toMatchObject({ ok: true });
    expect(engine.state.layers.plantType[tileIndex(x, y, SIZE)]).toBe(PlantType.HeatPlant);
    // Neither a heat plant nor a heat store is a grid source on its own
    // (see SUPPLY_SOURCES in shared/plants.ts) — a wind turbine within
    // the supply ring puts both on a grid island, which the heat store's
    // capacity now requires to count toward the city-wide SoC figures.
    placePlant(engine.state, tileIndex(x, y + 2, SIZE), PlantType.WindTurbine);
    let sx = x + 2;
    const sy = y;
    expect(engine.state.layers.terrain[tileIndex(sx, sy, SIZE)]).toBe(Terrain.Land);
    let store = await call('place_plant', { plant: 'heat_store', x: sx, y: sy });
    if (!store.ok && (store as { error?: string }).error === 'tileOccupied') {
      sx = x + 3;
      expect(engine.state.layers.terrain[tileIndex(sx, sy, SIZE)]).toBe(Terrain.Land);
      store = await call('place_plant', { plant: 'heat_store', x: sx, y: sy });
    }
    expect(store).toMatchObject({ ok: true });
    // The grid (and so layers.island) is only recomputed by a real tick,
    // not by the flush a build command gets for immediate visual
    // feedback — advance one so the heat store's island membership is
    // current before the figures below are read.
    await call('advance_time', { ticks: 1 });
    // get_energy_report spreads EnergyStats as-is, so the new fields are there by name.
    const report = (await call('get_energy_report')) as Record<string, any>;
    expect(report.consumption).toHaveProperty('heatPumps');
    expect(report.heatCapacity).toBe(BALANCE.heat.storeCapacity);
    expect(report).toHaveProperty('heatCop');
    // get_game_overview hand-builds energyPerTick and gains a heat block.
    const overview = (await call('get_game_overview')) as Record<string, any>;
    expect(overview.energyPerTick.consumption).toHaveProperty('heatPumps');
    expect(overview.energyPerTick.heat).toMatchObject({ capacity: BALANCE.heat.storeCapacity });
    expect(overview.energyPerTick.heat).toHaveProperty('cop');
  });

  it('inspect_tile reports district heating on a plant and on a building', async () => {
    const { call, engine } = createHarness();
    const { x, y } = findLand(engine);
    await call('place_plant', { plant: 'heat_plant', x, y });
    const info = (await call('inspect_tile', { x, y })) as Record<string, any>;
    expect(info.ok).toBe(true);
    expect(info.heatPlant).toMatchObject({ reach: expect.any(Number), served: expect.any(Number) });
    expect(info).toHaveProperty('heated');
  });

  it('the overview map draws heat plants and stores with their own glyphs', async () => {
    const { call, engine } = createHarness();
    const { x, y } = findLand(engine);
    await call('place_plant', { plant: 'heat_plant', x, y });
    const map = (await call('get_map', { layer: 'overview' })) as Record<string, any>;
    expect(map.rows[y][x]).toBe('Q');
    expect(map.legend).toContain('Q heat plant');
  });

  it('find_tiles isolated_plant lists supply plants that serve nothing', async () => {
    const { call, engine } = createHarness();
    // (2,2) is too steep for this seed's terrain; (2,22) is flat, empty
    // land far from any building or the wired turbine below.
    const lone = tileIndex(2, 22, SIZE);
    const wired = tileIndex(20, 20, SIZE);
    engine.state.money = 1e9;
    placePlant(engine.state, lone, PlantType.WindTurbine);
    placePlant(engine.state, wired, PlantType.WindTurbine);
    buildPowerLines(engine.state, [tileIndex(21, 20, SIZE), tileIndex(22, 20, SIZE)]);
    // The tool mirror only sees tiles through tick diffs: advance one tick.
    await call('advance_time', { ticks: 1 });
    const found = await call('find_tiles', { kind: 'isolated_plant' });
    const coords = (found.tiles as Array<{ x: number; y: number }>).map((t) => `${t.x},${t.y}`);
    expect(coords).toContain('2,22');
    expect(coords).not.toContain('20,20');
  });
});

describe('district grids', () => {
  it('overview and energy report list islands; find_tiles names islands without a substation', async () => {
    const { call, engine } = createHarness();
    engine.state.money = 1e9;
    const { terrain, tileType, density } = engine.state.layers;
    const buildable = (x: number, y: number): boolean => {
      if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return false;
      const i = tileIndex(x, y, SIZE);
      return (
        terrain[i] === Terrain.Land &&
        tileType[i] === TileType.Empty &&
        density[i] === 0 &&
        slopeAt(engine.state, i) <= BALANCE.terrain.maxBuildSlope
      );
    };
    // Two land tiles far enough apart (beyond the line supply radius on
    // each side) that their plants never share a ring and so land on two
    // separate islands.
    const land: Array<{ x: number; y: number }> = [];
    for (let y = 0; y < SIZE && land.length < 2; y++) {
      for (let x = 0; x < SIZE && land.length < 2; x++) {
        if (!buildable(x, y)) continue;
        if (land.length === 1) {
          const [first] = land;
          if (Math.max(Math.abs(first.x - x), Math.abs(first.y - y)) < 7) continue;
        }
        land.push({ x, y });
      }
    }
    expect(land.length).toBe(2);
    const [a, b] = land;

    const wind = await call('place_plant', { plant: 'wind', x: a.x, y: a.y });
    expect(wind).toMatchObject({ ok: true });
    const solar = await call('place_plant', { plant: 'solar', x: b.x, y: b.y });
    expect(solar).toMatchObject({ ok: true });

    // A substation within the solar farm's supply ring joins its island.
    let sub: { x: number; y: number } | null = null;
    for (const [dx, dy] of [
      [1, 0],
      [2, 0],
      [0, 1],
      [0, 2],
      [-1, 0],
      [-2, 0],
      [0, -1],
      [0, -2],
      [1, 1],
      [-1, -1],
    ]) {
      if (buildable(b.x + dx, b.y + dy)) {
        sub = { x: b.x + dx, y: b.y + dy };
        break;
      }
    }
    expect(sub).not.toBeNull();
    const substation = await call('place_plant', { plant: 'substation', x: sub!.x, y: sub!.y });
    expect(substation).toMatchObject({ ok: true });
    // A tick is needed for the grid (and so the island layer) to recompute.
    await call('advance_time', { ticks: 2 });

    const overview = (await call('get_game_overview')) as Record<string, any>;
    expect(overview.islands).toBe(2);
    expect(typeof overview.islandsInDeficit).toBe('number');

    const report = (await call('get_energy_report')) as Record<string, any>;
    expect((report.islands as unknown[]).length).toBe(2);
    // Every numeric field of an island is rounded, capacity included.
    for (const island of report.islands as Array<{ capacity: number }>) {
      expect(Number.isInteger(island.capacity)).toBe(true);
    }

    const missing = await call('find_tiles', { kind: 'island_without_substation' });
    expect((missing.tiles as { x: number; y: number }[]).length).toBe(1);

    const inspected = (await call('inspect_tile', { x: sub!.x, y: sub!.y })) as Record<string, any>;
    expect(inspected.substation).toBeDefined();
  });

  it("delivers a bare ring tile's island number to the tile mirror, not just the plant/line tiles", async () => {
    const { call, ctx, engine } = createHarness();
    engine.state.money = 1e9;
    const { terrain, tileType, density } = engine.state.layers;
    const buildable = (x: number, y: number): boolean => {
      if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return false;
      const i = tileIndex(x, y, SIZE);
      return (
        terrain[i] === Terrain.Land &&
        tileType[i] === TileType.Empty &&
        density[i] === 0 &&
        slopeAt(engine.state, i) <= BALANCE.terrain.maxBuildSlope
      );
    };
    const R = BALANCE.energy.lineSupplyRadius;
    // Enough buildable land in a row for the plant, a line running east
    // of it, and the bare tile only the line's own ring (not the
    // plant's) reaches.
    const span = 2 * R + 2;
    let origin: { x: number; y: number } | null = null;
    for (let y = 0; y < SIZE && !origin; y++) {
      for (let x = 0; x + span < SIZE && !origin; x++) {
        let ok = true;
        for (let dx = 0; dx <= span && ok; dx++) ok = buildable(x + dx, y);
        if (ok) origin = { x, y };
      }
    }
    expect(origin).not.toBeNull();
    const { x, y } = origin!;

    const wind = await call('place_plant', { plant: 'wind', x, y });
    expect(wind).toMatchObject({ ok: true });
    const line = await call('build_power_line', {
      from: { x: x + 1, y },
      to: { x: x + R + 2, y },
    });
    expect(line).toMatchObject({ ok: true });
    await call('advance_time', { ticks: 2 });

    // Bare land reached only by the far line tile's own ring, never the
    // plant's — and never a line tile itself, so nothing ever called
    // markDirty on it directly.
    const farTile = tileIndex(x + R + 2 + R, y, SIZE);
    expect(engine.state.layers.tileType[farTile]).toBe(TileType.Empty);

    const report = (await call('get_energy_report')) as Record<string, any>;
    const islandNumber = (report.islands as Array<{ number: number }>)[0].number;
    expect(islandNumber).toBeGreaterThan(0);
    expect(ctx.tiles.island[farTile]).toBe(islandNumber);
  });
});

describe('railways', () => {
  function flatHarness() {
    const h = createHarness();
    h.engine.state.layers.terrain.fill(Terrain.Land);
    h.engine.state.layers.elevation.fill(0);
    h.engine.state.money = 1e9;
    return h;
  }

  it('build_rail lays track along the path and reports the spend', async () => {
    const { call, engine } = flatHarness();
    const result = await call('build_rail', { from: { x: 2, y: 10 }, to: { x: 12, y: 10 } });
    expect(result).toMatchObject({ ok: true, tiles: 11 });
    expect(engine.state.layers.rail[tileIndex(5, 10, SIZE)]).not.toBe(0);
  });

  it('place_plant knows the three rail plants and rejects a yard without track', async () => {
    const { call } = flatHarness();
    await call('build_rail', { from: { x: 2, y: 10 }, to: { x: 12, y: 10 } });
    await call('build_road', { from: { x: 2, y: 8 }, to: { x: 12, y: 8 } });
    expect(await call('place_plant', { plant: 'train_station', x: 4, y: 9 })).toMatchObject({
      ok: true,
    });
    expect(await call('place_plant', { plant: 'freight_terminal', x: 6, y: 11 })).toMatchObject({
      ok: true,
    });
    expect(await call('place_plant', { plant: 'rail_yard', x: 8, y: 11 })).toMatchObject({
      ok: true,
    });
    expect(await call('place_plant', { plant: 'rail_yard', x: 20, y: 20 })).toMatchObject({
      ok: false,
      error: 'needsRailAccess',
    });
  });

  it('a served station shows as J on the rail layer', async () => {
    const { call, engine } = flatHarness();
    await call('build_rail', { from: { x: 2, y: 10 }, to: { x: 12, y: 10 } });
    await call('build_road', { from: { x: 2, y: 8 }, to: { x: 12, y: 8 } });
    await call('place_plant', { plant: 'train_station', x: 4, y: 9 });
    engine.state.layers.stationAge[tileIndex(4, 9, SIZE)] = 0;
    markDirty(engine.state, tileIndex(4, 9, SIZE));
    await call('advance_time', { ticks: 1 });
    const map = await call('get_map', {
      layer: 'rail',
      origin: { x: 4, y: 9 },
      width: 1,
      height: 1,
    });
    expect(map.rows).toEqual(['J']);
  });

  it('the overview carries a rail block, get_map a rail layer and find_tiles the rail kinds', async () => {
    const { call } = flatHarness();
    await call('build_rail', { from: { x: 2, y: 10 }, to: { x: 12, y: 10 } });
    await call('build_road', { from: { x: 2, y: 8 }, to: { x: 12, y: 8 } });
    await call('place_plant', { plant: 'train_station', x: 4, y: 9 });
    await call('place_plant', { plant: 'rail_yard', x: 8, y: 11 });
    await call('advance_time', { ticks: 1 });
    const overview = await call('get_game_overview');
    expect(overview.rail).toMatchObject({ networks: 1, stations: 1, stationsServed: 0, yards: 1 });
    const map = await call('get_map', {
      layer: 'rail',
      origin: { x: 2, y: 9 },
      width: 11,
      height: 3,
    });
    const rows = map.rows as string[];
    expect(rows[1]).toBe(':::::::::::');
    expect(rows[0]).toContain('x'); // the unserved station at (4, 9)
    expect(rows[2][6]).toBe('Z'); // the yard at (8, 11)
    expect(String(map.legend)).toContain('track');
    expect(String(map.legend)).toContain('J served station');
    expect(String(map.legend)).toContain('Z rail yard');
    // The overview marks the rail plants with letters no zone uses.
    const overviewMap = await call('get_map', {
      layer: 'overview',
      origin: { x: 2, y: 9 },
      width: 11,
      height: 3,
    });
    const overviewRows = overviewMap.rows as string[];
    expect(overviewRows[0][2]).toBe('J');
    expect(overviewRows[2][6]).toBe('Z');
    expect(String(overviewMap.legend)).toContain(
      'J train station, L freight terminal, Z rail yard',
    );
    expect(String(overviewMap.legend)).not.toContain('S train station');
    const due = await call('find_tiles', { kind: 'rail_station_due' });
    expect(due).toMatchObject({ total: 1, tiles: [{ x: 4, y: 9 }] });
    const dark = await call('find_tiles', { kind: 'rail_yard_without_grid' });
    expect(dark).toMatchObject({ total: 1, tiles: [{ x: 8, y: 11 }] });
    const track = await call('find_tiles', { kind: 'rail_track' });
    expect(track.total).toBe(11);
    const info = await call('inspect_tile', { x: 8, y: 11 });
    expect(info.railYard).toMatchObject({ powered: false, stationsInNetwork: 1 });
  });
});

// ---------------------------------------------------------------------------
// Town import: Nominatim and Overpass are stubbed through AgentContext.fetch.

const TOWN_XML = readFileSync(new URL('../import/fixtures/town.osm', import.meta.url), 'utf8');
/** Centre of the fixture's bounds. */
const TOWN_CENTRE = { lat: 49.8835, lon: 8.6709 };
const NOMINATIM_HIT = {
  name: 'Bach & Berg',
  display_name: 'Bach & Berg, Landkreis Musterstadt, Hessen, Germany',
  type: 'town',
  lat: String(TOWN_CENTRE.lat),
  lon: String(TOWN_CENTRE.lon),
};

type FetchCall = { url: string; init: RequestInit | undefined };

/**
 * A fetch stub answering Nominatim with `hits` (JSON) and every Overpass
 * endpoint with `overpass` (XML text, or an HTTP status for a failure).
 */
function fakeOsmFetch(
  hits: unknown[] | null = [NOMINATIM_HIT],
  overpass: string | number = TOWN_XML,
): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const stub = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith(OSM_IMPORT.nominatimUrl)) {
      return Promise.resolve(
        hits
          ? new Response(JSON.stringify(hits), {
              headers: { 'content-type': 'application/json' },
            })
          : new Response('busy', { status: 503 }),
      );
    }
    if (typeof overpass === 'number') {
      return Promise.resolve(new Response('no', { status: overpass }));
    }
    return Promise.resolve(
      new Response(overpass, { headers: { 'content-type': 'application/osm3s+xml' } }),
    );
  }) as typeof fetch;
  return { fetch: stub, calls };
}

describe('agent tools: town import', () => {
  beforeEach(() => resetSearchGate());

  it('search_places maps the Nominatim hits and reports a search failure', async () => {
    const harness = createHarness();
    const { fetch, calls } = fakeOsmFetch([NOMINATIM_HIT, { display_name: 'Bach, Elsewhere' }]);
    harness.ctx.fetch = fetch;
    const result = await harness.call('search_places', { query: ' Bach & Berg ' });
    expect(result).toMatchObject({ ok: true, query: 'Bach & Berg' });
    expect(result.hits).toEqual([
      {
        name: 'Bach & Berg',
        displayName: NOMINATIM_HIT.display_name,
        type: 'town',
        lat: TOWN_CENTRE.lat,
        lon: TOWN_CENTRE.lon,
      },
      { name: 'Bach', displayName: 'Bach, Elsewhere', type: '', lat: NaN, lon: NaN },
    ]);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get('q')).toBe('Bach & Berg');
    expect(url.searchParams.get('accept-language')).toBe('en');

    resetSearchGate();
    harness.ctx.fetch = fakeOsmFetch(null).fetch;
    expect(await harness.call('search_places', { query: 'Bach' })).toMatchObject({
      ok: false,
      error: 'importFailed',
      code: 'searchFailed',
      message: 'Town import failed (searchFailed)',
    });
    expect(await harness.call('search_places', { query: '  ' })).toMatchObject({
      ok: false,
      error: 'invalidInput',
    });
    expect(await harness.call('search_places', {})).toMatchObject({ ok: false });
  });

  it('import tools report noNetwork on a host without fetch', async () => {
    const { call } = createHarness();
    expect(await call('search_places', { query: 'Bach' })).toMatchObject({
      ok: false,
      error: 'noNetwork',
    });
    expect(await call('import_town', { query: 'Bach' })).toMatchObject({
      ok: false,
      error: 'noNetwork',
    });
  });

  it('import_town searches, downloads, rasterises and starts the city', async () => {
    const harness = createHarness();
    const { fetch, calls } = fakeOsmFetch();
    harness.ctx.fetch = fetch;
    const result = await harness.call('import_town', { query: 'Bach & Berg' });
    const bbox = squareBbox(TOWN_CENTRE.lat, TOWN_CENTRE.lon, OSM_IMPORT.sideKm[1]);
    expect(result).toMatchObject({
      ok: true,
      name: 'Bach & Berg',
      size: 96,
      sideKm: OSM_IMPORT.sideKm[1],
      difficulty: 'normal',
      disasters: 'normal',
      sandbox: false,
      bbox,
    });
    const report = result.report as { metresPerTile: number; counts: Record<string, number> };
    expect(report.metresPerTile).toBeCloseTo(
      (OSM_IMPORT.sideKm[1] * 1000) / (96 - 2 * marginTiles(96)),
      0,
    );
    expect(report.counts.street).toBeGreaterThan(0);
    expect(report.counts.buildings).toBeGreaterThan(0);
    // One Nominatim GET, then the first Overpass endpoint with the bbox query.
    expect(calls.map((c) => c.init?.method)).toEqual(['GET', 'POST']);
    expect(calls[1]!.url).toBe(OSM_IMPORT.overpassEndpoints[0]);
    expect(harness.newCities).toHaveLength(1);
    const city = harness.newCities[0]!;
    expect(city).toMatchObject({
      size: 96,
      startingMoney: BALANCE.startingMoney,
      seed: null,
      disasterScale: 1,
    });
    expect(city.layout).toMatchObject({ size: 96, name: 'Bach & Berg', bbox });
    expect(city.layout!.road.length).toBe(96 * 96);
  });

  it('import_town takes coordinates without a search and the start_new_city options', async () => {
    const harness = createHarness();
    const { fetch, calls } = fakeOsmFetch();
    harness.ctx.fetch = fetch;
    const result = await harness.call('import_town', {
      lat: TOWN_CENTRE.lat,
      lon: TOWN_CENTRE.lon,
      sideKm: 2.5,
      size: 48,
      difficulty: 'hard',
      seed: 7,
      sandbox: true,
    });
    expect(result).toMatchObject({
      ok: true,
      size: 48,
      sideKm: 2.5,
      difficulty: 'hard',
      seed: 7,
      disasters: 'off',
      sandbox: true,
      name: 'Bach & Berg',
    });
    expect(calls.map((c) => c.init?.method)).toEqual(['POST']);
    expect(harness.newCities[0]).toMatchObject({
      size: 48,
      startingMoney: 15_000,
      seed: 7,
      disasterScale: 0,
      sandbox: true,
    });
    expect(harness.newCities[0]!.layout!.size).toBe(48);
    // The fixture's own name wins over whatever the caller searched for;
    // without a place node in the box the hit name stands in.
    expect(harness.newCities[0]!.layout!.name).toBe('Bach & Berg');
  });

  it('import_town validates its arguments before touching the network', async () => {
    const harness = createHarness();
    const { fetch, calls } = fakeOsmFetch();
    harness.ctx.fetch = fetch;
    const bad = async (input: unknown): Promise<void> => {
      expect(await harness.call('import_town', input)).toMatchObject({
        ok: false,
        error: 'invalidInput',
      });
    };
    await bad({});
    await bad({ query: '' });
    await bad({ lat: TOWN_CENTRE.lat });
    await bad({ lat: 'north', lon: 8 });
    await bad({ lat: 95, lon: 8 });
    await bad({ query: 'Bach', sideKm: 4 });
    await bad({ query: 'Bach', size: 50 });
    await bad({ query: 'Bach', difficulty: 'brutal' });
    await bad({ query: 'Bach', sandbox: 'yes' });
    expect(calls).toHaveLength(0);
    expect(harness.newCities).toHaveLength(0);
  });

  it('import_town reports no hit, a failed download and a non-OSM answer', async () => {
    const harness = createHarness();
    harness.ctx.fetch = fakeOsmFetch([]).fetch;
    expect(await harness.call('import_town', { query: 'Nowhere' })).toMatchObject({
      ok: false,
      error: 'invalidInput',
      message: 'No place found for "Nowhere"',
    });

    resetSearchGate();
    const failing = fakeOsmFetch([NOMINATIM_HIT], 503);
    harness.ctx.fetch = failing.fetch;
    expect(await harness.call('import_town', { query: 'Bach' })).toMatchObject({
      ok: false,
      error: 'importFailed',
      code: 'fetchFailed',
      message: 'Town import failed (fetchFailed)',
    });
    // Every Overpass endpoint was tried.
    expect(failing.calls.filter((c) => c.init?.method === 'POST')).toHaveLength(
      OSM_IMPORT.overpassEndpoints.length,
    );

    harness.ctx.fetch = fakeOsmFetch([NOMINATIM_HIT], '<html>maintenance</html>').fetch;
    expect(
      await harness.call('import_town', { lat: TOWN_CENTRE.lat, lon: TOWN_CENTRE.lon }),
    ).toMatchObject({ ok: false, error: 'importFailed', code: 'notOsm' });
    expect(harness.newCities).toHaveLength(0);
  });

  it('get_game_overview carries the origin of an imported town', async () => {
    const { call, engine, ctx } = createHarness();
    expect((await call('get_game_overview')).origin).toBeUndefined();
    const { layout } = rasteriseTown(parseOsm(TOWN_XML), 48);
    engine.applyCommand({ type: 'init', seed: 3, size: 48, layout });
    await ctx.waitForTick(ctx.getStats()!.tick + 1);
    expect((await call('get_game_overview')).origin).toEqual({
      source: 'osm',
      name: 'Bach & Berg',
      bbox: layout.bbox,
    });
  });

  it('get_build_catalog lists the import mapping and settling thresholds', async () => {
    const { call } = createHarness();
    const catalog = await call('get_build_catalog');
    expect(catalog.osmImport).toMatchObject({
      sideKm: [...OSM_IMPORT.sideKm],
      maxBoxKm: OSM_IMPORT.maxBoxKm,
      marginShare: OSM_IMPORT.marginShare,
      buildingsPerDensity: [...BALANCE.osmImport.buildingsPerDensity],
      foundingGrantByDensity: [...BALANCE.osmImport.foundingGrantByDensity],
      abandonAfterDays: BALANCE.osmImport.abandonAfterDays,
    });
    const mapping = (catalog.osmImport as { mapping: Record<string, string[]> }).mapping;
    expect(mapping.avenueHighways).toContain('primary');
    expect(mapping.streetHighways).toContain('residential');
    expect(mapping.railways).toEqual(['rail']);
    expect(mapping.zoneLanduses).toEqual(['residential', 'commercial', 'retail', 'industrial']);
  });
});
