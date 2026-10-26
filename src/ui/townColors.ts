/**
 * One palette for the one-pixel-per-tile pictures of a city: the HUD
 * minimap (src/render/minimapLayer.ts) and the import preview on the
 * new-game page paint from it, so an imported town looks in the preview
 * as it will on the minimap.
 */
import { PlantType, Terrain, TownRoad, Zone, type TownLayout } from '../shared/types.ts';

export const MINIMAP_COLORS = {
  ground: '#8fb573',
  forest: '#3f6b3c',
  road: '#5a6068',
  avenue: '#8b929c',
  river: '#4d8fc4',
  lake: '#3f7fb5',
  sea: '#2f6ea8',
  powerLine: '#e8d76a',
  rail: '#8a8f99',
  busStop: '#f2d16b',
  /** Same heavy-damage red as the Damage overlay (overlays.ts DAMAGE_COLORS.heavy). */
  damaged: '#e05263',
  zoned: {
    [Zone.Residential]: '#a9d3ab',
    [Zone.Commercial]: '#a9c3e0',
    [Zone.Retail]: '#e0bfa9',
    [Zone.Industrial]: '#d9cfa9',
  } as Record<number, string>,
  building: {
    [Zone.Residential]: '#4c9a51',
    [Zone.Commercial]: '#3c6fb4',
    [Zone.Retail]: '#c07a45',
    [Zone.Industrial]: '#8a7a3c',
  } as Record<number, string>,
  plant: {
    [PlantType.SolarFarm]: '#2b3d66',
    [PlantType.WindTurbine]: '#e8eaec',
    [PlantType.Battery]: '#4d6b57',
    [PlantType.BiogasPlant]: '#93ab6d',
    [PlantType.ChargingHub]: '#58b7a4',
    [PlantType.Park]: '#3f7d46',
    [PlantType.RunOfRiver]: '#9aa3ad',
    [PlantType.PumpedStorage]: '#5d6b7a',
    [PlantType.HydrogenPlant]: '#54b8c9',
    [PlantType.FireStation]: '#c0392b',
    [PlantType.PoliceStation]: '#2f5fa8',
    [PlantType.LogisticsDepot]: '#8d99a6',
    [PlantType.BusDepot]: '#5b8fc7',
    [PlantType.TidalPlant]: '#1d7373',
    [PlantType.GeothermalPlant]: '#b5482f',
    [PlantType.HeatPlant]: '#d9822b',
    [PlantType.HeatStore]: '#c9a227',
    [PlantType.TrainStation]: '#d84a3a',
    [PlantType.FreightTerminal]: '#d9a441',
    [PlantType.RailYard]: '#6e5a9e',
  } as Record<number, string>,
} as const;

/** Settled buildings in the import preview: this much of the zone colour's brightness. */
const BUILDING_SHADE = 0.6;

/** A `#rrggbb` colour scaled towards black by `factor` (0..1). */
export function shade(hex: string, factor: number): string {
  const channel = (offset: number): string =>
    Math.round(parseInt(hex.slice(offset, offset + 2), 16) * factor)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(1)}${channel(3)}${channel(5)}`;
}

/** Preview colour of a settled building on a zone (darker than the zone). */
export function buildingShade(zone: number): string {
  return shade(MINIMAP_COLORS.zoned[zone] ?? MINIMAP_COLORS.ground, BUILDING_SHADE);
}

/** Preview colour of one tile of a TownLayout, in the minimap's priority order. */
export function townTileColor(layout: TownLayout, index: number): string {
  const terrain = layout.terrain[index];
  if (terrain === Terrain.River) return MINIMAP_COLORS.river;
  if (terrain === Terrain.Sea) return MINIMAP_COLORS.sea;
  if (terrain !== Terrain.Land) return MINIMAP_COLORS.lake;
  const road = layout.road[index];
  if (road === TownRoad.Avenue) return MINIMAP_COLORS.avenue;
  if (road !== TownRoad.None) return MINIMAP_COLORS.road;
  if (layout.rail[index] !== 0) return MINIMAP_COLORS.rail;
  const zone = layout.zone[index];
  if (layout.density[index] > 0) return buildingShade(zone);
  if (zone !== Zone.None) return MINIMAP_COLORS.zoned[zone] ?? MINIMAP_COLORS.ground;
  if (layout.forest[index] !== 0) return MINIMAP_COLORS.forest;
  return MINIMAP_COLORS.ground;
}
