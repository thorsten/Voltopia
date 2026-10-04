# Smart-Meter Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the free smart-charging switch with a paced, paid
smart-meter rollout whose coverage scales vehicle smart charging and a
flexible-load pool that moves household and heating load into surplus
hours, visible in the graph, panel, HUD, a goal and the agent tools.

**Architecture:** New sim module `src/sim/smartMeters.ts` (coverage,
daily install pacing, billing, command); the flexible pool lives inside
`energyStep` between demand and the storage cascade; vehicles gate on
a per-id hash against coverage; stats/history gain flex figures and an
`unshifted` series; UI, goal and agent follow. The work is staged so
every commit typechecks: the old `smartCharging` flag survives in
`SimState` until Task 2 and in `GlobalStats` (derived) until Task 5.

**Tech Stack:** TypeScript (strict), React 19, Vitest, pnpm, oxlint,
oxfmt.

**Spec:** `docs/superpowers/specs/2026-10-04-smart-meters-design.md`

## Global Constraints

- Balance values live only in `BALANCE.smartMeters` (see spec); no magic
  numbers in sim code. No randomness added (determinism tests must pass).
- Save compatibility: `SAVE_VERSION` stays 1; new `SaveGame` fields are
  optional; legacy `smartCharging === true` migrates to full coverage +
  active rollout on load.
- With coverage 0 the energy step is numerically identical to today.
- `src/render`/`src/ui` never import `src/sim`; UI strings in EN and DE;
  agent-tool parity with `docs/agent-tools.md`.
- The e2e test clicks `data-testid="smart-charging"` and expects the
  input to become checked: keep that test id on the rollout checkbox.
- `pnpm format` after every edit; hook runs `pnpm typecheck && pnpm lint
&& pnpm format:check && pnpm test`; never `--no-verify`. Transient 30 s
  timeouts under load: retry once.
- Coverage ≥ 90 % on `src/sim` and `src/shared`.

---

### Task 1: Rollout state, pacing, billing and command (sim core)

**Files:**

- Modify: `src/shared/constants.ts` (new `smartMeters` block in `BALANCE`, after `growth`)
- Modify: `src/shared/types.ts` (`SaveGame`, `GlobalStats['budget']`)
- Modify: `src/shared/messages.ts` (new command)
- Modify: `src/sim/state.ts` (state fields, serialize/deserialize, migration)
- Create: `src/sim/smartMeters.ts`
- Modify: `src/sim/tick.ts` (call the step; budget line)
- Modify: `src/sim/engine.ts` (command handler)
- Create: `src/sim/smartMeters.test.ts`
- Test: `src/sim/state.test.ts`, `src/sim/engine.test.ts`

**Interfaces:**

- Produces: `BALANCE.smartMeters = { costPerMeter, installsPerDay, householdFlexShare, heatingFlexShare, backlogHours, goalCoverage }`; `SimState.smartMeters: { active: boolean; metered: number; installCarry: number }`, `SimState.flexBacklog: number`, `SimState.lastSmartMeterCost: number`; `src/sim/smartMeters.ts` exports `countBuildings(state)`, `meteredCoverage(state)`, `smartMetersStep(state): number` (cost spent this tick), `setSmartMeterRollout(state, active)`; command `{ type: 'setSmartMeterRollout'; active: boolean }`; `SaveGame.smartMeters?: { active: boolean; metered: number }`, `SaveGame.flexBacklog?: number`; `GlobalStats.budget.smartMeters: number`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/sim/smartMeters.test.ts
import { describe, expect, it } from 'vitest';
import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { buildRoads, bulldozeTiles } from './roads.ts';
import {
  countBuildings,
  meteredCoverage,
  setSmartMeterRollout,
  smartMetersStep,
} from './smartMeters.ts';
import { createSimState, deserializeState, serializeState, Zone, type SimState } from './state.ts';

const SIZE = 16;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);

/** A town with `n` houses along a road and a full treasury. */
function town(n: number, money = 1e9): SimState {
  const state = createSimState(5, SIZE);
  state.money = money;
  buildRoads(
    state,
    Array.from({ length: n }, (_, i) => at(i, 5)),
  );
  for (let i = 0; i < n; i++) {
    state.layers.zone[at(i, 6)] = Zone.Residential;
    state.layers.density[at(i, 6)] = 1;
  }
  return state;
}

