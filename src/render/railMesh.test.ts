import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DIR_E, DIR_N, DIR_S, DIR_W, LINE_PRESENT } from '../shared/grid.ts';
import {
  PlantType,
  RoadClass,
  Terrain,
  TileType,
  VehicleKind,
  type TileDiff,
  type VehicleState,
} from '../shared/types.ts';
import { ElevationField } from './elevationField.ts';
import { RailMesh, SLEEPER_COLOR } from './railMesh.ts';
import { ROAD_HEIGHT, roadHalfWidth } from './roadsMesh.ts';
import { SIGNAL_GREEN, SIGNAL_RED } from './infrastructure/railSignals.ts';

const SIZE = 8;
const at = (x: number, y: number) => y * SIZE + x;

function baseTiles(): TileDiff[] {
  return Array.from({ length: SIZE * SIZE }, (_, index) => ({
    index,
    tileType: TileType.Empty,
    roadMask: 0,
    roadClass: 0,
    trafficLoad: 0,
    powerLine: 0,
    zone: 0,
    density: 0,
    variant: 0,
    supplied: 0,
    services: 0,
    heated: 0,
    island: 0,
    plantType: 0,
    terrain: Terrain.Land,
    elevation: 0,
    forest: 0,
    geothermal: 0,
    reservoirHeat: 0,
    damage: 0,
    stored: 0,
    ageStage: 0,
    deliveryState: 0,
    busStop: 0,
    stopState: 0,
    transitCover: 0,
    rail: 0,
    overpass: 0,
    railCover: 0,
    stationState: 0,
  })) as TileDiff[];
}

function sceneWith(diffs: TileDiff[]) {
  const scene = new THREE.Scene();
  const field = new ElevationField(SIZE);
  field.applyDiffs(diffs);
  const mesh = new RailMesh(scene, SIZE, field);
  mesh.applyDiffs(diffs);
  const instanced = scene.children.filter(
    (child): child is THREE.InstancedMesh => child instanceof THREE.InstancedMesh,
  );
  return {
    mesh,
    segments: instanced[0],
    crossings: instanced[1],
    centres: instanced[2],
    decks: instanced[3],
    parapets: instanced[4],
    barrierPosts: instanced[5],
    barrierBars: instanced[6],
    signalHeads: instanced[7],
    bendNeg: instanced[8],
    bendPos: instanced[9],
    crossingBendNeg: instanced[10],
    crossingBendPos: instanced[11],
  };
}

/** Position, rotation and scale of one instance. */
function instanceOf(mesh: THREE.InstancedMesh, slot: number) {
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(slot, matrix);
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(position, quaternion, scale);
  return { position, quaternion, scale };
}

