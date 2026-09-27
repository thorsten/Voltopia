import type { TileDiff } from '../shared/types.ts';
import { Terrain } from '../shared/types.ts';
import type { DiffLayer } from './renderer.ts';

/** World height of one elevation level. */
export const LEVEL_HEIGHT = 0.35;

/**
 * Per-tile elevation tracked from sim diffs, shared by every render
 * layer. Registered as the FIRST diff layer so heights are current
 * before the other layers rebuild. Corner heights average the adjacent
 * tiles — that interpolation is what makes the slopes smooth — except at
 * the water's edge, where they step down instead (see cornerY).
 */
export class ElevationField implements DiffLayer {
  /** Incremented whenever any height changes; layers rebuild on change. */
  version = 0;
  private readonly levels: Uint8Array;
  /** 1 where the tile is water (river, lake or sea), 0 on land. */
  private readonly water: Uint8Array;
  private readonly size: number;
  /** Tiles per side of the map. */
  readonly gridSize: number;

  constructor(gridSize: number) {
    this.size = gridSize;
    this.gridSize = gridSize;
    this.levels = new Uint8Array(gridSize * gridSize);
    this.water = new Uint8Array(gridSize * gridSize);
  }

  applyDiffs(diffs: TileDiff[]): void {
    let changed = false;
    for (const diff of diffs) {
      if (this.levels[diff.index] !== diff.elevation) {
        this.levels[diff.index] = diff.elevation;
        changed = true;
      }
      // A diff without terrain counts as land; the sim always sends it.
      const water = (diff.terrain ?? Terrain.Land) === Terrain.Land ? 0 : 1;
      if (this.water[diff.index] !== water) {
        this.water[diff.index] = water;
        changed = true;
      }
    }
    if (changed) this.version++;
  }

  levelAt(index: number): number {
    return this.levels[index];
  }

