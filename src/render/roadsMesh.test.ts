import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DIR_E, DIR_N, DIR_S, DIR_W, LINE_PRESENT } from '../shared/grid.ts';
import { RoadClass, Terrain, TileType, type TileDiff } from '../shared/types.ts';
import { ElevationField } from './elevationField.ts';
import { DECK_SIZE, RAIL_THICKNESS, RoadsMesh, roadHalfWidth } from './roadsMesh.ts';
import { KERB_WIDTH, LAMP_FOOT_SIZE, ZEBRA_STRIPES } from './infrastructure/roadFurniture.ts';

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
    // The south pad side stays open where the track leaves the tile.
    expect(layer.kerbs.mesh.count).toBe(3 * 5 + 6);
  });
});

describe('RoadsMesh kerbs at level crossings', () => {
  it('keeps kerbs off the rails but keeps the arm kerbs', () => {
    const list = tiles();
    road(list, 2, 1, DIR_S);
    road(list, 2, 2, DIR_N | DIR_S);
    road(list, 2, 3, DIR_N);
    list[at(2, 2)].rail = LINE_PRESENT | DIR_E | DIR_W;
    const layer = layerWith(list);
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    let onCrossing = 0;
    for (let slot = 0; slot < layer.kerbs.mesh.count; slot++) {
      layer.kerbs.mesh.getMatrixAt(slot, matrix);
      matrix.decompose(position, new THREE.Quaternion(), scale);
      if (position.x < 2 || position.x > 3 || position.z < 2 || position.z > 3) continue;
      onCrossing++;
      // The track's centre line runs along z = 2.5.
      expect(Math.abs(position.z - 2.5)).toBeGreaterThan(scale.z / 2);
    }
    // Two kerbs along each of the two arms.
    expect(onCrossing).toBe(4);
  });
});

describe('RoadsMesh streetlamps', () => {
  const position = (mesh: THREE.InstancedMesh, slot: number) => {
    const matrix = new THREE.Matrix4();
    mesh.getMatrixAt(slot, matrix);
    return new THREE.Vector3().setFromMatrixPosition(matrix);
  };

  it('hangs the glow over the road, closer to the tile centre than the foot', () => {
    const list = tiles();
    road(list, 2, 2, DIR_E | DIR_W);
    const layer = layerWith(list);
    expect(layer.lampPoles.mesh.count).toBe(1);
    expect(layer.lampHeads.mesh.count).toBe(1);
    expect(layer.lampPoles.mesh.castShadow).toBe(true);
    const centre = new THREE.Vector2(2.5, 2.5);
    const foot = position(layer.lampPoles.mesh, 0);
    const head = position(layer.lampHeads.mesh, 0);
    const flat = (v: THREE.Vector3) => new THREE.Vector2(v.x, v.z).distanceTo(centre);
    expect(flat(head)).toBeLessThan(flat(foot));
    // The arm reaches toward the centre along the diagonal.
    expect(head.x).toBeCloseTo(head.z, 6);
    expect(head.y).toBeGreaterThan(foot.y + 0.25);
  });

  it('leaves a level crossing to its barriers', () => {
    const list = tiles();
    road(list, 2, 2, DIR_E | DIR_W);
    list[at(2, 2)].rail = LINE_PRESENT | DIR_N | DIR_S;
    expect(layerWith(list).lampPoles.mesh.count).toBe(0);
  });

  it('keeps the pole foot off an avenue roadway', () => {
    const list = tiles();
    road(list, 2, 2, DIR_E | DIR_W);
    list[at(2, 2)].roadClass = RoadClass.Avenue;
    const layer = layerWith(list);
    const foot = position(layer.lampPoles.mesh, 0);
    expect(foot.x - 2.5).toBeGreaterThan(roadHalfWidth(RoadClass.Avenue));
    expect(foot.x - 2.5).toBeLessThan(0.5);
  });

  for (const roadClass of [RoadClass.Street, RoadClass.Avenue]) {
    const label = roadClass === RoadClass.Avenue ? 'an avenue' : 'a street';
    it(`keeps the lamp of ${label} on a straight bridge inside the railing`, () => {
      for (const alongX of [true, false]) {
        const list = tiles();
        road(list, 2, 2, alongX ? DIR_E | DIR_W : DIR_N | DIR_S);
        Object.assign(list[at(2, 2)], { roadClass, terrain: Terrain.River });
        const layer = layerWith(list);
        const inner = DECK_SIZE / 2 - RAIL_THICKNESS;
        // A street's corner fits between the roadway and the railing; an
        // avenue leaves no room, so its straight bridges go without.
        expect(layer.lampPoles.mesh.count).toBe(roadClass === RoadClass.Avenue ? 0 : 1);
        for (let slot = 0; slot < layer.lampPoles.mesh.count; slot++) {
          const foot = position(layer.lampPoles.mesh, slot);
          const across = alongX ? foot.z - 2.5 : foot.x - 2.5;
          expect(Math.abs(across) + LAMP_FOOT_SIZE / 2).toBeLessThanOrEqual(inner);
        }
      }
    });
  }
});

