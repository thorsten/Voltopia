import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DIR_E, DIR_N, DIR_S, DIR_W, LINE_PRESENT } from '../shared/grid.ts';
import { RoadClass, Terrain, TileType, type TileDiff } from '../shared/types.ts';
import { ElevationField } from './elevationField.ts';
import { DECK_SIZE, OVERPASS_LIFT, RAIL_THICKNESS, RoadsMesh, roadHalfWidth } from './roadsMesh.ts';
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
    overpass: 0,
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

/** An east-west track under a north-south street with an overpass at (2, 2). */
function overpassRoad(): TileDiff[] {
  const list = tiles();
  road(list, 2, 0, DIR_S);
  road(list, 2, 1, DIR_N | DIR_S);
  road(list, 2, 2, DIR_N | DIR_S);
  road(list, 2, 3, DIR_N | DIR_S);
  road(list, 2, 4, DIR_N);
  Object.assign(list[at(2, 2)], { rail: LINE_PRESENT | DIR_E | DIR_W, overpass: 1 });
  return list;
}

function positionOf(mesh: THREE.InstancedMesh, slot: number): THREE.Vector3 {
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(slot, matrix);
  return new THREE.Vector3().setFromMatrixPosition(matrix);
}

describe('RoadsMesh overpass', () => {
  it('lifts the road surface on the deck and along the ramps', () => {
    const layer = layerWith(overpassRoad());
    expect(layer.lift(2.5, 2.5)).toBeCloseTo(OVERPASS_LIFT, 6);
    // North ramp (2,1): far edge at z = 1, deck edge at z = 2.
    expect(layer.lift(2.5, 1.0)).toBeCloseTo(0, 6);
    expect(layer.lift(2.5, 1.5)).toBeCloseTo(OVERPASS_LIFT / 2, 6);
    expect(layer.lift(2.5, 1.999999)).toBeCloseTo(OVERPASS_LIFT, 4);
    // South ramp (2,3): deck edge at z = 3, far edge at z = 4.
    expect(layer.lift(2.5, 3.25)).toBeCloseTo(OVERPASS_LIFT * 0.75, 6);
    // Plain road and off-road: nothing.
    expect(layer.lift(2.5, 0.5)).toBe(0);
    expect(layer.lift(5.5, 5.5)).toBe(0);
  });

  it('draws a deck with two railings on the overpass and walls on both ramps', () => {
    const layer = layerWith(overpassRoad());
    // One deck slab for the overpass tile plus one wedge per ramp.
    expect(layer.decks.count).toBe(3);
    // Two railings on the deck, two walls per ramp.
    expect(layer.rails.mesh.count).toBe(6);
    // Instances follow tile order: north ramp wedge, deck, south ramp wedge.
    const deck = positionOf(layer.decks, 1);
    expect(Math.floor(deck.z)).toBe(2);
    expect(deck.y).toBeGreaterThan(OVERPASS_LIFT - 0.05);
    // The wedges sit under the ramps, centred half-way up.
    expect(positionOf(layer.decks, 0).y).toBeCloseTo(OVERPASS_LIFT / 2 - 0.02, 2);
  });

  it('keeps lamps, kerbs, stripes and shelters off deck and ramps', () => {
    const list = overpassRoad();
    list[at(2, 1)].busStop = 1;
    const layer = layerWith(list);
    // Lamps stand on every other tile: (2,0) and (2,4) only ((2,2) is the deck, (2,1)/(2,3) ramps).
    expect(layer.lampPoles.mesh.count).toBe(2);
    expect(layer.shelters.count).toBe(0);
    // Kerbs: the two plain dead ends only (5 pieces each).
    expect(layer.kerbs.mesh.count).toBe(10);
  });

  it('turns a road tile into a ramp when the overpass appears beside it, and back', () => {
    const list = overpassRoad();
    list[at(2, 2)].overpass = 0;
    const layer = layerWith(list);
    expect(layer.lift(2.5, 1.5)).toBe(0);
    layer.applyDiffs([{ ...list[at(2, 2)], overpass: 1 }]);
    expect(layer.lift(2.5, 1.5)).toBeCloseTo(OVERPASS_LIFT / 2, 6);
    layer.applyDiffs([{ ...list[at(2, 2)], overpass: 0 }]);
    expect(layer.lift(2.5, 1.5)).toBe(0);
  });

  it('a ramp pad is pitched toward the deck', () => {
    const layer = layerWith(overpassRoad());
    // The ramp pad is the single `mesh` instance whose centre lies in tile (2,1).
    let pitched = 0;
    const matrix = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    for (let slot = 0; slot < layer.mesh.count; slot++) {
      layer.mesh.getMatrixAt(slot, matrix);
      matrix.decompose(p, q, s);
      if (Math.floor(p.z) !== 1 || Math.floor(p.x) !== 2) continue;
      const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
      expect(forward.y).toBeGreaterThan(0.2); // +z (toward the deck) climbs
      pitched++;
    }
    expect(pitched).toBe(1);
  });
});
