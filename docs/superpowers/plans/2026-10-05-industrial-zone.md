# Industrial Zone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fourth zone, Industrial: factories that grow with the
retail sector, employ people, run a two-shift load that joins the
demand-response contract, hand their goods to the delivery vans before
the shop legs (a depot without a factory in reach imports and pays per
tour), lower the happiness of homes nearby, and unlock the `localGoods`
goal — with build tool, demand bar, inspector rows, budget line,
procedural factory meshes and agent-tool parity.

**Architecture:** `Zone.Industrial = 4` flows through the existing
`Record<Zone, …>` balance tables, so load, heating and cooling need no
code. `growth.ts` gets a fourth demand term driven by retail jobs and
stops counting industrial jobs against the commercial target.
`energy.ts` sums an `industrialDemand` line and hands it to the
demand-response dispatch as a second pool share. `deliveries.ts` adds a
pickup leg (`planPickup`, `VanPhase.Loading`, `van.pickup`) and a
per-tour import fee that lands on a new budget line; day counters on
`state.goods` feed the goal. `happiness.ts` subtracts an industry
coverage penalty. UI, render and agent follow. Every commit typechecks
and passes the pre-commit hook.

**Tech Stack:** TypeScript (strict), React 19, three.js, Vitest,
Playwright, pnpm, oxlint, oxfmt.

**Spec:** `docs/superpowers/specs/2026-10-05-industrial-zone-design.md`

## Global Constraints

- Balance values live only in `BALANCE` (`growth`, `energy`, `seasons`,
  `demandResponse`, `deliveries`, `happiness` blocks); no magic numbers
  in sim code. No randomness added (determinism tests must pass).