describe('RailMesh', () => {
  it('draws one half-segment per connection bit, a centre per track tile, and never culls', () => {
    const tiles = baseTiles();
    tiles[at(2, 2)].rail = LINE_PRESENT | DIR_E;
    tiles[at(3, 2)].rail = LINE_PRESENT | DIR_E | DIR_W;
    tiles[at(4, 2)].rail = LINE_PRESENT | DIR_W;
    const { segments, crossings, centres, decks, mesh } = sceneWith(tiles);
    expect(segments.count).toBe(4);
    expect(centres.count).toBe(3);
    expect(crossings.count).toBe(0);
    expect(decks.count).toBe(0);
    expect(segments.frustumCulled).toBe(false);
    expect(mesh.hasRail(at(3, 2))).toBe(true);
    expect(mesh.hasRail(at(5, 2))).toBe(false);
  });

  it('an isolated track tile is drawn as a straight stub', () => {
    const tiles = baseTiles();
    tiles[at(5, 5)].rail = LINE_PRESENT;
    const { segments, centres } = sceneWith(tiles);
    expect(segments.count).toBe(2);
    expect(centres.count).toBe(1);
  });

  it('a track on a road tile is a level crossing and a track over the river gets a deck', () => {
    const tiles = baseTiles();
    tiles[at(2, 2)].rail = LINE_PRESENT | DIR_E;
    tiles[at(3, 2)].rail = LINE_PRESENT | DIR_E | DIR_W;
    tiles[at(3, 2)].tileType = TileType.Road;
    tiles[at(3, 2)].roadMask = 5;
    tiles[at(4, 2)].rail = LINE_PRESENT | DIR_W;
    tiles[at(4, 2)].terrain = Terrain.River;
    const { segments, crossings, decks, parapets, barrierPosts, barrierBars, signalHeads } =
      sceneWith(tiles);
    expect(crossings.count).toBe(2);
    // The neighbours' half-segments plus ballast beyond the roadway on both sides of the crossing.
    expect(segments.count).toBe(4);
    expect(decks.count).toBe(1);
    // The straight span over the river gets a parapet per side …
    expect(parapets.count).toBe(2);
    // … and the straight crossing a barrier post, a raised bar and a signal head per approach.
    expect(barrierPosts.count).toBe(2);
    expect(barrierBars.count).toBe(2);
    expect(signalHeads.count).toBe(2);
    const post = instanceOf(barrierPosts, 0);
    const bar = instanceOf(barrierBars, 0);
    // Track along x: the approaches come from north and south, so the
    // posts stand off the centre along z and beside the lane along x.
    expect(Math.abs(post.position.z - 2.5)).toBeGreaterThan(0.3);
    expect(Math.abs(post.position.x - 3.5)).toBeGreaterThan(0.2);
    expect(bar.position.y).toBeGreaterThan(post.position.y);
    expect(bar.scale.y).toBeGreaterThan(bar.scale.x);
  });

  it('a junction crossing gets no barriers and a curved bridge span no parapets', () => {
    const tiles = baseTiles();
    tiles[at(3, 2)].rail = LINE_PRESENT | DIR_E | DIR_W | DIR_N;
    tiles[at(3, 2)].tileType = TileType.Road;
    tiles[at(5, 5)].rail = LINE_PRESENT | DIR_E | DIR_N;
    tiles[at(5, 5)].terrain = Terrain.River;
    const { parapets, barrierPosts, decks } = sceneWith(tiles);
    expect(barrierPosts.count).toBe(0);
    expect(decks.count).toBe(1);
    expect(parapets.count).toBe(0);
  });

  it('a bend closes its outer corner and does not cross its inner rails', () => {
    const tiles = baseTiles();
    tiles[at(3, 3)].rail = LINE_PRESENT | DIR_E | DIR_S;
    const { segments, bendNeg, bendPos, crossings } = sceneWith(tiles);
    expect(segments.count).toBe(0);
    expect(crossings.count).toBe(0);
    expect(bendNeg.count).toBe(1);
    expect(bendPos.count).toBe(1);
    // The east half runs +x; its partner leaves to the south (+z), so
    // its inner rail lies at +z and the half lands in the +z bend mesh.
    const east = instanceOf(bendPos, 0);
    const south = instanceOf(bendNeg, 0);
    expect(new THREE.Vector3(1, 0, 0).applyQuaternion(east.quaternion).x).toBeCloseTo(1, 6);
    expect(new THREE.Vector3(1, 0, 0).applyQuaternion(south.quaternion).z).toBeCloseTo(1, 6);
    expect(east.scale.x).toBeCloseTo(1, 6);
    // In the bend geometry the outer rail reaches past the centre to the
    // outer corner, while the inner rail starts short of the centre; the
    // ballast and sleepers under them keep the plain footprint.
    const railMinX = (mesh: THREE.InstancedMesh, sign: number) => {
      const position = mesh.geometry.getAttribute('position');
      let min = Infinity;
      for (let i = 0; i < position.count; i++)
        if (position.getY(i) > 0.045 && Math.sign(position.getZ(i)) === sign)
          min = Math.min(min, position.getX(i));
      return min;
    };
    expect(railMinX(bendPos, -1)).toBeCloseTo(-0.105, 6);
    expect(railMinX(bendPos, 1)).toBeCloseTo(0.075, 6);
    expect(railMinX(bendNeg, 1)).toBeCloseTo(-0.105, 6);
    expect(railMinX(bendNeg, -1)).toBeCloseTo(0.075, 6);
    bendPos.geometry.computeBoundingBox();
    expect(bendPos.geometry.boundingBox!.max.x).toBeCloseTo(0.5, 6);
    expect(bendPos.geometry.boundingBox!.max.y).toBeCloseTo(0.07, 6);
  });

  it('draws plain ballasted track and no barriers under a road overpass', () => {
    const tiles = baseTiles();
    tiles[at(2, 2)].rail = LINE_PRESENT | DIR_E;
    tiles[at(3, 2)].rail = LINE_PRESENT | DIR_E | DIR_W;
    tiles[at(3, 2)].tileType = TileType.Road;
    tiles[at(3, 2)].roadMask = DIR_N | DIR_S;
    tiles[at(3, 2)].overpass = 1;
    tiles[at(4, 2)].rail = LINE_PRESENT | DIR_W;
    const { segments, crossings, centres, barrierPosts, signalHeads } = sceneWith(tiles);
    expect(crossings.count).toBe(0);
    expect(segments.count).toBe(4);
    expect(centres.count).toBe(3);
    expect(barrierPosts.count).toBe(0);
    expect(signalHeads.count).toBe(0);
  });

  it('a bend on a road tile is flush to the tile edge, without ballast or barriers', () => {
    const tiles = baseTiles();
    tiles[at(3, 3)].rail = LINE_PRESENT | DIR_W | DIR_N;
    tiles[at(3, 3)].tileType = TileType.Road;
    tiles[at(3, 3)].roadMask = 5;
    const { segments, crossings, crossingBendNeg, crossingBendPos, barrierPosts } =
      sceneWith(tiles);
    expect(segments.count).toBe(0);
    expect(crossings.count).toBe(0);
    expect(crossingBendNeg.count).toBe(1);
    expect(crossingBendPos.count).toBe(1);
    expect(instanceOf(crossingBendNeg, 0).scale.x).toBeCloseTo(1, 6);
    expect(barrierPosts.count).toBe(0);
  });

  it('pitches a half-segment up a slope and stretches it to the edge', () => {
    const tiles = baseTiles();
    // Ground rises one level from x = 5 on. The corner heights blend
    // neighbouring tiles, so (4, 2) slopes while (3, 2) is still level.
    for (const tile of tiles) if (tile.index % SIZE >= 5) tile.elevation = 1;
    tiles[at(2, 2)].rail = LINE_PRESENT | DIR_E;
    tiles[at(3, 2)].rail = LINE_PRESENT | DIR_E | DIR_W;
    tiles[at(4, 2)].rail = LINE_PRESENT | DIR_E | DIR_W;
    tiles[at(5, 2)].rail = LINE_PRESENT | DIR_W;
    const { segments } = sceneWith(tiles);
    // Instances per tile follow DIRECTION_ANGLE order (E before W):
    // slots 1/2 = (3,2) E/W, slots 3/4 = (4,2) E/W.
    const level = instanceOf(segments, 1);
    const climb = instanceOf(segments, 3);
    const back = instanceOf(segments, 4);
    const xAxis = new THREE.Vector3(1, 0, 0);
    const levelDir = xAxis.clone().applyQuaternion(level.quaternion);
    const climbDir = xAxis.clone().applyQuaternion(climb.quaternion);
    expect(Math.abs(levelDir.y)).toBeLessThan(1e-6); // level ground: no pitch …
    expect(level.scale.x).toBeCloseTo(1, 6); // … and no stretch
    expect(climbDir.y).toBeGreaterThan(0.05); // climbs toward the higher east edge
    expect(climb.scale.x).toBeGreaterThan(1.001); // stretched to reach that edge
    // Both halves of the sloped tile start at the same tile-centre point.
    expect(climb.position.x).toBeCloseTo(back.position.x, 6);
    expect(climb.position.y).toBeCloseTo(back.position.y, 6);
  });

  it('removing the track clears its instances', () => {
    const tiles = baseTiles();
    tiles[at(2, 2)].rail = LINE_PRESENT;
    const { mesh, segments } = sceneWith(tiles);
    mesh.applyDiffs([{ ...tiles[at(2, 2)], rail: 0 }]);
    expect(segments.count).toBe(0);
  });
});

