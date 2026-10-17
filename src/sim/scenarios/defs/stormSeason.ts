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
import { column, rect, row } from './layout.ts';

const cfg = BALANCE.scenarios.stormSeason;

/**
 * Storm season with a fragile wind fleet: a town hanging on one long
 * line to a wind park, harsh disasters, autumn start. Earn stormProof
 * and keep the last month nearly deficit-free; a town half dark is lost.
 */
export const stormSeason: ScenarioDef = {
  id: 'stormSeason',
  seed: cfg.seed,
  size: cfg.size,
  startingMoney: cfg.startingMoney,
  disasterScale: cfg.disasterScale,
  rules: { importCapacityFactor: 1, startSeason: 'autumn' },
  deadlineDays: cfg.deadlineDays,
  win: [
    { kind: 'goal', id: 'stormProof' },
    {
      kind: 'metric',
      metric: 'deficitTicks',
      op: '<=',
      value: cfg.maxDeficitTicks,
      windowDays: cfg.deficitWindowDays,
    },
  ],
  fail: [
    { kind: 'metric', metric: 'money', op: '<=', value: BALANCE.scenarios.bankruptMoney },
    { kind: 'metric', metric: 'suppliedShare', op: '<=', value: cfg.minSuppliedShare },
  ],
  setup(state) {
    const s = state.size;
    // Town north of the southern hills, wind park far up the same column.
    withFreeBuild(state, () => {
      stampRoads(state, row(s, 23, 10, 26));
      stampRoads(state, row(s, 27, 10, 26));
      stampZone(state, rect(s, 10, 22, 26, 22), Zone.Residential);
      stampZone(state, rect(s, 10, 24, 26, 24), Zone.Residential);
      stampZone(state, rect(s, 10, 26, 18, 26), Zone.Commercial);
      stampZone(state, rect(s, 19, 26, 26, 26), Zone.Retail);
      stampBuildings(state, rect(s, 10, 22, 26, 22), 2);
      stampBuildings(state, rect(s, 10, 24, 26, 24), 1);
      stampBuildings(state, rect(s, 10, 26, 26, 26), 1);
      for (const tile of rect(s, 10, 3, 18, 3)) stampPlant(state, tile, PlantType.WindTurbine);
      stampLines(state, column(s, 14, 4, 21));
    });
  },
};
