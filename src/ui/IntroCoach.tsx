import { useEffect, useState } from 'react';
import type { GlobalStats } from '../shared/types.ts';
import { CoachCard } from './CoachCard.tsx';
import {
  firstOpenStep,
  introById,
  introStepShowsNext,
  markIntroSeen,
  type IntroId,
} from './intros.ts';

/**
 * Coach card for one system intro. Starts at the first step the city has
 * not satisfied yet, advances when a step's check becomes true and marks
 * the intro seen when it finishes or is closed. A manual start from the
 * help page shows every step with a Next button instead.
 */
export function IntroCoach({
  stats,
  introId,
  manual = false,
  onFinished,
}: {
  stats: GlobalStats;
  introId: IntroId;
  /** Started from the help page: walk every step by hand, even satisfied ones. */
  manual?: boolean;
  onFinished: () => void;
}) {
  const intro = introById(introId);
  const [stepIndex, setStepIndex] = useState(() => (manual ? 0 : firstOpenStep(intro, stats)));
  const step = intro.steps[stepIndex];

  useEffect(() => {
    if (!manual && step?.isComplete?.(stats)) {
      setStepIndex((index) => index + 1);
    }
  }, [stats, step, manual]);

  const finish = (): void => {
    markIntroSeen(introId);
    onFinished();
  };

  useEffect(() => {
    if (!step) finish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  if (!step) return null;

  const isLast = stepIndex === intro.steps.length - 1;

  return (
    <CoachCard
      testId="intro"
      data={{ 'data-intro': introId }}
      stepIndex={stepIndex}
      stepCount={intro.steps.length}
      title={step.title}
      body={step.body}
      showNext={manual || introStepShowsNext(step)}
      nextLabel={isLast ? 'intro.done' : 'tutorial.next'}
      nextTestId="intro-next"
      onNext={() => (isLast ? finish() : setStepIndex((i) => i + 1))}
      secondaryLabel="intro.close"
      secondaryTestId="intro-close"
      onSecondary={finish}
    />
  );
}
