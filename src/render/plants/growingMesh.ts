import * as THREE from 'three';

/** Instances every plant mesh starts with; capacity doubles from here on demand. */
export const PLANT_CAPACITY_START = 16;

/**
 * Flags the first `count` instances of an instanced attribute for
 * re-upload. The range never goes empty: three.js reads an empty range
 * list as "upload everything".
 */
function flagRange(attr: THREE.InstancedBufferAttribute, count: number): void {
  attr.clearUpdateRanges();
  attr.addUpdateRange(0, Math.max(1, count) * attr.itemSize);
  if (count > 0) attr.needsUpdate = true;
}

/**
 * Draw `count` instances of an InstancedMesh with no instance colour (a
 * plain mesh outside a `GrowingMesh`, e.g. rotors or fill bars) and flag
 * only those for re-upload. `GrowingMesh.commit` uses this for the
 * matrix half and adds the colour attribute itself when the mesh has one.
 */
export function uploadDrawn(mesh: THREE.InstancedMesh, count: number): void {
  mesh.count = count;
  flagRange(mesh.instanceMatrix, count);
}

/**
 * An InstancedMesh whose capacity grows on demand. Growing replaces the
 * mesh (an InstancedMesh cannot be resized): the new one is set up
 * through `setup`, takes over the written instances and the old one
 * leaves the scene and is disposed. Geometry and material are shared
 * and outlive every mesh, so callers must read `mesh` afresh rather
 * than hold on to it.
 */
export class GrowingMesh {
  private current: THREE.InstancedMesh;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly geometry: THREE.BufferGeometry,
    private readonly material: THREE.Material,
    private readonly setup: (mesh: THREE.InstancedMesh) => void,
    start = PLANT_CAPACITY_START,
  ) {
    this.current = this.create(start);
    scene.add(this.current);
  }

  /** The current mesh (replaced on growth). */
  get mesh(): THREE.InstancedMesh {
    return this.current;
  }

  /** Grow the capacity by doubling until it holds `count` instances. */
  ensure(count: number): void {
    const old = this.current;
    let capacity = old.instanceMatrix.count;
    if (count <= capacity) return;
    while (capacity < count) capacity *= 2;
    const grown = this.create(capacity);
    grown.instanceMatrix.array.set(old.instanceMatrix.array);
    if (old.instanceColor) {
      // Allocates the colour buffer at the new capacity, then copies.
      grown.setColorAt(0, new THREE.Color());
      grown.instanceColor!.array.set(old.instanceColor.array);
    }
    grown.count = old.count;
    this.scene.remove(old);
    old.dispose();
    this.scene.add(grown);
    this.current = grown;
  }

  /**
   * Draw `count` instances and flag only those for re-upload. The range
   * never goes empty: three.js reads an empty range list as "upload
   * everything".
   */
  commit(count: number): void {
    uploadDrawn(this.current, count);
    if (this.current.instanceColor) flagRange(this.current.instanceColor, count);
  }

  /** Flag only the first `count` instance colours for re-upload (matrices untouched). */
  commitColors(count: number): void {
    if (this.current.instanceColor) flagRange(this.current.instanceColor, count);
  }

  private create(capacity: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(this.geometry, this.material, capacity);
    this.setup(mesh);
    mesh.count = 0;
    return mesh;
  }
}
