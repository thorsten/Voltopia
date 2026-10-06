/** Persisted app settings (localStorage; independent of save games). */
export type HudTheme = 'dark' | 'light';

export interface AppSettings {
  soundEnabled: boolean;
  soundVolume: number;
  shadows: boolean;
  ambientOcclusion: boolean;
  reducedMotion: boolean;
  theme: HudTheme;
  /** Show the diagnostics panel (frame time, draw calls, tick cost). */
  diagnostics: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  soundEnabled: true,
  soundVolume: 0.4,
  shadows: true,
  ambientOcclusion: true,
  reducedMotion: false,
  theme: 'dark',
  diagnostics: false,
};

const SETTINGS_STORAGE_KEY = 'voltopia.settings';

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      soundEnabled: parsed.soundEnabled ?? DEFAULT_SETTINGS.soundEnabled,
      soundVolume:
        typeof parsed.soundVolume === 'number'
          ? Math.min(1, Math.max(0, parsed.soundVolume))
          : DEFAULT_SETTINGS.soundVolume,
      shadows: parsed.shadows ?? DEFAULT_SETTINGS.shadows,
      ambientOcclusion: parsed.ambientOcclusion ?? DEFAULT_SETTINGS.ambientOcclusion,
      reducedMotion: parsed.reducedMotion ?? DEFAULT_SETTINGS.reducedMotion,
      theme: parsed.theme === 'light' ? 'light' : 'dark',
      diagnostics: parsed.diagnostics ?? DEFAULT_SETTINGS.diagnostics,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function persistSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // best effort only
  }
}
