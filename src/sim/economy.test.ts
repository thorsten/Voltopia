import { describe, expect, it } from 'vitest';
import { BALANCE } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { economyStep, policeTaxFactor } from './economy.ts';
import { placePlant } from './energy.ts';
import { goalsStep } from './goals.ts';
import { energySystemActive } from './growth.ts';
import { happinessStep } from './happiness.ts';
import { buildPowerLines } from './powerLines.ts';
import { buildRoads } from './roads.ts';
import { createSimState, PlantType, SupplyStatus, Zone } from './state.ts';
import { buildBusStops } from './transit.ts';

const SIZE = 16;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);

describe('economyStep', () => {
  it('collects taxes from residents and jobs', () => {
    const state = createSimState(1, SIZE);
    state.lastServices = { fire: 1, police: 1 }; // full coverage: isolate the plain tax formula
    const before = state.money;
    const breakdown = economyStep(state, 100, 50);
    const expected =
      state.taxRate * (100 * BALANCE.tax.incomePerResident + 50 * BALANCE.tax.incomePerJob);
    expect(breakdown.taxIncome).toBeCloseTo(expected, 6);
    expect(state.money).toBeCloseTo(before + expected, 6);
  });

  it('taxes industrial jobs at the trade rate and the rest at the job rate', () => {
    const state = createSimState(1, SIZE);
    state.lastServices = { fire: 1, police: 1 };
    const tax = BALANCE.tax as { incomePerIndustrialJob: number };
    const saved = tax.incomePerIndustrialJob;
    tax.incomePerIndustrialJob = 0.3;
    try {
      const breakdown = economyStep(state, 100, 50, 20);
      const expected =
        state.taxRate *
        (100 * BALANCE.tax.incomePerResident + 30 * BALANCE.tax.incomePerJob + 20 * 0.3);
      expect(breakdown.taxIncome).toBeCloseTo(expected, 6);
    } finally {
      tax.incomePerIndustrialJob = saved;
    }
  });

  it('higher tax rate collects more', () => {
    const state = createSimState(1, SIZE);
    state.taxRate = 0.2;
    const high = economyStep(state, 100, 50).taxIncome;
    state.taxRate = 0.1;
    const low = economyStep(state, 100, 50).taxIncome;
    expect(high).toBeCloseTo(low * 2, 6);
  });

  it('charges road and plant upkeep', () => {
    const state = createSimState(1, SIZE);
    buildRoads(state, [at(1, 1), at(2, 1), at(3, 1)]);
    placePlant(state, at(5, 5), PlantType.WindTurbine);
    const breakdown = economyStep(state, 0, 0);
    expect(breakdown.gridUpkeep).toBeCloseTo(3 * BALANCE.upkeepPerTick.roadPerTile, 6);
    expect(breakdown.plantUpkeep).toBeCloseTo(
      BALANCE.upkeepPerTick.plant[PlantType.WindTurbine],
      6,
    );
  });

  it('biogas generation costs fuel', () => {
    const state = createSimState(1, SIZE);
    state.lastEnergy.biogas = 20;
    const breakdown = economyStep(state, 0, 0);
    expect(breakdown.biogasFuelCost).toBeCloseTo(
      20 * BALANCE.upkeepPerTick.biogasFuelCostPerEnergyUnit,
      6,
    );
  });

  it('grid imports cost money, exports earn a little', () => {
    const state = createSimState(1, SIZE);
    state.lastEnergy.gridImport = 40;
    state.lastEnergy.gridExport = 50;
    const before = state.money;
    const breakdown = economyStep(state, 0, 0);
    expect(breakdown.gridImportCost).toBeCloseTo(40 * BALANCE.market.importCostPerEnergyUnit, 6);
    expect(breakdown.gridExportRevenue).toBeCloseTo(
      50 * BALANCE.market.exportRevenuePerEnergyUnit,
      6,
    );
    expect(state.money).toBeCloseTo(
      before + breakdown.gridExportRevenue - breakdown.gridImportCost,
      6,
    );
  });

  it('link prices scale with the spot factor', () => {
    const state = createSimState(1, SIZE);
    state.lastEnergy.gridImport = 40;
    state.lastEnergy.gridExport = 50;
    state.lastEnergy.spotPrice = 2;
    const breakdown = economyStep(state, 0, 0);
    expect(breakdown.gridImportCost).toBeCloseTo(
      40 * BALANCE.market.importCostPerEnergyUnit * 2,
      6,
    );
    expect(breakdown.gridExportRevenue).toBeCloseTo(
      50 * BALANCE.market.exportRevenuePerEnergyUnit * 2,
      6,
    );
  });

  it('sold hydrogen earns revenue', () => {
    const state = createSimState(1, SIZE);
    state.lastEnergy.hydrogenSold = 30;
    const before = state.money;
    const breakdown = economyStep(state, 0, 0);
    expect(breakdown.hydrogenRevenue).toBeCloseTo(
      30 * BALANCE.hydrogen.saleRevenuePerEnergyUnit,
      6,
    );
    expect(state.money).toBeCloseTo(before + breakdown.hydrogenRevenue, 6);
  });

  it('charges upkeep per power line tile alongside road upkeep', () => {
    const state = createSimState(1, SIZE);
    buildPowerLines(state, [at(1, 1), at(2, 1)]);
    const breakdown = economyStep(state, 0, 0);
    expect(breakdown.gridUpkeep).toBeCloseTo(2 * BALANCE.upkeepPerTick.powerLinePerTile, 9);
  });

  it('scales tax income by police coverage once the city is big enough', () => {
    const { minPopulation, uncoveredTaxFactor } = BALANCE.services;
    expect(policeTaxFactor(0, minPopulation - 1)).toBe(1);
    expect(policeTaxFactor(0, minPopulation)).toBeCloseTo(uncoveredTaxFactor, 9);
    expect(policeTaxFactor(1, minPopulation)).toBe(1);
    expect(policeTaxFactor(0.5, minPopulation)).toBeCloseTo(0.5 + 0.5 * uncoveredTaxFactor, 9);

    const state = createSimState(1, SIZE);
    state.lastServices = { fire: 1, police: 0 };
    const uncovered = economyStep(state, minPopulation, 50).taxIncome;
    state.lastServices = { fire: 1, police: 1 };
    const covered = economyStep(state, minPopulation, 50).taxIncome;
    expect(uncovered).toBeCloseTo(covered * uncoveredTaxFactor, 6);
  });

  it('charges avenue upkeep on top of street upkeep and reports the split', () => {
    const state = createSimState(1, SIZE);
    state.layers.elevation.fill(0);
    buildRoads(state, [at(1, 1), at(2, 1)]);
    buildRoads(state, [at(3, 1)], true);
    const breakdown = economyStep(state, 0, 0);
    const { roadPerTile, avenuePerTile } = BALANCE.upkeepPerTick;
    expect(breakdown.roadTiles).toBe(3);
    expect(breakdown.avenueTiles).toBe(1);
    expect(breakdown.avenueUpkeep).toBeCloseTo(avenuePerTile, 9);
    expect(breakdown.gridUpkeep).toBeCloseTo(2 * roadPerTile + avenuePerTile, 9);
  });

  it('charges bus stop upkeep as part of the grid upkeep and reports the count', () => {
    const state = createSimState(1, SIZE);
    state.layers.elevation.fill(0);
    buildRoads(state, [at(1, 1), at(2, 1)]);
    buildBusStops(state, [at(1, 1)]);
    const breakdown = economyStep(state, 0, 0);
    const { roadPerTile, busStop } = BALANCE.upkeepPerTick;
    expect(breakdown.busStops).toBe(1);
    expect(breakdown.busStopUpkeep).toBeCloseTo(busStop, 9);
    expect(breakdown.gridUpkeep).toBeCloseTo(2 * roadPerTile + busStop, 9);
  });
});

