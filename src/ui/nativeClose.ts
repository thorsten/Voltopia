import type { SaveGame } from '../shared/types.ts';
import { isNativeApp } from './platform.ts';

/** How long Cmd+Q waits for the worker's save snapshot before quitting anyway. */
export const CLOSE_SAVE_TIMEOUT_MS = 2000;

export interface CloseDeps {
  send: (command: { type: 'requestSave' }) => void;
  onSaveData: (listener: (save: SaveGame) => void) => () => void;
  persist: (save: SaveGame) => Promise<void>;
  closeApp: () => Promise<void>;
  timeoutMs?: number;
  setTimer?: typeof setTimeout;
}

/**
 * The desktop quit handshake: Rust holds the window open and emits
 * `close-requested`; we ask the worker for a snapshot, persist it, and
 * call `close_app`. A timeout makes sure a stalled worker cannot make the
 * app unquittable. Idempotent while a close is pending.
 */
export function createCloseHandler({
  send,
  onSaveData,
  persist,
  closeApp,
  timeoutMs = CLOSE_SAVE_TIMEOUT_MS,
  setTimer = setTimeout,
}: CloseDeps): () => void {
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    let done = false;
    let unsubscribe: () => void = () => {};
    const finish = (): void => {
      if (done) return;
      done = true;
      unsubscribe();
      closeApp().catch((error) => {
        console.warn('close_app failed', error);
        pending = false;
      });
    };
    unsubscribe = onSaveData((save) => {
      persist(save)
        .catch((error) => console.warn('Save on quit failed', error))
        .finally(finish);
    });
    setTimer(finish, timeoutMs);
    send({ type: 'requestSave' });
  };
}

/** Wire the handshake to Tauri. Outside the app this is a no-op. */
export function listenForNativeClose(deps: CloseDeps, native = isNativeApp()): () => void {
  if (!native) return () => {};
  let unlisten: (() => void) | null = null;
  let cancelled = false;
  const handler = createCloseHandler(deps);
  void import('@tauri-apps/api/event')
    .then(({ listen }) =>
      listen('close-requested', handler).then((off) => {
        if (cancelled) off();
        else unlisten = off;
      }),
    )
    .catch((error) => console.warn('Native close listener failed', error));
  return () => {
    cancelled = true;
    unlisten?.();
  };
}

/** `closeApp` for `listenForNativeClose`: the Rust `close_app` command. */
export async function invokeCloseApp(): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('close_app');
}
