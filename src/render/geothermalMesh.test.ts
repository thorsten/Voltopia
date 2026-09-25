import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { TileDiff } from '../shared/types.ts';
import { ElevationField } from './elevationField.ts';
import { GeothermalMesh } from './geothermalMesh.ts';

const SIZE = 8;

function sceneWith(diffs: TileDiff[]): { steam: THREE.InstancedMesh; cones: THREE.InstancedMesh } {
  const scene = new THREE.Scene();
  const field = new ElevationField(SIZE);
  field.applyDiffs(diffs);
  const mesh = new GeothermalMesh(scene, SIZE, field);
  mesh.applyDiffs(diffs);
  mesh.update(0.25, 0);
  const instanced = scene.children.filter(
    (child): child is THREE.InstancedMesh => child instanceof THREE.InstancedMesh,
  );
  return { cones: instanced[0], steam: instanced[1] };
}

function tiles(hotspots: Record<number, number>): TileDiff[] {
  return Array.from({ length: SIZE * SIZE }, (_, index) => ({
    index,
    elevation: 0,
    geothermal: hotspots[index] ?? 0,
    reservoirHeat: hotspots[index] ? 255 : 0,
  })) as TileDiff[];
}

describe('geothermal mesh', () => {
  it('draws one fumarole per hotspot tile and nothing elsewhere', () => {
    const { cones, steam } = sceneWith(tiles({ 9: 2, 10: 2 }));
    expect(cones.count).toBe(2);
    expect(steam.count).toBe(2);
    expect(cones.frustumCulled).toBe(false);
    expect(steam.frustumCulled).toBe(false);
  });

  it('draws nothing on a map without hotspots', () => {
    const { cones } = sceneWith(tiles({}));
    expect(cones.count).toBe(0);
  });

  it('fades the steam with the reservoir', () => {
    const hot = sceneWith(tiles({ 9: 2 }));
    const cold: TileDiff[] = tiles({ 9: 2 }).map((diff) =>
      diff.index === 9 ? { ...diff, reservoirHeat: 20 } : diff,
    );
    const cooled = sceneWith(cold);
    expect(cooled.steam.material).toBeDefined();
    // Opacity is carried per instance in the alpha of the instance colour.
    const hotColor = new THREE.Color();
    const coldColor = new THREE.Color();
    hot.steam.getColorAt(0, hotColor);
    cooled.steam.getColorAt(0, coldColor);
    expect(coldColor.r).toBeLessThan(hotColor.r);
  });
});
