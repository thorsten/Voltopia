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
 * The floodplain at this severity: a fill outward from every river and
 * lake tile that loses one elevation level per tile of land it crosses.
 * Each water tile starts at its own bed elevation plus `rise`; every land
 * neighbour is offered that water line minus one, floods if its ground
 * lies at or below the offer, and passes on one level less again. So the
 * water climbs a bank until it runs out of head, and on dead-flat ground
 * a rise of `r` reaches `r` tiles inland.
 *
 * The decay is what makes the floodplain a floodplain, and it has to be
 * in here rather than in the water line: relief alone does not bound the
 * fill, because this game's maps are broad and low (elevation 0..7, most
 * tiles at 1..3), so carrying the line inland unchanged found a
 * contiguous path across the whole map — the balancing probe measured the
 * *mildest* flood covering every land tile on three of six seeds.
 *
 * Each tile keeps the highest water line any path can offer it, so the
 * fill is a max-relaxation: raising `rise` can only raise a tile's line,
 * never lower it, which makes the flooded set grow monotonically with
 * severity. (A lateral hop-count limit does not have that property — the
 * hop count of the path that *raised* a tile's line is not its shortest,
 * so a stricter limit could cut off a tile a milder flood had reached.)
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
    // One level of head is spent crossing to the next tile of land.
    const offer = level[index] - 1;
    for (const neighbor of neighbors4(index, state.size)) {
      if (terrain[neighbor] !== Terrain.Land) continue;
      if (elevation[neighbor] > offer) continue;
      if (level[neighbor] >= offer) continue;
      level[neighbor] = offer;
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
    const elapsed = state.tick - event.startTick;
    if (elapsed < 0) return false;
    for (let i = 0; i < event.tiles.length; i++) {
      const index = event.tiles[i];
      if (!isVulnerable(state, index)) continue;
      const deeper = 1 + event.intensity[i] * cfg.depthFactor;
      // Standing water is a slow soak, not a strike: the per-tile rate is
      // well under one damage point per tick, so accumulate it the same way
      // the storm accumulates its strikes (a running total differenced
      // across the tick) instead of letting addDamage round it up to one.
      // Shallow ground is then still repairable when the water recedes
      // while the deep middle of the plain is written off.
      const rate = cfg.damagePerTick * event.severity * deeper;
      addDamage(state, index, Math.floor(rate * (elapsed + 1)) - Math.floor(rate * elapsed));
    }
    return false; // the water recedes on schedule
  },
};
