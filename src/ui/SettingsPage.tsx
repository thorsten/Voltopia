import { useEffect, useState } from 'react';
import type { SaveGame } from '../shared/types.ts';
import { saveFromJson, saveToJson } from '../storage/serialization.ts';
import type { SaveStorage } from '../storage/storage.ts';
import { Modal } from './Modal.tsx';
import { useI18n } from './i18n.tsx';
import type { AppSettings } from './settings.ts';

const SLOT_IDS = ['slot1', 'slot2', 'slot3'] as const;

export function SettingsPage({
  settings,
  onSettingsChange,
  storage,
  requestSnapshot,
  onClose,
}: {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
  storage: SaveStorage;
  /** Asks the sim for a fresh SaveGame snapshot. */
  requestSnapshot: () => Promise<SaveGame>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [slotStates, setSlotStates] = useState<Record<string, boolean>>({});
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const entries: Record<string, boolean> = {};
      for (const slot of SLOT_IDS) {
        entries[slot] = (await storage.load(slot)) !== null;
      }
      if (!cancelled) setSlotStates(entries);
    })();
    return () => {
      cancelled = true;
    };
  }, [storage]);

  const update = (partial: Partial<AppSettings>): void => {
    onSettingsChange({ ...settings, ...partial });
  };

  const saveToSlot = async (slot: string): Promise<void> => {
    const snapshot = await requestSnapshot();
    await storage.save(snapshot, slot);
    setSlotStates((s) => ({ ...s, [slot]: true }));
    setMessage(t('settings.saved'));
  };

  const loadFromSlot = async (slot: string): Promise<void> => {
    const save = await storage.load(slot);
    if (!save) return;
    await storage.save(save); // becomes the autosave
    window.location.reload();
  };

  const exportSave = async (): Promise<void> => {
    const snapshot = await requestSnapshot();
    const blob = new Blob([saveToJson(snapshot)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `voltopia-save-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importSave = async (file: File): Promise<void> => {
    try {
      const save = saveFromJson(await file.text());
      await storage.save(save);
      window.location.reload();
    } catch (error) {
      setMessage(String(error instanceof Error ? error.message : error));
    }
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
      <section>
        <h3>{t('settings.saveSlots')}</h3>
        {SLOT_IDS.map((slot, index) => (
          <div key={slot} className="settings-slot" data-testid={`save-${slot}`}>
            <span>
              {t('settings.slot')} {index + 1}
              {slotStates[slot] ? ' ●' : ' ○'}
            </span>
            <span className="settings-slot-buttons">
              <button type="button" onClick={() => void saveToSlot(slot)}>
                {t('settings.save')}
              </button>
              <button
                type="button"
                disabled={!slotStates[slot]}
                onClick={() => void loadFromSlot(slot)}
              >
                {t('settings.load')}
              </button>
            </span>
          </div>
        ))}
      </section>
      <section>
        <h3>{t('settings.transfer')}</h3>
        <div className="settings-slot">
          <button type="button" data-testid="export-save" onClick={() => void exportSave()}>
            {t('settings.export')}
          </button>
          <label className="settings-import">
            {t('settings.import')}
            <input
              type="file"
              accept="application/json,.json"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void importSave(file);
              }}
            />
          </label>
        </div>
      </section>
      {message && <p className="settings-message">{message}</p>}
    </Modal>
  );
}
