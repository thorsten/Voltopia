import { BALANCE } from '../../../shared/constants.ts';
import { Zone } from '../../../shared/types.ts';
import { stampBuildings, stampRoads, stampZone, withFreeBuild } from '../stamp.ts';
import type { ScenarioDef } from '../types.ts';
import { column, rect, row } from './layout.ts';

const cfg = BALANCE.scenarios.oldTown;

/**
 * Electrify an old town: a dense, unpowered town with no plant and no
 * line. Supply nearly every building from mostly renewable sources.
 */
export const oldTown: ScenarioDef = {
  id: 'oldTown',
  seed: cfg.seed,
  size: cfg.size,
  startingMoney: cfg.startingMoney,
  disasterScale: 0,
  rules: { importCapacityFactor: 1, startSeason: 'spring' },
  deadlineDays: cfg.deadlineDays,
  win: [
    { kind: 'metric', metric: 'suppliedShare', op: '>=', value: cfg.suppliedShare },
    { kind: 'metric', metric: 'renewableShare', op: '>=', value: cfg.renewableShare },
  ],
  fail: [{ kind: 'metric', metric: 'cash', op: '<=', value: BALANCE.scenarios.bankruptMoney }],
  setup(state) {
    const s = state.size;
    // South-east of the river. Block rows between the outer roads, minus
    // the middle road at x = 31.
    const blocks = (y: number) => rect(s, 23, y, 39, y).filter((t) => t % s !== 31);
    withFreeBuild(state, () => {
      for (const y of [32, 36, 40, 44]) stampRoads(state, row(s, y, 22, 40));
      for (const x of [22, 31, 40]) stampRoads(state, column(s, x, 32, 44));
      for (const y of [33, 35, 41, 43]) stampZone(state, blocks(y), Zone.Residential);
      for (const y of [37, 39]) stampZone(state, rect(s, 23, y, 30, y), Zone.Commercial);
      for (const y of [37, 39]) stampZone(state, rect(s, 32, y, 39, y), Zone.Retail);
      for (const y of [33, 35, 41, 43]) {
        stampBuildings(state, rect(s, 23, y, 30, y), 3);
        stampBuildings(state, rect(s, 32, y, 39, y), 2);
      }
      for (const y of [37, 39]) stampBuildings(state, blocks(y), 2);
    });
  },
};
