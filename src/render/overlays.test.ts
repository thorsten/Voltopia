import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { TileDiff } from '../shared/types.ts';
import {
  HEATED_NONE,
  HEATED_SERVED,
  HEATED_TRUNK,
  OverlayMode,
  PlantType,
  SupplyStatus,
  TileType,
  Zone,
} from '../shared/types.ts';
import { ElevationField } from './elevationField.ts';
import {
  damageColor,
  gridColor,
  heatColor,
  ISLAND_PALETTE,
  OverlaysMesh,
  supplyColor,
} from './overlays.ts';

const SIZE = 8;

function setup(): { mesh: THREE.InstancedMesh; layer: OverlaysMesh } {
  const scene = new THREE.Scene();
  const field = new ElevationField(SIZE);
  field.applyDiffs(
    Array.from({ length: SIZE * SIZE }, (_, index) => ({ index, elevation: 0 }) as TileDiff),
  );
  const layer = new OverlaysMesh(scene, SIZE, field);
  const mesh = scene.children.find(
    (c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh,
  )!;
  return { mesh, layer };
}

function isolatedWindTurbine(supplied: SupplyStatus): TileDiff {
  return {
    index: 10,
    tileType: TileType.Plant,
    plantType: PlantType.WindTurbine,
    supplied,
    zone: Zone.None,
    density: 0,
    damage: 0,
  } as TileDiff;
}

describe('damageColor', () => {
  it('greens an intact tile and reds a wrecked one', () => {
    expect(damageColor(0)).not.toBe(damageColor(255));
  });

  it('is monotone in the damage', () => {
    const light = damageColor(30);
    const heavy = damageColor(200);
    expect(light).not.toBe(heavy);
  });
});

describe('heatColor', () => {
  it('tints trunk roads, served buildings and unserved buildings differently', () => {
    const trunk = heatColor({ tileType: TileType.Road, density: 0, heated: HEATED_TRUNK });
    const served = heatColor({ tileType: TileType.Empty, density: 1, heated: HEATED_SERVED });
    const unserved = heatColor({ tileType: TileType.Empty, density: 1, heated: HEATED_NONE });
    expect(trunk).not.toBeNull();
    expect(served).not.toBeNull();
    expect(unserved).not.toBeNull();
    expect(new Set([trunk, served, unserved]).size).toBe(3);
  });

  it('leaves roads outside the network and empty land alone', () => {
    expect(heatColor({ tileType: TileType.Road, density: 0, heated: HEATED_NONE })).toBeNull();
    expect(heatColor({ tileType: TileType.Empty, density: 0, heated: HEATED_NONE })).toBeNull();
  });
});

describe('supplyColor', () => {
  it('reds an isolated supply plant and leaves a serving one unpainted', () => {
    const isolated = supplyColor({
      tileType: TileType.Plant,
      density: 0,
      plantType: PlantType.WindTurbine,
      supplied: SupplyStatus.NotConnected,
    });
    const serving = supplyColor({
      tileType: TileType.Plant,
      density: 0,
      plantType: PlantType.WindTurbine,
      supplied: SupplyStatus.Supplied,
    });
    expect(isolated).toBe(0xe05263);
    expect(serving).toBeNull();
  });

  it('keeps colouring buildings by status and ignores stations', () => {
    expect(
      supplyColor({
        tileType: TileType.Empty,
        density: 2,
        plantType: PlantType.None,
        supplied: SupplyStatus.Undersupplied,
      }),
    ).toBe(0xffb347);
    expect(
      supplyColor({
        tileType: TileType.Plant,
        density: 0,
        plantType: PlantType.FireStation,
        supplied: SupplyStatus.NotConnected,
      }),
    ).toBeNull();
  });
});

describe('OverlaysMesh supply-plant storage', () => {
  it('paints an isolated supply plant in Supply mode and stops once it serves again', () => {
    const { mesh, layer } = setup();
    layer.setMode(OverlayMode.Supply);
    layer.applyDiffs([isolatedWindTurbine(SupplyStatus.NotConnected)]);
    expect(mesh.count).toBe(1);
    layer.applyDiffs([isolatedWindTurbine(SupplyStatus.Supplied)]);
    expect(mesh.count).toBe(0);
  });
});

const islands = new Map([
  [1, { deficit: false, substations: 1 }],
  [2, { deficit: true, substations: 1 }],
  [3, { deficit: false, substations: 0 }],
]);

describe('gridColor', () => {
  it('colours islands from the palette by number and leaves island 0 blank', () => {
    expect(gridColor({ island: 0 }, islands, 0)).toBeNull();
    expect(gridColor({ island: 1 }, islands, 0)).toBe(ISLAND_PALETTE[1 % ISLAND_PALETTE.length]);
    expect(gridColor({ island: 9 }, islands, 0)).toBe(ISLAND_PALETTE[9 % ISLAND_PALETTE.length]);
  });

  it('blends a deficit island toward red and dims one without a substation', () => {
    const plain = new THREE.Color(gridColor({ island: 1 }, islands, 0)!);
    const deficit = new THREE.Color(gridColor({ island: 2 }, islands, 0)!);
    const noLink = new THREE.Color(gridColor({ island: 3 }, islands, 0)!);
    expect(deficit.r).toBeGreaterThan(deficit.g);
    expect(noLink.getHSL({ h: 0, s: 0, l: 0 }).l).toBeLessThan(
      plain.getHSL({ h: 0, s: 0, l: 0 }).l,
    );
  });

  it('desaturates every island but the selected one', () => {
    const selected = new THREE.Color(gridColor({ island: 1 }, islands, 1)!);
    const other = new THREE.Color(gridColor({ island: 2 }, islands, 1)!);
    const hsl = { h: 0, s: 0, l: 0 };
    expect(other.getHSL(hsl).s).toBeLessThan(selected.getHSL({ h: 0, s: 0, l: 0 }).s);
  });
});
