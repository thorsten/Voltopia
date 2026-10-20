import type { TranslationKey } from './i18n.tsx';
import { useI18n } from './i18n.tsx';

export interface CoachCardProps {
  testId: string;
  /** Extra `data-*` attributes on the card (e.g. `data-intro`). */
  data?: Record<`data-${string}`, string>;
  stepIndex: number;
  stepCount: number;
  title: TranslationKey;
  body: TranslationKey;
  /** Show the Next button; otherwise the card shows "waiting". */
  showNext: boolean;
  nextLabel: TranslationKey;
  nextTestId: string;
  onNext: () => void;
  secondaryLabel: TranslationKey;
  secondaryTestId: string;
  onSecondary: () => void;
}

/** The floating coach-mark card shared by the tutorial and the system intros. */
export function CoachCard(props: CoachCardProps) {
  const { t } = useI18n();
  return (
    <div className="tutorial-card" data-testid={props.testId} {...props.data}>
      <div className="tutorial-progress">
        {props.stepIndex + 1}/{props.stepCount}
      </div>
      <h3>{t(props.title)}</h3>
      <p>{t(props.body)}</p>
      <div className="tutorial-actions">
        {props.showNext ? (
          <button
            type="button"
            className="coach-next"
            data-testid={props.nextTestId}
            onClick={props.onNext}
          >
            {t(props.nextLabel)}
          </button>
        ) : (
          <span className="tutorial-waiting">{t('tutorial.waiting')}</span>
        )}
        <button type="button" data-testid={props.secondaryTestId} onClick={props.onSecondary}>
          {t(props.secondaryLabel)}
        </button>
      </div>
    </div>
  );
}
