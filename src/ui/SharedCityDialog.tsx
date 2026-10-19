import type { SaveGame } from '../shared/types.ts';
import { dayOfTick, populationOfSave } from '../storage/summary.ts';
import { Modal } from './Modal.tsx';
import { useI18n } from './i18n.tsx';

/**
 * "Load shared city?" — shows what a decoded share link contains and lets
 * the player load it (the current city is kept as a save first) or cancel.
 */
export function SharedCityDialog({
  save,
  busy = false,
  error = null,
  onLoad,
  onCancel,
}: {
  save: SaveGame;
  busy?: boolean;
  error?: string | null;
  onLoad: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  return (
    <Modal title={t('share.dialogTitle')} onClose={onCancel} testId="shared-city-dialog">
      <p className="shared-city-details">
        <span data-testid="shared-city-details">
          {t('share.dialogDetails', {
            map: `${save.size}×${save.size}`,
            day: dayOfTick(save.tick),
            population: populationOfSave(save),
          })}
        </span>
        {save.sandbox === true && (
          <span className="sandbox-badge" data-testid="shared-city-sandbox">
            {t('share.sandbox')}
          </span>
        )}
      </p>
      <p className="saves-hint">{t('share.keepNote')}</p>
      <div className="new-game-actions">
        <button
          type="button"
          className="primary"
          data-testid="shared-city-load"
          disabled={busy}
          onClick={onLoad}
        >
          {t('share.load')}
        </button>
        <button type="button" data-testid="shared-city-cancel" onClick={onCancel}>
          {t('share.cancel')}
        </button>
      </div>
      {error && (
        <p className="saves-message shared-city-error" data-testid="shared-city-error">
          {error}
        </p>
      )}
    </Modal>
  );
}
