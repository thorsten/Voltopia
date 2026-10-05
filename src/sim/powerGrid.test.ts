import { describe, expect, it } from 'vitest';
import { BALANCE } from '../shared/constants.ts';
import { chebyshevDistance, LINE_PRESENT, tileIndex } from '../shared/grid.ts';
import { PlantType } from '../shared/types.ts';
import { addDamage } from './disasters.ts';
import { placePlant } from './energy.ts';
import {
  hasLineAttached,
  isIsolatedPlant,
  islandCount,
  islandKey,
  islandOf,
  isSupplySource,
  isTiedToGrid,
  isolatedPlants,
  recomputeGrid,
} from './powerGrid.ts';
import { buildPowerLines } from './powerLines.ts';
import { buildRoads } from './roads.ts';
import { bumpGridVersion, createSimState, TileType, Zone, type SimState } from './state.ts';

const SIZE = 24;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);
const R = BALANCE.energy.lineSupplyRadius;

function makeState(): SimState {
  const state = createSimState(1, SIZE);
  state.money = 1e9;
  return state;
}

describe('isSupplySource', () => {
  it('counts generators and storage, not hubs or parks', () => {
    expect(isSupplySource(PlantType.SolarFarm)).toBe(true);
    expect(isSupplySource(PlantType.Battery)).toBe(true);
    expect(isSupplySource(PlantType.PumpedStorage)).toBe(true);
    expect(isSupplySource(PlantType.TidalPlant)).toBe(true);
    expect(isSupplySource(PlantType.ChargingHub)).toBe(false);
    expect(isSupplySource(PlantType.Park)).toBe(false);
    expect(isSupplySource(PlantType.None)).toBe(false);
  });
});