describe('RailMesh rail yard stub', () => {
  it('draws a stub from the track toward a rail yard that halts at it', () => {
    const tiles = baseTiles();
    tiles[at(3, 2)].rail = LINE_PRESENT | DIR_E;
    tiles[at(4, 2)].rail = LINE_PRESENT | DIR_E | DIR_W;
    tiles[at(5, 2)].rail = LINE_PRESENT | DIR_W;
    tiles[at(4, 3)].tileType = TileType.Plant;
    tiles[at(4, 3)].plantType = PlantType.RailYard;
    const { segments } = sceneWith(tiles);
    // Four halves of the line plus the stub south from (4, 2).
    expect(segments.count).toBe(5);
    // Instances per tile follow DIRECTION_ANGLE order: (4, 2) is E, W, S.
    const stub = instanceOf(segments, 3);
    expect(stub.position.x).toBeCloseTo(4.5, 6);
    expect(stub.position.z).toBeCloseTo(2.5, 6);
    expect(new THREE.Vector3(1, 0, 0).applyQuaternion(stub.quaternion).z).toBeCloseTo(1, 6);
  });

  it('gives a yard one stub, from its lowest-index track neighbour only', () => {
    const tiles = baseTiles();
    // Track north and west of the yard at (4, 3): the north tile has the lower index.
    tiles[at(4, 2)].rail = LINE_PRESENT | DIR_E;
    tiles[at(5, 2)].rail = LINE_PRESENT | DIR_W;
    tiles[at(3, 3)].rail = LINE_PRESENT | DIR_N;
    tiles[at(3, 2)].rail = LINE_PRESENT | DIR_S;
    tiles[at(4, 3)].tileType = TileType.Plant;
    tiles[at(4, 3)].plantType = PlantType.RailYard;
    const { segments } = sceneWith(tiles);
    expect(segments.count).toBe(5);
  });

  it('a station beside the track gets no stub, and a demolished yard loses its stub', () => {
    const tiles = baseTiles();
    tiles[at(4, 2)].rail = LINE_PRESENT | DIR_E;
    tiles[at(5, 2)].rail = LINE_PRESENT | DIR_W;
    tiles[at(4, 3)].tileType = TileType.Plant;
    tiles[at(4, 3)].plantType = PlantType.TrainStation;
    const { mesh, segments } = sceneWith(tiles);
    expect(segments.count).toBe(2);
    mesh.applyDiffs([{ ...tiles[at(4, 3)], plantType: PlantType.RailYard }]);
    expect(segments.count).toBe(3);
    mesh.applyDiffs([{ ...tiles[at(4, 3)], tileType: TileType.Empty, plantType: 0 }]);
    expect(segments.count).toBe(2);
  });
});

