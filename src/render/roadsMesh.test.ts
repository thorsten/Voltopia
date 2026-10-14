import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DIR_E, DIR_N, DIR_S, DIR_W, LINE_PRESENT } from '../shared/grid.ts';
import { OVERPASS_LONG_RAMP_TILES, OVERPASS_SHORT_RAMP_TILES } from '../shared/constants.ts';
import { RoadClass, Terrain, TileType, type TileDiff } from '../shared/types.ts';
import { ElevationField } from './elevationField.ts';
import {
  DECK_SIZE,
  OVERPASS_LIFT,
  RAIL_THICKNESS,
  ROAD_HEIGHT,
  RoadsMesh,
  roadHalfWidth,
} from './roadsMesh.ts';
import { KERB_WIDTH, LAMP_FOOT_SIZE, ZEBRA_STRIPES } from './infrastructure/roadFurniture.ts';

const SIZE = 8;
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

/**
 * An east-west track under a north-south street with an overpass at
 * (2, 3): ramps on (2, 1)–(2, 2) and (2, 4)–(2, 5), plain road beyond.
 */
function overpassRoad(): TileDiff[] {
  const list = tiles();
  road(list, 2, 0, DIR_S);
  for (let y = 1; y <= 5; y++) road(list, 2, y, DIR_N | DIR_S);
  road(list, 2, 6, DIR_N);
  Object.assign(list[at(2, 3)], {
    rail: LINE_PRESENT | DIR_E | DIR_W,
    overpass: OVERPASS_LONG_RAMP_TILES,
  });
  return list;
}

/**
 * The same street, with short ramps: (2,2) and (2,4) are the ramps;
 * (2,1) and (2,5) are plain road (in the game a junction would sit there).
 */
