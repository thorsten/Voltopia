import { BALANCE } from '../shared/constants.ts';
import { DisasterKind, PlantType, TileType, type DisasterEvent } from '../shared/types.ts';
import { addDamage, type DisasterSpec } from './disasters.ts';
import type { SimState } from './state.ts';
import { frontMeans } from './weather.ts';

/**
 * Storm risk from the *front's* wind mean, not the momentary wind: a
 * building wind high is the warning behind the warning, and it is
 * readable in the HUD's wind display days ahead. Winter storms are more
 * likely, as they are in reality.
 */
export function stormRisk(state: SimState): number {
  const cfg = BALANCE.disasters.storm;
  const { windMean } = frontMeans(state.seed, state.tick, state.season);
  if (windMean <= cfg.windThreshold) return 0;
  const ramp = (windMean - cfg.windThreshold) / (1 - cfg.windThreshold);
  const winter = state.season.season === 'winter' ? cfg.winterFactor : 1;
  return cfg.baseRisk * ramp * winter;
}

/**
 * Gust the active storms add to the wind. Severe storms push the city
 * over the turbines' cut-out speed, so the wind fleet stops exactly when
 * the wind is strongest; a moderate storm only runs it flat out.
 */
export function stormGust(state: SimState): number {
  const cfg = BALANCE.disasters.storm;
  let gust = 0;
  for (const event of state.disasters.active) {
    if (event.kind !== DisasterKind.Storm) continue;
    gust = Math.max(gust, cfg.gust * event.severity);
  }
  return gust;
}

/** Damage points one strike does to this tile, by what stands on it. */
function strikeDamage(state: SimState, index: number): number {
  const { damage } = BALANCE.disasters.storm;
  const { tileType, plantType, powerLine } = state.layers;
  if (powerLine[index] !== 0) return damage.line;
  if (tileType[index] === TileType.Plant) {
    return plantType[index] === PlantType.WindTurbine ? damage.turbine : damage.plant;
  }
  return damage.building;
}

/**
 * Weighted pool of everything a storm can wreck: pylons and turbines
 * weigh heaviest, other plants less, buildings least. Roads are absent —
 * a storm never damages a road (a line ON a road is a line, and the road
 * under it stays passable, because nothing in routing reads `damage`).
 * Already damaged tiles are absent too, so a storm spreads its hits.
 */
function targets(state: SimState): number[] {
  const cfg = BALANCE.disasters.storm;
  const { tileType, plantType, powerLine, density, damage } = state.layers;
  const pool: number[] = [];
  for (let i = 0; i < tileType.length; i++) {
    if (damage[i] !== 0) continue;
    let weight = 0;
    if (powerLine[i] !== 0) weight = cfg.weights.line;
    else if (tileType[i] === TileType.Plant) {
      weight = plantType[i] === PlantType.WindTurbine ? cfg.weights.turbine : cfg.weights.plant;
    } else if (tileType[i] === TileType.Empty && density[i] > 0) {
      weight = cfg.weights.building;
    }
    for (let w = 0; w < weight; w++) pool.push(i);
  }
  return pool;
}

/**
 * Tiles this tick strikes, from a rate that may be well below one per
 * tick: the running total `floor(rate * elapsed)` is differenced across
 * the tick, so a rate of 0.7 strikes on seven ticks out of ten instead of
 * rounding up to one every tick. That rounding-up used to make the strike
 * count equal `durationTicks` for any rate at or below 1 — every storm
 * damaged exactly as many tiles as it lasted ticks, whatever its severity
 * and however small the city, since `targets` never offers a tile twice.
 * Severity now scales how *wide* a storm is as well as how hard it hits.
 *
 * Derived from the tick, so it needs no counter on the event and survives
 * a save/load in the middle of a storm unchanged.
 */
export function strikesThisTick(state: SimState, event: DisasterEvent): number {
  const rate = BALANCE.disasters.storm.hitsPerTick * event.severity;
  const elapsed = state.tick - event.startTick;
  if (elapsed < 0) return 0;
  return Math.floor(rate * (elapsed + 1)) - Math.floor(rate * elapsed);
}

export const stormSpec: DisasterSpec = {
  kind: DisasterKind.Storm,
  warnTicks: BALANCE.disasters.storm.warnTicks,
  durationTicks: BALANCE.disasters.storm.durationTicks,
  severityRange: BALANCE.disasters.storm.severityRange,
  risk: stormRisk,
  plan(state, _severity) {
    const pool = targets(state);
    if (pool.length === 0) return null;
    // The storm is global; `origin` is only the marker's anchor.
    const origin = pool[state.rng.nextInt(pool.length)];
    return { origin, tiles: [], intensity: [] };
  },
  apply(state, event) {
    const pool = targets(state);
    if (pool.length === 0) return false;
    const hits = strikesThisTick(state, event);
    for (let n = 0; n < hits; n++) {
      const index = pool[state.rng.nextInt(pool.length)];
      addDamage(state, index, strikeDamage(state, index) * event.severity);
      // Struck tiles join the event so they are not repaired mid-storm.
      // Linear search: a storm collects a few hundred tiles at most.
      if (!event.tiles.includes(index)) {
        event.tiles.push(index);
        event.intensity.push(0);
      }
    }
    return false; // a storm always blows itself out on schedule
  },
};
