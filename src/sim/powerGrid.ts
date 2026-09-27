import { BALANCE } from '../shared/constants.ts';
import {
  chebyshevDistance,
  LINE_PRESENT,
  lShapedPath,
  neighbors4,
  tileIndex,
  tileX,
  tileY,
} from '../shared/grid.ts';
import { PlantType, TileType } from '../shared/types.ts';
import { recomputePowerLineMask } from './powerLines.ts';
import type { SimState } from './state.ts';

/** Plants that feed the grid and seed the line network (hubs and parks do not). */
const SUPPLY_SOURCES: ReadonlySet<PlantType> = new Set<PlantType>([
  PlantType.SolarFarm,
  PlantType.WindTurbine,
  PlantType.Battery,
  PlantType.BiogasPlant,
  PlantType.RunOfRiver,
  PlantType.PumpedStorage,
  PlantType.HydrogenPlant,
  PlantType.TidalPlant,
]);

export function isSupplySource(plant: PlantType): boolean {
  return SUPPLY_SOURCES.has(plant);
}

/** Mark every tile within a Chebyshev radius of `index`, clipped to the map. */
function stampRadius(target: Uint8Array, index: number, size: number, radius: number): void {
  const cx = tileX(index, size);
  const cy = tileY(index, size);
  const x0 = Math.max(0, cx - radius);
  const x1 = Math.min(size - 1, cx + radius);
  const y0 = Math.max(0, cy - radius);
  const y1 = Math.min(size - 1, cy + radius);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) target[tileIndex(x, y, size)] = 1;
  }
}

/**
 * Rebuild the energized layer when plants or lines changed: flood-fill
 * from every supply plant over 4-connected line tiles, then stamp the
 * connection radius around every energised line tile and every supply
 * plant. Line tiles the fill never reaches are dead.
 */
export function recomputeGrid(state: SimState): void {
  if (state.gridComputedVersion === state.gridVersion) return;
  const { layers } = state;
  const size = state.size;
  const { powerLine, energized, tileType, plantType, damage } = layers;
  const radius = BALANCE.energy.lineSupplyRadius;

  const reached = new Uint8Array(size * size);
  const queue: number[] = [];
  const sources: number[] = [];
  for (let i = 0; i < tileType.length; i++) {
    if (tileType[i] !== TileType.Plant || !isSupplySource(plantType[i] as PlantType)) continue;
    if (damage[i] !== 0) continue; // a damaged plant feeds nothing
    sources.push(i);
    for (const n of neighbors4(i, size)) {
      if (powerLine[n] !== 0 && damage[n] === 0 && reached[n] === 0) {
        reached[n] = 1;
        queue.push(n);
      }
    }
  }
  while (queue.length > 0) {
    const index = queue.pop()!;
    for (const n of neighbors4(index, size)) {
      if (powerLine[n] !== 0 && damage[n] === 0 && reached[n] === 0) {
        reached[n] = 1;
        queue.push(n);
      }
    }
  }

  energized.fill(0);
  for (const source of sources) stampRadius(energized, source, size, radius);
  for (let i = 0; i < reached.length; i++) {
    if (reached[i] === 1) stampRadius(energized, i, size, radius);
  }
  state.gridComputedVersion = state.gridVersion;
}

/**
 * Whether a tile can carry a power line. Mirrors `buildRejection`'s
 * PowerLine rule in state.ts (lines share tiles with roads and water but
 * never with buildings or plants); duplicated instead of imported so this
 * module's import of state.ts stays type-only (state.ts imports this one).
 */
function canCarryLine(state: SimState, index: number): boolean {
  const { density, tileType } = state.layers;
  return density[index] === 0 && tileType[index] !== TileType.Plant;
}

/**
 * The road tile closest to `index` within `radius` (Chebyshev), or -1
 * when there is none. Ties go to the lowest tile index.
 */
function nearestRoadTile(state: SimState, index: number, radius: number): number {
  const { tileType } = state.layers;
  const size = state.size;
  const cx = tileX(index, size);
  const cy = tileY(index, size);
  const x0 = Math.max(0, cx - radius);
  const x1 = Math.min(size - 1, cx + radius);
  const y0 = Math.max(0, cy - radius);
  const y1 = Math.min(size - 1, cy + radius);
  let best = -1;
  let bestDistance = Infinity;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const candidate = tileIndex(x, y, size);
      if (tileType[candidate] !== TileType.Road) continue;
      const distance = chebyshevDistance(index, candidate, size);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
      }
    }
  }
  return best;
}

/**
 * One-time migration for saves from before power lines: hook every supply
 * plant up to the nearest road within the old supply radius (an L-shaped
 * connector, since plants never had to touch a street) and put a line on
 * every road tile reachable over roads from there, so the loaded city
 * stays supplied and shows a network along its streets.
 */
export function grantLegacyNetwork(state: SimState): void {
  const { layers } = state;
  const size = state.size;
  const { tileType, plantType, powerLine } = layers;
  const granted: number[] = [];
  const grant = (index: number): void => {
    if (powerLine[index] !== 0) return;
    powerLine[index] = LINE_PRESENT;
    granted.push(index);
  };

  const seen = new Uint8Array(size * size);
  for (let i = 0; i < tileType.length; i++) {
    if (tileType[i] !== TileType.Plant || !isSupplySource(plantType[i] as PlantType)) continue;
    const road = nearestRoadTile(state, i, BALANCE.energy.legacySupplyRadius);
    if (road < 0) continue;
    // Connector from the plant to that road. A building in the way breaks
    // the connector — those plants simply stay unconnected.
    const connector = lShapedPath(
      tileX(i, size),
      tileY(i, size),
      tileX(road, size),
      tileY(road, size),
      size,
    );
    for (const index of connector) {
      if (index === i || !canCarryLine(state, index)) continue;
      grant(index);
    }
    if (seen[road] === 1) continue;
    // Follow the streets from there and light up the whole road network.
    seen[road] = 1;
    const queue: number[] = [road];
    while (queue.length > 0) {
      const index = queue.pop()!;
      grant(index);
      for (const n of neighbors4(index, size)) {
        if (tileType[n] === TileType.Road && seen[n] === 0) {
          seen[n] = 1;
          queue.push(n);
        }
      }
    }
  }

  for (const index of granted) recomputePowerLineMask(state, index);
  // Inline instead of bumpGridVersion(): keeps this module's import of
  // state.ts type-only (state.ts imports this module for the migration).
  state.gridVersion++;
}