describe('RoadsMesh bus shelters', () => {
  const position = (mesh: THREE.InstancedMesh, slot: number) => {
    const matrix = new THREE.Matrix4();
    mesh.getMatrixAt(slot, matrix);
    return new THREE.Vector3().setFromMatrixPosition(matrix);
  };

  /** World positions of a shelter instance's vertices. */
  function shelterVertices(layer: RoadsMesh, slot: number): THREE.Vector3[] {
    const matrix = new THREE.Matrix4();
    layer.shelters.getMatrixAt(slot, matrix);
    const attribute = layer.shelters.geometry.getAttribute('position');
    return Array.from({ length: attribute.count }, (_, i) =>
      new THREE.Vector3().fromBufferAttribute(attribute, i).applyMatrix4(matrix),
    );
  }

  for (const roadClass of [RoadClass.Street, RoadClass.Avenue]) {
    for (const alongX of [true, false]) {
      const label = `${roadClass === RoadClass.Avenue ? 'an avenue' : 'a street'} along ${alongX ? 'x' : 'z'}`;
      it(`stands the shelter on ${label} beyond the kerb, inside the tile, clear of the lamp`, () => {
        const list = tiles();
        road(list, 2, 2, alongX ? DIR_E | DIR_W : DIR_N | DIR_S);
        Object.assign(list[at(2, 2)], { roadClass, busStop: 1 });
        const layer = layerWith(list);
        expect(layer.shelters.count).toBe(1);
        const vertices = shelterVertices(layer, 0);
        const kerbside = roadHalfWidth(roadClass) + KERB_WIDTH;
        for (const v of vertices) {
          expect(v.x).toBeGreaterThanOrEqual(2);
          expect(v.x).toBeLessThanOrEqual(3);
          expect(v.z).toBeGreaterThanOrEqual(2);
          expect(v.z).toBeLessThanOrEqual(3);
          // The posts (all vertices near the ground) stand beyond the kerb.
          const across = Math.abs(alongX ? v.z - 2.5 : v.x - 2.5);
          if (v.y < 0.1) expect(across).toBeGreaterThan(kerbside);
        }
        // Clear of the streetlamp's foot.
        expect(layer.lampPoles.mesh.count).toBe(1);
        const lamp = position(layer.lampPoles.mesh, 0);
        const half = LAMP_FOOT_SIZE / 2;
        const xs = vertices.map((v) => v.x);
        const zs = vertices.map((v) => v.z);
        const clear =
          lamp.x + half < Math.min(...xs) ||
          lamp.x - half > Math.max(...xs) ||
          lamp.z + half < Math.min(...zs) ||
          lamp.z - half > Math.max(...zs);
        expect(clear).toBe(true);
      });
    }
  }
});
