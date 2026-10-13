import * as THREE from 'three';
import type { TileDiff } from '../shared/types.ts';
import { Terrain } from '../shared/types.ts';
import { PALETTE } from './scene.ts';
import type { DiffLayer, RenderEnvironment } from './renderer.ts';
import type { ElevationField } from './elevationField.ts';
import { composePrismOnGround, createHalfTilePrism } from './decal.ts';
import { surfaceMaterial } from './materials.ts';
import { applyRipples, type RippleUniforms } from './nature/waterShader.ts';
import { uploadDrawn } from './plants/growingMesh.ts';

/**
 * Just above the ground plane, below roads (0.05) and the build grid. The
 * thinnest film of water any tile ever carries — exported so tests can
 * assert that the ground stays below it.
 */
export const WATER_HEIGHT = 0.015;
/** Thickness of the water slab (it is a box so it can be sheared onto slopes). */
export const WATER_THICKNESS = 0.01;
const WOBBLE_AMPLITUDE = 0.06;
const WOBBLE_SPEED = 1.3;
const NIGHT_DIM = 0.55;
/**
 * Tidal offset scale, in tile units: the sea surface moves
 * `tideLevel * TIDE_AMPLITUDE` with tideLevel running -1..1, so the full
 * peak-to-peak swing is twice this value. Deliberately small so the
 * shore reads as a shore, not as a flood.
 */
const TIDE_AMPLITUDE = 0.05;
/**
 * Mean sea level above the seabed. It clears the tidal amplitude, so
 * even at low water the surface still stands WATER_HEIGHT above the
 * ground — the sea used to be a thin slab at WATER_HEIGHT that the tide
 * moved bodily, which sank it into the opaque ground mesh (and out of
 * sight) for a quarter of every tidal cycle.
 */
const SEA_MEAN_HEIGHT = WATER_HEIGHT + TIDE_AMPLITUDE;
/**
 * Underside of the sea, just below the seabed: the water is a column
 * whose surface moves while its bottom stays put, so no gap opens under
 * it at high water and the ground never z-fights through it at low.
 */
const SEA_FLOOR = -0.01;

/** Width of a foam strip, measured from the shore line into the water. */
const FOAM_WIDTH = 0.06;
/** Foam floats this far above the water surface so it never z-fights it. */
const FOAM_LIFT = 0.002;
const FOAM_OPACITY = 0.55;
/** Opacity amplitude of the slow foam pulse. */
const FOAM_PULSE = 0.15;
const FOAM_PULSE_SPEED = 0.8;
const FOAM_COLOR = 0xffffff;
/** 4-neighbour offsets (N, E, S, W) a shore edge can face. */
const FOAM_NEIGHBOURS = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
] as const;
const FOAM_UP = new THREE.Vector3(0, 1, 0);
/** The strip's width axis in its own frame; river strips tilt about it. */
const FOAM_WIDTH_AXIS = new THREE.Vector3(0, 0, 1);

/**
 * One thin instanced slab per river or lake tile. Water never changes
 * after map generation, so the mesh only rebuilds when terrain diffs
 * arrive (new game / load). A slow brightness wobble and shader ripples keep it alive.
 */
export class WaterMesh implements DiffLayer {
  /** Lake tiles: flat unit boxes on the shared lake level. */
  private readonly mesh: THREE.InstancedMesh;
  /** River tiles: two prisms per tile, each flush with one ground triangle of the bed. */
  private readonly riverMesh: THREE.InstancedMesh;
  /** Sea tiles: flat boxes on the tide-driven sea level. */
  private readonly seaMesh: THREE.InstancedMesh;
  /** Foam along lake and river shores; recreated when it outgrows its capacity. */
  private inlandFoam: THREE.InstancedMesh;
  /** Foam along the coast; its mesh y follows the sea surface. */
  private seaFoam: THREE.InstancedMesh;
  private readonly foamGeometry: THREE.PlaneGeometry;
  private readonly foamMaterial: THREE.MeshBasicMaterial;
  private readonly scene: THREE.Scene;
  private seaSurfaceY = SEA_MEAN_HEIGHT;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly ripples: RippleUniforms;
  private readonly terrain: Uint8Array;
  private readonly gridSize: number;
  private readonly matrix = new THREE.Matrix4();
  private nightFactor = 0;
  private reducedMotion = false;
  private tideLevel = 0;
  /** Elevation version the water was last laid on. */
  private builtVersion: number;

