import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { DIR_E, DIR_N, DIR_S, DIR_W, DIRECTIONS } from '../shared/grid.ts';
import { crossingIsClosed, type CrossingTrain } from '../shared/levelCrossing.ts';
import {
  PlantType,
  Terrain,
  TileType,
  VehicleKind,
  type TileDiff,
  type VehicleState,
} from '../shared/types.ts';
import type { ElevationField } from './elevationField.ts';
import type { DiffLayer, RenderEnvironment } from './renderer.ts';
import { RailSignals } from './infrastructure/railSignals.ts';
import { surfaceMaterial } from './materials.ts';
import { box } from './modelKit.ts';
import { ROAD_HEIGHT, roadHalfWidth } from './roadsMesh.ts';

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
/** Sleepers across the track under the rails, baked into the ballasted half segment. */
export const SLEEPER_COLOR = 0x5a4632;
export const SLEEPERS_PER_HALF = 3;
const SLEEPER_LENGTH = 0.26;
const SLEEPER_WIDTH = 0.05;
const SLEEPER_HEIGHT = 0.015;
/** Rails rest this high on a ballasted piece: the ballast bed plus the sleepers on it. */
const TRACKBED_HEIGHT = 0.04;
const BALLAST_HEIGHT = TRACKBED_HEIGHT - SLEEPER_HEIGHT;
/** Rails on a road tile sit on the asphalt: no ballast, a hair above the road surface. */
const CROSSING_HAIR = 0.002;
const CROSSING_LIFT = ROAD_HEIGHT + CROSSING_HAIR;
const DECK_HEIGHT = 0.08;
const DECK_WIDTH = 0.5;
/** Railings along a rail bridge, like the road bridges' (roadsMesh). */
const PARAPET_HEIGHT = 0.12;
const PARAPET_THICKNESS = 0.03;
/**
 * Level-crossing furniture, per approach: a white post with the signal
 * head on its top and the red bar hung beside it, pivoting at the post's
 * top. The bar's length is set per crossing so the lowered bar ends at
 * the road's centre line.
 */
const BARRIER_POST = { sx: 0.06, sy: 0.14, sz: 0.06 } as const;
const BARRIER_BAR = { sx: 0.04, sz: 0.04 } as const;
const SIGNAL_HEAD = { sx: 0.08, sy: 0.1, sz: 0.05 } as const;
/** The bar hangs this far from the post's centre, toward the road's centre. */
const BAR_OFF_POST = BARRIER_POST.sx / 2 + BARRIER_BAR.sx / 2;
/** The post stands this far from the tile centre along the road … */
const BARRIER_ALONG_ROAD = 0.42;
/** … and this far off the roadway's edge, so the raised bar is clear of the lane. */
const BARRIER_CLEARANCE = 0.02;
/** Seconds a bar takes to travel between raised and lowered. */
const BARRIER_SWEEP_SECONDS = 0.6;
/** The signal head alternates lit/dark over this period while the crossing is closed. */
const SIGNAL_BLINK_PERIOD_SECONDS = 1;
const SIGNAL_BLINK_DUTY = 0.5;
/** Instance colours of the signal head: dark when the crossing is open, red when it is closed. */
const SIGNAL_DARK = 0x2b2f33;
const SIGNAL_LIT = 0xe0402c;
/** Every rail vehicle occupies a signal block; only locomotives close crossings. */
const RAIL_VEHICLES: ReadonlySet<number> = new Set([
  VehicleKind.Locomotive,
  VehicleKind.Wagon,
  VehicleKind.FreightLocomotive,
  VehicleKind.FreightWagon,
]);

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
  /** Length of the bar: from the post to the road's centre line. */
  length: number;
  yaw: number;
  /** 0 = raised, 1 = lowered flat across the road. */
  progress: number;
  /** Whether the signal head currently shows its lit colour. */
  lit: boolean;
}

function frac(value: number): number {
  return value - Math.floor(value);
}

/**
 * Which side of a half-segment a bend's partner half leaves toward, in
 * the half's local frame (pointing +x): -1 or +1 along z, 0 on a
 * straight or at a junction.
 */
type BendSide = -1 | 0 | 1;

