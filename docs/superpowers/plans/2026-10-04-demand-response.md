# Demand Response Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A demand-response contract with the commercial and retail
zones: a sheddable share of their base load, dispatched automatically
inside the deficit cascade when a call is cheaper than importing or the
link is saturated, billed as a daily retainer plus an activation
premium, limited to a few call hours per day, with a budget line, HUD
control, energy-panel row, goal and agent tool.

**Architecture:** New sim module `src/sim/demandResponse.ts` holds the
contract state helpers, the pure dispatch rule and the billing step;
`energyStep` sums the business base load, calls the dispatch between
biogas and import, and reports the shed; `stepTick` bills right after
the smart meters; stats, goal, UI and agent follow. Every commit
typechecks and passes the pre-commit hook.

**Tech Stack:** TypeScript (strict), React 19, Vitest, pnpm, oxlint,
oxfmt.

**Spec:** `docs/superpowers/specs/2026-10-04-demand-response-design.md`

## Global Constraints

- Balance values live only in `BALANCE.demandResponse`; no magic
  numbers in sim code. No randomness added (determinism tests must
  pass).
- Save compatibility: `SAVE_VERSION` stays 1; new `SaveGame` fields are
  optional; an old save loads with the contract off and a full call
  budget.
- With the contract off the energy step is numerically identical to
  today.
- All user-visible strings go through `src/ui/i18n.tsx`, English AND
  German.
- Run `pnpm format` after every edit; the pre-commit hook runs
  `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` and
  must pass. Never use `--no-verify`.
- Commit messages end with
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Work on branch `feat/demand-response` (already created, holds the
  spec).

## File map

| File                                                                                 | Responsibility                                                                                                |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `src/shared/constants.ts`                                                            | `BALANCE.demandResponse` block                                                                                |
| `src/sim/demandResponse.ts` (new)                                                    | `callBudgetTicks`, `setDemandResponse`, `dispatchDemandResponse`, `demandResponseStep`                        |
| `src/sim/state.ts`                                                                   | state fields, defaults, `lastEnergy` fields, serialize/deserialize                                            |
| `src/shared/types.ts`                                                                | `SaveGame`, `EnergyStats.consumption.shed`, `GlobalStats.demandResponse`, `GlobalStats.budget.demandResponse` |
| `src/storage/serialization.ts`                                                       | JSON round-trip of the new save fields                                                                        |
| `src/sim/energy.ts`                                                                  | business base-load sum, dispatch call, reporting                                                              |
| `src/sim/tick.ts`                                                                    | step order, stats assembly, budget flattening                                                                 |
| `src/sim/goals.ts`                                                                   | `loadManager` goal                                                                                            |
| `src/shared/messages.ts`, `src/sim/engine.ts`                                        | `setDemandResponse` command                                                                                   |
| `src/ui/HudConsole.tsx`, `App.tsx`, `EnergyPanel.tsx`, `BudgetPanel.tsx`, `i18n.tsx` | control, rows, strings                                                                                        |
| `src/agent/tools.ts`, `docs/agent-tools.md`                                          | `set_demand_response`, overview block                                                                         |
| `e2e/game.spec.ts`                                                                   | one click on the new toggle                                                                                   |
| `docs/idea.md`                                                                       | backlog entry marked done                                                                                     |

---

### Task 1: Balance, state and save fields

**Files:**

- Modify: `src/shared/constants.ts` (after the `smartMeters: { … }` block, ~line 690)
- Create: `src/sim/demandResponse.ts`
- Modify: `src/sim/state.ts` (interface ~line 234, defaults ~line 463, goalProgress ~line 341/518, serialize ~line 902, deserialize ~line 990)
- Modify: `src/shared/types.ts` (`SaveGame`, after `flexBacklog?` ~line 748)
- Modify: `src/storage/serialization.ts` (`SaveGameJson`, `saveToJson`, `saveFromJson`, guard)
- Test: `src/sim/demandResponse.test.ts` (new), `src/storage/serialization.test.ts`

**Interfaces:**

- Produces: `BALANCE.demandResponse.{shedShare, retainerPerBuildingPerDay, activationPricePerEnergyUnit, maxCallHoursPerDay, goalShedEnergy}`;
  `SimState.demandResponse: { active: boolean; callBudget: number }`;
  `SimState.lastDemandResponseCost: number`; `SimState.goalProgress.shedTotal: number`;
  `callBudgetTicks(): number`; `setDemandResponse(state, active): void`;
  `SaveGame.demandResponse?: { active: boolean; callBudget: number }`; `SaveGame.shedTotal?: number`.

- [ ] **Step 1: Write the failing tests**

Create `src/sim/demandResponse.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import { callBudgetTicks, setDemandResponse } from './demandResponse.ts';
import { createSimState, deserializeState, serializeState } from './state.ts';

const SIZE = 16;

describe('demand-response contract state', () => {
  it('starts off with a full call budget', () => {
    const state = createSimState(1, SIZE);
    expect(state.demandResponse).toEqual({ active: false, callBudget: callBudgetTicks() });
    expect(state.lastDemandResponseCost).toBe(0);
    expect(state.goalProgress.shedTotal).toBe(0);
  });

  it('callBudgetTicks is maxCallHoursPerDay in ticks', () => {
    expect(callBudgetTicks()).toBeCloseTo(
      (BALANCE.demandResponse.maxCallHoursPerDay * TICKS_PER_DAY) / 24,
      9,
    );
  });

  it('setDemandResponse flips the contract and marks the stats dirty', () => {
    const state = createSimState(1, SIZE);
    state.statsDirty = false;
    setDemandResponse(state, true);
    expect(state.demandResponse.active).toBe(true);
    expect(state.statsDirty).toBe(true);
    setDemandResponse(state, false);
    expect(state.demandResponse.active).toBe(false);
  });

  it('round-trips the contract, the call budget and the shed total', () => {
    const state = createSimState(1, SIZE);
    state.demandResponse = { active: true, callBudget: 12.5 };
    state.goalProgress.shedTotal = 321;
    const restored = deserializeState(serializeState(state));
    expect(restored.demandResponse).toEqual({ active: true, callBudget: 12.5 });
    expect(restored.goalProgress.shedTotal).toBe(321);
  });

  it('loads an old save with the contract off and a full budget', () => {
    const state = createSimState(1, SIZE);
    const save = serializeState(state);
    delete save.demandResponse;
    delete save.shedTotal;
    const restored = deserializeState(save);
    expect(restored.demandResponse).toEqual({ active: false, callBudget: callBudgetTicks() });
    expect(restored.goalProgress.shedTotal).toBe(0);
  });

  it('clamps a hand-edited call budget into the daily allowance', () => {
    const state = createSimState(1, SIZE);
    const save = serializeState(state);
    save.demandResponse = { active: true, callBudget: 1e9 };
    expect(deserializeState(save).demandResponse.callBudget).toBe(callBudgetTicks());
    save.demandResponse = { active: true, callBudget: Number.NaN };
    expect(deserializeState(save).demandResponse.callBudget).toBe(callBudgetTicks());
  });
});
```

Append to `src/storage/serialization.test.ts` (inside the existing
`describe` that holds the smart-meter round-trip, after the
`'accepts an old save without smartMeters or flexBacklog'` test):

```ts
it('round-trips the demand-response contract and the shed total', () => {
  const save = makeSave();
  save.demandResponse = { active: true, callBudget: 7.5 };
  save.shedTotal = 456;
  const restored = saveFromJson(saveToJson(save));
  expect(restored.demandResponse).toEqual({ active: true, callBudget: 7.5 });
  expect(restored.shedTotal).toBe(456);
});

it('accepts an old save without demandResponse or shedTotal', () => {
  const restored = saveFromJson(saveToJson(makeSave()));
  expect(restored.demandResponse).toBeUndefined();
  expect(restored.shedTotal).toBeUndefined();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/sim/demandResponse.test.ts src/storage/serialization.test.ts`
Expected: FAIL — `./demandResponse.ts` cannot be resolved; the
serialization tests fail on `demandResponse` being undefined after the
round-trip.

- [ ] **Step 3: Add the balance block**

In `src/shared/constants.ts`, directly after the closing `},` of the
`smartMeters: { … }` block (still inside `BALANCE`):

