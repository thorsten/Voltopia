import { describe, expect, it } from 'vitest';
import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { PlantType, Terrain, VehicleKind, Zone } from '../shared/types.ts';
import { SimEngine } from './engine.ts';
import { BusPhase, TileType, VanPhase } from './state.ts';
import { timeOfDay, dayNumber } from './tick.ts';
import { placePlant } from './energy.ts';
import { buildPowerLines } from './powerLines.ts';
import { buildRoads } from './roads.ts';

function makeEngine(seed = 42, size = 16): SimEngine {
  return new SimEngine(seed, size);
}

describe('SimEngine basics', () => {
  it('starts with the configured funds and default tax rate', () => {
    const engine = makeEngine();
    expect(engine.state.money).toBe(BALANCE.startingMoney);
    expect(engine.state.taxRate).toBe(BALANCE.tax.defaultRate);
  });

  it('advances the tick counter', () => {
    const engine = makeEngine();
    const first = engine.tick();
    const second = engine.tick();
    expect(first.type).toBe('tick');
    if (first.type === 'tick' && second.type === 'tick') {
      expect(first.stats.tick).toBe(1);
      expect(second.stats.tick).toBe(2);
    }
  });

  it('changes speed via command', () => {
    const engine = makeEngine();
    engine.applyCommand({ type: 'setSpeed', speed: 3 });
    expect(engine.state.speed).toBe(3);
    engine.applyCommand({ type: 'setSpeed', speed: 0 });
    expect(engine.state.speed).toBe(0);
  });

  it('clamps the tax rate to the allowed range', () => {
    const engine = makeEngine();
    engine.applyCommand({ type: 'setTaxRate', rate: 0.9 });
    expect(engine.state.taxRate).toBe(BALANCE.tax.maxRate);
    engine.applyCommand({ type: 'setTaxRate', rate: -0.5 });
    expect(engine.state.taxRate).toBe(0);
  });

  it('toggles smart charging', () => {
    const engine = makeEngine();
    engine.applyCommand({ type: 'setSmartCharging', enabled: true });
    expect(engine.state.smartCharging).toBe(true);
  });

  it('toggles market trading', () => {
    const engine = makeEngine();
    engine.applyCommand({ type: 'setMarketTrading', enabled: true });
    expect(engine.state.marketTrading).toBe(true);
  });

  it('is deterministic: same seed produces identical stats over time', () => {
    const a = makeEngine(1234);
    const b = makeEngine(1234);
    for (let i = 0; i < 200; i++) {
      const ea = a.tick();
      const eb = b.tick();
      if (ea.type === 'tick' && eb.type === 'tick') {
        expect(ea.stats).toEqual(eb.stats);
      }
    }
  });

  it('produces save data on request and restores from it', () => {
    const engine = makeEngine(7, 16);
    for (let i = 0; i < 10; i++) engine.tick();
    const events = engine.applyCommand({ type: 'requestSave' });
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe('saveData');
    if (event.type !== 'saveData') return;

    const restored = makeEngine(0, 4);
    restored.applyCommand({ type: 'init', seed: 7, size: 16, save: event.save });
    expect(restored.state.tick).toBe(10);
    expect(restored.state.money).toBe(engine.state.money);
    expect(restored.state.size).toBe(16);
    // Loading marks the whole grid dirty so the renderer redraws everything.
    const tickEvent = restored.tick();
    if (tickEvent.type === 'tick') {
      expect(tickEvent.diffs.length).toBe(16 * 16);
    }
  });

  it('re-inits into a fresh state without a save', () => {
    const engine = makeEngine(1, 8);
    engine.tick();
    engine.applyCommand({ type: 'init', seed: 2, size: 8 });
    expect(engine.state.tick).toBe(0);
    expect(engine.state.seed).toBe(2);
  });

  it('generates water on a fresh init but not when loading a save', () => {
    const engine = makeEngine(1, 48);
    engine.applyCommand({ type: 'init', seed: 2, size: 48 });
    const water = engine.state.layers.terrain.filter((t) => t !== 0).length;
    expect(water).toBeGreaterThan(40);
    const first = engine.tick();
    if (first.type !== 'tick') throw new Error('expected tick');
    expect(first.diffs.some((d) => d.terrain !== 0)).toBe(true);

    // Loading a save restores its terrain exactly instead of regenerating
    // it. SimEngine's constructor never calls generateWater, so a fresh
    // engine's terrain is all-land: deterministic, non-generated ground
    // truth to hand-set a single river tile on.
    const source = makeEngine(1, 48);
    source.state.layers.terrain[0] = Terrain.River;
    const events = source.applyCommand({ type: 'requestSave' });
    const saveEvent = events[0]!;
    if (saveEvent.type !== 'saveData') throw new Error('expected saveData');

    engine.applyCommand({ type: 'init', seed: 1, size: 48, save: saveEvent.save });
    const loadedWater = engine.state.layers.terrain.filter((t) => t !== Terrain.Land).length;
    expect(loadedWater).toBe(1);
    expect(engine.state.layers.terrain[0]).toBe(Terrain.River);
  });

  it('init generates terrain before water', () => {
    const engine = new SimEngine(1, 48);
    engine.applyCommand({ type: 'init', seed: 9, size: 48 });
    const { elevation, terrain } = engine.state.layers;
    expect(elevation.some((v) => v > 0)).toBe(true);
    expect(terrain.some((v) => v !== Terrain.Land)).toBe(true);
    // Only true when terrain generation ran before water: a lake sunk into
    // real relief shares one uniform elevation with the engine's state.
    for (let i = 0; i < terrain.length; i++) {
      if (terrain[i] === Terrain.Lake) expect(elevation[i]).toBe(engine.state.lakeLevel);
    }
  });

  it('reports dispatchable biogas capacity in the energy stats', () => {
    const engine = new SimEngine(1, 16);
    engine.applyCommand({ type: 'init', seed: 1, size: 16 });
    let event = engine.tick();
    if (event.type !== 'tick') throw new Error('expected tick event');
    expect(event.stats.energy.biogasCapacity).toBe(0);

    engine.state.money = 1e9;
    // Flatten the generated relief so cliffs can't reject the fixed tile.
    engine.state.layers.elevation.fill(0);
    engine.applyCommand({
      type: 'placePlant',
      tile: tileIndex(2, 2, 16),
      plant: PlantType.BiogasPlant,
    });
    event = engine.tick();
    if (event.type !== 'tick') throw new Error('expected tick event');
    expect(event.stats.energy.biogasCapacity).toBe(BALANCE.energy.biogasMaxOutput);
  });

  it('a legacy save loads into a supplied city', () => {
    const engine = new SimEngine(3, 16);
    engine.applyCommand({ type: 'init', seed: 3, size: 16 });
    engine.state.money = 1e9;
    const road = Array.from({ length: 8 }, (_, x) => tileIndex(x + 2, 8, 16));
    engine.applyCommand({ type: 'buildRoad', tiles: road });
    engine.applyCommand({
      type: 'placePlant',
      tile: tileIndex(2, 7, 16),
      plant: PlantType.WindTurbine,
    });
    engine.state.layers.zone[tileIndex(9, 9, 16)] = 1;
    engine.state.layers.density[tileIndex(9, 9, 16)] = 1;
    const events = engine.applyCommand({ type: 'requestSave' });
    const save = events[0].type === 'saveData' ? events[0].save : null;
    if (!save) throw new Error('expected save data');
    delete save.layers.powerLine;

    const restored = new SimEngine(0, 4);
    restored.applyCommand({ type: 'init', seed: 3, size: 16, save });
    restored.state.weather.windSpeed = 1;
    restored.tick();
    expect(restored.state.layers.supplied[tileIndex(9, 9, 16)]).not.toBe(0); // not NotConnected
  });

  it('reports the season in stats and advances it with the days', () => {
    const engine = makeEngine();
    // A road tile guarantees at least one diff on the first tick (an
    // untouched city produces none) so the services wiring below has a
    // TileDiff to check.
    buildRoads(engine.state, [tileIndex(0, 0, 16)]);
    const first = engine.tick();
    if (first.type !== 'tick') throw new Error('expected tick');
    expect(first.stats.season.season).toBe('spring');
    expect(first.stats.season.dayOfSeason).toBe(1);
    expect(first.stats.season.year).toBe(1);
    expect(first.stats.insulation).toBe(false);
    expect(first.stats.energy.consumption.heating).toBe(0);
    expect(first.stats.energy.consumption.cooling).toBe(0);
    expect(first.stats.services).toEqual({ fire: 1, police: 1 });
    expect(first.stats.counts.avenueTiles).toBe(0);
    expect(first.stats.traffic).toEqual({ congestion: 1, driving: 0, avenueShare: 0 });
    expect(first.stats.deliveries).toEqual({ suppliedShare: 1, shops: 0, driving: 0, depots: 0 });
    expect(first.stats.transit).toEqual({
      riderShare: 0,
      riders: 0,
      driving: 0,
      stops: 0,
      stopsServed: 0,
      depots: 0,
    });
    expect(first.stats.budget.busStops).toBe(0);
    expect(first.stats.budget.busStopUpkeep).toBe(0);
    expect(first.diffs[0].busStop).toBe(0);
    expect(first.diffs[0].stopState).toBe(0);
    expect(first.diffs[0].transitCover).toBe(0);
    expect(first.stats.counts.depots).toBe(0);
    expect(first.stats.budget.avenueTiles).toBe(0);
    expect(first.stats.budget.avenueUpkeep).toBe(0);
    expect(first.diffs[0].services).toBe(0);
    expect(first.diffs[0].trafficLoad).toBe(0);
    expect(first.diffs[0].deliveryState).toBe(0);
    engine.state.tick = TICKS_PER_DAY * BALANCE.seasons.daysPerSeason - 1;
    const next = engine.tick();
    if (next.type !== 'tick') throw new Error('expected tick');
    expect(next.stats.season.season).toBe('summer');
    expect(next.stats.season.dayOfSeason).toBe(1);
  });

  it('driving vans are sent to the renderer with kind Van', () => {
    const engine = new SimEngine(1, 24);
    // stepTick's syncFleet keeps only vans whose depot and parking road exist.
    const depot = tileIndex(2, 2, 24);
    const road = tileIndex(2, 3, 24);
    engine.state.layers.tileType[depot] = TileType.Plant;
    engine.state.layers.plantType[depot] = PlantType.LogisticsDepot;
    engine.state.layers.tileType[road] = TileType.Road;
    engine.state.vans.push({
      id: 5,
      depot,
      depotRoad: road,
      x: 2.5,
      y: 3.5,
      angle: 0,
      phase: VanPhase.Unloading,
      stops: [road],
      path: [],
      pathIndex: 0,
      charge: 1,
      charging: false,
      waitTicks: 0,
      dwellTicks: 50,
    });
    const event = engine.tick();
    if (event.type !== 'tick') throw new Error('expected tick');
    const vans = event.vehicles.filter((v) => v.kind === VehicleKind.Van);
    expect(vans).toEqual([{ id: 5, x: 2.5, y: 3.5, angle: 0, kind: VehicleKind.Van }]);
    // syncFleet topped the fleet up to vansPerDepot; the parked ones are not rendered.
    expect(engine.state.vans).toHaveLength(BALANCE.deliveries.vansPerDepot);
  });

  it('driving buses are sent to the renderer with kind Bus', () => {
    const engine = new SimEngine(1, 24);
    const depot = tileIndex(2, 2, 24);
    const road = tileIndex(2, 3, 24);
    engine.state.layers.tileType[depot] = TileType.Plant;
    engine.state.layers.plantType[depot] = PlantType.BusDepot;
    engine.state.layers.tileType[road] = TileType.Road;
    engine.state.buses.push({
      id: 8,
      depot,
      depotRoad: road,
      x: 2.5,
      y: 3.5,
      angle: 0,
      phase: BusPhase.Boarding,
      stops: [road],
      path: [],
      pathIndex: 0,
      charge: 1,
      charging: false,
      waitTicks: 0,
      dwellTicks: 50,
    });
    const event = engine.tick();
    if (event.type !== 'tick') throw new Error('expected tick');
    const buses = event.vehicles.filter((v) => v.kind === VehicleKind.Bus);
    expect(buses).toEqual([{ id: 8, x: 2.5, y: 3.5, angle: 0, kind: VehicleKind.Bus }]);
    expect(engine.state.buses).toHaveLength(BALANCE.transit.busesPerDepot);
  });

  it('reports the cooling load in stats on a hot summer afternoon', () => {
    const engine = makeEngine();
    const at = (x: number, y: number) => tileIndex(x, y, 16);
    const { comfortTemperature } = BALANCE.seasons.cooling;
    // Same powered block as the energy tests: turbine, one residential
    // building next to it, a power line tile touching both.
    placePlant(engine.state, at(5, 5), PlantType.WindTurbine);
    engine.state.layers.zone[at(6, 5)] = Zone.Residential;
    engine.state.layers.density[at(6, 5)] = 2;
    buildPowerLines(engine.state, [at(6, 6)]);
    // Midsummer, warmest hour of the day (see BALANCE.seasons.coldestTime + 0.5).
    engine.state.seasonOriginDay = -Math.floor(BALANCE.seasons.daysPerSeason * 1.5);
    engine.state.tick = Math.floor(TICKS_PER_DAY * 0.7);
    const hot = engine.tick();
    if (hot.type !== 'tick') throw new Error('expected tick');
    expect(hot.stats.season.season).toBe('summer');
    expect(hot.stats.season.temperature).toBeGreaterThan(comfortTemperature);
    expect(hot.stats.energy.consumption.cooling).toBeGreaterThan(0);
    expect(hot.stats.energy.consumption.heating).toBe(0);
  });

  it('sells building insulation once', () => {
    const engine = makeEngine();
    const before = engine.state.money;
    expect(engine.applyCommand({ type: 'buyInsulation' })).toEqual([]);
    expect(engine.state.insulation).toBe(true);
    expect(engine.state.money).toBe(before - BALANCE.costs.insulation);
    expect(engine.applyCommand({ type: 'buyInsulation' })).toEqual([
      { type: 'rejected', reason: 'alreadyInsulated' },
    ]);
    expect(engine.state.money).toBe(before - BALANCE.costs.insulation);
  });

  it('flushes stats after a command that changes no tiles', () => {
    const engine = makeEngine();
    const before = engine.state.money;
    engine.applyCommand({ type: 'buyInsulation' });
    const flushed = engine.flush();
    if (flushed?.type !== 'tick') throw new Error('expected a tick event');
    expect(flushed.stats.insulation).toBe(true);
    expect(flushed.stats.money).toBe(before - BALANCE.costs.insulation);
    // The pending stats change is consumed by the first flush.
    expect(engine.flush()).toBeNull();
  });

  it('flushes stats after a tax rate change', () => {
    const engine = makeEngine();
    engine.applyCommand({ type: 'setTaxRate', rate: 0.2 });
    const flushed = engine.flush();
    if (flushed?.type !== 'tick') throw new Error('expected a tick event');
    expect(flushed.stats.taxRate).toBeCloseTo(0.2);
    expect(engine.flush()).toBeNull();
  });

  it('flushes stats after a smart charging change', () => {
    const engine = makeEngine();
    engine.applyCommand({ type: 'setSmartCharging', enabled: true });
    const flushed = engine.flush();
    if (flushed?.type !== 'tick') throw new Error('expected a tick event');
    expect(flushed.stats.smartCharging).toBe(true);
  });

  it('rejects insulation when the city cannot afford it', () => {
    const engine = makeEngine();
    engine.state.money = BALANCE.costs.insulation - 1;
    expect(engine.applyCommand({ type: 'buyInsulation' })).toEqual([
      { type: 'rejected', reason: 'notEnoughMoney' },
    ]);
    expect(engine.state.insulation).toBe(false);
  });

  it('builds bus stops through the buildBusStop command and rejects off-road tiles', () => {
    const engine = makeEngine();
    const road = tileIndex(3, 3, 16);
    buildRoads(engine.state, [road]);
    expect(engine.applyCommand({ type: 'buildBusStop', tiles: [road] })).toEqual([]);
    expect(engine.state.layers.busStop[road]).toBe(1);
    expect(engine.applyCommand({ type: 'buildBusStop', tiles: [tileIndex(9, 9, 16)] })).toEqual([
      { type: 'rejected', reason: 'needsRoadTile' },
    ]);
  });

  it('applies the chosen disaster intensity to a new city', () => {
    const engine = new SimEngine(1, 32);
    engine.applyCommand({ type: 'init', seed: 1, size: 32, disasterScale: 0 });
    expect(engine.state.disasterScale).toBe(0);
  });
});

describe('time helpers', () => {
  it('wraps time of day over the day length', () => {
    expect(timeOfDay(0)).toBe(0);
    expect(timeOfDay(TICKS_PER_DAY / 2)).toBe(0.5);
    expect(timeOfDay(TICKS_PER_DAY)).toBe(0);
  });

  it('counts days', () => {
    expect(dayNumber(0)).toBe(0);
    expect(dayNumber(TICKS_PER_DAY * 3 + 5)).toBe(3);
  });
});
