import { Modal } from './Modal.tsx';
import { useI18n } from './i18n.tsx';

/**
 * Shown once per session when the viewport is phone-sized. A notice, not a
 * hard block: the player can dismiss it and keep playing on a small screen.
 */
export function SmallScreenNotice({ onDismiss }: { onDismiss: () => void }) {
  const { t } = useI18n();
  return (
    <Modal title={t('smallScreen.title')} onClose={onDismiss} testId="small-screen-notice">
      <p>{t('smallScreen.body')}</p>
      <button
        type="button"
        className="primary"
        data-testid="small-screen-continue"
        onClick={onDismiss}
      >
        {t('smallScreen.continue')}
      </button>
    </Modal>
  );
}
