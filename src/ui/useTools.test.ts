import { describe, expect, it } from 'vitest';
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
});
