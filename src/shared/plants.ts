import { PlantType } from './types.ts';

/**
 * Plants that feed the grid and seed the line network (hubs, parks,
 * stations, depots and heat plants do not). Shared so the renderer can
 * tell a supply plant from a service building without importing the sim.
 */
export const SUPPLY_SOURCES: ReadonlySet<PlantType> = new Set<PlantType>([
  PlantType.SolarFarm,
  PlantType.WindTurbine,
  PlantType.Battery,
  PlantType.BiogasPlant,
  PlantType.RunOfRiver,
  PlantType.PumpedStorage,
  PlantType.HydrogenPlant,
  PlantType.TidalPlant,
  PlantType.GeothermalPlant,
]);

export function isSupplySource(plant: PlantType): boolean {
  return SUPPLY_SOURCES.has(plant);
}
