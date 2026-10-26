import type { TileDiff } from '../shared/types.ts';
import { RoadClass, Terrain, TileType, Zone } from '../shared/types.ts';
import { MINIMAP_COLORS } from '../ui/townColors.ts';
import type { DiffLayer } from './renderer.ts';

const COLORS = MINIMAP_COLORS;

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
    // Wrecked tiles read as wrecked from the minimap too, regardless of
    // what stands on them — matches the Damage overlay's own rule that
    // `damage > 0` alone is enough to mark a tile, even a bare wrecked
    // pylon on otherwise-empty ground.
    if (diff.damage > 0) return COLORS.damaged;
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
    if (diff.rail !== 0) return COLORS.rail;
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
