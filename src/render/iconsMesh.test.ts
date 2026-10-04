import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { TileDiff } from '../shared/types.ts';
import { PlantType, SupplyStatus, TileType, Zone } from '../shared/types.ts';
import { ElevationField } from './elevationField.ts';
import { IconsMesh } from './iconsMesh.ts';

// IconsMesh draws its warning-bolt texture onto a 2D canvas in its
// constructor. This suite runs in vitest's `node` environment (no DOM,
// per vitest.config.ts), so stub just enough of `document`/canvas for
// that draw call to run; nothing under test reads the drawn pixels.
beforeAll(() => {
  const context = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineJoin: '',
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    closePath: () => {},
    stroke: () => {},
    fill: () => {},
  };
  vi.stubGlobal('document', {
    createElement: () => ({ width: 0, height: 0, getContext: () => context }),
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const SIZE = 8;

function setup(): { icons: THREE.InstancedMesh; layer: IconsMesh } {
  const scene = new THREE.Scene();
  const field = new ElevationField(SIZE);
  field.applyDiffs(
    Array.from({ length: SIZE * SIZE }, (_, index) => ({ index, elevation: 0 }) as TileDiff),
  );
  const layer = new IconsMesh(scene, SIZE, new THREE.PerspectiveCamera(), field);
  const icons = scene.children.find(
    (c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh,
  )!;
  return { icons, layer };
}

function plant(index: number, plantType: PlantType, supplied: SupplyStatus): TileDiff {
  return {
    index,
    tileType: TileType.Plant,
    plantType,
    density: 0,
    zone: Zone.None,
    supplied,
  } as TileDiff;
}

function building(index: number, supplied: SupplyStatus): TileDiff {
  return {
    index,
    tileType: TileType.Empty,
    plantType: PlantType.None,
    density: 1,
    zone: Zone.Residential,
    supplied,
  } as TileDiff;
}

const color = new THREE.Color();

describe('IconsMesh', () => {
  it('shows a permanent blue-grey bolt above an isolated supply plant and drops it when it serves again', () => {
    const { icons, layer } = setup();
    layer.applyDiffs([plant(10, PlantType.WindTurbine, SupplyStatus.NotConnected)]);
    layer.update(0.016, 1);
    expect(icons.count).toBe(1);
    icons.getColorAt(0, color);
    expect(color.getHex()).toBe(0x7fa7c9);
    // Far in the future: a building's undersupply icon would have expired; this one stays.
    layer.update(0.016, 1000);
    expect(icons.count).toBe(1);
    layer.applyDiffs([plant(10, PlantType.WindTurbine, SupplyStatus.Supplied)]);
    layer.update(0.016, 1001);
    expect(icons.count).toBe(0);
  });

  it('ignores non-supply plants and still reds an unconnected building', () => {
    const { icons, layer } = setup();
    layer.applyDiffs([
      plant(10, PlantType.FireStation, SupplyStatus.NotConnected),
      building(20, SupplyStatus.NotConnected),
    ]);
    layer.update(0.016, 1);
    expect(icons.count).toBe(1);
    icons.getColorAt(0, color);
    expect(color.getHex()).toBe(0xe05263);
  });

  it('drops the icon when the plant is bulldozed', () => {
    const { icons, layer } = setup();
    layer.applyDiffs([plant(10, PlantType.SolarFarm, SupplyStatus.NotConnected)]);
    layer.update(0.016, 1);
    expect(icons.count).toBe(1);
    layer.applyDiffs([
      {
        index: 10,
        tileType: TileType.Empty,
        plantType: PlantType.None,
        density: 0,
        zone: Zone.None,
        supplied: SupplyStatus.NotConnected,
      } as TileDiff,
    ]);
    layer.update(0.016, 2);
    expect(icons.count).toBe(0);
  });
});
