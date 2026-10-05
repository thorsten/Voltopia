import { describe, expect, it } from 'vitest';
import { BALANCE } from '../shared/constants.ts';
import { callBudgetTicks } from './demandResponse.ts';
import { balanceIsland, type IslandInput } from './islandBalance.ts';
import type { IslandPool } from './islandPools.ts';

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
    demand: { buildings: 0, heating: 0, cooling: 0, charging: 0, heatPumps: 0 },
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
        demand: { buildings: 40, heating: 0, cooling: 0, charging: 0, heatPumps: 0 },
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
      demand: { buildings: 100, heating: 0, cooling: 0, charging: 0, heatPumps: 0 },
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
        demand: { buildings: 400, heating: 0, cooling: 0, charging: 0, heatPumps: 0 },
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
        demand: { buildings: 100, heating: 0, cooling: 0, charging: 0, heatPumps: 0 },
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
});
