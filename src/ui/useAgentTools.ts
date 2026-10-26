import { useEffect } from 'react';
import {
  createAgentSaves,
  createAgentTools,
  type AgentContext,
  type NewCityOptions,
} from '../agent/tools.ts';
import { TileMirror } from '../agent/tileMirror.ts';
import { registerAgentTools } from '../agent/webmcp.ts';
import type { SimCommand } from '../shared/messages.ts';
import type { SaveGame, ScenarioId } from '../shared/types.ts';
import type { SaveStorage } from '../storage/storage.ts';
import { shareBaseUrl } from './shareLink.ts';
import type { SimBridge } from './useSimBridge.ts';

/** Where the save tools persist; must be a stable (module-level) object. */
export interface AgentSaveHost {
  storage: SaveStorage;
  /** Makes `save` the running city (autosave copy + reload). */
  replaceCity(save: SaveGame): Promise<void>;
}

/**
 * Publishes the agent tools (WebMCP + `window.voltopia`) for the lifetime
 * of the game view. Builds the tile mirror from the bridge's diffs and
 * turns the fire-and-forget worker protocol into promises via request ids.
 */
export function useAgentTools(
  bridge: SimBridge,
  gridSize: number,
  onNewCity: (options: NewCityOptions) => void,
  saveHost: AgentSaveHost,
  onStartScenario: (id: ScenarioId) => void,
): void {
  // Stable callbacks only — the bridge object changes identity every tick.
  const { send, onDiffs, onTick, onCommandResult, onLifetime, onSaveData, getStats } = bridge;

  useEffect(() => {
    const tiles = new TileMirror(gridSize);
    const unsubscribeDiffs = onDiffs((diffs) => tiles.applyDiffs(diffs));

    let nextRequestId = 1;
    const pending = new Map<number, (outcome: { rejected?: string }) => void>();
    const unsubscribeResults = onCommandResult((requestId, rejected) => {
      const resolve = pending.get(requestId);
      if (!resolve) return;
      pending.delete(requestId);
      resolve(rejected !== undefined ? { rejected } : {});
    });

    const ctx: AgentContext = {
      tiles,
      // The town import's only network access; bound so the tools can call it detached.
      fetch: globalThis.fetch.bind(globalThis),
      getStats,
      sendCommand: (command: SimCommand) =>
        new Promise((resolve) => {
          const requestId = nextRequestId++;
          pending.set(requestId, resolve);
          send({ ...command, requestId });
        }),
      waitForTick: (targetTick, signal) =>
        new Promise((resolve, reject) => {
          const current = getStats();
          if (current && current.tick >= targetTick) {
            resolve(current);
            return;
          }
          const unsubscribe = onTick((stats) => {
            if (stats.tick < targetTick) return;
            unsubscribe();
            resolve(stats);
          });
          signal?.addEventListener('abort', () => {
            unsubscribe();
            reject(new DOMException('advance_time aborted', 'AbortError'));
          });
        }),
      requestLifetime: () =>
        new Promise((resolve) => {
          const unsubscribe = onLifetime((data) => {
            unsubscribe();
            resolve(data);
          });
          send({ type: 'requestLifetime' });
        }),
      startNewCity: onNewCity,
      saves: createAgentSaves({
        storage: saveHost.storage,
        snapshot: () =>
          new Promise((resolve) => {
            const unsubscribe = onSaveData((save) => {
              unsubscribe();
              resolve(save);
            });
            send({ type: 'requestSave' });
          }),
        population: () => getStats()?.population ?? null,
        replaceCity: saveHost.replaceCity,
        shareBaseUrl: () => shareBaseUrl(),
      }),
      startScenario: onStartScenario,
    };

    const unregister = registerAgentTools(createAgentTools(ctx));
    return () => {
      unregister();
      unsubscribeDiffs();
      unsubscribeResults();
      pending.clear();
    };
  }, [
    send,
    onDiffs,
    onTick,
    onCommandResult,
    onLifetime,
    onSaveData,
    getStats,
    gridSize,
    onNewCity,
    saveHost,
    onStartScenario,
  ]);
}
