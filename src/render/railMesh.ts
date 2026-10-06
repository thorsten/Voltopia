import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { DIR_E, DIR_N, DIR_S, DIR_W } from '../shared/grid.ts';
import { crossingIsClosed, type CrossingTrain } from '../shared/levelCrossing.ts';
import {
  Terrain,
  TileType,
  VehicleKind,
  type TileDiff,
  type VehicleState,
} from '../shared/types.ts';
import type { ElevationField } from './elevationField.ts';
import type { DiffLayer } from './renderer.ts';

const BALLAST_COLOR = 0x8a8075;
const RAIL_COLOR = 0x4a4d52;
const DECK_COLOR = 0x6b6f75;
const PARAPET_COLOR = 0xd8d8d0;
const BARRIER_POST_COLOR = 0xe8e8e2;
const BARRIER_BAR_COLOR = 0xd84a3a;
/** Rails sit this far either side of the tile's centre line. */
const GAUGE = 0.09;
const RAIL_WIDTH = 0.03;
const RAIL_HEIGHT = 0.03;
const BALLAST_WIDTH = 0.3;
const BALLAST_HEIGHT = 0.04;
/** Rails on a road tile are flush with the asphalt: no ballast, a hair above the road. */
const CROSSING_LIFT = 0.012;
const DECK_HEIGHT = 0.08;
const DECK_WIDTH = 0.5;
/** Railings along a rail bridge, like the road bridges' (roadsMesh). */
const PARAPET_HEIGHT = 0.12;
const PARAPET_THICKNESS = 0.03;
/** Level-crossing furniture: a white post with a raised red bar and a signal head, per approach. */
const BARRIER_POST = { sx: 0.06, sy: 0.14, sz: 0.06 } as const;
const BARRIER_BAR = { sx: 0.04, sy: 0.46, sz: 0.04 } as const;
const SIGNAL_HEAD = { sx: 0.08, sy: 0.1, sz: 0.05 } as const;
/** The post stands this far from the tile centre along the road and beside the lane. */
const BARRIER_ALONG_ROAD = 0.42;
const BARRIER_BESIDE_LANE = 0.3;
/** Seconds a bar takes to travel between raised and lowered. */
const BARRIER_SWEEP_SECONDS = 0.6;
/** The signal head alternates lit/dark over this period while the crossing is closed. */
const SIGNAL_BLINK_PERIOD_SECONDS = 1;
const SIGNAL_BLINK_DUTY = 0.5;
/** Instance colours of the signal head: dark when the crossing is open, red when it is closed. */
const SIGNAL_DARK = 0x2b2f33;
const SIGNAL_LIT = 0xe0402c;

/** One barrier of a level crossing: a post, the bar that swings down and its signal head. */
interface CrossingBarrier {
  /** Centre of the crossing tile in world coordinates. */
  cx: number;
  cz: number;
  /** Whether the track runs along x (the road then crosses along z). */
  alongX: boolean;
  /** Which approach this barrier guards: -1 or +1 along the road. */
  side: number;
  /** Foot of the bar: the top of the post. */
  px: number;
  pz: number;
  pivotY: number;
  yaw: number;
  /** 0 = raised, 1 = lowered flat across the road. */
  progress: number;
  /** Whether the signal head currently shows its lit colour. */
  lit: boolean;
}

function frac(value: number): number {
  return value - Math.floor(value);
}

/** Half a tile of track from the centre to one edge, pointing +x. */
function segmentGeometry(withBallast: boolean): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  if (withBallast) {
    const ballast = new THREE.BoxGeometry(0.5, BALLAST_HEIGHT, BALLAST_WIDTH);
    ballast.translate(0.25, BALLAST_HEIGHT / 2, 0);
    parts.push(ballast);
  }
  const lift = withBallast ? BALLAST_HEIGHT : 0;
  for (const side of [-GAUGE, GAUGE]) {
    const rail = new THREE.BoxGeometry(0.5, RAIL_HEIGHT, RAIL_WIDTH);
    rail.translate(0.25, lift + RAIL_HEIGHT / 2, side);
    parts.push(rail);
  }
  return mergeGeometries(parts);
}

/** The junction block under a tile's centre, so curves and crossings close. */
function centreGeometry(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(BALLAST_WIDTH, BALLAST_HEIGHT, BALLAST_WIDTH);
  g.translate(0, BALLAST_HEIGHT / 2, 0);
  return g;
}

/** A unit box standing on its base, scaled per instance. */
function standingBoxGeometry(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 1, 1);
  g.translate(0, 0.5, 0);
  return g;
}