describe('RailMesh sleepers', () => {
  it('keeps the ballasted segment footprint and rail-top height', () => {
    const { segments } = sceneWith(baseTiles());
    const geometry = segments.geometry;
    geometry.computeBoundingBox();
    const { min, max } = geometry.boundingBox!;
    expect(min.x).toBeCloseTo(0, 6);
    expect(max.x).toBeCloseTo(0.5, 6);
    expect(min.y).toBeCloseTo(0, 6);
    // Rail tops: ballast bed and sleepers 0.04, rails 0.03 on top.
    expect(max.y).toBeCloseTo(0.07, 6);
    expect(min.z).toBeCloseTo(-0.15, 6);
    expect(max.z).toBeCloseTo(0.15, 6);
  });

  it('bakes sleepers into the ballasted segment as vertex colours', () => {
    const { segments } = sceneWith(baseTiles());
    const colors = segments.geometry.getAttribute('color');
    expect(colors).toBeDefined();
    const sleeper = new THREE.Color(SLEEPER_COLOR);
    let found = false;
    for (let i = 0; i < colors.count && !found; i++) {
      found =
        Math.abs(colors.getX(i) - sleeper.r) < 1e-6 &&
        Math.abs(colors.getY(i) - sleeper.g) < 1e-6 &&
        Math.abs(colors.getZ(i) - sleeper.b) < 1e-6;
    }
    expect(found).toBe(true);
    expect((segments.material as THREE.MeshStandardMaterial).vertexColors).toBe(true);
  });
});

