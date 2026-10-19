# Sandbox mode — Design

Date: 2026-10-19
Status: draft for review

## Goal

Free play always runs on a budget. A player who wants to try out a
layout, test the energy system or just build without pressure has no
way to switch money off. The new-game dialog already offers
"disasters off", but there is no way to play without money limits, and
time runs at most at 3x.

This feature adds a **sandbox** option to new free-play cities and a
new **6x** speed for every game.

## Decisions (with the user, 2026-10-19)

- **Free building, treasury shown as ∞** (rejected: topping up a huge
  visible balance). Building never fails for lack of money. The budget
  lines keep running so the statistics still show income and
  expenses. Credits, rating and the investment grant are hidden, and
  goals do not count.
- **New speed step 6x for every game** (rejected: 6x for sandbox only;
  10x with several ticks batched per message). A tick on a grown 128
  map costs about 23 ms, which leaves about 19 ms of headroom in a
  42 ms interval.
- The disaster dial stays independent. Choosing sandbox presets it to
  "off", but the player can turn disasters back on to test them.

## Scope

In: sandbox flag on `SimState` and in saves, the money pin, finance
and goals in sandbox, new-game dialog, ∞ display, speed 6x
(sim, UI, agent), the `start_new_city` agent option and its docs,
i18n (en + de), unit and e2e tests.

Out: switching sandbox on or off in a running city (it would let a
player earn goals for free), sandbox scenarios, unlimited-money cheats
in normal games, faster speeds than 6x, tick batching.

## Simulation

### State and save

- `SimState.sandbox: boolean` (default `false`).
- `SaveGame.sandbox?: boolean`. A missing value loads as `false`, so
  there is no `SAVE_VERSION` bump.
- The `init` worker message gains `sandbox?: boolean`. It only applies
  on the free-city branch of `SimEngine`; scenarios ignore it.

### Money pin

Sandbox does not change any cost check at the build sites (roads.ts,
energy.ts, zones.ts, …). Instead the treasury is pinned:

- `BALANCE.sandbox.treasury = 1_000_000_000`. This is far above any
  single cost and far below the range where floating-point sums lose
  precision.
- `pinSandboxTreasury(state)` sets `state.money = BALANCE.sandbox.treasury`
  when `state.sandbox` is set. It runs:
  - on creation,
  - at the end of every tick,
  - after every command that changes money (in the engine's command
    dispatch, once, after the command is applied).
- With the pin in place, every existing `cost > state.money` check
  passes. Spending capped by the balance (smart meters, disaster
  repairs) runs at full rate. Overdraft never happens.
- Budget lines and daily income/expense statistics are computed exactly
  as today. They come from the flows, not from the money delta.
  Verify this per line in the plan; any line derived from a money delta
  has to switch to the flow.

### Finance, goals and growth

- `takeCredit` is rejected with a new reason `sandbox`. The rating is
  frozen at A, and `financeStep` skips rating and overdraft bookkeeping
  in sandbox.
- No grant is paid out: `plantPrice` returns the full price in sandbox
  so the build cost statistics stay honest.
- Free-play goals are not evaluated (`goals.ts` skips while `sandbox`),
  so no celebrations are triggered.
- Taxes and the grid fee keep their effect on happiness. In sandbox
  they only do something through happiness, which is fine.

### Stats

`GlobalStats.sandbox: boolean` so the UI can show ∞. Agents get the
same flag in the city overview.

## Speed 6x

- `Speed = 0 | 1 | 3 | 6` (src/shared/types.ts). The worker interval is
  `TICK_MS / speed`, which is 41.67 ms; `setInterval` accepts fractional
  values.
- `SpeedControls`: a fourth button labelled `▶▶▶▶`
  (`speed.veryFast`: "Very fast (6x)" / "Sehr schnell (6x)"). Any
  keyboard shortcuts for speed get a matching key. The plan has to
  check whether such shortcuts exist.
- `DiagnosticsPanel` computes the tick share against `TICK_MS / speed`
  instead of `TICK_MS`.
- Agent `set_speed`: the enum becomes 0/1/3/6. `advance_time` uses 6
  when it has to unpause.
- Saves store `speed`? The plan checks this. If they do, the save
  validators must accept 6.

## UI

- **New-game dialog** (NewGamePage.tsx): a "Sandbox" toggle
  ("Sandbox – unlimited money, no goals" / "Sandbox – unbegrenztes
  Geld, keine Ziele"). When it is on, the difficulty choice
  (starting money) is disabled and the disaster dial jumps to "off"
  (the player can still change it). `NewGameOptions.sandbox` is passed
  through `storePendingNewGame` → `init`.
- **Money display** (CityVitals and anywhere else that shows the
  treasury): "∞" when `stats.sandbox` is set. A small "Sandbox" badge
  sits next to the day display.
- **Finance panel:** the credit and rating section is hidden in
  sandbox. The tax and grid-fee sliders stay.
- **Statistics page:** the money series is hidden in sandbox (it would
  be a flat line at 1e9).
- **Goals panel:** in sandbox it shows "Goals are off in sandbox
  mode".
- The insulation button and other `stats.money < cost` checks in the
  UI work unchanged because the money is pinned.

## Agent tools

- `start_new_city` gains `sandbox?: boolean`. In the same change, fix
  two problems: the duplicated starting-money table (use
  `DIFFICULTIES`) and the description, which lists sizes "48, 64 or 96"
  although the enum includes 128.
- The city overview reports `sandbox`.
- `take_credit` returns the rejection `sandbox`.
- docs/agent-tools.md is updated to match.

## Tests

- Sim: money stays pinned after building, upkeep, imports, disaster
  repairs and a full day. Budget lines are non-zero. `takeCredit`
  is rejected. Goals do not complete. A save/load round trip keeps the
  flag, and an old save loads with `false`.
- Speed: the worker reschedules for 6x; the agent `set_speed` accepts 6.
- UI/e2e: start a sandbox city, build a plant that costs more than
  the easy starting money, ∞ is visible, and the 6x button works.

## Risks

- A money-delta-based statistic would show 0 in sandbox. The pin runs
  after the tick, so per-tick deltas inside the tick are real; check
  the statistics code that reads `state.money` across ticks.
- 6x on 128 maps on slow machines: `setInterval` piles up and the game
  simply runs slower than 6x. This is acceptable; the diagnostics panel
  shows it.
