import { describe, expect, it } from 'vitest';
import { TICKS_PER_DAY } from '../../shared/constants.ts';
import { Terrain } from '../../shared/types.ts';
import { SimEngine } from '../engine.ts';
import { hasRoadAccess } from '../growth.ts';
import { serializeState } from '../state.ts';
import { scenarioDef } from './registry.ts';
import { SCENARIO_IDS } from './types.ts';

describe('shipped scenarios', () => {
  for (const id of SCENARIO_IDS) {
    it(`${id}: setup stamps a valid city and applies its rules`, () => {
      const def = scenarioDef(id);
      const engine = new SimEngine(0, 16);
      engine.applyCommand({ type: 'init', seed: 0, size: 16, scenario: id });
      const state = engine.state;
      expect(state.seed).toBe(def.seed);
      expect(state.size).toBe(def.size);
      expect(state.money).toBe(def.startingMoney);
      expect(state.disasterScale).toBe(def.disasterScale);
      expect(state.rules).toEqual(def.rules);
      expect(state.scenario).toMatchObject({ id, status: 'running', startTick: 0 });
      const { density, terrain } = state.layers;
      let buildings = 0;
      for (let i = 0; i < density.length; i++) {
        if (density[i] === 0) continue;
        buildings++;
        expect(terrain[i]).toBe(Terrain.Land);
        expect(hasRoadAccess(state, i)).toBe(true);
      }
      expect(buildings).toBeGreaterThan(0);
      expect(state.dirty.size).toBeGreaterThan(0);
    });
  }

  it('is deterministic: two inits and a day give the same save', () => {
    const run = () => {
      const engine = new SimEngine(0, 16);
      engine.applyCommand({ type: 'init', seed: 0, size: 16, scenario: 'dunkelflaute' });
      for (let i = 0; i < TICKS_PER_DAY / 4; i++) engine.tick();
      return JSON.stringify(serializeState(engine.state));
    };
    expect(run()).toBe(run());
  });
});
