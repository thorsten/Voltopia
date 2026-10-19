import { BALANCE, TICKS_PER_DAY } from '../../shared/constants.ts';
import { SupplyStatus } from '../../shared/types.ts';
import { totalDebt } from '../finance.ts';
import { countPopulationAndJobs, type SimState } from '../state.ts';
import { evaluateCondition } from './conditions.ts';
import type { ScenarioDef, ScenarioMetric, ScenarioRun } from './types.ts';

/** Completed scenario days at `tick`. */
export function scenarioDay(run: ScenarioRun, tick: number): number {
  return Math.floor((tick - run.startTick) / TICKS_PER_DAY);
}

function suppliedShare(state: SimState): number {
  const { density, supplied } = state.layers;
  let buildings = 0;
  let ok = 0;
  for (let i = 0; i < density.length; i++) {
    if (density[i] === 0) continue;
    buildings++;
    if (supplied[i] === SupplyStatus.Supplied) ok++;
  }
  return buildings === 0 ? 1 : ok / buildings;
}

function push(run: ScenarioRun, metric: ScenarioMetric, value: number): void {
  const samples = run.samples[metric];
  samples.push(value);
  if (samples.length > BALANCE.scenarios.maxSamples) samples.shift();
}

/**
 * Accumulate the day's counters every tick; at the day rollover store
 * the samples, then check fail conditions and, at the deadline, the win
 * conditions. Fail beats win on the same day. Nothing runs once the
 * scenario has ended.
 */
export function scenarioStep(state: SimState, def: ScenarioDef): void {
  const run = state.scenario;
  if (!run || run.status !== 'running') return;
  const e = state.lastEnergy;
  const t = run.today;
  if (e.deficit > 0) t.deficitTicks++;
  t.importedEnergy += e.gridImport;
  const renewable = e.solar + e.wind + e.rooftop + e.hydro + e.tidal + e.geothermal + e.fuelCell;
  t.renewable += renewable;
  t.generation += renewable + e.biogas + e.gridImport;
  t.suppliedShareSum += suppliedShare(state);
  t.ticks++;

  if ((state.tick - run.startTick) % TICKS_PER_DAY !== 0) return;

  push(run, 'population', countPopulationAndJobs(state).population);
  // Net worth: borrowed cash is owed back, so a loan cannot win a money goal.
  push(run, 'money', state.money - totalDebt(state));
  push(run, 'deficitTicks', t.deficitTicks);
  push(run, 'importedEnergy', t.importedEnergy);
  push(run, 'renewableShare', t.generation === 0 ? 1 : t.renewable / t.generation);
  push(run, 'suppliedShare', t.ticks === 0 ? 1 : t.suppliedShareSum / t.ticks);
  run.today = {
    deficitTicks: 0,
    importedEnergy: 0,
    renewable: 0,
    generation: 0,
    suppliedShareSum: 0,
    ticks: 0,
  };

  if (def.fail.some((c) => evaluateCondition(state, run, c).met)) {
    run.status = 'failed';
    run.endedTick = state.tick;
    return;
  }
  if (scenarioDay(run, state.tick) >= def.deadlineDays) {
    run.status = def.win.every((c) => evaluateCondition(state, run, c).met) ? 'won' : 'failed';
    run.endedTick = state.tick;
  }
}
