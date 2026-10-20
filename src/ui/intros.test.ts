import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GlobalStats, IslandStats } from '../shared/types.ts';
import { createSimState } from '../sim/state.ts';
import { buildStats } from '../sim/tick.ts';
import {
  canAutoStartIntro,
  createIntroTriggerState,
  firstOpenStep,
  INTRO_IDS,
  INTRO_TUNING,
  introById,
  introStepShowsNext,
  INTROS,
  loadSeenIntros,
  markIntroSeen,
  nextIntroToShow,
  resetSeenIntros,
  type IntroId,
} from './intros.ts';

const BASE = buildStats(createSimState(1, 16));

/** A fresh, quiet city: nothing triggers. Mutate the clone per test. */
function stats(edit: (s: GlobalStats) => void = () => {}): GlobalStats {
  const s = structuredClone(BASE);
  s.tick = 100;
  s.timeOfDay = 0.5;
  s.population = 0;
  s.islands = [island()];
  edit(s);
  return s;
}

function island(overrides: Partial<IslandStats> = {}): IslandStats {
  return {
    number: 1,
    key: 0,
    tiles: 1,
    buildings: 0,
    substations: 0,
    generation: 0,
    consumption: 0,
    stored: 0,
    capacity: 0,
    deficit: 0,
    curtailment: 0,
    gridImport: 0,
    gridExport: 0,
    importCost: 0,
    ...overrides,
  };
}

const trigger = (id: IntroId, s: GlobalStats): boolean => introById(id).trigger(s);

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

describe('intro triggers', () => {
  it('the base fixture triggers nothing', () => {
    const s = stats();
    for (const intro of INTROS) expect(intro.trigger(s), intro.id).toBe(false);
  });

  it('lists the intros in priority order', () => {
    expect(INTRO_IDS).toEqual(['smartMeters', 'demandResponse', 'islands', 'hydrogen', 'heat']);
  });

  it('sustains for one in-game hour', () => {
    expect(INTRO_TUNING.sustainTicks).toBe(40);
  });

  it('smart meters: a big enough city without a rollout', () => {
    expect(
      trigger(
        'smartMeters',
        stats((s) => (s.population = 150)),
      ),
    ).toBe(true);
    expect(
      trigger(
        'smartMeters',
        stats((s) => (s.population = 149)),
      ),
    ).toBe(false);
    expect(
      trigger(
        'smartMeters',
        stats((s) => {
          s.population = 500;
          s.smartMeters.active = true;
        }),
      ),
    ).toBe(false);
    expect(
      trigger(
        'smartMeters',
        stats((s) => {
          s.population = 500;
          s.smartMeters.coverage = 0.2;
        }),
      ),
    ).toBe(false);
  });

  it('demand response: an evening shortfall without a contract', () => {
    const evening = (edit: (s: GlobalStats) => void) =>
      stats((s) => {
        s.timeOfDay = 19 / 24;
        edit(s);
      });
    expect(
      trigger(
        'demandResponse',
        evening((s) => (s.islands[0]!.deficit = 1)),
      ),
    ).toBe(true);
    expect(
      trigger(
        'demandResponse',
        evening((s) => (s.energy.gridImport = 2)),
      ),
    ).toBe(true);
    expect(
      trigger(
        'demandResponse',
        evening(() => {}),
      ),
    ).toBe(false);
    expect(
      trigger(
        'demandResponse',
        evening((s) => {
          s.energy.gridImport = 2;
          s.demandResponse.active = true;
        }),
      ),
    ).toBe(false);
    expect(
      trigger(
        'demandResponse',
        stats((s) => {
          s.timeOfDay = 12 / 24;
          s.energy.gridImport = 2;
        }),
      ),
    ).toBe(false);
    expect(
      trigger(
        'demandResponse',
        stats((s) => {
          s.timeOfDay = 22 / 24;
          s.energy.gridImport = 2;
        }),
      ),
    ).toBe(false);
    expect(
      trigger(
        'demandResponse',
        stats((s) => {
          s.timeOfDay = 17 / 24;
          s.energy.deficit = 1;
        }),
      ),
    ).toBe(true);
  });

  it('islands: two or more grid islands', () => {
    expect(
      trigger(
        'islands',
        stats((s) => (s.islands = [island(), island({ number: 2 })])),
      ),
    ).toBe(true);
    expect(trigger('islands', stats())).toBe(false);
  });

  it('hydrogen: curtailment without hydrogen capacity', () => {
    expect(
      trigger(
        'hydrogen',
        stats((s) => (s.energy.curtailment = 3)),
      ),
    ).toBe(true);
    expect(
      trigger(
        'hydrogen',
        stats((s) => {
          s.energy.curtailment = 3;
          s.energy.hydrogenCapacity = 100;
        }),
      ),
    ).toBe(false);
  });

  it('heat: a large heating share and no heat plant', () => {
    const heating = (share: number, edit: (s: GlobalStats) => void = () => {}) =>
      stats((s) => {
        const c = s.energy.consumption;
        c.buildings = 100 * (1 - share);
        c.charging = 0;
        c.traction = 0;
        c.cooling = 0;
        c.electrolysis = 0;
        c.heatPumps = 0;
        c.heating = 100 * share;
        edit(s);
      });
    expect(trigger('heat', heating(0.2))).toBe(true);
    expect(trigger('heat', heating(0.15))).toBe(true);
    expect(trigger('heat', heating(0.1))).toBe(false);
    expect(
      trigger(
        'heat',
        heating(0.2, (s) => (s.energy.consumption.heatPumps = 1)),
      ),
    ).toBe(false);
    expect(
      trigger(
        'heat',
        heating(0.2, (s) => (s.energy.heatCapacity = 50)),
      ),
    ).toBe(false);
  });

  it('heat: no consumption at all does not trigger', () => {
    expect(trigger('heat', stats())).toBe(false);
  });
});

