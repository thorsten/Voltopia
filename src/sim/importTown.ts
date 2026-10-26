import { BALANCE, MAP_SIZES } from '../shared/constants.ts';
import { RoadLane, Terrain, type TownLayout, TownRoad, Zone } from '../shared/types.ts';
import { markDirty, type SimState } from './state.ts';
import {
  stampBuildings,
  stampLanes,
  stampRail,
  stampRoads,
  stampZone,
  withFreeBuild,
} from './scenarios/stamp.ts';

/** Building densities a layout may ask for (0 = no building). */
const MAX_DENSITY = BALANCE.growth.populationByDensity.length - 1;
const DENSITIES = [1, 2, 3] as const;
const ZONES = [Zone.Residential, Zone.Commercial, Zone.Retail, Zone.Industrial] as const;

/** Largest allowed value per tile layer; a flag layer holds 0 or 1. */
const LAYER_MAX: Record<Exclude<keyof TownLayout, 'size' | 'name' | 'bbox'>, number> = {
  terrain: Terrain.Sea,
  forest: BALANCE.forest.maxStage,
  road: TownRoad.Avenue,
  pedestrian: 1,
  rail: 1,
  zone: Zone.Industrial,
  density: MAX_DENSITY,
};

function isLayer(value: unknown, tiles: number, max: number): value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== tiles) return false;
  for (let i = 0; i < value.length; i++) if (value[i] > max) return false;
  return true;
}

function isBbox(value: unknown): value is TownLayout['bbox'] {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((edge) => typeof edge === 'number' && Number.isFinite(edge))
  );
}

/**
 * Whether `layout` is a TownLayout the sim can start from: the size a map
 * size the game offers and equal to the requested one, every layer a
 * Uint8Array of size² bytes within its enum range, a name or null, and a
 * finite bbox. The layout crosses the worker boundary and may come from
 * localStorage, so nothing about it is trusted.
 */
export function validateTownLayout(layout: unknown, size: number): layout is TownLayout {
  if (typeof layout !== 'object' || layout === null) return false;
  const candidate = layout as Record<string, unknown>;
  if (candidate.size !== size || !(MAP_SIZES as readonly number[]).includes(size)) return false;
  const tiles = size * size;
  for (const key of Object.keys(LAYER_MAX) as (keyof typeof LAYER_MAX)[]) {
    if (!isLayer(candidate[key], tiles, LAYER_MAX[key])) return false;
  }
  if (candidate.name !== null && typeof candidate.name !== 'string') return false;
  return isBbox(candidate.bbox);
}

/** Tile indices for which `pick` holds. */
function tilesWhere(layout: TownLayout, pick: (index: number) => boolean): number[] {
  const tiles: number[] = [];
  for (let i = 0; i < layout.size * layout.size; i++) if (pick(i)) tiles.push(i);
  return tiles;
}

/**
 * Turn a fresh, flat state into the imported town: terrain and woods are
 * copied, then roads, pedestrian streets, track, zones and settled
 * buildings are stamped at no cost. Elevation stays 0 everywhere. The
 * stamps throw a ScenarioSetupError on anything the sim refuses; the
 * rasteriser's rules are built so that never happens.
 */
export function applyTownLayout(state: SimState, layout: TownLayout): void {
  const { layers } = state;
  layers.terrain.set(layout.terrain);
  layers.forest.set(layout.forest);
  for (let i = 0; i < layout.size * layout.size; i++) markDirty(state, i);
  withFreeBuild(state, () => {
    stampRoads(
      state,
      tilesWhere(layout, (i) => layout.road[i] === TownRoad.Street),
    );
    stampRoads(
      state,
      tilesWhere(layout, (i) => layout.road[i] === TownRoad.Avenue),
      true,
    );
    stampLanes(
      state,
      tilesWhere(layout, (i) => layout.pedestrian[i] !== 0),
      RoadLane.Pedestrian,
    );
    stampRail(
      state,
      tilesWhere(layout, (i) => layout.rail[i] !== 0),
    );
    for (const zone of ZONES) {
      stampZone(
        state,
        tilesWhere(layout, (i) => layout.zone[i] === zone),
        zone,
      );
    }
    for (const density of DENSITIES) {
      stampBuildings(
        state,
        tilesWhere(layout, (i) => layout.density[i] === density),
        density,
      );
    }
  });
  // The stamp is the city's starting point, not something to undo.
  state.undoStack = [];
  state.origin = { source: 'osm', name: layout.name, bbox: [...layout.bbox] };
  state.gridVersion++;
  state.statsDirty = true;
}
