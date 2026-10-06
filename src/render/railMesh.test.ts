import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DIR_E, DIR_W, LINE_PRESENT } from '../shared/grid.ts';
import { Terrain, TileType, type TileDiff } from '../shared/types.ts';
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
  };
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
    const { segments, crossings, decks } = sceneWith(tiles);
    expect(crossings.count).toBe(2);
    expect(segments.count).toBe(2);
    expect(decks.count).toBe(1);
  });

  it('removing the track clears its instances', () => {
    const tiles = baseTiles();
    tiles[at(2, 2)].rail = LINE_PRESENT;
    const { mesh, segments } = sceneWith(tiles);
    mesh.applyDiffs([{ ...tiles[at(2, 2)], rail: 0 }]);
    expect(segments.count).toBe(0);
  });
});
