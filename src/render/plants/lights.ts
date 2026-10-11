import * as THREE from 'three';
import type { PlantType } from '../../shared/types.ts';
import { surfaceMaterial } from '../materials.ts';
import {
  WINDOW_COLOR,
  WINDOW_PROUD,
  windowGeometry,
  windowGlowOpacity,
} from '../buildings/windows.ts';
import { GrowingMesh } from './growingMesh.ts';
import { plantModel } from './models.ts';

/** Aviation lamps blink on and off this often per second, all in phase. */
export const AVIATION_BLINK_HZ = 0.5;
/** Edge of a lamp cube. */
export const LAMP_SIZE = 0.03;
/**
 * The glow quad sits over the glass (2 × WINDOW_PROUD) but behind the
 * mullions (3 × WINDOW_PROUD), so the cross still reads at night.
 */
export const GLOW_PROUD = 2.5 * WINDOW_PROUD;

const AVIATION_COLOR = 0xff3b30;
const YARD_COLOR = 0xffe2b0;
/** Share of each blink period the aviation lamps are on. */
const BLINK_ON_SHARE = 0.5;
const QUARTER_TURN = Math.PI / 2;
const UP = new THREE.Vector3(0, 1, 0);

/** A placed plant with its world pose: model base at (x, y, z), turned by yaw about +y. */
export interface LitPlant {
  index: number;
  type: PlantType;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** Light meshes span the grid (never cull) and cast no shadows. */
function setupLight(mesh: THREE.InstancedMesh): void {
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
}

function setupFrames(mesh: THREE.InstancedMesh): void {
  setupLight(mesh);
  mesh.receiveShadow = true;
}

function lightMaterial(color: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
}

/** Unit cube lamp with its base on the anchor. */
function lampGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(LAMP_SIZE, LAMP_SIZE, LAMP_SIZE);
  geometry.translate(0, LAMP_SIZE / 2, 0);
  return geometry;
}

/** Unit glow quad facing +z with its base at y = 0. */
function glowGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.PlaneGeometry(1, 1);
  geometry.translate(0, 0.5, 0);
  return geometry;
}

/**
 * Plant window frames (day and night), and on energised plants the
 * night glow of those windows, blinking red aviation lamps and warm
 * yard lamps.
 */
export class PlantLights {
  readonly frames: GrowingMesh;
  readonly glow: GrowingMesh;
  readonly aviation: GrowingMesh;
  readonly yard: GrowingMesh;
  private readonly glowMaterial = lightMaterial(WINDOW_COLOR);
  private readonly aviationMaterial = lightMaterial(AVIATION_COLOR);
  private readonly yardMaterial = lightMaterial(YARD_COLOR);
  private nightOpacity = 0;
  /** Seconds on the blink clock, wrapped to one period. */
  private blinkClock = 0;
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    this.glowMaterial.side = THREE.DoubleSide;
    this.frames = new GrowingMesh(
      scene,
      windowGeometry(),
      surfaceMaterial({ vertexColors: true }),
      setupFrames,
    );
    this.glow = new GrowingMesh(scene, glowGeometry(), this.glowMaterial, setupLight);
    const lamp = lampGeometry();
    this.aviation = new GrowingMesh(scene, lamp, this.aviationMaterial, setupLight);
    this.yard = new GrowingMesh(scene, lamp, this.yardMaterial, setupLight);
    this.applyOpacity();
  }

  /** Rewrite every frame, glow quad and lamp; `powered` says whether a tile is on a grid island. */
  rebuild(placed: ReadonlyArray<Readonly<LitPlant>>, powered: (index: number) => boolean): void {
    let frameCount = 0;
    let glowCount = 0;
    let aviationCount = 0;
    let yardCount = 0;
    const lit = placed.map((p) => powered(p.index));
    placed.forEach((p, i) => {
      const model = plantModel(p.type);
      frameCount += model.windows.length;
      if (!lit[i]) return;
      glowCount += model.windows.length;
      for (const l of model.lamps) {
        if (l.kind === 'aviation') aviationCount++;
        else yardCount++;
      }
    });
    this.frames.ensure(frameCount);
    this.glow.ensure(glowCount);
    this.aviation.ensure(aviationCount);
    this.yard.ensure(yardCount);

    let frameSlot = 0;
    let glowSlot = 0;
    let aviationSlot = 0;
    let yardSlot = 0;
    placed.forEach((p, i) => {
      const model = plantModel(p.type);
      for (const w of model.windows) {
        const faceYaw = p.yaw + w.face * QUARTER_TURN;
        this.worldPoint(p, w.x, w.y, w.z);
        this.quaternion.setFromAxisAngle(UP, faceYaw);
        this.scale.set(w.w, w.h, 1);
        this.matrix.compose(this.position, this.quaternion, this.scale);
        this.frames.mesh.setMatrixAt(frameSlot++, this.matrix);
        if (!lit[i]) continue;
        // Pushed along the face normal, over the glass.
        this.offset.set(Math.sin(faceYaw), 0, Math.cos(faceYaw)).multiplyScalar(GLOW_PROUD);
        this.position.add(this.offset);
        this.matrix.compose(this.position, this.quaternion, this.scale);
        this.glow.mesh.setMatrixAt(glowSlot++, this.matrix);
      }
      if (!lit[i]) return;
      for (const l of model.lamps) {
        this.worldPoint(p, l.x, l.y, l.z);
        this.matrix.makeTranslation(this.position);
        if (l.kind === 'aviation') this.aviation.mesh.setMatrixAt(aviationSlot++, this.matrix);
        else this.yard.mesh.setMatrixAt(yardSlot++, this.matrix);
      }
    });

    this.frames.commit(frameSlot);
    this.glow.commit(glowSlot);
    this.aviation.commit(aviationSlot);
    this.yard.commit(yardSlot);
    // Growth may have replaced a mesh; carry the night state over.
    this.applyOpacity();
  }

  /** Glow and yard lamps fade in with the night like the zone windows; aviation lamps also blink. */
  setNight(nightFactor: number): void {
    this.nightOpacity = windowGlowOpacity(nightFactor);
    this.applyOpacity();
  }

  /** Advance the shared blink clock. */
  update(deltaSeconds: number): void {
    this.blinkClock = (this.blinkClock + deltaSeconds) % (1 / AVIATION_BLINK_HZ);
    this.applyOpacity();
  }

  /** Model-space point (x, y, z) of a plant into world space, written to `position`. */
  private worldPoint(p: Readonly<LitPlant>, x: number, y: number, z: number): void {
    this.position.set(x, y, z).applyAxisAngle(UP, p.yaw);
    this.position.x += p.x;
    this.position.y += p.y;
    this.position.z += p.z;
  }

  private applyOpacity(): void {
    const phase = this.blinkClock * AVIATION_BLINK_HZ;
    const blink = phase < BLINK_ON_SHARE ? 1 : 0;
    const opacity = this.nightOpacity;
    this.glowMaterial.opacity = opacity;
    this.yardMaterial.opacity = opacity;
    this.aviationMaterial.opacity = opacity * blink;
    this.glow.mesh.visible = opacity > 0;
    this.yard.mesh.visible = opacity > 0;
    this.aviation.mesh.visible = this.aviationMaterial.opacity > 0;
  }
}
