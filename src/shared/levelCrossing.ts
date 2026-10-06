/**
 * The one rule for when a level crossing is closed, read by both sides:
 * the simulation stops road traffic with it (sim/crossings.ts) and the
 * renderer lowers the barriers with it (render/railMesh.ts), so the bar
 * a player sees and the car that waits never disagree.
 */
import { BALANCE } from './constants.ts';

/** A train's position in world (tile) coordinates. */
export interface CrossingTrain {
  x: number;
  /** Grid row — the renderer's z axis. */
  y: number;
}

/**
 * Is a train close enough to the crossing at (cx, cy) — tile centres —
 * to close it? `alongX` tells which way the track runs there: a train
 * must be within the approach distance along the track and beside its
 * centre line, so a train on another line nearby is ignored.
 */
export function crossingIsClosed(
  trains: readonly CrossingTrain[],
  cx: number,
  cy: number,
  alongX: boolean,
): boolean {
  const { crossingApproachTiles, crossingLateralTiles } = BALANCE.rail;
  for (const train of trains) {
    const along = alongX ? train.x - cx : train.y - cy;
    const lateral = alongX ? train.y - cy : train.x - cx;
    if (Math.abs(along) <= crossingApproachTiles && Math.abs(lateral) <= crossingLateralTiles)
      return true;
  }
  return false;
}
