import { describe, expect, it } from 'vitest';
import {
  HEATED_NONE,
  HEATED_SERVED,
  HEATED_TRUNK,
  PlantType,
  SupplyStatus,
  TileType,
} from '../shared/types.ts';
import { damageColor, heatColor, supplyColor } from './overlays.ts';

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
