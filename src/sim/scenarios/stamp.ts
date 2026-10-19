import { BALANCE } from '../../shared/constants.ts';
import { type PlantType, RoadClass, Terrain, TileType, Zone } from '../../shared/types.ts';
import { placePlant } from '../energy.ts';
import { BUILDING_VARIANTS, hasRoadAccess } from '../growth.ts';
import { buildPowerLines } from '../powerLines.ts';
import { type BuildResult, buildRoads } from '../roads.ts';
import { markDirty, type SimState } from '../state.ts';
import { paintZones } from '../zones.ts';

/** A scenario definition tried to stamp something the map cannot hold. */
export class ScenarioSetupError extends Error {}

function check(result: BuildResult, what: string): void {
  if (result.rejected) throw new ScenarioSetupError(`${what}: ${result.rejected}`);
}

/**
 * Run a setup with unlimited funds and restore the treasury and the
 * grant pot afterwards, so a stamped city costs the player nothing.
 */
export function withFreeBuild(state: SimState, setup: () => void): void {
  const money = state.money;
  const grantUsed = state.finance.grantUsedThisYear;
  state.money = Number.MAX_SAFE_INTEGER / 2;
  try {
    setup();
  } finally {
    state.money = money;
    state.finance.grantUsedThisYear = grantUsed;
  }
}

/** Throw naming the first tile for which `landed` is false. */
function verify(tiles: number[], what: string, landed: (index: number) => boolean): void {
  for (const index of tiles) {
    if (!landed(index)) throw new ScenarioSetupError(`${what} did not land on tile ${index}`);
  }
}

export function stampRoads(state: SimState, tiles: number[], avenue = false): void {
  check(buildRoads(state, tiles, avenue), 'road');
  const { layers } = state;
  verify(
    tiles,
    'road',
    (i) =>
      layers.tileType[i] === TileType.Road && (!avenue || layers.roadClass[i] === RoadClass.Avenue),
  );
}

export function stampZone(state: SimState, tiles: number[], zone: Zone): void {
  check(paintZones(state, tiles, zone), 'zone');
  verify(tiles, 'zone', (i) => state.layers.zone[i] === zone);
}

export function stampPlant(state: SimState, tile: number, plant: PlantType): void {
  check(placePlant(state, tile, plant), `plant ${plant}`);
  const { layers } = state;
  verify(
    [tile],
    `plant ${plant}`,
    (i) => layers.tileType[i] === TileType.Plant && layers.plantType[i] === plant,
  );
}

export function stampLines(state: SimState, tiles: number[]): void {
  check(buildPowerLines(state, tiles), 'power line');
  verify(tiles, 'power line', (i) => state.layers.powerLine[i] !== 0);
}

/**
 * Place grown buildings directly: the tiles must be zoned land with road
 * access. Age is set to the lived-in threshold so the city looks settled.
 */
export function stampBuildings(state: SimState, tiles: number[], density: 1 | 2 | 3): void {
  const { layers } = state;
  for (const index of tiles) {
    if (layers.terrain[index] !== Terrain.Land)
      throw new ScenarioSetupError(`building on water at ${index}`);
    if (layers.zone[index] === Zone.None)
      throw new ScenarioSetupError(`building on unzoned tile ${index}`);
    if (layers.tileType[index] !== TileType.Empty)
      throw new ScenarioSetupError(`building on built tile ${index}`);
    if (!hasRoadAccess(state, index))
      throw new ScenarioSetupError(`building without road at ${index}`);
    layers.density[index] = density;
    layers.variant[index] = state.rng.nextInt(BUILDING_VARIANTS);
    layers.buildingAge[index] = BALANCE.growth.ageStageTicks[0];
    markDirty(state, index);
  }
}