/**
 * Where a rail of a half-segment starts, measured from the tile centre
 * along +x. On a straight both rails start at the centre. In a bend the
 * inner rail stops short of the centre so the two inner rails meet at
 * their corner instead of crossing, and the outer rail reaches past the
 * centre to the outer corner so the two outer rails close it.
 */
function railStart(inner: BendSide, side: -1 | 1): number {
  if (inner === 0) return 0;
  return side === inner ? GAUGE - RAIL_WIDTH / 2 : -(GAUGE + RAIL_WIDTH / 2);
}

/** The two rails of a half-segment from their starts to the tile edge, their base at `y`. */
function railGeometries(inner: BendSide, y: number, color: number): THREE.BufferGeometry[] {
  return ([-1, 1] as const).map((side) => {
    const start = railStart(inner, side);
    return box(
      0.5 - start,
      RAIL_HEIGHT,
      RAIL_WIDTH,
      (0.5 + start) / 2,
      y + RAIL_HEIGHT / 2,
      side * GAUGE,
      color,
    );
  });
}

/**
 * Half a tile of track from the centre to one edge, pointing +x, on a
 * ballast bed with sleepers under the rails. Vertex-coloured.
 */
function ballastedSegmentGeometry(inner: BendSide): THREE.BufferGeometry {
  const parts = [
    box(0.5, BALLAST_HEIGHT, BALLAST_WIDTH, 0.25, BALLAST_HEIGHT / 2, 0, BALLAST_COLOR),
  ];
  const spacing = 0.5 / SLEEPERS_PER_HALF;
  for (let k = 0; k < SLEEPERS_PER_HALF; k++) {
    parts.push(
      box(
        SLEEPER_WIDTH,
        SLEEPER_HEIGHT,
        SLEEPER_LENGTH,
        spacing * (k + 0.5),
        BALLAST_HEIGHT + SLEEPER_HEIGHT / 2,
        0,
        SLEEPER_COLOR,
      ),
    );
  }
  parts.push(...railGeometries(inner, TRACKBED_HEIGHT, RAIL_COLOR));
  return mergeGeometries(parts);
}

/** Half a tile of bare rails from the centre to one edge, pointing +x (level crossings). */
function crossingSegmentGeometry(inner: BendSide): THREE.BufferGeometry {
  return mergeGeometries(railGeometries(inner, 0, RAIL_COLOR));
}

/** The ballast block under a tile's centre, so curves and crossings close; level with the bed, so the sleepers show. */
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
 * ballast across the roadway of road tiles (level crossing), ballasted
 * again from the road edge to the tile edge, with a barrier post, a raised
 * bar and a signal head per approach; a bend's rails mitred at the
 * corner; a deck with parapets under tiles
 * that bridge the river; line-side occupancy signals at stations and
 * junctions (`RailSignals`); a stub from the track toward a rail yard
 * that halts at it, meeting the yard's siding at the shared edge.
 * Rebuilt from the diffs like the lines.
 */
