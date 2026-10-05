import { describe, expect, it } from 'vitest';
import type { IslandStats } from '../shared/types.ts';
import { districtStatus, sortDistricts } from './districtStatus.ts';

function island(overrides: Partial<IslandStats> = {}): IslandStats {
  return {
    number: 1,
    key: 0,
    tiles: 1,
    buildings: 0,
    substations: 0,
    generation: 0,
    consumption: 0,
    stored: 0,
    capacity: 0,
    deficit: 0,
    curtailment: 0,
    gridImport: 0,
    gridExport: 0,
    importCost: 0,
    ...overrides,
  };
}

describe('districtStatus', () => {
  it('flags a deficit island even when it also curtails', () => {
    expect(districtStatus({ deficit: 5, curtailment: 3 })).toBe('deficit');
  });

  it('flags curtailment when there is no deficit', () => {
    expect(districtStatus({ deficit: 0, curtailment: 2 })).toBe('curtailing');
  });

  it('reads ok when neither is positive', () => {
    expect(districtStatus({ deficit: 0, curtailment: 0 })).toBe('ok');
  });

  it('treats a negative curtailment or deficit as not in that state', () => {
    expect(districtStatus({ deficit: -1, curtailment: -1 })).toBe('ok');
  });
});

describe('sortDistricts', () => {
  it('orders by tiles descending', () => {
    const islands = [island({ number: 1, tiles: 5 }), island({ number: 2, tiles: 20 })];
    expect(sortDistricts(islands).map((i) => i.number)).toEqual([2, 1]);
  });

  it('breaks a tie on tiles by ascending island number', () => {
    const islands = [
      island({ number: 3, tiles: 10 }),
      island({ number: 1, tiles: 10 }),
      island({ number: 2, tiles: 10 }),
    ];
    expect(sortDistricts(islands).map((i) => i.number)).toEqual([1, 2, 3]);
  });

  it('does not mutate the input array', () => {
    const islands = [island({ number: 1, tiles: 5 }), island({ number: 2, tiles: 20 })];
    const copy = [...islands];
    sortDistricts(islands);
    expect(islands).toEqual(copy);
  });

  it('returns an empty list for an empty input', () => {
    expect(sortDistricts([])).toEqual([]);
  });
});