- Save compatibility: `SAVE_VERSION` stays 1. The zone byte 4 is
  forward-additive; `state.goods` and `van.pickup` are transient (the
  house rule in `state.ts`: single-day counters are not persisted —
  this plan follows the house rule, not the spec's "optional field
  `goods`" line; Task 9 amends the spec).
- A city without a single industrial tile is numerically identical to
  today in energy, growth, happiness and money — except a depot pays
  `importFeePerTour` per tour it starts, which is the one intended
  change for existing cities.
- All user-visible strings go through `src/ui/i18n.tsx`, English AND
  German (add every key to both `en` and `de`).
- Run `pnpm format` after every edit; the pre-commit hook runs
  `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` and
  must pass. Never use `--no-verify`.
- Work on branch `feat/industrial-zone` in this checkout (no worktree:
  `node_modules` is shared with the Mac). Commit messages end with
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## File map

| File                                                                                                                                    | Responsibility in this feature                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/types.ts`                                                                                                                   | `Zone.Industrial`, `DemandStats.industrial`, `DeliveryStats.factories/localShare`, `DepotInfo.factoriesInReach/nearestFactoryTiles`, `BudgetStats.goodsImport`                                                                                           |
| `src/shared/constants.ts`                                                                                                               | Industrial entries in the five zone tables; new `growth.industrialPerRetailJob`, `demandResponse.industrialShedShare`, `deliveries.loadTicks/importFeePerTour/goalLocalMinShops/goalLocalMinFactories`, `happiness.industryRadius/industryPenaltyWeight` |
| `src/sim/state.ts`                                                                                                                      | `VanPhase.Loading`, `Van.pickup`, `SimState.goods`, `SimState.lastGoodsImportCost`, `countPopulationAndJobs` counts industry, `lastDemand.industrial`, `lastDeliveries` defaults                                                                         |
| `src/sim/growth.ts`                                                                                                                     | `countJobsByZone`, industrial demand, commercial demand against business jobs only, `demandFor`                                                                                                                                                          |
| `src/sim/vehicles.ts`                                                                                                                   | industry road tiles are commuter destinations                                                                                                                                                                                                            |
| `src/sim/energy.ts`                                                                                                                     | `industrialDemand` line; pool hand-off                                                                                                                                                                                                                   |
| `src/sim/demandResponse.ts`                                                                                                             | `dispatchDemandResponse(..., industrialDemand)`                                                                                                                                                                                                          |
| `src/sim/deliveries.ts`                                                                                                                 | `isFactory`, `hasFactoryBeside`, `depotReach`, `planPickup`, pickup leg in `planTour`, `Loading` phase, fee, day counters, stats and depot info                                                                                                          |
| `src/sim/tick.ts`                                                                                                                       | budget line `goodsImport`                                                                                                                                                                                                                                |
| `src/sim/happiness.ts`                                                                                                                  | `industryCoverage`, penalty                                                                                                                                                                                                                              |
| `src/sim/goals.ts`                                                                                                                      | `localGoods`                                                                                                                                                                                                                                             |
| `src/ui/useTools.ts`, `BuildBar.tsx`, `DemandBars.tsx`, `app.css`, `TileInspector.tsx`, `BudgetPanel.tsx`, `CityVitals.tsx`, `i18n.tsx` | tool, hotkey, bar, inspector sections, budget slice, HUD title, copy                                                                                                                                                                                     |
| `src/render/buildings/palette.ts`, `recipes.ts`, `src/render/zoneTilesMesh.ts`, `minimapLayer.ts`, `overlays.ts`                        | factory look and colours                                                                                                                                                                                                                                 |
| `src/agent/tools.ts`, `docs/agent-tools.md`                                                                                             | `industrial` zone name, `i/I` glyphs, overview fields, `factory` find kind, depot rules, descriptions                                                                                                                                                    |
| `e2e/game.spec.ts`                                                                                                                      | tool button and demand bar present                                                                                                                                                                                                                       |
| `docs/idea.md`, spec                                                                                                                    | backlog entry, probe record                                                                                                                                                                                                                              |

---

### Task 0: Branch

- [ ] **Step 1: Create the feature branch**

```bash
git checkout main && git checkout -b feat/industrial-zone
```

---

### Task 1: Zone value, balance tables, jobs and demand

**Files:**

- Modify: `src/shared/types.ts:31-37` (Zone), `:288-292` (DemandStats)
- Modify: `src/shared/constants.ts:252-256` (consumption), `:262-275` (profiles), `:620-626` (jobs), `:982-986` and `:995-999` (heating/cooling weights), `growth` block (`industrialPerRetailJob`)
- Modify: `src/sim/state.ts:1125-1137` (`countPopulationAndJobs`), `:525` (`lastDemand` default)
- Modify: `src/sim/growth.ts:20-73`
- Modify: `src/sim/vehicles.ts:265`
- Test: `src/sim/growth.test.ts`, `src/sim/state.test.ts`

**Interfaces:**

- Produces: `Zone.Industrial = 4`; `DemandStats.industrial: number`;
  `countJobsByZone(state): { commercial: number; retail: number; industrial: number }`
  (exported from `growth.ts`); `BALANCE.growth.industrialPerRetailJob`.

- [ ] **Step 1: Write the failing tests**

Append to `src/sim/growth.test.ts` inside `describe('computeDemand', …)`
(after the last existing `it` of that block):

```ts
it('retail jobs create industrial demand; a city without shops wants no factories', () => {
  const state = createSimState(1, SIZE);
  state.layers.zone[at(1, 1)] = Zone.Residential;
  state.layers.density[at(1, 1)] = 3;
  expect(computeDemand(state).industrial).toBe(0);
  state.layers.zone[at(2, 1)] = Zone.Retail;
  state.layers.density[at(2, 1)] = 3;
  expect(computeDemand(state).industrial).toBeGreaterThan(0.5);
});

it('industrial demand falls as factories cover the retail jobs', () => {
  const state = createSimState(1, SIZE);
  for (let i = 0; i < 2; i++) {
    state.layers.zone[at(i, 1)] = Zone.Retail;
    state.layers.density[at(i, 1)] = 3;
  }
  const before = computeDemand(state).industrial;
  for (let i = 0; i < 2; i++) {
    state.layers.zone[at(i, 3)] = Zone.Industrial;
    state.layers.density[at(i, 3)] = 3;
  }
  const after = computeDemand(state).industrial;
  expect(after).toBeLessThan(before);
  expect(after).toBeLessThan(BALANCE.growth.growthDemandThreshold);
});

it('a factory does not lower commercial demand', () => {
  const state = createSimState(1, SIZE);
  state.layers.zone[at(1, 1)] = Zone.Residential;
  state.layers.density[at(1, 1)] = 3;
  const before = computeDemand(state).commercial;
  state.layers.zone[at(1, 3)] = Zone.Industrial;
  state.layers.density[at(1, 3)] = 3;
  expect(computeDemand(state).commercial).toBeCloseTo(before, 9);
});
```

Append to `src/sim/growth.test.ts` a new describe block at the end of
the file:

```ts
describe('industrial growth', () => {
  it('a zoned industrial lot next to a road grows while shops want goods', () => {
    const state = cityWithRoad();
    // Enough shops to want factories; off the road so they stay as they are.
    for (let i = 0; i < 4; i++) {
      state.layers.zone[at(i + 2, 12)] = Zone.Retail;
      state.layers.density[at(i + 2, 12)] = 3;
    }
    paintZones(
      state,
      Array.from({ length: 10 }, (_, x) => at(x + 2, 4)),
      Zone.Industrial,
    );
    expect(computeDemand(state).industrial).toBeGreaterThan(BALANCE.growth.growthDemandThreshold);
    runGrowth(state, 200);
    expect(totalDensity(state, Zone.Industrial)).toBeGreaterThan(0);
  });
});
```

Append to `src/sim/state.test.ts` (find the existing `describe` that
tests `countPopulationAndJobs`, or add a new block at the end; import
`countPopulationAndJobs`, `createSimState`, `Zone` and `BALANCE` if not
already imported in that file, and define `const at = (x: number, y: number) => tileIndex(x, y, SIZE)` if the file has none):

```ts
describe('countPopulationAndJobs with industry', () => {
  it('counts industrial jobs', () => {
    const state = createSimState(1, 16);
    state.layers.zone[tileIndex(2, 2, 16)] = Zone.Industrial;
    state.layers.density[tileIndex(2, 2, 16)] = 3;
    expect(countPopulationAndJobs(state).jobs).toBe(
      BALANCE.growth.jobsByZoneAndDensity[Zone.Industrial][3],
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/sim/growth.test.ts src/sim/state.test.ts`
Expected: FAIL — `Zone.Industrial` is undefined / `industrial` missing on `DemandStats`.

- [ ] **Step 3: Add the zone, the stats field and the balance entries**

`src/shared/types.ts`:

```ts
export const Zone = {
  None: 0,
  Residential: 1,
  Commercial: 2,
  Retail: 3,
  Industrial: 4,
} as const;
```

```ts
export interface DemandStats {
  residential: number;
  commercial: number;
  retail: number;
  industrial: number;
}
```

`src/shared/constants.ts` — add an Industrial entry to each table:

```ts
    consumptionByZoneAndDensity: {
      [Zone.Residential]: [0, 2, 4.5, 8],
      [Zone.Commercial]: [0, 3, 6.5, 11],
      [Zone.Retail]: [0, 2.5, 5, 9],
      /** Factories draw more than offices of the same density. */
      [Zone.Industrial]: [0, 4, 9, 16],
    } as Record<Zone, number[]>,
```

In `loadProfileByZone`, after the Retail array:

```ts
      /**
       * Two-shift plant: 0.7 through the night, ramps at 5 and 22 h, full
       * load from 6 to 21 h — the only zone with real night-time load.
       */
      [Zone.Industrial]: [
        0.7, 0.7, 0.7, 0.7, 0.7, 0.85, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0.85, 0.7,
      ],
```

In `growth`:

```ts
    jobsByZoneAndDensity: {
      [Zone.Residential]: [0, 0, 0, 0],
      [Zone.Commercial]: [0, 4, 10, 22],
      [Zone.Retail]: [0, 3, 6, 12],
      /** Floor space per worker is large: fewer jobs per tile than offices. */
      [Zone.Industrial]: [0, 3, 8, 18],
    } as Record<Zone, number[]>,
```

and after `retailPerJob: 0.08,`:

```ts
    /** Industrial jobs the city wants per retail job (factories follow the shops they stock). */
    industrialPerRetailJob: 1.0,
```

In `seasons.heating.weightByZone` and `seasons.cooling.weightByZone`
add `[Zone.Industrial]: 0.3,` after the Retail line of each.

- [ ] **Step 4: Count industrial jobs and split the demand**

`src/sim/state.ts` `countPopulationAndJobs`:

```ts
    } else if (z === Zone.Commercial || z === Zone.Retail || z === Zone.Industrial) {
      jobs += BALANCE.growth.jobsByZoneAndDensity[z][d];
    }
```

and the default `lastDemand: { residential: 0, commercial: 0, retail: 0, industrial: 0 },`.

`src/sim/growth.ts` — replace `countRetailJobs` and `computeDemand`:

```ts
/** Jobs per business zone (residential provides none). */
export function countJobsByZone(state: SimState): {
  commercial: number;
  retail: number;
  industrial: number;
} {
  const { zone, density, tileType } = state.layers;
  const table = BALANCE.growth.jobsByZoneAndDensity;
  const jobs = { commercial: 0, retail: 0, industrial: 0 };
  for (let i = 0; i < zone.length; i++) {
    if (tileType[i] !== TileType.Empty || density[i] === 0) continue;
    const z = zone[i];
    if (z === Zone.Commercial) jobs.commercial += table[Zone.Commercial][density[i]];
    else if (z === Zone.Retail) jobs.retail += table[Zone.Retail][density[i]];
    else if (z === Zone.Industrial) jobs.industrial += table[Zone.Industrial][density[i]];
  }
  return jobs;
}

/**
 * The demand model: residential follows available jobs (all of them,
 * factories included), commercial follows the workforce against the
 * office and shop jobs only, retail follows both, industry follows the
 * retail jobs it supplies. Values are normalized to -1..1.
 */
export function computeDemand(state: SimState): DemandStats {
  const { population, jobs } = countPopulationAndJobs(state);
  const {
    jobsPerResident,
    retailPerResident,
    retailPerJob,
    industrialPerRetailJob,
    pioneerPopulation,
    demandHeadroom,
  } = BALANCE.growth;
  const byZone = countJobsByZone(state);

  // Each target is scaled by the headroom factor so the two mutually
  // dependent zones always leave at least one demand above the threshold.
  const targetPopulation = (pioneerPopulation + jobs / jobsPerResident) * demandHeadroom;
  const residential = normalize(targetPopulation - population, targetPopulation);

  // Factories must not crowd out offices: the commercial target is
  // measured against office and shop jobs only.
  const businessJobs = byZone.commercial + byZone.retail;
  const targetJobs = population * jobsPerResident * demandHeadroom;
  const commercial = normalize(targetJobs - businessJobs, Math.max(targetJobs, businessJobs));

  const targetRetail = (population * retailPerResident + jobs * retailPerJob) * demandHeadroom;
  const retail = normalize(targetRetail - byZone.retail, Math.max(targetRetail, byZone.retail));

  const targetIndustrial = byZone.retail * industrialPerRetailJob * demandHeadroom;
  const industrial = normalize(
    targetIndustrial - byZone.industrial,
    Math.max(targetIndustrial, byZone.industrial),
  );

  return { residential, commercial, retail, industrial };
}
```

Add to `demandFor`:

```ts
    case Zone.Industrial:
      return demand.industrial;
```

`src/sim/vehicles.ts:265`:

```ts
const workRoads = roadTilesNextToZones(state, [Zone.Commercial, Zone.Retail, Zone.Industrial]);
```

- [ ] **Step 5: Typecheck and fix every other `DemandStats` literal**

Run: `pnpm typecheck`
Expected errors list every object literal missing `industrial` (at
least `src/agent/tools.ts` overview `demand`, `src/render/overlays.ts`
tests, any test fixture). Fix each by adding `industrial` (overview:
`industrial: round(s.demand.industrial, 2),`; overlays `demandFor`:
`case Zone.Industrial: return this.demand.industrial;`). Re-run until clean.

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run src/sim/growth.test.ts src/sim/state.test.ts src/sim`
Expected: PASS (all sim tests — the extra zone must not change any
existing expectation).

- [ ] **Step 7: Format and commit**

```bash
pnpm format
git add src/shared/types.ts src/shared/constants.ts src/sim/state.ts src/sim/growth.ts src/sim/growth.test.ts src/sim/state.test.ts src/sim/vehicles.ts src/agent/tools.ts src/render/overlays.ts
git commit -m "feat(sim): industrial zone — value, balance tables, jobs and retail-driven demand

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

(Add any other file Step 5 touched.)

---

### Task 2: Industrial load in the demand-response pool

**Files:**

- Modify: `src/shared/constants.ts` (`demandResponse.industrialShedShare`)
- Modify: `src/sim/demandResponse.ts:33-55`
- Modify: `src/sim/energy.ts:355-356`, `:383-388`, `:492`, `:575`
- Test: `src/sim/demandResponse.test.ts`, `src/sim/energy.test.ts`

**Interfaces:**

- Consumes: `Zone.Industrial` (Task 1).
- Produces: `dispatchDemandResponse(state, businessDemand, shortfall, spotPrice, industrialDemand = 0)`;
  `BALANCE.demandResponse.industrialShedShare`.

- [ ] **Step 1: Write the failing tests**

`src/sim/demandResponse.test.ts` — inside the describe that already
calls `dispatchDemandResponse` (it has a `contracted()` helper and a
`breakEven` constant; reuse them), add:

```ts
it('adds industrialShedShare of the industrial load to the pool', () => {
  const { shedShare, industrialShedShare } = BALANCE.demandResponse;
  const pool = dispatchDemandResponse(contracted(), 100, 0, 1, 50).pool;
  expect(pool).toBeCloseTo(shedShare * 100 + industrialShedShare * 50, 9);
});

it('the industrial pool is available on a dark night when the offices are idle', () => {
  const { industrialShedShare } = BALANCE.demandResponse;
  const call = dispatchDemandResponse(contracted(), 0, 40, breakEven + 1, 50);
  expect(call.pool).toBeCloseTo(industrialShedShare * 50, 9);
  expect(call.shed).toBeCloseTo(Math.min(40, industrialShedShare * 50), 9);
});
```

`src/sim/energy.test.ts` — add at the end of the file:

```ts
describe('industrial load', () => {
  it('has a two-shift profile with real night load', () => {
    const profile = BALANCE.energy.loadProfileByZone[Zone.Industrial];
    expect(profile).toHaveLength(24);
    expect(Math.min(...profile)).toBeGreaterThanOrEqual(0.6);
    expect(Math.max(...profile)).toBe(1);
    expect(BALANCE.energy.consumptionByZoneAndDensity[Zone.Industrial]).toHaveLength(4);
  });

  it('a connected factory is a contract partner and widens the pool', () => {
    const state = createSimState(1, SIZE);
    state.season = { ...state.season, temperature: 18 };
    placePlant(state, at(5, 5), PlantType.SolarFarm);
    addBuilding(state, at(6, 5), Zone.Industrial, 3);
    state.demandResponse.active = true;
    stepTick(state);
    const e = state.lastEnergy;
    expect(e.contractedBuildings).toBe(1);
    const hour = Math.floor(((state.tick % TICKS_PER_DAY) / TICKS_PER_DAY) * 24);
    const base =
      BALANCE.energy.consumptionByZoneAndDensity[Zone.Industrial][3] *
      BALANCE.energy.loadProfileByZone[Zone.Industrial][hour];
    expect(e.shedPool).toBeCloseTo(BALANCE.demandResponse.industrialShedShare * base, 6);
  });
});
```

Import `stepTick` from `./tick.ts` and `placePlant` from `./energy.ts`
if the file does not already (check the import list at the top; most
are present). If `contractedBuildings` comes back 0, the building is
not energised: move the plant to `at(6, 4)` (directly adjacent) and
re-run — the ring radius is 3, so adjacency always connects.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/sim/demandResponse.test.ts src/sim/energy.test.ts`
Expected: FAIL — `industrialShedShare` undefined; pool ignores the fifth argument.

- [ ] **Step 3: Implement**

`src/shared/constants.ts`, in `demandResponse` directly after `shedShare: 0.4,`:

```ts
    /**
     * Share of the industrial base load the contract may shed. Process
     * load is more flexible than office lighting and IT, and it is the
     * only load of any size on a dark, calm night — the gap the
     * commercial pool could not fill. Frozen by the Task 9 probe.
     */
    industrialShedShare: 0.6,
```

`src/sim/demandResponse.ts` — new signature and pool:

```ts
export function dispatchDemandResponse(
  state: SimState,
  businessDemand: number,
  shortfall: number,
  spotPrice: number,
  industrialDemand = 0,
): DemandResponseCall {
  const contract = state.demandResponse;
  if (state.tick % TICKS_PER_DAY === 0) contract.callBudget = callBudgetTicks();
  if (!contract.active) return { pool: 0, shed: 0 };
  const { shedShare, industrialShedShare, activationPricePerEnergyUnit } = BALANCE.demandResponse;
  const { importCapacity, importCostPerEnergyUnit } = BALANCE.market;
  const pool = shedShare * businessDemand + industrialShedShare * industrialDemand;
```

(The rest of the function is unchanged.) Update the doc comment's
`pool` line: "shedShare of the business base load plus
industrialShedShare of the industrial base load, 0 when off".

`src/sim/energy.ts`:

```ts
let businessDemand = 0;
let industrialDemand = 0;
let contractedBuildings = 0;
```

```ts
if (zone === Zone.Commercial || zone === Zone.Retail) {
  businessDemand += base;
  contractedBuildings++;
} else if (zone === Zone.Industrial) {
  industrialDemand += base;
  contractedBuildings++;
}
```

```ts
shedPool = dispatchDemandResponse(state, businessDemand, 0, spotPrice, industrialDemand).pool;
```

```ts
const call = dispatchDemandResponse(state, businessDemand, shortfall, spotPrice, industrialDemand);
```

Update the `lastEnergy.contractedBuildings` doc comment in `state.ts`
to "Connected commercial, retail and industrial buildings (the
contract's partners)."

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run src/sim/demandResponse.test.ts src/sim/energy.test.ts`
Expected: PASS.

- [ ] **Step 5: Format and commit**

```bash
pnpm format
git add src/shared/constants.ts src/sim/demandResponse.ts src/sim/demandResponse.test.ts src/sim/energy.ts src/sim/energy.test.ts src/sim/state.ts
git commit -m "feat(sim): factories join the demand-response contract with their own shed share

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Pickup leg, import fee and goods counters

**Files:**

- Modify: `src/shared/types.ts` (`DeliveryStats`, `DepotInfo`, `BudgetStats`)
- Modify: `src/shared/constants.ts` (`deliveries` block)
- Modify: `src/sim/state.ts:86-114` (VanPhase, Van), SimState fields and defaults
- Modify: `src/sim/deliveries.ts`
- Modify: `src/sim/tick.ts:297-330` (`buildBudget`)
- Test: `src/sim/deliveries.test.ts`

**Interfaces:**

- Produces (all exported from `deliveries.ts` unless noted):
  - `isFactory(state, index): boolean` — Empty tile, `Zone.Industrial`, `density > 0`, `supplied === SupplyStatus.Supplied`.
  - `hasFactoryBeside(state, road): boolean`.
  - `depotReach(state, depotRoad): Map<number, number>` — `roadDistances(state, depotRoad, maxRouteTiles)`.
  - `planPickup(state, reach): number` — nearest road tile with a factory beside it, or −1.
  - `planTour(state, van, claimed, pickup = -1, reach = depotReach(state, van.depotRoad)): number[]`.
  - `VanPhase.Loading = 3`; `Van.pickup: number` (−1 none).
  - `SimState.goods: { localToursToday: number; importedToursToday: number; lastDay: { local: number; imported: number } }`.
  - `SimState.lastGoodsImportCost: number` (per tick).
  - `DeliveryStats.factories: number`, `DeliveryStats.localShare: number`.
  - `DepotInfo.factoriesInReach: number`, `DepotInfo.nearestFactoryTiles: number` (−1 none).
  - `BudgetStats.goodsImport: number`.
  - `BALANCE.deliveries.loadTicks`, `importFeePerTour`, `goalLocalMinShops`, `goalLocalMinFactories`.

- [ ] **Step 1: Write the failing tests**

In `src/sim/deliveries.test.ts`, extend the imports:

```ts
import {
  ageShops,
  claimedStops,
  deliveriesStep,
  deliveryState,
  deliveryStats,
  depotInfo,
  depotReach,
  drivingVans,
  dueTicks,
  isFactory,
  planPickup,
  planTour,
  supplyWindowTicks,
  syncFleet,
} from './deliveries.ts';
import { createSimState, SupplyStatus, TileType, VanPhase, type SimState } from './state.ts';
import { chargingDemand, laneOccupancy, ticksAtHour, vehiclesStep } from './vehicles.ts';
```

Add a helper under `shopTown`:

```ts
/** shopTown plus a factory south of the road at x=4, powered unless told otherwise. */
function factoryTown(seed = 1, shops = 6, powered = true): SimState {
  const state = shopTown(seed, shops);
  const f = at(4, 11);
  state.layers.zone[f] = Zone.Industrial;
  state.layers.density[f] = 1;
  state.layers.supplied[f] = powered ? SupplyStatus.Supplied : SupplyStatus.NotConnected;
  return state;
}

/** Make every shop due and put the clock inside the delivery window with charged vans. */
function readyToDispatch(state: SimState): void {
  syncFleet(state);
  for (let i = 0; i < state.layers.zone.length; i++) {
    if (state.layers.zone[i] === Zone.Retail && state.layers.density[i] > 0) {
      state.layers.deliveryAge[i] = dueTicks();
    }
  }
  state.tick = ticksAtHour(9);
  for (const van of state.vans) van.charge = 1;
}
```

Add a describe block at the end of the file:

```ts
describe('goods pickup', () => {
  it('a powered factory beside a reachable road is the pickup; unpowered is not', () => {
    const powered = factoryTown();
    expect(isFactory(powered, at(4, 11))).toBe(true);
    expect(planPickup(powered, depotReach(powered, at(2, 10)))).toBe(at(4, 10));
    const dark = factoryTown(1, 6, false);
    expect(isFactory(dark, at(4, 11))).toBe(false);
    expect(planPickup(dark, depotReach(dark, at(2, 10)))).toBe(-1);
    const none = shopTown();
    expect(planPickup(none, depotReach(none, at(2, 10)))).toBe(-1);
  });

  it('the tour starts at the pickup, visits the shops and closes at the depot', () => {
    const state = factoryTown();
    readyToDispatch(state);
    const van = state.vans[0];
    const pickup = planPickup(state, depotReach(state, van.depotRoad));
    const stops = planTour(state, van, new Set(), pickup);
    expect(stops[0]).toBe(at(4, 10));
    expect(stops.at(-1)).toBe(van.depotRoad);
    expect(stops.length).toBe(BALANCE.deliveries.stopsPerTour + 2);
    expect(stops.slice(1, -1).every((s) => s !== pickup)).toBe(true);
  });

  it('a local tour costs nothing and counts as local; without a factory the depot pays the import fee', () => {
    const local = factoryTown();
    readyToDispatch(local);
    const money = local.money;
    deliveriesStep(local, laneOccupancy(local));
    const started = local.vans.filter((v) => v.phase !== VanPhase.AtDepot);
    expect(started.length).toBeGreaterThan(0);
    for (const van of started) expect(van.pickup).toBe(at(4, 10));
    expect(local.goods.localToursToday).toBe(started.length);
    expect(local.goods.importedToursToday).toBe(0);
    expect(local.money).toBe(money);
    expect(local.lastGoodsImportCost).toBe(0);

    const imported = shopTown();
    readyToDispatch(imported);
    const before = imported.money;
    deliveriesStep(imported, laneOccupancy(imported));
    const tours = imported.vans.filter((v) => v.phase !== VanPhase.AtDepot).length;
    expect(tours).toBeGreaterThan(0);
    for (const van of imported.vans) expect(van.pickup).toBe(-1);
    expect(imported.goods.importedToursToday).toBe(tours);
    expect(imported.money).toBeCloseTo(before - tours * BALANCE.deliveries.importFeePerTour, 9);
    expect(imported.lastGoodsImportCost).toBeCloseTo(
      tours * BALANCE.deliveries.importFeePerTour,
      9,
    );
  });

  it('the van loads at the factory before it delivers', () => {
    const state = factoryTown(1, 2);
    readyToDispatch(state);
    // One van only, so the phases are easy to follow.
    state.vans.length = 1;
    const van = state.vans[0];
    let sawLoading = false;
    let firstDelivery = -1;
    for (let t = 0; t < 600 && firstDelivery < 0; t++) {
      deliveriesStep(state, laneOccupancy(state));
      state.tick++;
      if (van.phase === VanPhase.Loading) sawLoading = true;
      if (state.layers.deliveryAge[at(6, 11)] === 0 || state.layers.deliveryAge[at(7, 11)] === 0) {
        firstDelivery = t;
      }
    }
    expect(sawLoading).toBe(true);
    expect(firstDelivery).toBeGreaterThan(0);
  });

  it('a pickup that becomes unreachable is skipped and the shops are still served', () => {
    const state = factoryTown(1, 2);
    readyToDispatch(state);
    state.vans.length = 1;
    const van = state.vans[0];
    deliveriesStep(state, laneOccupancy(state));
    expect(van.pickup).toBe(at(4, 10));
    // Cut the road under the pickup before the van gets there.
    bulldozeTiles(state, [at(4, 10)]);
    // The depot road is west of the cut; re-lay a bypass so the shops stay reachable.
    buildRoads(state, [
      at(2, 11),
      at(2, 12),
      at(3, 12),
      at(4, 12),
      at(5, 12),
      at(5, 11),
      at(5, 10),
    ]);
    let delivered = false;
    for (let t = 0; t < 800 && !delivered; t++) {
      deliveriesStep(state, laneOccupancy(state));
      state.tick++;
      delivered = state.layers.deliveryAge[at(6, 11)] === 0;
    }
    expect(delivered).toBe(true);
  });

  it('rolls the day counters over at the day boundary and keeps yesterday for the goal', () => {
    const state = shopTown();
    syncFleet(state);
    state.goods.localToursToday = 4;
    state.goods.importedToursToday = 1;
    state.tick = TICKS_PER_DAY;
    deliveriesStep(state, laneOccupancy(state));
    expect(state.goods.lastDay).toEqual({ local: 4, imported: 1 });
    expect(state.goods.localToursToday).toBe(0);
    expect(state.goods.importedToursToday).toBe(0);
  });

  it('stats count factories and the local share; the depot reports its goods source', () => {
    const state = factoryTown();
    syncFleet(state);
    state.goods.localToursToday = 3;
    state.goods.importedToursToday = 1;
    const stats = deliveryStats(state);
    expect(stats.factories).toBe(1);
    expect(stats.localShare).toBeCloseTo(0.75, 9);
    expect(deliveryStats(shopTown()).localShare).toBe(1);
    const info = depotInfo(state, at(2, 9));
    expect(info.factoriesInReach).toBe(1);
    expect(info.nearestFactoryTiles).toBe(2);
    expect(depotInfo(shopTown(), at(2, 9)).nearestFactoryTiles).toBe(-1);
  });
});
```

Note on the bypass test: `bulldozeTiles` on the road under the pickup
also drops `at(4, 10)` from the route; if the van has already passed
the pickup by the time of the cut in your run, the test still holds
(the shop at `at(6, 11)` is served either way). If the bypass road
cannot be built because `at(5, 11)` is a shop (shops start at x=6, so it
is empty), adjust nothing; if `buildRoads` rejects for money, set
`state.money = 1e6` first.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/sim/deliveries.test.ts`
Expected: FAIL — missing exports `isFactory`, `planPickup`, `depotReach`; `goods` undefined.

- [ ] **Step 3: Balance, types and state**

`src/shared/constants.ts`, `deliveries` block, after `unloadTicks: 8,`:

```ts
    /** Ticks a van loads at a factory before its shop leg. */
    loadTicks: 8,
    /**
     * Paid per tour a depot starts without a powered factory in reach:
     * the goods are imported. Frozen by the Task 9 probe.
     */
    importFeePerTour: 12,
```

and after `goalMinShops: 20,`:

```ts
    /** Supplied shops the localGoods goal requires. */
    goalLocalMinShops: 10,
    /** Factories the localGoods goal requires. */
    goalLocalMinFactories: 3,
```

`src/shared/types.ts`:

```ts
export interface DepotInfo {
  vansTotal: number;
  vansDriving: number;
  vansCharging: number;
  /** Retail buildings a tour from this depot can reach. */
  shopsInReach: number;
  /** Powered factories a tour from this depot can load at. */
  factoriesInReach: number;
  /** Route cost to the nearest such factory, -1 when the depot imports. */
  nearestFactoryTiles: number;
}

/** City-wide delivery figures. */
export interface DeliveryStats {
  /** Supplied shops over all shops, 0..1 (1 when there are none). */
  suppliedShare: number;
  /** Retail buildings. */
  shops: number;
  /** Vans on the road. */
  driving: number;
  depots: number;
  /** Industrial buildings (powered or not). */
  factories: number;
  /** Tours started today that loaded at a factory, over all tours (1 when none started). */
  localShare: number;
}
```

In `BudgetStats`, after `demandResponse: number;`:

```ts
/** Import fees for tours that started without a factory in reach. */
goodsImport: number;
```

`src/sim/state.ts`:

```ts
export const VanPhase = { AtDepot: 0, Driving: 1, Unloading: 2, Loading: 3 } as const;
```

In `Van`, after `stops: number[];`:

```ts
/** Road tile of this tour's factory pickup, -1 when the goods were imported. */
pickup: number;
```

In `SimState`, after `vans: Van[];`:

```ts
/**
 * Goods tours of the running day and of the day before (localGoods
 * goal). Single-day counters: transient by the goalProgress rule.
 */
goods: {
  localToursToday: number;
  importedToursToday: number;
  lastDay: {
    local: number;
    imported: number;
  }
}
/** Import fees paid this tick (budget line). */
lastGoodsImportCost: number;
```

In `createSimState`, after `vans: [],`:

```ts
    goods: { localToursToday: 0, importedToursToday: 0, lastDay: { local: 0, imported: 0 } },
    lastGoodsImportCost: 0,
```

and `lastDeliveries: { suppliedShare: 1, shops: 0, driving: 0, depots: 0, factories: 0, localShare: 1 },`.

Search `state.ts` for the save/load code (`serializeState` /
`deserializeState`, around lines 920-1040): nothing is added there —
`goods` and `pickup` are transient. Confirm `deserializeState` builds
the state via `createSimState` (so the defaults apply); if it builds a
literal instead, add the two new fields to that literal.

- [ ] **Step 4: Deliveries**

`src/sim/deliveries.ts` — add after `isShopSupplied`:

```ts
/** A powered factory: zoned industrial, built, and supplied this tick. */
export function isFactory(state: SimState, index: number): boolean {
  const { tileType, zone, density, supplied } = state.layers;
  return (
    tileType[index] === TileType.Empty &&
    zone[index] === Zone.Industrial &&
    density[index] > 0 &&
    supplied[index] === SupplyStatus.Supplied
  );
}

/** True when a powered factory stands next to this road tile. */
export function hasFactoryBeside(state: SimState, road: number): boolean {
  for (const n of neighbors4(road, state.size)) if (isFactory(state, n)) return true;
  return false;
}

/** Bounded route costs from a depot's parking road: what its tours can reach. */
export function depotReach(state: SimState, depotRoad: number): Map<number, number> {
  return roadDistances(state, depotRoad, BALANCE.deliveries.maxRouteTiles);
}

/**
 * The nearest road tile in reach with a powered factory beside it
 * (ties: lower index), or -1 when the depot has to import.
 */
export function planPickup(state: SimState, reach: Map<number, number>): number {
  let best = -1;
  let bestCost = Infinity;
  for (const [tile, distance] of reach) {
    if (!hasFactoryBeside(state, tile)) continue;
    if (distance < bestCost || (distance === bestCost && tile < best)) {
      best = tile;
      bestCost = distance;
    }
  }
  return best;
}
```

Import `SupplyStatus` from `'./state.ts'` (it is re-exported there; the
test imports it from the same place).

Rewrite `planTour`:

```ts
/**
 * Plan a tour for a van waiting at its depot: up to stopsPerTour road
 * tiles with shops beside them, reachable within maxRouteTiles of the
 * depot, oldest first (ties: nearer, then lower index), ordered
 * nearest-neighbour from the pickup (or the depot when the goods are
 * imported) and closed by the depot road. With a pickup the tour opens
 * at that road tile; a shop beside the pickup tile is stocked while the
 * van loads, so the tile is never also a shop stop. Only candidates with
 * `age >= dueTicks() / 2` are considered, so a shop is visited at most
 * about three times per supply window and an idle fleet does not circle.
 * Empty when no shop qualifies (a pickup alone is no tour).
 */
export function planTour(
  state: SimState,
  van: Van,
  claimed: Set<number>,
  pickup = -1,
  reach: Map<number, number> = depotReach(state, van.depotRoad),
): number[] {
  const { stopsPerTour, maxRouteTiles } = BALANCE.deliveries;
  const minAge = Math.floor(dueTicks() / 2);
  const candidates: Array<{ tile: number; age: number; distance: number }> = [];
  for (const [tile, distance] of reach) {
    if (claimed.has(tile) || tile === pickup) continue;
    const age = oldestShopAge(state, tile);
    if (age < minAge) continue;
    candidates.push({ tile, age, distance });
  }
  candidates.sort((a, b) => b.age - a.age || a.distance - b.distance || a.tile - b.tile);
  const remaining = new Set(candidates.slice(0, stopsPerTour).map((c) => c.tile));
  if (remaining.size === 0) return [];

  const ordered: number[] = pickup >= 0 ? [pickup] : [];
  // Every stop lies within maxRouteTiles of the depot road, and so does
  // the pickup, so twice that bound covers every hop (triangle
  // inequality). The first hop reuses the depot's map when there is no
  // pickup.
  let from = pickup >= 0 ? roadDistances(state, pickup, 2 * maxRouteTiles) : reach;
  while (remaining.size > 0) {
    let best = -1;
    let bestCost = Infinity;
    for (const tile of remaining) {
      const cost = from.get(tile) ?? Infinity;
      if (cost < bestCost || (cost === bestCost && tile < best)) {
        best = tile;
        bestCost = cost;
      }
    }
    ordered.push(best);
    remaining.delete(best);
    from = roadDistances(state, best, 2 * maxRouteTiles);
  }
  ordered.push(van.depotRoad);
  return ordered;
}
```

(The old `let current` variable goes away.)

`createVan`: add `pickup: -1,` after `stops: [],`.

`arrive`: enter `Loading` at the pickup:

```ts
function arrive(state: SimState, van: Van): void {
  if (van.stops.length <= 1) {
    // Last stop is always the depot road.
    van.stops = [];
    van.pickup = -1;
    van.phase = VanPhase.AtDepot;
    van.dwellTicks = BALANCE.deliveries.turnaroundTicks;
    van.x = tileX(van.depotRoad, state.size) + 0.5;
    van.y = tileY(van.depotRoad, state.size) + 0.5;
    return;
  }
  if (van.stops[0] === van.pickup) {
    van.phase = VanPhase.Loading;
    van.dwellTicks = BALANCE.deliveries.loadTicks;
    return;
  }
  van.phase = VanPhase.Unloading;
  van.dwellTicks = BALANCE.deliveries.unloadTicks;
}
```

`deliveriesStep` — reset the fee, roll the day, dispatch with pickup,
handle `Loading`:

```ts
export function deliveriesStep(state: SimState, occupancy: Map<number, number>): void {
  state.lastGoodsImportCost = 0;
  if (state.tick % TICKS_PER_DAY === 0) {
    const goods = state.goods;
    goods.lastDay = { local: goods.localToursToday, imported: goods.importedToursToday };
    goods.localToursToday = 0;
    goods.importedToursToday = 0;
  }
  syncFleet(state);
  const dueSoon = ageShops(state);
  if (state.vans.length === 0) return;
  // ... (unchanged up to the switch)
```

Inside `case VanPhase.AtDepot`, replace the dispatch block:

```ts
if (dueSoon > 0 && van.dwellTicks === 0 && inWindow && van.charge >= d.minTripCharge) {
  const reach = depotReach(state, van.depotRoad);
  const pickup = planPickup(state, reach);
  const stops = planTour(state, van, claimed, pickup, reach);
  if (stops.length > 0) {
    for (const stop of stops) {
      if (stop !== van.depotRoad && stop !== pickup) claimed.add(stop);
    }
    van.stops = stops;
    van.pickup = pickup;
    van.charging = false;
    if (pickup >= 0) {
      state.goods.localToursToday++;
    } else {
      // No factory in reach: the goods are imported, fee per tour,
      // billed like the contracts even when the treasury is empty.
      state.money -= d.importFeePerTour;
      state.lastGoodsImportCost += d.importFeePerTour;
      state.goods.importedToursToday++;
      state.statsDirty = true;
    }
    routeToNextStop(state, van);
  }
}
```

Add a case after `VanPhase.Unloading`:

```ts
      case VanPhase.Loading: {
        van.dwellTicks--;
        if (van.dwellTicks <= 0) {
          // Loaded; a shop beside the factory's road is stocked on the spot.
          deliver(state, van);
          van.stops.shift();
          routeToNextStop(state, van);
        }
        break;
      }
```

`routeToNextStop` already drops unreachable stops; when it drops the
pickup, the van simply continues as an imported tour (the fee was
paid). Nothing to add there.

`deliveryStats`:

```ts
export function deliveryStats(state: SimState): DeliveryStats {
  const { tileType, zone, density, deliveryAge } = state.layers;
  const window = supplyWindowTicks();
  let shops = 0;
  let supplied = 0;
  let factories = 0;
  for (let i = 0; i < tileType.length; i++) {
    if (tileType[i] === TileType.Empty && zone[i] === Zone.Industrial && density[i] > 0) {
      factories++;
    }
    if (!isShop(state, i)) continue;
    shops++;
    if (deliveryAge[i] <= window) supplied++;
  }
  const { localToursToday, importedToursToday } = state.goods;
  const tours = localToursToday + importedToursToday;
  return {
    suppliedShare: shops > 0 ? supplied / shops : 1,
    shops,
    driving: drivingVanCount(state),
    depots: depotTiles(state).length,
    factories,
    localShare: tours > 0 ? localToursToday / tours : 1,
  };
}
```

`depotInfo`:

```ts
const road = depotRoadTile(state, depot);
const reached = new Set<number>();
const factories = new Set<number>();
let nearestFactoryTiles = -1;
if (road >= 0) {
  for (const [tile, distance] of depotReach(state, road)) {
    for (const n of neighbors4(tile, state.size)) {
      if (isShop(state, n)) reached.add(n);
      if (isFactory(state, n)) {
        factories.add(n);
        if (nearestFactoryTiles < 0 || distance < nearestFactoryTiles) {
          nearestFactoryTiles = distance;
        }
      }
    }
  }
}
return {
  vansTotal,
  vansDriving,
  vansCharging,
  shopsInReach: reached.size,
  factoriesInReach: factories.size,
  nearestFactoryTiles,
};
```

`src/sim/tick.ts` `buildBudget`: add `goodsImport: state.lastGoodsImportCost,`
after the `demandResponse` line and `- state.lastGoodsImportCost` at the
end of the `net` expression.

- [ ] **Step 5: Typecheck, run the tests**

Run: `pnpm typecheck && pnpm vitest run src/sim/deliveries.test.ts src/sim`
Expected: PASS. Typecheck will flag every `DeliveryStats` /
`DepotInfo` / `BudgetStats` literal elsewhere (tests, `tools.ts`
overview, `tools.test.ts` fixtures): add the new fields there
(`factories: 0, localShare: 1`, `factoriesInReach: 0, nearestFactoryTiles: -1`,
`goodsImport: 0`, and in `tools.ts` overview
`goodsImport: round(s.budget.goodsImport, 3),` plus
`factories: s.deliveries.factories, localShare: round(s.deliveries.localShare, 2),`).

Also check the e2e / agent tests that assert the full budget `net`
(grep `net:` in `src/agent/tools.test.ts`) still hold — `goodsImport`
is 0 without a depot.

- [ ] **Step 6: Format and commit**

```bash
pnpm format
git add src/shared/types.ts src/shared/constants.ts src/sim/state.ts src/sim/deliveries.ts src/sim/deliveries.test.ts src/sim/tick.ts src/agent/tools.ts
git commit -m "feat(sim): vans load at a powered factory before the shop leg; depots without one import and pay per tour

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

(Add any fixture files Step 5 touched.)

---

### Task 4: Nuisance penalty and the localGoods goal

**Files:**

- Modify: `src/shared/constants.ts` (`happiness` block)
- Modify: `src/sim/happiness.ts`
- Modify: `src/sim/goals.ts`
- Test: `src/sim/happiness.test.ts`, `src/sim/goals.test.ts`

**Interfaces:**

- Consumes: `state.goods.lastDay`, `state.lastDeliveries.factories` (Task 3).
- Produces: `industryCoverage(state): number` (exported from `happiness.ts`);
  goal id `'localGoods'`; `BALANCE.happiness.industryRadius`, `industryPenaltyWeight`.

- [ ] **Step 1: Write the failing tests**

`src/sim/happiness.test.ts` — add at the end:

```ts
describe('industry next door', () => {
  const { base, industryRadius, industryPenaltyWeight } = BALANCE.happiness;

  function withFactory(x: number, y: number, zone: Zone = Zone.Industrial) {
    const state = suppliedCity();
    state.layers.zone[at(x, y)] = zone;
    state.layers.density[at(x, y)] = 1;
    state.layers.supplied[at(x, y)] = SupplyStatus.Supplied;
    return state;
  }

  it('homes within the radius of a factory lower happiness by the covered share', () => {
    // Homes at y=2, x=0..9; a factory at (4, 5) is 3 rows away and reaches x=0..8.
    const state = withFactory(4, 5);
    expect(industryCoverage(state)).toBeCloseTo(0.9, 9);
    expect(settle(state, 10)).toBeCloseTo(base - 0.9 * industryPenaltyWeight, 2);
  });

  it('an office in the same place disturbs nobody', () => {
    const state = withFactory(4, 5, Zone.Commercial);
    expect(industryCoverage(state)).toBe(0);
    expect(settle(state, 10)).toBeCloseTo(base, 2);
  });

  it('a home is counted once however many factories surround it', () => {
    const state = withFactory(4, 5);
    state.layers.zone[at(3, 5)] = Zone.Industrial;
    state.layers.density[at(3, 5)] = 1;
    expect(industryCoverage(state)).toBeCloseTo(0.9, 9);
  });

  it('a factory just outside the radius does not count', () => {
    const state = withFactory(4, 2 + industryRadius + 1);
    expect(industryCoverage(state)).toBe(0);
  });
});
```

Import `industryCoverage` from `./happiness.ts`.

`src/sim/goals.test.ts` — add at the end:

```ts
describe('localGoods', () => {
  function stockedCity(local: number, imported: number): SimState {
    const state = createSimState(1, SIZE);
    state.lastDeliveries = {
      suppliedShare: 1,
      shops: BALANCE.deliveries.goalLocalMinShops,
      driving: 0,
      depots: 1,
      factories: BALANCE.deliveries.goalLocalMinFactories,
      localShare: 1,
    };
    state.goods.lastDay = { local, imported };
    state.tick = TICKS_PER_DAY;
    return state;
  }

  it('unlocks at the day boundary after a fully local day with enough shops and factories', () => {
    const state = stockedCity(5, 0);
    goalsStep(state);
    expect(state.goalsAchieved.has('localGoods')).toBe(true);
  });

  it('does not unlock after a day with one imported tour, nor off the boundary, nor with too few factories', () => {
    const imported = stockedCity(5, 1);
    goalsStep(imported);
    expect(imported.goalsAchieved.has('localGoods')).toBe(false);

    const midday = stockedCity(5, 0);
    midday.tick = TICKS_PER_DAY + 1;
    goalsStep(midday);
    expect(midday.goalsAchieved.has('localGoods')).toBe(false);

    const fewFactories = stockedCity(5, 0);
    fewFactories.lastDeliveries.factories = BALANCE.deliveries.goalLocalMinFactories - 1;
    goalsStep(fewFactories);
    expect(fewFactories.goalsAchieved.has('localGoods')).toBe(false);

    const noTours = stockedCity(0, 0);
    goalsStep(noTours);
    expect(noTours.goalsAchieved.has('localGoods')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/sim/happiness.test.ts src/sim/goals.test.ts`
Expected: FAIL — `industryCoverage` not exported; `'localGoods'` not a `GoalId`.

- [ ] **Step 3: Implement**

`src/shared/constants.ts`, `happiness` block, after `parkRadius: 6,`:

```ts
    /** Homes within this Chebyshev radius of a factory count as disturbed. */
    industryRadius: 4,
    /**
     * Max happiness penalty when every home has a factory nearby; scales
     * with the share of residential buildings within industryRadius.
     * Slightly above the park bonus, so a factory among the homes costs
     * more than a park next door buys back. Frozen by the Task 9 probe.
     */
    industryPenaltyWeight: 0.1,
```

`src/sim/happiness.ts` — add after `parkCoverage` and import `Zone`
from `'../shared/types.ts'`:

```ts
/** Share (0..1) of homes that have a factory within the industry radius. */
export function industryCoverage(state: SimState): number {
  const { layers } = state;
  const factories: number[] = [];
  for (let i = 0; i < layers.tileType.length; i++) {
    if (
      layers.tileType[i] === TileType.Empty &&
      layers.zone[i] === Zone.Industrial &&
      layers.density[i] > 0
    ) {
      factories.push(i);
    }
  }
  if (factories.length === 0) return 0;

  const radius = BALANCE.happiness.industryRadius;
  let homes = 0;
  let disturbed = 0;
  for (let i = 0; i < layers.tileType.length; i++) {
    if (
      layers.tileType[i] !== TileType.Empty ||
      layers.zone[i] !== Zone.Residential ||
      layers.density[i] === 0
    ) {
      continue;
    }
    homes++;
    const x = tileX(i, state.size);
    const y = tileY(i, state.size);
    for (const factory of factories) {
      const dx = Math.abs(x - tileX(factory, state.size));
      const dy = Math.abs(y - tileY(factory, state.size));
      if (Math.max(dx, dy) <= radius) {
        disturbed++;
        break;
      }
    }
  }
  return homes > 0 ? disturbed / homes : 0;
}
```

In `happinessStep`, after `coastBonus`:

```ts
// Factories are unwelcome neighbours: homes in their reach weigh on the city.
const industryPenalty = industryCoverage(state) * config.industryPenaltyWeight;
```

and add `- industryPenalty` to the `target` expression (after
`- supplyPenalty`). Extend the function's doc comment with "by homes
next to factories".

`src/sim/goals.ts`:

- Add `'localGoods',` after `'loadManager',` in `GOAL_IDS`.
- In `goalsStep`, after the `loadManager` check:

```ts
// Yesterday every tour loaded at a factory, in a real retail scene.
const { goalLocalMinShops, goalLocalMinFactories } = BALANCE.deliveries;
const yesterday = state.goods.lastDay;
if (
  !achieved.has('localGoods') &&
  state.tick % TICKS_PER_DAY === 0 &&
  yesterday.local > 0 &&
  yesterday.imported === 0 &&
  state.lastDeliveries.shops >= goalLocalMinShops &&
  state.lastDeliveries.suppliedShare >= BALANCE.deliveries.goalSuppliedShare &&
  state.lastDeliveries.factories >= goalLocalMinFactories
) {
  achieved.add('localGoods');
}
```

(`deliveriesStep` fills `lastDay` on the same boundary tick before
`goalsStep` runs — see `stepTick` order.)

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run src/sim/happiness.test.ts src/sim/goals.test.ts src/sim`
Expected: PASS. If a goals test asserts the total goal count (grep
`GOAL_IDS.length` or `toHaveLength(20)` in `goals.test.ts` and
`src/agent/tools.test.ts`), bump it by one.

- [ ] **Step 5: Format and commit**

```bash
pnpm format
git add src/shared/constants.ts src/sim/happiness.ts src/sim/happiness.test.ts src/sim/goals.ts src/sim/goals.test.ts
git commit -m "feat(sim): homes near factories are less happy; localGoods goal for a fully local day

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: UI — tool, demand bar, inspector, budget, HUD and copy

**Files:**

- Modify: `src/ui/useTools.ts:21-75`, `src/ui/BuildBar.tsx:51-59`, `src/ui/DemandBars.tsx`, `src/ui/app.css:842-850`, `src/ui/TileInspector.tsx:53-57, 424-480`, `src/ui/BudgetPanel.tsx:57-59, 203-213`, `src/ui/CityVitals.tsx:62-79`, `src/ui/i18n.tsx`
- Test: `src/ui/useTools.test.ts`

**Interfaces:**

- Consumes: `Zone.Industrial`, `DemandStats.industrial`, `TileInfo.depot.factoriesInReach/nearestFactoryTiles`, `BudgetStats.goodsImport`, `DeliveryStats.factories/localShare`.
- Produces: tool id `'zone-industrial'`, hotkey `n`, test ids `tool-zone-industrial`, `demand-industrial`, `inspect-goods`.

- [ ] **Step 1: Write the failing test**

`src/ui/useTools.test.ts`, inside `describe('tool hotkeys', …)`:

```ts
it('binds the industrial zone to N', () => {
  expect(TOOL_HOTKEYS.n).toBe('zone-industrial');
});
```

Run: `pnpm vitest run src/ui/useTools.test.ts` — Expected: FAIL.

- [ ] **Step 2: Tool and hotkey**

`src/ui/useTools.ts`: add `| 'zone-industrial'` to the `ToolId` union
(next to `'zone-retail'`), add to `ZONE_BY_TOOL`:

```ts
  'zone-industrial': Zone.Industrial,
```

and to `TOOL_HOTKEYS` (after `k: 'plant-busdepot',`): `n: 'zone-industrial',`.
Update the hotkey doc comment to include N.

`src/ui/BuildBar.tsx`, zones category:

```ts
      { id: 'zone-industrial', icon: '🏭', cost: BALANCE.costs.zonePerTile, perTile: true },
```

- [ ] **Step 3: Demand bar and CSS**

`src/ui/DemandBars.tsx`:

```ts
const BARS: Array<{ key: keyof DemandStats; label: string; className: string }> = [
  { key: 'residential', label: 'R', className: 'demand-residential' },
  { key: 'commercial', label: 'C', className: 'demand-commercial' },
  { key: 'retail', label: 'S', className: 'demand-retail' },
  { key: 'industrial', label: 'I', className: 'demand-industrial' },
];

/** Compact R/C/S/I demand indicator (S = shopping/retail, I = industry). */
```

`src/ui/app.css`, after `.demand-retail { … }`:

```css
.demand-industrial {
  background: #b3a06a;
}
```

- [ ] **Step 4: Inspector**

`src/ui/TileInspector.tsx`:

```ts
const ZONE_LABEL: Record<Zone, TranslationKey | null> = {
  [Zone.None]: null,
  [Zone.Residential]: 'tool.zone-residential',
  [Zone.Commercial]: 'tool.zone-commercial',
  [Zone.Retail]: 'tool.zone-retail',
  [Zone.Industrial]: 'tool.zone-industrial',
};
```

Directly before the `{isBuilding && info.zone === Zone.Retail && (` section:

```tsx
{
  isBuilding && info.zone === Zone.Industrial && (
    <section data-testid="inspect-goods">
      <h3>{t('inspect.section.goods')}</h3>
      <Row
        label={t('inspect.factory.goods')}
        value={t(
          info.supplied === SupplyStatus.Supplied
            ? 'inspect.factory.supplying'
            : 'inspect.factory.unpowered',
        )}
        tone={info.supplied === SupplyStatus.Supplied ? 'positive' : 'negative'}
      />
    </section>
  );
}
```

(Import `SupplyStatus` from `'../shared/types.ts'` if the file does
not already.) In the depot section, after the `shopsInReach` row:

```tsx
          <Row
            label={t('inspect.depot.factoriesInReach')}
            value={String(info.depot.factoriesInReach)}
            tone={info.depot.factoriesInReach > 0 ? 'positive' : 'muted'}
          />
          <Row
            label={t('inspect.depot.goodsSource')}
            value={
              info.depot.nearestFactoryTiles >= 0
                ? t('inspect.depot.goodsLocal', { tiles: info.depot.nearestFactoryTiles })
                : t('inspect.depot.goodsImported', { fee: BALANCE.deliveries.importFeePerTour })
            }
            tone={info.depot.nearestFactoryTiles >= 0 ? 'positive' : 'negative'}
          />
```

(Import `BALANCE` if missing.)

- [ ] **Step 5: Budget slice and HUD title**

`src/ui/BudgetPanel.tsx`: add `goodsImport: '#b3a06a',` to
`EXPENSE_COLORS` after `demandResponse`, and after the `demandResponse`
slice object:

```ts
    {
      key: 'goodsImport',
      label: t('budget.goodsImport'),
      value: perDay(budget.goodsImport),
      color: EXPENSE_COLORS.goodsImport,
    },
```

`src/ui/CityVitals.tsx`, deliveries title:

```tsx
          title={t('hud.deliveries.title', {
            supplied: Math.round(stats.deliveries.suppliedShare * stats.deliveries.shops),
            shops: stats.deliveries.shops,
            vans: stats.deliveries.driving,
            factories: stats.deliveries.factories,
            local: Math.round(stats.deliveries.localShare * 100),
          })}
```

- [ ] **Step 6: Strings, English and German**

`src/ui/i18n.tsx`, in `en` (place each next to its sibling key):

```ts
  'hud.deliveries.title':
    '{supplied} of {shops} shops supplied · {vans} vans on the road · {factories} factories · {local} % of today\'s tours loaded locally',
  'hud.demand.title': 'Demand: residential / commercial / retail / industrial',
  'tool.zone-industrial': 'Industrial',
  'tool.zone-industrial.desc':
    'Factories. Grow with your shops, add jobs and night-time load, hand their goods to the delivery vans — and bother the homes next door.',
  'budget.goodsImport': 'Goods import',
  'inspect.section.goods': 'Goods',
  'inspect.factory.goods': 'Goods',
  'inspect.factory.supplying': 'Supplies depots in reach',
  'inspect.factory.unpowered': 'No power — depots import instead',
  'inspect.depot.factoriesInReach': 'Factories in reach',
  'inspect.depot.goodsSource': 'Goods',
  'inspect.depot.goodsLocal': 'Loaded locally, nearest factory {tiles} tiles',
  'inspect.depot.goodsImported': 'Imported, {fee} per tour',
  'goal.localGoods.title': 'Made locally',
  'goal.localGoods.body':
    'A whole day in which every delivery tour loaded at your own factories (10+ stocked shops, 3+ factories).',
```

Edit the existing `en` strings:

- `'help.build.body'`: "paint residential, commercial and retail zones"
  → "paint residential, commercial, retail and industrial zones";
  "(see the R/C/S bars)" → "(see the R/C/S/I bars)".
- `'help.deliveries.body'`: append " Vans load at a powered factory
  in reach before their shop leg; a depot without one imports the goods
  and pays a fee per tour. Factories follow your shops, run day and
  night — and homes within a few tiles of one are less happy."
- `'help.energy.body'`: "lets your commercial and retail buildings shed"
  → "lets your commercial, retail and industrial buildings shed".
- `'demandResponse.title'`: "Commercial and retail buildings sign up
  to shed up to {share} % of their base load" → "Commercial and retail
  buildings sign up to shed up to {share} % of their base load,
  factories a larger share".

In `de`:

```ts
  'hud.deliveries.title':
    '{supplied} von {shops} Läden beliefert · {vans} Lieferwagen unterwegs · {factories} Fabriken · {local} % der heutigen Touren lokal beladen',
  'hud.demand.title': 'Nachfrage: Wohnen / Gewerbe / Handel / Industrie',
  'tool.zone-industrial': 'Industrie',
  'tool.zone-industrial.desc':
    'Fabriken. Wachsen mit deinen Läden, bringen Jobs und Nachtlast, beladen die Lieferwagen — und stören die Nachbarn.',
  'budget.goodsImport': 'Güterimport',
  'inspect.section.goods': 'Güter',
  'inspect.factory.goods': 'Güter',
  'inspect.factory.supplying': 'Beliefert Depots in Reichweite',
  'inspect.factory.unpowered': 'Kein Strom — Depots importieren stattdessen',
  'inspect.depot.factoriesInReach': 'Fabriken in Reichweite',
  'inspect.depot.goodsSource': 'Güter',
  'inspect.depot.goodsLocal': 'Lokal beladen, nächste Fabrik {tiles} Kacheln',
  'inspect.depot.goodsImported': 'Importiert, {fee} pro Tour',
  'goal.localGoods.title': 'Aus eigener Produktion',
  'goal.localGoods.body':
    'Ein ganzer Tag, an dem jede Liefertour in deinen eigenen Fabriken beladen wurde (ab 10 belieferten Läden und 3 Fabriken).',
```

and the German counterparts of the four edited strings (find them by
key: `'help.build.body'`, `'help.deliveries.body'`, `'help.energy.body'`,
`'demandResponse.title'`): "Wohn-, Gewerbe- und Einzelhandelszonen" →
"Wohn-, Gewerbe-, Einzelhandels- und Industriezonen"; "R/C/S" →
"R/C/S/I"; append to the deliveries help: " Lieferwagen beladen vor
der Ladentour an einer versorgten Fabrik in Reichweite; ein Depot ohne
Fabrik importiert die Ware und zahlt pro Tour eine Gebühr. Fabriken
folgen deinen Läden, laufen Tag und Nacht — und Wohnhäuser wenige
Kacheln daneben sind weniger zufrieden."; energy help "Gewerbe- und
Einzelhandelsgebäude" → "Gewerbe-, Einzelhandels- und
Industriegebäude" in the demand-response sentence; DR title: append
", Fabriken einen größeren Anteil" after the share clause. Read each
German sentence after editing so the grammar still holds.

- [ ] **Step 7: Typecheck, tests, format**

Run: `pnpm typecheck && pnpm vitest run src/ui && pnpm format && pnpm format:check`
Expected: PASS; `TranslationKey` catches any key present in only one language.

- [ ] **Step 8: Commit**

```bash
git add src/ui/useTools.ts src/ui/useTools.test.ts src/ui/BuildBar.tsx src/ui/DemandBars.tsx src/ui/app.css src/ui/TileInspector.tsx src/ui/BudgetPanel.tsx src/ui/CityVitals.tsx src/ui/i18n.tsx
git commit -m "feat(ui): industrial zone tool, I demand bar, goods rows in the inspector, goods-import budget line

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Render — factory look and zone colours

**Files:**

- Modify: `src/render/buildings/palette.ts:17-33`, `src/render/buildings/recipes.ts` (new `industrial` recipe, switch), `src/render/zoneTilesMesh.ts:13-17`, `src/render/minimapLayer.ts:18-27`
- Test: `src/render/buildings/palette.test.ts`, `src/render/buildings/recipes.test.ts`

**Interfaces:**

- Consumes: `Zone.Industrial`, `ZONE_FAMILIES`, `box`, `onStreetFace`, `PartKind`, `PartRole`, `ACCENT`.
- Produces: `ZONE_FAMILIES[Zone.Industrial]`; `industrial(density, p, face, family): BuildingPart[]`.

- [ ] **Step 1: Extend the tests**

`src/render/buildings/palette.test.ts`: change the `it.each` list to
`[Zone.Residential, Zone.Commercial, Zone.Retail, Zone.Industrial]`.

`src/render/buildings/recipes.test.ts`:

- `const ZONES: Zone[] = [Zone.Residential, Zone.Commercial, Zone.Retail, Zone.Industrial];`
- In `'tags nothing on any other recipe and never rotates a tagged part'`,
  extend `expected` with `|| zone === Zone.Industrial`.
- Add inside the `'part roles (stage 2 accents)'` describe:

```ts
it('tags exactly one chimney on every factory', () => {
  for (const { zone, parts } of allRecipes(SAMPLE)) {
    if (zone !== Zone.Industrial) continue;
    expect(parts.filter((p) => p.role === PartRole.Chimney)).toHaveLength(1);
  }
});
```

- Add to `describe('building recipes', …)`:

```ts
it('gives factories a saw-tooth roof: two gable parts side by side on the hall', () => {
  for (const { zone, parts } of allRecipes(SAMPLE)) {
    if (zone !== Zone.Industrial) continue;
    const gables = parts.filter((p) => p.kind === PartKind.GableRoof);
    expect(gables).toHaveLength(2);
    expect(gables[0].oy).toBeCloseTo(gables[1].oy, 9);
    expect(gables[0].ox).not.toBeCloseTo(gables[1].ox, 9);
  }
});
```

Run: `pnpm vitest run src/render/buildings` — Expected: FAIL (no family, no parts).

- [ ] **Step 2: Palette**

`src/render/buildings/palette.ts`, add to `ZONE_FAMILIES`:

```ts
  [Zone.Industrial]: {
    walls: colors(0x9aa0a6, 0xb5b0a3, 0x8c8f93, 0xa7a295),
    roofs: colors(0x5b5f66, 0x8a4b3a, 0x6f7378),
    trims: colors(0xe0b030, 0x3f4650),
  },
```

Update the comment above: "(…, rose and apricot, corrugated grey with
rust and safety yellow)".

- [ ] **Step 3: Recipe**

`src/render/buildings/recipes.ts` — add after `retail(…)`:

```ts
/**
 * Factories: low halls under a saw-tooth roof (two gable parts side by
 * side), a roll-up door on the street face, a chimney for the stage 2
 * smoke; the bigger plants add a tank or a silo and flat PV.
 */
function industrial(
  density: number,
  p: Picker,
  face: StreetFace,
  family: ZoneFamily,
): BuildingPart[] {
  const wall = p.from(family.walls);
  const roof = p.from(family.roofs);
  const trim = p.from(family.trims);
  const parts: BuildingPart[] = [];

  const sawTooth = (w: number, d: number, top: number, ox: number, oz: number): void => {
    const half = w / 2;
    for (const side of [-1, 1]) {
      parts.push({
        kind: PartKind.GableRoof,
        sx: half,
        sy: 0.1,
        sz: d,
        ox: ox + (side * half) / 2,
        oy: top,
        oz,
        turn: 0,
        color: roof,
      });
    }
  };
  const chimney = (sx: number, sy: number, ox: number, oy: number, oz: number): BuildingPart => ({
    kind: PartKind.Cylinder,
    sx,
    sy,
    sz: sx,
    ox,
    oy,
    oz,
    turn: 0,
    color: ACCENT.chimney,
    accent: true,
    role: PartRole.Chimney,
  });

  if (density === 1) {
    // Workshop: one hall, saw-tooth roof, door, chimney at the back.
    const w = 0.7;
    const d = 0.5;
    const h = 0.28 + p.unit() * 0.04;
    const body = box(w, h, d, 0, 0, 0, wall, { main: true });
    parts.push(body);
    sawTooth(w, d, h, 0, 0);
    parts.push(onStreetFace(body, face, 0.4, h * 0.7, 0.02, 0, trim));
    parts.push(chimney(0.06, 0.22, -0.25, h, -0.15));
  } else if (density === 2) {
    // Plant: main hall behind, lower annex in front, tank, chimney, PV.
    const w = 0.7;
    const h = 0.36 + p.unit() * 0.04;
    const body = box(w, h, 0.34, 0, 0, -0.12, wall, { main: true });
    parts.push(body);
    sawTooth(w, 0.34, h, 0, -0.12);
    const annexH = h * 0.7;
    const annex = box(0.5, annexH, 0.22, -0.08, 0, 0.19, wall);
    parts.push(annex);
    parts.push(onStreetFace(annex, face, 0.5, annexH * 0.7, 0.02, 0, trim));
    parts.push({
      kind: PartKind.Cylinder,
      sx: 0.14,
      sy: 0.3,
      sz: 0.14,
      ox: 0.28,
      oy: 0,
      oz: 0.22,
      turn: 0,
      color: ACCENT.waterTank,
      accent: true,
    });
    parts.push(chimney(0.06, 0.34, -0.27, h, -0.2));
    parts.push(
      box(0.3, ROOFTOP_PV_THICKNESS, 0.16, 0.1, annexH, 0.19, ACCENT.rooftopPv, { accent: true }),
    );
  } else {
    // Works: long hall, trim band, silo, tall chimney, door, PV.
    const w = 0.74;
    const d = 0.5;
    const h = 0.42 + p.unit() * 0.06;
    const body = box(w, h, d, 0, 0, -0.04, wall, { main: true });
    parts.push(body);
    sawTooth(w, d, h, 0, -0.04);
    parts.push(box(w + 0.02, 0.03, d + 0.02, 0, h * 0.5, -0.04, trim, { accent: true }));
    parts.push(onStreetFace(body, face, 0.3, h * 0.6, 0.02, 0, trim));
    parts.push({
      kind: PartKind.Cylinder,
      sx: 0.18,
      sy: 0.7,
      sz: 0.18,
      ox: 0.3,
      oy: 0,
      oz: 0.3,
      turn: 0,
      color: ACCENT.waterTank,
      accent: true,
    });
    parts.push(chimney(0.06, 0.55, -0.3, h, -0.25));
    parts.push(
      box(0.3, ROOFTOP_PV_THICKNESS, 0.2, -0.15, h + 0.1, 0.1, ACCENT.rooftopPv, { accent: true }),
    );
  }
  return parts;
}
```

Add to the `buildingParts` switch:

```ts
    case Zone.Industrial:
      return industrial(density, picker, face, family);
```

Part budgets per tile: d1 = 1 box + 2 gables + 1 door + 1 cylinder = 5;
d2 = 2 boxes + door + PV (4 boxes) + 2 gables + 2 cylinders = 8;
d3 = body + band + door + PV (4 boxes) + 2 gables + 2 cylinders = 8.
All within `MAX_PARTS_PER_TILE` (8), boxes ≤ 7, gables ≤ 2,
cylinders ≤ 2, one chimney ≤ `MAX_PUFF_ANCHORS_PER_TILE`. Extents stay
under `FOOTPRINT_HALF` (silo at ox 0.3 with radius 0.09 → 0.39).

The PV slab on d3 sits at `h + 0.1`, above the saw-tooth ridge (gable
height 0.1), so `buildingHeight` is the chimney top (`h + 0.55`), well
under the commercial tower — the "commercial towers are the tallest"
test holds. If `'grow rooftop PV from density 2 only'` asserts a PV
part on every density ≥ 2 and none on density 1, this recipe
satisfies it; read the test once to confirm.

- [ ] **Step 4: Zone tint, minimap**

`src/render/zoneTilesMesh.ts`:

```ts
  [Zone.Industrial]: new THREE.Color(0xb3a06a),
```

`src/render/minimapLayer.ts`: `zoned` → `[Zone.Industrial]: '#d9cfa9',`;
`building` → `[Zone.Industrial]: '#8a7a3c',`.

(`overlays.ts` `demandFor` was done in Task 1 Step 5.)

- [ ] **Step 5: Run the render tests**

Run: `pnpm vitest run src/render`
Expected: PASS. If `'stay inside the footprint and above the ground'`
fails for a part, shrink that part's offset until it passes and keep
the shapes.

- [ ] **Step 6: Format and commit**

```bash
pnpm format
git add src/render/buildings/palette.ts src/render/buildings/palette.test.ts src/render/buildings/recipes.ts src/render/buildings/recipes.test.ts src/render/zoneTilesMesh.ts src/render/minimapLayer.ts
git commit -m "feat(render): factory recipe — saw-tooth halls, silo, chimney — and industrial zone colours

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Agent tools and docs

**Files:**

- Modify: `src/agent/tools.ts:85-89, 215-224, 419-432, 540-543, 614-619, 678, 969, 1098, 1289-1292, 1379-1385`
- Modify: `docs/agent-tools.md:64, 115, 121, 128`
- Test: `src/agent/tools.test.ts:428`

**Interfaces:**

- Consumes: `Zone.Industrial`, `DeliveryStats.factories/localShare`, `BudgetStats.goodsImport`.
- Produces: zone name `industrial`; find kind `factory`; glyphs `i`/`I`.

- [ ] **Step 1: Fix and extend the tests**

`src/agent/tools.test.ts:428`: change `zone: 'industrial'` to
`zone: 'farmland'`.

Add to the describe that tests `paint_zone` (grep `paint_zone` for the
block; it uses `createHarness()` and `call`):

```ts
it('paints the industrial zone and reports it on the map and in the overview', async () => {
  const { call, engine } = createHarness();
  await call('build_road', { from: { x: 2, y: 5 }, to: { x: 8, y: 5 } });
  const result = await call('paint_zone', {
    zone: 'industrial',
    from: { x: 2, y: 6 },
    to: { x: 8, y: 6 },
  });
  expect(result).toMatchObject({ ok: true });
  expect(engine.state.layers.zone[tileIndex(4, 6, SIZE)]).toBe(Zone.Industrial);
  const map = (await call('get_map')) as { rows: string[] };
  expect(map.rows[6]).toContain('i');
  const overview = (await call('get_game_overview')) as {
    demand: { industrial: number };
    deliveries: { factories: number; localShare: number };
    budgetPerTick: { goodsImport: number };
  };
  expect(typeof overview.demand.industrial).toBe('number');
  expect(overview.deliveries.factories).toBe(0);
  expect(overview.deliveries.localShare).toBe(1);
  expect(overview.budgetPerTick.goodsImport).toBe(0);
  const found = (await call('find_tiles', { kind: 'factory', x: 4, y: 6 })) as {
    tiles: unknown[];
  };
  expect(found.tiles).toHaveLength(0);
});
```

Adjust the property names to what the harness exposes (`engine.state`
may be reached differently — grep how other tests read the state; the
map tool's result shape — grep `get_map` in the test file for the
field that holds the rows; the find tool's input — grep `find_tiles`).

Run: `pnpm vitest run src/agent` — Expected: FAIL on `industrial`.

- [ ] **Step 2: Implement**

`src/agent/tools.ts`:

```ts
export const ZONE_NAMES = {
  residential: Zone.Residential,
  commercial: Zone.Commercial,
  retail: Zone.Retail,
  industrial: Zone.Industrial,
} as const;
```

`FIND_KINDS`: add `'factory',` after `'undersupplied_building',`.

Glyphs (`layerGlyph`, overview layer):

```ts
if (zone === Zone.Retail) return built ? 'S' : 's';
if (zone === Zone.Industrial) return built ? 'I' : 'i';
```

Legend: `'r/c/s/i zoned but unbuilt (residential/commercial/retail/industrial), R/C/S/I building, '`.

Overview `demand` (done in Task 1), `deliveries` (done in Task 3) —
verify both carry `industrial`, `factories`, `localShare`, and
`budgetPerTick.goodsImport`.

`find_tiles` predicate:

```ts
    case 'factory':
      return tiles.zone[i] === Zone.Industrial && tiles.density[i] > 0;
```

and add `factory` to the `find_tiles` description list (line ~834):
"…, `factory` (an industrial building), …".

Descriptions:

- line ~678: `'Zones (residential, commercial, retail, industrial) grow on their own when demand is positive '` and append after that sentence: `'Industrial demand follows the retail jobs; factories hand goods to delivery vans and lower the happiness of homes within ' + BALANCE.happiness.industryRadius + ' tiles. '`.
- `paint_zone` description: `'Zone every empty land tile in a rectangle as residential, commercial, retail or industrial. '`.
- `set_demand_response` description: "…contract with the commercial and retail buildings. Under contract, up to X % of their base load…" → "…contract with the commercial, retail and industrial buildings. Under contract, up to ${Math.round(shedShare*100)} % of the business base load and ${Math.round(industrialShedShare*100)} % of the industrial base load is shed…" (destructure `industrialShedShare` from `BALANCE.demandResponse` alongside the others).
- Build-catalog rules for `PlantType.LogisticsDepot`:

```ts
return {
  vans: BALANCE.deliveries.vansPerDepot,
  routeReachTiles: BALANCE.deliveries.maxRouteTiles,
  loadTicks: BALANCE.deliveries.loadTicks,
  importFeePerTour: BALANCE.deliveries.importFeePerTour,
};
```

`docs/agent-tools.md`:

- Conventions: "Zones: `residential`, `commercial`, `retail`, `industrial`."
- `find_tiles` row: add `factory` to the kind list.
- `paint_zone` row: "Rectangle `from`→`to` with `zone` (`industrial` factories load the delivery vans; depots without one import)".
- `set_demand_response` row: "…with commercial, retail and industrial buildings…".
- `get_game_overview` row (grep it): mention "deliveries incl. factories and local share, goods import on the budget".

- [ ] **Step 3: Run, format, commit**

Run: `pnpm typecheck && pnpm vitest run src/agent && pnpm format`
Expected: PASS.

```bash
git add src/agent/tools.ts src/agent/tools.test.ts docs/agent-tools.md
git commit -m "feat(agent): industrial zone — paint_zone industrial, i/I glyphs, factory find kind, goods figures in the overview

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: e2e smoke

**Files:**

- Modify: `e2e/game.spec.ts:160-171`

- [ ] **Step 1: Assert the tool and the bar**

In the toolbar test (the block that checks `tool-plant-depot` is
visible), add:

```ts
await expect(page.getByTestId('tool-zone-industrial')).toBeVisible();
await expect(page.getByTestId('demand-industrial')).toBeVisible();
```

- [ ] **Step 2: Run what the sandbox can**

The Linux sandbox has no WebGL; run `pnpm typecheck && pnpm lint &&
pnpm format:check` and `node scripts/smoke.mjs`. `pnpm e2e` runs on the
Mac or CI — note it in the hand-off.

- [ ] **Step 3: Commit**

```bash
git add e2e/game.spec.ts
git commit -m "test(e2e): industrial zone tool and demand bar are on the HUD

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Pacing probe, balance freeze, docs

**Files:**

- Create (temporary, deleted before the commit): `src/sim/_industrialProbe.test.ts`
- Modify: `src/shared/constants.ts` (comments and, if the probe says so, values on `jobsByZoneAndDensity[Industrial]`, `consumptionByZoneAndDensity[Industrial]`, `industrialShedShare`, `importFeePerTour`, `industryRadius`, `industryPenaltyWeight`)
- Modify: `src/ui/i18n.tsx` (goal body numbers, only if `goalLocalMinShops/Factories` move)
- Modify: `docs/superpowers/specs/2026-10-05-industrial-zone-design.md` (Testing: probe record; Deliveries: `goods` is transient)
- Modify: `docs/idea.md` (backlog entry)

- [ ] **Step 1: Write the probe**

Create `src/sim/_industrialProbe.test.ts`:

```ts
import { describe, it } from 'vitest';
import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { placePlant } from './energy.ts';
import { industryCoverage } from './happiness.ts';
import { buildPowerLines } from './powerLines.ts';
import { buildRoads } from './roads.ts';
import { createSimState, PlantType, Zone, type SimState } from './state.ts';
import { stepTick } from './tick.ts';

const SIZE = 64;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);
const DAYS = 20;

/**
 * The demand-response probe town plus a connector road down x = 2, a
 * logistics depot at (1, 36) and, with `industry`, a band of factories
 * (density 2, 40 tiles) south of the road at y = 36, with a residential
 * band at y = 41 right behind them so the nuisance penalty is measured.
 * Bands: four residential (y 6..21), commercial/retail (26, 31),
 * industrial (36), residential (41). Lines on every road, trunk down
 * x = 3, plant park east: 8 wind, 8 solar, 6 batteries, biogas, hydrogen.
 */
function city(seed: number, industry: boolean): SimState {
  const state = createSimState(seed, SIZE);
  state.money = 1e9;
  const bandY = [6, 11, 16, 21, 26, 31, 36, 41];
  buildRoads(
    state,
    Array.from({ length: 36 }, (_, i) => at(2, 6 + i)),
  );
  for (const roadY of bandY) {
    const road = Array.from({ length: 41 }, (_, i) => at(3 + i, roadY));
    buildRoads(state, road);
  }
  for (const roadY of bandY) {
    buildPowerLines(
      state,
      Array.from({ length: 40 }, (_, i) => at(4 + i, roadY)),
    );
  }
  buildPowerLines(
    state,
    Array.from({ length: 36 }, (_, i) => at(3, 6 + i)),
  );
  for (let band = 0; band < bandY.length; band++) {
    const roadY = bandY[band];
    for (let i = 0; i < 40; i++) {
      const above = at(4 + i, roadY - 1);
      const below = at(4 + i, roadY + 1);
      if (band < 4 || band === 7) {
        state.layers.zone[above] = Zone.Residential;
        state.layers.zone[below] = Zone.Residential;
        state.layers.density[above] = 3;
        state.layers.density[below] = 3;
      } else if (band < 6) {
        state.layers.zone[above] = Zone.Commercial;
        state.layers.zone[below] = Zone.Retail;
        state.layers.density[above] = 3;
        state.layers.density[below] = 3;
      } else if (industry) {
        state.layers.zone[below] = Zone.Industrial;
        state.layers.density[below] = 2;
      }
    }
  }
  placePlant(state, at(1, 36), PlantType.LogisticsDepot);
  const plants: PlantType[] = [
    ...Array<PlantType>(8).fill(PlantType.WindTurbine),
    ...Array<PlantType>(8).fill(PlantType.SolarFarm),
    ...Array<PlantType>(6).fill(PlantType.Battery),
    PlantType.BiogasPlant,
    PlantType.HydrogenPlant,
  ];
  plants.forEach((plant, i) => {
    const y = bandY[i % 6];
    const x = 46 + 3 * Math.floor(i / 6);
    buildPowerLines(state, [at(44, y), at(45, y), at(x - 1, y)]);
    const result = placePlant(state, at(x, y), plant);
    if ('rejected' in result)
      console.log(`plant ${plant} at ${x},${y} rejected: ${result.rejected}`);
  });
  state.demandResponse.active = true;
  state.smartMeters.active = true;
  return state;
}

function run(seed: number, industry: boolean): void {
  const state = city(seed, industry);
  const start = state.money;
  let importCost = 0;
  let goodsFee = 0;
  let tax = 0;
  let shed = 0;
  let deficitTicks = 0;
  let happiness = 0;
  let localTours = 0;
  let importedTours = 0;
  const lines: string[] = [];
  for (let day = 0; day < DAYS; day++) {
    let dDeficit = 0;
    let dFee = 0;
    for (let t = 0; t < TICKS_PER_DAY; t++) {
      stepTick(state);
      const e = state.lastEnergy;
      importCost += state.lastEconomy.gridImportCost;
      dFee += state.lastGoodsImportCost;
      tax += state.lastEconomy.taxIncome;
      shed += e.shed;
      if (e.deficit > 0) dDeficit++;
      happiness += state.happiness;
    }
    goodsFee += dFee;
    deficitTicks += dDeficit;
    localTours += state.goods.lastDay.local;
    importedTours += state.goods.lastDay.imported;
    const d = state.lastDeliveries;
    lines.push(
      `day ${String(day).padStart(2)}  deficit ticks ${String(dDeficit).padStart(3)}  goods fee ${dFee.toFixed(0).padStart(5)}  shops supplied ${(d.suppliedShare * 100).toFixed(0).padStart(3)} %  local ${(d.localShare * 100).toFixed(0).padStart(3)} %  happiness ${state.happiness.toFixed(3)}  money ${(state.money - start).toFixed(0)}`,
    );
  }
  const ticks = DAYS * TICKS_PER_DAY;
  console.log(
    `\n=== seed ${seed} industry ${industry ? 'ON ' : 'OFF'} — ${state.lastDeliveries.factories} factories, coverage ${industryCoverage(state).toFixed(2)}, jobs/tile d2 ${BALANCE.growth.jobsByZoneAndDensity[Zone.Industrial][2]}, load d2 ${BALANCE.energy.consumptionByZoneAndDensity[Zone.Industrial][2]}, industrialShedShare ${BALANCE.demandResponse.industrialShedShare}, fee ${BALANCE.deliveries.importFeePerTour}, penalty ${BALANCE.happiness.industryPenaltyWeight}\n` +
      lines.join('\n') +
      `\nTOTAL deficit ticks ${deficitTicks}  grid import ${importCost.toFixed(0)}  goods fee ${goodsFee.toFixed(0)}  tax ${tax.toFixed(0)}  shed ${shed.toFixed(0)}  tours local/imported ${localTours}/${importedTours}  mean happiness ${(happiness / ticks).toFixed(3)}  net money ${(state.money - start).toFixed(0)}`,
  );
}

describe('industrial probe', () => {
  it('prints 20 days with and without the factory band', () => {
    for (const seed of [7, 11]) {
      run(seed, false);
      run(seed, true);
    }
  }, 600_000);
});
```

If `placePlant` returns its rejection under another property name,
adapt the log line; every plant and the depot must land, or the runs
are not comparable. If the depot at (1, 36) is rejected (off-grid or
unbuildable), use (1, 35) and re-run.

- [ ] **Step 2: Run the probe**

Run: `pnpm vitest run src/sim/_industrialProbe.test.ts --reporter=verbose 2>&1 | tee /tmp/industrial-probe.txt`
(Use the session scratch directory instead of `/tmp` when one is given.)

- [ ] **Step 3: Judge and adjust**

Targets, over 20 days and both seeds:

- **Goods loop works:** industry ON has `imported` tours ≈ 0 and
  `local` > 0 from day 1; shops supplied share stays ≥ 95 %. If
  imports persist with factories present, the depot or the pickup is
  out of reach — fix the town, not the balance.
- **Industry pays off, slowly:** the fee avoided (goods fee OFF minus
  ON) plus the tax from the 40 factories (tax ON minus tax OFF) should
  recover a 40-tile zoning spend (`BALANCE.costs.zonePerTile × 40`)
  within roughly 10-20 days, not 2. Move `importFeePerTour` first; it is
  the lever with no side effects.
- **Night pool bites:** with industry ON the deficit ticks fall by a
  clearly larger share than the 8-10 % the pure business pool managed
  (target 15 % or more on both seeds) — otherwise raise
  `industrialShedShare` to 0.7; if deficits actually rise, the band's
  load outweighs its pool: lower `consumptionByZoneAndDensity[Industrial]`
  one notch (`[0, 3.5, 8, 14]`) rather than the share.
- **Nuisance is a decision, not a wall:** the residential band at
  y = 41 is fully within radius 4 of the factory band, so coverage is
  that band's share of all homes (≈ 1/5). Mean happiness ON should be
  0.015-0.03 below OFF. Outside that, move `industryPenaltyWeight`
  (0.08-0.14); leave the radius at 4.

Change values in `BALANCE` only, re-run after each change, and keep the
final figures. Then write the measurement comments on the six values
(one paragraph each in the style of the `demandResponse.shedShare`
block: what was measured, what alternatives did). If
`goalLocalMinShops/Factories` move, update both `goal.localGoods.body`
strings.

- [ ] **Step 4: Record results, amend the spec, mark the backlog**

- Spec Testing section, under the probe paragraph, add a "Done"
  paragraph with per-seed totals (deficit ticks ON/OFF, grid import
  ON/OFF, goods fee ON/OFF, tax ON/OFF, tours local/imported, mean
  happiness ON/OFF) and the frozen values.
- Spec Deliveries section: replace the sentence "Saved as the optional
  field `goods`, absent → zeros." with "Transient, like the other
  single-day goal counters (the `goalProgress` rule in `state.ts`); a
  reload mid-day forfeits that day's `localGoods` attempt." and
  describe the `lastDay` snapshot: "At the day boundary
  `deliveriesStep` copies the day's two counters into `goods.lastDay`
  and zeros them; `goalsStep` reads `lastDay` on the same tick."
- Spec Agent section: drop the `energy_report` bullet — the pool
  already reaches agents through `shedPool` in the overview.
- `docs/idea.md`: after the **Demand response** entry, before
  **Per-district grids**, add:

```
- **Industrial zone** (done): factories grow with the retail jobs they
  stock, employ fewer people per tile than offices, run a two-shift
  load that is the grid's only real night-time draw and shed a larger
  share of it under the demand-response contract. Delivery vans load
  at a powered factory in reach before their shop leg; a depot without
  one imports the goods and pays a fee per tour. Homes within a few
  tiles of a factory are less happy, so placement is a decision. The
  `localGoods` goal rewards a day in which every tour loaded locally.
  Probe: <one sentence with the measured deficit-tick and fee figures>.
```

Also change the Demand response entry's last sentences ("A bigger
pool or an industrial zone is the next lever…") to "The industrial
zone (below) is that bigger pool."

- [ ] **Step 5: Delete the probe and verify**

```bash
rm src/sim/_industrialProbe.test.ts
pnpm format && pnpm typecheck && pnpm lint && pnpm coverage && node scripts/smoke.mjs
```

Expected: all PASS, coverage ≥ 90 % on `src/sim` + `src/shared`.

- [ ] **Step 6: Commit**

```bash
git add src/shared/constants.ts src/ui/i18n.tsx docs/superpowers/specs/2026-10-05-industrial-zone-design.md docs/idea.md
git commit -m "balance: freeze the industrial zone from a headless probe; docs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Finish the branch

- [ ] **Step 1: Full verification**

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm coverage && pnpm build && node scripts/smoke.mjs
```

Expected: all PASS.

- [ ] **Step 2: Review the diff against the spec**

`git diff main...feat/industrial-zone --stat` and skim: every file in
the File map is touched; no debug output; no leftover probe; every new
i18n key appears twice (`grep -c "'tool.zone-industrial'" src/ui/i18n.tsx`
→ 2, likewise for each key in Task 5); `docs/agent-tools.md` lists
`industrial` and `factory`.

- [ ] **Step 3: Merge**

Merge `origin/main` into the branch first if the Mac pushed anything
(see the memory note: the sandbox has no remote access, so ask the
user if unsure), then:

```bash
git checkout main && git merge --ff-only feat/industrial-zone
```

Stop after the merge and report; the user pushes from the Mac and runs
`pnpm e2e` plus the visual check of the factory meshes there.