export class RailMesh implements DiffLayer {
  private readonly segments: THREE.InstancedMesh;
  private readonly crossings: THREE.InstancedMesh;
  /** Ballasted halves of a bend whose inner side is local -z (index 0) or +z (index 1). */
  private readonly bends: readonly [THREE.InstancedMesh, THREE.InstancedMesh];
  /** The same for bends on a road tile: bare rails. */
  private readonly crossingBends: readonly [THREE.InstancedMesh, THREE.InstancedMesh];
  private readonly centres: THREE.InstancedMesh;
  private readonly decks: THREE.InstancedMesh;
  private readonly parapets: THREE.InstancedMesh;
  private readonly barrierPosts: THREE.InstancedMesh;
  private readonly barrierBars: THREE.InstancedMesh;
  private readonly signalHeads: THREE.InstancedMesh;
  private readonly barriers: CrossingBarrier[] = [];
  /** Locomotive positions in world coordinates, from the last tick. */
  private readonly trains: CrossingTrain[] = [];
  /** Positions of every rail vehicle (locomotives and wagons), for the signals. */
  private readonly railVehicles: CrossingTrain[] = [];
  readonly signals: RailSignals;
  private reducedMotion = false;
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly color = new THREE.Color();
  private readonly masks: Uint8Array;
  private readonly tileTypes: Uint8Array;
  private readonly terrains: Uint8Array;
  private readonly roadClasses: Uint8Array;
  private readonly plantTypes: Uint8Array;
  /** 1 where a road overpass carries the road over the track. */
  private readonly overpasses: Uint8Array;
  /** Road connection bits per tile (0 off the road). */
  private readonly roadMasks: Uint8Array;
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
    this.roadClasses = new Uint8Array(tiles);
    this.roadMasks = new Uint8Array(tiles);
    this.plantTypes = new Uint8Array(tiles);
    this.overpasses = new Uint8Array(tiles);
    const make = (
      geometry: THREE.BufferGeometry,
      color: number,
      count: number,
      material: THREE.Material = surfaceMaterial({ color }),
    ) => {
      const mesh = new THREE.InstancedMesh(geometry, material, count);
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.count = 0;
      scene.add(mesh);
      return mesh;
    };
    // White base colour: ballast, sleepers and rails come from the vertex colours.
    const ballasted = (inner: BendSide, count: number) =>
      make(
        ballastedSegmentGeometry(inner),
        0xffffff,
        count,
        surfaceMaterial({ vertexColors: true }),
      );
    this.segments = ballasted(0, tiles * 4);
    this.crossings = make(crossingSegmentGeometry(0), RAIL_COLOR, tiles * 4);
    this.centres = make(centreGeometry(), BALLAST_COLOR, tiles);
    this.decks = make(new THREE.BoxGeometry(1, DECK_HEIGHT, DECK_WIDTH), DECK_COLOR, tiles);
    this.parapets = make(standingBoxGeometry(), PARAPET_COLOR, tiles * 2);
    this.barrierPosts = make(standingBoxGeometry(), BARRIER_POST_COLOR, tiles * 2);
    this.barrierBars = make(standingBoxGeometry(), BARRIER_BAR_COLOR, tiles * 2);
    // White base colour: the head's own colour is per instance, so it can blink.
    this.signalHeads = make(standingBoxGeometry(), 0xffffff, tiles * 2);
    this.bends = [ballasted(-1, tiles * 2), ballasted(1, tiles * 2)];
    this.crossingBends = [
      make(crossingSegmentGeometry(-1), RAIL_COLOR, tiles * 2),
      make(crossingSegmentGeometry(1), RAIL_COLOR, tiles * 2),
    ];
    this.signals = new RailSignals(scene);
    this.signals.setVehicles(this.railVehicles);
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
      const roadMask = diff.tileType === TileType.Road ? diff.roadMask : 0;
      if (this.roadMasks[diff.index] !== roadMask) {
        this.roadMasks[diff.index] = roadMask;
        if (diff.rail !== 0) changed = true;
      }
      if (this.roadClasses[diff.index] !== diff.roadClass) {
        this.roadClasses[diff.index] = diff.roadClass;
        if (diff.rail !== 0) changed = true;
      }
      if (this.overpasses[diff.index] !== diff.overpass) {
        this.overpasses[diff.index] = diff.overpass;
        if (diff.rail !== 0) changed = true;
      }
      if (this.plantTypes[diff.index] !== diff.plantType) {
        this.plantTypes[diff.index] = diff.plantType;
        // A station next to the track gives that track a signal.
        if (this.besideTrack(diff.index)) changed = true;
      }
    }
    if (changed) this.rebuild();
  }

  /** Whether a 4-neighbour of the tile carries track. */
  private besideTrack(index: number): boolean {
    const x = index % this.gridSize;
    const y = Math.floor(index / this.gridSize);
    return DIRECTIONS.some(({ dx, dy }) => {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= this.gridSize || ny >= this.gridSize) return false;
      return this.masks[ny * this.gridSize + nx] !== 0;
    });
  }

  /**
   * Connection bits a track tile gets toward the rail yards beside it: a
   * yard halts at its lowest-index track neighbour (`plantTrack` in the
   * sim), and that tile draws a stub to the yard's siding.
   */
  private yardStubBits(index: number): number {
    const size = this.gridSize;
    const x = index % size;
    const y = Math.floor(index / size);
    let bits = 0;
    for (const { dx, dy, bit } of DIRECTIONS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const yard = ny * size + nx;
      if (this.tileTypes[yard] !== TileType.Plant || this.plantTypes[yard] !== PlantType.RailYard)
        continue;
      let halt = -1;
      for (const d of DIRECTIONS) {
        const tx = nx + d.dx;
        const ty = ny + d.dy;
        if (tx < 0 || ty < 0 || tx >= size || ty >= size) continue;
        const track = ty * size + tx;
        if (this.masks[track] !== 0 && (halt < 0 || track < halt)) halt = track;
      }
      if (halt === index) bits |= bit;
    }
    return bits;
  }

  /** Ground under a point of a track tile: the deck top on a river tile, the terrain elsewhere. */
  private groundY(index: number, x: number, z: number): number {
    return this.terrains[index] === Terrain.River
      ? this.elevation.maxCornerY(index) + DECK_HEIGHT
      : this.elevation.surfaceY(x, z);
  }

  /** Ground height `distance` from the tile centre (x, z) in the direction of `angle`. */
  private groundAlong(
    index: number,
    x: number,
    z: number,
    angle: number,
    distance: number,
  ): number {
    return this.groundY(index, x + distance * Math.cos(angle), z - distance * Math.sin(angle));
  }

  /**
   * A piece of half-segment geometry from `from` to `to` along `angle`
   * (distances from the tile centre), pitched from `fromY` to `toY` and
   * stretched to the slope length, so track follows the ground and two
   * neighbours meet at the shared edge point.
   */
  private placePiece(
    mesh: THREE.InstancedMesh,
    slot: number,
    x: number,
    z: number,
    angle: number,
    from: number,
    fromY: number,
    to: number,
    toY: number,
  ): void {
    const run = to - from;
    const rise = toY - fromY;
    this.dummy.position.set(x + from * Math.cos(angle), fromY, z - from * Math.sin(angle));
    this.dummy.rotation.set(0, angle, Math.atan2(rise, run));
    this.dummy.scale.set(Math.hypot(run, rise) / 0.5, 1, 1);
    this.dummy.updateMatrix();
    mesh.setMatrixAt(slot, this.dummy.matrix);
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
   * coming (locomotives only: one leads every train) and the signals
   * see every occupied block (wagons too).
   */
  setTrains(vehicles: readonly VehicleState[]): void {
    this.trains.length = 0;
    this.railVehicles.length = 0;
    for (const vehicle of vehicles) {
      if (!RAIL_VEHICLES.has(vehicle.kind)) continue;
      this.railVehicles.push({ x: vehicle.x, y: vehicle.y });
      if (vehicle.kind === VehicleKind.Locomotive || vehicle.kind === VehicleKind.FreightLocomotive)
        this.trains.push({ x: vehicle.x, y: vehicle.y });
    }
    this.signals.setVehicles(this.railVehicles);
  }

  /** Signal lamps glow brighter at night. */
  setEnvironment(environment: RenderEnvironment): void {
    this.signals.setNight(environment.nightFactor);
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
    this.signals.update();
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
    this.dummy.scale.set(BARRIER_BAR.sx, barrier.length, BARRIER_BAR.sz);
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
    const bends = [0, 0];
    const crossingBends = [0, 0];
    let centres = 0;
    let decks = 0;
    let parapets = 0;
    let barriers = 0;
    for (let index = 0; index < this.masks.length; index++) {
      const mask = this.masks[index];
      if (mask === 0) continue;
      const x = (index % this.gridSize) + 0.5;
      const z = Math.floor(index / this.gridSize) + 0.5;
      // Under a road overpass the road is in the air: the track is plain.
      const onRoad = this.tileTypes[index] === TileType.Road && this.overpasses[index] === 0;
      const onRiver = this.terrains[index] === Terrain.River;
      const lift = onRoad ? CROSSING_LIFT : 0;
      const centreY = this.groundY(index, x, z) + lift;
      const bits = mask & (DIR_N | DIR_E | DIR_S | DIR_W);
      const alongX = (bits & (DIR_E | DIR_W)) !== 0 && (bits & (DIR_N | DIR_S)) === 0;
      const alongZ = (bits & (DIR_N | DIR_S)) !== 0 && (bits & (DIR_E | DIR_W)) === 0;
      const arms = bits | this.yardStubBits(index);
      const directions =
        arms === 0
          ? [DIRECTION_ANGLE[0], DIRECTION_ANGLE[2]]
          : DIRECTION_ANGLE.filter((d) => (arms & d.bit) !== 0);
      const bend = bits !== 0 && directions.length === 2 && !alongX && !alongZ;
      const roadHalf = onRoad ? roadHalfWidth(this.roadClasses[index]) : 0;
      for (const { bit, angle } of directions) {
        // A track arm that leaves the roadway (the road has no arm that
        // way) is flush only across the road and ballasted beyond it. A
        // bend stays flush to the tile edge: the piece is scaled to its
        // run, which would shrink the mitre at the corner.
        const roadEdge = onRoad && !bend && (this.roadMasks[index] & bit) === 0 ? roadHalf : 0.5;
        const edgeY = this.groundAlong(index, x, z, angle, roadEdge) + lift;
        let target: THREE.InstancedMesh;
        let slot: number;
        if (!bend) {
          target = onRoad ? this.crossings : this.segments;
          slot = onRoad ? crossings++ : segments++;
        } else {
          // The partner half leaves at angle b; its direction (cos b, -sin b)
          // projects onto this half's local z axis (sin a, cos a) as
          // sin(a - b): +1 when it lies at local +z, -1 at local -z.
          const partner = directions[0].angle === angle ? directions[1] : directions[0];
          const inner = Math.sin(angle - partner.angle) > 0 ? 1 : 0;
          const counts = onRoad ? crossingBends : bends;
          target = (onRoad ? this.crossingBends : this.bends)[inner];
          slot = counts[inner]++;
        }
        this.placePiece(target, slot, x, z, angle, 0, centreY, roadEdge, edgeY);
        if (roadEdge < 0.5) {
          // The ballasted piece starts the crossing lift less the trackbed
          // height above the ground, so its rails continue the flush rails'
          // top at the road edge, and ramps down to its usual height at the
          // tile edge, where the neighbour's track starts. The 0.012 ramp
          // (about 4° on a street, 7° on an avenue's shorter stretch) reads
          // better than a step at the road edge.
          const startY = edgeY - TRACKBED_HEIGHT;
          const tileEdgeY = this.groundAlong(index, x, z, angle, 0.5);
          this.placePiece(this.segments, segments++, x, z, angle, roadEdge, startY, 0.5, tileEdgeY);
        }
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
        // side of each approach (traffic keeps right), its bar raised, the
        // signal head on the post's top. Decoration — cars and trains
        // ignore each other. The post stands just off the roadway; the
        // bar hangs beside it and reaches to the road's centre line.
        const beside =
          roadHalfWidth(this.roadClasses[index]) + BARRIER_POST.sx / 2 + BARRIER_CLEARANCE;
        const hang = beside - BAR_OFF_POST;
        for (const s of [-1, 1]) {
          const px = alongX ? x + s * beside : x + s * BARRIER_ALONG_ROAD;
          const pz = alongX ? z + s * BARRIER_ALONG_ROAD : z - s * beside;
          const ground = this.groundY(index, px, pz);
          const yaw = alongX ? 0 : Math.PI / 2;
          this.placeBox(this.barrierPosts, barriers, px, ground, pz, BARRIER_POST, yaw);
          this.placeBox(
            this.signalHeads,
            barriers,
            px,
            ground + BARRIER_POST.sy,
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
            px: alongX ? x + s * hang : px,
            pz: alongX ? pz : z - s * hang,
            pivotY: ground + BARRIER_POST.sy,
            length: hang,
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
    this.bends[0].count = bends[0];
    this.bends[1].count = bends[1];
    this.crossingBends[0].count = crossingBends[0];
    this.crossingBends[1].count = crossingBends[1];
    this.centres.count = centres;
    this.decks.count = decks;
    this.parapets.count = parapets;
    this.barrierPosts.count = barriers;
    this.barrierBars.count = barriers;
    this.signalHeads.count = barriers;
    if (this.signalHeads.instanceColor) this.signalHeads.instanceColor.needsUpdate = true;
    this.signals.rebuild(
      this.masks,
      this.tileTypes,
      this.terrains,
      this.plantTypes,
      this.gridSize,
      this.elevation,
    );
    for (const mesh of [
      this.segments,
      this.crossings,
      ...this.bends,
      ...this.crossingBends,
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
