import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { AO_RESOLUTION_SCALE, aoSize, isOcclusionCaster } from './postprocessing.ts';

describe('isOcclusionCaster', () => {
  const box = new THREE.BoxGeometry();
  it('counts lit opaque meshes and instanced meshes', () => {
    expect(isOcclusionCaster(new THREE.Mesh(box, new THREE.MeshStandardMaterial()))).toBe(true);
    expect(
      isOcclusionCaster(new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial(), 3)),
    ).toBe(true);
  });
  it('skips unlit helpers and transparent surfaces', () => {
    expect(isOcclusionCaster(new THREE.Mesh(box, new THREE.MeshBasicMaterial()))).toBe(false);
    expect(
      isOcclusionCaster(
        new THREE.Mesh(box, new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.5 })),
      ),
    ).toBe(false);
    expect(isOcclusionCaster(new THREE.Group())).toBe(false);
  });
  it('a mesh with several materials casts if any is lit and opaque', () => {
    const mixed = new THREE.Mesh(box, [
      new THREE.MeshBasicMaterial(),
      new THREE.MeshStandardMaterial(),
    ]);
    expect(isOcclusionCaster(mixed)).toBe(true);
  });
});

describe('aoSize', () => {
  it('scales the drawing buffer by AO_RESOLUTION_SCALE and never drops below one pixel', () => {
    expect(aoSize(1600, 900)).toEqual({
      width: Math.round(1600 * AO_RESOLUTION_SCALE),
      height: Math.round(900 * AO_RESOLUTION_SCALE),
    });
    expect(aoSize(1, 1)).toEqual({ width: 1, height: 1 });
  });
});
