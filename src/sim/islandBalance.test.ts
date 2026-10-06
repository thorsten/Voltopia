import { describe, expect, it } from 'vitest';
import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import { callBudgetTicks } from './demandResponse.ts';
import { balanceIsland, type IslandInput } from './islandBalance.ts';
import type { IslandPool } from './islandPools.ts';
import { comfortWindowHours } from './smartMeters.ts';

function pool(): IslandPool {
  return { flexBacklog: 0, callBudget: callBudgetTicks() };
}

function input(over: Partial<IslandInput> = {}): IslandInput {
  return {
    timeOfDay: 0.5,
    season: { sunrise: 0.25, sunset: 0.75 },
    spotPrice: 1,
    marketTrading: false,
    demandResponseActive: false,
    coverage: 0,
    generation: { solar: 0, wind: 0, rooftop: 0, hydro: 0, tidal: 0, geothermal: 0 },
    biogasCapacity: 0,
    demand: { buildings: 0, heating: 0, cooling: 0, charging: 0, heatPumps: 0, traction: 0 },
    businessDemand: 0,
    industrialDemand: 0,
    contractedBuildings: 0,
    battery: {
      stored: 0,
      capacity: 0,
      powerLimit: 0,
      efficiency: BALANCE.energy.batteryChargeEfficiency,
    },
    pumped: {
      stored: 0,
      capacity: 0,
      powerLimit: 0,
      efficiency: BALANCE.energy.pumpedStorageChargeEfficiency,
    },
    hydrogen: {
      stored: 0,
      capacity: 0,
      electrolyserLimit: 0,
      fuelCellLimit: 0,
      efficiency: BALANCE.hydrogen.chargeEfficiency,
    },
    heatStore: { headroom: 0, pumpPowerLeft: 0, cop: 1, nightNeedsHeat: false },
    substations: 0,
    ...over,
  };
}