describe('recomputeGrid', () => {
  it('a supply plant energises its own neighbourhood only', () => {
    const state = makeState();
    placePlant(state, at(10, 10), PlantType.WindTurbine);
    recomputeGrid(state);
    expect(state.layers.energized[at(10 + R, 10 + R)]).toBe(1);
    expect(state.layers.energized[at(10 + R + 1, 10)]).toBe(0);
  });

  it('a geothermal plant is a supply source: it energises its ring and seeds a line', () => {
    // Geothermal is the game's only baseload; it must tie into the grid
    // like every other generator (it was missing from the set once).
    const state = makeState();
    const site = at(10, 10);
    state.layers.tileType[site] = TileType.Plant;
    state.layers.plantType[site] = PlantType.GeothermalPlant;
    bumpGridVersion(state);
    buildPowerLines(state, [at(11, 10), at(12, 10)]);
    recomputeGrid(state);
    expect(state.layers.energized[at(10 + R, 10 + R)]).toBe(1);
    expect(state.layers.energized[at(12 + R, 10)]).toBe(1);
    expect(state.layers.energized[at(12 + R + 1, 10)]).toBe(0);
  });

  it('lines connected to a plant extend the energised area', () => {
    const state = makeState();
    placePlant(state, at(2, 10), PlantType.SolarFarm);
    const line = Array.from({ length: 10 }, (_, i) => at(3 + i, 10)); // x 3..12
    buildPowerLines(state, line);
    recomputeGrid(state);
    expect(state.layers.energized[at(12 + R, 10)]).toBe(1);
    expect(state.layers.energized[at(12 + R + 1, 10)]).toBe(0);
  });

  it('two plants joined by a line share one energised set', () => {
    const state = makeState();
    placePlant(state, at(2, 10), PlantType.SolarFarm); // plant A
    placePlant(state, at(12, 10), PlantType.WindTurbine); // plant B
    buildPowerLines(
      state,
      Array.from({ length: 9 }, (_, i) => at(3 + i, 10)), // x 3..11
    );
    const far = at(8, 12); // beyond either plant's own radius, next to the line
    expect(chebyshevDistance(far, at(2, 10), SIZE)).toBeGreaterThan(R);
    expect(chebyshevDistance(far, at(12, 10), SIZE)).toBeGreaterThan(R);
    recomputeGrid(state);
    expect(state.layers.energized[far]).toBe(1);
    // Plant B only shares the network; removing it changes nothing here.
    state.layers.tileType[at(12, 10)] = 0;
    state.layers.plantType[at(12, 10)] = PlantType.None;
    bumpGridVersion(state);
    recomputeGrid(state);
    expect(state.layers.energized[far]).toBe(1);
  });

  it('a line that touches no supply plant stays dead', () => {
    const state = makeState();
    placePlant(state, at(2, 2), PlantType.SolarFarm);
    buildPowerLines(state, [at(15, 15), at(16, 15), at(17, 15)]);
    recomputeGrid(state);
    expect(state.layers.energized[at(17 + R, 15)]).toBe(0);
  });

  it('charging hubs and parks neither energise nor seed the fill', () => {
    const state = makeState();
    placePlant(state, at(10, 10), PlantType.ChargingHub);
    placePlant(state, at(10, 14), PlantType.Park);
    buildPowerLines(state, [at(11, 10), at(12, 10)]);
    recomputeGrid(state);
    expect(state.layers.energized[at(10, 10)]).toBe(0);
    expect(state.layers.energized[at(12, 10)]).toBe(0);
  });

  it('clips the radius stamp at the map edge', () => {
    const state = makeState();
    placePlant(state, at(0, 0), PlantType.WindTurbine);
    expect(() => recomputeGrid(state)).not.toThrow();
    expect(state.layers.energized[at(R, R)]).toBe(1);
    expect(state.layers.energized[at(R + 1, 0)]).toBe(0);
    expect(state.layers.energized[at(SIZE - 1, SIZE - 1)]).toBe(0);
  });

  it('is a no-op until the grid version changes', () => {
    const state = makeState();
    placePlant(state, at(2, 10), PlantType.SolarFarm);
    recomputeGrid(state);
    expect(state.gridComputedVersion).toBe(state.gridVersion);
    // Poke the layer behind the version's back: nothing happens…
    state.layers.powerLine[at(3, 10)] = LINE_PRESENT;
    recomputeGrid(state);
    expect(state.layers.energized[at(3 + R, 10)]).toBe(0);
    // …until the version is bumped.
    bumpGridVersion(state);
    recomputeGrid(state);
    expect(state.layers.energized[at(3 + R, 10)]).toBe(1);
  });

  it('forgets energised tiles when their plant is gone', () => {
    const state = makeState();
    placePlant(state, at(10, 10), PlantType.WindTurbine);
    recomputeGrid(state);
    expect(state.layers.energized[at(10, 10)]).toBe(1);
    state.layers.tileType[at(10, 10)] = 0;
    state.layers.plantType[at(10, 10)] = PlantType.None;
    bumpGridVersion(state);
    recomputeGrid(state);
    expect(state.layers.energized[at(10, 10)]).toBe(0);
  });
});

