import { BALANCE } from '../shared/constants.ts';
import { neighbors4 } from '../shared/grid.ts';
import { DisasterKind, Terrain, TileType } from '../shared/types.ts';
import { addDamage, type DisasterSpec } from './disasters.ts';
import type { SimState } from './state.ts';

/**
 * Flood risk from the river itself: a flow near its maximum, and again
 * as much while a snowpack melts in warm weather — the spring melt peak
 * the seasons already produce.
 */
export function floodRisk(state: SimState): number {
  const cfg = BALANCE.disasters.flood;
  const { riverFlow, snowpack } = state.weather;
  if (riverFlow <= cfg.flowThreshold) return 0;
  const ramp = (riverFlow - cfg.flowThreshold) / (1 - cfg.flowThreshold);
  const melting = snowpack > 0 && state.season.temperature > BALANCE.seasons.meltTemperature;
  return cfg.baseRisk * ramp * (melting ? cfg.meltFactor : 1);
}

/**
 * The floodplain at this severity: a height-ordered fill outward from
 * every river and lake tile. Each water tile floods the land around it up
 * to its own bed elevation plus `rise`, and carries that water line
 * inland as far as the ground stays below it.
 *
 * Purely a function of the map and the severity — the same city floods
 * the same ground every time, so building in the floodplain is an
 * informed choice after the first flood. The terrain layer is never
 * touched: the inundation lives only in `damage` and the event's tiles.
 */
export function floodArea(state: SimState, severity: number): { tiles: number[]; depth: number[] } {
  const cfg = BALANCE.disasters.flood;
  const rise = Math.max(1, Math.round(cfg.maxRise * severity));
  const { terrain, elevation } = state.layers;
  // Water line each tile is reached with; -1 = dry.
  const level = new Int16Array(terrain.length).fill(-1);
  const queue: number[] = [];
  for (let i = 0; i < terrain.length; i++) {
    if (terrain[i] !== Terrain.River && terrain[i] !== Terrain.Lake) continue;
    level[i] = elevation[i] + rise;
    queue.push(i);
  }
  for (let head = 0; head < queue.length; head++) {
    const index = queue[head];
    for (const neighbor of neighbors4(index, state.size)) {
      if (terrain[neighbor] !== Terrain.Land) continue;
      if (elevation[neighbor] > level[index]) continue;
      if (level[neighbor] >= level[index]) continue;
      level[neighbor] = level[index];
      queue.push(neighbor);
    }
  }
  const tiles: number[] = [];
  const depth: number[] = [];
  for (let i = 0; i < terrain.length; i++) {
    if (terrain[i] !== Terrain.Land || level[i] < 0) continue;
    tiles.push(i);
    depth.push(Math.max(0, level[i] - elevation[i]));
  }
  return { tiles, depth };
}

/** Buildings, plants and lines drown; bare land just gets wet. */
function isVulnerable(state: SimState, index: number): boolean {
  const { tileType, density, powerLine } = state.layers;
  if (powerLine[index] !== 0) return true;
  if (tileType[index] === TileType.Plant) return true;
  return tileType[index] === TileType.Empty && density[index] > 0;
}

export const floodSpec: DisasterSpec = {
  kind: DisasterKind.Flood,
  warnTicks: BALANCE.disasters.flood.warnTicks,
  durationTicks: BALANCE.disasters.flood.durationTicks,
  severityRange: BALANCE.disasters.flood.severityRange,
  risk: floodRisk,
  plan(state, severity) {
    const { tiles, depth } = floodArea(state, severity);
    if (tiles.length === 0) return null;
    // The deepest tile anchors the marker: that is where the water is worst.
    let origin = tiles[0];
    let deepest = depth[0];
    for (let i = 1; i < tiles.length; i++) {
      if (depth[i] > deepest) {
        deepest = depth[i];
        origin = tiles[i];
      }
    }
    return { origin, tiles, intensity: depth };
  },
  apply(state, event) {
    const cfg = BALANCE.disasters.flood;
    for (let i = 0; i < event.tiles.length; i++) {
      const index = event.tiles[i];
      if (!isVulnerable(state, index)) continue;
      const deeper = 1 + event.intensity[i] * cfg.depthFactor;
      addDamage(state, index, cfg.damagePerTick * event.severity * deeper);
    }
    return false; // the water recedes on schedule
  },
};
