import { POLICY_IDS, SCENARIO_IDS, type SaveGame } from '../shared/types.ts';
import { takeCredit } from '../sim/finance.ts';
import { buildRoads } from '../sim/roads.ts';
import '../sim/scenarios/defs/index.ts';
import { scenarioDef } from '../sim/scenarios/registry.ts';
import { startScenario } from '../sim/scenarios/start.ts';
import { createSimState, serializeState } from '../sim/state.ts';

/** A save with every field and every layer set. */
export type FullSave = Required<SaveGame> & { layers: Required<SaveGame['layers']> };

/**
 * A save game in which every `SaveGame` field carries a non-default value
 * and every layer is present. The `Required<…>` return type turns a new
 * `SaveGame` field into a type error here until it gets a value, so the
 * round-trip tests cover it automatically.
 */
export function fullSave(): FullSave {
  const def = scenarioDef(SCENARIO_IDS[0]);
  const state = createSimState(def.seed, def.size);
  startScenario(state, def);
  buildRoads(state, [1, 2, 3]);
  state.policies[POLICY_IDS[0]] = true;
  const credit = takeCredit(state, 'loan', 5_000);
  if (credit.rejected) throw new Error(`fixture credit rejected: ${credit.rejected}`);
  const base = serializeState(state);
  const layers = base.layers as FullSave['layers'];
  for (const name of Object.keys(layers) as (keyof FullSave['layers'])[]) {
    // Distinct, non-zero bytes per layer so a swapped layer cannot pass.
    const bytes = new Uint8Array(layers[name]);
    bytes[0] = (bytes[0] + 1 + Object.keys(layers).indexOf(name)) & 0xff;
  }
  return {
    ...base,
    policies: base.policies!,
    finance: base.finance!,
    rules: base.rules!,
    scenario: {
      ...base.scenario!,
      endedTick: 40,
      samples: { ...base.scenario!.samples, population: [10, 20] },
    },
    smartCharging: true,
    storedEnergy: 3,
    stored: [1, 2.5],
    goals: ['firstPower'],
    lifetime: [
      {
        day: 1,
        population: 10,
        jobs: 4,
        happiness: 0.5,
        avgGeneration: 2,
        avgConsumption: 1.5,
        money: 1234,
        temperature: 12,
        heating: 0.25,
        cooling: 0.125,
      },
    ],
    riverFlow: 0.4,
    pumpedStorageEnergy: 4,
    hydrogenEnergy: 5,
    marketTrading: true,
    seasonOriginDay: 2,
    sandbox: true,
    snowpack: 0.3,
    insulation: true,
    winterTicks: 11,
    summerTicks: 12,
    freeFlowTicks: 13,
    wellStockedTicks: 14,
    transitTicks: 15,
    railTicks: 16,
    activeTicks: 17,
    trains: [
      {
        id: 1,
        kind: 0,
        yard: 3,
        yardTrack: 0,
        x: 1.5,
        y: 2.5,
        angle: 0.5,
        phase: 0,
        stops: [3, 7],
        pickup: 2,
        path: [3, 4, 5],
        pathIndex: 1,
        dwellTicks: 4,
      },
    ],
    heatStored: 6,
    warmWinterTicks: 18,
    districtDeficitTicks: 19,
    flexTicks: 20,
    smartMeters: { active: true, metered: 0.5 },
    flexBacklog: 7,
    demandResponse: { active: true, callBudget: 8 },
    islandPools: [[1, 2, 3]],
    shedTotal: 21,
    disasterScale: 0.5,
    disasters: {
      nextId: 2,
      cooldownTicks: 30,
      events: [
        {
          id: 1,
          kind: 0,
          severity: 1,
          startTick: 5,
          endTick: 50,
          origin: 17,
          tiles: [17, 18],
          intensity: [1, 0.5],
          active: true,
        },
      ],
    },
    layers,
  };
}
