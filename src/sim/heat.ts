/**
 * District heating.
 *
 * A heat plant is a large heat pump that injects heat into the road
 * network next to it; the network reaches `reachHops` road tiles out and
 * serves every building standing beside one of them. A heat store is a
 * hot-water tank the surplus cascade fills through the pumps. Heat never
 * turns back into electricity: the store is a one-way flexible load that
 * eats surplus and shifts the heating peak off the evening.
 *
 * `layers.heated` is derived every tick from the energised, undamaged
 * plants; it is never persisted.
 */
import { BALANCE } from '../shared/constants.ts';
import { neighbors4 } from '../shared/grid.ts';
import { HEATED_SERVED, HEATED_TRUNK, PlantType, Zone } from '../shared/types.ts';
import { censusPlants, heatingConsumption } from './energy.ts';
import { recomputeGrid } from './powerGrid.ts';
import { heatingDegree } from '../shared/heating.ts';
import { markDirty, TileType, type SimState } from './state.ts';

/**
 * Coefficient of performance of the heat pumps at an outdoor
 * temperature: `copWarm` at or above `copWarmTemperature`, `copCold` at
 * or below `copColdTemperature`, linear in between.
 */
export function heatPumpCop(temperature: number): number {
  const { copWarm, copCold, copWarmTemperature, copColdTemperature } = BALANCE.heat;
  if (temperature >= copWarmTemperature) return copWarm;
  if (temperature <= copColdTemperature) return copCold;
  const t = (temperature - copColdTemperature) / (copWarmTemperature - copColdTemperature);
  return copCold + (copWarm - copCold) * t;
}

/**
 * Road tiles the network reaches from one plant tile: a breadth-first
 * walk over 4-neighbour road tiles, at most `reachHops` deep, seeded by
 * the roads touching the plant. Plain hops, deliberately not
 * `roadDistances`: that prices avenues and traffic, and membership must
 * not flicker with the rush hour. Empty when no road touches the plant.
 */
export function plantReach(state: SimState, plant: number): number[] {
  const { tileType } = state.layers;
  const { size } = state;
  const maxHops = BALANCE.heat.reachHops;
  const hops = new Map<number, number>();
  const queue: number[] = [];
  for (const neighbor of neighbors4(plant, size)) {
    if (tileType[neighbor] !== TileType.Road || hops.has(neighbor)) continue;
    hops.set(neighbor, 1);
    queue.push(neighbor);
  }
  for (let head = 0; head < queue.length; head++) {
    const tile = queue[head];
    const depth = hops.get(tile)!;
    if (depth >= maxHops) continue;
    for (const neighbor of neighbors4(tile, size)) {
      if (tileType[neighbor] !== TileType.Road || hops.has(neighbor)) continue;
      hops.set(neighbor, depth + 1);
      queue.push(neighbor);
    }
  }
  return queue;
}

/**
 * Rebuild the heated layer from every heat plant that is connected to
 * the grid and intact. Tiles whose value changes are marked dirty so the
 * overlay and inspector follow. Deterministic; cost is plants × reach²
 * plus one pass over the grid, like the services layer.
 */
export function recomputeHeated(state: SimState): void {
  recomputeGrid(state);
  const { layers, size } = state;
  const next = new Uint8Array(layers.heated.length);
  for (let i = 0; i < layers.tileType.length; i++) {
    if (layers.tileType[i] !== TileType.Plant) continue;
    if (layers.plantType[i] !== PlantType.HeatPlant) continue;
    if (layers.energized[i] !== 1 || layers.damage[i] !== 0) continue;
    for (const road of plantReach(state, i)) next[road] = HEATED_TRUNK;
  }
  for (let i = 0; i < next.length; i++) {
    if (next[i] !== HEATED_TRUNK) continue;
    for (const neighbor of neighbors4(i, size)) {
      if (layers.tileType[neighbor] !== TileType.Empty || layers.density[neighbor] === 0) continue;
      // The energy loop treats a damaged or unconnected building as dark:
      // it draws nothing, so the network must not heat or bill it either.
      if (layers.damage[neighbor] !== 0 || layers.energized[neighbor] !== 1) continue;
      next[neighbor] = HEATED_SERVED;
    }
  }
  for (let i = 0; i < next.length; i++) {
    if (next[i] === layers.heated[i]) continue;
    layers.heated[i] = next[i];
    markDirty(state, i);
  }
}