  constructor(
    scene: THREE.Scene,
    gridSize: number,
    private readonly elevation: ElevationField,
  ) {
    this.gridSize = gridSize;
    this.scene = scene;
    this.terrain = new Uint8Array(gridSize * gridSize);
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    this.material = surfaceMaterial({ color: 0xffffff });
    this.ripples = applyRipples(this.material);
    this.mesh = new THREE.InstancedMesh(geometry, this.material, gridSize * gridSize);
    // Instance transforms live across the whole grid; the base geometry's
    // bounds would wrongly cull the mesh, so culling is disabled.
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.count = 0;
    scene.add(this.mesh);

    this.riverMesh = new THREE.InstancedMesh(
      createHalfTilePrism(),
      this.material,
      gridSize * gridSize * 2,
    );
    // Instance transforms live across the whole grid; the base geometry's
    // bounds would wrongly cull the mesh, so culling is disabled.
    this.riverMesh.frustumCulled = false;
    this.riverMesh.receiveShadow = true;
    this.riverMesh.count = 0;
    scene.add(this.riverMesh);

    this.seaMesh = new THREE.InstancedMesh(geometry, this.material, gridSize * gridSize);
    // Instance transforms live across the whole grid; the base geometry's
    // bounds would wrongly cull the mesh, so culling is disabled.
    this.seaMesh.frustumCulled = false;
    this.seaMesh.receiveShadow = true;
    this.seaMesh.count = 0;
    scene.add(this.seaMesh);

    // A flat strip, long side along x; E/W edges turn it about y.
    this.foamGeometry = new THREE.PlaneGeometry(1, FOAM_WIDTH);
    this.foamGeometry.rotateX(-Math.PI / 2);
    this.foamMaterial = new THREE.MeshBasicMaterial({
      color: FOAM_COLOR,
      transparent: true,
      opacity: FOAM_OPACITY,
      depthWrite: false,
    });
    this.inlandFoam = this.createFoam('inlandFoam', 1);
    this.seaFoam = this.createFoam('seaFoam', 1);
    this.setSeaSurface(SEA_MEAN_HEIGHT);
    this.builtVersion = elevation.version;
  }

  /** Shore edges drawn with foam, inland (lake, river) and on the coast. */
  get foamCount(): { inland: number; sea: number } {
    return { inland: this.inlandFoam.count, sea: this.seaFoam.count };
  }

  applyDiffs(diffs: TileDiff[]): void {
    let changed = false;
    for (const diff of diffs) {
      if (this.terrain[diff.index] !== diff.terrain) {
        this.terrain[diff.index] = diff.terrain;
        changed = true;
      }
    }
    // The ground moved under the water: lay it on the new bed.
    if (this.builtVersion !== this.elevation.version) changed = true;
    if (!changed) return;
    this.builtVersion = this.elevation.version;
    this.rebuild();
  }

  setEnvironment(environment: RenderEnvironment): void {
    this.nightFactor = environment.nightFactor;
    this.tideLevel = environment.tideLevel;
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
  }

  /** Seconds of ripple animation so far (frozen while motion is reduced). */
  get rippleTime(): number {
    return this.ripples.time.value;
  }

