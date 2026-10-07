import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { SURFACE_ROUGHNESS, surfaceMaterial } from './materials.ts';

describe('surfaceMaterial', () => {
  it('is a rough, non-metallic standard material', () => {
    const m = surfaceMaterial({ color: 0x336699 });
    expect(m).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(m.roughness).toBe(SURFACE_ROUGHNESS);
    expect(m.metalness).toBe(0);
    expect(m.color.getHex()).toBe(0x336699);
  });

  it('passes emissive, transparency, vertex colours and side through', () => {
    const m = surfaceMaterial({
      color: 0xffffff,
      emissive: 0xffaa00,
      emissiveIntensity: 0.5,
      transparent: true,
      opacity: 0.4,
      vertexColors: true,
      side: THREE.DoubleSide,
    });
    expect(m.emissive.getHex()).toBe(0xffaa00);
    expect(m.emissiveIntensity).toBe(0.5);
    expect(m.transparent).toBe(true);
    expect(m.opacity).toBe(0.4);
    expect(m.vertexColors).toBe(true);
    expect(m.side).toBe(THREE.DoubleSide);
  });

  it('works without options (instanced colours set the colour later)', () => {
    expect(surfaceMaterial().color.getHex()).toBe(0xffffff);
  });
});

describe('render materials', () => {
  it('no render module constructs a Lambert material any more', () => {
    const sources = import.meta.glob(
      ['./*.ts', './buildings/*.ts', '!./*.test.ts', '!./buildings/*.test.ts'],
      {
        query: '?raw',
        import: 'default',
        eager: true,
      },
    ) as Record<string, string>;
    expect(Object.keys(sources).length).toBeGreaterThan(10);
    const offenders = Object.entries(sources)
      .filter(([, text]) => text.includes('MeshLambertMaterial'))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
