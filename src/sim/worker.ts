/**
 * Simulation worker entry point. Thin binding between the pure SimEngine
 * and the browser: message handling and the fixed-tick scheduler live here,
 * everything else is testable engine code.
 */
import { tickIntervalMs } from '../shared/constants.ts';
import type { SimCommand, SimEvent } from '../shared/messages.ts';
import { SimEngine } from './engine.ts';

let engine: SimEngine | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function post(event: SimEvent): void {
  (self as unknown as Worker).postMessage(event);
}

function reschedule(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  if (!engine) return;
  const interval = tickIntervalMs(engine.state.speed);
  if (interval === null) return;
  timer = setInterval(() => {
    if (engine) post(engine.tick());
  }, interval);
}

self.onmessage = (message: MessageEvent<SimCommand>) => {
  const command = message.data;
  if (command.type === 'init') {
    engine = new SimEngine(command.seed, command.size);
    const events = engine.applyCommand(command);
    for (const event of events) post(event);
    // Send one immediate tick so the UI has initial state (includes the
    // full-grid diff after loading a save).
    post(engine.tick());
    post({ type: 'ready' });
    reschedule();
    return;
  }
  if (!engine) return;
  const events = engine.applyCommand(command);
  for (const event of events) post(event);
  // Selecting a tile must refresh the inspector even while paused, and a
  // speed change must reach the HUD even when the new speed is "paused"
  // (no tick will ever report it otherwise, so the pause button would
  // never light up).
  const flushed =
    command.type === 'inspectTile' || command.type === 'setSpeed'
      ? engine.snapshot()
      : engine.flush();
  if (flushed) post(flushed);
  if (command.type === 'setSpeed') reschedule();
  if (command.requestId !== undefined) {
    const rejection = events.find((event) => event.type === 'rejected');
    post({
      type: 'commandResult',
      requestId: command.requestId,
      ...(rejection && rejection.type === 'rejected' ? { rejected: rejection.reason } : {}),
    });
  }
};