  update(deltaSeconds: number, nowSeconds: number): void {
    if (!this.reducedMotion) this.ripples.time.value += deltaSeconds;
    const wobble = this.reducedMotion ? 0 : WOBBLE_AMPLITUDE * Math.sin(nowSeconds * WOBBLE_SPEED);
    const brightness = (1 + wobble) * (1 - NIGHT_DIM * this.nightFactor);
    this.material.color.setScalar(brightness);
    const pulse = this.reducedMotion ? 0 : FOAM_PULSE * Math.sin(nowSeconds * FOAM_PULSE_SPEED);
    this.foamMaterial.opacity = (FOAM_OPACITY + pulse) * (1 - NIGHT_DIM * this.nightFactor);
    // The sea rises and falls with the tide; the range is deliberately
    // small so the shore reads as a shore, not as a flood.
    const tideOffset = this.reducedMotion ? 0 : this.tideLevel * TIDE_AMPLITUDE;
    this.setSeaSurface(SEA_MEAN_HEIGHT + tideOffset);
  }

  /**
   * Stretch the sea column between the fixed floor and the current
   * surface. Sea tiles all sit at sea level (`carveSea` flattens them to
   * elevation 0), so one transform on the whole mesh does it — the
   * per-instance matrices only carry the tile's position.
   */
  private setSeaSurface(surfaceY: number): void {
    this.seaMesh.scale.y = surfaceY - SEA_FLOOR;
    this.seaMesh.position.y = (surfaceY + SEA_FLOOR) / 2;
    this.seaSurfaceY = surfaceY;
    this.seaFoam.position.y = surfaceY + FOAM_LIFT;
  }

  private createFoam(name: string, capacity: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(this.foamGeometry, this.foamMaterial, capacity);
    mesh.name = name;
    // Instance transforms live across the whole grid; the base geometry's
    // bounds would wrongly cull the mesh, so culling is disabled.
    mesh.frustumCulled = false;
    mesh.count = 0;
    this.scene.add(mesh);
    return mesh;
  }

  /** The foam mesh itself when it holds `count` strips, else a larger replacement. */
  private fitFoam(mesh: THREE.InstancedMesh, count: number): THREE.InstancedMesh {
    if (count <= mesh.instanceMatrix.count) return mesh;
    this.scene.remove(mesh);
    mesh.dispose();
    return this.createFoam(mesh.name, count);
  }