describe('RailMesh crossing ballast', () => {
  /** Horizontal distance from the tile centre (cx, cz) to both ends of a half-segment instance. */
  function extent(mesh: THREE.InstancedMesh, slot: number, cx: number, cz: number) {
    const { position, quaternion, scale } = instanceOf(mesh, slot);
    // The segment geometry runs 0.5 along local +x from its origin.
    const end = new THREE.Vector3(0.5 * scale.x, 0, 0).applyQuaternion(quaternion).add(position);
    const flat = (p: THREE.Vector3) => Math.hypot(p.x - cx, p.z - cz);
    return { from: flat(position), to: flat(end), startY: position.y, endY: end.y };
  }

  for (const roadClass of [RoadClass.Street, RoadClass.Avenue]) {
    const label = roadClass === RoadClass.Avenue ? 'an avenue' : 'a street';
    const half = roadHalfWidth(roadClass);

    it(`ballasts a straight crossing of ${label} from the road edge to the tile edge`, () => {
      const tiles = baseTiles();
      tiles[at(3, 3)].rail = LINE_PRESENT | DIR_N | DIR_S;
      tiles[at(3, 3)].tileType = TileType.Road;
      tiles[at(3, 3)].roadMask = DIR_E | DIR_W;
      tiles[at(3, 3)].roadClass = roadClass;
      const { segments, crossings, centres } = sceneWith(tiles);
      expect(segments.count).toBe(2);
      expect(crossings.count).toBe(2);
      expect(centres.count).toBe(0);
      for (const slot of [0, 1]) {
        const ballast = extent(segments, slot, 3.5, 3.5);
        expect(Math.abs(ballast.from - half)).toBeLessThan(0.01);
        expect(Math.abs(ballast.to - 0.5)).toBeLessThan(0.01);
        // Flush rails stop where the roadway does.
        const flush = extent(crossings, slot, 3.5, 3.5);
        expect(flush.from).toBeLessThan(0.01);
        expect(Math.abs(flush.to - half)).toBeLessThan(0.01);
        // The ballasted rails meet the flush ones at the road edge (rails
        // sit TRACKBED_HEIGHT = 0.04 above a ballasted piece and right on
        // the asphalt on the road), and the piece reaches the ground at the
        // tile edge, where the neighbour's track starts.
        const ballastRailTop = ballast.startY + 0.04;
        const flushRailTop = flush.endY;
        expect(Math.abs(ballastRailTop - flushRailTop)).toBeLessThanOrEqual(0.003);
        expect(ballast.endY).toBeCloseTo(0, 6);
        // The flush rails rest on the road surface, not in it.
        expect(flush.startY).toBeGreaterThanOrEqual(ROAD_HEIGHT);
        expect(flush.endY).toBeGreaterThanOrEqual(ROAD_HEIGHT);
      }
    });
  }

  it('ballasts every track arm of a junction crossing that leaves the roadway', () => {
    const tiles = baseTiles();
    // Track east, west and north; the road runs north-south, so only the
    // east and west arms leave the roadway.
    tiles[at(3, 3)].rail = LINE_PRESENT | DIR_E | DIR_W | DIR_N;
    tiles[at(3, 3)].tileType = TileType.Road;
    tiles[at(3, 3)].roadMask = DIR_N | DIR_S;
    const { segments, crossings, barrierPosts } = sceneWith(tiles);
    expect(crossings.count).toBe(3);
    expect(segments.count).toBe(2);
    expect(barrierPosts.count).toBe(0);
    const half = roadHalfWidth(RoadClass.Street);
    for (const slot of [0, 1]) {
      const ballast = extent(segments, slot, 3.5, 3.5);
      expect(Math.abs(ballast.from - half)).toBeLessThan(0.01);
      expect(Math.abs(ballast.to - 0.5)).toBeLessThan(0.01);
    }
    // The north arm runs along the road: flush all the way to the edge.
    const north = extent(crossings, 1, 3.5, 3.5);
    expect(Math.abs(north.to - 0.5)).toBeLessThan(0.01);
  });
});

