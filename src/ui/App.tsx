import { useCallback, useEffect, useRef, useState } from 'react';
import { OverlayMode, type SaveGame, type ScenarioId } from '../shared/types.ts';
import { IndexedDbStorage } from '../storage/indexeddb.ts';
import { decodeShareCode } from '../storage/shareCode.ts';
import type { GameRenderer, RendererCallbacks } from '../render/renderer.ts';
import { createCityReloader } from './cityReload.ts';
import { CityVitals } from './CityVitals.tsx';
import { DiagnosticsPanel } from './DiagnosticsPanel.tsx';
import { DisasterBanner } from './DisasterBanner.tsx';
import { HudConsole } from './HudConsole.tsx';
import { TimeControls } from './TimeControls.tsx';
import { TileInspector } from './TileInspector.tsx';
import { HelpPage } from './HelpPage.tsx';
import { ImprintPage } from './ImprintPage.tsx';
import { rejectionKey, useI18n, type Locale } from './i18n.tsx';
import { GameView } from './GameView.tsx';
import { invokeCloseApp, listenForNativeClose } from './nativeClose.ts';
import { EndScreen, endShownKey } from './EndScreen.tsx';
import { GoalsPanel } from './GoalsPanel.tsx';
import { Minimap } from './Minimap.tsx';
import { OverlayToggle } from './OverlayToggle.tsx';
import { BuildBar } from './BuildBar.tsx';
import type { NewCityOptions } from '../agent/tools.ts';
// Side effect: registers the shipped scenario definitions in this bundle.
import '../sim/scenarios/defs/index.ts';
import { scenarioDef } from '../sim/scenarios/registry.ts';
import {
  consumePendingNewGame,
  DEFAULT_NEW_GAME,
  storePendingNewGame,
  storePendingScenario,
  type NewGameOptions,
} from './newGame.ts';
import { NewGamePage } from './NewGamePage.tsx';
import { SavesPage } from './SavesPage.tsx';
import { SharedCityDialog } from './SharedCityDialog.tsx';
import {
  datedName,
  keepAndOpenShared,
  type KeptSlot,
  SHARE_HASH_PREFIX,
  shareSupported,
  takeShareCodeOnce,
} from './shareLink.ts';
import { ScenarioPanel } from './ScenarioPanel.tsx';
import { ScenariosPage } from './ScenariosPage.tsx';
import { SettingsPage } from './SettingsPage.tsx';
import { SmallScreenNotice } from './SmallScreenNotice.tsx';
import {
  isSmallScreen,
  rememberSmallScreenNoticeDismissed,
  wasSmallScreenNoticeDismissed,
} from './smallScreen.ts';
import { StatsPage } from './StatsPage.tsx';
import { loadSettings, persistSettings, type AppSettings } from './settings.ts';
import { sound } from './sound.ts';
import { IntroCoach } from './IntroCoach.tsx';
import {
  canAutoStartIntro,
  createIntroTriggerState,
  loadSeenIntros,
  nextIntroToShow,
  resetSeenIntros,
  type IntroId,
} from './intros.ts';
import { isTutorialDone, resetTutorial, Tutorial } from './Tutorial.tsx';
import { useAgentTools } from './useAgentTools.ts';
import { useSimBridge } from './useSimBridge.ts';
import { useTools } from './useTools.ts';

const AUTOSAVE_INTERVAL_MS = 10_000;
/** How long the start-up notice toast (e.g. an invalid share link) stays. */
const NOTICE_DURATION_MS = 6_000;

const storage = new IndexedDbStorage();

/**
 * Every "replace the city and reload" (load, new game, start_new_city)
 * goes through this, and every autosave too, so no autosave can write the
 * old city back between the copy and the reload.
 */
const cityReloader = createCityReloader(storage, () => window.location.reload());
/** The save tools' host; module-level so useAgentTools' effect stays put. */
const agentSaveHost = { storage, replaceCity: cityReloader.replaceCityAndReload };

