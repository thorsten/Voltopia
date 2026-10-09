import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { TileDiff } from '../shared/types.ts';
import { SupplyStatus, TileType, Zone } from '../shared/types.ts';
import { ElevationField } from './elevationField.ts';
import { BuildingsMesh } from './buildingsMesh.ts';
import { layoutWindows } from './buildings/windowLayout.ts';

// Pass-through spy: the real layout, but every call is counted.
vi.mock('./buildings/windowLayout.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./buildings/windowLayout.ts')>();
  return { ...actual, layoutWindows: vi.fn(actual.layoutWindows) };
});

const SIZE = 8;

function building(index: number, supplied: SupplyStatus = SupplyStatus.Supplied): TileDiff {
  return {
    index,
    tileType: TileType.Empty,
    zone: Zone.Residential,
    density: 3,
    variant: index % 8,
    supplied,
    elevation: 0,
  } as TileDiff;
}

function setup(): BuildingsMesh {
  const field = new ElevationField(SIZE);
  field.applyDiffs(
    Array.from({ length: SIZE * SIZE }, (_, index) => ({ index, elevation: 0 }) as TileDiff),
  );
  const mesh = new BuildingsMesh(new THREE.Scene(), SIZE, field);
  mesh.setReducedMotion(true);
  return mesh;
}

describe('BuildingsMesh window layout cache', () => {
  it('lays out a building once on placement, not again for the whole city', () => {
    const mesh = setup();
    const spy = vi.mocked(layoutWindows);
    spy.mockClear();
    mesh.applyDiffs([building(10), building(11), building(12)]);
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockClear();
    mesh.applyDiffs([building(20)]);
    // Only the new building; the three existing ones reuse their cached slots.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('re-lays out nothing on a supply flip, but still dims the glow', () => {
    const mesh = setup();
    mesh.applyDiffs([building(10), building(11)]);
    const frames = mesh.windowFramesMesh.count;
    const lit = mesh.windowCount();
    expect(lit).toBeGreaterThan(0);
    const spy = vi.mocked(layoutWindows);
    spy.mockClear();
    mesh.applyDiffs([building(10, SupplyStatus.Undersupplied)]);
    expect(spy).not.toHaveBeenCalled();
    expect(mesh.windowFramesMesh.count).toBe(frames);
    expect(mesh.windowCount()).toBeLessThan(lit);
    mesh.applyDiffs([building(10)]);
    expect(spy).not.toHaveBeenCalled();
    expect(mesh.windowCount()).toBe(lit);
  });

  it('re-lays out nothing on a removal', () => {
    const mesh = setup();
    mesh.applyDiffs([building(10), building(11)]);
    const spy = vi.mocked(layoutWindows);
    spy.mockClear();
    mesh.applyDiffs([
      { ...building(10), density: 0, zone: Zone.None, supplied: SupplyStatus.NotConnected },
    ]);
    expect(spy).not.toHaveBeenCalled();
  });
});
