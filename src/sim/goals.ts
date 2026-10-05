import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import { DisasterKind, PlantType } from '../shared/types.ts';
import { hasPowerInfrastructure } from './energy.ts';
import { hasPowerLines } from './powerLines.ts';
import { meteredCoverage } from './smartMeters.ts';
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
  'stormProof',
  'warmWinter',
  'flexibleCity',
  'loadManager',
  'localGoods',
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
/** Share of the city's heat the district network must carry for the goal. */
const WARM_WINTER_SHARE = 0.5;

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

  // A whole winter day on district heating: the network carries at least
  // half the city's heat, nobody falls back, and there is heat demand at
  // all (an empty city cannot unlock it). heatingConsumption already
  // includes the fallback share, so it alone covers every heat unit not
  // on the network.
  const heatTotal = e.networkHeat + e.heatingConsumption;
  if (
    state.season.season === 'winter' &&
    heatTotal > 0 &&
    e.heatFallback === 0 &&
    e.networkHeat >= WARM_WINTER_SHARE * heatTotal
  ) {
    progress.warmWinterTicks++;
  } else {
    progress.warmWinterTicks = 0;
  }

  // Smart meters: a well-metered city that actually shifts load. Unlike
  // the streaks above this counter is cumulative — half a day of
  // qualifying ticks, whenever they happen.
  if (
    population >= CLEAN_DAY_MIN_POPULATION &&
    meteredCoverage(state) >= BALANCE.smartMeters.goalCoverage &&
    e.flexDeferred + e.flexRecovered > 0
  ) {
    progress.flexTicks++;
  }

  // Cumulative business load shed under the demand-response contract.
  progress.shedTotal += e.shed;

  const achieved = state.goalsAchieved;

  // Riding out a storm: count the ticks a storm blows while the grid
  // holds, and bank the goal the moment the storm is over. A deficit sends
  // the streak negative, and it must stay negative for the rest of this
  // storm — a later good tick may not erase an earlier one, or a long
  // enough storm would always climb back into achieving territory.
  const inStorm = state.disasters.active.some((event) => event.kind === DisasterKind.Storm);
  if (inStorm) {
    if (state.lastEnergy.deficit !== 0) {
      progress.stormTicks = -1;
    } else if (progress.stormTicks >= 0) {
      progress.stormTicks++;
    }
  } else {
    if (!achieved.has('stormProof') && progress.stormTicks > 0) achieved.add('stormProof');
    progress.stormTicks = 0;
  }

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
  if (!achieved.has('warmWinter') && progress.warmWinterTicks >= TICKS_PER_DAY) {
    achieved.add('warmWinter');
  }
  if (!achieved.has('flexibleCity') && progress.flexTicks >= TICKS_PER_DAY / 2) {
    achieved.add('flexibleCity');
  }
  if (!achieved.has('loadManager') && progress.shedTotal >= BALANCE.demandResponse.goalShedEnergy) {
    achieved.add('loadManager');
  }

  // Yesterday every tour loaded at a factory, in a real retail scene.
  const { goalLocalMinShops, goalLocalMinFactories } = BALANCE.deliveries;
  const yesterday = state.goods.lastDay;
  if (
    !achieved.has('localGoods') &&
    state.tick % TICKS_PER_DAY === 0 &&
    !yesterday.partial &&
    yesterday.local > 0 &&
    yesterday.imported === 0 &&
    state.lastDeliveries.shops >= goalLocalMinShops &&
    state.lastDeliveries.suppliedShare >= BALANCE.deliveries.goalSuppliedShare &&
    state.lastDeliveries.factories >= goalLocalMinFactories
  ) {
    achieved.add('localGoods');
  }
}

export function goalStates(state: SimState): GoalState[] {
  // stormProof can only ever unlock while disasters can happen. With the
  // intensity off (an old save, or a city founded with disasters off) it
  // would sit forever as one goal nobody can complete — omit it instead so
  // the achieved/total count reflects what this city can actually reach.
  const ids = state.disasterScale === 0 ? GOAL_IDS.filter((id) => id !== 'stormProof') : GOAL_IDS;
  return ids.map((id) => ({ id, achieved: state.goalsAchieved.has(id) }));
}
