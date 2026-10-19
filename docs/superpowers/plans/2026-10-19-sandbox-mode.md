# Sandbox Mode Implementation Plan

> **For agentic workers:** Execute task by task, in order. Steps use checkbox (`- [ ]`) syntax. Each task ends with a green pre-commit hook and one commit.

**Goal:** A **sandbox** option for new free-play cities (unlimited money shown as ∞, no credit, rating or grant, no goals; budget lines and statistics keep running) and a new **6x** speed step for every game, in the sim, the UI, the saves and the agent tools.

**Architecture:** `SimState.sandbox` is set once when a free city is founded and lives in the save. The sim never branches at the build sites. Instead `pinSandboxTreasury(state)` (new `src/sim/sandbox.ts`) sets `state.money = BALANCE.sandbox.treasury` at the end of every `stepTick` and after every command the engine applies, so every `cost > state.money` check passes and every flow is still booked as usual. `finance.ts` refuses credit with `sandbox`, pays no grant and skips rating and overdraft bookkeeping. `goals.ts` does nothing. `GlobalStats.sandbox` drives the ∞ display, the hidden finance/money sections and the goals message. Speed becomes `SPEEDS = [0, 1, 3, 6]`. The worker interval comes from one shared helper `tickIntervalMs(speed)`, which the diagnostics panel also uses.

