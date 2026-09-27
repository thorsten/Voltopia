import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DisasterKind, type TileDiff } from '../shared/types.ts';
import { DisasterMesh } from './disasterMesh.ts';
import { ElevationField } from './elevationField.ts';

const SIZE = 8;

function baseDiff(index: number, damage: number): TileDiff {
  // A full TileDiff with everything neutral but the damage.
  return {
    index,
    tileType: 0,
    roadMask: 0,
    roadClass: 0,
    trafficLoad: 0,
    powerLine: 0,
    zone: 0,
    density: 0,
    variant: 0,
    supplied: 0,
    services: 0,
    plantType: 0,
    terrain: 0,
    elevation: 0,
    forest: 0,
    geothermal: 0,
    reservoirHeat: 0,
    damage,
    deliveryState: 0,
    busStop: 0,
    stopState: 0,
    transitCover: 0,
  } as TileDiff;
}

describe('DisasterMesh', () => {
  it('draws one decal per damaged tile and drops it when repaired', () => {
    const scene = new THREE.Scene();
    const mesh = new DisasterMesh(scene, SIZE, new ElevationField(SIZE));
    mesh.applyDiffs([baseDiff(3, 40), baseDiff(4, 90)]);
    expect(mesh.decalCount).toBe(2);
    mesh.applyDiffs([baseDiff(3, 0)]);
    expect(mesh.decalCount).toBe(1);
  });

  it('draws embers only on tiles that are actually on fire', () => {
    const scene = new THREE.Scene();
    const mesh = new DisasterMesh(scene, SIZE, new ElevationField(SIZE));
    mesh.applyDiffs([baseDiff(3, 40), baseDiff(4, 40)]);
    mesh.setActiveKinds(new Map([[3, DisasterKind.Fire]]));
    mesh.update(0.016, 1);
    expect(mesh.fireCount).toBe(1);
  });

  it('never culls its instanced meshes', () => {
    const scene = new THREE.Scene();
    const mesh = new DisasterMesh(scene, SIZE, new ElevationField(SIZE));
    for (const child of scene.children) {
      if (child instanceof THREE.InstancedMesh) expect(child.frustumCulled).toBe(false);
    }
    expect(mesh).toBeDefined();
  });

  it('drops fire visuals once a tile stops burning', () => {
    const scene = new THREE.Scene();
    const mesh = new DisasterMesh(scene, SIZE, new ElevationField(SIZE));
    mesh.setActiveKinds(new Map([[3, DisasterKind.Fire]]));
    mesh.update(0.016, 1);
    expect(mesh.fireCount).toBe(1);
    mesh.setActiveKinds(new Map());
    mesh.update(0.016, 2);
    expect(mesh.fireCount).toBe(0);
  });

  it('draws the flood film only on tiles the flood actually covers', () => {
    const scene = new THREE.Scene();
    const mesh = new DisasterMesh(scene, SIZE, new ElevationField(SIZE));
    mesh.setActiveKinds(
      new Map([
        [5, DisasterKind.Flood],
        [6, DisasterKind.Flood],
      ]),
    );
    expect(mesh.floodCount).toBe(2);
    mesh.setActiveKinds(new Map());
    expect(mesh.floodCount).toBe(0);
  });

  it('draws nothing special for a storm-only tile', () => {
    const scene = new THREE.Scene();
    const mesh = new DisasterMesh(scene, SIZE, new ElevationField(SIZE));
    mesh.setActiveKinds(new Map([[3, DisasterKind.Storm]]));
    mesh.update(0.016, 1);
    expect(mesh.fireCount).toBe(0);
    expect(mesh.floodCount).toBe(0);
  });
});
