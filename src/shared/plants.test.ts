import { describe, expect, it } from 'vitest';
import { PlantType } from './types.ts';
import { SUPPLY_SOURCES, isSupplySource } from './plants.ts';

describe('supply sources', () => {
  it('lists generators and storage, not hubs, parks, stations or heat', () => {
    for (const plant of [
      PlantType.SolarFarm,
      PlantType.WindTurbine,
      PlantType.Battery,
      PlantType.BiogasPlant,
      PlantType.RunOfRiver,
      PlantType.PumpedStorage,
      PlantType.HydrogenPlant,
      PlantType.TidalPlant,
      PlantType.GeothermalPlant,
    ]) {
      expect(isSupplySource(plant)).toBe(true);
      expect(SUPPLY_SOURCES.has(plant)).toBe(true);
    }
    for (const plant of [
      PlantType.None,
      PlantType.ChargingHub,
      PlantType.Park,
      PlantType.FireStation,
      PlantType.PoliceStation,
      PlantType.LogisticsDepot,
      PlantType.BusDepot,
      PlantType.HeatPlant,
      PlantType.HeatStore,
    ]) {
      expect(isSupplySource(plant)).toBe(false);
    }
  });
});
