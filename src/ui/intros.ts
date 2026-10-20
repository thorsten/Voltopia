import { TICKS_PER_DAY } from '../shared/constants.ts';
import type { GlobalStats } from '../shared/types.ts';
import type { CoachStep } from './coachSteps.ts';

/**
 * Guided introductions for the systems the first-run tutorial leaves out.
 * Each starts by itself once its trigger has held for a while and can be
 * restarted from the help page. UI only: everything reads `GlobalStats`.
 */

/** UI tuning for the intro triggers (not sim balance, so not in `BALANCE`). */
export const INTRO_TUNING = {
  /** Smart meters are worth explaining once the city has this many residents. */
  smartMetersMinPopulation: 150,
  /** Evening peak window for the demand-response trigger, in hours (start inclusive). */
  eveningStartHour: 17,
  eveningEndHour: 22,
  /** Heating share of total consumption that makes the heat sector relevant. */
  heatingShare: 0.15,
  /** A trigger must hold this many consecutive ticks (one in-game hour). */
  sustainTicks: TICKS_PER_DAY / 24,
  /** Smart-meter coverage that completes the second smart-meter step. */
  meterCoverageStep: 0.1,
} as const;

export type IntroId = 'smartMeters' | 'demandResponse' | 'islands' | 'hydrogen' | 'heat';

/** A step of an intro; `allowNext` shows the Next button although the step auto-completes. */
export interface IntroStep extends CoachStep {
  allowNext?: boolean;
}

export interface Intro {
  id: IntroId;
  /** Whether the system is relevant right now (must hold for `sustainTicks`). */
  trigger: (stats: GlobalStats) => boolean;
  steps: IntroStep[];
}

/** Total consumption as the energy panel sums it. */
function totalConsumption(stats: GlobalStats): number {
  const c = stats.energy.consumption;
  return (
    c.buildings + c.charging + c.traction + c.heating + c.cooling + c.electrolysis + c.heatPumps
  );
}

function isEvening(stats: GlobalStats): boolean {
  const hour = stats.timeOfDay * 24;
  return hour >= INTRO_TUNING.eveningStartHour && hour < INTRO_TUNING.eveningEndHour;
}

function isShort(stats: GlobalStats): boolean {
  return (
    stats.energy.deficit > 0 ||
    stats.energy.gridImport > 0 ||
    stats.islands.some((island) => island.deficit > 0 || island.gridImport > 0)
  );
}

/** All intros, in priority order (the first triggered one wins). */
export const INTROS: readonly Intro[] = [
  {
    id: 'smartMeters',
    trigger: (stats) =>
      stats.population >= INTRO_TUNING.smartMetersMinPopulation &&
      !stats.smartMeters.active &&
      stats.smartMeters.coverage === 0,
    steps: [
      {
        id: 'rollout',
        title: 'intro.smartMeters.1.title',
        body: 'intro.smartMeters.1.body',
        isComplete: (stats) => stats.smartMeters.active,
      },
      {
        id: 'coverage',
        title: 'intro.smartMeters.2.title',
        body: 'intro.smartMeters.2.body',
        isComplete: (stats) => stats.smartMeters.coverage >= INTRO_TUNING.meterCoverageStep,
        allowNext: true,
      },
    ],
  },
  {
    id: 'demandResponse',
    trigger: (stats) => !stats.demandResponse.active && isEvening(stats) && isShort(stats),
    steps: [
      {
        id: 'contract',
        title: 'intro.demandResponse.1.title',
        body: 'intro.demandResponse.1.body',
        isComplete: (stats) => stats.demandResponse.active,
      },
      {
        id: 'call',
        title: 'intro.demandResponse.2.title',
        body: 'intro.demandResponse.2.body',
        isComplete: (stats) => stats.energy.consumption.shed > 0,
        allowNext: true,
      },
    ],
  },
  {
    id: 'islands',
    trigger: (stats) => stats.islands.length >= 2,
    steps: [
      { id: 'split', title: 'intro.islands.1.title', body: 'intro.islands.1.body' },
      {
        id: 'connect',
        title: 'intro.islands.2.title',
        body: 'intro.islands.2.body',
        isComplete: (stats) =>
          stats.islands.length <= 1 || stats.islands.every((island) => island.substations > 0),
      },
    ],
  },
  {
    id: 'hydrogen',
    trigger: (stats) => stats.energy.curtailment > 0 && stats.energy.hydrogenCapacity === 0,
    steps: [
      {
        id: 'plant',
        title: 'intro.hydrogen.1.title',
        body: 'intro.hydrogen.1.body',
        isComplete: (stats) => stats.energy.hydrogenCapacity > 0,
      },
      {
        id: 'electrolysis',
        title: 'intro.hydrogen.2.title',
        body: 'intro.hydrogen.2.body',
        isComplete: (stats) => stats.energy.consumption.electrolysis > 0,
        allowNext: true,
      },
    ],
  },
  {
    id: 'heat',
    trigger: (stats) => {
      const total = totalConsumption(stats);
      return (
        total > 0 &&
        stats.energy.consumption.heating >= INTRO_TUNING.heatingShare * total &&
        stats.energy.consumption.heatPumps === 0 &&
        stats.energy.heatCapacity === 0
      );
    },
    steps: [
      {
        id: 'plant',
        title: 'intro.heat.1.title',
        body: 'intro.heat.1.body',
        isComplete: (stats) => stats.energy.networkHeat > 0,
      },
      {
        id: 'store',
        title: 'intro.heat.2.title',
        body: 'intro.heat.2.body',
        isComplete: (stats) => stats.energy.heatCapacity > 0,
        allowNext: true,
      },
    ],
  },
];