**Tech Stack:** TypeScript strict, vitest, React 19, i18n in `src/ui/i18n.tsx`, Playwright. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-19-sandbox-mode-design.md`

## Global Constraints

- `src/sim/` has no DOM or three.js imports. `src/shared/` never imports from `src/sim/`. Sandbox needs no randomness.
- No magic numbers in sim code: the pinned treasury is `BALANCE.sandbox.treasury`.
- `SaveGame.sandbox?: boolean` is optional and `SAVE_VERSION` stays unchanged. An absent or non-`true` value loads as `false`. A save that carries a `scenario` always loads with `sandbox = false`, because sandbox is free play only.
- **Speed is not persisted:** `serializeState` (`src/sim/state.ts:1346`) writes no `speed`, and `deserializeState` starts at `createSimState`'s `speed: 1`. No save validator needs to learn 6, but `src/storage/serialization.ts` has no speed field either.
- **No keyboard shortcuts for speed exist.** `TOOL_HOTKEYS` (`src/ui/useTools.ts:57`) maps digits and letters to build tools only, `App.tsx:199` handles only Ctrl/Cmd+S, and `renderer.ts:803` handles only Q/E. Nothing to add.
- Sandbox is free-play only. The scenario branch of `SimEngine.applyCommand('init')` ignores `command.sandbox`.
- Every user-visible string goes in `src/ui/i18n.tsx`, English AND German.
- React effects depend on stable identities (`bridge.send`), never on the `bridge` object.
- New option on a sim feature → `src/agent/tools.ts` + tool descriptions + `docs/agent-tools.md`.
- Per-tick cost: the pin is one branch and one assignment. Do not add any scans.
- Keep any single test under ~15 s. Run `pnpm format` before every commit. The hook must be green. Never use `--no-verify`.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Research results (resolved from the code)

**Budget lines and statistics are flows, not money deltas.** Every per-tick money mutation also records the amount it booked:

| Flow                                               | Where money moves                                     | Recorded as                                              |
| -------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------- |
| tax, export, hydrogen, upkeep, biogas fuel, import | `economyStep` (`src/sim/economy.ts:121`)              | `state.lastEconomy` breakdown (computed before the `+=`) |
| smart meters                                       | `smartMetersStep` (`src/sim/smartMeters.ts:78`)       | `lastSmartMeterCost = spent`                             |
| demand response                                    | `demandResponseStep` (`src/sim/demandResponse.ts:82`) | `lastDemandResponseCost`                                 |
| goods import                                       | `deliveriesStep` (`src/sim/deliveries.ts:410`)        | `lastGoodsImportCost +=`                                 |
| ordinances                                         | `policiesStep` (`src/sim/policies.ts:53`)             | `lastPolicyCost`                                         |
| repairs                                            | `repairStep` (`src/sim/disasters.ts:103`)             | `lastRepairCost = spend`                                 |
| grid fee, interest, principal, overdraft           | `financeStep` (`src/sim/finance.ts:235`)              | `state.lastFinance`                                      |

`operatingNet` and `buildBudget` (`src/sim/tick.ts:353`, `:372`) read only these records, and `financeStep`'s `dayIncome` reads `operatingNet`. **No budget line is derived from a money delta, so nothing has to switch.**

Two consumers do read `state.money` itself:

1. `recordLifetime` (`src/sim/tick.ts:147`) stores `money: state.money` in the daily sample. In sandbox this is ≈ `BALANCE.sandbox.treasury` minus the last tick's flows. The statistics page hides the series in sandbox (Task 5). Agents get `sandbox: true` next to it in the overview (Task 6). No sim change is needed.
2. **The agent tools compute `spent` / `refunded` / `repaid` as a money delta** across the command (`spent()` at `src/agent/tools.ts:1957`, `undo` at `:1407`, `repay_credit` at `:1605`). The pin makes these 0 in sandbox. Task 6 replaces them with `sandbox: true` in sandbox results.

Spending capped by the balance is `smartMetersStep` (`state.money - spent < costPerMeter`) and `repairStep` (`cost > state.money - spend`). Both run at the full rate from 1e9. The overdraft (`finance.ts:261`) can never trigger, and Task 3 also guards it.

**Pin call sites.**

- End of `stepTick` (`src/sim/tick.ts:115`), after `recordLifetime`. Goals, the scenario step and the lifetime sample see the tick's real flows. The next tick starts pinned again.
- `SimEngine.applyCommand` (`src/sim/engine.ts:55`): rename the switch to `private dispatch(command)`. `applyCommand` calls it and then calls `pinSandboxTreasury(this.state)` once. Use `this.state`, not the destructured `state`, because `init` replaces the state. This covers creation (`init` free branch and load), builds, undo refunds and `buyInsulation`.

**Speed.** `Speed = 0 | 1 | 3` (`src/shared/types.ts:100`). `worker.ts:23` uses `TICK_MS / engine.state.speed`. `DiagnosticsPanel.tsx:65` uses `TICK_MS`, and the panel already receives `stats`. `SpeedControls.tsx:4` has a `SPEEDS` table. On the agent side: `set_speed` (`tools.ts:1415`) has the enum and a hand-written check, `get_build_catalog` returns `speeds: [0, 1, 3]` (`:983`), and `advance_time` unpauses at speed 3 (`:1673`). `vehiclesMesh.ts:156` measures the update interval (it accepts 10 ms to 2 s), so it adapts to 42 ms on its own.

**Money in the UI.** The treasury appears in these places:

- `CityVitals.tsx:32`
- the saves list (`SavesPage.tsx:300`, from `SaveSummary.money`, `src/storage/summary.ts:47`)
- the money chart on the statistics page (`StatsPage.tsx:116`)
- the agent overview (`tools.ts:707`) and lifetime samples (`tools.ts:1167`)

The finance section is `FinancePanel`, mounted in `BudgetPanel.tsx:325`. It holds the rating, debt, credits, offers and the grant pot. The goals checklist is `GoalsPanel` (`App.tsx:370`). The victory check `EndScreen.tsx:38` requires `stats.goals.length > 0`. `HudConsole.tsx:170` (insulation) and BuildBar affordability compare against `stats.money` and work unchanged.

**New-game plumbing.** The chain is `NewGamePage.start` → `storePendingNewGame` (`newGame.ts:51`) → reload → `consumePendingNewGame` / `readPendingNewGame` (`newGame.ts:77`, validates every field) → `App.tsx:88` boot → `Game` → `useSimBridge({ … })` (`App.tsx:125`) → `init` command (`useSimBridge.ts:111`) → `SimEngine.applyCommand('init')` (`engine.ts:70`, free branch). Agents take the same path: `start_new_city` → `ctx.startNewCity(NewCityOptions)` (`tools.ts:51`) → `startNewCityFromTool` (`App.tsx:235`) → `storePendingNewGame`. `start_new_city` (`tools.ts:1784`) duplicates the difficulty money table at `:1810`, and its description says "48, 64 or 96" although the enum has 128.

**Export JSON.** `saveToJson` / `saveFromJson` (`src/storage/serialization.ts:79`, `:228`) list the fields one by one. Add `sandbox` there. Another branch fixes the other dropped fields.

**e2e.** Everything lives in `e2e/game.spec.ts`. The new-game pattern is at line 50 (`new-game` → `new-game-page` → `start-city`). The `window.voltopia` agent-call helper is at line 579, and it needs no WebGL. The speed test is at line 239 and uses `readTick` on `tick-counter`.

## Review Focus

1. The pin runs after every command and at the end of every tick, and nowhere else. A sandbox city never ends a tick or a command off `BALANCE.sandbox.treasury`. A normal city is bit-for-bit unchanged (Task 2).
2. Budget lines in sandbox are non-zero and equal what the same city books without sandbox on the same tick (Task 2).
3. No credit, no grant, rating stays A, no goal is ever added to `goalsAchieved`, and no victory screen (Task 3).
4. Old saves and scenario saves load with `sandbox = false`. A JSON export round trip keeps the flag (Task 2).
5. The agent `spent` figure is never a misleading 0 in sandbox (Task 6).
6. The fourth speed button does not break the HUD layout at phone widths. The e2e test "HUD islands never overlap" covers this (Task 1).

---

### Task 1: Speed 6x

**Files:**

- Modify: `src/shared/types.ts` (`SPEEDS`, `Speed`), `src/shared/constants.ts` (`tickIntervalMs`), `src/sim/worker.ts` (`reschedule`), `src/sim/engine.ts` (`setSpeed` guard), `src/ui/SpeedControls.tsx`, `src/ui/DiagnosticsPanel.tsx`, `src/ui/i18n.tsx`, `src/ui/app.css` (only if the row needs it), `src/agent/tools.ts` (`set_speed`, `advance_time`, `get_build_catalog`), `src/agent/tools.test.ts`, `src/sim/engine.test.ts`, `docs/agent-tools.md`, `docs/idea.md:39`, `docs/plan.md:20`
- Create: `src/shared/constants.test.ts`

**Interfaces:**

```ts
// src/shared/types.ts (replaces `export type Speed = 0 | 1 | 3;`)
export const SPEEDS = [0, 1, 3, 6] as const;
export type Speed = (typeof SPEEDS)[number];

