import { useEffect, useState } from 'react';
import type { GlobalStats } from '../shared/types.ts';
import { CoachCard } from './CoachCard.tsx';
import type { CoachStep } from './coachSteps.ts';

const TUTORIAL_DONE_KEY = 'voltopia.tutorialDone';

export function isTutorialDone(): boolean {
  try {
    return localStorage.getItem(TUTORIAL_DONE_KEY) === '1';
  } catch {
    return true;
  }
}

/** Forget that the tutorial was finished, so it shows again. */
export function resetTutorial(): void {
  try {
    localStorage.removeItem(TUTORIAL_DONE_KEY);
  } catch {
    // best effort only
  }
}

function markTutorialDone(): void {
  try {
    localStorage.setItem(TUTORIAL_DONE_KEY, '1');
  } catch {
    // best effort only
  }
}

const STEPS: CoachStep[] = [
  { id: 'welcome', title: 'tutorial.welcome.title', body: 'tutorial.welcome.body' },
  {
    id: 'road',
    title: 'tutorial.road.title',
    body: 'tutorial.road.body',
    isComplete: (stats) => stats.counts.roadTiles > 0,
  },
  {
    id: 'zone',
    title: 'tutorial.zone.title',
    body: 'tutorial.zone.body',
    isComplete: (stats) => stats.counts.zonedTiles > 0,
  },
  {
    id: 'power',
    title: 'tutorial.power.title',
    body: 'tutorial.power.body',
    isComplete: (stats) => stats.counts.plantTiles > 0,
  },
  {
    id: 'grid',
    title: 'tutorial.grid.title',
    body: 'tutorial.grid.body',
    isComplete: (stats) => stats.counts.powerLineTiles > 0,
  },
  {
    id: 'substation',
    title: 'tutorial.substation.title',
    body: 'tutorial.substation.body',
    isComplete: (stats) => stats.islands.some((i) => i.substations > 0),
  },
  {
    id: 'rail',
    title: 'tutorial.rail.title',
    body: 'tutorial.rail.body',
    isComplete: (stats) => stats.rail.stationsServed >= 2,
  },
  {
    id: 'growth',
    title: 'tutorial.growth.title',
    body: 'tutorial.growth.body',
    isComplete: (stats) => stats.counts.buildingTiles > 0,
  },
  { id: 'night', title: 'tutorial.night.title', body: 'tutorial.night.body' },
];

/**
 * A guided first city: each step waits for the described action to
 * actually happen in the simulation before advancing.
 */
export function Tutorial({ stats, onFinished }: { stats: GlobalStats; onFinished: () => void }) {
  const [stepIndex, setStepIndex] = useState(0);
  const step = STEPS[stepIndex];

  useEffect(() => {
    if (step?.isComplete?.(stats)) {
      setStepIndex((index) => index + 1);
    }
  }, [stats, step]);

  const finish = (): void => {
    markTutorialDone();
    onFinished();
  };

  useEffect(() => {
    if (!step) finish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  if (!step) return null;

  const isLast = stepIndex === STEPS.length - 1;

  return (
    <CoachCard
      testId="tutorial"
      stepIndex={stepIndex}
      stepCount={STEPS.length}
      title={step.title}
      body={step.body}
      showNext={!step.isComplete}
      nextLabel={isLast ? 'tutorial.done' : 'tutorial.next'}
      nextTestId="tutorial-next"
      onNext={() => (isLast ? finish() : setStepIndex((i) => i + 1))}
      secondaryLabel="tutorial.skip"
      secondaryTestId="tutorial-skip"
      onSecondary={finish}
    />
  );
}
