import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DIR_E, DIR_N, DIR_S, DIR_W, LINE_PRESENT } from '../shared/grid.ts';
import { Terrain, TileType, type TileDiff } from '../shared/types.ts';
import { ElevationField } from './elevationField.ts';
import { RoadsMesh } from './roadsMesh.ts';
import { ZEBRA_STRIPES } from './infrastructure/roadFurniture.ts';

const SIZE = 5;
const at = (x: number, y: number) => y * SIZE + x;

function tiles(): TileDiff[] {
  return Array.from({ length: SIZE * SIZE }, (_, index) => ({
    index,
    tileType: TileType.Empty,
    roadMask: 0,
    roadClass: 0,
    busStop: 0,
    terrain: Terrain.Land,
    elevation: 0,
    rail: 0,
  })) as unknown as TileDiff[];
}

function road(list: TileDiff[], x: number, y: number, mask: number): void {
  Object.assign(list[at(x, y)], { tileType: TileType.Road, roadMask: mask });
}

function layerWith(list: TileDiff[]): RoadsMesh {
  const field = new ElevationField(SIZE);
  field.applyDiffs(list);
  const layer = new RoadsMesh(new THREE.Scene(), SIZE, field);
  layer.applyDiffs(list);
  return layer;
}

/** A T-junction at (2,2): arms west, east and north. */
function tJunction(): TileDiff[] {
  const list = tiles();
  road(list, 1, 2, DIR_E);
  road(list, 2, 2, DIR_E | DIR_W | DIR_N);
  road(list, 3, 2, DIR_W);
  road(list, 2, 1, DIR_S);
  return list;
}

describe('RoadsMesh kerbs and zebra crossings', () => {
  it('draws kerbs on every road tile and stripes on the junction', () => {
    const layer = layerWith(tJunction());
    // Three dead ends (5 pieces each) + the T-junction (3 arms x 2 + 1 pad side).
    expect(layer.kerbs.mesh.count).toBe(3 * 5 + 7);
    expect(layer.stripes.mesh.count).toBe(3 * ZEBRA_STRIPES);
    expect(layer.kerbs.mesh.castShadow).toBe(false);
    expect(layer.stripes.mesh.castShadow).toBe(false);
  });

  it('draws neither on a bridge tile', () => {
    const list = tJunction();
    list[at(2, 2)].terrain = Terrain.River;
    const layer = layerWith(list);
    expect(layer.kerbs.mesh.count).toBe(3 * 5);
    expect(layer.stripes.mesh.count).toBe(0);
  });

  it('leaves the zebra off a level crossing', () => {
    const list = tJunction();
    list[at(2, 2)].rail = LINE_PRESENT | DIR_N | DIR_S;
    const layer = layerWith(list);
    expect(layer.stripes.mesh.count).toBe(0);
    expect(layer.kerbs.mesh.count).toBe(3 * 5 + 7);
  });
});