  /** Largest level difference to a 4-neighbour (mirrors sim slopeAt). */
  slopeAt(index: number): number {
    const size = this.size;
    const x = index % size;
    const z = Math.floor(index / size);
    let slope = 0;
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx;
      const nz = z + dz;
      if (nx < 0 || nz < 0 || nx >= size || nz >= size) continue;
      slope = Math.max(slope, Math.abs(this.levels[index] - this.levels[nz * size + nx]));
    }
    return slope;
  }

  /** Tile centre height in world units (built tiles sit flat on this). */
  centerY(index: number): number {
    return this.levels[index] * LEVEL_HEIGHT;
  }

  /**
   * Height of the ground-mesh vertex at integer corner (vx, vz): the mean
   * of the adjacent tiles' levels, which is what makes inland relief read
   * as smooth slopes.
   *
   * A corner that touches water takes the LOWEST adjacent level instead,
   * so a shore is a step down into the water rather than a ramp. Averaging
   * there lifted the shared corner halfway up the bank — a sea tile beside
   * level-2 land got a corner half a level high, far above the highest
   * tide — and the opaque ground then rendered straight through the water
   * surface as a green wedge, most visibly where a river met the sea.
   * Measured before this rule: 21 % of all sea tiles and 40 % of lake
   * tiles had ground above their own water surface.
   */
  cornerY(vx: number, vz: number): number {
    const size = this.size;
    let sum = 0;
    let count = 0;
    let lowest = Number.POSITIVE_INFINITY;
    let touchesWater = false;
    for (const [dx, dz] of [
      [-1, -1],
      [0, -1],
      [-1, 0],
      [0, 0],
    ] as const) {
      const x = vx + dx;
      const z = vz + dz;
      if (x < 0 || z < 0 || x >= size || z >= size) continue;
      const level = this.levels[z * size + x];
      sum += level;
      count++;
      lowest = Math.min(lowest, level);
      if (this.water[z * size + x] !== 0) touchesWater = true;
    }
    if (count === 0) return 0;
    return (touchesWater ? lowest : sum / count) * LEVEL_HEIGHT;
  }

  /** Highest ground corner of a tile — flat decals sit here so the
   *  corner-averaged ground can never cover them. */
  maxCornerY(index: number): number {
    const size = this.size;
    const x = index % size;
    const z = Math.floor(index / size);
    return Math.max(
      this.cornerY(x, z),
      this.cornerY(x + 1, z),
      this.cornerY(x, z + 1),
      this.cornerY(x + 1, z + 1),
    );
  }

  /**
   * Slopes (world units per tile along +x and +z) of one of the two
   * ground triangles of a tile. The ground mesh is a PlaneGeometry, which
   * splits every cell along the diagonal from corner (x, z+1) to
   * (x+1, z): the "low" triangle holds corner (x, z) and the "high"
   * triangle holds corner (x+1, z+1). Each triangle is a plane, so a
   * decal fitted to it lies flush with the ground.
   */
  trianglePlane(index: number, high: boolean): { gx: number; gz: number } {
    const size = this.size;
    const x = index % size;
    const z = Math.floor(index / size);
    const h00 = this.cornerY(x, z);
    const h10 = this.cornerY(x + 1, z);
    const h01 = this.cornerY(x, z + 1);
    const h11 = this.cornerY(x + 1, z + 1);
    return high ? { gx: h11 - h01, gz: h11 - h10 } : { gx: h10 - h00, gz: h01 - h00 };
  }

  /** True when a point inside a tile lies in the tile's high ground triangle. */
  static inHighTriangle(fx: number, fz: number): boolean {
    return fx + fz > 1;
  }

  /**
   * Normal of the ground mesh at integer corner (vx, vz): the sum of the
   * (area-weighted, unnormalised) normals of the up to six triangles that
   * meet there, normalised — exactly what BufferGeometry.computeVertexNormals
   * produces for the indexed ground plane, so decals lit with it match the
   * ground's smooth shading.
   */
  cornerNormal(vx: number, vz: number): { x: number; y: number; z: number } {
    const size = this.size;
    let nx = 0;
    let ny = 0;
    let nz = 0;
    const add = (x: number, z: number, high: boolean) => {
      if (x < 0 || z < 0 || x >= size || z >= size) return;
      const { gx, gz } = this.trianglePlane(z * size + x, high);
      nx -= gx;
      ny += 1;
      nz -= gz;
    };
    // The vertex is corner (x, z) of the tile to its south-east (low
    // triangle only), corner (x+1, z+1) of the tile to its north-west (high
    // only), and lies on the crease of the two remaining tiles (both).
    add(vx, vz, false);
    add(vx - 1, vz - 1, true);
    add(vx - 1, vz, false);
    add(vx - 1, vz, true);
    add(vx, vz - 1, false);
    add(vx, vz - 1, true);
    const length = Math.hypot(nx, ny, nz);
    return length > 0 ? { x: nx / length, y: ny / length, z: nz / length } : { x: 0, y: 1, z: 0 };
  }

  /**
   * Ground normal at a continuous tile-space position as the renderer
   * shades it: the corner normals of the containing triangle blended
   * barycentrically, then normalised. Continuous across creases, unlike
   * the facet normal of trianglePlane.
   */
  smoothNormal(x: number, z: number): { x: number; y: number; z: number } {
    const size = this.size;
    const cx = Math.min(size - 1, Math.max(0, Math.floor(x)));
    const cz = Math.min(size - 1, Math.max(0, Math.floor(z)));
    const fx = Math.min(1, Math.max(0, x - cx));
    const fz = Math.min(1, Math.max(0, z - cz));
    // Every triangle has corners (cx, cz+1) and (cx+1, cz); the third is
    // (cx+1, cz+1) in the high triangle and (cx, cz) in the low one.
    const b = this.cornerNormal(cx, cz + 1);
    const d = this.cornerNormal(cx + 1, cz);
    let wb: number;
    let wd: number;
    let third: { x: number; y: number; z: number };
    let wt: number;
    if (ElevationField.inHighTriangle(fx, fz)) {
      third = this.cornerNormal(cx + 1, cz + 1);
      wt = fx + fz - 1;
      wb = 1 - fx;
      wd = 1 - fz;
    } else {
      third = this.cornerNormal(cx, cz);
      wt = 1 - fx - fz;
      wb = fz;
      wd = fx;
    }
    const nx = wb * b.x + wd * d.x + wt * third.x;
    const ny = wb * b.y + wd * d.y + wt * third.y;
    const nz = wb * b.z + wd * d.z + wt * third.z;
    const length = Math.hypot(nx, ny, nz);
    return { x: nx / length, y: ny / length, z: nz / length };
  }

  /**
   * Ground height at a continuous tile-space position, piecewise planar
   * exactly like the rendered ground mesh (see trianglePlane).
   */
  surfaceY(x: number, z: number): number {
    const size = this.size;
    const cx = Math.min(size - 1, Math.max(0, Math.floor(x)));
    const cz = Math.min(size - 1, Math.max(0, Math.floor(z)));
    const fx = Math.min(1, Math.max(0, x - cx));
    const fz = Math.min(1, Math.max(0, z - cz));
    const index = cz * size + cx;
    if (ElevationField.inHighTriangle(fx, fz)) {
      const { gx, gz } = this.trianglePlane(index, true);
      return this.cornerY(cx + 1, cz + 1) - gx * (1 - fx) - gz * (1 - fz);
    }
    const { gx, gz } = this.trianglePlane(index, false);
    return this.cornerY(cx, cz) + gx * fx + gz * fz;
  }
}
