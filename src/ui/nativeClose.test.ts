import { describe, expect, it, vi } from 'vitest';
import type { SaveGame } from '../shared/types.ts';
import { CLOSE_SAVE_TIMEOUT_MS, createCloseHandler } from './nativeClose.ts';

function harness(persist = vi.fn(async () => {}), closeApp = vi.fn(async () => {})) {
  let listener: ((save: SaveGame) => void) | null = null;
  const send = vi.fn();
  const timers: Array<() => void> = [];
  const setTimer = ((fn: () => void) => {
    timers.push(fn);
    return 0;
  }) as unknown as typeof setTimeout;
  const clearTimer = vi.fn() as unknown as typeof clearTimeout;
  const onSaveData = (l: (save: SaveGame) => void) => {
    listener = l;
    return () => {
      listener = null;
    };
  };
  const handle = createCloseHandler({ send, onSaveData, persist, closeApp, setTimer, clearTimer });
  const save = {} as SaveGame;
  return { handle, send, closeApp, persist, timers, clearTimer, emitSave: () => listener?.(save) };
}

describe('createCloseHandler', () => {
  it('requests a save, persists it, then closes', async () => {
    const h = harness();
    h.handle();
    expect(h.send).toHaveBeenCalledWith({ type: 'requestSave' });
    expect(h.closeApp).not.toHaveBeenCalled();
    h.emitSave();
    await vi.waitFor(() => expect(h.closeApp).toHaveBeenCalledOnce());
    expect(h.persist).toHaveBeenCalledOnce();
  });

  it('closes after the timeout when no save arrives', async () => {
    const h = harness();
    h.handle();
    expect(h.timers).toHaveLength(1);
    h.timers[0]();
    await vi.waitFor(() => expect(h.closeApp).toHaveBeenCalledOnce());
  });

  it('closes even when persisting fails', async () => {
    const h = harness(
      vi.fn(async () => {
        throw new Error('disk');
      }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.handle();
    h.emitSave();
    await vi.waitFor(() => expect(h.closeApp).toHaveBeenCalledOnce());
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('does not time out once a snapshot has arrived', async () => {
    let resolvePersist: () => void = () => {};
    const persist = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePersist = resolve;
        }),
    );
    const h = harness(persist);
    h.handle();
    h.emitSave();
    expect(h.clearTimer).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(h.closeApp).not.toHaveBeenCalled();
    resolvePersist();
    await vi.waitFor(() => expect(h.closeApp).toHaveBeenCalledOnce());
  });

  it('ignores a second close request while one is pending', async () => {
    const h = harness();
    h.handle();
    h.handle();
    expect(h.send).toHaveBeenCalledTimes(1);
    h.emitSave();
    h.timers.forEach((t) => t());
    await vi.waitFor(() => expect(h.closeApp).toHaveBeenCalledOnce());
  });

  it('allows a new close request after close_app fails', async () => {
    const closeApp = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('ipc'))
      .mockResolvedValue(undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = harness(undefined, closeApp);
    h.handle();
    h.emitSave();
    await vi.waitFor(() => expect(closeApp).toHaveBeenCalledOnce());
    await vi.waitFor(() => {
      h.handle();
      expect(h.send).toHaveBeenCalledTimes(2);
    });
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('exposes the timeout constant', () => {
    expect(CLOSE_SAVE_TIMEOUT_MS).toBe(2000);
  });
});
