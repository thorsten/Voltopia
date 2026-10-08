import { describe, expect, it } from 'vitest';
import { BALANCE } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { closedCrossings } from './crossings.ts';
import { buildRail } from './rail.ts';
import { buildRoads } from './roads.ts';
import { createSimState, TrainKind, TrainPhase, type SimState, type Train } from './state.ts';

const SIZE = 16;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);

/** A north-south road crossed by an east-west track at (5, 8). */
function crossingTown(): SimState {
  const state = createSimState(1, SIZE);
  state.money = 1e9;
  buildRoads(
    state,
    Array.from({ length: 12 }, (_, i) => at(5, i + 2)),
  );
  buildRail(
    state,
    Array.from({ length: 12 }, (_, i) => at(i + 2, 8)),
  );
  return state;
}

function runningTrain(state: SimState, x: number, y: number, angle = 0): void {
  const train: Train = {
    id: 1,
    kind: TrainKind.Passenger,
    yard: at(2, 8),
    yardTrack: at(2, 8),
    x,
    y,
    angle,
    phase: TrainPhase.Running,
    stops: [],
    pickup: -1,
    path: [],
    pathIndex: 0,
    dwellTicks: 0,
    stalled: false,
    trail: [],
  };
  state.trains.push(train);
}

describe('closedCrossings', () => {
  it('closes the crossing a train is approaching', () => {
    const state = crossingTown();
    runningTrain(state, 5.5 + BALANCE.rail.crossingApproachTiles - 0.5, 8.5);
    expect([...closedCrossings(state)]).toEqual([at(5, 8)]);
  });

  it('leaves it open while the train is still far off', () => {
    const state = crossingTown();
    runningTrain(state, 5.5 + BALANCE.rail.crossingApproachTiles + 1, 8.5);
    expect(closedCrossings(state).size).toBe(0);
  });

  it('closes nothing without a running train', () => {
    const state = crossingTown();
    expect(closedCrossings(state).size).toBe(0);
    runningTrain(state, 6, 8.5);
    state.trains[0].phase = TrainPhase.Parked;
    expect(closedCrossings(state).size).toBe(0);
  });

  it('leaves a junction crossing open: it carries no barriers', () => {
    const state = crossingTown();
    // A spur turning north out of the crossing tile makes it a junction.
    buildRail(state, [at(5, 7)]);
    runningTrain(state, 6, 8.5);
    expect(closedCrossings(state).size).toBe(0);
  });

  it('ignores track that does not cross a road', () => {
    const state = createSimState(1, SIZE);
    state.money = 1e9;
    buildRail(
      state,
      Array.from({ length: 12 }, (_, i) => at(i + 2, 8)),
    );
    runningTrain(state, 6, 8.5);
    expect(closedCrossings(state).size).toBe(0);
  });
});