  /**
   * Lay one foam strip along every edge where a water tile meets land,
   * `FOAM_WIDTH / 2` into the water. Water–water edges and the map
   * border stay bare. Sea strips sit at y = 0: the mesh carries the tide.
   */
  private rebuildFoam(): void {
    const size = this.gridSize;
    const inland: THREE.Matrix4[] = [];
    const sea: THREE.Matrix4[] = [];
    const turn = new THREE.Quaternion();
    const unit = new THREE.Vector3(1, 1, 1);
    const stretch = new THREE.Vector3();
    const tilt = new THREE.Quaternion();
    const along = new THREE.Vector3();
    const at = new THREE.Vector3();
    for (let index = 0; index < this.terrain.length; index++) {
      const terrain = this.terrain[index];
      if (terrain === Terrain.Land) continue;
      const x = index % size;
      const z = Math.floor(index / size);
      for (const [dx, dz] of FOAM_NEIGHBOURS) {
        const nx = x + dx;
        const nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= size || nz >= size) continue;
        if (this.terrain[nz * size + nx] !== Terrain.Land) continue;
        // Centre of the edge, pulled half a strip back into the water.
        const fx = x + 0.5 + dx * (0.5 - FOAM_WIDTH / 2);
        const fz = z + 0.5 + dz * (0.5 - FOAM_WIDTH / 2);
        turn.setFromAxisAngle(FOAM_UP, dx === 0 ? 0 : Math.PI / 2);
        stretch.copy(unit);
        let fy = 0;
        if (terrain === Terrain.Lake) {
          fy = this.elevation.centerY(index) + WATER_HEIGHT + WATER_THICKNESS + FOAM_LIFT;
        } else if (terrain === Terrain.River) {
          // A river edge may drop a level along its length: lay the strip
          // on the water at both ends, tilted about its width axis.
          along.set(1, 0, 0).applyQuaternion(turn).multiplyScalar(0.5);
          const lift = WATER_HEIGHT + WATER_THICKNESS + FOAM_LIFT;
          const yPlus = this.elevation.surfaceY(fx + along.x, fz + along.z) + lift;
          const yMinus = this.elevation.surfaceY(fx - along.x, fz - along.z) + lift;
          const dy = yPlus - yMinus;
          fy = (yPlus + yMinus) / 2;
          tilt.setFromAxisAngle(FOAM_WIDTH_AXIS, Math.atan2(dy, 1));
          turn.multiply(tilt);
          stretch.x = Math.hypot(1, dy);
        }
        const matrix = new THREE.Matrix4().compose(at.set(fx, fy, fz), turn, stretch);
        (terrain === Terrain.Sea ? sea : inland).push(matrix);
      }
    }
    this.inlandFoam = this.fitFoam(this.inlandFoam, inland.length);
    this.seaFoam = this.fitFoam(this.seaFoam, sea.length);
    this.seaFoam.position.y = this.seaSurfaceY + FOAM_LIFT;
    inland.forEach((matrix, i) => this.inlandFoam.setMatrixAt(i, matrix));
    sea.forEach((matrix, i) => this.seaFoam.setMatrixAt(i, matrix));
    uploadDrawn(this.inlandFoam, inland.length);
    uploadDrawn(this.seaFoam, sea.length);
  }

  private rebuild(): void {
    const color = new THREE.Color();
    let lakeCount = 0;
    let riverCount = 0;
    let seaCount = 0;
    for (let index = 0; index < this.terrain.length; index++) {
      const terrain = this.terrain[index];
      if (terrain === Terrain.Land) continue;
      if (terrain === Terrain.Lake) {
        // Every lake tile shares one level: one flat surface, banks rise around it.
        const x = (index % this.gridSize) + 0.5;
        const z = Math.floor(index / this.gridSize) + 0.5;
        this.matrix.makeScale(1, WATER_THICKNESS, 1);
        this.matrix.setPosition(
          x,
          this.elevation.centerY(index) + WATER_HEIGHT + WATER_THICKNESS / 2,
          z,
        );
        this.mesh.setMatrixAt(lakeCount, this.matrix);
        this.mesh.setColorAt(lakeCount, color.setHex(PALETTE.lake));
        lakeCount++;
        continue;
      }
      if (terrain === Terrain.Sea) {
        // Sea tiles sit at elevation 0 (sea level); the mesh transform
        // carries both the floor and the tide-driven surface, so the
        // per-instance matrix only places the unit column on its tile.
        const x = (index % this.gridSize) + 0.5;
        const z = Math.floor(index / this.gridSize) + 0.5;
        this.matrix.identity();
        this.matrix.setPosition(x, 0, z);
        this.seaMesh.setMatrixAt(seaCount, this.matrix);
        this.seaMesh.setColorAt(seaCount, color.setHex(PALETTE.sea));
        seaCount++;
        continue;
      }
      // The river bed is carved into the ground; the water follows it downhill.
      for (const high of [false, true]) {
        composePrismOnGround(
          this.matrix,
          this.elevation,
          index,
          high,
          1,
          WATER_THICKNESS,
          WATER_HEIGHT,
        );
        this.riverMesh.setMatrixAt(riverCount, this.matrix);
        this.riverMesh.setColorAt(riverCount, color.setHex(PALETTE.river));
        riverCount++;
      }
    }
    this.mesh.count = lakeCount;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.riverMesh.count = riverCount;
    this.riverMesh.instanceMatrix.needsUpdate = true;
    if (this.riverMesh.instanceColor) this.riverMesh.instanceColor.needsUpdate = true;
    this.seaMesh.count = seaCount;
    this.seaMesh.instanceMatrix.needsUpdate = true;
    if (this.seaMesh.instanceColor) this.seaMesh.instanceColor.needsUpdate = true;
    this.rebuildFoam();
  }
}