/**
 * Yaw per connection bit: rotating +x about +y by +90° gives -z, which
 * is north (grid y - 1). The direction vector of an angle a is
 * (cos a, 0, -sin a).
 */
const DIRECTION_ANGLE: ReadonlyArray<{ bit: number; angle: number }> = [
  { bit: DIR_E, angle: 0 },
  { bit: DIR_N, angle: Math.PI / 2 },
  { bit: DIR_W, angle: Math.PI },
  { bit: DIR_S, angle: -Math.PI / 2 },
];

/**
 * Tracks: per track tile one half-segment per connection bit (an
 * isolated tile gets an east and a west stub), each pitched from the
 * tile centre to its edge so a line follows the ground over a slope and
 * meets its neighbour at the edge; a centre block; rails without
 * ballast on road tiles (level crossing) with a barrier post, a raised
 * bar and a signal head per approach; a deck with parapets under tiles
 * that bridge the river. Rebuilt from the diffs like the lines.
 */
export class RailMesh implements DiffLayer {
  private readonly segments: THREE.InstancedMesh;
  private readonly crossings: THREE.InstancedMesh;
  private readonly centres: THREE.InstancedMesh;
  private readonly decks: THREE.InstancedMesh;
  private readonly parapets: THREE.InstancedMesh;
  private readonly barrierPosts: THREE.InstancedMesh;
  private readonly barrierBars: THREE.InstancedMesh;
  private readonly signalHeads: THREE.InstancedMesh;
  private readonly barriers: CrossingBarrier[] = [];
  /** Locomotive positions in world coordinates, from the last tick. */
  private readonly trains: CrossingTrain[] = [];
  private reducedMotion = false;
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly color = new THREE.Color();
  private readonly masks: Uint8Array;
  private readonly tileTypes: Uint8Array;
  private readonly terrains: Uint8Array;
  private readonly dummy = new THREE.Object3D();

  constructor(
    scene: THREE.Scene,
    private readonly gridSize: number,
    private readonly elevation: ElevationField,
  ) {
    const tiles = gridSize * gridSize;
    this.masks = new Uint8Array(tiles);
    this.tileTypes = new Uint8Array(tiles);
    this.terrains = new Uint8Array(tiles);
    const make = (geometry: THREE.BufferGeometry, color: number, count: number) => {
      const mesh = new THREE.InstancedMesh(
        geometry,
        new THREE.MeshLambertMaterial({ color }),
        count,
      );
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.count = 0;
      scene.add(mesh);
      return mesh;
    };
    this.segments = make(segmentGeometry(true), BALLAST_COLOR, tiles * 4);
    this.crossings = make(segmentGeometry(false), RAIL_COLOR, tiles * 4);
    this.centres = make(centreGeometry(), BALLAST_COLOR, tiles);
    this.decks = make(new THREE.BoxGeometry(1, DECK_HEIGHT, DECK_WIDTH), DECK_COLOR, tiles);
    this.parapets = make(standingBoxGeometry(), PARAPET_COLOR, tiles * 2);
    this.barrierPosts = make(standingBoxGeometry(), BARRIER_POST_COLOR, tiles * 2);
    this.barrierBars = make(standingBoxGeometry(), BARRIER_BAR_COLOR, tiles * 2);
    // White base colour: the head's own colour is per instance, so it can blink.
    this.signalHeads = make(standingBoxGeometry(), 0xffffff, tiles * 2);
  }

  hasRail(index: number): boolean {
    return this.masks[index] !== 0;
  }

  applyDiffs(diffs: TileDiff[]): void {
    let changed = false;
    for (const diff of diffs) {
      if (this.masks[diff.index] !== diff.rail) {
        this.masks[diff.index] = diff.rail;
        changed = true;
      }
      if (this.tileTypes[diff.index] !== diff.tileType) {
        this.tileTypes[diff.index] = diff.tileType;
        if (diff.rail !== 0) changed = true;
      }
      if (this.terrains[diff.index] !== diff.terrain) {
        this.terrains[diff.index] = diff.terrain;
        if (diff.rail !== 0) changed = true;
      }
    }
    if (changed) this.rebuild();
  }

  /** Ground under a point of a track tile: the deck top on a river tile, the terrain elsewhere. */
  private groundY(index: number, x: number, z: number): number {
    return this.terrains[index] === Terrain.River
      ? this.elevation.maxCornerY(index) + DECK_HEIGHT
      : this.elevation.surfaceY(x, z);
  }

