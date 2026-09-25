import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import { PlantType } from '../shared/types.ts';
import { hasPowerInfrastructure } from './energy.ts';
import { hasPowerLines } from './powerLines.ts';
import { countPlants, countPopulationAndJobs, type SimState } from './state.ts';

export const GOAL_IDS = [
  'firstPower',
  'gridBuilder',
  'population100',
  'population500',
  'cleanDay',
  'evFleet',
  'exporter',
  'hydroPower',
  'tidalPower',
  'winterResilience',
  'summerResilience',
  'safeCity',
  'freeFlow',
  'wellStocked',
  'modalShift',
  'geothermalBaseload',
] as const;
export type GoalId = (typeof GOAL_IDS)[number];

export interface GoalState {
  id: GoalId;
  achieved: boolean;
}

/** Cumulative export energy needed for the exporter goal. */
const EXPORTER_TARGET_ENERGY = 20_000;
/** Minimum population for the clean-day goal to count. */
const CLEAN_DAY_MIN_POPULATION = 50;
const EV_FLEET_TARGET = 30;
/** Share of generation that must come from geothermal for the goal. */
const GEOTHERMAL_SHARE = 0.15;

/**
 * Evaluate all goals for this tick. Achieved goals stay achieved (they
 * are part of the save game); progress counters live on the state.
 */
export function goalsStep(state: SimState): void {
  const { population } = countPopulationAndJobs(state);
  const progress = state.goalProgress;

  progress.exportedTotal += state.lastEnergy.gridExport;

  // A full in-game day without deficit or imports (and a real city).
  if (
    population >= CLEAN_DAY_MIN_POPULATION &&
    state.lastEnergy.deficit === 0 &&
    state.lastEnergy.gridImport === 0
  ) {
    progress.cleanDayTicks++;
  } else {
    progress.cleanDayTicks = 0;
  }

  // A whole winter (every tick) without undersupply, for a real city.
  const inWinter = state.season.season === 'winter';
  if (inWinter && population >= CLEAN_DAY_MIN_POPULATION && state.lastEnergy.deficit === 0) {
    progress.winterTicks++;
  } else {
    progress.winterTicks = 0;
  }

  // A whole summer (every tick) without undersupply, for a real city.
  const inSummer = state.season.season === 'summer';
  if (inSummer && population >= CLEAN_DAY_MIN_POPULATION && state.lastEnergy.deficit === 0) {
    progress.summerTicks++;
  } else {
    progress.summerTicks = 0;
  }

  // A whole day of flowing commutes, for a real city.
  const { flowing, goalMinPopulation } = BALANCE.traffic;
  if (population >= goalMinPopulation && state.commuteCongestion <= flowing) {
    progress.freeFlowTicks++;
  } else {
    progress.freeFlowTicks = 0;
  }

  // A whole day with (nearly) every shop supplied, for a real retail scene.
  const { goalSuppliedShare, goalMinShops } = BALANCE.deliveries;
  const deliveries = state.lastDeliveries;
  if (deliveries.shops >= goalMinShops && deliveries.suppliedShare >= goalSuppliedShare) {
    progress.wellStockedTicks++;
  } else {
    progress.wellStockedTicks = 0;
  }

  // A whole day with a real share of commuters on the bus, for a real city.
  const { goalRiderShare, goalMinPopulation: transitMinPopulation } = BALANCE.transit;
  if (population >= transitMinPopulation && state.lastTransit.riderShare >= goalRiderShare) {
    progress.transitTicks++;
  } else {
    progress.transitTicks = 0;
  }

  // A whole day with a real share of generation from geothermal.
  const e = state.lastEnergy;
  const generation = e.solar + e.wind + e.rooftop + e.hydro + e.tidal + e.geothermal + e.biogas;
  if (generation > 0 && e.geothermal / generation >= GEOTHERMAL_SHARE) {
    progress.geothermalTicks++;
  } else {
    progress.geothermalTicks = 0;
  }

  const achieved = state.goalsAchieved;
  if (!achieved.has('firstPower') && hasPowerInfrastructure(state)) {
    achieved.add('firstPower');
  }
  if (!achieved.has('population100') && population >= 100) {
    achieved.add('population100');
  }
  if (!achieved.has('population500') && population >= 500) {
    achieved.add('population500');
  }
  if (!achieved.has('cleanDay') && progress.cleanDayTicks >= TICKS_PER_DAY) {
    achieved.add('cleanDay');
  }
  if (!achieved.has('evFleet') && state.vehicles.length >= EV_FLEET_TARGET) {
    achieved.add('evFleet');
  }
  if (!achieved.has('exporter') && progress.exportedTotal >= EXPORTER_TARGET_ENERGY) {
    achieved.add('exporter');
  }
  if (!achieved.has('hydroPower') && countPlants(state, PlantType.RunOfRiver) > 0) {
    achieved.add('hydroPower');
  }
  if (!achieved.has('tidalPower') && countPlants(state, PlantType.TidalPlant) > 0) {
    achieved.add('tidalPower');
  }
  if (!achieved.has('gridBuilder') && hasPowerLines(state)) {
    achieved.add('gridBuilder');
  }
  if (
    !achieved.has('winterResilience') &&
    progress.winterTicks >= BALANCE.seasons.daysPerSeason * TICKS_PER_DAY
  ) {
    achieved.add('winterResilience');
  }
  if (
    !achieved.has('summerResilience') &&
    progress.summerTicks >= BALANCE.seasons.daysPerSeason * TICKS_PER_DAY
  ) {
    achieved.add('summerResilience');
  }
  const { minPopulation, goalCoverage } = BALANCE.services;
  if (
    !achieved.has('safeCity') &&
    population >= minPopulation &&
    state.lastServices.fire >= goalCoverage &&
    state.lastServices.police >= goalCoverage
  ) {
    achieved.add('safeCity');
  }
  if (!achieved.has('freeFlow') && progress.freeFlowTicks >= TICKS_PER_DAY) {
    achieved.add('freeFlow');
  }
  if (!achieved.has('wellStocked') && progress.wellStockedTicks >= TICKS_PER_DAY) {
    achieved.add('wellStocked');
  }
  if (!achieved.has('modalShift') && progress.transitTicks >= TICKS_PER_DAY) {
    achieved.add('modalShift');
  }
  if (!achieved.has('geothermalBaseload') && progress.geothermalTicks >= TICKS_PER_DAY) {
    achieved.add('geothermalBaseload');
  }
}

export function goalStates(state: SimState): GoalState[] {
  return GOAL_IDS.map((id) => ({ id, achieved: state.goalsAchieved.has(id) }));
}
