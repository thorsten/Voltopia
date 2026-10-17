import { BALANCE } from '../../../shared/constants.ts';
import { PlantType, Zone } from '../../../shared/types.ts';
import { stampBuildings, stampPlant, stampRoads, stampZone, withFreeBuild } from '../stamp.ts';
import type { ScenarioDef } from '../types.ts';
import { column, rect, row } from './layout.ts';

const cfg = BALANCE.scenarios.dunkelflaute;

/**
 * Survive a winter Dunkelflaute: a solar-only town ten days before
 * winter. Keep the deficit ticks under the limit for the whole run and do
 * not lose residents.
 */
export const dunkelflaute: ScenarioDef = {
  id: 'dunkelflaute',
  seed: cfg.seed,
  size: cfg.size,
  startingMoney: cfg.startingMoney,
  disasterScale: 0,
  rules: { importCapacityFactor: 1, startSeason: 'autumn' },
  deadlineDays: cfg.deadlineDays,
  win: [
    { kind: 'metric', metric: 'deficitTicks', op: '<=', value: cfg.maxDeficitTicks },
    { kind: 'metric', metric: 'population', op: '>=', value: cfg.population },
  ],
  fail: [{ kind: 'metric', metric: 'money', op: '<=', value: BALANCE.scenarios.bankruptMoney }],
  setup(state) {
    const s = state.size;
    // East of the river; the north-south road at x = 31 splits every block row.
    const west = (y: number) => rect(s, 20, y, 30, y);
    const east = (y: number) => rect(s, 32, y, 42, y);
    withFreeBuild(state, () => {
      stampRoads(state, row(s, 18, 20, 42));
      stampRoads(state, row(s, 22, 20, 42));
      stampRoads(state, row(s, 26, 20, 42));
      stampRoads(state, column(s, 31, 18, 26));
      stampZone(state, rect(s, 20, 17, 42, 17), Zone.Residential);
      stampZone(state, [...west(19), ...east(19)], Zone.Residential);
      stampZone(state, west(21), Zone.Commercial);
      stampZone(state, east(21), Zone.Retail);
      stampZone(state, [...west(23), ...east(23)], Zone.Residential);
      stampZone(state, [...west(25), ...east(25)], Zone.Commercial);
      stampBuildings(state, rect(s, 20, 17, 42, 17), 2);
      stampBuildings(state, west(19), 2);
      stampBuildings(state, east(19), 1);
      stampBuildings(state, west(21), 1);
      stampBuildings(state, east(21), 1);
      stampBuildings(state, [...west(23), ...east(23)], 1);
      stampBuildings(state, [...rect(s, 22, 25, 30, 25), ...rect(s, 32, 25, 38, 25)], 1);
      for (const tile of rect(s, 45, 18, 46, 24)) stampPlant(state, tile, PlantType.SolarFarm);
      stampPlant(state, rect(s, 45, 26, 45, 26)[0], PlantType.Battery);
    });
  },
};
