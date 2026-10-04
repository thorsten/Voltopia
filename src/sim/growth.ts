import { BALANCE } from '../shared/constants.ts';
import { neighbors4 } from '../shared/grid.ts';
import { isShopSupplied } from './deliveries.ts';
import { hasPowerInfrastructure } from './energy.ts';
import { SERVICE_FIRE } from './services.ts';
import type { DemandStats } from '../shared/types.ts';
import {
  countPopulationAndJobs,
  markDirty,
  SupplyStatus,
  Terrain,
  TileType,
  Zone,
  type SimState,
} from './state.ts';

/** Number of visual variants per zone the renderer provides. */
export const BUILDING_VARIANTS = 8;

/** Jobs provided by retail buildings only (used for retail demand). */
function countRetailJobs(state: SimState): number {
  const { zone, density, tileType } = state.layers;
  let retailJobs = 0;
  for (let i = 0; i < zone.length; i++) {
    if (tileType[i] !== TileType.Empty || density[i] === 0) continue;
    if (zone[i] === Zone.Retail) {
      retailJobs += BALANCE.growth.jobsByZoneAndDensity[Zone.Retail][density[i]];
    }
  }
  return retailJobs;
}

/**
 * The demand model: residential follows available jobs, commercial follows
 * the workforce, retail follows both. Values are normalized to -1..1.
 */
export function computeDemand(state: SimState): DemandStats {
  const { population, jobs } = countPopulationAndJobs(state);
  const { jobsPerResident, retailPerResident, retailPerJob, pioneerPopulation, demandHeadroom } =
    BALANCE.growth;

  // Each target is scaled by the headroom factor so the two mutually
  // dependent zones always leave at least one demand above the threshold.
  const targetPopulation = (pioneerPopulation + jobs / jobsPerResident) * demandHeadroom;
  const residential = normalize(targetPopulation - population, targetPopulation);

  const targetJobs = population * jobsPerResident * demandHeadroom;
  const commercial = normalize(targetJobs - jobs, Math.max(targetJobs, jobs));

  const retailJobs = countRetailJobs(state);
  const targetRetail = (population * retailPerResident + jobs * retailPerJob) * demandHeadroom;
  const retail = normalize(targetRetail - retailJobs, Math.max(targetRetail, retailJobs));

  return { residential, commercial, retail };
}

function normalize(difference: number, scale: number): number {
  if (scale <= 0) return 0;
  return Math.min(Math.max(difference / scale, -1), 1);
}

export function demandFor(demand: DemandStats, zone: Zone): number {
  switch (zone) {
    case Zone.Residential:
      return demand.residential;
    case Zone.Commercial:
      return demand.commercial;
    case Zone.Retail:
      return demand.retail;
    default:
      return -1;
  }
}

export function hasRoadAccess(state: SimState, index: number): boolean {
  const { tileType } = state.layers;
  return neighbors4(index, state.size).some((neighbor) => tileType[neighbor] === TileType.Road);
}

/**
 * One growth step: a few seeded-random tiles get the chance to spawn a
 * building or densify. Buildings only appear on zoned tiles next to a
 * road; densification additionally requires full energy supply and a
 * minimum building age. City-wide happiness gates all growth.
 */
export function growthStep(state: SimState, demand: DemandStats): void {
  const { layers } = state;
  const tileCount = state.size * state.size;

  const [livedInAge, weatheredAge] = BALANCE.growth.ageStageTicks;
  layers.buildingAge.forEach((_, i) => {
    if (layers.density[i] === 0) return;
    const age = ++layers.buildingAge[i];
    // The renderer only hears about dirty tiles: tell it the moment a
    // building turns lived-in or weathered (ageStageOf in state.ts). Age
    // only ever moves by +1 or resets to 0 (never jumps or decrements by
    // more), so this equality check against the thresholds is exact.
    if (age === livedInAge || age === weatheredAge) markDirty(state, i);
  });

  if (state.happiness < BALANCE.happiness.growthMinimum) return;

  for (let attempt = 0; attempt < BALANCE.growth.attemptsPerTick; attempt++) {
    const index = state.rng.nextInt(tileCount);
    const zone = layers.zone[index] as Zone;
    if (zone === Zone.None) continue;
    if (layers.tileType[index] !== TileType.Empty) continue;
    if (layers.terrain[index] !== Terrain.Land) continue;
    // Lines may run over zoned land; nothing is ever built on a line tile.
    if (layers.powerLine[index] !== 0) continue;
    if (demandFor(demand, zone) < BALANCE.growth.growthDemandThreshold) continue;
    if (!hasRoadAccess(state, index)) continue;

    const density = layers.density[index];
    if (density === 0) {
      if (layers.supplied[index] === SupplyStatus.Undersupplied) continue;
      if (!state.rng.chance(BALANCE.growth.growthChance)) continue;
      layers.density[index] = 1;
      layers.variant[index] = state.rng.nextInt(BUILDING_VARIANTS);
      layers.buildingAge[index] = 0;
      markDirty(state, index);
    } else if (density < 3) {
      if (!canDensify(state, index)) continue;
      if (!state.rng.chance(BALANCE.growth.growthChance)) continue;
      layers.density[index] = density + 1;
      layers.buildingAge[index] = 0;
      markDirty(state, index);
    }
  }
}

/**
 * Densification requires a minimum building age, a powered fire station in
 * reach for the top density, and — once the energy system is active (any
 * plant placed) — full supply.
 */
function canDensify(state: SimState, index: number): boolean {
  const { layers } = state;
  if (layers.buildingAge[index] < BALANCE.growth.densifyMinAge) return false;
  // The top density needs a fire station in reach.
  if (layers.density[index] === 2 && (layers.services[index] & SERVICE_FIRE) === 0) return false;
  // Shops need a recent delivery to grow.
  if (layers.zone[index] === Zone.Retail && !isShopSupplied(state, index)) return false;
  if (!energySystemActive(state)) return true;
  return layers.supplied[index] === SupplyStatus.Supplied;
}

/** True once the player has placed any power-related plant (not parks). */
export function energySystemActive(state: SimState): boolean {
  return hasPowerInfrastructure(state);
}

/**
 * Abandonment: buildings track how long they have been without full
 * supply; after a grace period they decay one density level at a time
 * until the lot is vacant again. Inactive until the first plant exists,
 * so a young pre-grid settlement doesn't self-destruct.
 */
export function decayStep(state: SimState): void {
  const { layers } = state;
  const active = energySystemActive(state);
  for (let i = 0; i < layers.density.length; i++) {
    if (layers.tileType[i] !== TileType.Empty || layers.density[i] === 0) {
      layers.troubledTicks[i] = 0;
      continue;
    }
    if (!active) {
      layers.troubledTicks[i] = 0;
      continue;
    }
    // Leaky counter: undersupply flickers tick to tick, so supplied ticks
    // drain the counter faster than troubled ticks fill it. Chronic
    // trouble accumulates; occasional dips recover.
    if (layers.supplied[i] === SupplyStatus.Supplied) {
      layers.troubledTicks[i] = Math.max(0, layers.troubledTicks[i] - 2);
      continue;
    }
    layers.troubledTicks[i]++;
    if (layers.troubledTicks[i] < BALANCE.growth.abandonAfterTicks) continue;
    if (!state.rng.chance(BALANCE.growth.abandonChancePerTick)) continue;
    layers.density[i]--;
    layers.buildingAge[i] = 0;
    layers.troubledTicks[i] = 0;
    markDirty(state, i);
  }
}