describe('isIsolatedPlant', () => {
  /** A supply plant at (10,10) on an otherwise empty map. */
  function lonePlant(): SimState {
    const state = makeState();
    placePlant(state, at(10, 10), PlantType.WindTurbine);
    return state;
  }
  function house(state: SimState, index: number): void {
    state.layers.zone[index] = Zone.Residential;
    state.layers.density[index] = 1;
  }

  it('flags a supply plant with no line and no building in its ring', () => {
    const state = lonePlant();
    expect(hasLineAttached(state, at(10, 10))).toBe(false);
    expect(isIsolatedPlant(state, at(10, 10))).toBe(true);
  });

  it('is not isolated once a building stands inside the ring, up to the ring edge', () => {
    const inside = lonePlant();
    house(inside, at(10 + R, 10 - R)); // Chebyshev distance exactly R
    expect(isIsolatedPlant(inside, at(10, 10))).toBe(false);
    const outside = lonePlant();
    house(outside, at(10 + R + 1, 10));
    expect(isIsolatedPlant(outside, at(10, 10))).toBe(true);
    // Zoning alone does not lift isolation: a tile needs an actual building.
    const zonedOnly = lonePlant();
    zonedOnly.layers.zone[at(11, 10)] = Zone.Residential; // density stays 0
    expect(isIsolatedPlant(zonedOnly, at(10, 10))).toBe(true);
  });

  it('is not isolated once a power line touches one of its sides', () => {
    const state = lonePlant();
    buildPowerLines(state, [at(11, 10), at(12, 10)]);
    expect(hasLineAttached(state, at(10, 10))).toBe(true);
    expect(isIsolatedPlant(state, at(10, 10))).toBe(false);
  });

  it("counts a plant standing in a lined plant's ring as part of its park, up to the ring edge", () => {
    const state = lonePlant();
    buildPowerLines(state, [at(9, 10)]);
    placePlant(state, at(10 + R, 10), PlantType.SolarFarm);
    placePlant(state, at(10 + R + 1, 14), PlantType.SolarFarm);
    expect(hasLineAttached(state, at(10 + R, 10))).toBe(false);
    expect(isTiedToGrid(state, at(10 + R, 10))).toBe(true);
    expect(isIsolatedPlant(state, at(10 + R, 10))).toBe(false);
    // Chebyshev distance R + 1 from every park member: on its own.
    expect(isTiedToGrid(state, at(10 + R + 1, 14))).toBe(false);
    expect(isIsolatedPlant(state, at(10 + R + 1, 14))).toBe(true);
  });

  it('chains through a park: the line may be several plants away', () => {
    const state = lonePlant();
    buildPowerLines(state, [at(9, 10)]);
    placePlant(state, at(10 + R, 10), PlantType.WindTurbine);
    placePlant(state, at(10 + 2 * R, 10), PlantType.WindTurbine);
    expect(isIsolatedPlant(state, at(10 + 2 * R, 10))).toBe(false);
    expect(isTiedToGrid(state, at(10 + 2 * R, 10))).toBe(true);
  });

  it('a park serves when any member has a building in its ring', () => {
    const state = lonePlant();
    placePlant(state, at(10 + R, 10), PlantType.WindTurbine);
    house(state, at(10 + 2 * R, 10)); // in the second plant's ring only
    expect(isIsolatedPlant(state, at(10, 10))).toBe(false);
    expect(isTiedToGrid(state, at(10, 10))).toBe(false); // served, but no line anywhere
    expect(isIsolatedPlant(state, at(10 + R, 10))).toBe(false);
  });

  it('isolatedPlants flags every park at once and agrees with isIsolatedPlant', () => {
    const state = lonePlant();
    buildPowerLines(state, [at(9, 10)]);
    placePlant(state, at(10 + R, 10), PlantType.WindTurbine);
    placePlant(state, at(20, 20), PlantType.SolarFarm);
    placePlant(state, at(2, 20), PlantType.Battery);
    house(state, at(3, 21));
    const flags = isolatedPlants(state);
    for (const [x, y] of [
      [10, 10],
      [10 + R, 10],
      [20, 20],
      [2, 20],
    ]) {
      expect(flags[at(x, y)] === 1).toBe(isIsolatedPlant(state, at(x, y)));
    }
    expect(flags[at(20, 20)]).toBe(1);
    expect(flags[at(2, 20)]).toBe(0);
    expect(flags[at(10 + R, 10)]).toBe(0);
    expect(flags[at(5, 5)]).toBe(0); // empty tile
  });

  it('never flags empty tiles or non-supply plants', () => {
    const state = makeState();
    expect(isIsolatedPlant(state, at(3, 3))).toBe(false);
    buildRoads(state, [at(2, 3)]); // stations need a road 4-neighbour
    expect(placePlant(state, at(3, 3), PlantType.FireStation)).toEqual({});
    expect(isIsolatedPlant(state, at(3, 3))).toBe(false);
  });
});

