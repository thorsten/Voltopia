import { BALANCE } from '../shared/constants.ts';
import { DIR_E, DIR_N, DIR_S, DIR_W, LINE_PRESENT, tileIndex } from '../shared/grid.ts';
import { crossingIsClosed } from '../shared/levelCrossing.ts';
import { TileType, type SimState } from './state.ts';
import { runningTrains } from './trains.ts';

/**
 * Level crossings closed by an approaching train this tick, as tile
 * indices. Only straight crossings count — those are the ones that carry
 * barriers (render/railMesh.ts draws none on a junction), so what stops
 * a car is always what a player can see coming down.
 *
 * Derived from the trains, not from a grid pass: each train looks a few
 * tiles along its own axis, so the cost is a handful of lookups per
 * train however large the map is.
 */
export function closedCrossings(state: SimState): Set<number> {
  const closed = new Set<number>();
  const trains = runningTrains(state);
  if (trains.length === 0) return closed;
  const reach = Math.ceil(BALANCE.rail.crossingApproachTiles);
  const { tileType, rail } = state.layers;
  for (const train of trains) {
    const tx = Math.floor(train.x);
    const ty = Math.floor(train.y);
    // The train's heading picks the line of tiles to look along; each
    // candidate's own track direction then decides whether it is a
    // straight crossing and which way its traffic runs.
    const headingAlongX = Math.abs(Math.cos(train.angle)) >= 0.5;
    for (let step = -reach; step <= reach; step++) {
      const x = headingAlongX ? tx + step : tx;
      const y = headingAlongX ? ty : ty + step;
      if (x < 0 || y < 0 || x >= state.size || y >= state.size) continue;
      const index = tileIndex(x, y, state.size);
      if (closed.has(index)) continue;
      if (tileType[index] !== TileType.Road) continue;
      const mask = rail[index];
      if ((mask & LINE_PRESENT) === 0) continue;
      const bits = mask & (DIR_N | DIR_E | DIR_S | DIR_W);
      const alongX = (bits & (DIR_E | DIR_W)) !== 0 && (bits & (DIR_N | DIR_S)) === 0;
      const alongY = (bits & (DIR_N | DIR_S)) !== 0 && (bits & (DIR_E | DIR_W)) === 0;
      if (!alongX && !alongY) continue;
      if (crossingIsClosed([train], x + 0.5, y + 0.5, alongX)) closed.add(index);
    }
  }
  return closed;
}
