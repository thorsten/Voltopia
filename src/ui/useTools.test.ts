import { describe, expect, it } from 'vitest';
import { PlantType } from '../shared/types.ts';
import { PLANT_BY_TOOL, TOOL_HOTKEYS, type ToolId } from './useTools.ts';

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