// src/shared/constants.ts, next to TICK_MS
/** Real-time milliseconds between ticks at `speed`; null while paused. */
export function tickIntervalMs(speed: Speed): number | null {
  return speed === 0 ? null : TICK_MS / speed;
}
```

- `worker.ts` `reschedule`: `const interval = tickIntervalMs(engine.state.speed); if (interval === null) return;`. `setInterval` accepts the fractional 41.67.
- `engine.ts` `case 'setSpeed'`: `if (SPEEDS.includes(command.speed)) state.speed = command.speed;`. This hardens the boundary, because the main thread posts what it likes.
- `SpeedControls.tsx`: add `{ value: 6, label: '▶▶▶▶', title: 'speed.veryFast' }`.
- `DiagnosticsPanel.tsx`: `const budgetMs = tickIntervalMs(stats?.speed ?? 1) ?? TICK_MS;`. Compute `tickShare` against `budgetMs` and show `({Math.round(budgetMs)} ms)`. Update the doc comment ("against the 250 ms it has" → "against the interval of the current speed").
- i18n: `'speed.veryFast': 'Very fast (6x)'` / `'Sehr schnell (6x)'`.
- Agent:
  - `set_speed`: description "… 3 is fast, 6 is very fast", `enum: [...SPEEDS]`, check `SPEEDS.includes(speed as Speed)` with the message `"speed" must be one of 0, 1, 3, 6`.
  - `get_build_catalog`: `speeds: [...SPEEDS]`.
  - `advance_time`: `setSpeed` 6 when paused. Description: "Runs at very fast speed (6x) if the game is paused …".
- `docs/agent-tools.md`: `set_speed` row "0 (pause), 1, 3, 6". `advance_time` row unchanged in meaning. `docs/idea.md:39` and `docs/plan.md:20` change "1×, 3×" to "1×, 3×, 6×".

**Steps:**

- [ ] Write the failing tests first:
  - `constants.test.ts`: `tickIntervalMs(0) === null`, `tickIntervalMs(1) === TICK_MS`, `tickIntervalMs(6)` ≈ 41.67.
  - `engine.test.ts`: `setSpeed` 6 sets `state.speed` to 6, and `setSpeed` 2 (cast) leaves it unchanged.
  - `tools.test.ts`: `set_speed { speed: 6 }` → ok and `engine.state.speed === 6`. `{ speed: 2 }` is still rejected. The catalog's `speeds` equals `[0, 1, 3, 6]`. Update the existing `advance_time` test (around line 598) if it asserts the intermediate speed 3.
- [ ] Implement.
- [ ] Load the app (`pnpm dev`, or `node scripts/smoke.mjs` in the sandbox) and check the speed row. Narrow the button padding in `.speed-controls button` (`app.css:504`) only if the plate wraps.
- [ ] `pnpm typecheck && pnpm test` green. `pnpm format`. Commit `feat: 6x simulation speed`.

---

### Task 2: Sandbox core — state, BALANCE, pin, init, save, stats

**Files:**

- Create: `src/sim/sandbox.ts`, `src/sim/sandbox.test.ts`
- Modify: `src/shared/constants.ts` (`BALANCE.sandbox`), `src/shared/types.ts` (`SaveGame.sandbox?`, `GlobalStats.sandbox`), `src/shared/messages.ts` (`init.sandbox?`), `src/sim/state.ts` (`SimState.sandbox`, `createSimState`, `serializeState`, `deserializeState`), `src/sim/tick.ts` (`stepTick`, `buildStats`), `src/sim/engine.ts` (`applyCommand` → `dispatch` + pin, free-city `init`), `src/storage/serialization.ts` (`SaveGameJson`, `saveToJson`, `saveFromJson`), `src/storage/serialization.test.ts`, `src/sim/engine.test.ts`, `src/sim/state.test.ts`

**Interfaces:**

```ts
// src/shared/constants.ts — inside BALANCE, right after startingMoney
sandbox: {
  /**
   * The treasury a sandbox city is pinned to after every tick and
   * command: far above any single cost (the dearest plant is 5_000, a
   * full 128 map of avenues well under 1e6) and far below where float
   * sums of per-tick flows lose precision (2^53 ≈ 9e15).
   */
  treasury: 1_000_000_000,
},