  /** A standing box of the given size at (x, y, z), yawed by `angle`. */
  private placeBox(
    mesh: THREE.InstancedMesh,
    slot: number,
    x: number,
    y: number,
    z: number,
    size: { readonly sx: number; readonly sy: number; readonly sz: number },
    angle: number,
  ): void {
    this.dummy.position.set(x, y, z);
    this.dummy.rotation.set(0, angle, 0);
    this.dummy.scale.set(size.sx, size.sy, size.sz);
    this.dummy.updateMatrix();
    mesh.setMatrixAt(slot, this.dummy.matrix);
  }

  /**
   * Train positions of the last tick, so the crossings can see them
   * coming. Wagons are left out: a locomotive leads every train.
   */
  setTrains(vehicles: readonly VehicleState[]): void {
    this.trains.length = 0;
    for (const vehicle of vehicles) {
      if (vehicle.kind !== VehicleKind.Locomotive && vehicle.kind !== VehicleKind.FreightLocomotive)
        continue;
      this.trains.push({ x: vehicle.x, y: vehicle.y });
    }
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
  }

  /**
   * Swing the bars of every crossing a train is approaching down, raise
   * the rest, and blink the signal head of a closed one. Under reduced
   * motion a bar jumps to its end state and the head holds its colour.
   */
  update(deltaSeconds: number, nowSeconds: number): void {
    if (this.barriers.length === 0) return;
    const step = this.reducedMotion ? 1 : deltaSeconds / BARRIER_SWEEP_SECONDS;
    const litPhase =
      this.reducedMotion || frac(nowSeconds / SIGNAL_BLINK_PERIOD_SECONDS) < SIGNAL_BLINK_DUTY;
    let movedBars = false;
    let changedSignals = false;
    for (let slot = 0; slot < this.barriers.length; slot++) {
      const barrier = this.barriers[slot];
      const target = crossingIsClosed(this.trains, barrier.cx, barrier.cz, barrier.alongX) ? 1 : 0;
      const progress =
        target > barrier.progress
          ? Math.min(target, barrier.progress + step)
          : Math.max(target, barrier.progress - step);
      if (progress !== barrier.progress) {
        barrier.progress = progress;
        this.writeBar(slot, barrier);
        movedBars = true;
      }
      const lit = barrier.progress > 0 && litPhase;
      if (lit !== barrier.lit) {
        barrier.lit = lit;
        this.writeSignal(slot, lit);
        changedSignals = true;
      }
    }
    if (movedBars) this.barrierBars.instanceMatrix.needsUpdate = true;
    if (changedSignals && this.signalHeads.instanceColor)
      this.signalHeads.instanceColor.needsUpdate = true;
  }

  /**
   * The bar stands on the post's top and turns about that foot: upright
   * at progress 0, flat across the road toward the lane's centre at 1.
   */
  private writeBar(slot: number, barrier: CrossingBarrier): void {
    this.euler.set(0, barrier.yaw, barrier.side * barrier.progress * (Math.PI / 2));
    this.dummy.position.set(barrier.px, barrier.pivotY, barrier.pz);
    this.dummy.quaternion.setFromEuler(this.euler);
    this.dummy.scale.set(BARRIER_BAR.sx, BARRIER_BAR.sy, BARRIER_BAR.sz);
    this.dummy.updateMatrix();
    this.barrierBars.setMatrixAt(slot, this.dummy.matrix);
  }

  private writeSignal(slot: number, lit: boolean): void {
    this.color.setHex(lit ? SIGNAL_LIT : SIGNAL_DARK);
    this.signalHeads.setColorAt(slot, this.color);
  }