describe('nextIntroToShow', () => {
  const curtailing = (tick: number) =>
    stats((s) => {
      s.tick = tick;
      s.energy.curtailment = 1;
    });

  it('shows an intro only after its trigger held for sustainTicks', () => {
    const state = createIntroTriggerState();
    const none = new Set<IntroId>();
    for (let tick = 1; tick < INTRO_TUNING.sustainTicks; tick++) {
      expect(nextIntroToShow(state, curtailing(tick), none)).toBeNull();
    }
    expect(nextIntroToShow(state, curtailing(INTRO_TUNING.sustainTicks), none)).toBe('hydrogen');
  });

  it('counts by tick delta when stats arrive in steps', () => {
    const state = createIntroTriggerState();
    const none = new Set<IntroId>();
    expect(nextIntroToShow(state, curtailing(1), none)).toBeNull();
    expect(nextIntroToShow(state, curtailing(21), none)).toBeNull();
    expect(nextIntroToShow(state, curtailing(40), none)).toBe('hydrogen');
  });

  it('a repeated stats update for the same tick does not count twice', () => {
    const state = createIntroTriggerState();
    const none = new Set<IntroId>();
    nextIntroToShow(state, curtailing(1), none);
    for (let i = 0; i < 100; i++) nextIntroToShow(state, curtailing(1), none);
    expect(state.held.hydrogen).toBe(1);
  });

  it('a false tick resets the counter', () => {
    const state = createIntroTriggerState();
    const none = new Set<IntroId>();
    for (let tick = 1; tick <= 30; tick++) nextIntroToShow(state, curtailing(tick), none);
    nextIntroToShow(
      state,
      stats((s) => (s.tick = 31)),
      none,
    );
    expect(state.held.hydrogen).toBe(0);
    for (let tick = 32; tick < 32 + INTRO_TUNING.sustainTicks - 1; tick++) {
      expect(nextIntroToShow(state, curtailing(tick), none)).toBeNull();
    }
  });

  it('a jump in ticks (another city loaded) counts as a single tick', () => {
    const state = createIntroTriggerState();
    const none = new Set<IntroId>();
    nextIntroToShow(state, curtailing(1), none);
    expect(nextIntroToShow(state, curtailing(10_000), none)).toBeNull();
    expect(state.held.hydrogen).toBe(1);
    expect(nextIntroToShow(state, curtailing(5), none)).toBeNull();
    expect(state.held.hydrogen).toBe(1);
  });

  it('the first triggered intro in table order wins', () => {
    const state = createIntroTriggerState();
    const both = (tick: number) =>
      stats((s) => {
        s.tick = tick;
        s.energy.curtailment = 1;
        s.population = 200;
      });
    let shown: IntroId | null = null;
    for (let tick = 1; tick <= INTRO_TUNING.sustainTicks; tick++) {
      shown = nextIntroToShow(state, both(tick), new Set());
    }
    expect(shown).toBe('smartMeters');
    expect(nextIntroToShow(state, both(INTRO_TUNING.sustainTicks), new Set(['smartMeters']))).toBe(
      'hydrogen',
    );
  });

  it('seen intros are skipped', () => {
    const state = createIntroTriggerState();
    const seen = new Set<IntroId>(['hydrogen']);
    let shown: IntroId | null = null;
    for (let tick = 1; tick <= 2 * INTRO_TUNING.sustainTicks; tick++) {
      shown = nextIntroToShow(state, curtailing(tick), seen);
    }
    expect(shown).toBeNull();
  });
});