```ts
  /**
   * Demand response: a contract with the commercial and retail zones
   * under which a share of their base load is shed in a deficit. Called
   * automatically inside the cascade (after biogas, before import)
   * when a call is cheaper than importing at the tick's spot price, or
   * when the shortfall exceeds the import link. Initial values; the
   * pacing probe freezes them (see the design spec).
   */
  demandResponse: {
    /** Share of the commercial and retail base load the contract may shed. */
    shedShare: 0.4,
    /** Retainer per contracted business building and in-game day, paid while the contract runs. */
    retainerPerBuildingPerDay: 20,
    /**
     * Paid per energy unit shed. Below market.importCostPerEnergyUnit, so
     * a call beats importing whenever spot >= activationPrice / importCost
     * (0.75 at these values) — normal and scarce prices, not abundance.
     */
    activationPricePerEnergyUnit: 0.3,
    /** Hours of full-pool shedding the contract allows per in-game day. */
    maxCallHoursPerDay: 4,
    /** Cumulative shed energy the loadManager goal requires. */
    goalShedEnergy: 2_000,
  },
```

- [ ] **Step 4: Create the module with the state helpers**

Create `src/sim/demandResponse.ts`:

```ts
import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import type { SimState } from './state.ts';

/** The contract's daily allowance of full-pool shedding, in ticks. */
export function callBudgetTicks(): number {
  return (BALANCE.demandResponse.maxCallHoursPerDay * TICKS_PER_DAY) / 24;
}

/** Sign or end the contract. Ending it clears nothing else: the day's budget keeps counting down. */
export function setDemandResponse(state: SimState, active: boolean): void {
  state.demandResponse.active = active;
  state.statsDirty = true;
}
```

- [ ] **Step 5: Add the state fields, defaults and save mapping**

In `src/sim/state.ts`:

1. Add the import near the other sim imports at the top of the file:

```ts
import { callBudgetTicks } from './demandResponse.ts';
```

2. In the `SimState` interface, directly after `lastSmartMeterCost: number;`:

```ts
/**
 * Demand-response contract with the commercial and retail zones:
 * whether it is in force, and the ticks of full-pool shedding still
 * allowed today (fractions for partial calls). The budget is
 * persisted so a reload cannot refill the day's allowance.
 */
demandResponse: {
  active: boolean;
  callBudget: number;
}
/** Retainer plus activation premiums paid last tick (budget line). */
lastDemandResponseCost: number;
```

3. In the `goalProgress` interface block, after `flexTicks: number;`:

```ts
/** Cumulative energy shed under the contract (loadManager); persisted like flexTicks. */
shedTotal: number;
```

4. In `createSimState`, after `lastSmartMeterCost: 0,`:

```ts
    demandResponse: { active: false, callBudget: callBudgetTicks() },
    lastDemandResponseCost: 0,
```

and in the `goalProgress` literal, after `flexTicks: 0,`:

```ts
      shedTotal: 0,
```

5. In `serializeState`, after `flexTicks: state.goalProgress.flexTicks,`:

```ts
    demandResponse: {
      active: state.demandResponse.active,
      callBudget: state.demandResponse.callBudget,
    },
    shedTotal: state.goalProgress.shedTotal,
```

6. In `deserializeState`, after `state.goalProgress.flexTicks = save.flexTicks ?? 0;`:

```ts
state.goalProgress.shedTotal =
  typeof save.shedTotal === 'number' && Number.isFinite(save.shedTotal)
    ? Math.max(0, save.shedTotal)
    : 0;
// Clamp into the daily allowance: a hand-edited export must not grant
// more call hours than a day has, and NaN would poison the budget.
const savedBudget = save.demandResponse?.callBudget;
state.demandResponse = {
  active: save.demandResponse?.active === true,
  callBudget:
    typeof savedBudget === 'number' && Number.isFinite(savedBudget)
      ? Math.min(callBudgetTicks(), Math.max(0, savedBudget))
      : callBudgetTicks(),
};
```

In `src/shared/types.ts`, in `SaveGame` after `flexBacklog?: number;`:

```ts
  /** Demand-response contract and the call budget left today (absent in older saves → off, full). */
  demandResponse?: { active: boolean; callBudget: number };
  /** Cumulative energy shed under the contract (absent in older saves → 0). */
  shedTotal?: number;
```

In `src/storage/serialization.ts`:

1. In `SaveGameJson` after `flexBacklog?: number;`:

```ts
  demandResponse?: { active: boolean; callBudget: number };
  shedTotal?: number;
```

2. In `saveToJson`'s object literal after the `flexBacklog` spread:

```ts
    ...(save.demandResponse !== undefined ? { demandResponse: save.demandResponse } : {}),
    ...(save.shedTotal !== undefined ? { shedTotal: save.shedTotal } : {}),
```

3. Next to `isSavedSmartMeters` add:

```ts
function isSavedDemandResponse(value: unknown): value is { active: boolean; callBudget: number } {
  if (typeof value !== 'object' || value === null) return false;
  const d = value as Partial<{ active: boolean; callBudget: number }>;
  return typeof d.active === 'boolean' && typeof d.callBudget === 'number';
}
```

4. In `saveFromJson`'s returned literal after the `flexBacklog` spread:

```ts
    ...(isSavedDemandResponse(parsed.demandResponse)
      ? { demandResponse: parsed.demandResponse }
      : {}),
    ...(typeof parsed.shedTotal === 'number' && Number.isFinite(parsed.shedTotal)
      ? { shedTotal: parsed.shedTotal }
      : {}),
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm format && pnpm vitest run src/sim/demandResponse.test.ts src/storage/serialization.test.ts src/sim/state.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/shared/constants.ts src/sim/demandResponse.ts src/sim/demandResponse.test.ts src/sim/state.ts src/shared/types.ts src/storage/serialization.ts src/storage/serialization.test.ts
git commit -m "feat(sim): demand-response contract state, balance block and save fields

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Dispatch rule and the energy cascade

**Files:**

- Modify: `src/sim/demandResponse.ts`
- Modify: `src/sim/energy.ts` (building loop ~line 364-388, cascade ~line 515-537, reporting ~line 598-640)
- Modify: `src/sim/state.ts` (`lastEnergy` interface ~line 412, defaults ~line 574)
- Test: `src/sim/demandResponse.test.ts`, `src/sim/energy.test.ts`

**Interfaces:**

- Consumes: `BALANCE.demandResponse`, `state.demandResponse`, `callBudgetTicks()` (Task 1).
- Produces: `dispatchDemandResponse(state, businessDemand, shortfall, spotPrice): { pool: number; shed: number }`;
  `state.lastEnergy.shed`, `state.lastEnergy.shedPool`, `state.lastEnergy.contractedBuildings`.

- [ ] **Step 1: Write the failing unit tests for the dispatch rule**

Append to `src/sim/demandResponse.test.ts` (add `dispatchDemandResponse` to the import from `./demandResponse.ts`):

```ts
describe('dispatchDemandResponse', () => {
  const { shedShare, activationPricePerEnergyUnit } = BALANCE.demandResponse;
  const { importCapacity, importCostPerEnergyUnit } = BALANCE.market;
  /** Spot factor at which importing costs exactly the activation premium. */
  const breakEven = activationPricePerEnergyUnit / importCostPerEnergyUnit;

  function contracted(): ReturnType<typeof createSimState> {
    const state = createSimState(1, SIZE);
    state.demandResponse.active = true;
    state.tick = 1; // not a day boundary
    return state;
  }

  it('sheds nothing with the contract off', () => {
    const state = createSimState(1, SIZE);
    const call = dispatchDemandResponse(state, 100, 50, breakEven + 1);
    expect(call).toEqual({ pool: 0, shed: 0 });
    expect(state.demandResponse.callBudget).toBe(callBudgetTicks());
  });

  it('the pool is shedShare of the business base load', () => {
    const state = contracted();
    expect(dispatchDemandResponse(state, 100, 0, 1).pool).toBeCloseTo(shedShare * 100, 9);
  });

  it('sheds up to the pool when importing is dearer than a call', () => {
    const state = contracted();
    const call = dispatchDemandResponse(state, 100, 30, breakEven);
    expect(call.shed).toBeCloseTo(30, 9);
    const big = dispatchDemandResponse(contracted(), 100, 1000, breakEven);
    expect(big.shed).toBeCloseTo(shedShare * 100, 9);
  });

  it('sheds nothing at abundance prices while the link can carry the shortfall', () => {
    const state = contracted();
    const call = dispatchDemandResponse(state, 100, importCapacity, breakEven - 0.01);
    expect(call.shed).toBe(0);
    expect(state.demandResponse.callBudget).toBe(callBudgetTicks());
  });

  it('sheds only the excess over the link at abundance prices', () => {
    const state = contracted();
    const call = dispatchDemandResponse(state, 100, importCapacity + 10, breakEven - 0.01);
    expect(call.shed).toBeCloseTo(10, 9);
  });

  it('spends the call budget in proportion to the pool used', () => {
    const state = contracted();
    dispatchDemandResponse(state, 100, shedShare * 100, breakEven); // a full-pool tick
    expect(state.demandResponse.callBudget).toBeCloseTo(callBudgetTicks() - 1, 9);
    dispatchDemandResponse(state, 100, shedShare * 50, breakEven); // half the pool
    expect(state.demandResponse.callBudget).toBeCloseTo(callBudgetTicks() - 1.5, 9);
  });

  it('runs the budget down to a partial last call and then nothing', () => {
    const state = contracted();
    state.demandResponse.callBudget = 0.25;
    const partial = dispatchDemandResponse(state, 100, 1000, breakEven);
    expect(partial.shed).toBeCloseTo(0.25 * shedShare * 100, 9);
    expect(state.demandResponse.callBudget).toBeCloseTo(0, 9);
    expect(dispatchDemandResponse(state, 100, 1000, breakEven).shed).toBe(0);
  });

  it('refills the budget at the start of a day', () => {
    const state = contracted();
    state.demandResponse.callBudget = 0;
    state.tick = TICKS_PER_DAY;
    const call = dispatchDemandResponse(state, 100, 1000, breakEven);
    expect(call.shed).toBeCloseTo(shedShare * 100, 9);
    expect(state.demandResponse.callBudget).toBeCloseTo(callBudgetTicks() - 1, 9);
  });

  it('never sheds more than the shortfall', () => {
    const state = contracted();
    expect(dispatchDemandResponse(state, 100, 5, breakEven).shed).toBeCloseTo(5, 9);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/sim/demandResponse.test.ts`
Expected: FAIL — `dispatchDemandResponse` is not exported.

- [ ] **Step 3: Implement the dispatch rule**

Append to `src/sim/demandResponse.ts`:

```ts
export interface DemandResponseCall {
  /** Energy the contract could shed this tick (shedShare of the business base load, 0 when off). */
  pool: number;
  /** Energy actually shed this tick. */
  shed: number;
}

/**
 * One tick of the contract inside the deficit cascade (after biogas,
 * before import). `shortfall` is what is still uncovered, `spotPrice`
 * the tick's spot factor. Two rules, combined with max rather than
 * summed: the economic call sheds whatever the pool can give whenever
 * importing would cost more than the activation premium; the security
 * call only adds, at abundance prices, the part of the shortfall the
 * import link cannot carry. The day's allowance refills on the first
 * tick of every in-game day and is spent in fractions of a full-pool
 * tick, so a partial call costs a partial tick. Shed energy is gone,
 * not deferred.
 */
export function dispatchDemandResponse(
  state: SimState,
  businessDemand: number,
  shortfall: number,
  spotPrice: number,
): DemandResponseCall {
  const contract = state.demandResponse;
  if (state.tick % TICKS_PER_DAY === 0) contract.callBudget = callBudgetTicks();
  if (!contract.active) return { pool: 0, shed: 0 };
  const { shedShare, activationPricePerEnergyUnit } = BALANCE.demandResponse;
  const { importCapacity, importCostPerEnergyUnit } = BALANCE.market;
  const pool = shedShare * businessDemand;
  if (pool <= 0 || shortfall <= 0) return { pool, shed: 0 };
  const available = pool * Math.min(1, Math.max(0, contract.callBudget));
  const importPrice = importCostPerEnergyUnit * spotPrice;
  const economic = importPrice >= activationPricePerEnergyUnit ? Math.min(shortfall, available) : 0;
  const secure = Math.min(Math.max(0, shortfall - importCapacity), available);
  const shed = Math.max(economic, secure);
  contract.callBudget = Math.max(0, contract.callBudget - shed / pool);
  return { pool, shed };
}
```

- [ ] **Step 4: Run the unit tests to verify they pass**

Run: `pnpm format && pnpm vitest run src/sim/demandResponse.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing energy-step tests**

Append to `src/sim/energy.test.ts` a new `describe` at the end of the
file. It reuses the file's `makeState`, `addBuilding`, `at`, `placePlant`,
`Zone`, `PlantType`, `SupplyStatus` and `TICKS_PER_DAY`; add
`import { spotPriceFactor } from './market.ts';` and
`import { callBudgetTicks } from './demandResponse.ts';` to the imports.

```ts
describe('demand response in the cascade', () => {
  const { shedShare, activationPricePerEnergyUnit } = BALANCE.demandResponse;

  /**
   * Twenty dense business buildings next to a wind turbine that stands
   * still: a scarce noon (clouds, no wind → high spot price) with a
   * shortfall far beyond the import link.
   */
  function scarceBusinessTown(zone: Zone = Zone.Commercial): SimState {
    const state = makeState();
    placePlant(state, at(6, 5), PlantType.WindTurbine);
    state.weather.windSpeed = 0;
    for (let i = 0; i < 20; i++) {
      addBuilding(state, at(3 + (i % 7), 2 + Math.floor(i / 7)), zone, 3);
    }
    state.tick = TICKS_PER_DAY / 2 + 1; // noon, not a day boundary
    state.weather.cloudCover = 1;
    state.demandResponse.active = true;
    return state;
  }

  /** Businesses' base load this tick, before any shedding (same town, contract off). */
  function businessBase(): number {
    const bare = scarceBusinessTown();
    bare.demandResponse.active = false;
    energyStep(bare, { chargingDemand: 0 });
    return bare.lastEnergy.buildingConsumption;
  }

  it('is a no-op with the contract off', () => {
    const state = scarceBusinessTown();
    state.demandResponse.active = false;
    energyStep(state, { chargingDemand: 0 });
    expect(state.lastEnergy.shed).toBe(0);
    expect(state.lastEnergy.shedPool).toBe(0);
    expect(state.lastEnergy.contractedBuildings).toBe(20);
    expect(state.demandResponse.callBudget).toBe(callBudgetTicks());
  });

  it('sheds the pool before importing at a scarce price', () => {
    const state = scarceBusinessTown();
    const importPrice = BALANCE.market.importCostPerEnergyUnit * spotPriceFactor(state);
    expect(importPrice).toBeGreaterThanOrEqual(activationPricePerEnergyUnit); // precondition
    const base = businessBase();
    energyStep(state, { chargingDemand: 0 });
    const e = state.lastEnergy;
    expect(e.shedPool).toBeCloseTo(shedShare * base, 6);
    expect(e.shed).toBeCloseTo(e.shedPool, 6);
    expect(e.buildingConsumption).toBeCloseTo(base - e.shed, 6);
    expect(e.gridImport).toBeCloseTo(BALANCE.market.importCapacity, 6);
    // The deficit is what the pool and the link together cannot cover.
    expect(e.deficit).toBeCloseTo(base - e.rooftop - e.shed - BALANCE.market.importCapacity, 6);
    expect(e.unshifted - e.buildingConsumption).toBeCloseTo(e.shed, 6);
    expect(state.demandResponse.callBudget).toBeCloseTo(callBudgetTicks() - 1, 6);
  });

  it('a residential town has nothing to shed', () => {
    const state = scarceBusinessTown(Zone.Residential);
    energyStep(state, { chargingDemand: 0 });
    expect(state.lastEnergy.shedPool).toBe(0);
    expect(state.lastEnergy.shed).toBe(0);
    expect(state.lastEnergy.contractedBuildings).toBe(0);
  });

  it('a small shortfall at an abundance price imports instead of shedding', () => {
    const state = makeState();
    // A battery (empty) connects the building; strong wind with no
    // turbine keeps generation at zero but pushes the spot price down.
    placePlant(state, at(6, 5), PlantType.Battery);
    state.storedEnergy = 0;
    // 0.8, not 1: at 1 the turbines' cut-out speed zeroes the wind
    // factor and the spot price would read scarce instead.
    state.weather.windSpeed = 0.8;
    state.weather.cloudCover = 1;
    addBuilding(state, at(8, 5), Zone.Retail, 3);
    state.tick = TICKS_PER_DAY / 8 + 1; // 3 am: low regional demand
    state.demandResponse.active = true;
    const importPrice = BALANCE.market.importCostPerEnergyUnit * spotPriceFactor(state);
    expect(importPrice).toBeLessThan(activationPricePerEnergyUnit); // precondition
    energyStep(state, { chargingDemand: 0 });
    expect(state.lastEnergy.shedPool).toBeGreaterThan(0);
    expect(state.lastEnergy.shed).toBe(0);
    expect(state.lastEnergy.gridImport).toBeGreaterThan(0);
    expect(state.lastEnergy.deficit).toBe(0);
  });

  it("falls through to import and deficit once the day's budget is spent", () => {
    const state = scarceBusinessTown();
    state.demandResponse.callBudget = 0;
    const base = businessBase();
    energyStep(state, { chargingDemand: 0 });
    const e = state.lastEnergy;
    expect(e.shed).toBe(0);
    expect(e.buildingConsumption).toBeCloseTo(base, 6);
    expect(e.deficit).toBeCloseTo(base - e.rooftop - BALANCE.market.importCapacity, 6);
  });

  it('flickers fewer buildings into undersupply when the contract sheds', () => {
    const count = (state: SimState): number => {
      let n = 0;
      for (let i = 0; i < 20; i++) {
        if (
          state.layers.supplied[at(3 + (i % 7), 2 + Math.floor(i / 7))] ===
          SupplyStatus.Undersupplied
        )
          n++;
      }
      return n;
    };
    const off = scarceBusinessTown();
    off.demandResponse.active = false;
    energyStep(off, { chargingDemand: 0 });
    const on = scarceBusinessTown();
    energyStep(on, { chargingDemand: 0 });
    expect(count(on)).toBeLessThan(count(off));
  });
});
```

- [ ] **Step 6: Run the energy tests to verify they fail**

Run: `pnpm vitest run src/sim/energy.test.ts -t "demand response"`
Expected: FAIL — `shed`, `shedPool`, `contractedBuildings` are undefined on `lastEnergy`.

- [ ] **Step 7: Wire the dispatch into the energy step**

In `src/sim/state.ts`, in the `lastEnergy` interface after `unshifted: number;`:

```ts
/** Energy shed under the demand-response contract this tick. */
shed: number;
/** What the contract could have shed this tick (0 while it is off). */
shedPool: number;
/** Connected commercial and retail buildings (the contract's partners). */
contractedBuildings: number;
```

and in the `createSimState` defaults for `lastEnergy` after `unshifted: 0,`:

```ts
      shed: 0,
      shedPool: 0,
      contractedBuildings: 0,
```

In `src/sim/energy.ts`:

1. Add the import:

```ts
import { dispatchDemandResponse } from './demandResponse.ts';
```

2. In `energyStep`, next to `let buildingDemand = 0;` add:

```ts
// Base load of the connected businesses — the demand-response pool.
let businessDemand = 0;
let contractedBuildings = 0;
```

and inside the building loop, directly after
`buildingDemand += buildingConsumption(zone, density, time);`:

```ts
if (zone === Zone.Commercial || zone === Zone.Retail) {
  businessDemand += buildingConsumption(zone, density, time);
  contractedBuildings++;
}
```

3. Move the spot price above the cascade: delete the line
   `const spotPrice = spotPriceFactor(state);` from the market-trading block
   and insert it directly before `const net = generation - totalDemand;`:

```ts
// The spot factor depends only on the state (clock and weather), so
// reading it before the cascade changes nothing for trading below.
const spotPrice = spotPriceFactor(state);
```

4. Next to `let heatStoreCharge = 0;` add:

```ts
let shed = 0;
let shedPool = 0;
```

5. In the surplus branch (`if (net >= 0) {`), as its first statement — the
   day's budget refills and the pool is reported even without a shortfall:

```ts
shedPool = dispatchDemandResponse(state, businessDemand, 0, spotPrice).pool;
```

6. In the deficit branch, replace

```ts
biogas = Math.min(shortfall, census.biogasPlants * BALANCE.energy.biogasMaxOutput);
shortfall -= biogas;
// Expensive imports over the limited transmission link come last.
gridImport = Math.min(shortfall, BALANCE.market.importCapacity);
```

with

```ts
biogas = Math.min(shortfall, census.biogasPlants * BALANCE.energy.biogasMaxOutput);
shortfall -= biogas;
// The demand-response contract sheds business load when a call is
// cheaper than importing or the link alone cannot carry the rest.
const call = dispatchDemandResponse(state, businessDemand, shortfall, spotPrice);
shedPool = call.pool;
shed = call.shed;
shortfall -= shed;
// Expensive imports over the limited transmission link come last.
gridImport = Math.min(shortfall, BALANCE.market.importCapacity);
```

7. Shed energy was not consumed. Directly before the comment
   `// Flag a deterministic, tick-varying share of connected buildings as`
   add:

```ts
// Shed load was never served: it leaves the businesses' line and the
// tick's consumption, so the dashed unshifted curve shows it as a gap.
buildingDemand -= shed;
const consumptionThisTick = totalDemand - shed;
```

then change `const deficitShare = totalDemand > 0 ? deficit / totalDemand : 0;`
to

```ts
const deficitShare = consumptionThisTick > 0 ? deficit / consumptionThisTick : 0;
```

and `accum.consumption += totalDemand;` to

```ts
accum.consumption += consumptionThisTick;
```

8. In the `state.lastEnergy = { … }` literal after `unshifted,`:

```ts
    shed,
    shedPool,
    contractedBuildings,
```

Also extend the doc comment above `energyStep`: in step 3 of the list,
change "then dispatches biogas, then imports over the transmission
link," to "then dispatches biogas, then sheds contracted business load
(demand response), then imports over the transmission link,".

- [ ] **Step 8: Run the sim tests to verify they pass**

Run: `pnpm format && pnpm vitest run src/sim`
Expected: PASS, including the engine determinism tests and every
existing energy test (contract off → identical numbers).

- [ ] **Step 9: Commit**

```bash
git add src/sim/demandResponse.ts src/sim/demandResponse.test.ts src/sim/energy.ts src/sim/energy.test.ts src/sim/state.ts
git commit -m "feat(sim): dispatch demand response between biogas and import

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Billing step, tick order, stats and budget line

**Files:**

- Modify: `src/sim/demandResponse.ts`
- Modify: `src/sim/tick.ts` (step order ~line 83, `consumption: {` ~line 198, `smartMeters: {` ~line 235, `buildBudget` ~line 285)
- Modify: `src/shared/types.ts` (`EnergyStats.consumption` ~line 195, `GlobalStats` ~line 520, `budget` ~line 319)
- Test: `src/sim/demandResponse.test.ts`

**Interfaces:**

- Consumes: `state.lastEnergy.{shed, contractedBuildings}` (Task 2).
- Produces: `demandResponseStep(state): number`; `EnergyStats.consumption.shed`;
  `GlobalStats.demandResponse: { active; pool; shed; callHoursLeft; contractedBuildings; retainerPerBuildingPerDay; activationPrice }`;
  `GlobalStats.budget.demandResponse`.

- [ ] **Step 1: Write the failing tests**

Append to `src/sim/demandResponse.test.ts` (add `demandResponseStep` to
the import from `./demandResponse.ts`, and
`import { buildStats, stepTick } from './tick.ts';` — `buildStats` is the
exported `GlobalStats` builder in `src/sim/tick.ts`):

```ts
describe('demandResponseStep', () => {
  const { retainerPerBuildingPerDay, activationPricePerEnergyUnit } = BALANCE.demandResponse;

  it('bills nothing with the contract off', () => {
    const state = createSimState(1, SIZE);
    state.lastEnergy.shed = 10;
    state.lastEnergy.contractedBuildings = 5;
    const before = state.money;
    expect(demandResponseStep(state)).toBe(0);
    expect(state.money).toBe(before);
    expect(state.lastDemandResponseCost).toBe(0);
  });

  it('bills the retainer per contracted building and day plus the activation premium', () => {
    const state = createSimState(1, SIZE);
    state.demandResponse.active = true;
    state.lastEnergy.contractedBuildings = 5;
    state.lastEnergy.shed = 10;
    const before = state.money;
    const spent = demandResponseStep(state);
    const retainer = (5 * retainerPerBuildingPerDay) / TICKS_PER_DAY;
    expect(spent).toBeCloseTo(retainer + 10 * activationPricePerEnergyUnit, 9);
    expect(state.money).toBeCloseTo(before - spent, 9);
    expect(state.lastDemandResponseCost).toBeCloseTo(spent, 9);
  });

  it('a day of retainer is exactly retainerPerBuildingPerDay per building', () => {
    const state = createSimState(1, SIZE);
    state.demandResponse.active = true;
    state.lastEnergy.contractedBuildings = 3;
    let total = 0;
    for (let t = 0; t < TICKS_PER_DAY; t++) total += demandResponseStep(state);
    expect(total).toBeCloseTo(3 * retainerPerBuildingPerDay, 6);
  });

  it('keeps billing when the treasury is empty (a contract, not a purchase)', () => {
    const state = createSimState(1, SIZE);
    state.demandResponse.active = true;
    state.lastEnergy.contractedBuildings = 1;
    state.money = 0;
    demandResponseStep(state);
    expect(state.money).toBeLessThan(0);
  });

  it('reaches the stats and the budget line', () => {
    const state = createSimState(1, SIZE);
    state.demandResponse.active = true;
    state.demandResponse.callBudget = callBudgetTicks() / 2;
    state.lastEnergy.contractedBuildings = 4;
    state.lastEnergy.shed = 2;
    state.lastEnergy.shedPool = 8;
    const spent = demandResponseStep(state);
    const stats = buildStats(state);
    expect(stats.demandResponse).toEqual({
      active: true,
      pool: 8,
      shed: 2,
      callHoursLeft: BALANCE.demandResponse.maxCallHoursPerDay / 2,
      contractedBuildings: 4,
      retainerPerBuildingPerDay,
      activationPrice: activationPricePerEnergyUnit,
    });
    expect(stats.energy.consumption.shed).toBe(2);
    expect(stats.budget.demandResponse).toBeCloseTo(spent, 9);
  });

  it('is billed every tick of a running city', () => {
    const state = createSimState(1, SIZE);
    state.demandResponse.active = true;
    stepTick(state);
    // No businesses yet: the retainer is zero, but the step ran.
    expect(state.lastDemandResponseCost).toBe(0);
    expect(buildStats(state).budget.demandResponse).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/sim/demandResponse.test.ts`
Expected: FAIL — `demandResponseStep` is not exported; `stats.demandResponse` undefined.

- [ ] **Step 3: Implement the billing step**

Append to `src/sim/demandResponse.ts`:

```ts
/**
 * One tick of the contract's money: the retainer for every contracted
 * business (per building and day, so a day sums to exactly
 * retainerPerBuildingPerDay each) plus the activation premium for what
 * the energy step shed this tick. Runs after the energy step and the
 * smart meters, before the economy, so the cost lands in this tick's
 * budget. A contract is not a purchase: it is billed even when the
 * treasury is empty. Returns the money spent and records it for the
 * budget line.
 */
export function demandResponseStep(state: SimState): number {
  let spent = 0;
  if (state.demandResponse.active) {
    const { retainerPerBuildingPerDay, activationPricePerEnergyUnit } = BALANCE.demandResponse;
    const { contractedBuildings, shed } = state.lastEnergy;
    spent =
      (contractedBuildings * retainerPerBuildingPerDay) / TICKS_PER_DAY +
      shed * activationPricePerEnergyUnit;
  }
  state.money -= spent;
  state.lastDemandResponseCost = spent;
  if (spent > 0) state.statsDirty = true;
  return spent;
}

/** Call hours left today, for the HUD. */
export function callHoursLeft(state: SimState): number {
  return (state.demandResponse.callBudget * 24) / TICKS_PER_DAY;
}
```

- [ ] **Step 4: Wire the step, the stats and the budget**

In `src/sim/tick.ts`:

1. Import:

```ts
import { callHoursLeft, demandResponseStep } from './demandResponse.ts';
```

2. Directly after `smartMetersStep(state);` in `stepTick`:

```ts
// The contract bills what the energy step shed this tick.
demandResponseStep(state);
```

3. In the stats literal, in `consumption: {` after `flexBacklog: e.flexBacklog,`:

```ts
        shed: e.shed,
```

4. After the `smartMeters: { … },` block in the stats literal:

```ts
    demandResponse: {
      active: state.demandResponse.active,
      pool: e.shedPool,
      shed: e.shed,
      callHoursLeft: callHoursLeft(state),
      contractedBuildings: e.contractedBuildings,
      retainerPerBuildingPerDay: BALANCE.demandResponse.retainerPerBuildingPerDay,
      activationPrice: BALANCE.demandResponse.activationPricePerEnergyUnit,
    },
```

(`e` is the local the literal already uses for `state.lastEnergy`; if
the stats builder names it differently, use that name.)

5. In `buildBudget`, after `smartMeters: state.lastSmartMeterCost,`:

```ts
    demandResponse: state.lastDemandResponseCost,
```

and in the `net:` expression add `- state.lastDemandResponseCost` next to
`- state.lastRepairCost -` … `state.lastSmartMeterCost` (keep the
existing order; the result is the same sum minus the new line).

In `src/shared/types.ts`:

1. In `EnergyStats.consumption` after `flexBacklog: number;`:

```ts
/** Business load shed under the demand-response contract this tick. */
shed: number;
```

2. In `GlobalStats.budget` after `smartMeters: number;`:

```ts
/** Demand-response retainer and activation premiums paid this tick. */
demandResponse: number;
```

3. In `GlobalStats` after the `smartMeters: { … };` field:

```ts
/** Demand-response contract: in force, pool and shed this tick, call hours left today, partners and prices. */
demandResponse: {
  active: boolean;
  pool: number;
  shed: number;
  callHoursLeft: number;
  contractedBuildings: number;
  retainerPerBuildingPerDay: number;
  activationPrice: number;
}
```

- [ ] **Step 5: Run typecheck and tests**

Run: `pnpm format && pnpm typecheck && pnpm vitest run src/sim src/agent src/ui`
Expected: typecheck PASS (fix any test fixture that builds a
`GlobalStats` or `EnergyStats` literal by hand — grep
`src` for `flexBacklog:` in `.test.ts` / `.test.tsx` files and add
`shed: 0`, `demandResponse: 0` in budgets, and the `demandResponse`
block where a `smartMeters: {` stats block is built), tests PASS.

- [ ] **Step 6: Commit**

```bash
git add -A src/sim src/shared src/agent src/ui
git commit -m "feat(sim): bill the demand-response contract; stats and budget line

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The loadManager goal

**Files:**

- Modify: `src/sim/goals.ts` (`GOAL_IDS` ~line 27, progress ~line 142, achievements ~line 227)
- Modify: `src/ui/i18n.tsx` (goal strings, EN ~line 416 and DE ~line 969)
- Test: `src/sim/goals.test.ts`

**Interfaces:**

- Consumes: `state.lastEnergy.shed`, `state.goalProgress.shedTotal`, `BALANCE.demandResponse.goalShedEnergy`.
- Produces: goal id `'loadManager'`; i18n keys `goal.loadManager.title`, `goal.loadManager.body`.

- [ ] **Step 1: Write the failing tests**

Append to `src/sim/goals.test.ts` (it already imports `goalsStep`,
`createSimState`, `deserializeState`, `serializeState`, `BALANCE`):

```ts
describe('loadManager', () => {
  it('achieves once the cumulative shed reaches the target', () => {
    const state = createSimState(4, 16);
    const target = BALANCE.demandResponse.goalShedEnergy;
    state.lastEnergy.shed = target / 4;
    for (let i = 0; i < 3; i++) goalsStep(state);
    expect(state.goalProgress.shedTotal).toBeCloseTo((3 * target) / 4, 9);
    expect(state.goalsAchieved.has('loadManager')).toBe(false);
    goalsStep(state);
    expect(state.goalsAchieved.has('loadManager')).toBe(true);
  });

  it('does not progress without shedding', () => {
    const state = createSimState(4, 16);
    for (let i = 0; i < 100; i++) goalsStep(state);
    expect(state.goalProgress.shedTotal).toBe(0);
    expect(state.goalsAchieved.has('loadManager')).toBe(false);
  });

  it('round-trips its progress', () => {
    const state = createSimState(4, 16);
    state.lastEnergy.shed = 5;
    for (let i = 0; i < 7; i++) goalsStep(state);
    const restored = deserializeState(serializeState(state));
    expect(restored.goalProgress.shedTotal).toBeCloseTo(35, 9);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/sim/goals.test.ts -t loadManager`
Expected: FAIL — `'loadManager'` never achieved (and a type error on the id).

- [ ] **Step 3: Implement the goal**

In `src/sim/goals.ts`:

1. Add `'loadManager',` to `GOAL_IDS` directly after `'flexibleCity',`.
2. Directly after the `progress.flexTicks++;` block (before
   `const achieved = state.goalsAchieved;`). `e` is the local the
   `flexTicks` block already uses for `state.lastEnergy` (it reads
   `e.flexDeferred`):

```ts
// Cumulative business load shed under the demand-response contract.
progress.shedTotal += e.shed;
```

3. After the `flexibleCity` achievement block:

```ts
if (!achieved.has('loadManager') && progress.shedTotal >= BALANCE.demandResponse.goalShedEnergy) {
  achieved.add('loadManager');
}
```

In `src/ui/i18n.tsx`, English block after `'goal.flexibleCity.body': …,`:

```ts
  'goal.loadManager.title': 'Load manager',
  'goal.loadManager.body':
    'Shed 2,000 energy units of business load under a demand-response contract.',
```

German block after `'goal.flexibleCity.body': …,`:

```ts
  'goal.loadManager.title': 'Lastmanager',
  'goal.loadManager.body':
    'Wirf unter einem Demand-Response-Vertrag 2.000 Energieeinheiten Gewerbelast ab.',
```

(The goal bodies in this file quote their thresholds as literals, like
`flexibleCity`'s "80%"; keep the figure in sync with
`goalShedEnergy` when the probe moves it.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm format && pnpm vitest run src/sim/goals.test.ts src/agent`
Expected: PASS (the agent overview test lists goals with titles; the
new id needs its strings, which are now present).

- [ ] **Step 5: Commit**

```bash
git add src/sim/goals.ts src/sim/goals.test.ts src/ui/i18n.tsx
git commit -m "feat(sim): loadManager goal for shed business load

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Command, HUD control, panel rows and help text

**Files:**

- Modify: `src/shared/messages.ts` (~line 39)
- Modify: `src/sim/engine.ts` (~line 68)
- Modify: `src/ui/HudConsole.tsx` (props ~line 19-29, markup after the smart-meter label ~line 84, `EnergyPanel` call ~line 54)
- Modify: `src/ui/App.tsx` (~line 260)
- Modify: `src/ui/EnergyPanel.tsx` (props ~line 76-83, rows ~line 206)
- Modify: `src/ui/BudgetPanel.tsx` (`EXPENSE_COLORS` ~line 57, rows ~line 201)
- Modify: `src/ui/i18n.tsx` (EN ~line 172-180, 432, 261; DE ~line 721-729, 985, 811)
- Modify: `e2e/game.spec.ts` (~line 244)
- Test: `src/sim/engine.test.ts`

**Interfaces:**

- Consumes: `setDemandResponse` (Task 1), `GlobalStats.demandResponse`, `EnergyStats.consumption.shed`, `budget.demandResponse` (Task 3).
- Produces: command `{ type: 'setDemandResponse'; active: boolean }`; i18n keys
  `energy.shed`, `demandResponse.label`, `demandResponse.figure`, `demandResponse.title`, `budget.demandResponse`;
  `data-testid="demand-response"` on the HUD label.

- [ ] **Step 1: Write the failing engine test**

Append to `src/sim/engine.test.ts` inside the `describe` that holds the
`setSpeed` / `setTaxRate` command tests (they build the engine with the
file's `makeEngine()` helper, which returns `new SimEngine(seed, size)`,
and send commands with `engine.applyCommand(...)`):

```ts
it('setDemandResponse signs and ends the contract', () => {
  const engine = makeEngine();
  engine.applyCommand({ type: 'setDemandResponse', active: true });
  expect(engine.state.demandResponse.active).toBe(true);
  engine.applyCommand({ type: 'setDemandResponse', active: false });
  expect(engine.state.demandResponse.active).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/sim/engine.test.ts -t setDemandResponse`
Expected: FAIL — type error / unknown command type.

- [ ] **Step 3: Add the command**

In `src/shared/messages.ts`, after `| { type: 'setSmartMeterRollout'; active: boolean }`:

```ts
  | { type: 'setDemandResponse'; active: boolean }
```

In `src/sim/engine.ts`, import `setDemandResponse` from
`./demandResponse.ts` and add after the `setSmartMeterRollout` case:

```ts
      case 'setDemandResponse':
        setDemandResponse(state, command.active);
        return [];
```

- [ ] **Step 4: Run the engine test to verify it passes**

Run: `pnpm vitest run src/sim/engine.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the strings**

In `src/ui/i18n.tsx`, English block:

- After `'energy.flexBacklog': '⏳ Deferred',`:

```ts
  'energy.shed': '✂ Load shed',
```

- After the `'smartMeters.title': …,` entry:

```ts
  'demandResponse.label': 'Demand-response contract',
  'demandResponse.figure': '{pool} sheddable · {hours} h left',
  'demandResponse.title':
    'Commercial and retail buildings sign up to shed up to {share} % of their base load, for {retainer} per business and day plus {price} per energy unit shed. Called automatically for at most {hours} h a day — when a call is cheaper than importing, or the link alone cannot carry the shortfall.',
```

- After `'budget.smartMeters': 'Smart meters',`:

```ts
  'budget.demandResponse': 'Demand response',
```

- Append to the end of the `'help.energy.body'` string (before its
  closing quote): ` A demand-response contract lets your commercial and retail buildings shed part of their load in a deficit — for a daily retainer plus a premium per unit shed, called automatically when that beats importing or the link is full, a few hours a day at most.`

German block:

- After `'energy.flexBacklog': '⏳ Aufgeschoben',`:

```ts
  'energy.shed': '✂ Abgeworfene Last',
```

- After the `'smartMeters.title': …,` entry:

```ts
  'demandResponse.label': 'Demand-Response-Vertrag',
  'demandResponse.figure': '{pool} abschaltbar · {hours} h übrig',
  'demandResponse.title':
    'Gewerbe und Einzelhandel verpflichten sich, bis zu {share} % ihrer Grundlast abzuwerfen, für {retainer} je Betrieb und Tag plus {price} je abgeworfener Energieeinheit. Wird automatisch abgerufen, höchstens {hours} h am Tag — wenn das günstiger ist als Import oder die Netzleitung allein das Defizit nicht trägt.',
```

- After `'budget.smartMeters': 'Smart Meter',`:

```ts
  'budget.demandResponse': 'Demand Response',
```

- Append to the end of the German `'help.energy.body'` string: ` Ein Demand-Response-Vertrag lässt Gewerbe und Einzelhandel im Defizit einen Teil ihrer Last abwerfen — gegen eine tägliche Bereitstellungsprämie plus eine Abrufprämie je Einheit, automatisch abgerufen, wenn das günstiger ist als Import oder die Leitung voll ist, höchstens ein paar Stunden am Tag.`

- [ ] **Step 6: Add the HUD control**

In `src/ui/HudConsole.tsx`:

1. Props: after `onSetSmartMeterRollout: (active: boolean) => void;` add
   `onSetDemandResponse: (active: boolean) => void;` and destructure
   `onSetDemandResponse` next to `onSetSmartMeterRollout`.

2. Directly after the smart-meter `<label … data-testid="smart-charging">…</label>`
   block, add:

```tsx
<label
  className="smart-charging-toggle smart-meters"
  data-testid="demand-response"
  title={t('demandResponse.title', {
    share: Math.round(BALANCE.demandResponse.shedShare * 100),
    retainer: BALANCE.demandResponse.retainerPerBuildingPerDay,
    price: BALANCE.demandResponse.activationPricePerEnergyUnit,
    hours: BALANCE.demandResponse.maxCallHoursPerDay,
  })}
>
  <input
    type="checkbox"
    checked={stats.demandResponse.active}
    onChange={(e) => onSetDemandResponse(e.target.checked)}
  />
  <span>{t('demandResponse.label')}</span>
  <span className="smart-meters-coverage" data-testid="demand-response-figure">
    {t('demandResponse.figure', {
      pool: Math.round(stats.demandResponse.pool),
      hours: stats.demandResponse.callHoursLeft.toFixed(1),
    })}
  </span>
</label>
```

3. Pass `demandResponse={stats.demandResponse}` to `<EnergyPanel … />`.

In `src/ui/App.tsx`, next to the `onSetSmartMeterRollout` prop:

```tsx
              onSetDemandResponse={(active) => bridge.send({ type: 'setDemandResponse', active })}
```

In `src/ui/EnergyPanel.tsx`:

1. Add the prop `demandResponse: GlobalStats['demandResponse'];` to the
   props type and destructure it.
2. Directly after the smart-meter fragment (`{(smartMeters.coverage > 0 || …) && (<>…</>)}`):

```tsx
{
  (demandResponse.active || energy.consumption.shed > 0) && (
    <Row label={t('energy.shed')} value={energy.consumption.shed} testId="detail-energy-shed" />
  );
}
```

In `src/ui/BudgetPanel.tsx`:

1. In `EXPENSE_COLORS` after `smartMeters: '#8fb3c9',`: `demandResponse: '#c9a58f',`
2. After the `smartMeters` row object:

```ts
    {
      key: 'demandResponse',
      label: t('budget.demandResponse'),
      value: perDay(budget.demandResponse),
      color: EXPENSE_COLORS.demandResponse,
    },
```

If the `GameView.tsx` or any other component forwards the HUD props,
thread `onSetDemandResponse` through the same way `onSetSmartMeterRollout`
travels (grep `onSetSmartMeterRollout` in `src/ui`).

- [ ] **Step 7: Extend the e2e test**

In `e2e/game.spec.ts`, inside `'tax slider and smart charging are interactive'`,
after the `smartCharging` expectation:

```ts
const demandResponse = page.getByTestId('demand-response').locator('input');
await demandResponse.click();
await expect(demandResponse).toBeChecked({ timeout: 5_000 });
```

- [ ] **Step 8: Verify**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm test && node scripts/smoke.mjs`
Expected: all PASS. (The e2e run needs the Mac or CI; `pnpm e2e` may be
skipped here, note it in the commit body if skipped.)

- [ ] **Step 9: Commit**

```bash
git add src/shared/messages.ts src/sim/engine.ts src/sim/engine.test.ts src/ui e2e/game.spec.ts
git commit -m "feat(ui): demand-response contract toggle, load-shed row, budget line

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Agent tool and docs

**Files:**

- Modify: `src/agent/tools.ts` (`set_smart_meter_rollout` ~line 1073, overview ~line 637, energy-report description ~line 724)
- Modify: `docs/agent-tools.md` (rows for `get_game_overview` ~line 110, `get_energy_report` ~line 112, after `set_smart_meter_rollout` ~line 127)
- Test: `src/agent/tools.test.ts`

**Interfaces:**

- Consumes: command `setDemandResponse` (Task 5), `GlobalStats.demandResponse` (Task 3).
- Produces: tool `set_demand_response { active: boolean }`; overview block `demandResponse`.

- [ ] **Step 1: Write the failing tests**

In `src/agent/tools.test.ts`:

1. In the tool-name list, after `'set_smart_meter_rollout',` add `'set_demand_response',`.
2. In the validation test, after the `set_smart_meter_rollout` line:

```ts
expect(await call('set_demand_response', { active: 'yes' })).toMatchObject({ ok: false });
```

3. In the effect test, after `expect(overview).not.toHaveProperty('smartCharging');`:

```ts
expect(await call('set_demand_response', { active: true })).toMatchObject({ ok: true });
expect(engine.state.demandResponse.active).toBe(true);
const contracted = await call('get_game_overview');
expect(contracted.demandResponse).toMatchObject({ active: true, contractedBuildings: 0 });
expect(contracted.demandResponse.callHoursLeft).toBe(BALANCE.demandResponse.maxCallHoursPerDay);
```

and after the `get_energy_report` call in that test:

```ts
expect(report.consumption).toHaveProperty('shed');
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/agent`
Expected: FAIL — unknown tool `set_demand_response`.

- [ ] **Step 3: Add the tool, the overview block and the report note**

In `src/agent/tools.ts`:

1. After the `set_smart_meter_rollout` tool object:

```ts
    {
      name: 'set_demand_response',
      description: `Sign or end the demand-response contract with the commercial and retail buildings. Under contract, up to ${Math.round(BALANCE.demandResponse.shedShare * 100)} % of their base load is shed automatically in a deficit — after storage and biogas, before import — whenever a call is cheaper than importing at the spot price or the import link cannot carry the shortfall, for at most ${BALANCE.demandResponse.maxCallHoursPerDay} h a day. Costs ${BALANCE.demandResponse.retainerPerBuildingPerDay} per business and day plus ${BALANCE.demandResponse.activationPricePerEnergyUnit} per energy unit shed. See demandResponse in get_game_overview.`,
      inputSchema: {
        type: 'object',
        properties: { active: { type: 'boolean' } },
        required: ['active'],
      },
      async execute(input) {
        if (typeof input.active !== 'boolean') throw new ToolInputError('"active" must be boolean');
        const outcome = await ctx.sendCommand({ type: 'setDemandResponse', active: input.active });
        return outcomeResult(outcome, { demandResponse: { active: input.active } });
      },
    },
```

2. In the `get_game_overview` result after the `smartMeters: { … },` block:

```ts
          demandResponse: {
            active: s.demandResponse.active,
            pool: round(s.demandResponse.pool),
            shed: round(s.demandResponse.shed),
            callHoursLeft: round(s.demandResponse.callHoursLeft, 2),
            contractedBuildings: s.demandResponse.contractedBuildings,
          },
```

3. In the `get_energy_report` description, change
   `'(flexDeferred, flexRecovered, flexBacklog) and the unshifted curve, and the sampled '`
   to
   `'(flexDeferred, flexRecovered, flexBacklog), the business load shed under the demand-response contract (shed), the unshifted curve, and the sampled '`.

In `docs/agent-tools.md`:

- `get_game_overview` row: append `, demand-response contract (active, pool, shed, callHoursLeft, contractedBuildings)` to its description.
- `get_energy_report` row: append `, and `shed` (demand response)` after "the `unshifted` curve".
- After the `set_smart_meter_rollout` row add:

```
| `set_demand_response`     | write | `active: boolean` — sign/end the demand-response contract with commercial and retail buildings; sheds up to a share of their base load automatically in a deficit (cheaper than import, or link saturated), limited call hours per day, retainer plus activation premium |
```

(Keep the table's column alignment; `pnpm format` does not reflow
Markdown tables, so align by hand roughly like the neighbouring rows.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm format && pnpm vitest run src/agent`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools.ts src/agent/tools.test.ts docs/agent-tools.md
git commit -m "feat(agent): set_demand_response; overview carries the contract figures

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Pacing probe, balance freeze and backlog note

**Files:**

- Create (temporary, deleted before the commit): `src/sim/_demandResponseProbe.test.ts`
- Modify: `src/shared/constants.ts` (`demandResponse` block comments and, if the probe says so, values)
- Modify: `src/ui/i18n.tsx` (goal body figure, only if `goalShedEnergy` moves)
- Modify: `docs/superpowers/specs/2026-10-04-demand-response-design.md` (Testing: probe results; Economy: note that the step deducts the money itself, as the smart meters do)
- Modify: `docs/idea.md` (backlog entry)

- [ ] **Step 1: Write the probe**

Create `src/sim/_demandResponseProbe.test.ts`:

```ts
import { describe, it } from 'vitest';
import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { placePlant } from './energy.ts';
import { buildPowerLines } from './powerLines.ts';
import { buildRoads } from './roads.ts';
import { createSimState, PlantType, Zone, type SimState } from './state.ts';
import { stepTick } from './tick.ts';

const SIZE = 64;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);
const DAYS = 20;

/**
 * A mid-size scripted city: six bands of road (x = 4..43) with dense
 * buildings on both sides — four residential bands, two business bands
 * (commercial above, retail below) — lines on every road, a trunk line
 * down x = 3, and a plant park east of the roads: 8 wind, 8 solar, 6
 * batteries, 1 biogas, 1 hydrogen, each on its own line stub.
 */
function city(seed: number, contract: boolean): SimState {
  const state = createSimState(seed, SIZE);
  state.money = 1e9;
  for (let band = 0; band < 6; band++) {
    const roadY = 6 + 5 * band;
    const road = Array.from({ length: 40 }, (_, i) => at(4 + i, roadY));
    buildRoads(state, road);
    buildPowerLines(state, road);
    for (let i = 0; i < 40; i++) {
      const above = at(4 + i, roadY - 1);
      const below = at(4 + i, roadY + 1);
      const business = band >= 4;
      state.layers.zone[above] = business ? Zone.Commercial : Zone.Residential;
      state.layers.zone[below] = business ? Zone.Retail : Zone.Residential;
      state.layers.density[above] = 3;
      state.layers.density[below] = 3;
    }
  }
  buildPowerLines(
    state,
    Array.from({ length: 26 }, (_, i) => at(3, 6 + i)),
  );
  const plants: PlantType[] = [
    ...Array<PlantType>(8).fill(PlantType.WindTurbine),
    ...Array<PlantType>(8).fill(PlantType.SolarFarm),
    ...Array<PlantType>(6).fill(PlantType.Battery),
    PlantType.BiogasPlant,
    PlantType.HydrogenPlant,
  ];
  plants.forEach((plant, i) => {
    const y = 6 + 5 * (i % 6);
    const x = 46 + 3 * Math.floor(i / 6);
    buildPowerLines(state, [at(44, y), at(45, y), at(x - 1, y)]);
    placePlant(state, at(x, y), plant);
  });
  state.demandResponse.active = contract;
  state.smartMeters.active = true;
  return state;
}

function run(seed: number, contract: boolean): void {
  const state = city(seed, contract);
  const start = state.money;
  let shed = 0;
  let hours = 0;
  let importCost = 0;
  let drCost = 0;
  let deficitTicks = 0;
  let deficitEnergy = 0;
  const lines: string[] = [];
  for (let day = 0; day < DAYS; day++) {
    let dShed = 0;
    let dHours = 0;
    let dImport = 0;
    let dDeficit = 0;
    for (let t = 0; t < TICKS_PER_DAY; t++) {
      stepTick(state);
      const e = state.lastEnergy;
      dShed += e.shed;
      if (e.shedPool > 0) dHours += (e.shed / e.shedPool) * (24 / TICKS_PER_DAY);
      dImport += state.lastEconomy.gridImportCost;
      if (e.deficit > 0) {
        dDeficit++;
        deficitEnergy += e.deficit;
      }
      drCost += state.lastDemandResponseCost;
    }
    shed += dShed;
    hours += dHours;
    importCost += dImport;
    deficitTicks += dDeficit;
    lines.push(
      `day ${String(day).padStart(2)}  shed ${dShed.toFixed(0).padStart(6)}  hours ${dHours.toFixed(1).padStart(4)}  import ${dImport.toFixed(0).padStart(6)}  deficit ticks ${String(dDeficit).padStart(3)}  money ${(state.money - start).toFixed(0)}`,
    );
  }
  console.log(
    `\n=== seed ${seed} contract ${contract ? 'ON ' : 'OFF'} — ${state.lastEnergy.contractedBuildings} businesses, shedShare ${BALANCE.demandResponse.shedShare}, retainer ${BALANCE.demandResponse.retainerPerBuildingPerDay}, price ${BALANCE.demandResponse.activationPricePerEnergyUnit}, hours/day ${BALANCE.demandResponse.maxCallHoursPerDay}\n` +
      lines.join('\n') +
      `\nTOTAL shed ${shed.toFixed(0)}  call hours ${hours.toFixed(1)}  import cost ${importCost.toFixed(0)}  contract cost ${drCost.toFixed(0)}  deficit ticks ${deficitTicks}  deficit energy ${deficitEnergy.toFixed(0)}  net money ${(state.money - start).toFixed(0)}`,
  );
}

describe('demand-response probe', () => {
  it('prints a year on and off', () => {
    for (const seed of [7, 11]) {
      run(seed, false);
      run(seed, true);
    }
  }, 600_000);
});
```

If a plant placement is rejected
(`placePlant` returns `{ rejected }`), print the rejection and fix the
coordinate — every plant must land, or the two runs are not comparable.

- [ ] **Step 2: Run the probe**

Run: `pnpm vitest run src/sim/_demandResponseProbe.test.ts --reporter=verbose 2>&1 | tee /tmp/dr-probe.txt`
(Use the session scratchpad directory instead of `/tmp` when one is
given.) Read the four summaries.

- [ ] **Step 3: Judge against the spec targets and adjust**

Targets from the spec:

- Contract ON has at least 50 % fewer deficit ticks than OFF over the year on both seeds.
- Import cost ON is clearly below OFF (calls replace imports at scarce prices).
- Net money ON ends the year roughly break-even to modestly ahead of OFF
  (within about −5 % to +15 % of OFF's net income); if the contract is
  far ahead, raise `retainerPerBuildingPerDay`; if far behind, lower it
  or raise `shedShare`; if the call hours saturate every day (hours ≈
  `maxCallHoursPerDay` nearly every day), the pool is the binding limit
  and `maxCallHoursPerDay` could go to 6; if hours are mostly 0, the
  city has no deficits and the probe needs fewer plants (remove two
  wind turbines and two solar farms and rerun).

Change values in `BALANCE.demandResponse` only, re-run the probe after
each change, and keep the final figures. Then rewrite the comments on
the four values in `constants.ts` to record the measurements (one
paragraph each, in the style of the `smartMeters` block: what was
measured, what alternative values did). If `goalShedEnergy` moves,
update both goal body strings in `i18n.tsx`. Make sure the goal is
reachable: `goalShedEnergy` should be about a quarter of the year's
total shed on the ON runs.

- [ ] **Step 4: Record results and mark the backlog**

- In the spec's Testing section, under the probe bullet, add a "Done"
  paragraph with the per-seed totals (shed, call hours, import cost
  ON/OFF, deficit ticks ON/OFF, net money ON/OFF) and the final values.
- In the spec's Economy section, replace "it is subtracted from the
  money alongside the import cost" with "the step deducts it from the
  money itself, as the smart-meter step does, and `buildBudget`
  flattens `lastDemandResponseCost` into the budget".
- In `docs/idea.md`, change the backlog bullet
  `- **Demand response**: contracts with industry to shed load in a Dunkelflaute; maybe a grid-frequency minigame.`
  to:

```
- **Demand response** (done): a contract with the commercial and
  retail zones under which a share of their base load is shed
  automatically in a deficit — after storage and biogas, before
  import — whenever a call is cheaper than importing at the spot price
  or the link alone cannot carry the shortfall, for a few hours a
  day. Paid as a daily retainer per business plus an activation
  premium per unit shed; the `loadManager` goal rewards a city that
  has shed its share. (A grid-frequency minigame stays an idea.)
```

- [ ] **Step 5: Delete the probe and verify**

```bash
rm src/sim/_demandResponseProbe.test.ts
pnpm format && pnpm typecheck && pnpm lint && pnpm coverage && node scripts/smoke.mjs
```

Expected: all PASS, coverage gate ≥ 90 % on `src/sim` + `src/shared`.

- [ ] **Step 6: Commit**

```bash
git add src/shared/constants.ts src/ui/i18n.tsx docs/superpowers/specs/2026-10-04-demand-response-design.md docs/idea.md
git commit -m "balance: freeze the demand-response contract from a headless probe; docs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Finish the branch

- [ ] **Step 1: Full verification**

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm coverage && pnpm build && node scripts/smoke.mjs
```

Expected: all PASS.

- [ ] **Step 2: Review the diff against the spec**

`git diff main...feat/demand-response --stat` and skim: every file in
the File map is touched; no debug output; no leftover probe; both
languages present for every new key (grep each new key twice in
`i18n.tsx`).

- [ ] **Step 3: Merge**

```bash
git checkout main && git merge --no-ff feat/demand-response -m "Merge branch 'feat/demand-response'" && git push origin main
```

(Push only if the user has asked for it; otherwise stop after the
merge and report.)
