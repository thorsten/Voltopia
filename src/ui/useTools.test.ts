import { describe, expect, it } from 'vitest';
import { PlantType, Terrain } from '../shared/types.ts';
import {
  bridgeTileCount,
  lineToolCommand,
  PLANT_BY_TOOL,
  TOOL_HOTKEYS,
  type ToolId,
} from './useTools.ts';

describe('tool hotkeys', () => {
  it('gives every buildable plant a hotkey', () => {
    // The tidal plant shipped without one, so its tooltip showed no key
    // and the tool was reachable only through the build bar.
    const mapped = new Set<ToolId>(Object.values(TOOL_HOTKEYS));
    const missing = Object.keys(PLANT_BY_TOOL).filter((tool) => !mapped.has(tool as ToolId));
    expect(missing).toEqual([]);
  });

  it('binds each key to exactly one tool', () => {
    const tools = Object.values(TOOL_HOTKEYS);
    expect(new Set(tools).size).toBe(tools.length);
  });

  it('uses only single lowercase keys, so the keydown lookup matches', () => {
    for (const key of Object.keys(TOOL_HOTKEYS)) {
      expect(key).toBe(key.toLowerCase());
      expect(key).toHaveLength(1);
    }
  });

  it('binds the geothermal plant to E', () => {
    expect(TOOL_HOTKEYS.e).toBe('plant-geothermal');
    expect(PLANT_BY_TOOL['plant-geothermal']).toBe(PlantType.GeothermalPlant);
  });

  it('maps the heat plant and heat store tools and their hotkeys', () => {
    expect(TOOL_HOTKEYS.r).toBe('plant-heat');
    expect(TOOL_HOTKEYS.o).toBe('plant-heatstore');
    expect(PLANT_BY_TOOL['plant-heat']).toBe(PlantType.HeatPlant);
    expect(PLANT_BY_TOOL['plant-heatstore']).toBe(PlantType.HeatStore);
  });

  it('binds the industrial zone to N', () => {
    expect(TOOL_HOTKEYS.n).toBe('zone-industrial');
  });

  it('binds the substation to X', () => {
    expect(TOOL_HOTKEYS.x).toBe('plant-substation');
    expect(PLANT_BY_TOOL['plant-substation']).toBe(PlantType.Substation);
  });

  it('maps the rail plants to free hotkeys and leaves the rail drag tool toolbar-only', () => {
    expect(TOOL_HOTKEYS.m).toBe('plant-station');
    expect(TOOL_HOTKEYS.j).toBe('plant-terminal');
    expect(TOOL_HOTKEYS.z).toBe('plant-railyard');
    expect(Object.values(TOOL_HOTKEYS)).not.toContain('rail');
    expect(PLANT_BY_TOOL['plant-station']).toBe(PlantType.TrainStation);
    expect(PLANT_BY_TOOL['plant-terminal']).toBe(PlantType.FreightTerminal);
    expect(PLANT_BY_TOOL['plant-railyard']).toBe(PlantType.RailYard);
  });
});

describe('line tool commands', () => {
  it('the overpass tool sends buildOverpass for the clicked tile', () => {
    expect(lineToolCommand('overpass', [42])).toEqual({ type: 'buildOverpass', tiles: [42] });
  });

  it('maps the other drag tools to their commands', () => {
    expect(lineToolCommand('avenue', [1, 2])).toEqual({
      type: 'buildRoad',
      tiles: [1, 2],
      avenue: true,
    });
    expect(lineToolCommand('rail', [3])).toEqual({ type: 'buildRail', tiles: [3] });
    expect(lineToolCommand('bus-stop', [4])).toEqual({ type: 'buildBusStop', tiles: [4] });
    expect(lineToolCommand('power-line', [5])).toEqual({ type: 'buildPowerLine', tiles: [5] });
    expect(lineToolCommand('select', [6])).toBeNull();
  });
});

describe('bridge tile count', () => {
  // Tiles 2 and 3 are river, 4 is lake, the rest land.
  const terrainAt = (index: number): Terrain | undefined =>
    index === 2 || index === 3 ? Terrain.River : index === 4 ? Terrain.Lake : Terrain.Land;

  it('counts the river tiles of a road, avenue or track drag', () => {
    for (const tool of ['road', 'avenue', 'rail'] as const) {
      expect(bridgeTileCount(tool, [1, 2, 3, 5], terrainAt)).toBe(2);
    }
  });

  it('ignores lake tiles and land-only paths', () => {
    expect(bridgeTileCount('road', [4, 5], terrainAt)).toBe(0);
    expect(bridgeTileCount('rail', [0, 1], terrainAt)).toBe(0);
  });

  it('is zero for tools that build no bridges', () => {
    for (const tool of ['power-line', 'bus-stop', 'overpass', 'zone-residential'] as const) {
      expect(bridgeTileCount(tool, [2, 3], terrainAt)).toBe(0);
    }
  });

  it('is zero while the terrain is unknown', () => {
    expect(bridgeTileCount('road', [2, 3], () => undefined)).toBe(0);
  });
});
