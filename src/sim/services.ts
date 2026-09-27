import { BALANCE } from '../shared/constants.ts';
import { tileIndex, tileX, tileY } from '../shared/grid.ts';
import { PlantType, SERVICE_FIRE, SERVICE_POLICE, TileType } from '../shared/types.ts';
import { recomputeGrid } from './powerGrid.ts';
import { markDirty, type SimState } from './state.ts';

// Re-exported so existing sim imports (`import { SERVICE_FIRE } from
// './services.ts'`) keep working; the canonical definition lives in
// shared/types.ts next to TileDiff.services.
export { SERVICE_FIRE, SERVICE_POLICE };

/** OR `bit` into every tile within a Chebyshev radius, clipped to the map. */
function stampBit(
  target: Uint8Array,
  index: number,
  size: number,
  radius: number,
  bit: number,
): void {
  const cx = tileX(index, size);
  const cy = tileY(index, size);
  const x0 = Math.max(0, cx - radius);
  const x1 = Math.min(size - 1, cx + radius);
  const y0 = Math.max(0, cy - radius);
  const y1 = Math.min(size - 1, cy + radius);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) target[tileIndex(x, y, size)] |= bit;
  }
}

/**
 * Rebuild the coverage layer from every station that is connected to
 * the grid. Tiles whose bits change are marked dirty so the overlay in
 * the renderer follows. Deterministic; cost is stations × radius² plus
 * one pass over the grid.
 */
export function recomputeServices(state: SimState): void {
  recomputeGrid(state);
  const { layers, size } = state;
  const next = new Uint8Array(layers.services.length);
  for (let i = 0; i < layers.tileType.length; i++) {
    if (layers.tileType[i] !== TileType.Plant || layers.energized[i] !== 1) continue;
    // A damaged station stamps nothing: a fire that reaches the fire
    // station widens its own path.
    if (layers.damage[i] !== 0) continue;
    const plant = layers.plantType[i] as PlantType;
    if (plant === PlantType.FireStation) {
      stampBit(next, i, size, BALANCE.services.fire.radius, SERVICE_FIRE);
    } else if (plant === PlantType.PoliceStation) {
      stampBit(next, i, size, BALANCE.services.police.radius, SERVICE_POLICE);
    }
  }
  for (let i = 0; i < next.length; i++) {
    if (next[i] === layers.services[i]) continue;
    layers.services[i] = next[i];
    markDirty(state, i);
  }
}

/** Share (0..1) of buildings covered per service; 1/1 when there are no buildings. */
export function serviceCoverage(state: SimState): { fire: number; police: number } {
  const { layers } = state;
  let buildings = 0;
  let fire = 0;
  let police = 0;
  for (let i = 0; i < layers.tileType.length; i++) {
    if (layers.tileType[i] !== TileType.Empty || layers.density[i] === 0) continue;
    buildings++;
    if (layers.services[i] & SERVICE_FIRE) fire++;
    if (layers.services[i] & SERVICE_POLICE) police++;
  }
  if (buildings === 0) return { fire: 1, police: 1 };
  return { fire: fire / buildings, police: police / buildings };
}