describe('RailMesh level-crossing barriers', () => {
  /** A straight east-west crossing at (3, 2) with its road running north-south. */
  function crossing(roadClass: number = RoadClass.Street) {
    const tiles = baseTiles();
    tiles[at(2, 2)].rail = LINE_PRESENT | DIR_E;
    tiles[at(3, 2)].rail = LINE_PRESENT | DIR_E | DIR_W;
    tiles[at(3, 2)].tileType = TileType.Road;
    tiles[at(3, 2)].roadMask = DIR_N | DIR_S;
    tiles[at(3, 2)].roadClass = roadClass;
    tiles[at(4, 2)].rail = LINE_PRESENT | DIR_W;
    return sceneWith(tiles);
  }

  /** A straight north-south crossing at (3, 3) with its road running east-west. */
  function crossingAlongZ(roadClass: number) {
    const tiles = baseTiles();
    tiles[at(3, 3)].rail = LINE_PRESENT | DIR_N | DIR_S;
    tiles[at(3, 3)].tileType = TileType.Road;
    tiles[at(3, 3)].roadMask = DIR_E | DIR_W;
    tiles[at(3, 3)].roadClass = roadClass;
    return sceneWith(tiles);
  }

  for (const roadClass of [RoadClass.Street, RoadClass.Avenue]) {
    const label = roadClass === RoadClass.Avenue ? 'an avenue' : 'a street';
    const half = roadHalfWidth(roadClass);

    it(`stands the posts beside the roadway of ${label}, inside the tile`, () => {
      // Track along x: the road runs along z, so the lateral offset is in x.
      for (const [{ barrierPosts }, lateralOf] of [
        [crossing(roadClass), (p: THREE.Vector3) => p.x - 3.5],
        [crossingAlongZ(roadClass), (p: THREE.Vector3) => p.z - 3.5],
      ] as const) {
        expect(barrierPosts.count).toBe(2);
        for (const slot of [0, 1]) {
          const post = instanceOf(barrierPosts, slot);
          const lateral = Math.abs(lateralOf(post.position));
          const halfPost = post.scale.x / 2;
          expect(lateral - halfPost).toBeGreaterThan(half);
          expect(lateral + halfPost).toBeLessThanOrEqual(0.5);
        }
      }
    });

    it(`lowers the bar of ${label} to the road's centre line`, () => {
      const { mesh, barrierBars } = crossing(roadClass);
      mesh.setTrains([train(5, 2.5)]);
      mesh.update(1, 1);
      for (const slot of [0, 1]) {
        const bar = instanceOf(barrierBars, slot);
        const tip = new THREE.Vector3(0, 1, 0).applyMatrix4(
          new THREE.Matrix4().compose(bar.position, bar.quaternion, bar.scale),
        );
        expect(Math.abs(tip.x - 3.5)).toBeLessThan(0.03);
      }
    });
  }

  /** World direction the bar points in (its local +y axis after rotation). */
  function barDirection(bars: THREE.InstancedMesh, slot: number): THREE.Vector3 {
    return new THREE.Vector3(0, 1, 0).applyQuaternion(instanceOf(bars, slot).quaternion);
  }

  function train(x: number, y: number): VehicleState {
    return { id: 1, x, y, angle: 0, kind: VehicleKind.Locomotive };
  }

  it('mounts the signal head on the post and hangs the bar beside it', () => {
    const { mesh, barrierPosts, barrierBars, signalHeads } = crossing();
    for (const slot of [0, 1]) {
      const post = instanceOf(barrierPosts, slot);
      const head = instanceOf(signalHeads, slot);
      // The head stands on the post's top, over its foot.
      expect(head.position.x).toBeCloseTo(post.position.x, 6);
      expect(head.position.z).toBeCloseTo(post.position.z, 6);
      expect(head.position.y).toBeCloseTo(post.position.y + post.scale.y, 6);
      // The bar pivots at the post's top, beside it toward the road's centre.
      const bar = instanceOf(barrierBars, slot);
      expect(bar.position.y).toBeCloseTo(post.position.y + post.scale.y, 6);
      expect(Math.abs(bar.position.x - 3.5)).toBeLessThan(Math.abs(post.position.x - 3.5));
      expect(Math.abs(bar.position.x - 3.5)).toBeGreaterThan(
        Math.abs(post.position.x - 3.5) - post.scale.x,
      );
    }
    // Lowering the bar leaves the head where it is.
    const before = instanceOf(signalHeads, 0).position.clone();
    mesh.setTrains([train(5, 2.5)]);
    mesh.update(1, 1);
    expect(instanceOf(signalHeads, 0).position).toEqual(before);
  });

  it('keeps the bars raised while no train is near', () => {
    const { mesh, barrierBars } = crossing();
    mesh.setTrains([train(7.5, 2.5)]); // four tiles east: out of range
    mesh.update(1, 1);
    for (const slot of [0, 1]) expect(barDirection(barrierBars, slot).y).toBeCloseTo(1, 6);
  });

  it('lowers both bars across the road when a train approaches on the track', () => {
    const { mesh, barrierBars } = crossing();
    mesh.setTrains([train(5, 2.5)]); // 1.5 tiles east on the track axis
    mesh.update(1, 1);
    // Barriers are placed for s = -1 then s = +1; each bar swings from its
    // post toward the road's centre line, so across the lane and flat.
    const near = barDirection(barrierBars, 0);
    const far = barDirection(barrierBars, 1);
    expect(Math.abs(near.y)).toBeLessThan(1e-6);
    expect(Math.abs(far.y)).toBeLessThan(1e-6);
    expect(near.x).toBeCloseTo(1, 6);
    expect(far.x).toBeCloseTo(-1, 6);
  });

  it('ignores a train that is not on this crossing', () => {
    const { mesh, barrierBars } = crossing();
    mesh.setTrains([train(3.5, 5)]); // on the road axis, 2.5 tiles off the track
    mesh.update(1, 1);
    expect(barDirection(barrierBars, 0).y).toBeCloseTo(1, 6);
  });

  it('sweeps down over time and back up once the train has passed', () => {
    const { mesh, barrierBars } = crossing();
    mesh.setTrains([train(5, 2.5)]);
    mesh.update(0.1, 0.1);
    const partway = barDirection(barrierBars, 0);
    expect(partway.y).toBeLessThan(1); // moving …
    expect(partway.y).toBeGreaterThan(0.1); // … but not there yet
    mesh.setTrains([]);
    mesh.update(1, 1.1);
    expect(barDirection(barrierBars, 0).y).toBeCloseTo(1, 6);
  });

  it('snaps without a sweep and holds the signal steady under reduced motion', () => {
    const { mesh, barrierBars, signalHeads } = crossing();
    mesh.setReducedMotion(true);
    mesh.setTrains([train(5, 2.5)]);
    mesh.update(0.016, 0.016);
    expect(Math.abs(barDirection(barrierBars, 0).y)).toBeLessThan(1e-6);
    const lit = new THREE.Color();
    signalHeads.getColorAt(0, lit);
    mesh.update(0.016, 1.016);
    const later = new THREE.Color();
    signalHeads.getColorAt(0, later);
    expect(later.getHex()).toBe(lit.getHex());
  });

  it('blinks the signal head while the crossing is closed', () => {
    const { mesh, signalHeads } = crossing();
    mesh.setTrains([train(5, 2.5)]);
    mesh.update(1, 1);
    const colors = [0, 0.5, 1, 1.5].map((offset) => {
      mesh.update(0.016, 1 + offset);
      const color = new THREE.Color();
      signalHeads.getColorAt(0, color);
      return color.getHex();
    });
    expect(new Set(colors).size).toBeGreaterThan(1);
  });
});