describe('balanceIsland', () => {
  it('serves demand from generation and curtails the rest without storage or a substation', () => {
    const r = balanceIsland(
      input({
        generation: { solar: 100, wind: 0, rooftop: 0, hydro: 0, tidal: 0, geothermal: 0 },
        demand: { buildings: 40, heating: 0, cooling: 0, charging: 0, heatPumps: 0, traction: 0 },
      }),
      pool(),
    );
    expect(r.curtailment).toBeCloseTo(60, 9);
    expect(r.deficit).toBe(0);
    expect(r.gridExport).toBe(0);
    expect(r.exportCapacity).toBe(0);
  });

  it('a deficit without a substation cannot import; with one it imports up to the link, two double it', () => {
    const short = input({
      demand: { buildings: 100, heating: 0, cooling: 0, charging: 0, heatPumps: 0, traction: 0 },
    });
    expect(balanceIsland(short, pool()).gridImport).toBe(0);
    expect(balanceIsland(short, pool()).deficit).toBeCloseTo(100, 9);
    const one = balanceIsland({ ...short, substations: 1 }, pool());
    expect(one.gridImport).toBeCloseTo(BALANCE.market.importCapacity, 9);
    expect(one.importCapacity).toBe(BALANCE.market.importCapacity);
    const two = balanceIsland({ ...short, substations: 2 }, pool());
    expect(two.gridImport).toBeCloseTo(Math.min(100, 2 * BALANCE.market.importCapacity), 9);
  });

  it('surplus charges the battery before exporting and reports the signed delta', () => {
    const r = balanceIsland(
      input({
        generation: { solar: 200, wind: 0, rooftop: 0, hydro: 0, tidal: 0, geothermal: 0 },
        battery: { stored: 0, capacity: 3_000, powerLimit: 120, efficiency: 0.92 },
        substations: 1,
      }),
      pool(),
    );
    expect(r.batteryDelta).toBeCloseTo(120 * 0.92, 9);
    expect(r.gridExport).toBeCloseTo(80, 9);
    expect(r.curtailment).toBe(0);
  });

  it('a deficit discharges the battery, then biogas, then sheds under the contract, then imports', () => {
    const p = pool();
    const r = balanceIsland(
      input({
        demand: { buildings: 400, heating: 0, cooling: 0, charging: 0, heatPumps: 0, traction: 0 },
        businessDemand: 200,
        contractedBuildings: 10,
        demandResponseActive: true,
        spotPrice: 2,
        battery: { stored: 1_000, capacity: 3_000, powerLimit: 120, efficiency: 0.92 },
        biogasCapacity: 90,
        substations: 1,
      }),
      p,
    );
    expect(r.batteryDelta).toBeCloseTo(-120, 9);
    expect(r.biogas).toBeCloseTo(90, 9);
    expect(r.shed).toBeCloseTo(BALANCE.demandResponse.shedShare * 200, 9);
    expect(r.gridImport).toBeCloseTo(BALANCE.market.importCapacity, 9);
    expect(r.deficit).toBeCloseTo(400 - 120 - 90 - r.shed - r.gridImport, 9);
    expect(p.callBudget).toBeLessThan(callBudgetTicks());
  });

  it('defers metered flexible load at night and keeps the backlog in the pool', () => {
    const p = pool();
    const r = balanceIsland(
      input({
        timeOfDay: 0.1,
        coverage: 1,
        demand: { buildings: 100, heating: 0, cooling: 0, charging: 0, heatPumps: 0, traction: 0 },
      }),
      p,
    );
    expect(r.flexDeferred).toBeCloseTo(BALANCE.smartMeters.householdFlexShare * 100, 9);
    expect(p.flexBacklog).toBeCloseTo(r.flexDeferred, 9);
    expect(r.consumptionThisTick).toBeCloseTo(100 - r.flexDeferred, 9);
  });

  it('market trading sells only through a substation', () => {
    const base = input({
      marketTrading: true,
      spotPrice: BALANCE.market.trading.sellThreshold,
      generation: { solar: 10, wind: 0, rooftop: 0, hydro: 0, tidal: 0, geothermal: 0 },
      battery: { stored: 3_000, capacity: 3_000, powerLimit: 120, efficiency: 0.92 },
    });
    expect(balanceIsland(base, pool()).tradeSell).toBe(0);
    expect(balanceIsland({ ...base, substations: 1 }, pool()).tradeSell).toBeGreaterThan(0);
  });
  it('fills battery, then pumped, then the heat store, then the tanks, before selling', () => {
    const r = balanceIsland(
      input({
        generation: { solar: 1_000, wind: 0, rooftop: 0, hydro: 0, tidal: 0, geothermal: 0 },
        battery: { stored: 0, capacity: 10_000, powerLimit: 100, efficiency: 0.92 },
        pumped: { stored: 0, capacity: 10_000, powerLimit: 200, efficiency: 0.8 },
        hydrogen: {
          stored: 0,
          capacity: 1_000,
          electrolyserLimit: 100,
          fuelCellLimit: 0,
          efficiency: 0.5,
        },
        heatStore: { headroom: 100, pumpPowerLeft: 60, cop: 2, nightNeedsHeat: true },
        substations: 1,
      }),
      pool(),
    );
    // Each stage takes its power limit; the heat store sits between
    // pumped storage and the tanks, and is bound by headroom / cop here.
    expect(r.batteryDelta).toBeCloseTo(100 * 0.92, 9);
    expect(r.pumpedDelta).toBeCloseTo(200 * 0.8, 9);
    expect(r.heatStoreCharge).toBeCloseTo(50, 9);
    expect(r.heatPumpConsumption).toBeCloseTo(50, 9);
    expect(r.electrolysis).toBeCloseTo(100, 9);
    expect(r.hydrogenDelta).toBeCloseTo(100 * 0.5, 9);
    // The link only ever sees what the tanks could not hold, and only
    // what is left over is curtailed.
    const stored = 100 + 200 + 50 + 100;
    expect(r.gridExport).toBeCloseTo(Math.min(r.exportCapacity, 1_000 - stored), 9);
    expect(r.hydrogenSold).toBe(0);
    expect(r.curtailment).toBeCloseTo(1_000 - stored - r.gridExport, 9);
  });

  it('charges the heat store from what the storages left, within pump power and headroom', () => {
    const surplus = (heatStore: IslandInput['heatStore'], batteryPowerLimit = 100): IslandInput =>
      input({
        generation: { solar: 300, wind: 0, rooftop: 0, hydro: 0, tidal: 0, geothermal: 0 },
        demand: { buildings: 0, heating: 0, cooling: 0, charging: 0, heatPumps: 5, traction: 0 },
        battery: { stored: 0, capacity: 10_000, powerLimit: batteryPowerLimit, efficiency: 0.92 },
        heatStore,
      });
    // 295 surplus, 100 into the battery: 195 reaches the store.
    const byHeadroom = balanceIsland(
      surplus({ headroom: 100, pumpPowerLeft: 60, cop: 2, nightNeedsHeat: true }),
      pool(),
    );
    expect(byHeadroom.heatStoreCharge).toBeCloseTo(100 / 2, 9);
    // Serving plus charging: the pumps' own draw is on top of the store.
    expect(byHeadroom.heatPumpConsumption).toBeCloseTo(5 + 50, 9);
    const byPumpPower = balanceIsland(
      surplus({ headroom: 400, pumpPowerLeft: 60, cop: 2, nightNeedsHeat: true }),
      pool(),
    );
    expect(byPumpPower.heatStoreCharge).toBeCloseTo(60, 9);
    const bySurplus = balanceIsland(
      surplus({ headroom: 400, pumpPowerLeft: 60, cop: 2, nightNeedsHeat: true }, 290),
      pool(),
    );
    expect(bySurplus.heatStoreCharge).toBeCloseTo(5, 9);
    // Mild nights: the store stays out of the cascade entirely.
    const warm = balanceIsland(
      surplus({ headroom: 400, pumpPowerLeft: 60, cop: 2, nightNeedsHeat: false }),
      pool(),
    );
    expect(warm.heatStoreCharge).toBe(0);
    expect(warm.heatPumpConsumption).toBeCloseTo(5, 9);
  });

  it('sells over the better-paying route first and curtails only what neither route takes', () => {
    // Full tanks (capacity 0): every electrolyser unit is a direct sale.
    const sale = (spotPrice: number, solar: number): IslandInput =>
      input({
        spotPrice,
        generation: { solar, wind: 0, rooftop: 0, hydro: 0, tidal: 0, geothermal: 0 },
        hydrogen: {
          stored: 0,
          capacity: 0,
          electrolyserLimit: 100,
          fuelCellLimit: 0,
          efficiency: 0.5,
        },
        substations: 1,
      });
    const exportValue = (spot: number) => BALANCE.market.exportRevenuePerEnergyUnit * spot;
    const hydrogenValue = 0.5 * BALANCE.hydrogen.saleRevenuePerEnergyUnit;
    // Scarcity: the link pays more, so it fills first and the
    // electrolysers mop up the remaining 40.
    expect(exportValue(2.5)).toBeGreaterThanOrEqual(hydrogenValue);
    const link = balanceIsland(sale(2.5, 120), pool());
    expect(link.gridExport).toBeCloseTo(BALANCE.market.exportCapacity, 9);
    expect(link.electrolysis).toBeCloseTo(120 - BALANCE.market.exportCapacity, 9);
    expect(link.hydrogenSold).toBeCloseTo((120 - BALANCE.market.exportCapacity) * 0.5, 9);
    expect(link.curtailment).toBeCloseTo(0, 9);
    // Abundance: the fixed hydrogen revenue beats the cheap link, so the
    // electrolysers run flat out first and the link takes the rest.
    expect(exportValue(1)).toBeLessThan(hydrogenValue);
    const tanks = balanceIsland(sale(1, 120), pool());
    expect(tanks.electrolysis).toBeCloseTo(100, 9);
    expect(tanks.hydrogenSold).toBeCloseTo(50, 9);
    expect(tanks.gridExport).toBeCloseTo(20, 9);
    expect(tanks.curtailment).toBeCloseTo(0, 9);
    // Both routes full: only then is the rest curtailed, either way round.
    for (const spot of [2.5, 1]) {
      const over = balanceIsland(sale(spot, 300), pool());
      expect(over.gridExport).toBeCloseTo(BALANCE.market.exportCapacity, 9);
      expect(over.electrolysis).toBeCloseTo(100, 9);
      expect(over.curtailment).toBeCloseTo(300 - BALANCE.market.exportCapacity - 100, 9);
    }
  });

  it('discharges battery, then pumped, then the fuel cells, then dispatches biogas', () => {
    const short = (buildings: number): IslandInput =>
      input({
        demand: { buildings, heating: 0, cooling: 0, charging: 0, heatPumps: 0, traction: 0 },
        battery: { stored: 1_000, capacity: 3_000, powerLimit: 120, efficiency: 0.92 },
        pumped: { stored: 500, capacity: 2_000, powerLimit: 80, efficiency: 0.8 },
        hydrogen: {
          stored: 200,
          capacity: 1_000,
          electrolyserLimit: 0,
          fuelCellLimit: 50,
          efficiency: 0.5,
        },
        biogasCapacity: 90,
      });
    // Within the battery's power limit nothing further down is touched.
    const small = balanceIsland(short(100), pool());
    expect(small.batteryDelta).toBeCloseTo(-100, 9);
    expect(small.pumpedDelta).toBe(0);
    expect(small.fuelCell).toBe(0);
    expect(small.hydrogenDelta).toBe(0);
    expect(small.biogas).toBe(0);
    expect(small.deficit).toBeCloseTo(0, 9);
    // Beyond it the cascade walks down the order; biogas comes last and
    // no substation means no import, so the rest is the island's deficit.
    const deep = balanceIsland(short(500), pool());
    expect(deep.batteryDelta).toBeCloseTo(-120, 9);
    expect(deep.pumpedDelta).toBeCloseTo(-80, 9);
    expect(deep.fuelCell).toBeCloseTo(50, 9);
    expect(deep.hydrogenDelta).toBeCloseTo(-50, 9);
    expect(deep.biogas).toBeCloseTo(90, 9);
    expect(deep.shed).toBe(0);
    expect(deep.gridImport).toBe(0);
    expect(deep.deficit).toBeCloseTo(500 - 120 - 80 - 50 - 90, 9);
  });

  it('stretches the comfort bound toward sunrise at night instead of the day window', () => {
    const season = { sunrise: 0.25, sunset: 0.75 };
    const night = 20 / 24;
    const flexible = BALANCE.smartMeters.householdFlexShare * 100;
    const bound = (time: number) =>
      flexible * comfortWindowHours(time, season) * (TICKS_PER_DAY / 24);
    expect(comfortWindowHours(night, season)).toBeGreaterThan(BALANCE.smartMeters.backlogHours);
    const load = { buildings: 100, heating: 0, cooling: 0, charging: 0, heatPumps: 0, traction: 0 };
    // A backlog just over the daytime bound: by day the excess is served
    // regardless of the weather, and the backlog lands back on the bound.
    const over = bound(0.5) + 10;
    const byDay: IslandPool = { flexBacklog: over, callBudget: callBudgetTicks() };
    const day = balanceIsland(input({ timeOfDay: 0.5, coverage: 1, demand: load }), byDay);
    expect(day.flexOverflow).toBeCloseTo(over + day.flexDeferred - bound(0.5), 9);
    expect(byDay.flexBacklog).toBeCloseTo(bound(0.5), 9);
    // The same backlog at 20:00 is well inside the stretched window, so
    // nothing is forced out and it keeps waiting for the morning sun.
    const byNight: IslandPool = { flexBacklog: over, callBudget: callBudgetTicks() };
    const atNight = balanceIsland(input({ timeOfDay: night, coverage: 1, demand: load }), byNight);
    expect(atNight.flexOverflow).toBe(0);
    expect(byNight.flexBacklog).toBeCloseTo(over + atNight.flexDeferred, 9);
  });

  it('drains the backlog by at most maxDrainShare of the load per tick', () => {
    const load = { buildings: 100, heating: 0, cooling: 0, charging: 0, heatPumps: 0, traction: 0 };
    const drainCap = BALANCE.smartMeters.maxDrainShare * 100;
    // Dark and calm: the comfort bound alone would serve thousands at
    // once, but the overflow may not exceed the drain cap.
    const dark: IslandPool = { flexBacklog: 10_000, callBudget: callBudgetTicks() };
    const r = balanceIsland(input({ coverage: 1, demand: load }), dark);
    expect(r.flexRecovered).toBe(0);
    expect(r.flexOverflow).toBeCloseTo(drainCap, 9);
    expect(dark.flexBacklog).toBeCloseTo(10_000 + r.flexDeferred - drainCap, 9);
    // A big surplus could recover the whole backlog; the same cap holds.
    const sunny: IslandPool = { flexBacklog: 10_000, callBudget: callBudgetTicks() };
    const recovering = balanceIsland(
      input({
        coverage: 1,
        demand: load,
        generation: { solar: 1_000, wind: 0, rooftop: 0, hydro: 0, tidal: 0, geothermal: 0 },
      }),
      sunny,
    );
    expect(recovering.flexRecovered).toBeCloseTo(drainCap, 9);
    expect(recovering.flexOverflow).toBe(0);
    expect(sunny.flexBacklog).toBeCloseTo(10_000 - drainCap, 9);
  });

  it('market trading buys into storage at abundance prices, only through a substation', () => {
    const base = input({
      marketTrading: true,
      spotPrice: BALANCE.market.trading.buyThreshold,
      battery: { stored: 0, capacity: 1_000, powerLimit: 50, efficiency: 0.92 },
      pumped: { stored: 0, capacity: 1_000, powerLimit: 30, efficiency: 0.8 },
    });
    const noLink = balanceIsland(base, pool());
    expect(noLink.tradeBuy).toBe(0);
    expect(noLink.gridImport).toBe(0);
    expect(noLink.batteryDelta).toBe(0);
    // One substation: the purchase is bound by the import link, so the
    // battery takes its power limit and pumped storage the remainder.
    const r = balanceIsland({ ...base, substations: 1 }, pool());
    expect(r.tradeBuy).toBeCloseTo(BALANCE.market.importCapacity, 9);
    expect(r.gridImport).toBeCloseTo(BALANCE.market.importCapacity, 9);
    expect(r.batteryDelta).toBeCloseTo(50 * 0.92, 9);
    expect(r.pumpedDelta).toBeCloseTo((BALANCE.market.importCapacity - 50) * 0.8, 9);
    expect(r.tradeSell).toBe(0);
  });

  it('buys only in the import link left over after serving a deficit', () => {
    // Cheap power and an empty battery, so the deficit cascade reaches
    // the link before trading does. The buy branch runs on a deficit
    // tick too (nothing was curtailed or exported), and the purchase
    // only gets the room the deficit import left.
    const base = input({
      marketTrading: true,
      spotPrice: BALANCE.market.trading.buyThreshold,
      battery: { stored: 0, capacity: 1_000, powerLimit: 50, efficiency: 0.92 },
      substations: 1,
    });
    const partial = balanceIsland(
      {
        ...base,
        demand: { buildings: 20, heating: 0, cooling: 0, charging: 0, heatPumps: 0, traction: 0 },
      },
      pool(),
    );
    expect(partial.tradeBuy).toBeCloseTo(BALANCE.market.importCapacity - 20, 9);
    expect(partial.gridImport).toBeCloseTo(BALANCE.market.importCapacity, 9);
    expect(partial.batteryDelta).toBeCloseTo((BALANCE.market.importCapacity - 20) * 0.92, 9);
    // A deficit deep enough to fill the link leaves no room at all.
    const full = balanceIsland(
      {
        ...base,
        demand: { buildings: 100, heating: 0, cooling: 0, charging: 0, heatPumps: 0, traction: 0 },
      },
      pool(),
    );
    expect(full.gridImport).toBeCloseTo(BALANCE.market.importCapacity, 9);
    expect(full.tradeBuy).toBe(0);
    expect(full.batteryDelta).toBe(0);
    expect(full.deficit).toBeCloseTo(100 - BALANCE.market.importCapacity, 9);
  });

  it('traction is an inflexible load that counts toward consumption and the deficit', () => {
    const quiet = balanceIsland(input(), pool());
    const loaded = balanceIsland(
      input({
        demand: { buildings: 0, heating: 0, cooling: 0, charging: 0, heatPumps: 0, traction: 30 },
      }),
      pool(),
    );
    expect(loaded.tractionConsumption).toBe(30);
    expect(loaded.consumptionThisTick).toBeCloseTo(quiet.consumptionThisTick + 30);
    // No generation, no biogas, no storage in the factory's defaults: the whole load is a deficit.
    expect(loaded.deficit).toBeCloseTo(quiet.deficit + 30);
  });
});
