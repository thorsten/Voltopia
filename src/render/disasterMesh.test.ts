import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
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
    ageStage: 0,
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
    // decalCount is the mesh's raw instance count: two prisms (low + high
    // ground triangle, see decal.ts) per damaged tile, so 2 tiles -> 4.
    expect(mesh.decalCount).toBe(4);
    expect(mesh.damagedTileCount).toBe(2);
    mesh.applyDiffs([baseDiff(3, 0)]);
    expect(mesh.decalCount).toBe(2);
    expect(mesh.damagedTileCount).toBe(1);
  });

  it('allocates exactly two decal instances per damaged tile at full-grid capacity', () => {
    const scene = new THREE.Scene();
    const mesh = new DisasterMesh(scene, SIZE, new ElevationField(SIZE));
    const tiles = SIZE * SIZE;
    // Damage every tile on the grid: the worst case for the decal mesh's
    // preallocated instance buffer (sized tiles * 2 in the constructor).
    // Nothing should be silently dropped even at full capacity.
    const diffs = Array.from({ length: tiles }, (_, index) => baseDiff(index, 40));
    mesh.applyDiffs(diffs);
    expect(mesh.decalCount).toBe(tiles * 2);
    expect(mesh.damagedTileCount).toBe(tiles);
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
    // Like the decals, floodCount is the raw instance count: two prisms
    // per flooded tile, so 2 tiles -> 4.
    expect(mesh.floodCount).toBe(4);
    mesh.setActiveKinds(new Map());
    expect(mesh.floodCount).toBe(0);
  });

  it('does not re-upload the fire buffers under reduced motion when the burning set is unchanged', () => {
    const scene = new THREE.Scene();
    const mesh = new DisasterMesh(scene, SIZE, new ElevationField(SIZE));
    // Construction order in disasterMesh.ts: decals, embers, smoke, flood.
    const embers = scene.children[1] as THREE.InstancedMesh;

    mesh.setReducedMotion(true);
    mesh.setActiveKinds(new Map([[3, DisasterKind.Fire]]));
    mesh.update(0.016, 1);
    expect(mesh.fireCount).toBe(1);

    // setStats calls setActiveKinds every sim tick even when nothing about
    // the fire changed; with reduced motion on, an unchanged tile set must
    // not force update() to rebuild (and re-upload) the ember/smoke meshes.
    const setMatrixAt = vi.spyOn(embers, 'setMatrixAt');
    mesh.setActiveKinds(new Map([[3, DisasterKind.Fire]]));
    mesh.update(0.016, 5);
    expect(setMatrixAt).not.toHaveBeenCalled();

    // A real change (a second tile catching) still forces a rebuild.
    mesh.setActiveKinds(
      new Map([
        [3, DisasterKind.Fire],
        [4, DisasterKind.Fire],
      ]),
    );
    mesh.update(0.016, 5);
    expect(setMatrixAt).toHaveBeenCalled();
    expect(mesh.fireCount).toBe(2);
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