describe('RailMesh occupancy signals', () => {
  /** A straight east-west line along row 2 with a station south of (3,2). */
  function lineWithStation(stationFirst: boolean) {
    const tiles = baseTiles();
    for (let x = 0; x < SIZE; x++) {
      tiles[at(x, 2)].rail = LINE_PRESENT | (x > 0 ? DIR_W : 0) | (x < SIZE - 1 ? DIR_E : 0);
    }
    const station = tiles[at(3, 3)];
    const scene = new THREE.Scene();
    const field = new ElevationField(SIZE);
    field.applyDiffs(tiles);
    const mesh = new RailMesh(scene, SIZE, field);
    if (stationFirst) {
      Object.assign(station, { tileType: TileType.Plant, plantType: PlantType.TrainStation });
      mesh.applyDiffs(tiles);
    } else {
      mesh.applyDiffs(tiles);
      // The station is built next to existing track: only its own tile changes.
      Object.assign(station, { tileType: TileType.Plant, plantType: PlantType.TrainStation });
      mesh.applyDiffs([station]);
    }
    return mesh;
  }

  const lampHex = (mesh: RailMesh) => {
    const color = new THREE.Color();
    mesh.signals.lamps.mesh.getColorAt(0, color);
    return color.getHex();
  };

  it('signals beside a station built next to the track', () => {
    expect(lineWithStation(true).signals.masts.mesh.count).toBe(1);
    expect(lineWithStation(false).signals.masts.mesh.count).toBe(1);
  });

  it('shows red while a wagon is in the block and green once it has left', () => {
    const mesh = lineWithStation(true);
    const wagon = (x: number): VehicleState => ({
      id: 2,
      x,
      y: 2.5,
      angle: 0,
      kind: VehicleKind.FreightWagon,
    });
    mesh.setTrains([wagon(4.5)]);
    mesh.update(0.016, 0.016);
    expect(lampHex(mesh)).toBe(SIGNAL_RED);
    mesh.setTrains([wagon(6.5)]);
    mesh.update(0.016, 0.032);
    expect(lampHex(mesh)).toBe(SIGNAL_GREEN);
  });
});