describe('firstOpenStep', () => {
  it('starts at the first step that is not yet satisfied', () => {
    const smart = introById('smartMeters');
    expect(firstOpenStep(smart, stats())).toBe(0);
    expect(
      firstOpenStep(
        smart,
        stats((s) => (s.smartMeters.active = true)),
      ),
    ).toBe(1);
    expect(
      firstOpenStep(
        smart,
        stats((s) => {
          s.smartMeters.active = true;
          s.smartMeters.coverage = 0.5;
        }),
      ),
    ).toBe(2);
  });

  it('stops at a manual step', () => {
    const islands = introById('islands');
    const split = stats((s) => (s.islands = [island({ substations: 1 }), island({ number: 2 })]));
    expect(firstOpenStep(islands, split)).toBe(0);
  });

  it('every intro has a second step and the islands intro completes on a substation per island', () => {
    for (const intro of INTROS) expect(intro.steps.length).toBeGreaterThanOrEqual(2);
    const connect = introById('islands').steps[1]!;
    expect(
      connect.isComplete!(
        stats((s) => (s.islands = [island({ substations: 1 }), island({ substations: 2 })])),
      ),
    ).toBe(true);
    expect(connect.isComplete!(stats((s) => (s.islands = [island(), island()])))).toBe(false);
    expect(connect.isComplete!(stats())).toBe(true);
  });

  it('the other step checks read the documented fields', () => {
    const [dr1, dr2] = introById('demandResponse').steps;
    expect(dr1!.isComplete!(stats((s) => (s.demandResponse.active = true)))).toBe(true);
    expect(dr2!.isComplete!(stats((s) => (s.energy.consumption.shed = 1)))).toBe(true);
    const [h1, h2] = introById('hydrogen').steps;
    expect(h1!.isComplete!(stats((s) => (s.energy.hydrogenCapacity = 10)))).toBe(true);
    expect(h2!.isComplete!(stats((s) => (s.energy.consumption.electrolysis = 1)))).toBe(true);
    const [q1, q2] = introById('heat').steps;
    expect(q1!.isComplete!(stats((s) => (s.energy.networkHeat = 1)))).toBe(true);
    expect(q2!.isComplete!(stats((s) => (s.energy.heatCapacity = 1)))).toBe(true);
    expect(q1!.isComplete!(stats())).toBe(false);
  });
});

describe('seen intros storage', () => {
  beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
  afterEach(() => vi.unstubAllGlobals());

  it('is empty by default and records seen ids', () => {
    expect(loadSeenIntros().size).toBe(0);
    markIntroSeen('heat');
    markIntroSeen('islands');
    markIntroSeen('heat');
    expect([...loadSeenIntros()].sort()).toEqual(['heat', 'islands']);
  });

  it('drops unknown ids and survives corrupt JSON', () => {
    localStorage.setItem('voltopia.introsSeen', JSON.stringify(['heat', 'bogus', 3]));
    expect([...loadSeenIntros()]).toEqual(['heat']);
    localStorage.setItem('voltopia.introsSeen', '{not json');
    expect(loadSeenIntros().size).toBe(0);
    localStorage.setItem('voltopia.introsSeen', JSON.stringify({ heat: true }));
    expect(loadSeenIntros().size).toBe(0);
  });

  it('reset clears the list', () => {
    markIntroSeen('hydrogen');
    resetSeenIntros();
    expect(loadSeenIntros().size).toBe(0);
  });

  it('treats unavailable storage as nothing seen', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    });
    expect(loadSeenIntros().size).toBe(0);
    expect(() => markIntroSeen('heat')).not.toThrow();
    expect(() => resetSeenIntros()).not.toThrow();
  });
});

describe('introStepShowsNext', () => {
  it('shows Next on manual steps and on steps that allow it', () => {
    expect(introStepShowsNext(introById('islands').steps[0])).toBe(true);
    expect(introStepShowsNext(introById('islands').steps[1])).toBe(false);
    expect(introStepShowsNext(introById('smartMeters').steps[0])).toBe(false);
    expect(introStepShowsNext(introById('smartMeters').steps[1])).toBe(true);
  });
});

describe('canAutoStartIntro', () => {
  const free = { introActive: false, tutorialShowing: false, pageOpen: false, introsEnabled: true };

  it('starts only on a free screen with intros enabled', () => {
    expect(canAutoStartIntro(free)).toBe(true);
    expect(canAutoStartIntro({ ...free, introActive: true })).toBe(false);
    expect(canAutoStartIntro({ ...free, tutorialShowing: true })).toBe(false);
    expect(canAutoStartIntro({ ...free, pageOpen: true })).toBe(false);
    expect(canAutoStartIntro({ ...free, introsEnabled: false })).toBe(false);
  });
});