describe('islands', () => {
  function town(): SimState {
    const state = makeState();
    // Island A: a turbine with a line east; island B: a solar farm far away.
    placePlant(state, at(2, 2), PlantType.WindTurbine);
    buildPowerLines(state, [at(3, 2), at(4, 2), at(5, 2)]);
    placePlant(state, at(20, 20), PlantType.SolarFarm);
    return state;
  }

  it('numbers separate networks ascending by their lowest tile and keys them by it', () => {
    const state = town();
    recomputeGrid(state);
    expect(islandCount(state)).toBe(2);
    expect(islandOf(state, at(2, 2))).toBe(1);
    expect(islandOf(state, at(5, 2))).toBe(1);
    expect(islandOf(state, at(20, 20))).toBe(2);
    expect(islandOf(state, at(12, 12))).toBe(0);
    expect(islandKey(state, 1)).toBe(at(0, 0)); // top-left of the turbine's ring, clipped to the map
    expect(islandKey(state, 2)).toBe(at(20 - R, 20 - R));
  });

  it('energized is exactly island !== 0', () => {
    const state = town();
    recomputeGrid(state);
    const { energized, island } = state.layers;
    for (let i = 0; i < island.length; i++) expect(energized[i] === 1).toBe(island[i] !== 0);
  });

  it('merges islands through a line, through overlapping rings and through a plant in a ring', () => {
    const byLine = town();
    buildPowerLines(
      byLine,
      Array.from({ length: 14 }, (_, i) => at(6 + i, 2)),
    );
    buildPowerLines(
      byLine,
      Array.from({ length: 18 }, (_, i) => at(19, 3 + i)),
    );
    recomputeGrid(byLine);
    expect(islandCount(byLine)).toBe(1);

    const byRing = makeState();
    placePlant(byRing, at(5, 5), PlantType.WindTurbine);
    placePlant(byRing, at(5 + 2 * R, 5), PlantType.SolarFarm); // rings overlap on x = 5 + R
    recomputeGrid(byRing);
    expect(islandCount(byRing)).toBe(1);

    const byPlant = makeState();
    placePlant(byPlant, at(5, 5), PlantType.WindTurbine);
    placePlant(byPlant, at(5 + R, 5), PlantType.Battery); // inside the turbine's ring
    recomputeGrid(byPlant);
    expect(islandCount(byPlant)).toBe(1);
    expect(islandOf(byPlant, at(5 + R, 5))).toBe(1);
  });

  it('a damaged line stretch longer than two rings splits an island and the lower key survives', () => {
    const state = makeState();
    placePlant(state, at(2, 2), PlantType.WindTurbine);
    buildPowerLines(
      state,
      Array.from({ length: 12 }, (_, i) => at(3 + i, 2)),
    );
    placePlant(state, at(15, 2), PlantType.SolarFarm);
    recomputeGrid(state);
    expect(islandCount(state)).toBe(1);
    const keyBefore = islandKey(state, 1);
    // Rings are connections: one dead tile leaves the rings of both ends
    // overlapping, so the gap has to exceed 2 * R tiles (7 here) to split.
    for (let x = 6; x <= 12; x++) addDamage(state, at(x, 2), 10);
    bumpGridVersion(state);
    recomputeGrid(state);
    expect(islandCount(state)).toBe(2);
    expect(islandKey(state, 1)).toBe(keyBefore);
    expect(islandOf(state, at(15, 2))).toBe(2);
  });

  it('a substation seeds the flood and belongs to its island', () => {
    const state = makeState();
    placePlant(state, at(8, 8), PlantType.Substation);
    buildPowerLines(state, [at(9, 8), at(10, 8)]);
    recomputeGrid(state);
    expect(islandCount(state)).toBe(1);
    expect(islandOf(state, at(10 + R, 8))).toBe(1);
  });
});