export const INTRO_IDS: readonly IntroId[] = INTROS.map((intro) => intro.id);

export function introById(id: IntroId): Intro {
  const intro = INTROS.find((candidate) => candidate.id === id);
  if (!intro) throw new Error(`Unknown intro ${id}`);
  return intro;
}

/** Consecutive ticks each trigger has held, plus the tick last counted. */
export interface IntroTriggerState {
  lastTick: number;
  held: Record<IntroId, number>;
}

function zeroHeld(): Record<IntroId, number> {
  return { smartMeters: 0, demandResponse: 0, islands: 0, hydrogen: 0, heat: 0 };
}

export function createIntroTriggerState(): IntroTriggerState {
  return { lastTick: -1, held: zeroHeld() };
}

/**
 * Feed one stats update; returns the first unseen intro whose trigger has
 * held for `sustainTicks` consecutive ticks, or null. Counts by tick delta,
 * so a repeated stats object for the same tick does not count twice; a
 * false trigger resets its counter. The first update, a tick going
 * backwards or a jump longer than the sustain window (another city was
 * loaded) count as a single tick. Mutates `state`.
 */
export function nextIntroToShow(
  state: IntroTriggerState,
  stats: GlobalStats,
  seen: ReadonlySet<IntroId>,
): IntroId | null {
  const delta = stats.tick - state.lastTick;
  if (delta !== 0) {
    const continuous = state.lastTick >= 0 && delta > 0 && delta <= INTRO_TUNING.sustainTicks;
    const step = continuous ? delta : 1;
    if (!continuous) state.held = zeroHeld();
    for (const intro of INTROS) {
      state.held[intro.id] = intro.trigger(stats) ? state.held[intro.id] + step : 0;
    }
    state.lastTick = stats.tick;
  }
  for (const intro of INTROS) {
    if (!seen.has(intro.id) && state.held[intro.id] >= INTRO_TUNING.sustainTicks) {
      return intro.id;
    }
  }
  return null;
}

/** Index of the first step not yet satisfied (= steps.length when all are). */
export function firstOpenStep(intro: Intro, stats: GlobalStats): number {
  const index = intro.steps.findIndex((step) => !step.isComplete?.(stats));
  return index === -1 ? intro.steps.length : index;
}

const INTROS_SEEN_KEY = 'voltopia.introsSeen';

function isIntroId(value: unknown): value is IntroId {
  return typeof value === 'string' && (INTRO_IDS as readonly string[]).includes(value);
}

/** Intros this browser has finished or closed (per browser, across cities). */
export function loadSeenIntros(): Set<IntroId> {
  try {
    const raw = localStorage.getItem(INTROS_SEEN_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter(isIntroId));
  } catch {
    return new Set();
  }
}

export function markIntroSeen(id: IntroId): void {
  const seen = loadSeenIntros();
  seen.add(id);
  try {
    localStorage.setItem(INTROS_SEEN_KEY, JSON.stringify([...seen]));
  } catch {
    // best effort only
  }
}

export function resetSeenIntros(): void {
  try {
    localStorage.removeItem(INTROS_SEEN_KEY);
  } catch {
    // best effort only
  }
}

/** Whether a step offers a Next button (manual steps, or `allowNext`). */
export function introStepShowsNext(step: IntroStep): boolean {
  return !step.isComplete || step.allowNext === true;
}

/** What blocks an intro from starting by itself. */
export interface IntroAutoStartContext {
  introActive: boolean;
  tutorialShowing: boolean;
  pageOpen: boolean;
  introsEnabled: boolean;
}

/** Automatic starts wait for a free screen; manual starts bypass this. */
export function canAutoStartIntro(context: IntroAutoStartContext): boolean {
  return (
    context.introsEnabled && !context.introActive && !context.tutorialShowing && !context.pageOpen
  );
}
