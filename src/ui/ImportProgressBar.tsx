/**
 * The bar under the Load button while a town is loading: a track with a
 * filled fraction, the phase and the percent, plus the megabytes during
 * the download. The percent comes from the flow state, which keeps it
 * monotonic; the waiting phases get a striped track so the bar moves
 * even while the estimate barely does.
 */
import { useI18n, type TranslationKey } from './i18n.tsx';
import type { ImportProgress } from './importTown.ts';

/** Megabytes as the label shows them (decimal, like download dialogs). */
const BYTES_PER_MB = 1_000_000;
const MB_DECIMALS = 1;

export function ImportProgressBar({
  progress,
  percent,
}: {
  progress: ImportProgress;
  /** The bar's value, 0–100. */
  percent: number;
}) {
  const { t } = useI18n();
  const shown = Math.round(percent);
  const phase = t(`newGame.import.progress.${progress.phase}` as TranslationKey);
  const label =
    progress.phase === 'downloading'
      ? t('newGame.import.progress.labelBytes', {
          phase,
          percent: shown,
          mb: (progress.bytes / BYTES_PER_MB).toFixed(MB_DECIMALS),
        })
      : t('newGame.import.progress.label', { phase, percent: shown });
  return (
    <div
      className={`import-progress import-progress-${progress.phase}`}
      data-testid="import-town-progress"
    >
      <div
        className="import-progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={shown}
        aria-label={label}
      >
        <div className="import-progress-fill" style={{ width: `${shown}%` }} />
      </div>
      <span className="import-progress-label" data-testid="import-town-progress-label">
        {label}
      </span>
    </div>
  );
}