function shortOverpassRoad(): TileDiff[] {
  const list = overpassRoad();
  list[at(2, 3)].overpass = OVERPASS_SHORT_RAMP_TILES;
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
    expect(layer.lift(2.5, 3.5)).toBeCloseTo(OVERPASS_LIFT, 6);
    // North ramp over (2,1) and (2,2): far edge at z = 1, deck edge at z = 3.
    expect(layer.lift(2.5, 1.0)).toBeCloseTo(0, 6);
    expect(layer.lift(2.5, 1.5)).toBeCloseTo(OVERPASS_LIFT / 4, 6);
    expect(layer.lift(2.5, 2.0)).toBeCloseTo(OVERPASS_LIFT / 2, 6);
    expect(layer.lift(2.5, 2.5)).toBeCloseTo((OVERPASS_LIFT * 3) / 4, 6);
    expect(layer.lift(2.5, 2.999999)).toBeCloseTo(OVERPASS_LIFT, 4);
    // South ramp over (2,4) and (2,5): deck edge at z = 4, far edge at z = 6.
    expect(layer.lift(2.5, 4.25)).toBeCloseTo(OVERPASS_LIFT * (7 / 8), 6);
    expect(layer.lift(2.5, 5.5)).toBeCloseTo(OVERPASS_LIFT / 4, 6);
    // Plain road and off-road: nothing.
    expect(layer.lift(2.5, 0.5)).toBe(0);
    expect(layer.lift(2.5, 6.5)).toBe(0);
    expect(layer.lift(5.5, 5.5)).toBe(0);
  });

  it('draws a deck with two railings on the overpass and walls on both ramps', () => {
    const layer = layerWith(overpassRoad());
    // One deck slab for the overpass tile plus a plinth under each inner
    // ramp tile (the wedge of the far tile stands on the ground).
    expect(layer.decks.count).toBe(3);
    // Two railings on the deck, two walls per ramp tile.
    expect(layer.rails.mesh.count).toBe(2 + 4 * 2);
    // Instances follow tile order: north inner plinth (2,2), deck (2,3), south inner plinth (2,4).
    const deck = positionOf(layer.decks, 1);
    expect(Math.floor(deck.z)).toBe(3);
    expect(deck.y).toBeGreaterThan(OVERPASS_LIFT - 0.05);
    const plinth = positionOf(layer.decks, 0);
    expect(Math.floor(plinth.z)).toBe(2);
    expect(plinth.y).toBeCloseTo(OVERPASS_LIFT / 4, 6);
  });

  it('puts a wedge under each ramp tile, each rising one step toward the deck', () => {
    const layer = layerWith(overpassRoad());
    expect(layer.wedges.count).toBe(4);
    const matrix = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    // Far north tile (2,1): the wedge stands on the ground, half the deck lift
    // high, its rising edge (local +x) pointing south toward the deck.
    layer.wedges.getMatrixAt(0, matrix);
    matrix.decompose(p, q, s);
    expect(p.x).toBeCloseTo(2.5, 6);
    expect(p.y).toBeCloseTo(0, 6);
    expect(p.z).toBeCloseTo(1.5, 6);
    expect(s.y).toBeCloseTo(OVERPASS_LIFT / 2, 6);
    expect(new THREE.Vector3(1, 0, 0).applyQuaternion(q).z).toBeCloseTo(1, 6);
    // Inner north tile (2,2): the same wedge on a plinth half the lift high.
    layer.wedges.getMatrixAt(1, matrix);
    matrix.decompose(p, q, s);
    expect(p.z).toBeCloseTo(2.5, 6);
    expect(p.y).toBeCloseTo(OVERPASS_LIFT / 2, 6);
    expect(s.y).toBeCloseTo(OVERPASS_LIFT / 2, 6);
  });

  it('keeps lamps, kerbs, stripes and shelters off deck and ramps', () => {
    const list = overpassRoad();
    list[at(2, 1)].busStop = 1;
    const layer = layerWith(list);
    // Lamps stand on every other tile: (2,0) and (2,6) only; (2,1)–(2,5) are ramps and deck.
    expect(layer.lampPoles.mesh.count).toBe(2);
    expect(layer.shelters.count).toBe(0);
    // Kerbs: the two plain dead ends only (5 pieces each).
    expect(layer.kerbs.mesh.count).toBe(10);
  });

  it('turns a road tile into a ramp when the overpass appears beside it, and back', () => {
    const list = overpassRoad();
    list[at(2, 3)].overpass = 0;
    const layer = layerWith(list);
    expect(layer.lift(2.5, 1.5)).toBe(0);
    layer.applyDiffs([{ ...list[at(2, 3)], overpass: OVERPASS_LONG_RAMP_TILES }]);
    expect(layer.lift(2.5, 1.5)).toBeCloseTo(OVERPASS_LIFT / 4, 6);
    layer.applyDiffs([{ ...list[at(2, 3)], overpass: 0 }]);
    expect(layer.lift(2.5, 1.5)).toBe(0);
  });

  it('a short-ramp overpass climbs over the adjacent tile only', () => {
    const layer = layerWith(shortOverpassRoad());
    expect(layer.lift(2.5, 3.5)).toBeCloseTo(OVERPASS_LIFT, 6);
    // North ramp over (2,2) only: far edge at z = 2, deck edge at z = 3.
    expect(layer.lift(2.5, 1.5)).toBe(0);
    expect(layer.lift(2.5, 2.0)).toBeCloseTo(0, 6);
    expect(layer.lift(2.5, 2.5)).toBeCloseTo(OVERPASS_LIFT / 2, 6);
    // South ramp over (2,4): deck edge at z = 4, far edge at z = 5.
    expect(layer.lift(2.5, 4.25)).toBeCloseTo(OVERPASS_LIFT * (3 / 4), 6);
    expect(layer.lift(2.5, 5.5)).toBe(0);
  });

  it('a short ramp gets one full-height wedge on the ground and no plinth', () => {
    const layer = layerWith(shortOverpassRoad());
    // The deck slab only; no plinths.
    expect(layer.decks.count).toBe(1);
    // Two railings on the deck, two walls per ramp tile.
    expect(layer.rails.mesh.count).toBe(2 + 2 * 2);
    expect(layer.wedges.count).toBe(2);
    const matrix = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    layer.wedges.getMatrixAt(0, matrix);
    matrix.decompose(p, q, s);
    expect(p.z).toBeCloseTo(2.5, 6);
    expect(p.y).toBeCloseTo(0, 6);
    expect(s.y).toBeCloseTo(OVERPASS_LIFT, 6);
    const pitched: number[] = [];
    for (let slot = 0; slot < layer.mesh.count; slot++) {
      layer.mesh.getMatrixAt(slot, matrix);
      matrix.decompose(p, q, s);
      if (Math.floor(p.x) !== 2) continue;
      const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
      if (Math.abs(forward.y) > 1e-6) pitched.push(Math.floor(p.z));
    }
    // Only the two ramp pads are pitched, each by the full lift over its tile.
    expect(pitched.sort()).toEqual([2, 4]);
  });

  it('a ramp pad is pitched toward the deck', () => {
    const layer = layerWith(overpassRoad());
    // The far ramp pad is the single `mesh` instance whose centre lies in tile (2,1).
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
      // +z (toward the deck) climbs by half the lift over the tile.
      expect(forward.y / forward.z).toBeCloseTo(OVERPASS_LIFT / 2, 6);
      pitched++;
    }
    expect(pitched).toBe(1);
  });
});