// src/sim/sandbox.ts
import { BALANCE } from '../shared/constants.ts';
import type { SimState } from './state.ts';

/**
 * Sandbox cities never run out of money: the treasury is reset to
 * BALANCE.sandbox.treasury after every command and at the end of every
 * tick. Costs and flows are booked exactly as in a normal city, so the
 * budget lines stay honest; only the balance is pinned.
 */
export function pinSandboxTreasury(state: SimState): void {
  if (state.sandbox) state.money = BALANCE.sandbox.treasury;
}

// src/shared/messages.ts, init body
/** Free play with the treasury pinned (new free cities only; scenarios ignore it). */
sandbox?: boolean;

// src/shared/types.ts
// SaveGame:    /** Sandbox city (absent in older saves → false). */ sandbox?: boolean;
// GlobalStats: /** Sandbox city: unlimited money, no finance, no goals. */ sandbox: boolean;
// SimState:    /** Founded as a sandbox (free play only); fixed for the city's life. */ sandbox: boolean;
```

- `createSimState` (`state.ts:702`): `sandbox: false`.
- `serializeState` (`state.ts:1346`): `...(state.sandbox ? { sandbox: true } : {})`. Writing it only when true keeps existing save fixtures and `toEqual` checks stable.
- `deserializeState` (`state.ts:1444`): `state.sandbox = save.sandbox === true && !save.scenario;`, then `pinSandboxTreasury(state)` once the money is set. This repairs a hand-edited sandbox save with a small balance.
- `engine.ts`:

  ```ts
  applyCommand(command: SimCommand): SimEvent[] {
    const events = this.dispatch(command);
    // After the command, on whatever state it left (init replaces it).
    pinSandboxTreasury(this.state);
    return events;
  }
  private dispatch(command: SimCommand): SimEvent[] { /* the current switch, unchanged */ }
  ```

  In the free-city `init` branch (`engine.ts:70`), after `disasterScale`, add `this.state.sandbox = command.sandbox === true;`. The scenario and save branches do not read it.

- `stepTick` (`tick.ts:115`): after `recordLifetime(...)`, add `pinSandboxTreasury(state);` with the comment `// Last: every flow of the tick is booked, the next tick starts pinned.`
- `buildStats` (`tick.ts:214`): `sandbox: state.sandbox`.
- `serialization.ts`: add `sandbox?: boolean` to `SaveGameJson`. `saveToJson`: `...(save.sandbox !== undefined ? { sandbox: save.sandbox } : {})`. `saveFromJson`: `...(parsed.sandbox === true ? { sandbox: true } : {})`.

**Steps:**

