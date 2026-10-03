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
import { HEATED_SERVED, HEATED_TRUNK, PlantType } from '../shared/types.ts';
import { recomputeGrid } from './powerGrid.ts';
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
      next[neighbor] = HEATED_SERVED;
    }
  }
  for (let i = 0; i < next.length; i++) {
    if (next[i] === layers.heated[i]) continue;
    layers.heated[i] = next[i];
    markDirty(state, i);
  }
}
