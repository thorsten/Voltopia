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
 * the intro seen when it finishes or is closed.
 */
export function IntroCoach({
  stats,
  introId,
  onFinished,
}: {
  stats: GlobalStats;
  introId: IntroId;
  onFinished: () => void;
}) {
  const intro = introById(introId);
  const [stepIndex, setStepIndex] = useState(() => firstOpenStep(intro, stats));
  const step = intro.steps[stepIndex];

  useEffect(() => {
    if (step?.isComplete?.(stats)) {
      setStepIndex((index) => index + 1);
    }
  }, [stats, step]);

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
      showNext={introStepShowsNext(step)}
      nextLabel={isLast ? 'intro.done' : 'tutorial.next'}
      nextTestId="intro-next"
      onNext={() => (isLast ? finish() : setStepIndex((i) => i + 1))}
      secondaryLabel="intro.close"
      secondaryTestId="intro-close"
      onSecondary={finish}
    />
  );
}
