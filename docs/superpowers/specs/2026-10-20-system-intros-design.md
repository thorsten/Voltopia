# Guided introductions for the later systems — design

Date: 2026-10-20 · Status: draft, awaiting approval

## Goal

The first-run tutorial (`src/ui/Tutorial.tsx`) covers roads, zones,
power, grid, substation, rail and growth. The later systems — smart
meters, demand response, grid islands, hydrogen and the heat sector —
are only explained on the help page. Each gets a short guided
introduction (2-3 steps) that **starts by itself when the system
becomes relevant** and can be **restarted from the help page**.

## Scope

UI only. No sim, protocol, save-game or agent-tool changes: every
trigger and step check reads fields `GlobalStats` already carries.

## Introductions

Each intro is `{ id, trigger(stats), steps[] }`; a step is the existing
`TutorialStep` shape (title, body, optional `isComplete(stats)`;
manual "Next" when absent). Thresholds live in one exported
`INTRO_TUNING` object in `src/ui/intros.ts` (UI tuning, not `BALANCE`).

| Intro            | Trigger (sustained, see below)                                                                              | Steps                                                                                                                                                                                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `smartMeters`    | population ≥ 150, rollout inactive, coverage 0                                                              | 1. What smart meters do (flexible load waits for cheap/green hours), start the rollout — done when `smartMeters.active`. 2. Coverage grows by installs per day, cost per meter — done when `coverage ≥ 0.1` or Next.                                                                 |
| `demandResponse` | any island `deficit > 0` or `gridImport > 0` between 17:00 and 22:00, contract inactive                     | 1. What the contract is (retainer per building, price per activation, call hours per day) — sign it: done when `demandResponse.active`. 2. Watch the first call — done when `energy.consumption.shed > 0` or Next.                                                                   |
| `islands`        | `islands.length ≥ 2`                                                                                        | 1. Why the city split (no line between the districts), what an island does alone (own generation, storage, deficit) — Next. 2. Connect them with a power line, or give each a substation — done when `islands.length === 1` or every island has `substations > 0`.                   |
| `hydrogen`       | `energy.curtailment > 0`, no hydrogen capacity                                                              | 1. Curtailment wastes surplus; an electrolyser stores it as hydrogen for windless weeks — build a hydrogen plant: done when `hydrogenCapacity > 0`. 2. Surplus feeds electrolysis, the fuel cell re-electrifies, full tanks sell — done when `consumption.electrolysis > 0` or Next. |
| `heat`           | `consumption.heating` ≥ 15 % of total consumption, no heat plant (`heatPumps == 0` and `heatCapacity == 0`) | 1. Winter heating load and why a heat pump plant beats individual heating (COP) — build a heat plant: done when `networkHeat > 0`. 2. A heat store shifts heat-pump load into surplus hours; insulation halves the load — done when `heatCapacity > 0` or Next.                      |

**Sustain**: a trigger must hold for `INTRO_TUNING.sustainTicks`
(40 ticks = one in-game hour) of consecutive stats updates, so a single
tick of curtailment or a brief split while drawing a line does not pop
a card. A pure helper `nextIntroToShow(state, stats)` tracks the
counters and returns the intro id to show (tested).

## Behaviour

- **One card at a time**, same coach-mark card as the tutorial (shared
  component extracted from `Tutorial.tsx`: progress `n/m`, title, body,
  Next / waiting, "Close"). If several triggers fire, the first in the
  table order wins; the others wait.
- **Never while the first-run tutorial runs**, never while a modal page
  is open (the card simply waits).
- **Seen once**: finishing or closing an intro records its id in
  `localStorage` `voltopia.introsSeen` (JSON array). Per browser, like
  `voltopia.tutorialDone` — the knowledge carries across cities.
- Already satisfied steps are skipped on show (e.g. a city that already
  has a substation in every island jumps to the end).
- Works in free play, sandbox and scenarios.
- **Setting** "Show introductions" (settings page, default on) turns
  the automatic start off. Stored with the other settings
  (`src/ui/settings.ts`).
- **Help page**: a new "Introductions" section lists the five with a
  "Start" button each (starts it regardless of trigger or seen state,
  closes the help page) and "Reset introductions" (clears the seen
  list). The base tutorial gets a "Start" button there too (clears
  `voltopia.tutorialDone` and shows it).

## i18n

New keys `intro.<id>.<step>.title/body`, `intro.close`,
`help.intros.*`, `settings.intros*` — English and German.

## Testing

- `src/ui/intros.test.ts`: each trigger true/false on crafted stats,
  sustain counting and reset, priority order, seen ids skipped, setting
  off returns nothing, satisfied-step skipping.
- Seen-list storage helpers (corrupt JSON → empty list).
- e2e: existing tests disable intros via the init script (like
  `voltopia.tutorialDone`); one new test starts an intro from the help
  page, sees step 1 and closes it.

## Out of scope

Highlighting/arrowing the relevant HUD control, intros for railways,
finance or policies (candidates for later), agent tools (the intros are
human-facing UI with no sim effect).