/**
 * A street along x or z at across = 2 from along = 0 to 6, the overpass
 * deck at along = 3, on ground whose level follows `level(along)`.
 */
function slopedOverpass(
  alongX: boolean,
  rampTiles: number,
  level: (along: number) => number,
): { layer: RoadsMesh; field: ElevationField } {
  const list = tiles();
  const tile = (along: number) => (alongX ? at(along, 2) : at(2, along));
  const [toward, back] = alongX ? [DIR_E, DIR_W] : [DIR_S, DIR_N];
  for (let along = 0; along <= 6; along++) {
    const mask = (along > 0 ? back : 0) | (along < 6 ? toward : 0);
    Object.assign(list[tile(along)], { tileType: TileType.Road, roadMask: mask });
  }
  for (const diff of list) {
    const x = diff.index % SIZE;
    const z = Math.floor(diff.index / SIZE);
    diff.elevation = level(alongX ? x : z);
  }
  Object.assign(list[tile(3)], {
    rail: LINE_PRESENT | (alongX ? DIR_N | DIR_S : DIR_E | DIR_W),
    overpass: rampTiles,
  });
  const field = new ElevationField(SIZE);
  field.applyDiffs(list);
  const layer = new RoadsMesh(new THREE.Scene(), SIZE, field);
  layer.applyDiffs(list);
  return { layer, field };
}

/** Height of an instance's top face (local y = +0.5) above the world point (x, z). */
function topFaceY(mesh: THREE.InstancedMesh, slot: number, x: number, z: number): number {
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(slot, matrix);
  const point = new THREE.Vector3(0, 0.5, 0).applyMatrix4(matrix);
  const normal = new THREE.Vector3(0, 1, 0)
    .applyMatrix3(new THREE.Matrix3().getNormalMatrix(matrix))
    .normalize();
  return point.y - (normal.x * (x - point.x) + normal.z * (z - point.z)) / normal.y;
}

/** Slots of a mesh's instances centred inside tile (tx, tz). */
function slotsIn(mesh: THREE.InstancedMesh, tx: number, tz: number): number[] {
  const slots: number[] = [];
  for (let slot = 0; slot < mesh.count; slot++) {
    const p = positionOf(mesh, slot);
    if (Math.floor(p.x) === tx && Math.floor(p.z) === tz) slots.push(slot);
  }
  return slots;
}