describe('happinessStep', () => {
  function withBuildings(supplied: number): ReturnType<typeof createSimState> {
    const state = createSimState(1, SIZE);
    for (let i = 0; i < 10; i++) {
      state.layers.zone[at(i, 2)] = Zone.Residential;
      state.layers.density[at(i, 2)] = 1;
      state.layers.supplied[at(i, 2)] = supplied;
    }
    return state;
  }

  it('converges toward the base level in a healthy city', () => {
    const state = withBuildings(SupplyStatus.Supplied);
    for (let i = 0; i < 2000; i++) happinessStep(state, 0);
    expect(state.happiness).toBeCloseTo(BALANCE.happiness.base, 2);
  });

  it('drops with unpowered buildings', () => {
    const state = withBuildings(SupplyStatus.Undersupplied);
    for (let i = 0; i < 2000; i++) happinessStep(state, 0);
    expect(state.happiness).toBeLessThan(
      BALANCE.happiness.base - BALANCE.happiness.undersupplyPenaltyWeight + 0.05,
    );
  });

  it('drops with taxes above the neutral rate', () => {
    const state = withBuildings(SupplyStatus.Supplied);
    state.taxRate = BALANCE.tax.maxRate;
    for (let i = 0; i < 2000; i++) happinessStep(state, 0);
    expect(state.happiness).toBeLessThan(BALANCE.happiness.base - 0.2);
  });

  it('parks near buildings raise happiness toward base + bonus', () => {
    const state = withBuildings(SupplyStatus.Supplied);
    placePlant(state, at(2, 3), PlantType.Park); // adjacent to the row of homes
    for (let i = 0; i < 3000; i++) happinessStep(state, 0);
    expect(state.happiness).toBeGreaterThan(BALANCE.happiness.base + 0.02);
  });

  it('a park far away from all buildings gives no bonus', () => {
    const state = withBuildings(SupplyStatus.Supplied);
    const far = BALANCE.happiness.parkRadius + 3;
    placePlant(state, at(far, far + 2), PlantType.Park);
    for (let i = 0; i < 3000; i++) happinessStep(state, 0);
    expect(state.happiness).toBeLessThanOrEqual(BALANCE.happiness.base + 0.005);
  });

  it('a park does not activate the energy system or firstPower', () => {
    const state = withBuildings(SupplyStatus.Supplied);
    placePlant(state, at(2, 3), PlantType.Park);
    expect(energySystemActive(state)).toBe(false);
    goalsStep(state);
    expect(state.goalsAchieved.has('firstPower')).toBe(false);
  });

  it('jammed commutes lower happiness', () => {
    const state = withBuildings(SupplyStatus.Supplied);
    for (let i = 0; i < 2000; i++) happinessStep(state, 0);
    const calm = state.happiness;
    state.commuteCongestion = 3; // heavy jams
    for (let i = 0; i < 2000; i++) happinessStep(state, 0);
    expect(state.happiness).toBeLessThan(calm - 0.05);
  });

  it('changes smoothly, not abruptly', () => {
    const state = withBuildings(SupplyStatus.Undersupplied);
    const before = state.happiness;
    happinessStep(state, 0);
    expect(Math.abs(state.happiness - before)).toBeLessThan(0.05);
  });
});
