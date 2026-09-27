import { useCallback, useEffect, useRef, useState } from 'react';
import { OverlayMode, type SaveGame } from '../shared/types.ts';
import { IndexedDbStorage } from '../storage/indexeddb.ts';
import type { GameRenderer, RendererCallbacks } from '../render/renderer.ts';
import { CityVitals } from './CityVitals.tsx';
import { HudConsole } from './HudConsole.tsx';
import { TimeControls } from './TimeControls.tsx';
import { TileInspector } from './TileInspector.tsx';
import { HelpPage } from './HelpPage.tsx';
import { ImprintPage } from './ImprintPage.tsx';
import { rejectionKey, useI18n, type Locale } from './i18n.tsx';
import { GameView } from './GameView.tsx';
import { GoalsPanel } from './GoalsPanel.tsx';
import { Minimap } from './Minimap.tsx';
import { OverlayToggle } from './OverlayToggle.tsx';
import { BuildBar } from './BuildBar.tsx';
import type { NewCityOptions } from '../agent/tools.ts';
import {
  consumePendingNewGame,
  DEFAULT_NEW_GAME,
  storePendingNewGame,
  type NewGameOptions,
} from './newGame.ts';
import { NewGamePage } from './NewGamePage.tsx';
import { SettingsPage } from './SettingsPage.tsx';
import { StatsPage } from './StatsPage.tsx';
import { loadSettings, persistSettings, type AppSettings } from './settings.ts';
import { sound } from './sound.ts';
import { isTutorialDone, Tutorial } from './Tutorial.tsx';
import { WinScreen } from './WinScreen.tsx';
import { useAgentTools } from './useAgentTools.ts';
import { useSimBridge } from './useSimBridge.ts';
import { useTools } from './useTools.ts';

const AUTOSAVE_INTERVAL_MS = 10_000;

const storage = new IndexedDbStorage();

/** Remembers whether the HUD detail drawer is open, across sessions. */
const DETAILS_STORAGE_KEY = 'voltopia.hudDetails';

