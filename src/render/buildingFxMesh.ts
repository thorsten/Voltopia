import * as THREE from 'three';
import type { TileDiff } from '../shared/types.ts';
import { SupplyStatus } from '../shared/types.ts';
import { heatingDegree } from '../shared/heating.ts';
import type { DiffLayer, RenderEnvironment } from './renderer.ts';
import type { AccentAnchor, AccentSink, AccentState } from './buildings/accents.ts';
import { MAX_PUFF_ANCHORS_PER_TILE } from './buildings/accents.ts';
import { PartRole } from './buildings/recipes.ts';

/** Puffs per smoking chimney or vent stack. */
export const PUFFS_PER_EMITTER = 3;
/** Seconds for one puff to rise from the stack top to its fade-out. */
const PUFF_CYCLE_SECONDS = 2.4;
/** Rise in tiles over one cycle. */
const CHIMNEY_RISE = 0.35;
const VENT_RISE = 0.2;
/** Vent puffs are thinner than full-cold chimney smoke. */
const VENT_STRENGTH = 0.45;
/** Sideways drift over a cycle along +x (the camera turns in quarter steps, so no direction is privileged). */
const WIND_DRIFT = 0.08;
/** Puff diameter in tiles at birth and at fade-out. */
const PUFF_MIN = 0.03;
const PUFF_MAX = 0.12;
const PUFF_COLOR = new THREE.Color(0xb9bcc0);
const PUFF_OPACITY = 0.5;
/** Night dimming of the puffs, like the geothermal steam. */
const NIGHT_DIM = 0.45;
/** Beacon (Task 5): a tiny box on the antenna tip. */
const BEACON_SIZE = 0.04;
const BEACON_HEIGHT = 0.03;
const BEACON_COLOR = 0xff3b30;
/** Smaller environment moves are not worth a rebuild under reduced motion. */
const TEMPERATURE_EPSILON = 0.25;
const NIGHT_FACTOR_EPSILON = 0.002;

interface Emitter {
  anchors: readonly AccentAnchor[];
  state: AccentState;
  /** Stable 0..1 phase so neighbours never puff or blink in step. */
  phase: number;
}

/** Deterministic hash of a tile index to 0..1 (same scheme as weatherFx.ts). */
function hash01(index: number): number {
  let h = (index * 374761393 + 668265263) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return (h >>> 8) / 16777216;
}

function frac(x: number): number {
  return x - Math.floor(x);
}

function sameState(a: AccentState, b: AccentState): boolean {
  return a.heated === b.heated && a.supplied === b.supplied && a.damaged === b.damaged;
}

/**
 * Animated building accents: chimney smoke on self-heated houses in the
 * cold, vent puffs on a busy market hall, and a night beacon on office
 * antennas. Everything it knows arrives through the `AccentSink` from
 * `BuildingsMesh`; tile diffs are not read here.
 *
 * With motion on, the puffs and beacons rebuild every frame while any
 * emitter exists. With reduced motion, puffs freeze at phase 0 and beacons
 * stay lit, and the layer rebuilds only when something it depends on
 * changed (emitters, state, temperature, night), so an idle map does no
 * per-frame GPU uploads — the same rule as geothermalMesh.ts.
 */
export class BuildingFxMesh implements DiffLayer, AccentSink {
  readonly puffs: THREE.InstancedMesh;
  readonly beacons: THREE.InstancedMesh;
  private readonly beaconMaterial: THREE.MeshBasicMaterial;
  private readonly emitters = new Map<number, Emitter>();
  private nightFactor = 0;
  private temperature = 20;
  private reducedMotion = false;
  /** Something the frozen (reduced-motion) build depends on changed. */
  private dirty = false;
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private readonly color = new THREE.Color();

