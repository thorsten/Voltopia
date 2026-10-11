import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GrowingMesh, PLANT_CAPACITY_START } from './growingMesh.ts';

function holder(scene: THREE.Scene): GrowingMesh {
  return new GrowingMesh(
    scene,
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial(),
    (mesh) => {
      mesh.frustumCulled = false;
    },
  );
}

function meshesIn(scene: THREE.Scene): THREE.InstancedMesh[] {
  return scene.children.filter(
    (c): c is THREE.InstancedMesh => (c as THREE.InstancedMesh).isInstancedMesh,
  );
}

describe('GrowingMesh', () => {
  it('starts with PLANT_CAPACITY_START instances, none drawn, in the scene', () => {
    const scene = new THREE.Scene();
    const g = holder(scene);
    expect(PLANT_CAPACITY_START).toBe(16);
    expect(g.mesh.instanceMatrix.count).toBe(16);
    expect(g.mesh.count).toBe(0);
    expect(meshesIn(scene)).toEqual([g.mesh]);
    expect(g.mesh.frustumCulled).toBe(false);
  });

  it('doubles its capacity on demand and swaps the mesh in the scene', () => {
    const scene = new THREE.Scene();
    const g = holder(scene);
    const old = g.mesh;
    const geometry = old.geometry;
    const material = old.material;
    g.ensure(17);
    expect(g.mesh).not.toBe(old);
    expect(g.mesh.instanceMatrix.count).toBe(32);
    expect(meshesIn(scene)).toEqual([g.mesh]);
    expect(g.mesh.frustumCulled).toBe(false);
    // Geometry and material are shared, never replaced.
    expect(g.mesh.geometry).toBe(geometry);
    expect(g.mesh.material).toBe(material);
    g.ensure(100);
    expect(g.mesh.instanceMatrix.count).toBe(128);
  });

  it('keeps the mesh when the capacity already suffices', () => {
    const scene = new THREE.Scene();
    const g = holder(scene);
    const old = g.mesh;
    g.ensure(16);
    expect(g.mesh).toBe(old);
  });

  it('keeps already written instances across growth', () => {
    const scene = new THREE.Scene();
    const g = holder(scene);
    g.mesh.setMatrixAt(5, new THREE.Matrix4().makeTranslation(1, 2, 3));
    g.mesh.setColorAt(5, new THREE.Color(0xff0000));
    g.commit(6);
    g.ensure(40);
    const m = new THREE.Matrix4();
    g.mesh.getMatrixAt(5, m);
    expect(new THREE.Vector3().setFromMatrixPosition(m).toArray()).toEqual([1, 2, 3]);
    const c = new THREE.Color();
    g.mesh.getColorAt(5, c);
    expect(c.getHex()).toBe(0xff0000);
    expect(g.mesh.count).toBe(6);
  });

  it('commits the count with upload ranges bounded by it', () => {
    const scene = new THREE.Scene();
    const g = holder(scene);
    g.mesh.setColorAt(0, new THREE.Color(0x00ff00));
    const version = g.mesh.instanceMatrix.version;
    g.commit(3);
    expect(g.mesh.count).toBe(3);
    expect(g.mesh.instanceMatrix.updateRanges).toEqual([{ start: 0, count: 48 }]);
    expect(g.mesh.instanceColor!.updateRanges).toEqual([{ start: 0, count: 9 }]);
    expect(g.mesh.instanceMatrix.version).toBeGreaterThan(version);
  });
});
