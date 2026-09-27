import { BALANCE } from '../shared/constants.ts';
import { neighbors4 } from '../shared/grid.ts';
import { DisasterKind, TileType } from '../shared/types.ts';
import { addDamage, type DisasterSpec } from './disasters.ts';
import { clearForest } from './forest.ts';
import { SERVICE_FIRE } from './services.ts';
import type { SimState } from './state.ts';

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * How dry the city is, 0..1: warm, cloudless and snow-free weather dries
 * it out. All three factors multiply, so a single wet one keeps the city
 * safe — a winter fire is effectively impossible.
 */
export function dryness(state: SimState): number {
  const cfg = BALANCE.disasters.fire;
  const warm = clamp01((state.season.temperature - cfg.dryTemperature) / cfg.dryTemperatureSpan);
  const clear = clamp01((cfg.dryCloudCeiling - state.weather.cloudCover) / cfg.dryCloudCeiling);
  const snowFree = 1 - clamp01(state.weather.snowpack);
  return warm * clear * snowFree;
}

/**
 * Weighted pool of ignition sites: dense buildings weigh by density, and
 * four times as much without fire cover — so every station measurably
 * lowers the chance of a fire, not just its consequences. Mature woods
 * join the pool: in a drought the forest is fuel.
 */
export function fireCandidates(state: SimState): number[] {
  const cfg = BALANCE.disasters.fire;
  const { tileType, density, services, forest, damage } = state.layers;
  const pool: number[] = [];
  for (let i = 0; i < tileType.length; i++) {
    if (damage[i] !== 0) continue;
    if (tileType[i] === TileType.Empty && density[i] > 0) {
      const covered = (services[i] & SERVICE_FIRE) !== 0;
      const weight =
        density[i] * (covered ? cfg.coveredIgnitionWeight : cfg.uncoveredIgnitionWeight);
      for (let w = 0; w < weight; w++) pool.push(i);
    } else if (forest[i] >= BALANCE.forest.maxStage) {
      pool.push(i);
    }
  }
  return pool;
}

/** Fires need fuel and drought; the exposure saturates on a big city. */
export function fireRisk(state: SimState): number {
  const cfg = BALANCE.disasters.fire;
  const dry = dryness(state);
  if (dry <= 0) return 0;
  const pool = fireCandidates(state);
  if (pool.length === 0) return 0;
  const exposure = Math.min(1, pool.length / cfg.exposureSaturation);
  return cfg.baseRisk * dry * exposure;
}

/** Buildings and woods burn; roads, water, plants and bare land do not. */
function isFlammable(state: SimState, index: number): boolean {
  const { tileType, density, forest, damage } = state.layers;
  if (damage[index] !== 0) return false;
  if (forest[index] !== 0) return true;
  return tileType[index] === TileType.Empty && density[index] > 0;
}

export const fireSpec: DisasterSpec = {
  kind: DisasterKind.Fire,
  warnTicks: BALANCE.disasters.fire.warnTicks,
  durationTicks: BALANCE.disasters.fire.durationTicks,
  severityRange: BALANCE.disasters.fire.severityRange,
  risk: fireRisk,
  plan(state, _severity) {
    const pool = fireCandidates(state);
    if (pool.length === 0) return null;
    const origin = pool[state.rng.nextInt(pool.length)];
    return {
      origin,
      tiles: [origin],
      intensity: [BALANCE.disasters.fire.burnTicks],
    };
  },
  apply(state, event) {
    const cfg = BALANCE.disasters.fire;
    const { services, forest, density } = state.layers;
    // Snapshot the length: tiles that catch this tick only act from the
    // next one, so a fire cannot race across the map in a single tick.
    const burning = event.tiles.length;
    for (let n = 0; n < burning; n++) {
      if (event.intensity[n] <= 0) continue;
      const index = event.tiles[n];
      const covered = (services[index] & SERVICE_FIRE) !== 0;

      if (forest[index] !== 0) {
        // Woods burn away rather than break: nothing here to repair. This
        // clears on the first tick only — the tile keeps "burning" (and
        // can still ignite neighbours) for the rest of its window, so
        // gate the damage branch below on density, not on forest being
        // zero, or a cleared tile would start taking building damage.
        clearForest(state, index);
      } else if (density[index] > 0) {
        addDamage(state, index, cfg.damagePerTick * event.severity);
      }

      event.intensity[n] -= covered ? cfg.extinguishCovered : 1;
      if (event.intensity[n] <= 0) continue;

      const spread = (covered ? cfg.spreadChanceCovered : cfg.spreadChance) * event.severity;
      for (const neighbor of neighbors4(index, state.size)) {
        if (!isFlammable(state, neighbor) || event.tiles.includes(neighbor)) continue;
        if (!state.rng.chance(spread)) continue;
        event.tiles.push(neighbor);
        event.intensity.push(cfg.burnTicks);
      }
    }
    return event.intensity.every((ticks) => ticks <= 0);
  },
};
