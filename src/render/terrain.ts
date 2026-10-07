import * as THREE from 'three';
import type { DiffLayer, RenderEnvironment } from './renderer.ts';
import { PALETTE } from './scene.ts';
import { ElevationField, LEVEL_HEIGHT } from './elevationField.ts';
import { BALANCE } from '../shared/constants.ts';
import { surfaceMaterial } from './materials.ts';

const SEASON_KEYS = [
  new THREE.Color(PALETTE.groundSpring),
  new THREE.Color(PALETTE.groundSummer),
  new THREE.Color(PALETTE.groundAutumn),
  new THREE.Color(PALETTE.groundWinter),
];
const SNOW = new THREE.Color(PALETTE.groundSnow);
/** Each key colour sits in the middle of its season. */
const KEY_OFFSET = 0.125;

/** Cyclic blend of the four seasonal ground colours, then toward snow. */
export function groundColor(target: THREE.Color, phase: number, snowCover: number): THREE.Color {
  const cyclic = (((phase - KEY_OFFSET) % 1) + 1) % 1;
  const x = cyclic * SEASON_KEYS.length;
  const i = Math.floor(x) % SEASON_KEYS.length;
  const next = (i + 1) % SEASON_KEYS.length;
  return target
    .copy(SEASON_KEYS[i])
    .lerp(SEASON_KEYS[next], x - Math.floor(x))
    .lerp(SNOW, THREE.MathUtils.clamp(snowCover, 0, 1));
}

/** Per-vertex brightness ramp so relief reads from the iso camera. */
const SHADE_LOW = 0.92;
const SHADE_SPAN = 0.1;
/** Ground height at the highest elevation level, for the shade ramp. */
const MAX_TERRAIN_Y = BALANCE.terrain.maxLevel * LEVEL_HEIGHT;

/**
 * Height-field ground spanning [0, size] x [0, size], with a grid overlay
 * that follows the terrain (a flat GridHelper would clip into hills).
 */
export class GroundMesh implements DiffLayer {
  readonly group: THREE.Group;
  readonly ground: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  private readonly gridLines: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  private readonly field: ElevationField;
  private readonly size: number;
  private appliedVersion = -1;

  constructor(size: number, field: ElevationField) {
    this.size = size;
    this.field = field;
    this.group = new THREE.Group();

    const geometry = new THREE.PlaneGeometry(size, size, size, size);
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(size / 2, 0, size / 2);
    const colors = new Float32Array(geometry.attributes.position.count * 3).fill(1);
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const material = surfaceMaterial({ color: PALETTE.ground, vertexColors: true });
    this.ground = new THREE.Mesh(geometry, material);
    this.ground.receiveShadow = true;
    this.group.add(this.ground);

    // Grid lines follow the terrain (a flat GridHelper would clip into hills).
    this.gridLines = new THREE.LineSegments(
      this.buildGridGeometry(),
      new THREE.LineBasicMaterial({
        color: PALETTE.grid,
        transparent: true,
        opacity: 0.18,
        depthWrite: false,
      }),
    );
    this.group.add(this.gridLines);
    this.rebuildHeights();
  }

  applyDiffs(): void {
    if (this.field.version !== this.appliedVersion) {
      this.appliedVersion = this.field.version;
      this.rebuildHeights();
    }
  }

  setEnvironment(environment: RenderEnvironment): void {
    groundColor(this.ground.material.color, environment.phase, environment.snowCover);
  }

  setGridVisible(visible: boolean): void {
    this.gridLines.visible = visible;
  }

  private rebuildHeights(): void {
    const position = this.ground.geometry.attributes.position;
    const color = this.ground.geometry.attributes.color;
    const maxY = MAX_TERRAIN_Y;
    for (let i = 0; i < position.count; i++) {
      const vx = Math.round(position.getX(i));
      const vz = Math.round(position.getZ(i));
      const y = this.field.cornerY(vx, vz);
      position.setY(i, y);
      const shade = SHADE_LOW + SHADE_SPAN * (maxY > 0 ? y / maxY : 0);
      color.setXYZ(i, shade, shade, shade);
    }
    position.needsUpdate = true;
    color.needsUpdate = true;
    this.ground.geometry.computeVertexNormals();
    this.ground.geometry.computeBoundingSphere();
    this.rebuildGridHeights();
  }

  /** One line segment per tile edge, slightly above the ground. */
  private buildGridGeometry(): THREE.BufferGeometry {
    const size = this.size;
    const points: number[] = [];
    for (let v = 0; v <= size; v++) {
      for (let a = 0; a < size; a++) {
        points.push(a, 0, v, a + 1, 0, v); // lines along x at z = v
        points.push(v, 0, a, v, 0, a + 1); // lines along z at x = v
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points), 3));
    return geometry;
  }

  private rebuildGridHeights(): void {
    const position = this.gridLines.geometry.attributes.position;
    for (let i = 0; i < position.count; i++) {
      const vx = Math.round(position.getX(i));
      const vz = Math.round(position.getZ(i));
      position.setY(i, this.field.cornerY(vx, vz) + 0.02);
    }
    position.needsUpdate = true;
    this.gridLines.geometry.computeBoundingSphere();
  }
}