export interface HeatTickResult {
  /** Heat the served buildings wanted this tick. */
  demand: number;
  /** Heat the store released. */
  fromStore: number;
  /** Heat the pumps made. */
  pumpHeat: number;
  /** Electricity the pumps drew to make pumpHeat. */
  pumpPower: number;
  /** Heat nobody delivered; those buildings heat themselves electrically. */
  fallback: number;
  /** Pump electricity still available this tick for charging the store. */
  pumpPowerLeft: number;
  /** COP in force. */
  cop: number;
  /** Heat units the store can still take. */
  headroom: number;
  /** Installed store capacity (heat units). */
  capacity: number;
  /** fromStore + pumpHeat. */
  networkHeat: number;
}

/** The result of a tick without any district heating. */
export const IDLE_HEAT: Readonly<HeatTickResult> = Object.freeze({
  demand: 0,
  fromStore: 0,
  pumpHeat: 0,
  pumpPower: 0,
  fallback: 0,
  pumpPowerLeft: 0,
  cop: 1,
  headroom: 0,
  capacity: 0,
  networkHeat: 0,
});

/**
 * One tick of the heat balance, run before the energy balance:
 * rebuild the network, sum the served buildings' heat demand, cover it
 * from the store (within its discharge limit), then from the pumps at
 * the current COP (within their power limit); whatever is left falls
 * back to the buildings' own electric heating. The store then loses its
 * standing share. Charging happens later, in the surplus cascade.
 */
export function heatStep(state: SimState): HeatTickResult {
  recomputeHeated(state);
  const cfg = BALANCE.heat;
  const { layers } = state;
  const census = censusPlants(state);
  const capacity = census.heatStores * cfg.storeCapacity;
  state.heatStored = Math.min(state.heatStored, capacity);

  const temperature = state.season.temperature;
  let demand = 0;
  for (let i = 0; i < layers.heated.length; i++) {
    if (layers.heated[i] !== HEATED_SERVED) continue;
    demand += heatingConsumption(
      layers.zone[i] as Zone,
      layers.density[i],
      temperature,
      state.insulation,
    );
  }

  const cop = heatPumpCop(temperature);
  const fromStore = Math.min(demand, census.heatStores * cfg.storeDischargeLimit, state.heatStored);
  state.heatStored -= fromStore;
  const pumpPowerLimit = census.heatPlants * cfg.pumpPowerLimit;
  const pumpHeat = Math.min(demand - fromStore, pumpPowerLimit * cop);
  const pumpPower = pumpHeat / cop;
  const fallback = demand - fromStore - pumpHeat;
  state.heatStored *= 1 - cfg.storeLossPerTick;

  return {
    demand,
    fromStore,
    pumpHeat,
    pumpPower,
    fallback,
    pumpPowerLeft: pumpPowerLimit - pumpPower,
    cop,
    headroom: Math.max(0, capacity - state.heatStored),
    capacity,
    networkHeat: fromStore + pumpHeat,
  };
}

/**
 * The store only fills while the coming night will need heat: the
 * diurnal swing below the current temperature must still be a heating
 * degree. A summer surplus is exported, not boiled away.
 */
export function nightNeedsHeat(temperature: number): boolean {
  return heatingDegree(temperature - BALANCE.seasons.diurnalAmplitude) > 0;
}

/**
 * Push surplus electricity into the store through the pumps: one
 * electricity unit stores `cop` heat units, within the pump power left
 * after serving and within the headroom. Returns the electricity
 * absorbed; mutates the store and the result's remaining budgets.
 */
export function chargeHeatStore(state: SimState, heat: HeatTickResult, surplus: number): number {
  if (surplus <= 0 || heat.pumpPowerLeft <= 0 || heat.headroom <= 0) return 0;
  if (!nightNeedsHeat(state.season.temperature)) return 0;
  const absorbed = Math.max(0, Math.min(surplus, heat.pumpPowerLeft, heat.headroom / heat.cop));
  state.heatStored += absorbed * heat.cop;
  heat.headroom -= absorbed * heat.cop;
  heat.pumpPowerLeft -= absorbed;
  return absorbed;
}