describe('RoadsMesh overpass ramps on sloping ground', () => {
  // Falling away from the deck on the low side, rising past it on the high side.
  const slopes: { name: string; level: (along: number) => number }[] = [
    { name: 'ground falling away to the low end', level: (a) => [0, 0, 1, 2, 2, 2, 2, 2][a] },
    { name: 'a steady slope', level: (a) => [0, 0, 1, 1, 2, 2, 3, 3][a] },
    { name: 'a dip under the deck', level: (a) => [2, 2, 1, 0, 0, 1, 2, 2][a] },
  ];
  for (const rampTiles of [OVERPASS_SHORT_RAMP_TILES, OVERPASS_LONG_RAMP_TILES]) {
    for (const alongX of [false, true]) {
      for (const { name, level } of slopes) {
        const label = `${rampTiles}-tile ramps along ${alongX ? 'x' : 'z'} on ${name}`;
        it(`${label} meet the neighbour road and the deck flush`, () => {
          const { layer, field } = slopedOverpass(alongX, rampTiles, level);
          const point = (along: number): [number, number] => (alongX ? [along, 2.5] : [2.5, along]);
          const tileOf = (along: number): [number, number] => (alongX ? [along, 2] : [2, along]);
          const deckTop =
            field.maxCornerY(alongX ? at(3, 2) : at(2, 3)) + OVERPASS_LIFT + ROAD_HEIGHT;
          for (const side of [-1, 1]) {
            // Ramp tiles: along = 3 + side * step; the foot edge lies beyond the last one.
            const deckEdge = side < 0 ? 3 : 4;
            const footEdge = deckEdge + side * rampTiles;
            for (let step = 1; step <= rampTiles; step++) {
              const along = 3 + side * step;
              const [pad] = slotsIn(layer.mesh, ...tileOf(along));
              const near = side < 0 ? along + 1 : along;
              const far = side < 0 ? along : along + 1;
              const line = (edge: number) => {
                const footY = field.surfaceY(...point(footEdge)) + ROAD_HEIGHT;
                const s = (edge - footEdge) / (deckEdge - footEdge);
                return footY + (deckTop - footY) * s;
              };
              expect(topFaceY(layer.mesh, pad, ...point(far))).toBeCloseTo(line(far), 3);
              expect(topFaceY(layer.mesh, pad, ...point(near))).toBeCloseTo(line(near), 3);
              if (step === rampTiles) {
                // (1) flush with the neighbour road's top at the foot edge.
                expect(topFaceY(layer.mesh, pad, ...point(footEdge))).toBeCloseTo(
                  field.surfaceY(...point(footEdge)) + ROAD_HEIGHT,
                  3,
                );
              }
              if (step === 1) {
                // (2) flush with the deck road's top at the deck edge.
                expect(topFaceY(layer.mesh, pad, ...point(deckEdge))).toBeCloseTo(deckTop, 3);
              }
              // (3) vehicles ride the drawn carriageway (where it is above ground).
              for (const f of [0.1, 0.5, 0.9]) {
                const [x, z] = point(along + f);
                const ground = field.surfaceY(x, z);
                const top = topFaceY(layer.mesh, pad, x, z);
                expect(ground + layer.lift(x, z) + ROAD_HEIGHT).toBeCloseTo(
                  Math.max(top, ground + ROAD_HEIGHT),
                  3,
                );
              }
              // (4) the solid under the ramp reaches the ground at every corner.
              const [tx, tz] = tileOf(along);
              const bottoms = [
                ...slotsIn(layer.wedges, tx, tz).map((slot) => positionOf(layer.wedges, slot).y),
                ...slotsIn(layer.decks, tx, tz).map((slot) => {
                  const m = new THREE.Matrix4();
                  layer.decks.getMatrixAt(slot, m);
                  const p = new THREE.Vector3();
                  const s = new THREE.Vector3();
                  m.decompose(p, new THREE.Quaternion(), s);
                  return p.y - s.y / 2;
                }),
              ];
              const bottom = Math.min(...bottoms);
              for (const [cx, cz] of [
                [tx, tz],
                [tx + 1, tz],
                [tx, tz + 1],
                [tx + 1, tz + 1],
              ]) {
                expect(bottom).toBeLessThanOrEqual(field.cornerY(cx, cz) + 1e-6);
              }
            }
          }
        });
      }
    }
  }
});