describe('smart-meter rollout', () => {
  it('counts buildings and reports zero coverage before any meter', () => {
    const state = town(10);
    expect(countBuildings(state)).toBe(10);
    expect(meteredCoverage(state)).toBe(0);
    expect(meteredCoverage(createSimState(1, SIZE))).toBe(0);
  });

  it('installs installsPerDay meters over one day while active, billing each', () => {
    const state = town(40);
    setSmartMeterRollout(state, true);
    const before = state.money;
    let spent = 0;
    for (let t = 0; t < TICKS_PER_DAY; t++) spent += smartMetersStep(state);
    const { installsPerDay, costPerMeter } = BALANCE.smartMeters;
    expect(state.smartMeters.metered).toBe(installsPerDay);
    expect(spent).toBe(installsPerDay * costPerMeter);
    expect(before - state.money).toBe(spent);
    expect(meteredCoverage(state)).toBeCloseTo(installsPerDay / 40, 9);
  });

  it('does nothing while paused and stops at full coverage', () => {
    const state = town(5);
    for (let t = 0; t < TICKS_PER_DAY; t++) smartMetersStep(state);
    expect(state.smartMeters.metered).toBe(0);
    setSmartMeterRollout(state, true);
    for (let t = 0; t < 3 * TICKS_PER_DAY; t++) smartMetersStep(state);
    expect(state.smartMeters.metered).toBe(5);
    expect(meteredCoverage(state)).toBe(1);
  });

  it('waits when the treasury cannot pay and never goes into debt', () => {
    const state = town(40, BALANCE.smartMeters.costPerMeter * 2 + 1);
    setSmartMeterRollout(state, true);
    for (let t = 0; t < TICKS_PER_DAY; t++) smartMetersStep(state);
    expect(state.smartMeters.metered).toBe(2);
    expect(state.money).toBeGreaterThanOrEqual(0);
    state.money = 1e9;
    for (let t = 0; t < TICKS_PER_DAY; t++) smartMetersStep(state);
    expect(state.smartMeters.metered).toBeGreaterThan(2);
  });

  it('loses meters with demolished buildings', () => {
    const state = town(5);
    state.smartMeters.metered = 5;
    bulldozeTiles(state, [at(0, 6), at(1, 6)]);
    smartMetersStep(state);
    expect(state.smartMeters.metered).toBe(3);
    expect(meteredCoverage(state)).toBe(1);
  });

  it('round-trips rollout state and the flexible backlog through a save', () => {
    const state = town(5);
    state.smartMeters = { active: true, metered: 3, installCarry: 0.4 };
    state.flexBacklog = 12.5;
    const restored = deserializeState(serializeState(state));
    expect(restored.smartMeters.active).toBe(true);
    expect(restored.smartMeters.metered).toBe(3);
    expect(restored.flexBacklog).toBe(12.5);
  });

  it('migrates a legacy save: smart charging on means every building metered', () => {
    const state = town(5);
    const save = serializeState(state);
    delete save.smartMeters;
    delete save.flexBacklog;
    const on = deserializeState({ ...save, smartCharging: true });
    expect(on.smartMeters.active).toBe(true);
    expect(on.smartMeters.metered).toBe(5);
    const off = deserializeState({ ...save, smartCharging: false });
    expect(off.smartMeters.active).toBe(false);
    expect(off.smartMeters.metered).toBe(0);
    expect(off.flexBacklog).toBe(0);
  });

  it('clamps a saved meter count to the current building count', () => {
    const state = town(5);
    const save = serializeState(state);
    const restored = deserializeState({ ...save, smartMeters: { active: false, metered: 99 } });
    expect(restored.smartMeters.metered).toBe(5);
  });
});
```

Append to `src/sim/engine.test.ts` (next to "toggles smart charging"):

```ts
it('starts and pauses the smart-meter rollout and flushes stats', () => {
  const engine = makeEngine();
  engine.applyCommand({ type: 'setSmartMeterRollout', active: true });
  expect(engine.state.smartMeters.active).toBe(true);
  const flushed = engine.flush();
  if (flushed?.type !== 'tick') throw new Error('expected a tick event');
  expect(flushed.stats.budget.smartMeters).toBe(0);
  engine.applyCommand({ type: 'setSmartMeterRollout', active: false });
  expect(engine.state.smartMeters.active).toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/sim/smartMeters.test.ts src/sim/engine.test.ts`
Expected: FAIL — module missing; unknown command type.

- [ ] **Step 3: Balance, types, messages**

`src/shared/constants.ts`, inside `BALANCE` after the `growth: { … },`
block:

```ts
  /** Smart-meter rollout: paced installation and the flexible load it unlocks. */
  smartMeters: {
    /** Money per installed meter (billed as the crews install). */
    costPerMeter: 60,
    /** Meters the crews install per in-game day while the rollout is active. */
    installsPerDay: 15,
    /** Share of a metered building's base load that can wait for surplus. */
    householdFlexShare: 0.15,
    /** Share of a metered building's on-site electric heating that can wait (thermal inertia). */
    heatingFlexShare: 0.3,
    /** Hours of flexible demand the backlog may hold before comfort wins. */
    backlogHours: 4,
    /** Coverage the flexibleCity goal requires. */
    goalCoverage: 0.8,
  },
```

`src/shared/types.ts`: in `SaveGame`, after `warmWinterTicks?: number;`:

```ts
  /** Smart-meter rollout (absent in older saves: migrated from smartCharging). */
  smartMeters?: { active: boolean; metered: number };
  /** Deferred flexible energy waiting for surplus (absent → 0). */
  flexBacklog?: number;
```

and in `GlobalStats['budget']` next to `repair: number;`:

```ts
/** Smart-meter installs paid this tick. */
smartMeters: number;
```

(`SaveGame.smartCharging` stays as is for now; Task 2 makes it optional.)

`src/shared/messages.ts`: add after the `setSmartCharging` line:

```ts
  | { type: 'setSmartMeterRollout'; active: boolean }
```

- [ ] **Step 4: State fields, save, migration**

`src/sim/state.ts`: in `SimState` after `insulation: boolean;`:

```ts
/** Smart-meter rollout: crews installing, meters in place, fractional carry. */
smartMeters: {
  active: boolean;
  metered: number;
  installCarry: number;
}
/** Deferred flexible energy waiting for renewable surplus (energy units). */
flexBacklog: number;
/** Smart-meter install cost paid last tick (budget line). */
lastSmartMeterCost: number;
```

In `createSimState` next to `insulation: false,`:

```ts
    smartMeters: { active: false, metered: 0, installCarry: 0 },
    flexBacklog: 0,
    lastSmartMeterCost: 0,
```

In `serializeState` after `insulation: state.insulation,`:

```ts
    smartMeters: { active: state.smartMeters.active, metered: state.smartMeters.metered },
    flexBacklog: state.flexBacklog,
```

In `deserializeState` after `state.insulation = save.insulation ?? false;`
(the layers are already restored at that point — check the function
order; if not, place this after the layer restore):

```ts
// Rollout: new saves carry it; legacy saves with smart charging on get
// every building metered so the city keeps the effect it had.
const buildings = countBuildings(state);
if (save.smartMeters) {
  state.smartMeters = {
    active: save.smartMeters.active,
    metered: Math.min(save.smartMeters.metered, buildings),
    installCarry: 0,
  };
} else {
  state.smartMeters = {
    active: save.smartCharging === true,
    metered: save.smartCharging === true ? buildings : 0,
    installCarry: 0,
  };
}
state.flexBacklog = save.flexBacklog ?? 0;
```

`countBuildings` is defined in `smartMeters.ts` (Step 5); `state.ts`
importing from `smartMeters.ts` would cycle (that module imports
`SimState`), so put `countBuildings` in `state.ts` itself next to
`countPopulationAndJobs` and have `smartMeters.ts` re-export it:

```ts
/** Buildings standing on zoned land (density > 0). */
export function countBuildings(state: SimState): number {
  const { density, tileType } = state.layers;
  let n = 0;
  for (let i = 0; i < density.length; i++) {
    if (tileType[i] === TileType.Empty && density[i] > 0) n++;
  }
  return n;
}
```

- [ ] **Step 5: The rollout module**

```ts
// src/sim/smartMeters.ts
import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import { countBuildings, type SimState } from './state.ts';

export { countBuildings };

/** Share of buildings with a smart meter, 0 without buildings. */
export function meteredCoverage(state: SimState): number {
  const buildings = countBuildings(state);
  if (buildings === 0) return 0;
  return Math.min(1, state.smartMeters.metered / buildings);
}

/** Start or pause the crews. */
export function setSmartMeterRollout(state: SimState, active: boolean): void {
  state.smartMeters.active = active;
  state.statsDirty = true;
}

/**
 * One tick of the rollout: meters vanish with demolished buildings; while
 * active, crews accumulate installsPerDay / TICKS_PER_DAY per tick and
 * install one meter per whole unit, each billed at costPerMeter, as long
 * as the treasury can pay (the carry waits otherwise — no debt). Returns
 * the money spent this tick and records it for the budget.
 */
export function smartMetersStep(state: SimState): number {
  const meters = state.smartMeters;
  const buildings = countBuildings(state);
  if (meters.metered > buildings) meters.metered = buildings;
  let spent = 0;
  if (meters.active && meters.metered < buildings) {
    const { installsPerDay, costPerMeter } = BALANCE.smartMeters;
    meters.installCarry += installsPerDay / TICKS_PER_DAY;
    while (meters.installCarry >= 1 && meters.metered < buildings) {
      if (state.money - spent < costPerMeter) break;
      meters.installCarry -= 1;
      meters.metered++;
      spent += costPerMeter;
    }
    // Reaching full coverage drops any leftover carry: the next new
    // building should not get an instant meter from stale credit.
    if (meters.metered >= buildings) meters.installCarry = 0;
  }
  state.money -= spent;
  state.lastSmartMeterCost = spent;
  if (spent > 0) state.statsDirty = true;
  return spent;
}
```

Note the carry must not grow without bound while broke: cap it at 1
(`if (meters.installCarry > 1) meters.installCarry = 1;` right after the
accumulation) — otherwise a long broke stretch installs a burst of meters
the moment money arrives. Add that line and this test:

```ts
it('does not stockpile installs while broke', () => {
  const state = town(40, 0);
  setSmartMeterRollout(state, true);
  for (let t = 0; t < 3 * TICKS_PER_DAY; t++) smartMetersStep(state);
  state.money = 1e9;
  smartMetersStep(state);
  expect(state.smartMeters.metered).toBeLessThanOrEqual(1);
});
```

- [ ] **Step 6: Tick wiring, budget, engine**

`src/sim/tick.ts`: import `smartMetersStep` from `./smartMeters.ts`; in
`stepTick` insert `smartMetersStep(state);` directly before
`economyStep(state, population, jobs);`. In `buildBudget` add
`smartMeters: state.lastSmartMeterCost,` after `repair:` and subtract
`state.lastSmartMeterCost` in `net` after `state.lastRepairCost`.

`src/sim/engine.ts`: import `setSmartMeterRollout` from
`./smartMeters.ts`; add after the `setSmartCharging` case:

```ts
      case 'setSmartMeterRollout':
        setSmartMeterRollout(state, command.active);
        return [];
```

Any other place that builds a `GlobalStats['budget']` literal (grep
`repair:` in `src` outside tests, e.g. a UI test fixture) gains
`smartMeters: 0`.

- [ ] **Step 7: Run the tests**

Run: `pnpm format && pnpm typecheck && pnpm vitest run src/sim/smartMeters.test.ts src/sim/engine.test.ts src/sim/state.test.ts src/storage src/sim/integration.test.ts`
Expected: PASS. Typecheck may point at UI/test fixtures that construct a
budget object — add the `smartMeters: 0` field there.

- [ ] **Step 8: Commit**

```bash
git add src/shared/constants.ts src/shared/types.ts src/shared/messages.ts src/sim/state.ts src/sim/smartMeters.ts src/sim/smartMeters.test.ts src/sim/tick.ts src/sim/engine.ts src/sim/engine.test.ts
git commit -m "feat(sim): smart-meter rollout — paced installs, billing, save and command

Crews install installsPerDay meters per in-game day while the rollout is
active, each billed at costPerMeter; meters vanish with demolished
buildings; legacy saves with smart charging on load fully metered."
```

---

### Task 2: Vehicles gate on coverage; retire `state.smartCharging`

**Files:**

- Modify: `src/sim/vehicles.ts`, `src/sim/transit.ts`, `src/sim/deliveries.ts`
- Modify: `src/sim/state.ts` (remove the field; serialize legacy), `src/shared/types.ts` (`SaveGame.smartCharging` optional; `GlobalStats.smartCharging` kept, derived), `src/shared/messages.ts` (drop `setSmartCharging`), `src/sim/engine.ts`, `src/sim/tick.ts` (`buildStats`), `src/agent/tools.ts` (the `set_smart_charging` tool now sends the rollout command — minimal, Task 5 renames it), `src/storage/serialization.ts`
- Test: `src/sim/vehicles.test.ts`, `src/sim/transit.test.ts`, `src/sim/deliveries.test.ts`, `src/sim/engine.test.ts`, `src/sim/smartMeters.test.ts`

**Interfaces:**

- Produces: `isSmartVehicle(state, id): boolean` exported from `src/sim/smartMeters.ts` (`hash01(id) < meteredCoverage(state)`); `SimState.smartCharging` removed; `GlobalStats.smartCharging = state.smartMeters.active` (temporary, removed in Task 5); `SaveGame.smartCharging?: boolean` (legacy, read on load only).

- [ ] **Step 1: Write the failing tests**

Append to `src/sim/smartMeters.test.ts` (import `isSmartVehicle`):

```ts
describe('isSmartVehicle', () => {
  it('is false for everyone at zero coverage and true for everyone at full coverage', () => {
    const none = town(10);
    const full = town(10);
    full.smartMeters.metered = 10;
    for (let id = 0; id < 50; id++) {
      expect(isSmartVehicle(none, id)).toBe(false);
      expect(isSmartVehicle(full, id)).toBe(true);
    }
  });

  it('picks a stable set that only grows with coverage', () => {
    const state = town(100);
    state.smartMeters.metered = 50;
    const half = Array.from({ length: 200 }, (_, id) => isSmartVehicle(state, id));
    const count = half.filter(Boolean).length;
    expect(count).toBeGreaterThan(70);
    expect(count).toBeLessThan(130);
    expect(Array.from({ length: 200 }, (_, id) => isSmartVehicle(state, id))).toEqual(half);
    state.smartMeters.metered = 80;
    for (let id = 0; id < 200; id++) if (half[id]) expect(isSmartVehicle(state, id)).toBe(true);
  });
});
```

Migrate the existing smart-charging tests: everywhere a test sets
`state.smartCharging = true` (`vehicles.test.ts` ×3, `transit.test.ts`,
`deliveries.test.ts`), replace it with full coverage:

```ts
state.smartMeters.metered = countBuildings(state); // full coverage: every vehicle is smart
```

(import `countBuildings` from `./smartMeters.ts`). If a test town has no
buildings (`commuterTown`/`busTown`/`shopTown` build zoned houses — check
`countBuildings(state) > 0` in the test; if it is 0, the test must add a
house tile first, e.g. `state.layers.zone[at(1, 1)] = Zone.Residential; state.layers.density[at(1, 1)] = 1;`).
In `engine.test.ts` delete the two `setSmartCharging` tests (Task 1 added
their replacement).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/sim/smartMeters.test.ts src/sim/vehicles.test.ts src/sim/transit.test.ts src/sim/deliveries.test.ts`
Expected: the new `isSmartVehicle` tests FAIL (not exported); the
migrated tests FAIL because the gate still reads `state.smartCharging`.

- [ ] **Step 3: Implement**

`src/sim/smartMeters.ts` — append:

```ts
/** Deterministic 0..1 per vehicle id (same scheme as the sim's other hashes). */
function hash01(id: number): number {
  let h = (id * 2654435761 + 97) >>> 0;
  h ^= h >>> 13;
  h = (h * 0x5bd1e995) >>> 0;
  return (h >>> 8) / 16777216;
}

/**
 * Whether a vehicle (car, van or bus) charges "smart" — deferring to
 * renewable surplus unless its battery is low. The share follows the
 * rollout: a vehicle is smart when its hash falls under the coverage, so
 * the smart set only ever grows and never flickers between ticks.
 */
export function isSmartVehicle(state: SimState, id: number): boolean {
  return hash01(id) < meteredCoverage(state);
}
```

`src/sim/vehicles.ts` `decideCharging`: replace
`if (!state.smartCharging) return true;` with
`if (!isSmartVehicle(state, vehicle.id)) return true;` (import from
`./smartMeters.ts`). Same in `src/sim/transit.ts` `decideBusCharging`
(`bus.id`) and `src/sim/deliveries.ts` `decideVanCharging` (`van.id`).

`src/sim/state.ts`: delete `smartCharging: boolean;` from `SimState`,
`smartCharging: false,` from `createSimState`, the
`smartCharging: state.smartCharging,` line in `serializeState` (do not
write it any more) and `state.smartCharging = save.smartCharging;` in
`deserializeState` (the migration from Task 1 already reads it).

`src/shared/types.ts`: `SaveGame.smartCharging` becomes
`/** Legacy smart-charging switch; read on load, never written. */ smartCharging?: boolean;`
and `GlobalStats.smartCharging`'s doc becomes
`/** Rollout active (legacy name; see smartMeters in Task 5). */`.

`src/storage/serialization.ts`: `SaveGameJson.smartCharging` → optional;
in `saveToJson` emit it only when defined (`...(save.smartCharging !== undefined ? { smartCharging: save.smartCharging } : {})`);
in `saveFromJson` parse `...(typeof parsed.smartCharging === 'boolean' ? { smartCharging: parsed.smartCharging } : {})`.
Add `smartMeters` and `flexBacklog` to `SaveGameJson` and both
functions the same optional way.

`src/shared/messages.ts`: delete the `setSmartCharging` line.
`src/sim/engine.ts`: delete the `setSmartCharging` case.
`src/sim/tick.ts` `buildStats`: `smartCharging: state.smartMeters.active,`.
`src/agent/tools.ts` `set_smart_charging`: send
`{ type: 'setSmartMeterRollout', active: input.enabled }` and return
`{ smartCharging: input.enabled }` unchanged (Task 5 renames it). Fix the
agent test at `tools.test.ts` ("sets speed, tax rate, smart charging…")
to assert `engine.state.smartMeters.active` instead of
`engine.state.smartCharging`.

- [ ] **Step 4: Run the tests**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm vitest run src/sim src/storage src/agent`
Expected: PASS; `grep -rn "smartCharging" src --include=*.ts` now shows
only the `SaveGame`/`SaveGameJson` legacy fields, the migration read, the
`GlobalStats` field and its UI/agent readers.

- [ ] **Step 5: Commit**

```bash
git add -A src/sim src/shared src/storage src/agent
git commit -m "feat(sim): vehicles charge smart in proportion to meter coverage

A stable per-id hash under the coverage decides which cars, vans and
buses defer to surplus. The global smartCharging flag is gone from the
state; saves keep it as a legacy field for migration."
```

---

### Task 3: Flexible-load pool, stats, history and the goal

**Files:**

- Modify: `src/sim/energy.ts` (`energyStep`, `lastEnergy`, history accumulator), `src/sim/state.ts` (`lastEnergy` type + init, `energyHistoryAccum`, `goalProgress`, save of `flexTicks`), `src/sim/tick.ts` (`pendingHistoryPoint`, `buildStats` energy block), `src/shared/types.ts` (`EnergyStats.consumption`, `EnergyHistoryPoint`, `SaveGame.flexTicks?`), `src/sim/goals.ts`
- Test: `src/sim/energy.test.ts`, `src/sim/goals.test.ts`, `src/sim/state.test.ts`

**Interfaces:**

- Consumes: `meteredCoverage` (Task 1), `BALANCE.smartMeters`.
- Produces: `lastEnergy.flexDeferred/flexRecovered/flexBacklog/unshifted`; `EnergyStats.consumption.flexDeferred/flexRecovered/flexBacklog`; `EnergyHistoryPoint.unshifted`; goal id `flexibleCity`, `goalProgress.flexTicks`, `SaveGame.flexTicks?`.

- [ ] **Step 1: Write the failing tests**

Append to `src/sim/energy.test.ts` (import `countBuildings` from `./smartMeters.ts`; the file already has `createSimState`, `placePlant`, `energyStep`, `Zone`, `PlantType`, `SIZE`, `at`, `TICKS_PER_DAY`, `BALANCE`):

```ts
describe('flexible load pool (smart meters)', () => {
  /** Ten houses on a road, fully metered, plus the given plant. */
  function meteredTown(plant: PlantType | null): SimState {
    const state = createSimState(9, SIZE);
    state.money = 1e9;
    buildRoads(
      state,
      Array.from({ length: 10 }, (_, i) => at(i + 2, 5)),
    );
    for (let i = 0; i < 10; i++) {
      state.layers.zone[at(i + 2, 6)] = Zone.Residential;
      state.layers.density[at(i + 2, 6)] = 2;
    }
    if (plant !== null) placePlant(state, at(2, 3), plant);
    buildPowerLines(state, [at(2, 4)]);
    state.smartMeters.metered = countBuildings(state);
    return state;
  }

  it('is a no-op at zero coverage', () => {
    const a = meteredTown(PlantType.WindTurbine);
    const b = meteredTown(PlantType.WindTurbine);
    b.smartMeters.metered = 0;
    a.smartMeters.metered = 0;
    for (let t = 0; t < 50; t++) {
      energyStep(a, { chargingDemand: 0 });
      energyStep(b, { chargingDemand: 0 });
      expect(a.lastEnergy.flexDeferred).toBe(0);
      expect(a.lastEnergy.flexRecovered).toBe(0);
      expect(a.lastEnergy.unshifted).toBeCloseTo(
        a.lastEnergy.buildingConsumption +
          a.lastEnergy.heatingConsumption +
          a.lastEnergy.coolingConsumption +
          a.lastEnergy.chargingConsumption +
          a.lastEnergy.heatPumpConsumption,
        9,
      );
    }
  });

  it('defers the flexible share at night without surplus and bounds the backlog', () => {
    const state = meteredTown(null); // no generation at all
    state.tick = Math.round(TICKS_PER_DAY * 0.1); // 02:24
    energyStep(state, { chargingDemand: 0 });
    const e = state.lastEnergy;
    const { householdFlexShare, heatingFlexShare, backlogHours } = BALANCE.smartMeters;
    const flexible =
      householdFlexShare * e.buildingConsumption + heatingFlexShare * e.heatingConsumption;
    expect(e.flexDeferred).toBeCloseTo(flexible, 9);
    expect(e.flexRecovered).toBe(0);
    expect(e.unshifted - e.deficit).toBeCloseTo(e.flexDeferred, 6); // nothing generated: unshifted = demand, served = demand - deferred
    // Keep deferring: the backlog saturates at backlogHours of flexible demand.
    for (let t = 0; t < TICKS_PER_DAY; t++) energyStep(state, { chargingDemand: 0 });
    const capacity = flexible * backlogHours * (TICKS_PER_DAY / 24);
    expect(state.flexBacklog).toBeLessThanOrEqual(capacity + 1e-6);
    expect(state.flexBacklog).toBeGreaterThan(capacity * 0.5);
  });

  it('serves the flexible share and drains the backlog when renewables exceed the inflexible load', () => {
    const state = meteredTown(PlantType.WindTurbine);
    placePlant(state, at(3, 3), PlantType.WindTurbine);
    placePlant(state, at(4, 3), PlantType.WindTurbine);
    state.weather.windSpeed = 0.9;
    state.flexBacklog = 5;
    energyStep(state, { chargingDemand: 0 });
    const e = state.lastEnergy;
    expect(e.flexDeferred).toBe(0);
    expect(e.flexRecovered).toBeGreaterThan(0);
    expect(e.flexRecovered).toBeLessThanOrEqual(5);
    expect(state.flexBacklog).toBeCloseTo(5 - e.flexRecovered, 9);
    expect(state.flexBacklog).toBeGreaterThanOrEqual(0);
  });

  it('keeps the identity unshifted - consumption = deferred - recovered - overflow', () => {
    const state = meteredTown(PlantType.WindTurbine);
    for (let t = 0; t < 200; t++) {
      const before = state.flexBacklog;
      energyStep(state, { chargingDemand: 0 });
      const e = state.lastEnergy;
      const served =
        e.buildingConsumption +
        e.heatingConsumption +
        e.coolingConsumption +
        e.chargingConsumption +
        e.heatPumpConsumption;
      // consumption actually served this tick = unshifted - deferred + recovered + overflow
      const overflow = Math.max(0, before + e.flexDeferred - e.flexRecovered - state.flexBacklog);
      expect(e.unshifted - e.flexDeferred + e.flexRecovered + overflow).toBeCloseTo(served, 6);
    }
  });
});
```

The last test defines what `served` means: the `lastEnergy` consumption
fields must report what was actually served (the building field reduced
by the deferred share and increased by recovered/overflow). Keep that
contract in the implementation (see Step 3: `buildingConsumption`
reports `buildingDemand - deferred + recovered + overflow` only if that
is where the flexibility lives — simpler and what the test assumes:
report `buildingConsumption = buildingDemand - deferred + recovered + overflow`
and leave heating as is; the identity then holds).

Append to `src/sim/goals.test.ts`:

```ts
describe('flexibleCity', () => {
  function flexCity(): SimState {
    const state = createSimState(4, 16);
    for (let i = 0; i < 20; i++) {
      state.layers.zone[at(i % 16, 2 + Math.floor(i / 16))] = Zone.Residential;
      state.layers.density[at(i % 16, 2 + Math.floor(i / 16))] = 3; // population ≥ 50
    }
    state.smartMeters.metered = 20;
    state.lastEnergy.flexDeferred = 1;
    return state;
  }

  it('achieves after half a day of metered, shifting ticks', () => {
    const state = flexCity();
    for (let i = 0; i < TICKS_PER_DAY / 2 - 1; i++) goalsStep(state);
    expect(state.goalsAchieved.has('flexibleCity')).toBe(false);
    goalsStep(state);
    expect(state.goalsAchieved.has('flexibleCity')).toBe(true);
  });

  it('needs coverage and actual shifting', () => {
    const low = flexCity();
    low.smartMeters.metered = 10; // 50 % < goalCoverage
    for (let i = 0; i < TICKS_PER_DAY; i++) goalsStep(low);
    expect(low.goalsAchieved.has('flexibleCity')).toBe(false);
    const idle = flexCity();
    idle.lastEnergy.flexDeferred = 0;
    idle.lastEnergy.flexRecovered = 0;
    for (let i = 0; i < TICKS_PER_DAY; i++) goalsStep(idle);
    expect(idle.goalsAchieved.has('flexibleCity')).toBe(false);
  });

  it('round-trips its progress', () => {
    const state = flexCity();
    for (let i = 0; i < 7; i++) goalsStep(state);
    const restored = deserializeState(serializeState(state));
    expect(restored.goalProgress.flexTicks).toBe(7);
  });
});
```

(`createSimState`, `deserializeState`, `serializeState`, `Zone`, `at`,
`TICKS_PER_DAY`, `goalsStep` are already imported there.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/sim/energy.test.ts src/sim/goals.test.ts`
Expected: FAIL — `flexDeferred`/`unshifted` undefined; unknown goal.

- [ ] **Step 3: Implement the pool**

`src/sim/state.ts`: extend `lastEnergy` type and the init literal with

```ts
/** Flexible load deferred into the backlog this tick (smart meters). */
flexDeferred: number;
/** Backlog served from renewable surplus this tick. */
flexRecovered: number;
/** Deferred flexible energy still waiting after this tick. */
flexBacklog: number;
/** What consumption would have been without shifting. */
unshifted: number;
```

(init all four to 0), add `unshifted: number;` to `energyHistoryAccum`
(init 0), and `flexTicks: number;` to `goalProgress` (init 0; save it as
`flexTicks` next to `warmWinterTicks` in both directions, default 0).

`src/shared/types.ts`: `EnergyStats.consumption` gains
`flexDeferred: number; flexRecovered: number; flexBacklog: number;`
(documented); `EnergyHistoryPoint` gains
`/** Consumption without load shifting (equals consumption when nothing is metered). */ unshifted: number;`;
`SaveGame` gains `flexTicks?: number;`.

`src/sim/energy.ts` — in `energyStep`, replace

```ts
const chargingDemand = Math.max(0, input.chargingDemand);
const totalDemand =
  buildingDemand + heatingDemand + coolingDemand + chargingDemand + heat.pumpPower;
const generation = solar + wind + rooftop + hydro + tidal + geothermal;
```

with

```ts
const chargingDemand = Math.max(0, input.chargingDemand);
const generation = solar + wind + rooftop + hydro + tidal + geothermal;

// Smart meters: a share of metered household load and on-site electric
// heating waits for renewable surplus (see smartMeters.ts). Cooling,
// charging and the network pumps stay inflexible. With no coverage
// every term is 0 and the step is unchanged.
const unshifted = buildingDemand + heatingDemand + coolingDemand + chargingDemand + heat.pumpPower;
const coverage = meteredCoverage(state);
const { householdFlexShare, heatingFlexShare, backlogHours } = BALANCE.smartMeters;
const flexible =
  coverage * (householdFlexShare * buildingDemand + heatingFlexShare * heatingDemand);
const inflexible = unshifted - flexible;
const renewableSurplus = generation - inflexible;
let servedNow = 0;
let recovered = 0;
let deferred = flexible;
if (renewableSurplus > 0) {
  servedNow = Math.min(flexible, renewableSurplus);
  recovered = Math.min(state.flexBacklog, renewableSurplus - servedNow);
  deferred = flexible - servedNow;
}
const backlogCapacity = flexible * backlogHours * (TICKS_PER_DAY / 24);
const overflow = Math.max(0, state.flexBacklog + deferred - recovered - backlogCapacity);
state.flexBacklog = Math.max(0, state.flexBacklog + deferred - recovered - overflow);
const totalDemand = inflexible + servedNow + recovered + overflow;
// Report the household line as what was actually served this tick.
buildingDemand = buildingDemand - deferred + recovered + overflow;
```

(import `meteredCoverage` from `./smartMeters.ts` and `TICKS_PER_DAY`
from the constants; `buildingDemand` must be a `let` — it already is.)
Everything downstream keeps using `totalDemand`. In the `state.lastEnergy`
literal add `flexDeferred: deferred, flexRecovered: recovered,
flexBacklog: state.flexBacklog, unshifted,`. In the accumulator add
`accum.unshifted += unshifted;` and in the `pushEnergyHistory` call
`unshifted: accum.unshifted / accum.ticks,`; reset it where the others
reset.

`src/sim/tick.ts`: `pendingHistoryPoint` fallback literal gains
`unshifted: 0` and the averaged branch `unshifted: accum.unshifted / accum.ticks`;
`buildStats` energy `consumption` block gains
`flexDeferred: e.flexDeferred, flexRecovered: e.flexRecovered, flexBacklog: e.flexBacklog,`.
Any other `EnergyHistoryPoint`/`EnergyStats` literal in `src` (grep
`stateOfCharge:` and `heatPumps:`) gains the new fields (tests: `as`
casts or add `unshifted`).

`src/sim/goals.ts`: add `'flexibleCity'` to `GOAL_IDS` (after
`'warmWinter'`), import `meteredCoverage`, and in `goalsStep`:

```ts
// Smart meters: a well-metered city that actually shifts load.
const e = state.lastEnergy;
if (
  population >= CLEAN_DAY_MIN_POPULATION &&
  meteredCoverage(state) >= BALANCE.smartMeters.goalCoverage &&
  e.flexDeferred + e.flexRecovered > 0
) {
  progress.flexTicks++;
}
if (progress.flexTicks >= TICKS_PER_DAY / 2) achieve(state, 'flexibleCity');
```

(use the file's existing achieve helper/pattern — read how `warmWinter`
is marked achieved and mirror it; the counter is cumulative, not a streak.)

- [ ] **Step 4: Run the tests**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm vitest run src/sim src/storage src/agent src/ui`
Expected: PASS, including the engine determinism tests and the existing
energy balance tests (coverage 0 everywhere else).

- [ ] **Step 5: Commit**

```bash
git add -A src/sim src/shared
git commit -m "feat(sim): flexible-load pool with a backlog, flex stats, unshifted history and the flexibleCity goal

Metered households defer a share of their load and on-site heating
while renewables fall short of the inflexible load and recover it from
later surplus, bounded by backlogHours; the history keeps the unshifted
curve for the graph."
```

---

### Task 4: HUD rollout control, energy panel rows, graph line, budget row, strings

**Files:**

- Modify: `src/ui/HudConsole.tsx`, `src/ui/App.tsx`, `src/ui/EnergyPanel.tsx`, `src/ui/EnergyGraph.tsx`, `src/ui/BudgetPanel.tsx`, `src/ui/i18n.tsx`, `src/ui/app.css`
- Modify: `src/shared/types.ts` (`GlobalStats.smartMeters`), `src/sim/tick.ts` (`buildStats`)
- Test: `src/ui/EnergyGraph.test.tsx` (new, only if the project already has a React test setup — check `src/ui/*.test.ts*`; otherwise test the pure series helper) — at minimum unit-test a pure `showsUnshifted(history)` helper exported from `EnergyGraph.tsx`.

**Interfaces:**

- Produces: `GlobalStats.smartMeters: { active: boolean; metered: number; buildings: number; coverage: number; costPerMeter: number }` (alongside the still-present `smartCharging`); new i18n keys (EN+DE): `smartMeters.label` ("Smart-meter rollout" / "Smart-Meter-Ausbau"), `smartMeters.coverage` ("{percent} % metered ({metered}/{buildings})" / "{percent} % mit Zähler ({metered}/{buildings})"), `smartMeters.title` ("Crews install {perDay} meters a day at {cost} each. Metered homes charge cars on surplus and shift part of their load and heating into sunny, windy hours." / "Teams installieren {perDay} Zähler pro Tag zu je {cost}. Haushalte mit Zähler laden Autos bei Überschuss und verschieben einen Teil von Last und Heizung in sonnige, windige Stunden."), `energy.smartMeters` ("📟 Smart meters" / "📟 Smart Meter"), `energy.flexRecovered` ("↪ Load shifted" / "↪ Verschobene Last"), `energy.flexBacklog` ("⏳ Deferred" / "⏳ Aufgeschoben"), `energy.legend.unshifted` ("without shifting" / "ohne Verschiebung"), `budget.smartMeters` ("Smart meters" / "Smart Meter"), `goal.flexibleCity.title` ("Flexible city" / "Flexible Stadt"), `goal.flexibleCity.body` ("Meter 80 % of your buildings and shift load for half a day (50+ residents)." / "Statte 80 % deiner Gebäude mit Smart Metern aus und verschiebe einen halben Tag lang Last (50+ Einwohner)."). The `smartCharging.*` keys are deleted. `help.energy.body` gains one sentence in each language (EN: "Smart meters are rolled out building by building; metered homes charge their cars on surplus and defer part of their load and heating until the sun or wind returns — the dashed grey line in the graph shows what consumption would have been without that." / DE: "Smart Meter werden Gebäude für Gebäude ausgerollt; Haushalte mit Zähler laden ihre Autos bei Überschuss und verschieben einen Teil von Last und Heizung, bis Sonne oder Wind zurück sind — die gestrichelte graue Linie im Diagramm zeigt, wie hoch der Verbrauch ohne diese Verschiebung wäre.").

- [ ] **Step 1: Stats block**

`src/shared/types.ts` `GlobalStats`: after `smartCharging: boolean;` add

```ts
/** Smart-meter rollout: crews active, meters in place, coverage and the price per meter. */
smartMeters: {
  active: boolean;
  metered: number;
  buildings: number;
  coverage: number;
  costPerMeter: number;
}
```

`src/sim/tick.ts` `buildStats`: after `smartCharging: …,` add

```ts
    smartMeters: {
      active: state.smartMeters.active,
      metered: state.smartMeters.metered,
      buildings: countBuildings(state),
      coverage: meteredCoverage(state),
      costPerMeter: BALANCE.smartMeters.costPerMeter,
    },
```

(imports from `./smartMeters.ts`). Any `GlobalStats` literal in tests
gains the block (or uses a cast).

- [ ] **Step 2: HUD control**

`src/ui/HudConsole.tsx`: rename the prop `onSetSmartCharging` →
`onSetSmartMeterRollout: (active: boolean) => void`; replace the
smart-charging `<label>` with:

```tsx
<label
  className="smart-charging-toggle smart-meters"
  data-testid="smart-charging"
  title={t('smartMeters.title', {
    perDay: BALANCE.smartMeters.installsPerDay,
    cost: BALANCE.smartMeters.costPerMeter,
  })}
>
  <input
    type="checkbox"
    checked={stats.smartMeters.active}
    onChange={(e) => onSetSmartMeterRollout(e.target.checked)}
  />
  <span>{t('smartMeters.label')}</span>
  <span className="smart-meters-coverage" data-testid="smart-meters-coverage">
    {t('smartMeters.coverage', {
      percent: Math.round(stats.smartMeters.coverage * 100),
      metered: stats.smartMeters.metered,
      buildings: stats.smartMeters.buildings,
    })}
  </span>
</label>
```

`src/ui/App.tsx`: `onSetSmartMeterRollout={(active) => bridge.send({ type: 'setSmartMeterRollout', active })}`.
`src/ui/app.css`: after `.smart-charging-toggle input { … }` add

```css
.smart-meters-coverage {
  margin-left: auto;
  color: var(--hud-muted, var(--hud-text));
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
```

(check the file for the muted colour variable it already uses and use
that name).

- [ ] **Step 3: Energy panel and budget rows**

`src/ui/EnergyPanel.tsx`: after the heat-pumps `<Row>` add

```tsx
{
  (energy.consumption.flexRecovered > 0 || energy.consumption.flexBacklog > 0) && (
    <>
      <Row
        label={t('energy.flexRecovered')}
        value={energy.consumption.flexRecovered}
        testId="detail-energy-flex-recovered"
        tone="positive"
      />
      <Row
        label={t('energy.flexBacklog')}
        value={energy.consumption.flexBacklog}
        testId="detail-energy-flex-backlog"
      />
    </>
  );
}
```

`src/ui/BudgetPanel.tsx`: add an expense slice after `repair`:

```ts
    {
      key: 'smartMeters',
      label: t('budget.smartMeters'),
      value: perDay(budget.smartMeters),
      color: EXPENSE_COLORS.smartMeters,
    },
```

with `smartMeters: '#8fb3c9'` in `EXPENSE_COLORS`.

- [ ] **Step 4: Graph line**

`src/ui/EnergyGraph.tsx`: add `unshifted: Array<[number, number]>` to
`Series`, `unshifted: project((p) => p.unshifted)` in `seriesOf`, export
a pure helper

```ts
/** The dashed line only earns its place once shifting actually happens. */
export function showsUnshifted(energy: Pick<EnergyStats, 'history' | 'pending'>): boolean {
  return [...energy.history, energy.pending].some(
    (p) => Math.abs(p.unshifted - p.consumption) > 1e-6,
  );
}
```

and draw, before `<Curves>` and after the price polyline, when
`showsUnshifted(energy)`:

```tsx
{
  showsUnshifted(energy) && (
    <polyline
      points={line(series.unshifted)}
      fill="none"
      style={{ stroke: CONSUMPTION_COLOR, opacity: 0.55 }}
      strokeWidth="1.5"
      strokeDasharray="4 3"
      strokeLinejoin="round"
      vectorEffect="non-scaling-stroke"
    />
  );
}
```

Legend: add `<span className="legend-unshifted">{t('energy.legend.unshifted')}</span>`
after the consumption legend, shown under the same condition, with a CSS
rule mirroring `.legend-consumption` but dashed/muted (copy the existing
legend rule pattern in `app.css`). Include `unshifted` in `useNiceMax`'s
peak so the dashed line never clips.

Test (`src/ui/EnergyGraph.test.ts`, new, no DOM needed):

```ts
import { describe, expect, it } from 'vitest';
import { showsUnshifted } from './EnergyGraph.tsx';

const point = (consumption: number, unshifted: number) => ({
  generation: 0,
  consumption,
  unshifted,
  stateOfCharge: 0,
  price: 1,
});

describe('showsUnshifted', () => {
  it('hides the dashed line while nothing is shifted and shows it once something is', () => {
    expect(showsUnshifted({ history: [point(10, 10)], pending: point(12, 12) })).toBe(false);
    expect(showsUnshifted({ history: [point(10, 10)], pending: point(12, 13) })).toBe(true);
  });
});
```

If importing a `.tsx` module in a node test pulls React in and fails,
move `showsUnshifted` to `src/ui/energyGraphSeries.ts` and import it in
both places.

- [ ] **Step 5: Strings**

`src/ui/i18n.tsx`: delete the two `smartCharging.*` keys in both
languages; add the keys listed under Interfaces in both languages;
extend `help.energy.body` in both. Typecheck fails if the key sets
differ.

- [ ] **Step 6: Check**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm vitest run src/ui src/sim/engine.test.ts`
Expected: PASS. Then `pnpm build` once (catches a bad JSX/CSS import).

- [ ] **Step 7: Commit**

```bash
git add -A src/ui src/shared/types.ts src/sim/tick.ts
git commit -m "feat(ui): smart-meter rollout control, shifted-load rows, dashed unshifted line, budget row

The smart-charging toggle becomes the rollout switch with coverage in
its label (same test id); the energy panel shows load shifted and the
backlog; the graph draws what consumption would have been without
shifting. English and German."
```

---

### Task 5: Agent tool, overview and energy report, docs; retire `GlobalStats.smartCharging`

**Files:**

- Modify: `src/agent/tools.ts`, `src/agent/tools.test.ts`, `docs/agent-tools.md`
- Modify: `src/shared/types.ts`, `src/sim/tick.ts` (drop `GlobalStats.smartCharging`)
- Test: `src/agent/tools.test.ts`

**Interfaces:**

- Produces: tool `set_smart_meter_rollout { active: boolean }` (replaces `set_smart_charging`); `get_game_overview.smartMeters = { active, metered, buildings, coverage }`; `get_energy_report` includes the three flex figures (already spread from `s.energy`) and `unshifted` in each history sample.

- [ ] **Step 1: Write the failing tests**

In `src/agent/tools.test.ts`: in the tool-name list replace
`'set_smart_charging'` with `'set_smart_meter_rollout'`; replace the
validation line with
`expect(await call('set_smart_meter_rollout', { active: 'yes' })).toMatchObject({ ok: false });`;
in "sets speed, tax rate, smart charging and buys insulation" replace the
smart-charging call with

```ts
expect(await call('set_smart_meter_rollout', { active: true })).toMatchObject({ ok: true });
expect(engine.state.smartMeters.active).toBe(true);
const overview = await call('get_game_overview');
expect(overview.smartMeters).toMatchObject({ active: true });
expect(overview).not.toHaveProperty('smartCharging');
const report = await call('get_energy_report');
expect((report.history as Array<Record<string, unknown>>)[0]).toHaveProperty('unshifted');
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/agent/tools.test.ts`
Expected: FAIL — unknown tool name.

- [ ] **Step 3: Implement**

`src/agent/tools.ts`: replace the `set_smart_charging` tool with

```ts
    {
      name: 'set_smart_meter_rollout',
      description:
        `Start or pause the smart-meter rollout. Crews install ${BALANCE.smartMeters.installsPerDay} meters per in-game day at ${BALANCE.smartMeters.costPerMeter} each; coverage (metered buildings / buildings) scales smart EV charging and the flexible-load pool that shifts household and heating load into renewable surplus. See smartMeters in get_game_overview.`,
      inputSchema: {
        type: 'object',
        properties: { active: { type: 'boolean' } },
        required: ['active'],
      },
      async execute(input) {
        if (typeof input.active !== 'boolean') throw new ToolInputError('"active" must be boolean');
        const outcome = await ctx.sendCommand({ type: 'setSmartMeterRollout', active: input.active });
        return outcomeResult(outcome, { smartMeters: { active: input.active } });
      },
    },
```

In `get_game_overview` replace `smartCharging: s.smartCharging,` with
`smartMeters: { active: s.smartMeters.active, metered: s.smartMeters.metered, buildings: s.smartMeters.buildings, coverage: round(s.smartMeters.coverage, 2) },`.
In `get_energy_report` history mapping add `unshifted: round(point.unshifted),`
and extend its description with ", flexible-load figures (flexDeferred,
flexRecovered, flexBacklog) and the unshifted curve".

`src/shared/types.ts`: delete `GlobalStats.smartCharging`; `src/sim/tick.ts`
`buildStats`: delete the line. `grep -rn "smartCharging" src` must then
show only the `SaveGame`/`SaveGameJson` legacy fields and the migration.

`docs/agent-tools.md`: replace the `set_smart_charging` row with
``| `set_smart_meter_rollout` | write | `active: boolean` — start/pause the paced, paid rollout; coverage scales smart EV charging and the flexible-load pool |``;
in the `get_game_overview` row add "smart-meter rollout (active, metered,
buildings, coverage)"; in `get_energy_report` add "flexible-load figures
and the `unshifted` curve".

- [ ] **Step 4: Run everything**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src/agent src/shared/types.ts src/sim/tick.ts docs/agent-tools.md
git commit -m "feat(agent): set_smart_meter_rollout replaces set_smart_charging; overview and energy report carry the rollout and flex figures"
```

---

### Task 6: Pacing probe, balance freeze, docs, full checks

**Files:**

- Create (temporary, deleted before commit): `src/sim/_smartMetersProbe.test.ts`
- Modify: `src/shared/constants.ts` (final values), `docs/superpowers/specs/2026-10-04-smart-meters-design.md` (final numbers + any deviation), `docs/plan.md` (module map: `smartMeters.ts`), `docs/idea.md` (mark the backlog entry done)
- Test: full checks + `node scripts/smoke.mjs` + `pnpm coverage`

- [ ] **Step 1: Probe**

Write `src/sim/_smartMetersProbe.test.ts` following the pattern of the
project's earlier balance probes (see the commit "balance: resize energy
system"): build a 24×24 city through `SimEngine` commands (a road grid,
residential/commercial zones, 3 wind turbines + 2 solar farms + a
battery, power lines), run 5 in-game days to let it grow, start the
rollout, then run 20 in-game days and `console.log` per day: coverage,
cumulative cost, shifted energy / total consumption, evening-peak
consumption vs unshifted peak, backlog max. Run it with
`pnpm vitest run src/sim/_smartMetersProbe.test.ts`.

- [ ] **Step 2: Tune**

Targets (from the spec): full coverage of a mid-size city in roughly one
in-game year (20 days) — adjust `installsPerDay`; shifted load clearly
visible (≥ 5 % of consumption on a sunny/windy day) without emptying
storage's job — adjust the flex shares / backlog hours; cost noticeable
but not punishing relative to the city's daily tax income — adjust
`costPerMeter`. Record the final table in the report and in the spec's
Balance section.

- [ ] **Step 3: Delete the probe, update docs**

`rm src/sim/_smartMetersProbe.test.ts`. `docs/plan.md` module map gains
`    smartMeters.ts # smart-meter rollout: coverage, paced installs, billing, vehicle gate`.
`docs/idea.md`: mark **Smart-meter rollout** as (done) with a one-line
summary like the other done entries. Spec: final numbers, and note the
staged `GlobalStats.smartCharging` removal.

- [ ] **Step 4: Run everything**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm coverage && node scripts/smoke.mjs`
Expected: all PASS (dev server for the smoke script may need
`pnpm dev --host 127.0.0.1 --port 5173 --strictPort`; stop it after).

- [ ] **Step 5: Commit**

```bash
git add src/shared/constants.ts docs/superpowers/specs/2026-10-04-smart-meters-design.md docs/plan.md docs/idea.md
git commit -m "balance: tune the smart-meter rollout from a headless probe; docs"
```

- [ ] **Step 6: Hand back for the Mac visual pass**

Report: the dashed line against the solid consumption line; the HUD
label width in both languages; the rollout at 0 %, mid-way and 100 %;
the energy panel rows; the e2e checkbox test still green on CI.
