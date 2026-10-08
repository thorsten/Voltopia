import { describe, expect, it } from 'vitest';
import { TICKS_PER_DAY } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { PlantType, Zone } from '../shared/types.ts';
import { SimEngine } from './engine.ts';

const SIZE = 32;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);

/** Split from integration.test.ts: each file stays far below vitest's 60 s worker RPC timeout on CI. */
describe('full gameplay integration', () => {
  it('an unpowered city stalls: unhappy, no densification', () => {
    const engine = new SimEngine(99, SIZE);
    engine.applyCommand({
      type: 'buildRoad',
      tiles: Array.from({ length: 10 }, (_, x) => at(x + 4, 10)),
    });
    engine.applyCommand({
      type: 'paintZone',
      tiles: Array.from({ length: 10 }, (_, x) => at(x + 4, 9)),
      zone: Zone.Residential,
    });
    for (let i = 0; i < TICKS_PER_DAY * 2; i++) engine.tick();
    const event = engine.tick();
    if (event.type !== 'tick') throw new Error('expected tick event');
    // Some pioneers may settle, but the city cannot become happy.
    expect(event.stats.happiness).toBeLessThan(0.5);
  });
});

describe('lifetime statistics', () => {
  it('records one sample per day and survives save/load', () => {
    const engine = new SimEngine(7, SIZE);
    engine.applyCommand({
      type: 'buildRoad',
      tiles: Array.from({ length: 10 }, (_, x) => at(x + 4, 10)),
    });
    engine.applyCommand({
      type: 'paintZone',
      tiles: Array.from({ length: 10 }, (_, x) => at(x + 4, 9)),
      zone: Zone.Residential,
    });
    engine.applyCommand({ type: 'placePlant', tile: at(8, 12), plant: PlantType.WindTurbine });
    for (let i = 0; i < TICKS_PER_DAY * 3; i++) engine.tick();

    const samples = engine.state.lifetime.samples;
    expect(samples.length).toBe(3);
    expect(samples[0].day).toBe(0);
    expect(samples[2].population).toBeGreaterThan(0);
    expect(samples[2].avgGeneration).toBeGreaterThan(0);
    expect(typeof samples[2].temperature).toBe('number');
    expect(samples[2].heating).toBeGreaterThanOrEqual(0);
    expect(samples[2].cooling).toBeGreaterThanOrEqual(0);

    // Round trip through a save keeps the history.
    const events = engine.applyCommand({ type: 'requestSave' });
    const save = events[0].type === 'saveData' ? events[0].save : null;
    expect(save?.lifetime?.length).toBe(3);
    const restored = new SimEngine(0, 4);
    restored.applyCommand({ type: 'init', seed: 7, size: SIZE, save: save! });
    expect(restored.state.lifetime.samples.length).toBe(3);

    // The lifetime request returns the samples.
    const lifetimeEvents = restored.applyCommand({ type: 'requestLifetime' });
    expect(lifetimeEvents[0].type).toBe('lifetimeData');
    if (lifetimeEvents[0].type === 'lifetimeData') {
      expect(lifetimeEvents[0].samples.length).toBe(3);
    }
  });
});