  constructor(scene: THREE.Scene, gridSize: number) {
    const tiles = gridSize * gridSize;
    this.puffs = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.5, 8, 6),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: PUFF_OPACITY,
        depthWrite: false,
      }),
      tiles * MAX_PUFF_ANCHORS_PER_TILE * PUFFS_PER_EMITTER,
    );
    // Instance transforms span the whole grid; the base geometry's bounds
    // would wrongly cull the mesh, so culling is disabled.
    this.puffs.frustumCulled = false;
    this.puffs.count = 0;
    scene.add(this.puffs);

    this.beaconMaterial = new THREE.MeshBasicMaterial({
      color: BEACON_COLOR,
      transparent: true,
      opacity: 0,
    });
    this.beacons = new THREE.InstancedMesh(
      new THREE.BoxGeometry(BEACON_SIZE, BEACON_HEIGHT, BEACON_SIZE),
      this.beaconMaterial,
      tiles,
    );
    this.beacons.frustumCulled = false;
    this.beacons.count = 0;
    this.beacons.visible = false;
    scene.add(this.beacons);
  }

  /** Nothing to read from tile diffs: anchors and state arrive through the sink. */
  applyDiffs(_diffs: TileDiff[]): void {}

  set(index: number, anchors: readonly AccentAnchor[], state: AccentState): void {
    this.emitters.set(index, { anchors, state, phase: hash01(index) });
    this.dirty = true;
  }

  setState(index: number, state: AccentState): void {
    const emitter = this.emitters.get(index);
    if (!emitter || sameState(emitter.state, state)) return;
    emitter.state = state;
    this.dirty = true;
  }

  remove(index: number): void {
    if (this.emitters.delete(index)) this.dirty = true;
  }

  setEnvironment(environment: RenderEnvironment): void {
    if (Math.abs(environment.temperature - this.temperature) > TEMPERATURE_EPSILON) {
      this.temperature = environment.temperature;
      this.dirty = true;
    }
    if (Math.abs(environment.nightFactor - this.nightFactor) > NIGHT_FACTOR_EPSILON) {
      this.nightFactor = environment.nightFactor;
      this.dirty = true;
    }
    // Beacons fade in with the night exactly like the window lights.
    const opacity = Math.max(0, environment.nightFactor - 0.25) / 0.75;
    this.beaconMaterial.opacity = opacity;
    this.beacons.visible = opacity > 0.02;
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
    this.dirty = true;
  }

  update(_deltaSeconds: number, nowSeconds: number): void {
    if (this.emitters.size === 0) {
      if (this.puffs.count !== 0 || this.beacons.count !== 0) {
        this.puffs.count = 0;
        this.beacons.count = 0;
        this.puffs.instanceMatrix.needsUpdate = true;
        this.beacons.instanceMatrix.needsUpdate = true;
      }
      this.dirty = false;
      return;
    }
    if (this.reducedMotion && !this.dirty) return;
    this.rebuild(this.reducedMotion ? 0 : nowSeconds);
    this.dirty = false;
  }

  private rebuild(time: number): void {
    const degree = heatingDegree(this.temperature);
    const nightDim = 1 - NIGHT_DIM * this.nightFactor;
    let puffCount = 0;
    let beaconCount = 0;
    for (const emitter of this.emitters.values()) {
      const { state, phase } = emitter;
      const powered = state.supplied !== SupplyStatus.NotConnected && !state.damaged;
      for (const anchor of emitter.anchors) {
        switch (anchor.role) {
          case PartRole.Chimney:
            if (powered && !state.heated && degree > 0) {
              puffCount = this.writePuffs(
                puffCount,
                anchor,
                phase,
                time,
                degree,
                CHIMNEY_RISE,
                nightDim,
              );
            }
            break;
          case PartRole.Vent:
            if (state.supplied === SupplyStatus.Supplied && !state.damaged) {
              puffCount = this.writePuffs(
                puffCount,
                anchor,
                phase,
                time,
                VENT_STRENGTH,
                VENT_RISE,
                nightDim,
              );
            }
            break;
          case PartRole.Antenna:
            // Task 5 fills this in.
            break;
        }
      }
    }
    // Nothing to upload when there were no puffs before and there are
    // none now (an idle map with only non-emitting accents attached).
    const puffsChanged = puffCount > 0 || this.puffs.count > 0;
    this.puffs.count = puffCount;
    if (puffsChanged) {
      this.puffs.instanceMatrix.needsUpdate = true;
      if (this.puffs.instanceColor) this.puffs.instanceColor.needsUpdate = true;
    }
    this.beacons.count = beaconCount;
    this.beacons.instanceMatrix.needsUpdate = true;
  }

  /** Three puffs on a repeating rise cycle above `anchor`; returns the next free slot. */
  private writePuffs(
    slot: number,
    anchor: AccentAnchor,
    phase: number,
    time: number,
    strength: number,
    rise: number,
    nightDim: number,
  ): number {
    // Capacity is sized for MAX_PUFF_ANCHORS_PER_TILE live emitters per
    // tile; a future recipe with more tagged parts degrades to dropped
    // puffs here rather than a silent out-of-bounds write.
    if (slot + PUFFS_PER_EMITTER > this.puffs.instanceMatrix.count) return slot;
    for (let k = 0; k < PUFFS_PER_EMITTER; k++) {
      const u = frac(time / PUFF_CYCLE_SECONDS + k / PUFFS_PER_EMITTER + phase);
      const size = PUFF_MIN + (PUFF_MAX - PUFF_MIN) * u;
      this.position.set(anchor.x + WIND_DRIFT * u, anchor.y + rise * u, anchor.z);
      this.scale.set(size, size, size);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.puffs.setMatrixAt(slot, this.matrix);
      this.puffs.setColorAt(
        slot,
        this.color.copy(PUFF_COLOR).multiplyScalar(strength * (1 - u) * nightDim),
      );
      slot++;
    }
    return slot;
  }
}