  private rebuild(): void {
    this.barriers.length = 0;
    let segments = 0;
    let crossings = 0;
    let centres = 0;
    let decks = 0;
    let parapets = 0;
    let barriers = 0;
    for (let index = 0; index < this.masks.length; index++) {
      const mask = this.masks[index];
      if (mask === 0) continue;
      const x = (index % this.gridSize) + 0.5;
      const z = Math.floor(index / this.gridSize) + 0.5;
      const onRoad = this.tileTypes[index] === TileType.Road;
      const onRiver = this.terrains[index] === Terrain.River;
      const lift = onRoad ? CROSSING_LIFT : 0;
      const centreY = this.groundY(index, x, z) + lift;
      const target = onRoad ? this.crossings : this.segments;
      const bits = mask & (DIR_N | DIR_E | DIR_S | DIR_W);
      const alongX = (bits & (DIR_E | DIR_W)) !== 0 && (bits & (DIR_N | DIR_S)) === 0;
      const alongZ = (bits & (DIR_N | DIR_S)) !== 0 && (bits & (DIR_E | DIR_W)) === 0;
      const directions =
        bits === 0
          ? [DIRECTION_ANGLE[0], DIRECTION_ANGLE[2]]
          : DIRECTION_ANGLE.filter((d) => (bits & d.bit) !== 0);
      for (const { angle } of directions) {
        // Pitch the half-segment from the centre height to the edge
        // midpoint's height and stretch it to reach the edge, so track
        // climbs a slope instead of floating over the downhill half, and
        // two neighbours meet at the shared edge point.
        const ex = x + 0.5 * Math.cos(angle);
        const ez = z - 0.5 * Math.sin(angle);
        const edgeY = this.groundY(index, ex, ez) + lift;
        const rise = edgeY - centreY;
        this.dummy.position.set(x, centreY, z);
        this.dummy.rotation.set(0, angle, Math.atan2(rise, 0.5));
        this.dummy.scale.set(Math.hypot(0.5, rise) / 0.5, 1, 1);
        this.dummy.updateMatrix();
        target.setMatrixAt(onRoad ? crossings++ : segments++, this.dummy.matrix);
      }
      if (!onRoad) {
        this.dummy.position.set(x, centreY, z);
        this.dummy.rotation.set(0, 0, 0);
        this.dummy.scale.set(1, 1, 1);
        this.dummy.updateMatrix();
        this.centres.setMatrixAt(centres++, this.dummy.matrix);
      }
      if (onRiver) {
        const deckTop = this.elevation.maxCornerY(index) + DECK_HEIGHT;
        const horizontal = alongX || bits === 0;
        this.dummy.position.set(x, deckTop - DECK_HEIGHT / 2, z);
        this.dummy.rotation.set(0, horizontal ? 0 : Math.PI / 2, 0);
        this.dummy.scale.set(1, 1, 1);
        this.dummy.updateMatrix();
        this.decks.setMatrixAt(decks++, this.dummy.matrix);
        // Parapets along a straight bridge span, one per side of the deck.
        if (horizontal || alongZ) {
          const offset = DECK_WIDTH / 2 - PARAPET_THICKNESS / 2;
          for (const side of [-1, 1]) {
            const px = horizontal ? x : x + side * offset;
            const pz = horizontal ? z + side * offset : z;
            this.placeBox(
              this.parapets,
              parapets++,
              px,
              deckTop,
              pz,
              { sx: 1, sy: PARAPET_HEIGHT, sz: PARAPET_THICKNESS },
              horizontal ? 0 : Math.PI / 2,
            );
          }
        }
      }
      if (onRoad && (alongX || alongZ)) {
        // A road crossing a straight track: a barrier on the right-hand
        // side of each approach (traffic keeps right), its bar raised, a
        // signal head on the post. Decoration — cars and trains ignore
        // each other.
        for (const s of [-1, 1]) {
          const px = alongX ? x + s * BARRIER_BESIDE_LANE : x + s * BARRIER_ALONG_ROAD;
          const pz = alongX ? z + s * BARRIER_ALONG_ROAD : z - s * BARRIER_BESIDE_LANE;
          const ground = this.groundY(index, px, pz);
          const yaw = alongX ? 0 : Math.PI / 2;
          this.placeBox(this.barrierPosts, barriers, px, ground, pz, BARRIER_POST, yaw);
          this.placeBox(
            this.signalHeads,
            barriers,
            px,
            ground + BARRIER_POST.sy + BARRIER_BAR.sy - SIGNAL_HEAD.sy,
            pz,
            SIGNAL_HEAD,
            yaw,
          );
          // A rebuild only follows a track or road edit; a bar standing
          // open for the 0.6 s it needs to close again is not worth
          // carrying progress across one.
          const barrier: CrossingBarrier = {
            cx: x,
            cz: z,
            alongX,
            side: s,
            px,
            pz,
            pivotY: ground + BARRIER_POST.sy,
            yaw,
            progress: 0,
            lit: false,
          };
          this.barriers.push(barrier);
          this.writeBar(barriers, barrier);
          this.writeSignal(barriers, false);
          barriers++;
        }
      }
    }
    this.segments.count = segments;
    this.crossings.count = crossings;
    this.centres.count = centres;
    this.decks.count = decks;
    this.parapets.count = parapets;
    this.barrierPosts.count = barriers;
    this.barrierBars.count = barriers;
    this.signalHeads.count = barriers;
    if (this.signalHeads.instanceColor) this.signalHeads.instanceColor.needsUpdate = true;
    for (const mesh of [
      this.segments,
      this.crossings,
      this.centres,
      this.decks,
      this.parapets,
      this.barrierPosts,
      this.barrierBars,
      this.signalHeads,
    ]) {
      mesh.instanceMatrix.needsUpdate = true;
    }
  }
}
