import { BALANCE } from '../../../shared/constants.ts';
import { PlantType, Zone } from '../../../shared/types.ts';
import {
  stampBuildings,
  stampLines,
  stampPlant,
  stampRoads,
  stampZone,
  withFreeBuild,
} from '../stamp.ts';
import type { ScenarioDef } from '../types.ts';
import { rect, row } from './layout.ts';

const cfg = BALANCE.scenarios.island;

/**
 * Island without an import link: a small town with one solar farm and
 * no way to import. Grow it to the target population and get it through
 * the closing winter with few deficit ticks.
 */
export const island: ScenarioDef = {
  id: 'island',
  seed: cfg.seed,
  size: cfg.size,
  startingMoney: cfg.startingMoney,
  disasterScale: 0,
  rules: { importCapacityFactor: 0, startSeason: 'spring' },
  deadlineDays: cfg.deadlineDays,
  win: [
    { kind: 'metric', metric: 'population', op: '>=', value: cfg.population },
    {
      kind: 'metric',
      metric: 'deficitTicks',
      op: '<=',
      value: cfg.maxDeficitTicks,
      windowDays: cfg.deficitWindowDays,
    },
  ],
  fail: [{ kind: 'metric', metric: 'money', op: '<=', value: BALANCE.scenarios.bankruptMoney }],
  setup(state) {
    const s = state.size;
    withFreeBuild(state, () => {
      stampRoads(state, row(s, 20, 14, 30));
      stampRoads(state, row(s, 24, 14, 30));
      stampZone(state, rect(s, 14, 19, 30, 19), Zone.Residential);
      stampZone(state, rect(s, 14, 21, 30, 21), Zone.Residential);
      stampZone(state, rect(s, 14, 23, 22, 23), Zone.Commercial);
      stampZone(state, rect(s, 23, 23, 30, 23), Zone.Retail);
      stampBuildings(state, rect(s, 14, 19, 30, 19), 1);
      stampBuildings(state, rect(s, 16, 21, 28, 21), 1);
      stampBuildings(state, rect(s, 15, 23, 20, 23), 1);
      stampBuildings(state, rect(s, 24, 23, 27, 23), 1);
      stampPlant(state, rect(s, 32, 20, 32, 20)[0], PlantType.SolarFarm);
      // One line along the main road wires every block row to the farm.
      stampLines(state, row(s, 20, 14, 31));
    });
  },
};
