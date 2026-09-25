import { BALANCE } from '../shared/constants.ts';
import { chebyshevDistance, neighbors4 } from '../shared/grid.ts';
import { Rng } from '../shared/rng.ts';
import { PlantType, Terrain, TileType } from '../shared/types.ts';
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

/**
 * One hotspot cluster: the wells on its tiles share its heat. Derived
 * from the `geothermal` layer, never persisted — `heat` is restored from
 * the quantised `reservoirHeat` layer on load.
 */
export interface GeothermalField {
  tiles: number[];
  /** Hotspot quality 1..3, shared by every tile of the field. */
  quality: number;
  /** Wells the field sustains before its reservoir starts cooling. */
  capacity: number;
  /** Reservoir temperature 0..1; the authoritative, unquantised value. */
  heat: number;
}

/**
 * Recompute `state.geothermalFields` as connected components of the
 * hotspot layer. Call after generating a map and after loading a save.
 */
export function discoverGeothermalFields(state: SimState): void {
  const cfg = BALANCE.geothermal;
  const { geothermal, reservoirHeat } = state.layers;
  const seen = new Uint8Array(geothermal.length);
  const fields: GeothermalField[] = [];
  for (let start = 0; start < geothermal.length; start++) {
    if (geothermal[start] === 0 || seen[start] !== 0) continue;
    const tiles: number[] = [];
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const index = stack.pop()!;
      tiles.push(index);
      for (const n of neighbors4(index, state.size)) {
        if (geothermal[n] !== 0 && seen[n] === 0) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    const quality = geothermal[start];
    fields.push({
      tiles,
      quality,
      capacity: Math.max(
        1,
        Math.round(tiles.length * cfg.sustainablePerTile * cfg.qualityFactor[quality]),
      ),
      heat: reservoirHeat[start] / FULL_HEAT,
    });
  }
  state.geothermalFields = fields;
}

/** The field a tile belongs to, if any. */
export function fieldAt(state: SimState, index: number): GeothermalField | undefined {
  return state.geothermalFields.find((field) => field.tiles.includes(index));
}

/**
 * Advance every field's reservoir by one tick.
 *
 * `heat += recharge * (1 - heat) - drain * excessWells * heat`
 *
 * Up to `capacity` wells the field stays at heat 1. Beyond it the
 * temperature settles at `recharge / (recharge + drain * excess)` — a
 * lower equilibrium, never zero — and climbs back toward 1 as soon as the
 * excess wells are removed. Total field output (`wells * heat`) therefore
 * keeps rising with every well but flattens toward `recharge / drain`
 * well-equivalents: overdrilling wastes money, it never ruins a field.
 */
export function reservoirStep(state: SimState): void {
  const cfg = BALANCE.geothermal;
  const { tileType, plantType, reservoirHeat } = state.layers;
  for (const field of state.geothermalFields) {
    let wells = 0;
    for (const index of field.tiles) {
      if (tileType[index] === TileType.Plant && plantType[index] === PlantType.GeothermalPlant) {
        wells++;
      }
    }
    const excess = Math.max(0, wells - field.capacity);
    const next = field.heat + cfg.recharge * (1 - field.heat) - cfg.drain * excess * field.heat;
    field.heat = Math.min(1, Math.max(0, next));

    // The layer is only a quantised mirror for diffs, save and render; a
    // slow drift must not flood the diff channel every tick.
    const quantised = Math.round(field.heat * FULL_HEAT);
    // Samples only tiles[0]: every tile of a field carries the same
    // quantised value. That invariant is established when a field is
    // first written (generateGeothermal fills every tile with FULL_HEAT)
    // and kept here (the loop below always writes all of a field's
    // tiles together); deserializeState in state.ts restores the whole
    // layer at once, so a loaded save preserves it too.
    if (reservoirHeat[field.tiles[0]] === quantised) continue;
    for (const index of field.tiles) {
      reservoirHeat[index] = quantised;
      markDirty(state, index);
    }
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
