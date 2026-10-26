import { describe, expect, it } from 'vitest';
import { Terrain, TownRoad, Zone, type TownLayout } from '../shared/types.ts';
import { MINIMAP_COLORS, buildingShade, shade, townTileColor } from './townColors.ts';

function layoutOf(size: number): TownLayout {
  const tiles = size * size;
  return {
    size,
    terrain: new Uint8Array(tiles),
    forest: new Uint8Array(tiles),
    road: new Uint8Array(tiles),
    pedestrian: new Uint8Array(tiles),
    rail: new Uint8Array(tiles),
    zone: new Uint8Array(tiles),
    density: new Uint8Array(tiles),
    name: null,
    bbox: [0, 0, 1, 1],
  };
}

describe('shade', () => {
  it('scales every channel towards black', () => {
    expect(shade('#ffffff', 0.5)).toBe('#808080');
    expect(shade('#102030', 1)).toBe('#102030');
    expect(shade('#102030', 0)).toBe('#000000');
  });

  it('makes a building darker than its zone', () => {
    for (const zone of [Zone.Residential, Zone.Commercial, Zone.Retail, Zone.Industrial]) {
      const zoned = parseInt(MINIMAP_COLORS.zoned[zone].slice(1), 16);
      expect(parseInt(buildingShade(zone).slice(1), 16)).toBeLessThan(zoned);
    }
  });
});

describe('townTileColor', () => {
  it('follows the minimap priority: water, road, rail, building, zone, forest, ground', () => {
    const layout = layoutOf(4);
    expect(townTileColor(layout, 0)).toBe(MINIMAP_COLORS.ground);
    layout.forest[0] = 3;
    expect(townTileColor(layout, 0)).toBe(MINIMAP_COLORS.forest);
    layout.zone[0] = Zone.Retail;
    expect(townTileColor(layout, 0)).toBe(MINIMAP_COLORS.zoned[Zone.Retail]);
    layout.density[0] = 2;
    expect(townTileColor(layout, 0)).toBe(buildingShade(Zone.Retail));
    layout.rail[0] = 1;
    expect(townTileColor(layout, 0)).toBe(MINIMAP_COLORS.rail);
    layout.road[0] = TownRoad.Street;
    expect(townTileColor(layout, 0)).toBe(MINIMAP_COLORS.road);
    layout.road[0] = TownRoad.Avenue;
    expect(townTileColor(layout, 0)).toBe(MINIMAP_COLORS.avenue);
    layout.terrain[0] = Terrain.Lake;
    expect(townTileColor(layout, 0)).toBe(MINIMAP_COLORS.lake);
    layout.terrain[0] = Terrain.River;
    expect(townTileColor(layout, 0)).toBe(MINIMAP_COLORS.river);
    layout.terrain[0] = Terrain.Sea;
    expect(townTileColor(layout, 0)).toBe(MINIMAP_COLORS.sea);
  });
});
