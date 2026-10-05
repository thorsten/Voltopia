import { describe, expect, it } from 'vitest';
import { BALANCE } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { happinessStep, industryCoverage } from './happiness.ts';
import { createSimState, SupplyStatus, Zone } from './state.ts';

const SIZE = 16;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);

function suppliedCity() {
  const state = createSimState(1, SIZE);
  for (let i = 0; i < 10; i++) {
    state.layers.zone[at(i, 2)] = Zone.Residential;
    state.layers.density[at(i, 2)] = 1;
    state.layers.supplied[at(i, 2)] = SupplyStatus.Supplied;
  }
  return state;
}

function settle(state: ReturnType<typeof createSimState>, population: number): number {
  for (let i = 0; i < 2000; i++) happinessStep(state, population);
  return state.happiness;
}

describe('police coverage and happiness', () => {
  const { minPopulation, policePenaltyWeight } = BALANCE.services;

  it('has no effect below minPopulation', () => {
    const state = suppliedCity();
    state.lastServices = { fire: 0, police: 0 };
    expect(settle(state, minPopulation - 1)).toBeCloseTo(BALANCE.happiness.base, 2);
  });

  it('applies the full penalty with zero coverage above minPopulation', () => {
    const state = suppliedCity();
    state.lastServices = { fire: 0, police: 0 };
    expect(settle(state, minPopulation)).toBeCloseTo(
      BALANCE.happiness.base - policePenaltyWeight,
      2,
    );
  });

  it('scales the penalty with the uncovered share', () => {
    const state = suppliedCity();
    state.lastServices = { fire: 1, police: 0.75 };
    expect(settle(state, minPopulation)).toBeCloseTo(
      BALANCE.happiness.base - 0.25 * policePenaltyWeight,
      2,
    );
  });
});

describe('industry next door', () => {
  const { base, industryRadius, industryPenaltyWeight } = BALANCE.happiness;

  function withFactory(x: number, y: number, zone: Zone = Zone.Industrial) {
    const state = suppliedCity();
    state.layers.zone[at(x, y)] = zone;
    state.layers.density[at(x, y)] = 1;
    state.layers.supplied[at(x, y)] = SupplyStatus.Supplied;
    return state;
  }

  it('homes within the radius of a factory lower happiness by the covered share', () => {
    // Homes at y=2, x=0..9; a factory at (4, 5) is 3 rows away and reaches x=0..8.
    const state = withFactory(4, 5);
    expect(industryCoverage(state)).toBeCloseTo(0.9, 9);
    expect(settle(state, 10)).toBeCloseTo(base - 0.9 * industryPenaltyWeight, 2);
  });

  it('an office in the same place disturbs nobody', () => {
    const state = withFactory(4, 5, Zone.Commercial);
    expect(industryCoverage(state)).toBe(0);
    expect(settle(state, 10)).toBeCloseTo(base, 2);
  });

  it('a home is counted once however many factories surround it', () => {
    const state = withFactory(4, 5);
    state.layers.zone[at(3, 5)] = Zone.Industrial;
    state.layers.density[at(3, 5)] = 1;
    expect(industryCoverage(state)).toBeCloseTo(0.9, 9);
  });

  it('a factory just outside the radius does not count', () => {
    const state = withFactory(4, 2 + industryRadius + 1);
    expect(industryCoverage(state)).toBe(0);
  });
});