function loadDetailsOpen(): boolean {
  try {
    return localStorage.getItem(DETAILS_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

/** Loads the autosave before booting the simulation. */
export function App() {
  const { t } = useI18n();
  const [boot, setBoot] = useState<{
    save: SaveGame | null;
    options: NewGameOptions;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    storage.load().then((save) => {
      // Pending options only apply when starting fresh.
      const options = consumePendingNewGame();
      if (!cancelled) setBoot({ save, options });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!boot) {
    return <div className="boot-screen">{t('boot.loading')}</div>;
  }
  return <Game save={boot.save} options={boot.options} />;
}

function LanguageSwitch() {
  const { locale, setLocale } = useI18n();
  const options: Locale[] = ['en', 'de'];
  return (
    <span className="language-switch" data-testid="language-switch">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          className={locale === option ? 'active' : ''}
          data-testid={`language-${option}`}
          onClick={() => setLocale(option)}
        >
          {option.toUpperCase()}
        </button>
      ))}
    </span>
  );
}

function Game({ save, options }: { save: SaveGame | null; options: NewGameOptions }) {
  const { t } = useI18n();
  // A saved city keeps its own size/seed; new cities use the chosen options.
  const gridSize = save?.size ?? options.size;
  const bridge = useSimBridge({
    seed: save?.seed ?? options.seed ?? Date.now() % 2147483647,
    size: gridSize,
    startingMoney: options.startingMoney,
    disasterScale: options.disasterScale,
    ...(save ? { save } : {}),
  });
  const callbacksRef = useRef<RendererCallbacks>({});
  const rendererRef = useRef<GameRenderer | null>(null);
  const { tool, setTool, costPreview, selectedTile, clearSelectedTile } = useTools(
    bridge,
    callbacksRef,
    rendererRef,
    gridSize,
  );
  const [overlay, setOverlay] = useState<OverlayMode>(OverlayMode.None);
  const [page, setPage] = useState<'help' | 'imprint' | 'settings' | 'newGame' | 'stats' | null>(
    null,
  );
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [detailsOpen, setDetailsOpen] = useState(loadDetailsOpen);
  // The tutorial runs for brand-new cities only (no autosave existed).
  const [showTutorial, setShowTutorial] = useState(() => save === null && !isTutorialDone());

  const toggleDetails = (): void => {
    setDetailsOpen((open) => {
      try {
        localStorage.setItem(DETAILS_STORAGE_KEY, open ? '0' : '1');
      } catch {
        // best effort only
      }
      return !open;
    });
  };

  const stats = bridge.stats;

  useEffect(() => {
    rendererRef.current?.setOverlayMode(overlay);
  }, [overlay]);

  // Autosave: periodically request a snapshot and persist it. The deps
  // must be the stable callbacks, NOT the bridge object — that changes
  // identity on every stats tick and would reset the interval before it
  // ever fires.
  const { send, onSaveData } = bridge;
  useEffect(() => {
    const unsubscribe = onSaveData((save) => {
      storage.save(save).catch((error) => console.warn('Autosave failed', error));
    });
    const timer = setInterval(() => send({ type: 'requestSave' }), AUTOSAVE_INTERVAL_MS);
    // Quick-save on Ctrl/Cmd+S (autosave covers the rest); plain S pans.
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        send({ type: 'requestSave' });
      }
    };
    // Best-effort save when the tab is hidden (switch, reload, close).
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') send({ type: 'requestSave' });
    };
    window.addEventListener('keydown', onKeyDown);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      unsubscribe();
      clearInterval(timer);
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [send, onSaveData]);

  const startNewGame = async (): Promise<void> => {
    await storage.clear();
    window.location.reload();
  };

  // Agent tools (WebMCP + window.voltopia); a new city from a tool goes
  // through the same pending-options reload as the new-game dialog. No
  // tool exposes disaster intensity yet (Task 15), so fill the default
  // when the tool didn't supply one — NewCityOptions leaves it optional.
  const startNewCityFromTool = useCallback((options: NewCityOptions) => {
    storePendingNewGame({
      ...options,
      disasterScale: options.disasterScale ?? DEFAULT_NEW_GAME.disasterScale,
    });
    void storage.clear().then(() => window.location.reload());
  }, []);
  useAgentTools(bridge, gridSize, startNewCityFromTool);

  useEffect(() => {
    if (stats) rendererRef.current?.setStats(stats);
  }, [stats]);

  // Ring around the inspected tile showing what it supplies or serves.
  // Only trust inspection data for the tile that is actually selected —
  // the worker answers a tick later than the click.
  const inspected = stats?.inspected;
  const selectionRadius =
    selectedTile !== null && inspected?.index === selectedTile ? inspected.ringRadius : 0;
  useEffect(() => {
    rendererRef.current?.setSelectionRadius(selectionRadius);
  }, [selectionRadius, selectedTile]);

  // Apply settings to sound and renderer; re-applied once the renderer
  // exists (stats implies the app is fully booted).
  const rendererReady = stats !== null;
  useEffect(() => {
    persistSettings(settings);
    sound.enabled = settings.soundEnabled;
    sound.volume = settings.soundVolume;
    rendererRef.current?.setShadows(settings.shadows);
    rendererRef.current?.setReducedMotion(settings.reducedMotion);
    // On the root element so modals and the boot screen follow it too.
    document.documentElement.dataset.theme = settings.theme;
  }, [settings, rendererReady]);

  const requestSnapshot = (): Promise<SaveGame> =>
    new Promise((resolve) => {
      const unsubscribe = onSaveData((save) => {
        unsubscribe();
        resolve(save);
      });
      send({ type: 'requestSave' });
    });

  useEffect(() => {
    if (bridge.rejection) sound.play('reject');
  }, [bridge.rejection]);

  const rejection = bridge.rejection
    ? (() => {
        const key = rejectionKey(bridge.rejection);
        return key ? t(key) : bridge.rejection;
      })()
    : null;

  return (
    <div className="app">
      <GameView
        bridge={bridge}
        gridSize={gridSize}
        callbacksRef={callbacksRef}
        rendererRef={rendererRef}
      />
      {/* One grid over the canvas: rows and columns keep the HUD islands
          apart at any window size, so nothing can overlap. */}
      <div className="hud-layer">
        {/* Three plates docked to the top edge: vitals left, energy centre,
            time controls right. On narrower windows the console drops under
            the two corner plates and hangs from them. */}
        <div className="hud-slot hud-slot-top">
          {stats && <CityVitals stats={stats} />}
          {stats && (
            <HudConsole
              stats={stats}
              detailsOpen={detailsOpen}
              onToggleDetails={toggleDetails}
              onSetTaxRate={(rate) => bridge.send({ type: 'setTaxRate', rate })}
              onSetSmartCharging={(enabled) => bridge.send({ type: 'setSmartCharging', enabled })}
              onSetMarketTrading={(enabled) => bridge.send({ type: 'setMarketTrading', enabled })}
              onBuyInsulation={() => bridge.send({ type: 'buyInsulation' })}
            />
          )}
          {stats && (
            <TimeControls
              stats={stats}
              onSetSpeed={(speed) => bridge.send({ type: 'setSpeed', speed })}
              onNewGame={() => setPage('newGame')}
            />
          )}
        </div>

        <div className="hud-slot hud-slot-left">
          <div className="hud-rail-bottom">
            {stats && (
              <GoalsPanel
                goals={stats.goals}
                services={stats.services}
                onAchievement={() => sound.play('achievement')}
              />
            )}
            {/* One plate in the corner: minimap, overlay switch and the
                controls hint share it, so the corner has a single edge. */}
            <div className="hud-plate hud-corner-plate">
              <div className="minimap-card">
                <Minimap rendererRef={rendererRef} gridSize={gridSize} />
              </div>
              <OverlayToggle mode={overlay} onChange={setOverlay} />
              <p className="controls-hint" data-testid="controls-hint">
                {t('footer.hint')}
              </p>
            </div>
          </div>
        </div>

        <div className="hud-slot hud-slot-bottom-center">
          <BuildBar
            tool={tool}
            onSelectTool={(next) => {
              sound.play('click');
              setTool(next);
            }}
            onUndo={() => bridge.send({ type: 'undo' })}
          />
        </div>

        <div className="hud-slot hud-slot-right">
          <div className="hud-rail-bottom">
            {/* Bottom-anchored like the left cluster, which also keeps it
                clear of the console drawer hanging down from the top. */}
            {selectedTile !== null && stats?.inspected && (
              <TileInspector info={stats.inspected} onClose={clearSelectedTile} />
            )}
            <footer className="hud-plate hud-footer">
              <button type="button" data-testid="open-help" onClick={() => setPage('help')}>
                {t('footer.help')}
              </button>
              <button type="button" data-testid="open-imprint" onClick={() => setPage('imprint')}>
                {t('footer.imprint')}
              </button>
              <button type="button" data-testid="open-settings" onClick={() => setPage('settings')}>
                {t('footer.settings')}
              </button>
              <LanguageSwitch />
            </footer>
          </div>
        </div>
      </div>

      {rejection && (
        <div className="rejection-toast" data-testid="rejection">
          {rejection}
        </div>
      )}
      {costPreview && (
        <div className="cost-preview" data-testid="cost-preview">
          {costPreview.tiles} ▦ · {costPreview.cost.toLocaleString('en-US')} ⌁
        </div>
      )}
      {/* Coach mark, not a HUD island: it floats above the layout for the
          handful of steps it runs, then never comes back. */}
      {showTutorial && stats && (
        <Tutorial stats={stats} onFinished={() => setShowTutorial(false)} />
      )}
      {stats && <WinScreen stats={stats} onCelebrate={() => sound.play('achievement')} />}
      {page === 'help' && <HelpPage onClose={() => setPage(null)} />}
      {page === 'imprint' && <ImprintPage onClose={() => setPage(null)} />}
      {page === 'stats' && <StatsPage bridge={bridge} onClose={() => setPage(null)} />}
      {page === 'newGame' && (
        <NewGamePage onStart={() => void startNewGame()} onClose={() => setPage(null)} />
      )}
      {page === 'settings' && (
        <SettingsPage
          settings={settings}
          onSettingsChange={setSettings}
          storage={storage}
          requestSnapshot={requestSnapshot}
          onClose={() => setPage(null)}
        />
      )}
    </div>
  );
}
