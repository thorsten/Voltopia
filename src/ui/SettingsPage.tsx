import { Modal } from './Modal.tsx';
import { useI18n } from './i18n.tsx';
import type { AppSettings } from './settings.ts';

export function SettingsPage({
  settings,
  onSettingsChange,
  onClose,
}: {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const update = (partial: Partial<AppSettings>): void => {
    onSettingsChange({ ...settings, ...partial });
  };

  return (
    <Modal title={t('settings.title')} onClose={onClose} testId="settings-page">
      <section>
        <h3>{t('settings.sound')}</h3>
        <label className="settings-row">
          <input
            type="checkbox"
            data-testid="setting-sound"
            checked={settings.soundEnabled}
            onChange={(e) => update({ soundEnabled: e.target.checked })}
          />
          <span>{t('settings.soundEnabled')}</span>
        </label>
        <label className="settings-row">
          <span>{t('settings.volume')}</span>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(settings.soundVolume * 100)}
            onChange={(e) => update({ soundVolume: Number(e.target.value) / 100 })}
          />
        </label>
      </section>
      <section>
        <h3>{t('settings.gameplay')}</h3>
        <label className="settings-row">
          <input
            type="checkbox"
            data-testid="setting-intros"
            checked={settings.introsEnabled}
            onChange={(e) => update({ introsEnabled: e.target.checked })}
          />
          <span>{t('settings.introsEnabled')}</span>
        </label>
      </section>
      <section>
        <h3>{t('settings.graphics')}</h3>
        <label className="settings-row">
          <input
            type="checkbox"
            data-testid="setting-shadows"
            checked={settings.shadows}
            onChange={(e) => update({ shadows: e.target.checked })}
          />
          <span>{t('settings.shadows')}</span>
        </label>
        <label className="settings-row" title={t('settings.ambientOcclusion.hint')}>
          <input
            type="checkbox"
            data-testid="setting-ambient-occlusion"
            checked={settings.ambientOcclusion}
            onChange={(e) => update({ ambientOcclusion: e.target.checked })}
          />
          <span>{t('settings.ambientOcclusion')}</span>
        </label>
        <label className="settings-row">
          <input
            type="checkbox"
            data-testid="setting-reduced-motion"
            checked={settings.reducedMotion}
            onChange={(e) => update({ reducedMotion: e.target.checked })}
          />
          <span>{t('settings.reducedMotion')}</span>
        </label>
        <label className="settings-row">
          <input
            type="checkbox"
            data-testid="setting-diagnostics"
            checked={settings.diagnostics}
            onChange={(e) => update({ diagnostics: e.target.checked })}
          />
          <span>{t('settings.diagnostics')}</span>
        </label>
        <label className="settings-row">
          <span>{t('settings.theme')}</span>
          <select
            data-testid="setting-theme"
            value={settings.theme}
            onChange={(e) => update({ theme: e.target.value === 'light' ? 'light' : 'dark' })}
          >
            <option value="dark">{t('settings.theme.dark')}</option>
            <option value="light">{t('settings.theme.light')}</option>
          </select>
        </label>
      </section>
    </Modal>
  );
}
