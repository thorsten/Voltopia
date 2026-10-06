import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DIR_E, DIR_N, DIR_W, LINE_PRESENT } from '../shared/grid.ts';
import {
  Terrain,
  TileType,
  VehicleKind,
  type TileDiff,
  type VehicleState,
} from '../shared/types.ts';
import { ElevationField } from './elevationField.ts';
import { RailMesh } from './railMesh.ts';

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
    expect(segments.count).toBe(2);
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

describe('RailMesh level-crossing barriers', () => {
  /** A straight east-west crossing at (3, 2) with its road running north-south. */
  function crossing() {
    const tiles = baseTiles();
    tiles[at(2, 2)].rail = LINE_PRESENT | DIR_E;
    tiles[at(3, 2)].rail = LINE_PRESENT | DIR_E | DIR_W;
    tiles[at(3, 2)].tileType = TileType.Road;
    tiles[at(3, 2)].roadMask = 5;
    tiles[at(4, 2)].rail = LINE_PRESENT | DIR_W;
    return sceneWith(tiles);
  }

  /** World direction the bar points in (its local +y axis after rotation). */
  function barDirection(bars: THREE.InstancedMesh, slot: number): THREE.Vector3 {
    return new THREE.Vector3(0, 1, 0).applyQuaternion(instanceOf(bars, slot).quaternion);
  }

  function train(x: number, y: number): VehicleState {
    return { id: 1, x, y, angle: 0, kind: VehicleKind.Locomotive };
  }

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