- [ ] Write the failing tests in `src/sim/sandbox.test.ts`. Use `createSimState(seed, 32)`, set `state.sandbox = true`, call `pinSandboxTreasury`, and build through the sim functions (`buildRoads`, `placePlant`, `paintZones`) or a headless `SimEngine` with `init { sandbox: true }`:
  - pin is a no-op when `sandbox` is false (money unchanged);
  - after `init { sandbox: true }` money equals `BALANCE.sandbox.treasury`;
  - a build costing more than `BALANCE.startingMoney` in total succeeds through `applyCommand`. Example: wind turbines until the sum exceeds 40_000. Money is pinned after each command.
  - `undo` refunds and stays pinned;
  - after one `engine.tick()` with roads, plants and an energy deficit (no plants, so imports happen), money is pinned and `stats.budget.gridUpkeep`, `plantUpkeep` and `gridImportCost` are > 0;
  - **flow parity:** clone the same city with and without sandbox (same seed and builds, the non-sandbox one with ample money via `createSimState(seed, 32, BALANCE.sandbox.treasury)`). Step both 50 ticks. `buildStats(a).budget` deep-equals `buildStats(b).budget`.
  - repairs: set `layers.damage[i] = 50` on a few building tiles, run `repairStep`, and `lastRepairCost > 0`. After `stepTick`, money is pinned.
  - a full day (`TICKS_PER_DAY` ticks on 32×32) ends pinned and records one lifetime sample.
- [ ] Add these tests to `engine.test.ts` / `state.test.ts`:
  - save round trip keeps `sandbox` and money;
  - a save without `sandbox` loads `false`;
  - a save with `sandbox: true` and a `scenario` loads `false`;
  - `init { scenario: 'island', sandbox: true }` → `state.sandbox === false`;
  - `init` with a `save` ignores `command.sandbox`.
- [ ] `serialization.test.ts`: the JSON round trip keeps `sandbox: true`, and `sandbox: "yes"` is dropped.
- [ ] Implement. `pnpm typecheck` flags every `GlobalStats` literal that needs `sandbox` (search the test fixtures).
- [ ] Green, format, commit `feat(sim): sandbox cities with a pinned treasury`.

---

### Task 3: Finance and goals in sandbox

**Files:** Modify `src/sim/finance.ts`, `src/sim/goals.ts`, `src/ui/i18n.tsx` (`rejection.sandbox`), tests in `src/sim/finance.test.ts`, `src/sim/goals.test.ts`.

- `creditOfferRejection` (`finance.ts:88`): first line `if (state.sandbox) return 'sandbox';`. `takeCredit` therefore rejects with `sandbox`, and `financeStats.offers[*].available[*]` reads `'sandbox'`.
- `creditRate` stays as is. The rating never leaves A (next point).
- `grantRemaining` (`finance.ts:161`): `if (state.sandbox) return 0;`. `plantPrice` then returns `grant 0, net = gross` with no further branch. `financeStats.grantRemaining` is 0, so the BuildBar shows no struck-through grant price.
- `financeStep` (`finance.ts:235`):
  - Grid-fee income is still booked, because it is a real budget line.
  - The credit loop is empty anyway.
  - Guard the overdraft block with `!state.sandbox`.
  - On day rollover in sandbox, still `rollGrantYear` and reset `dayIncome`, but do not touch `incomeWindow`, `overdraftDays` or `rating`. Rating stays `'A'`.
  - `lastFinance` is written as usual.
- `goalsStep` (`goals.ts:55`): `if (state.sandbox) return;` as the first line. Nothing else reads `goalProgress` (verified by grep: only `goals.ts` and `state.ts` save/load). Skipping the counters is safe, and they stay 0 in the save.
- `goalStates` (`goals.ts:306`): `if (state.sandbox) return [];`. With an empty list, `EndScreen`'s free-play victory (`goals.length > 0 && every achieved`) can never fire, and agents see no goal list.
- i18n: `'rejection.sandbox': 'No credit needed in sandbox mode'` / `'Im Sandbox-Modus braucht es keinen Kredit'`.

**Steps:**

- [ ] Write the failing tests:
  - finance:
    - `takeCredit` in sandbox → `{ rejected: 'sandbox' }` and no credit is added;
    - every offer amount is `'sandbox'`;
    - `plantPrice` of a solar farm in sandbox equals gross (`grant 0`) and leaves `grantUsedThisYear` at 0 after `placePlant`;
    - with `money` forced negative before `financeStep` in sandbox, `overdraftInterest` is 0;
    - after a day rollover in sandbox, rating is `'A'` and `incomeWindow` is empty;
    - grid fee 0.01 in sandbox still books `lastFinance.gridFeeIncome > 0`.
  - goals: a sandbox state set up to satisfy an easy goal (reuse the setup of an existing `goals.test.ts` case) stays unachieved after `goalsStep`, and `goalStates` is `[]`.
