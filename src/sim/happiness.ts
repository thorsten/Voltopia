import { BALANCE } from '../shared/constants.ts';
import { tileX, tileY } from '../shared/grid.ts';
import { PlantType, SupplyStatus, TileType } from '../shared/types.ts';
import { damagedBuildingShare } from './disasters.ts';
import { seaCoverage } from './sea.ts';
import { forestCoverage } from './forest.ts';
import type { SimState } from './state.ts';

/** Share (0..1) of buildings that have a park within the park radius. */
export function parkCoverage(state: SimState): number {
  const { layers } = state;
  const parks: number[] = [];
  for (let i = 0; i < layers.tileType.length; i++) {
    if (layers.tileType[i] === TileType.Plant && layers.plantType[i] === PlantType.Park) {
      parks.push(i);
    }
  }
  if (parks.length === 0) return 0;

  const radius = BALANCE.happiness.parkRadius;
  let buildings = 0;
  let covered = 0;
  for (let i = 0; i < layers.tileType.length; i++) {
    if (layers.tileType[i] !== TileType.Empty || layers.density[i] === 0) continue;
    buildings++;
    const x = tileX(i, state.size);
    const y = tileY(i, state.size);
    for (const park of parks) {
      const dx = Math.abs(x - tileX(park, state.size));
      const dy = Math.abs(y - tileY(park, state.size));
      if (Math.max(dx, dy) <= radius) {
        covered++;
        break;
      }
    }
  }
  return buildings > 0 ? covered / buildings : 0;
}

/**
 * Move city happiness toward its target: a comfortable base, reduced by
 * taxes above the neutral rate, by buildings without (sufficient) power,
 * and, once the city is big enough, by buildings without police cover.
 * Smoothing avoids jumpy reactions to single bad ticks.
 */
export function happinessStep(state: SimState, population: number): void {
  const { layers } = state;
  const config = BALANCE.happiness;

  let buildings = 0;
  let troubled = 0;
  for (let i = 0; i < layers.tileType.length; i++) {
    if (layers.tileType[i] !== TileType.Empty || layers.density[i] === 0) continue;
    buildings++;
    if (layers.supplied[i] !== SupplyStatus.Supplied) troubled++;
  }
  const troubledShare = buildings > 0 ? troubled / buildings : 0;

  const taxPenalty =
    Math.max(0, state.taxRate - BALANCE.tax.happinessNeutralRate) * config.taxPenaltyWeight;
  const supplyPenalty = troubledShare * config.undersupplyPenaltyWeight;
  const parkBonus = parkCoverage(state) * config.parksAndLightsBonus;
  // Woods in reach are worth their own bonus on top of parks.
  const forestBonus = forestCoverage(state) * BALANCE.forest.coverBonus;
  // A sea view is worth its own bonus, like woods and parks.
  const coastBonus = seaCoverage(state) * BALANCE.sea.coastBonus;
  const commutePenalty = Math.min(
    config.commuteMaxPenalty,
    Math.max(0, state.commuteCongestion - config.commuteCongestionThreshold) *
      config.commutePenaltyWeight,
  );
  const services = BALANCE.services;
  const policePenalty =
    population >= services.minPopulation
      ? (1 - state.lastServices.police) * services.policePenaltyWeight
      : 0;

  const disasters = BALANCE.disasters;
  // Wrecked homes weigh permanently; an event in progress frightens the
  // whole city while it runs.
  const damagePenalty = damagedBuildingShare(state) * disasters.damagedPenaltyWeight;
  const eventPenalty = state.disasters.active.length > 0 ? disasters.activeEventPenalty : 0;

  const target = Math.min(
    1,
    Math.max(
      0,
      config.base +
        parkBonus +
        forestBonus +
        coastBonus -
        taxPenalty -
        supplyPenalty -
        commutePenalty -
        policePenalty -
        damagePenalty -
        eventPenalty,
    ),
  );
  state.happiness += (target - state.happiness) * config.smoothing;
}