/** Remembers whether the HUD detail drawer is open, across sessions. */
const DETAILS_STORAGE_KEY = 'voltopia.hudDetails';

function loadDetailsOpen(): boolean {
  try {
    return localStorage.getItem(DETAILS_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

type SharedLinkResult = SaveGame | 'failed' | null;

/** Decodes this page load's '#city=' code; 'failed' for unusable links. */
function readSharedLink(code: string | null): Promise<SharedLinkResult> {
  if (!code) return Promise.resolve(null);
  if (!shareSupported()) {
    console.warn('Shared city link rejected', 'unsupported');
    return Promise.resolve('failed');
  }
  return decodeShareCode(code).then(
    (save) => save,
    (error: unknown) => {
      console.warn('Shared city link rejected', error);
      return 'failed' as const;
    },
  );
}

/**
 * Loads the autosave (and a shared city from the URL, if any) before
 * booting the simulation. While a shared city awaits the player's answer,
 * `Game` is not mounted, so no worker or autosave can race the replacement.
 */
export function App() {
  const { t, locale } = useI18n();
  const [boot, setBoot] = useState<{
    save: SaveGame | null; // the autosave
    options: NewGameOptions;
    shared: SaveGame | null; // decoded link, awaiting the dialog
    linkFailed: boolean;
  } | null>(null);
  const [sharedBusy, setSharedBusy] = useState(false);
  const [sharedError, setSharedError] = useState<string | null>(null);
  // The slot the current city was kept in: a retried Load reuses it.
  const keptSlot = useRef<KeptSlot>({ id: null });

  // A share link opened in this already-running tab only changes the
  // hash (same document): reload so the boot path reads it like any link.
  useEffect(() => {
    const onHashChange = (): void => {
      if (window.location.hash.startsWith(SHARE_HASH_PREFIX)) window.location.reload();
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Strips the hash synchronously, before any await; cached per page load.
    const decoded = readSharedLink(takeShareCodeOnce());
    void Promise.all([storage.load(), decoded]).then(([save, shared]) => {
      // Always consumed (cached per load); a link wins over pending options.
      const pending = consumePendingNewGame();
      const linked = shared !== null && shared !== 'failed';
      if (!cancelled)
        setBoot({
          save,
          options: linked ? { ...DEFAULT_NEW_GAME } : pending,
          shared: linked ? shared : null,
          linkFailed: shared === 'failed',
        });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!boot) {
    return <div className="boot-screen">{t('boot.loading')}</div>;
  }
  if (boot.shared) {
    const shared = boot.shared;
    const load = async (): Promise<void> => {
      setSharedBusy(true);
      setSharedError(null);
      try {
        await keepAndOpenShared({
          storage,
          current: boot.save,
          keptName: datedName(t('share.keptName'), new Date(), locale),
          shared,
          replace: cityReloader.replaceCityAndReload,
          kept: keptSlot.current,
        });
      } catch (error) {
        console.error('Loading the shared city failed', error);
        setSharedError(t('share.loadFailed'));
        setSharedBusy(false);
      }
    };
    return (
      <>
        <div className="boot-screen">{t('boot.loading')}</div>
        <SharedCityDialog
          save={shared}
          busy={sharedBusy}
          error={sharedError}
          onLoad={() => void load()}
          onCancel={() => {
            if (!sharedBusy) setBoot({ ...boot, shared: null });
          }}
        />
      </>
    );
  }
  return (
    <Game
      save={boot.save}
      options={boot.options}
      notice={boot.linkFailed ? t('share.invalid') : null}
    />
  );
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

function Game({
  save,
  options,
  notice,
}: {
  save: SaveGame | null;
  options: NewGameOptions;
  /** A one-off message (e.g. a rejected share link), shown briefly on start. */
  notice: string | null;
}) {
  const { t } = useI18n();
  const [noticeVisible, setNoticeVisible] = useState(notice !== null);
  useEffect(() => {
    const timer = setTimeout(() => setNoticeVisible(false), NOTICE_DURATION_MS);
    return () => clearTimeout(timer);
  }, []);
  // A saved city keeps its own size/seed; new cities use the chosen options.
  const gridSize = save?.size ?? options.size;
  const bridge = useSimBridge({
    seed: save?.seed ?? options.seed ?? Date.now() % 2147483647,
    size: gridSize,
    startingMoney: options.startingMoney,
    disasterScale: options.disasterScale,
    ...(save === null && options.scenario ? { scenario: options.scenario } : {}),
    ...(save === null && options.sandbox ? { sandbox: true } : {}),
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
  const [selectedIsland, setSelectedIsland] = useState(0);
  const [page, setPage] = useState<
    'help' | 'imprint' | 'settings' | 'saves' | 'newGame' | 'stats' | 'scenarios' | null
  >(null);
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [detailsOpen, setDetailsOpen] = useState(loadDetailsOpen);
  // The tutorial runs for brand-new free-play cities only (no autosave existed).
  const [showTutorial, setShowTutorial] = useState(
    () => save === null && !options.scenario && !isTutorialDone(),
  );
  // Bumped on every manual start so the card remounts at its first open step.
  const [tutorialRun, setTutorialRun] = useState(0);
  const [activeIntro, setActiveIntro] = useState<{
    id: IntroId;
    run: number;
    manual: boolean;
  } | null>(null);
  const introRunRef = useRef(0);
  const introTriggerRef = useRef(createIntroTriggerState());
  // Cached copy of the seen list; refreshed whenever it changes.
  const seenIntrosRef = useRef<Set<IntroId> | null>(null);
  // Evaluated once at startup; no resize listener — a phone rotated into
  // landscape is still a phone.
  const [showSmallScreenNotice, setShowSmallScreenNotice] = useState(
    () => isSmallScreen(window.innerWidth, window.innerHeight) && !wasSmallScreenNoticeDismissed(),
  );

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
    // Grid is the only overlay a district selection makes sense on —
    // switching to any other one drops the highlight.
    if (overlay !== OverlayMode.Grid) {
      setSelectedIsland(0);
      rendererRef.current?.setSelectedIsland(0);
    }
  }, [overlay]);

  const selectIsland = (n: number): void => {
    setSelectedIsland(n);
    rendererRef.current?.setSelectedIsland(n);
    if (n !== 0) setOverlay(OverlayMode.Grid);
  };

  // Autosave: periodically request a snapshot and persist it. The deps
  // must be the stable callbacks, NOT the bridge object — that changes
  // identity on every stats tick and would reset the interval before it
  // ever fires.
  const { send, onSaveData } = bridge;
  useEffect(() => {
    const unsubscribe = onSaveData((save) => {
      cityReloader.autosave(save).catch((error) => console.warn('Autosave failed', error));
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
    // Desktop app: Cmd+Q waits for one last autosave (see nativeClose.ts).
    const stopNativeClose = listenForNativeClose({
      send,
      onSaveData,
      // While a city is being replaced this resolves without writing,
      // so the window still closes and the new city stays the autosave.
      persist: (save) => cityReloader.autosave(save),
      closeApp: invokeCloseApp,
    });
    return () => {
      stopNativeClose();
      unsubscribe();
      clearInterval(timer);
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [send, onSaveData]);

  const startNewGame = (): Promise<void> => cityReloader.replaceCityAndReload(null);

  // Agent tools (WebMCP + window.voltopia); a new city from a tool goes
  // through the same pending-options reload as the new-game dialog.
  // start_new_city always supplies disasterScale, but NewCityOptions
  // leaves it optional (other callers may not), so fill the default here too.
  const startNewCityFromTool = useCallback((options: NewCityOptions) => {
    storePendingNewGame({
      ...options,
      disasterScale: options.disasterScale ?? DEFAULT_NEW_GAME.disasterScale,
    });
    void cityReloader.replaceCityAndReload(null);
  }, []);
  // A scenario always runs on its definition's seed, so a replay would
  // find the end screen already marked as shown — clear that mark first.
  const startScenario = useCallback((id: ScenarioId) => {
    try {
      localStorage.removeItem(endShownKey(scenarioDef(id).seed, id));
    } catch {
      // best effort only
    }
    storePendingScenario(id);
    void storage.clear().then(() => window.location.reload());
  }, []);
  useAgentTools(bridge, gridSize, startNewCityFromTool, agentSaveHost, startScenario);

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
    rendererRef.current?.setAmbientOcclusion(settings.ambientOcclusion);
    rendererRef.current?.setReducedMotion(settings.reducedMotion);
    // On the root element so modals and the boot screen follow it too.
    document.documentElement.dataset.theme = settings.theme;
  }, [settings, rendererReady]);

  // Feed every stats update to the intro triggers, even while something
  // blocks a start, so the sustain counters stay honest.
  const pageOpen = page !== null;
  const introActive = activeIntro !== null;
  useEffect(() => {
    if (!stats) return;
    seenIntrosRef.current ??= loadSeenIntros();
    const next = nextIntroToShow(introTriggerRef.current, stats, seenIntrosRef.current);
    if (
      next &&
      canAutoStartIntro({
        introActive,
        tutorialShowing: showTutorial,
        pageOpen,
        introsEnabled: settings.introsEnabled,
      })
    ) {
      introRunRef.current += 1;
      setActiveIntro({ id: next, run: introRunRef.current, manual: false });
    }
  }, [stats, introActive, showTutorial, pageOpen, settings.introsEnabled]);

  // Manual starts from the help page bypass the setting and the seen list.
  const startIntro = (id: IntroId): void => {
    setPage(null);
    setShowTutorial(false);
    introRunRef.current += 1;
    setActiveIntro({ id, run: introRunRef.current, manual: true });
  };
  const startTutorial = (): void => {
    resetTutorial();
    setPage(null);
    setActiveIntro(null);
    setTutorialRun((run) => run + 1);
    setShowTutorial(true);
  };
  const resetIntros = (): void => {
    resetSeenIntros();
    seenIntrosRef.current = new Set();
  };
  const finishIntro = (): void => {
    seenIntrosRef.current = loadSeenIntros();
    setActiveIntro(null);
  };

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
              onSetGridFee={(rate) => bridge.send({ type: 'setGridFee', rate })}
              onTakeCredit={(kind, amount) => bridge.send({ type: 'takeCredit', kind, amount })}
              onRepayCredit={(id) => bridge.send({ type: 'repayCredit', id })}
              onSetSmartMeterRollout={(active) =>
                bridge.send({ type: 'setSmartMeterRollout', active })
              }
              onSetDemandResponse={(active) => bridge.send({ type: 'setDemandResponse', active })}
              onSetMarketTrading={(enabled) => bridge.send({ type: 'setMarketTrading', enabled })}
              onBuyInsulation={() => bridge.send({ type: 'buyInsulation' })}
              onSetPolicy={(id, active) => bridge.send({ type: 'setPolicy', id, active })}
              selectedIsland={selectedIsland}
              onSelectIsland={selectIsland}
            />
          )}
          {stats && (
            <TimeControls
              stats={stats}
              onSetSpeed={(speed) => bridge.send({ type: 'setSpeed', speed })}
              onNewGame={() => setPage('newGame')}
              onScenarios={() => setPage('scenarios')}
            />
          )}
          {stats && (
            <DisasterBanner
              disasters={stats.disasters}
              onWarning={() => sound.play('alarm')}
              onStrike={() => sound.play('alarm')}
            />
          )}
          {settings.diagnostics && rendererReady && (
            <DiagnosticsPanel
              rendererRef={rendererRef}
              getTickMs={bridge.getTickMs}
              stats={stats}
              gridSize={gridSize}
            />
          )}
        </div>

        <div className="hud-slot hud-slot-left">
          <div className="hud-rail-bottom">
            {stats?.scenario ? (
              <ScenarioPanel scenario={stats.scenario} />
            ) : (
              stats && (
                <GoalsPanel
                  goals={stats.goals}
                  services={stats.services}
                  sandbox={stats.sandbox}
                  onAchievement={() => sound.play('achievement')}
                />
              )
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
            grantRemaining={stats?.finance.grantRemaining ?? 0}
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
              <button type="button" data-testid="open-saves" onClick={() => setPage('saves')}>
                {t('footer.saves')}
              </button>
              <button type="button" data-testid="open-settings" onClick={() => setPage('settings')}>
                {t('footer.settings')}
              </button>
              <LanguageSwitch />
            </footer>
          </div>
        </div>
      </div>

      {noticeVisible && notice && (
        <div className="notice-toast" data-testid="share-invalid">
          {notice}
        </div>
      )}
      {rejection && (
        <div className="rejection-toast" data-testid="rejection">
          {rejection}
        </div>
      )}
      {costPreview && (
        <div className="cost-preview" data-testid="cost-preview">
          {costPreview.tiles} ▦ · {costPreview.cost.toLocaleString('en-US')} ⌁
          {costPreview.bridges !== undefined &&
            ` · ${t(costPreview.bridges === 1 ? 'costPreview.bridge' : 'costPreview.bridges', {
              count: costPreview.bridges,
            })}`}
        </div>
      )}
      {showSmallScreenNotice && (
        <SmallScreenNotice
          onDismiss={() => {
            rememberSmallScreenNoticeDismissed();
            setShowSmallScreenNotice(false);
          }}
        />
      )}
      {/* Coach marks, not HUD islands: they float above the layout for the
          handful of steps they run. The help page can restart them. */}
      {showTutorial && stats && (
        <Tutorial key={tutorialRun} stats={stats} onFinished={() => setShowTutorial(false)} />
      )}
      {activeIntro && !showTutorial && stats && (
        <IntroCoach
          key={activeIntro.run}
          stats={stats}
          introId={activeIntro.id}
          manual={activeIntro.manual}
          onFinished={finishIntro}
        />
      )}
      {stats && (
        <EndScreen
          stats={stats}
          onCelebrate={() => sound.play('achievement')}
          onRetry={startScenario}
          onScenarios={() => setPage('scenarios')}
        />
      )}
      {page === 'help' && (
        <HelpPage
          onClose={() => setPage(null)}
          onStartIntro={startIntro}
          onStartTutorial={startTutorial}
          onResetIntros={resetIntros}
        />
      )}
      {page === 'imprint' && <ImprintPage onClose={() => setPage(null)} />}
      {page === 'stats' && (
        <StatsPage
          bridge={bridge}
          sandbox={bridge.stats?.sandbox ?? false}
          storage={storage}
          onClose={() => setPage(null)}
        />
      )}
      {page === 'scenarios' && (
        <ScenariosPage onStart={startScenario} onClose={() => setPage(null)} />
      )}
      {page === 'newGame' && (
        <NewGamePage onStart={() => void startNewGame()} onClose={() => setPage(null)} />
      )}
      {page === 'settings' && (
        <SettingsPage
          settings={settings}
          onSettingsChange={setSettings}
          onClose={() => setPage(null)}
        />
      )}
      {page === 'saves' && stats && (
        <SavesPage
          storage={storage}
          requestSnapshot={requestSnapshot}
          replaceCityAndReload={cityReloader.replaceCityAndReload}
          population={stats.population}
          tick={stats.tick}
          canShare={!stats.scenario}
          onClose={() => setPage(null)}
        />
      )}
    </div>
  );
}
