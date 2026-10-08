import { describe, expect, it } from 'vitest';
import { TICKS_PER_DAY } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { PlantType, SupplyStatus, Zone } from '../shared/types.ts';
import { SimEngine } from './engine.ts';
import { storedByKind } from './storage.ts';

const SIZE = 32;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);

/**
 * Plays a small city for several in-game days: roads, zones, solar +
 * wind + battery + biogas. Verifies the systems work together.
 */
describe('full gameplay integration', () => {
  it('grows a powered city and balances energy over days', () => {
    const engine = new SimEngine(1234, SIZE);
    const state = engine.state;

    // Main street with residential north, commercial/retail south.
    const road = Array.from({ length: 16 }, (_, x) => at(x + 4, 10));
    engine.applyCommand({ type: 'buildRoad', tiles: road });
    const residential: number[] = [];
    const commercial: number[] = [];
    const retail: number[] = [];
    for (let x = 4; x < 20; x++) {
      residential.push(at(x, 9), at(x, 8));
      if (x < 12) commercial.push(at(x, 11));
      else retail.push(at(x, 11));
    }
    engine.applyCommand({ type: 'paintZone', tiles: residential, zone: Zone.Residential });
    engine.applyCommand({ type: 'paintZone', tiles: commercial, zone: Zone.Commercial });
    engine.applyCommand({ type: 'paintZone', tiles: retail, zone: Zone.Retail });

    // Renewable park nearby: everything within the supply radius.
    engine.applyCommand({ type: 'placePlant', tile: at(10, 13), plant: PlantType.SolarFarm });
    engine.applyCommand({ type: 'placePlant', tile: at(12, 13), plant: PlantType.SolarFarm });
    engine.applyCommand({ type: 'placePlant', tile: at(14, 13), plant: PlantType.WindTurbine });
    engine.applyCommand({ type: 'placePlant', tile: at(16, 13), plant: PlantType.Battery });
    engine.applyCommand({ type: 'placePlant', tile: at(18, 13), plant: PlantType.BiogasPlant });

    // Grid: from the solar farm west along row 12, up column 3, then along
    // the main street. The street row energises the zones on both sides.
    const trunk = [
      ...Array.from({ length: 8 }, (_, i) => at(10 - i, 12)), // (10,12) … (3,12)
      at(3, 11),
      at(3, 10),
      ...Array.from({ length: 16 }, (_, x) => at(x + 4, 10)), // main street
    ];
    engine.applyCommand({ type: 'buildPowerLine', tiles: trunk });

    let sawStorageCharge = false;
    let sawSolar = false;
    for (let i = 0; i < TICKS_PER_DAY * 4; i++) {
      engine.tick();
      if (storedByKind(state, PlantType.Battery) > 1) sawStorageCharge = true;
      if (state.lastEnergy.solar > 0) sawSolar = true;
    }

    // The city grew a real population and jobs.
    const stats = engine.tick();
    if (stats.type !== 'tick') throw new Error('expected tick event');
    expect(stats.stats.population).toBeGreaterThan(50);
    expect(stats.stats.jobs).toBeGreaterThan(20);

    // Energy systems were exercised.
    expect(sawSolar).toBe(true);
    expect(sawStorageCharge).toBe(true);
    expect(stats.stats.energy.history.length).toBeGreaterThan(10);

    // Buildings are connected and (mostly) supplied.
    let supplied = 0;
    let buildings = 0;
    for (let i = 0; i < SIZE * SIZE; i++) {
      if (state.layers.density[i] > 0) {
        buildings++;
        if (state.layers.supplied[i] === SupplyStatus.Supplied) supplied++;
      }
    }
    expect(buildings).toBeGreaterThan(10);
    expect(supplied / buildings).toBeGreaterThan(0.6);

    // Happiness stays livable in a powered city.
    expect(stats.stats.happiness).toBeGreaterThan(0.5);
  });
});