- [ ] Implement.
- [ ] Green, format, commit `feat(sim): no credit, grant, rating or goals in sandbox cities`.

---

### Task 4: New-game dialog and plumbing

**Files:** Modify `src/ui/newGame.ts`, `src/ui/newGame.test.ts`, `src/ui/NewGamePage.tsx`, `src/ui/useSimBridge.ts`, `src/ui/App.tsx` (`useSimBridge` call at `:125`), `src/ui/i18n.tsx`, `src/ui/app.css`.

- `NewGameOptions.sandbox?: boolean`. `DEFAULT_NEW_GAME` has no sandbox. `readPendingNewGame` returns `...(parsed.sandbox === true && !scenario ? { sandbox: true } : {})`, so a scenario start never carries it.
- `SimBridgeOptions.sandbox?: boolean`. The `init` command gets `...(options.sandbox ? { sandbox: true } : {})`.
- `App.tsx` `Game`: pass `sandbox: options.sandbox` only when `save === null`. A loaded save keeps its own flag, the same way `scenario` is gated today (`App.tsx:131`). The `init` save branch ignores it anyway, but do not send it.
- `NewGamePage.tsx`:
  - `const [sandbox, setSandbox] = useState(false)`.
  - A checkbox section between "map size" and "difficulty": `<label className="option-toggle"><input type="checkbox" data-testid="sandbox-toggle" checked={sandbox} onChange={…} /> {t('newGame.sandbox')}</label>`.
  - Switching it on calls `setDisasters(0)` (the player can turn disasters back on). Switching it off leaves the disaster choice alone.
  - While sandbox is on, the difficulty buttons are `disabled` and a hint `newGame.sandbox.hint` is shown.
  - `start()` stores `{ …, ...(sandbox ? { sandbox: true } : {}) }`.
- i18n (EN / DE):
  - `'newGame.sandbox': 'Sandbox – unlimited money, no goals'` / `'Sandbox – unbegrenztes Geld, keine Ziele'`
  - `'newGame.sandbox.hint': 'Difficulty does not apply: money is unlimited. Disasters are off by default but can be switched on.'` / `'Die Schwierigkeit entfällt: Geld ist unbegrenzt. Katastrophen sind zunächst aus, lassen sich aber einschalten.'`
- CSS: style `.option-toggle` like the existing `option-row` / `smart-charging-toggle` controls. Disabled difficulty buttons look muted.

**Steps:**

- [ ] Write the failing tests in `newGame.test.ts` (pattern: the existing pending-options tests):
  - stored `{ sandbox: true }` is read back;
  - `sandbox: "yes"` is dropped;
  - a stored scenario with `sandbox: true` drops the flag;
  - options without sandbox read back without the key.
- [ ] Implement.
- [ ] `pnpm typecheck && pnpm test` green. `node scripts/smoke.mjs` if it runs in the sandbox. Format. Commit `feat(ui): sandbox option in the new-game dialog`.

---

### Task 5: Sandbox displays — ∞, badge, finance, statistics, goals, saves

**Files:** Modify `src/ui/CityVitals.tsx`, `src/ui/TimeControls.tsx`, `src/ui/BudgetPanel.tsx`, `src/ui/HudConsole.tsx`, `src/ui/StatsPage.tsx`, `src/ui/GoalsPanel.tsx`, `src/ui/App.tsx`, `src/ui/SavesPage.tsx`, `src/storage/storage.ts` (`SaveSummary.sandbox?`), `src/storage/summary.ts`, `src/storage/summary.test.ts`, `src/ui/i18n.tsx`, `src/ui/app.css`.

