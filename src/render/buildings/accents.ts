import type { SupplyStatus } from '../../shared/types.ts';
import type { BuildingPart, PartRole } from './recipes.ts';

/**
 * Puff-emitting anchors (chimney or vent) a single tile can carry: the
 * market hall's two vent stacks; the chimney house has one. Sizes
 * `BuildingFxMesh`'s puff buffer and is pinned on the recipe side by
 * recipes.test.ts so a future recipe cannot silently outgrow it.
 */
export const MAX_PUFF_ANCHORS_PER_TILE = 2;

/** World-space top centre of a role-tagged part. */
export interface AccentAnchor {
  role: PartRole;
  x: number;
  y: number;
  z: number;
}

/** The per-tile state the effects depend on. */
export interface AccentState {
  /** On the district-heating network this tick. */
  heated: boolean;
  supplied: SupplyStatus;
  /** damage > 0: the building is out of service. */
  damaged: boolean;
}

/**
 * Receiver of a building's effect anchors. `BuildingsMesh` talks to it
 * instead of to the effects layer directly, so the two stay separately
 * testable.
 */
export interface AccentSink {
  /** Create or replace the anchors (and state) of the building on `index`. */
  set(index: number, anchors: readonly AccentAnchor[], state: AccentState): void;
  /** Only the state changed (supply, heat or damage flip). */
  setState(index: number, state: AccentState): void;
  remove(index: number): void;
}

/**
 * Anchors of every role-tagged part: tile centre plus the part's offset,
 * elevation lift plus the part's top. Tagged parts never carry a `turn`
 * or `tilt` (guarded by recipes.test.ts), so no rotation applies.
 */
export function accentAnchors(
  parts: readonly BuildingPart[],
  cx: number,
  cz: number,
  lift: number,
): AccentAnchor[] {
  const anchors: AccentAnchor[] = [];
  for (const p of parts) {
    if (p.role === undefined) continue;
    anchors.push({ role: p.role, x: cx + p.ox, y: lift + p.oy + p.sy, z: cz + p.oz });
  }
  return anchors;
}
