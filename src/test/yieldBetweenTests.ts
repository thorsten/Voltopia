import { afterEach } from 'vitest';

/**
 * Let the worker's event loop reach its poll phase between tests.
 *
 * Vitest workers report progress to the main process over an RPC whose
 * replies only arrive as macrotasks, and each call times out after 60 s.
 * Our simulation tests are synchronous and vitest chains them with
 * microtasks, so a test file never lets a reply in until it ends: a file
 * that runs longer than 60 s in total fails with "Timeout calling
 * onTaskUpdate" although every test passed (it happened on the slower
 * GitHub runners). Two timer hops guarantee one pass through the poll
 * phase — the first callback runs in the timers phase, the second is
 * only due after the loop went round once — so now only the single
 * longest test has to stay below the limit.
 */
const nextTimer = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(async () => {
  await nextTimer();
  await nextTimer();
});