- `CityVitals.tsx:32`: when `stats.sandbox` is set, render `∞ {CURRENCY}` with `title={t('hud.funds.unlimited')}`. Keep `data-testid="money"`.
- `TimeControls.tsx:39`: right after `<Clock …/>`, add `{stats.sandbox && <span className="sandbox-badge" data-testid="sandbox-badge">{t('hud.sandbox')}</span>}`.
- `BudgetPanel`: new prop `sandbox: boolean`. When it is set, do not mount `FinancePanel`. That hides rating, debt, credits, offers and the grant pot. The repayment line is 0 and already hidden. `HudConsole.tsx:85` passes `sandbox={stats.sandbox}`. The tax and grid-fee sliders stay.
- `StatsPage`: new prop `sandbox: boolean` (`App.tsx:466` passes `bridge.stats?.sandbox ?? false`). When it is set, the money `Chart` is not rendered.
- `GoalsPanel`: new prop `sandbox?: boolean` (`App.tsx:370` passes `stats.sandbox`). When it is set, the header reads `🏆 {t('goals.title')}` without a count and the open list shows `<p data-testid="goals-sandbox">{t('goals.sandbox')}</p>`. The toast effect sees `goals = []` and stays quiet.
- `SaveSummary.sandbox?: boolean`. `summarizeSave` adds `...(save.sandbox ? { sandbox: true } : {})`. `storedSummary` in `catalog.ts` spreads it through. Old summary rows lack it, which means false. `SavesPage.tsx:300` shows `∞ ⌁` for the money field when `summary.sandbox` is set.
- i18n (EN / DE):
  - `'hud.sandbox': 'Sandbox'` / `'Sandbox'`
  - `'hud.funds.unlimited': 'Unlimited money (sandbox)'` / `'Unbegrenztes Geld (Sandbox)'`
  - `'goals.sandbox': 'Goals are off in sandbox mode.'` / `'Ziele sind im Sandbox-Modus aus.'`
- CSS: `.sandbox-badge` is a small pill in the HUD accent colour next to the clock.

**Steps:**

- [ ] Write the failing tests in `summary.test.ts`: a sandbox save summarises with `sandbox: true`, and a normal save has no key (existing `toEqual` checks stay green).
- [ ] Implement.
- [ ] `pnpm typecheck && pnpm test`. Smoke-check the HUD row with the badge plus four speed buttons at a narrow width (the e2e "HUD islands never overlap" test runs in Task 7). Format. Commit `feat(ui): show unlimited money and hide finance and goals in sandbox`.

---

### Task 6: Agent tools and docs

**Files:** `src/agent/tools.ts`, `src/agent/tools.test.ts`, `src/ui/App.tsx` (`startNewCityFromTool` needs no change if it spreads `options`; verify), `docs/agent-tools.md`.

- `NewCityOptions.sandbox?: boolean` (`tools.ts:51`).
- `start_new_city` (`tools.ts:1784`):
  - Import `DIFFICULTIES` from `../ui/newGame.ts` next to `DISASTER_LEVELS` and `MAP_SIZES`. Replace the inline table at `:1810` with `DIFFICULTIES.find((d) => d.id === difficulty)!.startingMoney`, and the enum with `DIFFICULTIES.map((d) => d.id)`.
  - Describe sizes as `${MAP_SIZES.join(', ')}` and use `enum: [...MAP_SIZES]`. This fixes "48, 64 or 96".
  - Add the property `sandbox: { type: 'boolean', description: 'Unlimited money, no credit, grant or goals; disasters default to off.' }`. Read it with `readBoolean` when present, default false.
  - The disasters default is `sandbox ? 'off' : 'normal'`.
  - Pass `...(sandbox ? { sandbox: true } : {})` to `ctx.startNewCity`. The result echoes `sandbox`.
- `get_game_overview` (`tools.ts:706`): add `sandbox: s.sandbox` next to `money`. The description adds: "sandbox: money is pinned at a huge value (unlimited); finance offers are refused with `sandbox` and goals are off".
- `spent()` (`tools.ts:1957`):

  ```ts
  function spent(
    ctx: AgentContext,
    before: number,
  ): { spent: number; money: number } | { sandbox: true } {
    const stats = ctx.getStats();
    // The treasury is pinned in sandbox, so a money delta would read 0.
    if (stats?.sandbox) return { sandbox: true };
    const money = stats?.money ?? before;
    return { spent: Math.round(before - money), money: Math.round(money) };
  }
  ```

  `undo` (`:1407`) returns `{ sandbox: true }` instead of `refunded` in sandbox. `place_plant`'s `grant` is 0 in sandbox by itself.

- `take_credit` description: append "In a sandbox city every credit is refused with `sandbox`."
- `docs/agent-tools.md`:
  - `start_new_city` row: sizes 48/64/96/128 (already right), `sandbox` (default false; disasters then default off).
  - `get_game_overview` row: `sandbox`.
  - `take_credit` row: rejection `sandbox`.
  - Build tools: "in sandbox, results carry `sandbox: true` instead of `spent`/`money`".

**Steps:**

