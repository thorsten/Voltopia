import { describe, expect, it } from 'vitest';
import { tileIndex } from '../shared/grid.ts';
import { createSimState, deserializeState, serializeState } from './state.ts';

const SIZE = 32;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);

describe('the damage layer', () => {
  it('starts out intact on every tile', () => {
    const state = createSimState(1, SIZE);
    expect(state.layers.damage).toHaveLength(SIZE * SIZE);
    expect([...state.layers.damage].every((value) => value === 0)).toBe(true);
  });

  it('survives a save/load round trip', () => {
    const state = createSimState(1, SIZE);
    state.layers.damage[at(4, 5)] = 120;
    const loaded = deserializeState(serializeState(state));
    expect(loaded.layers.damage[at(4, 5)]).toBe(120);
  });

  it('starts a city with no events in flight and no repair bill', () => {
    const state = createSimState(1, SIZE);
    expect(state.disasters).toEqual({
      pending: [],
      active: [],
      nextId: 1,
      cooldownTicks: 0,
    });
    expect(state.lastRepairCost).toBe(0);
  });
});

describe('disaster intensity', () => {
  it('defaults to normal for a new city', () => {
    expect(createSimState(1, SIZE).disasterScale).toBe(1);
  });

  it('is zero for a save from before disasters', () => {
    const save = serializeState(createSimState(1, SIZE));
    delete save.disasterScale;
    expect(deserializeState(save).disasterScale).toBe(0);
  });

  it('round-trips a chosen intensity', () => {
    const state = createSimState(1, SIZE);
    state.disasterScale = 1.6;
    expect(deserializeState(serializeState(state)).disasterScale).toBe(1.6);
  });
});
