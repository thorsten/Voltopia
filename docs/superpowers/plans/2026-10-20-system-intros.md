# Guided introductions for the later systems — plan

Spec: `docs/superpowers/specs/2026-10-20-system-intros-design.md`.
Branch `feature/system-intros`. UI only; every task ends with
`pnpm format && pnpm typecheck && pnpm lint && pnpm test` green and one
commit.

## Task 1 — intro definitions and trigger logic (`src/ui/intros.ts`)

- Move the step shape out of `Tutorial.tsx` into a shared
  `src/ui/coachSteps.ts`: `export interface CoachStep { id; title;
body; isComplete?(stats) }` (Tutorial imports it).
- `src/ui/intros.ts`:
  - `export const INTRO_TUNING = { smartMetersMinPopulation: 150,
eveningStartHour: 17, eveningEndHour: 22, heatingShare: 0.15,
sustainTicks: 40, meterCoverageStep: 0.1 }` (sustain = one in-game
    hour, `TICKS_PER_DAY / 24`).
  - `export type IntroId = 'smartMeters' | 'demandResponse' | 'islands'
| 'hydrogen' | 'heat'`; `export const INTROS: Intro[]` in spec table
    order, each `{ id, trigger(stats): boolean, steps: CoachStep[] }`
    exactly per the spec table. Total consumption for the heat share =
    sum of `energy.consumption` fields the energy panel sums (see
    `EnergyPanel.tsx`), guard divide-by-zero.
  - Sustain tracker: `export interface IntroTriggerState { lastTick:
number; held: Record<IntroId, number> }`, `createIntroTriggerState()`,
    `nextIntroToShow(state, stats, seen: ReadonlySet<IntroId>):
IntroId | null` — counts consecutive ticks (by `stats.tick` delta,
    so a duplicate stats object for the same tick does not double
    count; a false trigger resets to 0), returns the first unseen intro
    whose counter reached `sustainTicks`. Mutates `state`.
  - `firstOpenStep(intro, stats): number` — index of the first step
    whose `isComplete` is false or absent (= steps.length when all done).
  - Seen storage: `loadSeenIntros(): Set<IntroId>` (key
    `voltopia.introsSeen`, JSON array, unknown ids dropped, corrupt →
    empty), `markIntroSeen(id)`, `resetSeenIntros()`; plus
    `resetTutorial()` in `Tutorial.tsx` (removes `voltopia.tutorialDone`).
- `src/ui/settings.ts`: `introsEnabled: boolean` (default true, loaded
  with `??`); extend `settings.test.ts`.
- `src/ui/intros.test.ts`: per intro trigger true/false on crafted stats
  (build a minimal `GlobalStats` fixture helper — reuse one if a test
  already has it, grep `GlobalStats` in `src/ui/*.test.ts`); sustain
  counting, reset on a false tick, same-tick no double count; priority;
  seen skipped; `firstOpenStep`; storage corrupt/unknown ids.
- i18n: all `intro.<id>.<n>.title/body` keys (EN + DE), `intro.close`.
  Bodies: 1-3 sentences, correct energy terminology, name the HUD
  control the player must use (check the real labels in i18n).

## Task 2 — card, App wiring, help and settings

- Extract the card markup of `Tutorial.tsx` into `CoachCard`
  (`src/ui/CoachCard.tsx`: progress, title, body, Next/waiting, a
  secondary button with label + testId). Tutorial uses it unchanged in
  behaviour/testids (`tutorial`, `tutorial-next`, `tutorial-skip`).
- `src/ui/IntroCoach.tsx`: given `stats`, `introId`, `onFinished`; starts
  at `firstOpenStep`, auto-advances like the tutorial, marks seen on
  finish/close. Testids `intro`, `intro-next`, `intro-close`,
  `data-intro={id}`.
- `App.tsx`: hold a `useRef(createIntroTriggerState())` and
  `activeIntro` state. In an effect on `stats`: if no intro active,
  tutorial not showing, no `page` open, `settings.introsEnabled` →
  `nextIntroToShow`; set it. Render `IntroCoach` where the tutorial
  renders. Manual starts (help page) bypass enabled/seen.
- `HelpPage.tsx`: new first-level section "Introductions" with a Start
  button per intro + one for the base tutorial, and "Reset
  introductions". Props `onStartIntro(id)`, `onStartTutorial()`,
  `onResetIntros()`; App closes the page on start.
- `SettingsPage.tsx`: checkbox "Show introductions" bound to
  `introsEnabled`.
- i18n EN + DE for `help.intros.*`, `settings.intros*`.

## Task 3 — e2e, docs

- `e2e/game.spec.ts` beforeEach: also set `voltopia.introsSeen` to all
  five ids (unless an opt-in marker). New test: open help, start the
  smart-meter intro, card visible with `data-intro="smartMeters"`,
  close it, gone. Run e2e if possible in the sandbox (see memory:
  temp Playwright config with /usr/bin/chromium); otherwise note it.
- `docs/idea.md`: mark "Onboarding for the later systems" done with a
  short description. Help text for controls if it lists help-page
  features.