- [ ] Write the failing tests:
  - `start_new_city { sandbox: true }` → host options `{ size: 64, startingMoney: BALANCE.startingMoney, seed: null, disasterScale: 0, sandbox: true }`;
  - `{ sandbox: true, disasters: 'mild' }` → `disasterScale: 0.5`;
  - without sandbox, the existing `toEqual` expectations are unchanged (no key);
  - `difficulty: 'easy'` → `startingMoney` equals `DIFFICULTIES[0].startingMoney`;
  - `size: 128` is accepted;
  - with a harness engine inited `{ sandbox: true }`: the overview shows `sandbox: true`, `build_road` returns `{ ok: true, sandbox: true }`, `take_credit loan 5000` → `ok: false` with reason `sandbox`;
  - the existing read-only/consequential tool count tests stay green (no new tool).
- [ ] Implement, update the docs, format, commit `feat(agent): sandbox option for start_new_city, sandbox in the overview`.

---

### Task 7: End-to-end test and docs

**Files:** `e2e/game.spec.ts`, `docs/idea.md` (line ~400, "Difficulty and sandbox modes"), `docs/plan.md`, `README.md` (feature list).

- [ ] Add `test('a sandbox city builds beyond any starting money and runs at 6x', …)` after the new-game test (`e2e/game.spec.ts:50`). It needs no WebGL:
  1. `new-game` → `sandbox-toggle` check. Expect `disasters-off` to have class `active` and `difficulty-easy` to be disabled. Then `size-48` → `start-city`.
  2. Expect `money` to contain `∞`, and `sandbox-badge` to be visible.
  3. Use the `window.voltopia` `call` helper (copy the pattern from line 579): `find_tiles { kind: 'empty_land', near: { x: 24, y: 24 }, limit: 30 }`, then `place_plant { plant: 'wind', x, y }` until 10 are accepted (10 × 4_500 = 45_000 > the easy 40_000). Assert 10 accepted and that each result has `sandbox: true`. `money` still contains `∞`.
  4. `take_credit { kind: 'loan', amount: 5000 }` → `ok: false`.
  5. Speed: `speed-6` click → it has class `active`. `readTick` grows by more than 12 within 1.5 s. 6x gives about 36 ticks, 3x would give about 18, so the margin is generous for CI.
  6. Reload. `money` still contains `∞` (the flag survives the autosave).
  - `test.setTimeout(90_000)`.
- [ ] Extend the pause/play test (line 239) to also click `speed-6` and assert the `active` class.
- [ ] Run against the sandbox Chromium (temp config in /tmp) if possible. Otherwise note that it needs the Mac or CI. The "HUD islands never overlap" test must pass with the fourth speed button and the badge.
- [ ] Docs:
  - `docs/idea.md`: mark "Difficulty and sandbox modes" as done (sandbox + 6x; difficulty already existed).
  - `docs/plan.md`: one line for the feature, linking the spec.
  - README: one feature-list line.
- [ ] Format, commit `test(e2e): sandbox city with unlimited money and 6x speed`.

## Self-review notes

- The pin keeps the sim free of `if (sandbox)` at the dozen build sites. The only sandbox branches are `creditOfferRejection`, `grantRemaining`, `financeStep` (overdraft and rating), `goalsStep` and `goalStates`.
- Pinning after `stepTick` (not before) means goals, scenarios and the lifetime sample see real per-tick flows. Pinning in `applyCommand` covers creation, load (also pinned in `deserializeState`), every build, undo and insulation with one call.
- Flow parity (Task 2) proves the budget is unchanged by sandbox, which is the spec's "verify per line" requirement. The research table above shows why it holds.
- **Spec deviations and additions:**
  1. The spec's e2e step "build a plant that costs more than the easy starting money" is impossible, because the dearest plant is the hydrogen plant at 5_000. Task 7 places 10 wind turbines (45_000 total) instead.
  2. The agent build tools' `spent` is a money delta, which the spec did not anticipate. In sandbox they return `sandbox: true` instead (Task 6).
  3. The saves list also shows the treasury. It gets ∞ through `SaveSummary.sandbox` (Task 5).
  4. `goalStates` returns `[]` in sandbox (not an all-false list), so the free-play victory screen cannot fire and the agent overview has no goal list.
  5. `start_new_city` defaults disasters to off when `sandbox` is set, mirroring the dialog's preset.
- **Open questions:**
  - Should a sandbox city still record the money lifetime sample? It is ≈ 1e9 and hidden in the UI. The plan keeps it for simplicity.
  - The `get_lifetime_stats` tool still returns it alongside `sandbox` in the overview.
