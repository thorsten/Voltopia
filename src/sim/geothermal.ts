import { BALANCE } from '../shared/constants.ts';
import { chebyshevDistance, neighbors4 } from '../shared/grid.ts';
import { Rng } from '../shared/rng.ts';
import { Terrain } from '../shared/types.ts';
import { markDirty, slopeAt, type SimState } from './state.ts';

/** Keeps the hotspots independent of terrain, water, forest and gameplay RNG. */
const GEOTHERMAL_SEED_SALT = 0x6e07be;

/** A brimful reservoir, as stored in the quantised `reservoirHeat` layer. */
export const FULL_HEAT = 255;

/**
 * Geothermal hotspots: small clusters of hot rock, drawn toward the
 * highlands but never confined to them. Each cluster is one *field* —
 * several wells may tap it, and they share its heat (see reservoirStep).
 *
 * Generation is a pure function of seed, terrain and elevation, so a save
 * written before this feature can regenerate exactly the same hotspots.
 */
export function generateGeothermal(state: SimState): void {
  const rng = new Rng((state.seed ^ GEOTHERMAL_SEED_SALT) >>> 0);
  const { size } = state;
  const cfg = BALANCE.geothermal;
  const { geothermal, reservoirHeat } = state.layers;

  // Candidates are buildable land; highland tiles enter the pool several
  // times so they are drawn more often without ever being required.
  const pool: number[] = [];
  for (let index = 0; index < geothermal.length; index++) {
    if (!isDrillable(state, index)) continue;
    const weight = state.layers.elevation[index] >= cfg.highlandLevel ? cfg.highlandWeight : 1;
    for (let w = 0; w < weight; w++) pool.push(index);
  }
  if (pool.length === 0) return;

  const target = Math.min(
    cfg.maxSpots,
    Math.max(cfg.minSpots, Math.round((size * size) / cfg.tilesPerSpot)),
  );
  const [minSize, maxSize] = cfg.clusterSizeRange;
  const seeds: number[] = [];
  // Bounded: every attempt consumes one draw, so this always terminates.
  const maxAttempts = target * 40;
  for (let attempt = 0; attempt < maxAttempts && seeds.length < target; attempt++) {
    const seed = pool[rng.nextInt(pool.length)];
    if (geothermal[seed] !== 0) continue;
    if (seeds.some((other) => chebyshevDistance(seed, other, size) < cfg.minSpotDistance)) {
      continue;
    }
    // A seed adjacent to another field's tiles would grow straight into
    // it (see growField) and merge two fields into one connected
    // component, breaking clusterSizeRange and (later) the one-field-one-
    // reservoir model. Only every OTHER field is written to the layer at
    // this point (a field's own tiles land there only once it is
    // complete), so this check only ever sees earlier fields.
    if (neighbors4(seed, size).some((n) => geothermal[n] !== 0)) continue;

    const highland = state.layers.elevation[seed] >= cfg.highlandLevel;
    const quality = Math.min(3, 1 + rng.nextInt(2) + (highland ? 1 : 0));
    const wanted = minSize + rng.nextInt(maxSize - minSize + 1);
    const tiles = growField(state, seed, wanted, rng);
    if (tiles.length < minSize) continue;

    for (const index of tiles) {
      geothermal[index] = quality;
      reservoirHeat[index] = FULL_HEAT;
      markDirty(state, index);
    }
    seeds.push(seed);
  }
}

/** True where a well could ever stand: buildable land, no water. */
function isDrillable(state: SimState, index: number): boolean {
  if (state.layers.terrain[index] !== Terrain.Land) return false;
  return slopeAt(state, index) <= BALANCE.terrain.maxBuildSlope;
}

/**
 * Grow a field from its seed by random flood fill over drillable land. A
 * candidate tile may only join the field if none of ITS 4-neighbours
 * already carries another field's (non-zero) geothermal value — otherwise
 * two fields that grow toward each other could end up 4-adjacent and read
 * back as a single connected component (see generateGeothermal).
 */
function growField(state: SimState, seed: number, wanted: number, rng: Rng): number[] {
  const tiles = [seed];
  const frontier = [...neighbors4(seed, state.size)];
  while (tiles.length < wanted && frontier.length > 0) {
    const pick = rng.nextInt(frontier.length);
    const index = frontier.splice(pick, 1)[0];
    if (tiles.includes(index)) continue;
    if (!isDrillable(state, index) || state.layers.geothermal[index] !== 0) continue;
    if (neighbors4(index, state.size).some((n) => state.layers.geothermal[n] !== 0)) continue;
    tiles.push(index);
    frontier.push(...neighbors4(index, state.size));
  }
  return tiles;
}
