import type { TileDiff } from '../shared/types.ts';
import { PlantType, RoadClass, Terrain, TileType, Zone } from '../shared/types.ts';
import type { DiffLayer } from './renderer.ts';

const COLORS = {
  ground: '#8fb573',
  forest: '#3f6b3c',
  road: '#5a6068',
  avenue: '#8b929c',
  river: '#4d8fc4',
  lake: '#3f7fb5',
  sea: '#2f6ea8',
  powerLine: '#e8d76a',
  busStop: '#f2d16b',
  zoned: {
    [Zone.Residential]: '#a9d3ab',
    [Zone.Commercial]: '#a9c3e0',
    [Zone.Retail]: '#e0bfa9',
  } as Record<number, string>,
  building: {
    [Zone.Residential]: '#4c9a51',
    [Zone.Commercial]: '#3c6fb4',
    [Zone.Retail]: '#c07a45',
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
  } as Record<number, string>,
} as const;

/**
 * Keeps a one-pixel-per-tile canvas of the city in sync with the sim
 * diffs; the UI minimap draws from it.
 */
export class MinimapLayer implements DiffLayer {
  readonly canvas: HTMLCanvasElement;
  /** Incremented on every change so the UI knows when to redraw. */
  version = 0;
  private readonly context: CanvasRenderingContext2D;
  private readonly gridSize: number;
  private readonly elevations: Uint8Array;

  constructor(gridSize: number) {
    this.gridSize = gridSize;
    this.elevations = new Uint8Array(gridSize * gridSize);
    this.canvas = document.createElement('canvas');
    this.canvas.width = gridSize;
    this.canvas.height = gridSize;
    this.context = this.canvas.getContext('2d')!;
    this.context.fillStyle = COLORS.ground;
    this.context.fillRect(0, 0, gridSize, gridSize);
  }

  applyDiffs(diffs: TileDiff[]): void {
    for (const diff of diffs) {
      this.elevations[diff.index] = diff.elevation;
      this.context.fillStyle = this.tileColor(diff);
      this.context.fillRect(
        diff.index % this.gridSize,
        Math.floor(diff.index / this.gridSize),
        1,
        1,
      );
    }
    if (diffs.length > 0) this.version++;
  }

  private tileColor(diff: TileDiff): string {
    if (diff.tileType === TileType.Empty && diff.terrain !== Terrain.Land) {
      if (diff.terrain === Terrain.River) return COLORS.river;
      if (diff.terrain === Terrain.Sea) return COLORS.sea;
      return COLORS.lake;
    }
    if (diff.tileType === TileType.Road) {
      if (diff.busStop !== 0) return COLORS.busStop;
      return diff.roadClass === RoadClass.Avenue ? COLORS.avenue : COLORS.road;
    }
    if (diff.tileType === TileType.Plant) {
      return COLORS.plant[diff.plantType] ?? COLORS.ground;
    }
    if (diff.density > 0) return COLORS.building[diff.zone] ?? COLORS.ground;
    if (diff.powerLine !== 0) return COLORS.powerLine;
    if (diff.forest > 0) return this.shade(COLORS.forest, this.elevations[diff.index]);
    if (diff.zone !== Zone.None) {
      return this.shade(COLORS.zoned[diff.zone] ?? COLORS.ground, this.elevations[diff.index]);
    }
    return this.shade(COLORS.ground, this.elevations[diff.index]);
  }

  /** Darken valleys, lighten hills (levels 0..7 around a level-2 baseline). */
  private shade(hex: string, level: number): string {
    const factor = 0.9 + 0.05 * (level - 2);
    const value = parseInt(hex.slice(1), 16);
    const channel = (shift: number): number =>
      Math.min(255, Math.round(((value >> shift) & 0xff) * factor));
    return `rgb(${channel(16)}, ${channel(8)}, ${channel(0)})`;
  }
}
