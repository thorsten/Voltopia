import { useEffect, useState } from 'react';
import type { GlobalStats } from '../shared/types.ts';
import { useI18n, type TranslationKey } from './i18n.tsx';

const TUTORIAL_DONE_KEY = 'voltopia.tutorialDone';

export function isTutorialDone(): boolean {
  try {
    return localStorage.getItem(TUTORIAL_DONE_KEY) === '1';
  } catch {
    return true;
  }
}

function markTutorialDone(): void {
  try {
    localStorage.setItem(TUTORIAL_DONE_KEY, '1');
  } catch {
    // best effort only
  }
}

interface TutorialStep {
  id: string;
  title: TranslationKey;
  body: TranslationKey;
  /** Auto-advance when this becomes true (undefined = manual button). */
  isComplete?: (stats: GlobalStats) => boolean;
}

const STEPS: TutorialStep[] = [
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
  const { t } = useI18n();
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

  const isManualStep = !step.isComplete;
  const isLast = stepIndex === STEPS.length - 1;

  return (
    <div className="tutorial-card" data-testid="tutorial">
      <div className="tutorial-progress">
        {stepIndex + 1}/{STEPS.length}
      </div>
      <h3>{t(step.title)}</h3>
      <p>{t(step.body)}</p>
      <div className="tutorial-actions">
        {isManualStep && (
          <button
            type="button"
            data-testid="tutorial-next"
            onClick={() => (isLast ? finish() : setStepIndex((i) => i + 1))}
          >
            {isLast ? t('tutorial.done') : t('tutorial.next')}
          </button>
        )}
        {!isManualStep && <span className="tutorial-waiting">{t('tutorial.waiting')}</span>}
        <button type="button" data-testid="tutorial-skip" onClick={finish}>
          {t('tutorial.skip')}
        </button>
      </div>
    </div>
  );
}
