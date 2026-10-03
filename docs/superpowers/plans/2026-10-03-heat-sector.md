# Heat Sector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Voltopia district heating: a heat-pump plant whose network
follows the roads, a hot-water store the surplus cascade fills before
exporting, and fallback to each building's own electric heating when the
network falls short.

**Architecture:** One new sim module `src/sim/heat.ts` owns the COP
curve, the derived `heated` tile layer (plain road-hop BFS from every
energised heat plant) and `heatStep`, which serves the network's heat
from the store first, then from the pumps at the current COP, and
reports what fell back. `energyStep` consumes that result as an input
next to `chargingDemand`: served buildings leave `heatingDemand`, the
pumps' electricity joins `totalDemand`, and one new step in the surplus
cascade (after pumped storage, before export) pushes surplus into the
store through the pumps. Two new `PlantType`s, one new optional save
field, one overlay, two build tools, one goal, agent tools.

**Tech Stack:** TypeScript (strict), Vitest, React 19, three.js, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-03-heat-sector-design.md`

## Global Constraints

- `src/sim/` stays pure: no DOM, no three.js imports. No randomness is
  needed anywhere in this feature; nothing reads `state.rng`.
- No magic numbers in sim code: every tuning value lives in
  `BALANCE.heat` (`src/shared/constants.ts`), costs in
  `BALANCE.costs.plant`, upkeep in `BALANCE.upkeepPerTick.plant`.
- `SAVE_VERSION` stays **1**. `heatStored` and `warmWinterTicks` are
  optional save fields; a save without them loads with an empty tank and
  a zero streak. The `heated` layer is derived every tick and never
  persisted.
- Every user-visible string goes through `src/ui/i18n.tsx` in **both**
  English and German (`de` is typed `Record<TranslationKey, string>`, so
  a missing German key fails `pnpm typecheck`).
- One heat unit equals the electricity a resistive heater would have
  used: a served building's heat demand is exactly today's
  `heatingConsumption(zone, density, temperature, insulation)`.
- Heat never converts back to electricity. The deficit branch of
  `energyStep` does not change.
- The network is hop-counted over road tiles with `neighbors4`; it never
  reads `roadDistances`, `trafficLoad` or `roadClass`.
- Coverage gate ≥ 90 % on `src/sim` + `src/shared` (`pnpm coverage`).
- Every new `InstancedMesh` sets `frustumCulled = false` (none is
  planned; the plant meshes reuse `plantsMesh.ts`'s existing instancing).
- Run `pnpm format` (oxfmt) after edits; the pre-commit hook runs
  `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`. Never
  `--no-verify`.
- Agent parity (CLAUDE.md): new plant types appear in `src/agent/tools.ts`
  (`PLANT_NAMES`, tool descriptions, catalog, map glyphs) and in
  `docs/agent-tools.md`.
- Commit messages: imperative summary + short body, one task per commit,
  ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## File Structure

| File                                                                                                                                             | Responsibility                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/sim/heat.ts` (new)                                                                                                                          | COP curve, `plantReach`, `recomputeHeated`, `heatStep`, `chargeHeatStore`, `nightNeedsHeat`, `IDLE_HEAT`. The only module that knows heat.                                                   |
| `src/sim/heat.test.ts` (new)                                                                                                                     | Unit tests for everything in `heat.ts`, plus determinism and save round trip of the heat state.                                                                                              |
| `src/shared/types.ts`                                                                                                                            | `PlantType.HeatPlant/HeatStore`, `HEATED_*` constants, `TileDiff.heated`, `EnergyStats` heat fields, `TileInfo.heated/heatPlant`, `SaveGame.heatStored/warmWinterTicks`, `OverlayMode.Heat`. |
| `src/shared/constants.ts`                                                                                                                        | `BALANCE.heat`, costs and upkeep rows.                                                                                                                                                       |
| `src/sim/state.ts`                                                                                                                               | `layers.heated`, `state.heatStored`, `lastEnergy` heat fields, `goalProgress.warmWinterTicks`, diff/serialize/deserialize, `totalHeatCapacity`.                                              |
| `src/sim/energy.ts`                                                                                                                              | Census rows, `EnergyTickInput.heat`, served buildings leave `heatingDemand`, pump power in `totalDemand`, store charging in the cascade, `lastEnergy` writes.                                |
| `src/sim/tick.ts`                                                                                                                                | `heatStep` before `energyStep`; lifetime sums; `buildStats` heat fields.                                                                                                                     |
| `src/sim/goals.ts`                                                                                                                               | `warmWinter`.                                                                                                                                                                                |
| `src/sim/inspect.ts`                                                                                                                             | `heated`, `heatPlant` block, heat store share.                                                                                                                                               |
| `src/storage/serialization.ts`                                                                                                                   | JSON export/import of the two optional fields.                                                                                                                                               |
| `src/ui/useTools.ts`, `BuildBar.tsx`, `EnergyPanel.tsx`, `TileInspector.tsx`, `BudgetPanel.tsx`, `OverlayToggle.tsx`, `HelpPage.tsx`, `i18n.tsx` | Player surface.                                                                                                                                                                              |
| `src/render/overlays.ts`, `plantsMesh.ts`, `minimapLayer.ts`                                                                                     | Heat overlay, plant shapes, minimap colours.                                                                                                                                                 |
| `src/agent/tools.ts`, `docs/agent-tools.md`                                                                                                      | Agent parity.                                                                                                                                                                                |
| `docs/idea.md`, `docs/superpowers/specs/2026-10-03-heat-sector-design.md`                                                                        | Backlog entry marked done; spec's save section amended for `warmWinterTicks`.                                                                                                                |

---

### Task 1: Plant types, balance block, state and save field

**Files:**

- Modify: `src/shared/types.ts` (`PlantType` at line 39, `PlantCensus` is in energy.ts, `EnergyStats` ~line 160, `TileDiff` ~line 585, `SaveGame` ~line 642)
- Modify: `src/shared/constants.ts` (`costs.plant` ~line 72, `upkeepPerTick.plant` ~line 103, new `heat` block after `hydrogen` ~line 274)
- Modify: `src/sim/state.ts` (`TileLayers` ~line 194, `SimState` ~line 233, `createTileLayers` ~line 385, `createSimState` ~line 417, `lastEnergy` ~line 336 and ~line 490, `goalProgress` ~line 301/450, `collectDiffs` ~line 564, `serializeState` ~line 816, `deserializeState` ~line 873, `totalHydrogenCapacity` ~line 995)
- Modify: `src/sim/energy.ts` (`PlantCensus` ~line 82, `censusPlants` ~line 110)
- Modify: `src/storage/serialization.ts` (`SaveGameJson` ~line 5, `saveToJson` ~line 70, `saveFromJson` ~line 209)
- Modify: `src/ui/i18n.tsx` (tool names ~line 67 EN, ~line 568 DE)
- Modify: `src/ui/TileInspector.tsx:30-47`, `src/ui/BudgetPanel.tsx:17-34` (`PLANT_LABEL` maps are `Record<PlantType, …>`, so typecheck forces the two new rows)
- Modify: `src/render/minimapLayer.ts:30-44`
- Test: `src/sim/state.test.ts`, `src/storage/serialization.test.ts`, `src/sim/energy.test.ts`

**Interfaces:**

- Produces: `PlantType.HeatPlant = 16`, `PlantType.HeatStore = 17`;
  `HEATED_NONE = 0`, `HEATED_TRUNK = 1`, `HEATED_SERVED = 2` (in
  `src/shared/types.ts`); `BALANCE.heat` with keys `reachHops`,
  `copWarmTemperature`, `copWarm`, `copColdTemperature`, `copCold`,
  `pumpPowerLimit`, `storeCapacity`, `storeDischargeLimit`,
  `storeLossPerTick`; `state.layers.heated: Uint8Array`;
  `state.heatStored: number`; `state.goalProgress.warmWinterTicks`;
  `state.lastEnergy.{heatPumpConsumption, networkHeat, heatFallback,
heatStoreCharge, heatCop}`; `PlantCensus.{heatPlants, heatStores}`;
  `totalHeatCapacity(state): number`; `TileDiff.heated`;
  `SaveGame.heatStored?`, `SaveGame.warmWinterTicks?`; `EnergyStats`
  gains `consumption.heatPumps`, `networkHeat`, `heatFallback`,
  `heatStoreCharge`, `heatStored`, `heatCapacity`, `heatCop`.

- [ ] **Step 1: Write the failing tests**

Append to `src/sim/state.test.ts` (inside the existing top-level
`describe` that owns "persists season origin, snowpack and insulation";
`makeState`, `serializeState`, `deserializeState` are already imported
there):

```ts
it('persists the heat store and the warm-winter streak', () => {
  const state = makeState();
  state.heatStored = 777;
  state.goalProgress.warmWinterTicks = 42;
  const restored = deserializeState(serializeState(state));
  expect(restored.heatStored).toBe(777);
  expect(restored.goalProgress.warmWinterTicks).toBe(42);
});

it('loads a save without heat fields as an empty tank and a zero streak', () => {
  const state = makeState();
  const save = serializeState(state);
  delete save.heatStored;
  delete save.warmWinterTicks;
  const restored = deserializeState(save);
  expect(restored.heatStored).toBe(0);
  expect(restored.goalProgress.warmWinterTicks).toBe(0);
});
```

Append to `src/storage/serialization.test.ts` next to "round-trips the
stored hydrogen":

```ts
it('round-trips the heat store and the warm-winter streak', () => {
  const save = makeSave();
  save.heatStored = 321;
  save.warmWinterTicks = 7;
  const restored = saveFromJson(saveToJson(save));
  expect(restored.heatStored).toBe(321);
  expect(restored.warmWinterTicks).toBe(7);
});
```

Append to `src/sim/energy.test.ts` (uses the file's `makeState`, `at`,
`placePlant`, `censusPlants`; add `isSupplySource` to the import from
`./powerGrid.ts` — add that import line if the file does not have it:
`import { isSupplySource } from './powerGrid.ts';`):

```ts
describe('heat plants', () => {
  it('census counts heat plants and heat stores, and neither feeds the grid', () => {
    const state = makeState();
    state.money = 1e9;
    placePlant(state, at(5, 5), PlantType.HeatPlant);
    placePlant(state, at(6, 5), PlantType.HeatStore);
    placePlant(state, at(7, 5), PlantType.HeatStore);
    const census = censusPlants(state);
    expect(census.heatPlants).toBe(1);
    expect(census.heatStores).toBe(2);
    expect(isSupplySource(PlantType.HeatPlant)).toBe(false);
    expect(isSupplySource(PlantType.HeatStore)).toBe(false);
  });

  it('a damaged heat store leaves the census', () => {
    const state = makeState();
    state.money = 1e9;
    placePlant(state, at(5, 5), PlantType.HeatStore);
    state.layers.damage[at(5, 5)] = 10;
    expect(censusPlants(state).heatStores).toBe(0);
  });

  it('charges the listed cost for both heat plants', () => {
    const state = makeState();
    const before = state.money;
    placePlant(state, at(5, 5), PlantType.HeatPlant);
    expect(state.money).toBe(before - BALANCE.costs.plant[PlantType.HeatPlant]);
    placePlant(state, at(6, 5), PlantType.HeatStore);
    expect(state.money).toBe(
      before - BALANCE.costs.plant[PlantType.HeatPlant] - BALANCE.costs.plant[PlantType.HeatStore],
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/sim/state.test.ts src/storage/serialization.test.ts src/sim/energy.test.ts`
Expected: FAIL — `PlantType.HeatPlant` is undefined, `heatStored` is not a property, `heatPlants` is undefined.

- [ ] **Step 3: Add the types**

In `src/shared/types.ts`, extend `PlantType`:

```ts
  GeothermalPlant: 15,
  /** District-heating plant: a large heat pump feeding the road network. */
  HeatPlant: 16,
  /** Hot-water store charged through the heat plants from surplus. */
  HeatStore: 17,
} as const;
```

Right after `SERVICE_POLICE` (~line 584) add the heated layer values:

```ts
/** Values of `TileDiff.heated` / `layers.heated`. */
export const HEATED_NONE = 0;
/** A road tile the district-heating network reaches. */
export const HEATED_TRUNK = 1;
/** A building tile the network heats. */
export const HEATED_SERVED = 2;
```

In `TileDiff`, after `services: number;`:

```ts
/** District heating: 0 = none, 1 = network road (trunk), 2 = served building. */
heated: number;
```

In `EnergyStats.consumption`, after `electrolysis`:

```ts
/** Electricity the district-heating pumps drew (serving plus charging the store). */
heatPumps: number;
```

In `EnergyStats`, after `hydrogenSold: number;`:

```ts
/** Heat units delivered to served buildings this tick (store plus pumps). */
networkHeat: number;
/** Heat units the network could not deliver; those buildings heated themselves. */
heatFallback: number;
/** Electricity absorbed into the heat store this tick. */
heatStoreCharge: number;
/** Heat units in the pooled hot-water store. */
heatStored: number;
/** Installed heat store capacity (heat units). */
heatCapacity: number;
/** Heat pump coefficient of performance in force this tick. */
heatCop: number;
```

In `SaveGame`, after `transitTicks?: number;`:

```ts
  /** Heat units in the district-heating store (absent in older saves → 0). */
  heatStored?: number;
  /** Consecutive warm-winter ticks so far (absent in older saves → 0). */
  warmWinterTicks?: number;
```

- [ ] **Step 4: Add the balance block, costs and upkeep**

In `src/shared/constants.ts`, after the `hydrogen` block:

```ts
  heat: {
    /**
     * District heating. A heat plant is a large heat pump that injects
     * heat into the road network; a heat store is a hot-water tank the
     * surplus cascade fills through the pumps. Heat never turns back
     * into electricity, so the store is a one-way flexible load.
     */
    /** Road tiles (4-neighbour hops) the network extends from a plant. */
    reachHops: 12,
    /** At or above this °C the COP is copWarm. */
    copWarmTemperature: 10,
    /** Heat units per electricity unit in mild weather. */
    copWarm: 3.5,
    /** At or below this °C the COP is copCold. */
    copColdTemperature: -10,
    /** COP in deep cold. */
    copCold: 1.8,
    /** Electricity one plant can draw per tick (serving plus charging). */
    pumpPowerLimit: 60,
    /** Heat units one store holds. */
    storeCapacity: 6_000,
    /** Heat units one store releases per tick. */
    storeDischargeLimit: 150,
    /** Share of the stored heat lost per tick (~38 % left after two in-game days). */
    storeLossPerTick: 0.0005,
  },
```

In `costs.plant`, after the geothermal row:

```ts
      /** A large heat pump plus the street mains: priced near a geothermal well. */
      [PlantType.HeatPlant]: 2_800,
      /** A hot-water tank: cheap capacity, but it only holds heat. */
      [PlantType.HeatStore]: 1_600,
```

In `upkeepPerTick.plant`, after the geothermal row:

```ts
      [PlantType.HeatPlant]: 0.06,
      [PlantType.HeatStore]: 0.03,
```

- [ ] **Step 5: Add the state fields**

In `src/sim/state.ts`:

`TileLayers`, after `services: Uint8Array;`:

```ts
/** District heating: HEATED_NONE / HEATED_TRUNK / HEATED_SERVED. Derived, not persisted. */
heated: Uint8Array;
```

`SimState`, after `hydrogenEnergy: number;`:

```ts
/** Heat units in the pooled district-heating store (fourth pool; never re-electrified). */
heatStored: number;
```

`SimState.lastEnergy`, after `hydrogenSold: number;`:

```ts
/** Electricity the heat pumps drew this tick (serving plus charging). */
heatPumpConsumption: number;
/** Heat units delivered to served buildings this tick. */
networkHeat: number;
/** Heat units that fell back to the buildings' own electric heating. */
heatFallback: number;
/** Electricity absorbed into the heat store this tick. */
heatStoreCharge: number;
/** Heat pump COP in force this tick. */
heatCop: number;
```

`SimState.goalProgress`, after `stormTicks: number;`:

```ts
warmWinterTicks: number;
```

`createTileLayers`, after `services: new Uint8Array(tiles),`:

```ts
    heated: new Uint8Array(tiles),
```

`createSimState`: after `hydrogenEnergy: 0,` add `heatStored: 0,`; in
the `lastEnergy` literal after `hydrogenSold: 0,` add
`heatPumpConsumption: 0, networkHeat: 0, heatFallback: 0, heatStoreCharge: 0, heatCop: 1,`;
in `goalProgress` after `stormTicks: 0,` add `warmWinterTicks: 0,`.

`collectDiffs`, after `services: layers.services[index],`:

```ts
      heated: layers.heated[index],
```

`serializeState`, after `transitTicks: state.goalProgress.transitTicks,`:

```ts
    heatStored: state.heatStored,
    warmWinterTicks: state.goalProgress.warmWinterTicks,
```

`deserializeState`, after `state.hydrogenEnergy = save.hydrogenEnergy ?? 0;`:

```ts
state.heatStored = save.heatStored ?? 0;
```

and after `state.goalProgress.transitTicks = save.transitTicks ?? 0;`:

```ts
state.goalProgress.warmWinterTicks = save.warmWinterTicks ?? 0;
```

After `totalHydrogenCapacity`:

```ts
/** Installed heat store capacity (heat units); damaged stores do not count. */
export function totalHeatCapacity(state: SimState): number {
  const { tileType, plantType, damage } = state.layers;
  let stores = 0;
  for (let i = 0; i < tileType.length; i++) {
    if (tileType[i] !== TileType.Plant || damage[i] !== 0) continue;
    if (plantType[i] === PlantType.HeatStore) stores++;
  }
  return stores * BALANCE.heat.storeCapacity;
}
```

- [ ] **Step 6: Add the census rows**

In `src/sim/energy.ts`, `PlantCensus` gains:

```ts
heatPlants: number;
heatStores: number;
```

`censusPlants` initialises `heatPlants: 0, heatStores: 0,` and the
switch gains:

```ts
      case PlantType.HeatPlant:
        census.heatPlants++;
        break;
      case PlantType.HeatStore:
        census.heatStores++;
        break;
```

`SUPPLY_SOURCES` in `src/sim/powerGrid.ts` is **not** touched: both
plants consume.

- [ ] **Step 7: JSON export/import**

In `src/storage/serialization.ts`, `SaveGameJson` gains
`heatStored?: number; warmWinterTicks?: number;`. In `saveToJson` after
the `transitTicks` spread:

```ts
    ...(save.heatStored !== undefined ? { heatStored: save.heatStored } : {}),
    ...(save.warmWinterTicks !== undefined ? { warmWinterTicks: save.warmWinterTicks } : {}),
```

In `saveFromJson` after the `transitTicks` spread:

```ts
    ...(typeof parsed.heatStored === 'number' ? { heatStored: parsed.heatStored } : {}),
    ...(typeof parsed.warmWinterTicks === 'number'
      ? { warmWinterTicks: parsed.warmWinterTicks }
      : {}),
```

- [ ] **Step 8: Labels the type system demands**

`src/ui/i18n.tsx`, EN after `'tool.plant-geothermal': 'Geothermal plant',`:

```ts
  'tool.plant-heat': 'Heat plant',
  'tool.plant-heatstore': 'Heat store',
```

DE after `'tool.plant-geothermal': 'Geothermiekraftwerk',`:

```ts
  'tool.plant-heat': 'Heizwerk',
  'tool.plant-heatstore': 'Wärmespeicher',
```

`src/ui/TileInspector.tsx` and `src/ui/BudgetPanel.tsx`, in each
`PLANT_LABEL` after the geothermal row:

```ts
  [PlantType.HeatPlant]: 'tool.plant-heat',
  [PlantType.HeatStore]: 'tool.plant-heatstore',
```

`src/render/minimapLayer.ts`, after the geothermal colour:

```ts
    [PlantType.HeatPlant]: '#d9822b',
    [PlantType.HeatStore]: '#c9a227',
```

- [ ] **Step 9: Typecheck, run the tests**

Run: `pnpm typecheck && pnpm vitest run src/sim/state.test.ts src/storage/serialization.test.ts src/sim/energy.test.ts`
Expected: typecheck clean (it will name any `Record<PlantType, …>` you missed — fix them), all three files PASS.

- [ ] **Step 10: Format and commit**

```bash
pnpm format
git add -A
git commit -m "feat(sim): heat plant and heat store types, balance and save field

Two new PlantTypes, the BALANCE.heat block, a derived heated tile layer,
a pooled heatStored field (optional in saves), census rows and the
labels the Record<PlantType> maps demand. No behaviour yet.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The COP curve and the heated layer

**Files:**

- Create: `src/sim/heat.ts`
- Create: `src/sim/heat.test.ts`

**Interfaces:**

- Consumes: `BALANCE.heat`, `HEATED_*`, `PlantType.HeatPlant`,
  `recomputeGrid` (`./powerGrid.ts`), `neighbors4` (`../shared/grid.ts`),
  `markDirty`, `TileType`, `SimState` (`./state.ts`).
- Produces:
  - `heatPumpCop(temperature: number): number`
  - `plantReach(state: SimState, plant: number): number[]` — trunk road
    tiles reached from one heat plant tile (empty when the plant has no
    adjacent road); does not check energised/damage.
  - `recomputeHeated(state: SimState): void` — rebuilds `layers.heated`
    from every energised, undamaged heat plant and marks changed tiles
    dirty.

- [ ] **Step 1: Write the failing tests**

Create `src/sim/heat.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BALANCE } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { HEATED_NONE, HEATED_SERVED, HEATED_TRUNK } from '../shared/types.ts';
import { placePlant } from './energy.ts';
import { heatPumpCop, plantReach, recomputeHeated } from './heat.ts';
import { buildRoads } from './roads.ts';
import { createSimState, PlantType, TileType, Zone, type SimState } from './state.ts';

const SIZE = 48;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);

function freshState(): SimState {
  const state = createSimState(1, SIZE);
  state.money = 1e9;
  return state;
}

/** A road running east from (x0, y) for `length` tiles. */
function roadEast(state: SimState, x0: number, y: number, length: number): void {
  buildRoads(
    state,
    Array.from({ length }, (_, i) => at(x0 + i, y)),
  );
}

/** A heat plant at (x, y), energised by a wind turbine ring south of it. */
function poweredHeatPlant(state: SimState, x: number, y: number): void {
  placePlant(state, at(x, y), PlantType.HeatPlant);
  placePlant(state, at(x, y + 2), PlantType.WindTurbine);
}

function building(state: SimState, x: number, y: number, density = 1): void {
  state.layers.zone[at(x, y)] = Zone.Residential;
  state.layers.density[at(x, y)] = density;
}

describe('heatPumpCop', () => {
  const cfg = BALANCE.heat;

  it('is copWarm at and above the warm temperature', () => {
    expect(heatPumpCop(cfg.copWarmTemperature)).toBe(cfg.copWarm);
    expect(heatPumpCop(cfg.copWarmTemperature + 30)).toBe(cfg.copWarm);
  });

  it('is copCold at and below the cold temperature', () => {
    expect(heatPumpCop(cfg.copColdTemperature)).toBe(cfg.copCold);
    expect(heatPumpCop(cfg.copColdTemperature - 30)).toBe(cfg.copCold);
  });

  it('is linear and monotone in between', () => {
    const mid = (cfg.copWarmTemperature + cfg.copColdTemperature) / 2;
    expect(heatPumpCop(mid)).toBeCloseTo((cfg.copWarm + cfg.copCold) / 2, 6);
    expect(heatPumpCop(mid + 1)).toBeGreaterThan(heatPumpCop(mid));
  });
});

describe('plantReach', () => {
  it('reaches reachHops road tiles from the plant and not one more', () => {
    const state = freshState();
    // Plant at (2, 10); the road starts right next to it at (3, 10).
    roadEast(state, 3, 10, 30);
    placePlant(state, at(2, 10), PlantType.HeatPlant);
    const reach = new Set(plantReach(state, at(2, 10)));
    const hops = BALANCE.heat.reachHops;
    expect(reach.has(at(3, 10))).toBe(true);
    expect(reach.has(at(3 + hops - 1, 10))).toBe(true);
    expect(reach.has(at(3 + hops, 10))).toBe(false);
    expect(reach.size).toBe(hops);
  });

  it('is empty for a plant with no adjacent road', () => {
    const state = freshState();
    roadEast(state, 10, 10, 5);
    placePlant(state, at(2, 2), PlantType.HeatPlant);
    expect(plantReach(state, at(2, 2))).toEqual([]);
  });
});

describe('recomputeHeated', () => {
  it('marks reached roads as trunk and road-adjacent buildings as served', () => {
    const state = freshState();
    roadEast(state, 3, 10, 30);
    poweredHeatPlant(state, 2, 10);
    building(state, 5, 9); // north of the road, within reach
    building(state, 5, 11); // south of the road, within reach
    building(state, 3 + BALANCE.heat.reachHops + 2, 9); // beyond reach
    recomputeHeated(state);
    const { heated } = state.layers;
    expect(heated[at(3, 10)]).toBe(HEATED_TRUNK);
    expect(heated[at(5, 9)]).toBe(HEATED_SERVED);
    expect(heated[at(5, 11)]).toBe(HEATED_SERVED);
    expect(heated[at(3 + BALANCE.heat.reachHops + 2, 9)]).toBe(HEATED_NONE);
    expect(heated[at(2, 10)]).toBe(HEATED_NONE); // the plant tile itself
  });

  it('two plants union their reach', () => {
    const state = freshState();
    roadEast(state, 3, 10, 40);
    poweredHeatPlant(state, 2, 10);
    poweredHeatPlant(state, 30, 11); // its road neighbour is (30, 10)
    recomputeHeated(state);
    expect(state.layers.heated[at(3, 10)]).toBe(HEATED_TRUNK);
    expect(state.layers.heated[at(30, 10)]).toBe(HEATED_TRUNK);
    // (17,10) is 14 hops from the first plant's road and 13 from the second's.
    expect(state.layers.heated[at(17, 10)]).toBe(HEATED_NONE);
  });

  it('an unpowered plant reaches nothing', () => {
    const state = freshState();
    roadEast(state, 3, 10, 10);
    placePlant(state, at(2, 10), PlantType.HeatPlant); // no turbine, no lines
    building(state, 4, 9);
    recomputeHeated(state);
    expect(state.layers.heated[at(3, 10)]).toBe(HEATED_NONE);
    expect(state.layers.heated[at(4, 9)]).toBe(HEATED_NONE);
  });

  it('a damaged plant drops out and returns once repaired', () => {
    const state = freshState();
    roadEast(state, 3, 10, 10);
    poweredHeatPlant(state, 2, 10);
    recomputeHeated(state);
    expect(state.layers.heated[at(3, 10)]).toBe(HEATED_TRUNK);
    state.layers.damage[at(2, 10)] = 50;
    recomputeHeated(state);
    expect(state.layers.heated[at(3, 10)]).toBe(HEATED_NONE);
    state.layers.damage[at(2, 10)] = 0;
    recomputeHeated(state);
    expect(state.layers.heated[at(3, 10)]).toBe(HEATED_TRUNK);
  });

  it('marks only changed tiles dirty', () => {
    const state = freshState();
    roadEast(state, 3, 10, 10);
    poweredHeatPlant(state, 2, 10);
    recomputeHeated(state);
    state.dirty.clear();
    recomputeHeated(state);
    expect(state.dirty.size).toBe(0);
    state.layers.tileType[at(2, 10)] = TileType.Empty;
    state.layers.plantType[at(2, 10)] = PlantType.None;
    state.gridVersion++;
    recomputeHeated(state);
    expect(state.dirty.has(at(3, 10))).toBe(true);
    expect(state.layers.heated[at(3, 10)]).toBe(HEATED_NONE);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/sim/heat.test.ts`
Expected: FAIL — cannot resolve `./heat.ts`.

- [ ] **Step 3: Write `src/sim/heat.ts`**

```ts
/**
 * District heating.
 *
 * A heat plant is a large heat pump that injects heat into the road
 * network next to it; the network reaches `reachHops` road tiles out and
 * serves every building standing beside one of them. A heat store is a
 * hot-water tank the surplus cascade fills through the pumps. Heat never
 * turns back into electricity: the store is a one-way flexible load that
 * eats surplus and shifts the heating peak off the evening.
 *
 * `layers.heated` is derived every tick from the energised, undamaged
 * plants; it is never persisted.
 */
import { BALANCE } from '../shared/constants.ts';
import { neighbors4 } from '../shared/grid.ts';
import { HEATED_SERVED, HEATED_TRUNK, PlantType } from '../shared/types.ts';
import { recomputeGrid } from './powerGrid.ts';
import { markDirty, TileType, type SimState } from './state.ts';

/**
 * Coefficient of performance of the heat pumps at an outdoor
 * temperature: `copWarm` at or above `copWarmTemperature`, `copCold` at
 * or below `copColdTemperature`, linear in between.
 */
export function heatPumpCop(temperature: number): number {
  const { copWarm, copCold, copWarmTemperature, copColdTemperature } = BALANCE.heat;
  if (temperature >= copWarmTemperature) return copWarm;
  if (temperature <= copColdTemperature) return copCold;
  const t = (temperature - copColdTemperature) / (copWarmTemperature - copColdTemperature);
  return copCold + (copWarm - copCold) * t;
}

/**
 * Road tiles the network reaches from one plant tile: a breadth-first
 * walk over 4-neighbour road tiles, at most `reachHops` deep, seeded by
 * the roads touching the plant. Plain hops, deliberately not
 * `roadDistances`: that prices avenues and traffic, and membership must
 * not flicker with the rush hour. Empty when no road touches the plant.
 */
export function plantReach(state: SimState, plant: number): number[] {
  const { tileType } = state.layers;
  const { size } = state;
  const maxHops = BALANCE.heat.reachHops;
  const hops = new Map<number, number>();
  const queue: number[] = [];
  for (const neighbor of neighbors4(plant, size)) {
    if (tileType[neighbor] !== TileType.Road || hops.has(neighbor)) continue;
    hops.set(neighbor, 1);
    queue.push(neighbor);
  }
  for (let head = 0; head < queue.length; head++) {
    const tile = queue[head];
    const depth = hops.get(tile)!;
    if (depth >= maxHops) continue;
    for (const neighbor of neighbors4(tile, size)) {
      if (tileType[neighbor] !== TileType.Road || hops.has(neighbor)) continue;
      hops.set(neighbor, depth + 1);
      queue.push(neighbor);
    }
  }
  return queue;
}

/**
 * Rebuild the heated layer from every heat plant that is connected to
 * the grid and intact. Tiles whose value changes are marked dirty so the
 * overlay and inspector follow. Deterministic; cost is plants × reach²
 * plus one pass over the grid, like the services layer.
 */
export function recomputeHeated(state: SimState): void {
  recomputeGrid(state);
  const { layers, size } = state;
  const next = new Uint8Array(layers.heated.length);
  for (let i = 0; i < layers.tileType.length; i++) {
    if (layers.tileType[i] !== TileType.Plant) continue;
    if (layers.plantType[i] !== PlantType.HeatPlant) continue;
    if (layers.energized[i] !== 1 || layers.damage[i] !== 0) continue;
    for (const road of plantReach(state, i)) next[road] = HEATED_TRUNK;
  }
  for (let i = 0; i < next.length; i++) {
    if (next[i] !== HEATED_TRUNK) continue;
    for (const neighbor of neighbors4(i, size)) {
      if (layers.tileType[neighbor] !== TileType.Empty || layers.density[neighbor] === 0) continue;
      next[neighbor] = HEATED_SERVED;
    }
  }
  for (let i = 0; i < next.length; i++) {
    if (next[i] === layers.heated[i]) continue;
    layers.heated[i] = next[i];
    markDirty(state, i);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/sim/heat.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Format and commit**

```bash
pnpm format
git add src/sim/heat.ts src/sim/heat.test.ts
git commit -m "feat(sim): heat pump COP and the district-heating reach

The COP falls linearly from copWarm to copCold with the outdoor
temperature. The heated layer is a plain road-hop BFS from every
energised, intact heat plant; buildings beside a reached road are
served. Hop-counted on purpose so membership never follows traffic.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `heatStep` — store first, pumps at COP, fallback

**Files:**

- Modify: `src/sim/heat.ts`
- Modify: `src/sim/heat.test.ts`

**Interfaces:**

- Consumes: `heatingConsumption` (`./energy.ts`), `censusPlants`
  (`./energy.ts`), `heatingDegree` (`./seasons.ts`), `Zone`.
- Produces:

  ```ts
  export interface HeatTickResult {
    /** Heat the served buildings wanted this tick. */
    demand: number;
    /** Heat the store released. */
    fromStore: number;
    /** Heat the pumps made. */
    pumpHeat: number;
    /** Electricity the pumps drew to make pumpHeat. */
    pumpPower: number;
    /** Heat nobody delivered; those buildings heat themselves electrically. */
    fallback: number;
    /** Pump electricity still available this tick for charging the store. */
    pumpPowerLeft: number;
    /** COP in force. */
    cop: number;
    /** Heat units the store can still take. */
    headroom: number;
    /** Installed store capacity. */
    capacity: number;
    /** fromStore + pumpHeat. */
    networkHeat: number;
  }
  export const IDLE_HEAT: HeatTickResult; // all zero, cop 1
  export function heatStep(state: SimState): HeatTickResult;
  export function nightNeedsHeat(temperature: number): boolean;
  export function chargeHeatStore(state: SimState, heat: HeatTickResult, surplus: number): number;
  ```

  `chargeHeatStore` returns the electricity absorbed and mutates
  `state.heatStored` and `heat.headroom`/`heat.pumpPowerLeft`.

- [ ] **Step 1: Write the failing tests**

Append to `src/sim/heat.test.ts` (extend the import from `./heat.ts`
with `chargeHeatStore, heatStep, IDLE_HEAT, nightNeedsHeat`, and add
`import { heatingConsumption } from './energy.ts';` — merge into the
existing `./energy.ts` import):

```ts
/**
 * One powered plant (two when `plants` is 2: the second at the east end
 * of the road), a 40-tile road, and `count` served residential buildings
 * of `density` on alternating sides of the road (x = 4 + floor(i / 2)).
 */
function village(state: SimState, count: number, density = 1, plants = 1): void {
  roadEast(state, 3, 10, 40); // x = 3..42
  poweredHeatPlant(state, 2, 10);
  if (plants === 2) poweredHeatPlant(state, 43, 10);
  for (let i = 0; i < count; i++) {
    building(state, 4 + Math.floor(i / 2), i % 2 === 0 ? 9 : 11, density);
  }
}

/** Heat demand of `count` residential buildings of `density` at `temperature`. */
function demandOf(state: SimState, count: number, temperature: number, density = 1): number {
  return count * heatingConsumption(Zone.Residential, density, temperature, state.insulation);
}

describe('heatStep', () => {
  it('serves demand from the pumps at the COP when the store is empty', () => {
    const state = freshState();
    village(state, 4);
    state.season = { ...state.season, temperature: 0 };
    const heat = heatStep(state);
    const demand = demandOf(state, 4, 0);
    expect(demand).toBeGreaterThan(0);
    expect(heat.demand).toBeCloseTo(demand, 6);
    expect(heat.fromStore).toBe(0);
    expect(heat.pumpHeat).toBeCloseTo(demand, 6);
    expect(heat.cop).toBeCloseTo(heatPumpCop(0), 6);
    expect(heat.pumpPower).toBeCloseTo(demand / heatPumpCop(0), 6);
    expect(heat.fallback).toBe(0);
    expect(heat.networkHeat).toBeCloseTo(demand, 6);
    expect(heat.pumpPowerLeft).toBeCloseTo(BALANCE.heat.pumpPowerLimit - heat.pumpPower, 6);
  });

  it('drains the store before running the pumps', () => {
    const state = freshState();
    village(state, 4);
    placePlant(state, at(2, 14), PlantType.HeatStore);
    state.season = { ...state.season, temperature: 0 };
    state.heatStored = 1_000;
    const heat = heatStep(state);
    expect(heat.fromStore).toBeCloseTo(heat.demand, 6);
    expect(heat.pumpHeat).toBe(0);
    expect(heat.pumpPower).toBe(0);
    // Loss applies after the discharge.
    expect(state.heatStored).toBeCloseTo(
      (1_000 - heat.demand) * (1 - BALANCE.heat.storeLossPerTick),
      6,
    );
  });

  it('honours the store discharge limit and lets the pumps cover the rest', () => {
    const state = freshState();
    // Two plants reach 46 of the 80 dense buildings (≈ 294 heat at full
    // cold), more than one store releases per tick.
    village(state, 80, 3, 2);
    placePlant(state, at(2, 14), PlantType.HeatStore);
    state.season = { ...state.season, temperature: -20 };
    state.heatStored = BALANCE.heat.storeCapacity;
    const heat = heatStep(state);
    expect(heat.demand).toBeGreaterThan(BALANCE.heat.storeDischargeLimit);
    expect(heat.fromStore).toBeCloseTo(BALANCE.heat.storeDischargeLimit, 6);
    expect(heat.pumpHeat).toBeCloseTo(heat.demand - BALANCE.heat.storeDischargeLimit, 6);
    expect(heat.fallback).toBe(0);
  });

  it('falls back past the pump limit when there is no store', () => {
    const state = freshState();
    village(state, 80, 3, 2);
    state.season = { ...state.season, temperature: -20 };
    const heat = heatStep(state);
    const cop = heatPumpCop(-20);
    const pumpLimit = 2 * BALANCE.heat.pumpPowerLimit;
    expect(heat.demand).toBeGreaterThan(pumpLimit * cop);
    expect(heat.fromStore).toBe(0);
    expect(heat.pumpHeat).toBeCloseTo(pumpLimit * cop, 6);
    expect(heat.pumpPower).toBeCloseTo(pumpLimit, 6);
    expect(heat.fallback).toBeCloseTo(heat.demand - heat.pumpHeat, 6);
    expect(heat.pumpPowerLeft).toBeCloseTo(0, 6);
  });

  it('clamps the store to the installed capacity and reports headroom', () => {
    const state = freshState();
    village(state, 0);
    placePlant(state, at(2, 14), PlantType.HeatStore);
    state.season = { ...state.season, temperature: 20 }; // no demand
    state.heatStored = BALANCE.heat.storeCapacity * 5;
    const heat = heatStep(state);
    expect(heat.capacity).toBe(BALANCE.heat.storeCapacity);
    expect(state.heatStored).toBeLessThanOrEqual(BALANCE.heat.storeCapacity);
    expect(heat.headroom).toBeCloseTo(BALANCE.heat.storeCapacity - state.heatStored, 6);
  });

  it('is idle without plants: no demand, full fallback for nobody', () => {
    const state = freshState();
    building(state, 5, 5);
    state.season = { ...state.season, temperature: -5 };
    const heat = heatStep(state);
    expect(heat).toMatchObject({ demand: 0, pumpPower: 0, fallback: 0, networkHeat: 0 });
  });
});

describe('nightNeedsHeat', () => {
  const { comfortTemperature } = BALANCE.seasons.heating;
  const swing = BALANCE.seasons.diurnalAmplitude;

  it('opens when the coming night drops below the comfort temperature', () => {
    expect(nightNeedsHeat(comfortTemperature + swing - 0.5)).toBe(true);
    expect(nightNeedsHeat(-5)).toBe(true);
  });

  it('closes on a warm day', () => {
    expect(nightNeedsHeat(comfortTemperature + swing)).toBe(false);
    expect(nightNeedsHeat(30)).toBe(false);
  });
});

describe('chargeHeatStore', () => {
  function storeState(temperature: number): { state: SimState; heat: ReturnType<typeof heatStep> } {
    const state = freshState();
    village(state, 0);
    placePlant(state, at(2, 14), PlantType.HeatStore);
    state.season = { ...state.season, temperature };
    return { state, heat: heatStep(state) };
  }

  it('stores cop heat units per electricity unit within pump power and headroom', () => {
    const { state, heat } = storeState(0);
    const absorbed = chargeHeatStore(state, heat, 20);
    expect(absorbed).toBeCloseTo(20, 6);
    expect(state.heatStored).toBeCloseTo(20 * heatPumpCop(0), 6);
    expect(heat.pumpPowerLeft).toBeCloseTo(BALANCE.heat.pumpPowerLimit - 20, 6);
  });

  it('is capped by the pump power left', () => {
    const { state, heat } = storeState(0);
    const absorbed = chargeHeatStore(state, heat, 10_000);
    expect(absorbed).toBeCloseTo(BALANCE.heat.pumpPowerLimit, 6);
  });

  it('is capped by the headroom', () => {
    const { state, heat } = storeState(0);
    state.heatStored = BALANCE.heat.storeCapacity - 7;
    heat.headroom = 7;
    const absorbed = chargeHeatStore(state, heat, 10_000);
    expect(absorbed).toBeCloseTo(7 / heatPumpCop(0), 6);
    expect(state.heatStored).toBeCloseTo(BALANCE.heat.storeCapacity, 6);
  });

  it('does nothing while the nights are warm', () => {
    const { state, heat } = storeState(30);
    expect(chargeHeatStore(state, heat, 100)).toBe(0);
    expect(state.heatStored).toBe(0);
  });

  it('does nothing without a plant to pump with', () => {
    const state = freshState();
    placePlant(state, at(2, 14), PlantType.HeatStore);
    state.season = { ...state.season, temperature: 0 };
    const heat = heatStep(state);
    expect(chargeHeatStore(state, heat, 100)).toBe(0);
  });

  it('IDLE_HEAT absorbs nothing', () => {
    const state = freshState();
    expect(chargeHeatStore(state, { ...IDLE_HEAT }, 100)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/sim/heat.test.ts`
Expected: FAIL — `heatStep` is not exported.

- [ ] **Step 3: Implement `heatStep`, `nightNeedsHeat`, `chargeHeatStore`**

Append to `src/sim/heat.ts` (and extend the imports: `censusPlants,
heatingConsumption` from `./energy.ts`, `heatingDegree` from
`./seasons.ts`, `Zone` from `../shared/types.ts`):

```ts
export interface HeatTickResult {
  /** Heat the served buildings wanted this tick. */
  demand: number;
  /** Heat the store released. */
  fromStore: number;
  /** Heat the pumps made. */
  pumpHeat: number;
  /** Electricity the pumps drew to make pumpHeat. */
  pumpPower: number;
  /** Heat nobody delivered; those buildings heat themselves electrically. */
  fallback: number;
  /** Pump electricity still available this tick for charging the store. */
  pumpPowerLeft: number;
  /** COP in force. */
  cop: number;
  /** Heat units the store can still take. */
  headroom: number;
  /** Installed store capacity (heat units). */
  capacity: number;
  /** fromStore + pumpHeat. */
  networkHeat: number;
}

/** The result of a tick without any district heating. */
export const IDLE_HEAT: Readonly<HeatTickResult> = Object.freeze({
  demand: 0,
  fromStore: 0,
  pumpHeat: 0,
  pumpPower: 0,
  fallback: 0,
  pumpPowerLeft: 0,
  cop: 1,
  headroom: 0,
  capacity: 0,
  networkHeat: 0,
});

/**
 * One tick of the heat balance, run before the energy balance:
 * rebuild the network, sum the served buildings' heat demand, cover it
 * from the store (within its discharge limit), then from the pumps at
 * the current COP (within their power limit); whatever is left falls
 * back to the buildings' own electric heating. The store then loses its
 * standing share. Charging happens later, in the surplus cascade.
 */
export function heatStep(state: SimState): HeatTickResult {
  recomputeHeated(state);
  const cfg = BALANCE.heat;
  const { layers } = state;
  const census = censusPlants(state);
  const capacity = census.heatStores * cfg.storeCapacity;
  state.heatStored = Math.min(state.heatStored, capacity);

  const temperature = state.season.temperature;
  let demand = 0;
  for (let i = 0; i < layers.heated.length; i++) {
    if (layers.heated[i] !== HEATED_SERVED) continue;
    demand += heatingConsumption(
      layers.zone[i] as Zone,
      layers.density[i],
      temperature,
      state.insulation,
    );
  }

  const cop = heatPumpCop(temperature);
  const fromStore = Math.min(demand, census.heatStores * cfg.storeDischargeLimit, state.heatStored);
  state.heatStored -= fromStore;
  const pumpPowerLimit = census.heatPlants * cfg.pumpPowerLimit;
  const pumpHeat = Math.min(demand - fromStore, pumpPowerLimit * cop);
  const pumpPower = pumpHeat / cop;
  const fallback = demand - fromStore - pumpHeat;
  state.heatStored *= 1 - cfg.storeLossPerTick;

  return {
    demand,
    fromStore,
    pumpHeat,
    pumpPower,
    fallback,
    pumpPowerLeft: pumpPowerLimit - pumpPower,
    cop,
    headroom: Math.max(0, capacity - state.heatStored),
    capacity,
    networkHeat: fromStore + pumpHeat,
  };
}

/**
 * The store only fills while the coming night will need heat: the
 * diurnal swing below the current temperature must still be a heating
 * degree. A summer surplus is exported, not boiled away.
 */
export function nightNeedsHeat(temperature: number): boolean {
  return heatingDegree(temperature - BALANCE.seasons.diurnalAmplitude) > 0;
}

/**
 * Push surplus electricity into the store through the pumps: one
 * electricity unit stores `cop` heat units, within the pump power left
 * after serving and within the headroom. Returns the electricity
 * absorbed; mutates the store and the result's remaining budgets.
 */
export function chargeHeatStore(state: SimState, heat: HeatTickResult, surplus: number): number {
  if (surplus <= 0 || heat.pumpPowerLeft <= 0 || heat.headroom <= 0) return 0;
  if (!nightNeedsHeat(state.season.temperature)) return 0;
  const absorbed = Math.max(0, Math.min(surplus, heat.pumpPowerLeft, heat.headroom / heat.cop));
  state.heatStored += absorbed * heat.cop;
  heat.headroom -= absorbed * heat.cop;
  heat.pumpPowerLeft -= absorbed;
  return absorbed;
}
```

`heatingConsumption` returns 0 for `density === 0` zones via the
consumption table, and served tiles always have `density > 0`, so no
extra guard is needed.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/sim/heat.test.ts`
Expected: PASS. If a plant's measured reach gives less demand than the
caps, report the measured demand rather than touching BALANCE.

- [ ] **Step 5: Format and commit**

```bash
pnpm format
git add src/sim/heat.ts src/sim/heat.test.ts
git commit -m "feat(sim): the heat balance — store first, pumps at COP, fallback

heatStep serves the network's heat from the store within its discharge
limit, then from the pumps within their power limit at the current COP,
and reports the rest as fallback. chargeHeatStore fills the tank from
surplus through the pumps, only while the coming night needs heat.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Wire heat into the energy balance, the tick and the stats

**Files:**

- Modify: `src/sim/energy.ts` (`EnergyTickInput` ~line 270, building loop ~line 342-366, surplus branch ~line 392-432, `lastEnergy` write ~line 517)
- Modify: `src/sim/tick.ts` (`stepTick` ~line 63, `recordLifetime` ~line 85-91, `buildStats` ~line 170-200)
- Test: `src/sim/energy.test.ts`, `src/sim/integration.test.ts`

**Interfaces:**

- Consumes: `heatStep`, `chargeHeatStore`, `IDLE_HEAT`, `HeatTickResult` (`./heat.ts`), `HEATED_SERVED`, `totalHeatCapacity`.
- Produces: `EnergyTickInput.heat?: HeatTickResult` (defaults to
  `IDLE_HEAT`); `state.lastEnergy.heatPumpConsumption / networkHeat /
heatFallback / heatStoreCharge / heatCop` are written every tick;
  `GlobalStats.energy` carries the seven heat fields.

- [ ] **Step 1: Write the failing tests**

Append to `src/sim/energy.test.ts` inside the `describe('heat plants')`
block from Task 1 (add `import { heatStep } from './heat.ts';` and
`import { HEATED_SERVED } from '../shared/types.ts';` — merge with
existing imports; `buildRoads` is already imported):

```ts
/**
 * Plant at (2,10) powered by a turbine at (2,12), a 20-tile road east
 * of the plant, `count` residential buildings of `density` on
 * alternating sides of the road (x = 4 + floor(i / 2)).
 */
function heatedVillage(state: SimState, count: number, density = 1): void {
  state.money = 1e9;
  buildRoads(
    state,
    Array.from({ length: 20 }, (_, i) => at(3 + i, 10)),
  );
  placePlant(state, at(2, 10), PlantType.HeatPlant);
  placePlant(state, at(2, 12), PlantType.WindTurbine);
  for (let i = 0; i < count; i++) {
    addBuilding(state, at(4 + Math.floor(i / 2), i % 2 === 0 ? 9 : 11), Zone.Residential, density);
  }
}

it('served buildings leave the heating load and the pumps draw heat ÷ COP instead', () => {
  const state = heatedVillageState(4);
  const cold = { ...state.season, temperature: 0 };
  state.season = cold;
  const heat = heatStep(state);
  expect(state.layers.heated[at(4, 9)]).toBe(HEATED_SERVED);
  energyStep(state, { chargingDemand: 0, heat });
  const e = state.lastEnergy;
  expect(e.heatingConsumption).toBeCloseTo(0, 6);
  expect(e.heatPumpConsumption).toBeCloseTo(heat.demand / heat.cop, 6);
  expect(e.networkHeat).toBeCloseTo(heat.demand, 6);
  expect(e.heatFallback).toBe(0);
  expect(e.heatCop).toBeCloseTo(heat.cop, 6);
});

it('fallback heat lands back on the heating load', () => {
  // 24 dense buildings at full cold ≈ 154 heat, beyond one plant's 60 × 1.8.
  const state = heatedVillageState(24, 3);
  state.season = { ...state.season, temperature: -20 };
  const heat = heatStep(state);
  expect(heat.fallback).toBeGreaterThan(0);
  energyStep(state, { chargingDemand: 0, heat });
  expect(state.lastEnergy.heatingConsumption).toBeCloseTo(heat.fallback, 6);
  expect(state.lastEnergy.heatFallback).toBeCloseTo(heat.fallback, 6);
});

it('charges the heat store after the batteries and before exporting', () => {
  const state = heatedVillageState(0);
  placePlant(state, at(2, 14), PlantType.HeatStore);
  placePlant(state, at(2, 16), PlantType.Battery);
  for (let i = 0; i < 3; i++) placePlant(state, at(5 + i, 14), PlantType.SolarFarm);
  setNoonClearSky(state);
  state.season = { ...state.season, temperature: 0 }; // cold: the night needs heat
  const heat = heatStep(state);
  energyStep(state, { chargingDemand: 0, heat });
  const e = state.lastEnergy;
  // Batteries first (their power limit), then the heat store (pump limit), then export.
  expect(e.heatStoreCharge).toBeCloseTo(BALANCE.heat.pumpPowerLimit, 3);
  expect(state.heatStored).toBeCloseTo(BALANCE.heat.pumpPowerLimit * heat.cop, 3);
  expect(state.storedEnergy).toBeGreaterThan(0);
  const generation = 3 * BALANCE.energy.solarPeakOutput + e.wind;
  const afterStorage = generation - BALANCE.energy.batteryPowerLimit - e.heatStoreCharge;
  expect(e.gridExport).toBeCloseTo(Math.min(afterStorage, BALANCE.market.exportCapacity), 3);
  // Charging counts as pump electricity.
  expect(e.heatPumpConsumption).toBeCloseTo(e.heatStoreCharge, 6);
});

it('does not charge the store on a warm day', () => {
  const state = heatedVillageState(0);
  placePlant(state, at(2, 14), PlantType.HeatStore);
  for (let i = 0; i < 3; i++) placePlant(state, at(5 + i, 14), PlantType.SolarFarm);
  setNoonClearSky(state);
  state.season = { ...state.season, temperature: 30 };
  const heat = heatStep(state);
  energyStep(state, { chargingDemand: 0, heat });
  expect(state.lastEnergy.heatStoreCharge).toBe(0);
  expect(state.heatStored).toBe(0);
});

it('runs without a heat input as if there were no district heating', () => {
  const state = heatedVillageState(2);
  state.season = { ...state.season, temperature: 0 };
  energyStep(state, { chargingDemand: 0 });
  expect(state.lastEnergy.heatPumpConsumption).toBe(0);
  expect(state.lastEnergy.heatingConsumption).toBeGreaterThan(0);
});
```

and, inside the same block, the helper the tests call:

```ts
function heatedVillageState(count: number, density = 1): SimState {
  const state = makeState();
  heatedVillage(state, count, density);
  return state;
}
```

Append to `src/sim/integration.test.ts` (it already builds cities with
`createSimState`/`stepTick`; add a self-contained case using
`placePlant`, `buildRoads`, `tileIndex`, `HEATED_SERVED`,
`PlantType`, `Zone` — import whatever is missing):

```ts
describe('district heating in the tick loop', () => {
  it('heats a served building through stepTick and reports it in the stats', () => {
    const size = 32;
    const at = (x: number, y: number) => tileIndex(x, y, size);
    const state = createSimState(7, size);
    state.money = 1e9;
    buildRoads(
      state,
      Array.from({ length: 10 }, (_, i) => at(3 + i, 10)),
    );
    placePlant(state, at(2, 10), PlantType.HeatPlant);
    placePlant(state, at(2, 12), PlantType.WindTurbine);
    placePlant(state, at(2, 14), PlantType.HeatStore);
    state.layers.zone[at(4, 9)] = Zone.Residential;
    state.layers.density[at(4, 9)] = 2;
    // Winter: SEASON_ORDER is spring, summer, autumn, winter, so a year
    // that started three seasons ago puts day 0 on the first winter day.
    state.seasonOriginDay = -BALANCE.seasons.daysPerSeason * 3;
    for (let i = 0; i < 20; i++) stepTick(state);
    expect(state.season.season).toBe('winter');
    expect(state.layers.heated[at(4, 9)]).toBe(HEATED_SERVED);
    const stats = buildStats(state);
    expect(stats.energy.networkHeat).toBeGreaterThan(0);
    expect(stats.energy.consumption.heatPumps).toBeGreaterThan(0);
    expect(stats.energy.heatCapacity).toBe(BALANCE.heat.storeCapacity);
    expect(stats.energy.heatCop).toBeLessThan(BALANCE.heat.copWarm);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/sim/energy.test.ts src/sim/integration.test.ts`
Expected: FAIL — `heat` is not a known property of `EnergyTickInput`;
`heatPumpConsumption` stays 0.

- [ ] **Step 3: Wire `energyStep`**

In `src/sim/energy.ts`:

Import: `import { chargeHeatStore, IDLE_HEAT, type HeatTickResult } from './heat.ts';`
and add `HEATED_SERVED` to the `../shared/types.ts` import.

`EnergyTickInput`:

```ts
export interface EnergyTickInput {
  /** Additional charging consumption (EVs), served after buildings. */
  chargingDemand: number;
  /** This tick's district-heating balance (IDLE_HEAT when absent). */
  heat?: HeatTickResult;
}
```

At the top of `energyStep`, after `const time = timeOfDay(state.tick);`:

```ts
const heat = input.heat ?? { ...IDLE_HEAT };
```

In the connected-buildings loop, replace the heating line:

```ts
// A served building gets its heat from the network; its own
// electric heating only runs for the fallback share (added below).
if (layers.heated[i] !== HEATED_SERVED) {
  heatingDemand += heatingConsumption(zone, density, temperature, state.insulation);
}
```

After the loop, before `const chargingDemand = …`:

```ts
// Heat the network could not deliver is heated electrically on site.
heatingDemand += heat.fallback;
```

`totalDemand`:

```ts
const totalDemand =
  buildingDemand + heatingDemand + coolingDemand + chargingDemand + heat.pumpPower;
```

Declare with the other accumulators: `let heatStoreCharge = 0;`.

In the surplus branch, replace the `remaining` line and keep the rest:

```ts
// The heat store drinks after the electric storages and before the
// link: a cheap one-way sink that shifts the heating peak.
heatStoreCharge = chargeHeatStore(state, heat, net - battery.absorbed - pumped.absorbed);
const remaining = net - battery.absorbed - pumped.absorbed - heatStoreCharge;
```

In the `state.lastEnergy = { … }` literal add:

```ts
    heatPumpConsumption: heat.pumpPower + heatStoreCharge,
    networkHeat: heat.networkHeat,
    heatFallback: heat.fallback,
    heatStoreCharge,
    heatCop: heat.cop,
```

Update the doc comment above `energyStep` (step 2 of the list):
"surplus charges batteries, then pumped storage, then the heat store
through the heat pumps (only while the nights are cold), anything beyond
is exported…".

- [ ] **Step 4: Wire the tick and the stats**

In `src/sim/tick.ts`:

Import `import { heatStep } from './heat.ts';` and add
`totalHeatCapacity` to the `./state.ts` import.

Replace the energy line in `stepTick`:

```ts
// Reservoirs first: this tick's generation reads the heat they leave.
reservoirStep(state);
// The heat network before the balance: served buildings leave the
// heating load, the pumps join it, and the cascade may fill the store.
const heat = heatStep(state);
energyStep(state, { chargingDemand: chargingDemand(state), heat });
```

In `recordLifetime`:

```ts
sums.consumption +=
  e.buildingConsumption +
  e.chargingConsumption +
  e.heatingConsumption +
  e.coolingConsumption +
  e.heatPumpConsumption;
sums.heating += e.heatingConsumption + e.heatPumpConsumption;
```

In `buildStats`, `consumption` gains `heatPumps: e.heatPumpConsumption,`
and after `hydrogenSold: e.hydrogenSold,`:

```ts
      networkHeat: e.networkHeat,
      heatFallback: e.heatFallback,
      heatStoreCharge: e.heatStoreCharge,
      heatStored: state.heatStored,
      heatCapacity: totalHeatCapacity(state),
      heatCop: e.heatCop,
```

- [ ] **Step 5: Run the full suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS. Watch for the hydrogen cascade tests in `energy.test.ts`
("electrolyses only the surplus the export link cannot take"): with no
heat plant `chargeHeatStore` returns 0, so their numbers must not move.

- [ ] **Step 6: Format and commit**

```bash
pnpm format
git add -A
git commit -m "feat(sim): district heating in the energy balance and the tick

Served buildings leave the heating load, the pumps' electricity joins
total demand, and the surplus cascade fills the heat store after the
electric storages and before export. heatStep runs before energyStep;
lifetime sums and GlobalStats carry the new figures.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Determinism, save/load and the tile diff

**Files:**

- Modify: `src/sim/heat.test.ts`
- Test: `src/sim/state.test.ts`

**Interfaces:**

- Consumes: `serializeState`, `deserializeState`, `collectDiffs`
  (`./state.ts`), `stepTick` (`./tick.ts`).

- [ ] **Step 1: Write the failing tests**

Append to `src/sim/heat.test.ts` (add imports: `collectDiffs,
deserializeState, serializeState` from `./state.ts`, `stepTick` from
`./tick.ts`, `TICKS_PER_DAY` from `../shared/constants.ts`):

```ts
/**
 * A flat-map winter village built with the same script every time: a
 * plant, a turbine, a store, six served buildings. `createSimState`
 * rather than `SimEngine.init` so no generated river or lake can cut
 * the road.
 */
function scriptedState(seed: number): SimState {
  const state = createSimState(seed, SIZE);
  state.money = 1e9;
  roadEast(state, 3, 10, 20);
  poweredHeatPlant(state, 2, 10);
  placePlant(state, at(2, 14), PlantType.HeatStore);
  for (let i = 0; i < 6; i++) building(state, 4 + i, 9, 2);
  // SEASON_ORDER is spring, summer, autumn, winter: a year that started
  // three seasons ago puts day 0 on the first winter day.
  state.seasonOriginDay = -BALANCE.seasons.daysPerSeason * 3;
  return state;
}

describe('district heating is deterministic and survives a reload', () => {
  it('two states with the same seed and script agree on the store and the layer', () => {
    const a = scriptedState(5);
    const b = scriptedState(5);
    for (let i = 0; i < TICKS_PER_DAY; i++) {
      stepTick(a);
      stepTick(b);
    }
    expect(a.heatStored).toBe(b.heatStored);
    expect(a.lastEnergy.networkHeat).toBe(b.lastEnergy.networkHeat);
    expect(Array.from(a.layers.heated)).toEqual(Array.from(b.layers.heated));
    expect(a.lastEnergy.networkHeat).toBeGreaterThan(0);
  });

  it('a save in mid-operation reloads with the same store and rebuilds the layer', () => {
    const live = scriptedState(9);
    for (let i = 0; i < TICKS_PER_DAY / 2; i++) stepTick(live);
    const save = serializeState(live);
    const restored = deserializeState(save);
    expect(restored.heatStored).toBe(live.heatStored);
    // Derived, never saved: empty on load, rebuilt by the first tick.
    expect(restored.layers.heated.every((v) => v === HEATED_NONE)).toBe(true);
    stepTick(restored);
    expect(restored.layers.heated.filter((v) => v === HEATED_SERVED).length).toBe(6);
    expect(restored.layers.heated.filter((v) => v === HEATED_TRUNK).length).toBe(
      BALANCE.heat.reachHops,
    );
  });

  it('the tile diff carries the heated value', () => {
    const state = freshState();
    roadEast(state, 3, 10, 10);
    poweredHeatPlant(state, 2, 10);
    building(state, 4, 9);
    collectDiffs(state); // drain the build diffs
    recomputeHeated(state);
    const diffs = collectDiffs(state);
    expect(diffs.find((d) => d.index === at(3, 10))?.heated).toBe(HEATED_TRUNK);
    expect(diffs.find((d) => d.index === at(4, 9))?.heated).toBe(HEATED_SERVED);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `pnpm vitest run src/sim/heat.test.ts`
Expected: PASS already for determinism (nothing random was added) and
the diff (Task 1 wired `collectDiffs`); the reload case pins that the
layer is derived, not saved. If the reload case fails on the trunk count,
check that `deserializeState` restores `tileType` before anything reads
roads (it does, at the top of the layer copies).

- [ ] **Step 3: Format and commit**

```bash
pnpm format
git add src/sim/heat.test.ts
git commit -m "test(sim): district heating is deterministic and survives a reload

Pins that two engines agree on the store and the heated layer, that a
mid-operation save reloads the store and rebuilds the layer on the next
tick, and that the tile diff carries the heated value.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: The `warmWinter` goal

**Files:**

- Modify: `src/sim/goals.ts` (`GOAL_IDS` line 7-25, `goalsStep` ~line 150-191)
- Modify: `src/ui/i18n.tsx` (goal strings after `goal.stormProof.body`, EN ~line 386, DE ~line 892)
- Modify: `docs/superpowers/specs/2026-10-03-heat-sector-design.md` (Save compatibility section)
- Test: `src/sim/goals.test.ts`

**Interfaces:**

- Produces: `GoalId` gains `'warmWinter'`; `state.goalProgress.warmWinterTicks`
  (declared in Task 1) is counted here.

- [ ] **Step 1: Write the failing tests**

Append to `src/sim/goals.test.ts` inside the top-level describe, next to
`geothermalBaseload`:

```ts
describe('warmWinter', () => {
  function winterCity(): ReturnType<typeof createSimState> {
    const state = createSimState(3, 16);
    state.season = { ...state.season, season: 'winter' };
    state.lastEnergy.networkHeat = 60;
    state.lastEnergy.heatFallback = 0;
    state.lastEnergy.heatingConsumption = 40;
    return state;
  }

  it('achieves after a full winter day with the network carrying half the heat', () => {
    const state = winterCity();
    for (let i = 0; i < TICKS_PER_DAY - 1; i++) goalsStep(state);
    expect(state.goalsAchieved.has('warmWinter')).toBe(false);
    goalsStep(state);
    expect(state.goalsAchieved.has('warmWinter')).toBe(true);
  });

  it('a fallback tick, a low share, another season or no demand resets the streak', () => {
    const state = winterCity();
    for (let i = 0; i < 10; i++) goalsStep(state);
    expect(state.goalProgress.warmWinterTicks).toBe(10);
    state.lastEnergy.heatFallback = 1;
    goalsStep(state);
    expect(state.goalProgress.warmWinterTicks).toBe(0);

    state.lastEnergy.heatFallback = 0;
    state.lastEnergy.heatingConsumption = 100; // network share 60/160 < 0.5
    goalsStep(state);
    expect(state.goalProgress.warmWinterTicks).toBe(0);

    state.lastEnergy.heatingConsumption = 40;
    state.season = { ...state.season, season: 'summer' };
    goalsStep(state);
    expect(state.goalProgress.warmWinterTicks).toBe(0);

    state.season = { ...state.season, season: 'winter' };
    state.lastEnergy.networkHeat = 0;
    state.lastEnergy.heatingConsumption = 0; // no demand at all
    goalsStep(state);
    expect(state.goalProgress.warmWinterTicks).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/sim/goals.test.ts`
Expected: FAIL — `'warmWinter'` is not a `GoalId`.

- [ ] **Step 3: Implement the goal**

In `src/sim/goals.ts`, `GOAL_IDS` gains `'warmWinter',` after
`'stormProof',`. Add a constant next to `GEOTHERMAL_SHARE`:

```ts
/** Share of the city's heat the district network must carry for the goal. */
const WARM_WINTER_SHARE = 0.5;
```

In `goalsStep`, after the geothermal streak:

```ts
// A whole winter day on district heating: the network carries at least
// half the city's heat, nobody falls back, and there is heat demand at
// all (an empty city cannot unlock it).
const heatTotal = e.networkHeat + e.heatFallback + e.heatingConsumption;
if (
  state.season.season === 'winter' &&
  heatTotal > 0 &&
  e.heatFallback === 0 &&
  e.networkHeat >= WARM_WINTER_SHARE * heatTotal
) {
  progress.warmWinterTicks++;
} else {
  progress.warmWinterTicks = 0;
}
```

and with the other achievements:

```ts
if (!achieved.has('warmWinter') && progress.warmWinterTicks >= TICKS_PER_DAY) {
  achieved.add('warmWinter');
}
```

`e.heatingConsumption` already includes the fallback share (Task 4), so
`heatTotal` double counts fallback by design: any fallback resets the
streak anyway, so the share is only ever evaluated with
`heatFallback === 0`.

- [ ] **Step 4: Strings**

`src/ui/i18n.tsx`, EN after `'goal.stormProof.body'`:

```ts
  'goal.warmWinter.title': 'Warm winter',
  'goal.warmWinter.body':
    'Carry at least half of your heat over the district network for a full winter day, with nobody falling back to their own heating.',
```

DE after `'goal.stormProof.body'`:

```ts
  'goal.warmWinter.title': 'Warmer Winter',
  'goal.warmWinter.body':
    'Liefere einen ganzen Wintertag lang mindestens die Hälfte der Wärme über das Fernwärmenetz, ohne dass jemand auf die eigene Heizung zurückfällt.',
```

- [ ] **Step 5: Amend the spec**

In the spec's "Save compatibility" section replace the first sentence
with: "`heatStored` and the goal's `warmWinterTicks` streak are added,
both optional (every other streak goal persists its counter the same
way)." Also add `warmWinterTicks?: number` to the Data model → State
bullet list.

- [ ] **Step 6: Run the tests**

Run: `pnpm typecheck && pnpm vitest run src/sim/goals.test.ts src/sim/state.test.ts`
Expected: PASS.

- [ ] **Step 7: Format and commit**

```bash
pnpm format
git add -A
git commit -m "feat(sim): a goal for a winter day on district heating

warmWinter counts consecutive winter ticks in which the network carries
at least half the city's heat with no fallback; achieved after a full
day. The streak persists like the other streak goals.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: The inspector explains heat

**Files:**

- Modify: `src/shared/types.ts` (`TileInfo` ~line 354)
- Modify: `src/sim/inspect.ts` (`plantStorage` ~line 110, assembly ~line 290-348)
- Modify: `src/ui/TileInspector.tsx` (plant section near the `info.hotspot` block ~line 228; building services section ~line 482)
- Modify: `src/ui/i18n.tsx`
- Test: `src/sim/inspect.test.ts`

**Interfaces:**

- Produces on `TileInfo`:

  ```ts
  /** Building heated by the district network this tick. */
  heated: boolean;
  /** Present on a heat plant: its own reach and what it serves. */
  heatPlant?: {
    /** Road tiles this plant's network reaches (0 without an adjacent road). */
    reach: number;
    /** Buildings beside those roads. */
    served: number;
    /** COP in force this tick. */
    cop: number;
    /** Connected to the grid and intact, i.e. actually heating. */
    active: boolean;
  };
  ```

  A heat store reports its share of the pool through the existing
  `storedEnergy` / `storageCapacity` fields.

- [ ] **Step 1: Write the failing tests**

Append to `src/sim/inspect.test.ts` (reuse that file's helpers for
creating a state; if it has none, use `createSimState(1, 32)` with
`state.money = 1e9`, `buildRoads`, `placePlant` and direct zone/density
writes as in `heat.test.ts`; call `recomputeHeated(state)` before
inspecting, exactly as the tick would):

```ts
describe('district heating', () => {
  const SIZE = 32;
  const at = (x: number, y: number) => tileIndex(x, y, SIZE);

  function heatedTown() {
    const state = createSimState(1, SIZE);
    state.money = 1e9;
    buildRoads(
      state,
      Array.from({ length: 10 }, (_, i) => at(3 + i, 10)),
    );
    placePlant(state, at(2, 10), PlantType.HeatPlant);
    placePlant(state, at(2, 12), PlantType.WindTurbine);
    placePlant(state, at(2, 14), PlantType.HeatStore);
    state.layers.zone[at(4, 9)] = Zone.Residential;
    state.layers.density[at(4, 9)] = 1;
    state.layers.zone[at(20, 20)] = Zone.Residential;
    state.layers.density[at(20, 20)] = 1;
    state.heatStored = 1_500;
    recomputeHeated(state);
    return state;
  }

  it('flags a served building and not an unserved one', () => {
    const state = heatedTown();
    expect(inspectTile(state, at(4, 9)).heated).toBe(true);
    expect(inspectTile(state, at(20, 20)).heated).toBe(false);
  });

  it('describes a heat plant: reach, served buildings, COP, active', () => {
    const state = heatedTown();
    const info = inspectTile(state, at(2, 10));
    expect(info.heatPlant).toEqual({
      reach: 10,
      served: 1,
      cop: heatPumpCop(state.season.temperature),
      active: true,
    });
  });

  it('a plant without a road reaches nothing', () => {
    const state = heatedTown();
    placePlant(state, at(25, 25), PlantType.HeatPlant);
    expect(inspectTile(state, at(25, 25)).heatPlant?.reach).toBe(0);
  });

  it('a heat store shows its share of the pool', () => {
    const state = heatedTown();
    const info = inspectTile(state, at(2, 14));
    expect(info.storedEnergy).toBeCloseTo(1_500, 6);
    expect(info.storageCapacity).toBe(BALANCE.heat.storeCapacity);
    expect(info.heatPlant).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/sim/inspect.test.ts`
Expected: FAIL — `heated` is undefined on `TileInfo`.

- [ ] **Step 3: Extend `TileInfo` and `inspectTile`**

`src/shared/types.ts`, in `TileInfo` after `policeCovered: boolean;`:

```ts
  /** Building heated by the district network this tick. */
  heated: boolean;
  /** Present on a heat plant: its own reach and what it serves. */
  heatPlant?: {
    /** Road tiles this plant's network reaches (0 without an adjacent road). */
    reach: number;
    /** Buildings beside those roads. */
    served: number;
    /** COP in force this tick. */
    cop: number;
    /** Connected to the grid and intact, i.e. actually heating. */
    active: boolean;
  };
```

`src/sim/inspect.ts`: import `heatPumpCop, plantReach` from `./heat.ts`
and `HEATED_SERVED` from `../shared/types.ts`.

In `plantStorage`, before the final `return { stored: 0, capacity: 0 };`:

```ts
if (plant === PlantType.HeatStore && census.heatStores > 0) {
  return {
    stored: state.heatStored / census.heatStores,
    capacity: BALANCE.heat.storeCapacity,
  };
}
```

Add a helper above `inspectTile`:

```ts
/** A heat plant's own network: reach and the buildings beside it. */
function heatPlantInfo(state: SimState, index: number, connected: boolean) {
  const { layers } = state;
  const reach = plantReach(state, index);
  const served = new Set<number>();
  for (const road of reach) {
    for (const neighbor of neighbors4(road, state.size)) {
      if (layers.tileType[neighbor] === TileType.Empty && layers.density[neighbor] > 0) {
        served.add(neighbor);
      }
    }
  }
  return {
    reach: reach.length,
    served: served.size,
    cop: heatPumpCop(state.season.temperature),
    active: connected && layers.damage[index] === 0,
  };
}
```

In the returned literal, after `policeCovered: …,`:

```ts
    heated: isBuilding && layers.heated[index] === HEATED_SERVED,
    ...(tileType === TileType.Plant && plant === PlantType.HeatPlant
      ? { heatPlant: heatPlantInfo(state, index, connected) }
      : {}),
```

`connected` for a non-supply plant is `layers.energized[index] === 1`
in this file already (check how `stationActive` derives it and reuse the
same variable).

- [ ] **Step 4: Show it in the UI**

`src/ui/TileInspector.tsx`, inside the plant section right after the
`info.hotspot && (…)` block:

```tsx
{
  info.heatPlant && (
    <>
      <Row
        label={t('inspect.heatReach')}
        value={`${info.heatPlant.reach} · ${info.heatPlant.served}`}
        hint={t('inspect.heatReachHint')}
        tone={info.heatPlant.reach === 0 ? 'negative' : 'muted'}
        testId="inspect-heat-reach"
      />
      <Row
        label={t('inspect.heatCop')}
        value={`${info.heatPlant.cop.toFixed(1)} · ${
          info.heatPlant.active ? t('inspect.heatActive') : t('inspect.heatInactive')
        }`}
        tone={info.heatPlant.active ? 'positive' : 'negative'}
        testId="inspect-heat-cop"
      />
      {info.heatPlant.reach === 0 && (
        <Row
          label={t('inspect.heatNoRoad')}
          value=""
          tone="negative"
          testId="inspect-heat-noroad"
        />
      )}
    </>
  );
}
```

In the building services section (the one with `inspect.section.services`
and `fireCovered`), add a row:

```tsx
<Row
  label={t('inspect.heating')}
  value={info.heated ? t('inspect.heatNetwork') : t('inspect.heatOwn')}
  tone={info.heated ? 'positive' : 'muted'}
  testId="inspect-heating"
/>
```

Match the `Row` prop names to the component as it exists in the file
(`label`, `value`, `hint`, `tone`, `testId`); if `Row` requires a
non-empty `value`, use `'—'` for the no-road row.

`src/ui/i18n.tsx`, EN after `'inspect.hotspotHint'`:

```ts
  'inspect.heatReach': 'Heat network',
  'inspect.heatReachHint': 'Road tiles reached · buildings served. The network follows the roads touching the plant.',
  'inspect.heatCop': 'Heat pump COP',
  'inspect.heatActive': 'heating',
  'inspect.heatInactive': 'off — not connected or damaged',
  'inspect.heatNoRoad': 'No road touches this plant, so it heats nobody',
  'inspect.heating': 'Heating',
  'inspect.heatNetwork': 'district heating',
  'inspect.heatOwn': 'own heat pump',
```

DE after `'inspect.hotspotHint'`:

```ts
  'inspect.heatReach': 'Wärmenetz',
  'inspect.heatReachHint': 'Erreichte Straßenkacheln · versorgte Gebäude. Das Netz folgt den Straßen, die das Heizwerk berühren.',
  'inspect.heatCop': 'Wärmepumpen-COP',
  'inspect.heatActive': 'heizt',
  'inspect.heatInactive': 'aus — nicht angeschlossen oder beschädigt',
  'inspect.heatNoRoad': 'Keine Straße berührt dieses Heizwerk, es versorgt niemanden',
  'inspect.heating': 'Heizung',
  'inspect.heatNetwork': 'Fernwärme',
  'inspect.heatOwn': 'eigene Wärmepumpe',
```

- [ ] **Step 5: Run the tests**

Run: `pnpm typecheck && pnpm vitest run src/sim/inspect.test.ts`
Expected: PASS.

- [ ] **Step 6: Format and commit**

```bash
pnpm format
git add -A
git commit -m "feat(ui): the inspector explains district heating

A served building says so; a heat plant shows its reach, the buildings
it serves, the COP now and whether it is heating; a heat store shows
its share of the pool. A plant with no road gets a hint.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Build tools and hotkeys

**Files:**

- Modify: `src/ui/useTools.ts` (`ToolId` line 9-34, `TOOL_HOTKEYS` line 43-69, `PLANT_BY_TOOL` line 76-92)
- Modify: `src/ui/BuildBar.tsx` (energy category line 62-72)
- Modify: `src/ui/i18n.tsx` (tool descriptions after `'tool.plant-geothermal.desc'`, EN ~line 117, DE ~line 619)
- Test: `src/ui/useTools.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/ui/useTools.test.ts` next to the geothermal hotkey case:

```ts
it('maps the heat plant and heat store tools and their hotkeys', () => {
  expect(TOOL_HOTKEYS.r).toBe('plant-heat');
  expect(TOOL_HOTKEYS.o).toBe('plant-heatstore');
  expect(PLANT_BY_TOOL['plant-heat']).toBe(PlantType.HeatPlant);
  expect(PLANT_BY_TOOL['plant-heatstore']).toBe(PlantType.HeatStore);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/ui/useTools.test.ts`
Expected: FAIL — `TOOL_HOTKEYS.r` is undefined.

- [ ] **Step 3: Wire the tools**

`src/ui/useTools.ts`: add `| 'plant-heat' | 'plant-heatstore'` to
`ToolId` after `'plant-geothermal'`; in `TOOL_HOTKEYS` add
`r: 'plant-heat',` and `o: 'plant-heatstore',` (both free: `q`/`e`
rotate the camera, `w a s d` pan — see `GameRenderer.PAN_KEYS`); in
`PLANT_BY_TOOL` add:

```ts
  'plant-heat': PlantType.HeatPlant,
  'plant-heatstore': PlantType.HeatStore,
```

`src/ui/BuildBar.tsx`, energy category after the hydrogen button:

```ts
      { id: 'plant-heat', icon: '🔥', cost: BALANCE.costs.plant[PlantType.HeatPlant] },
      { id: 'plant-heatstore', icon: '🛢', cost: BALANCE.costs.plant[PlantType.HeatStore] },
```

`src/ui/i18n.tsx`, EN after `'tool.plant-geothermal.desc'`:

```ts
  'tool.plant-heat.desc':
    'A large heat pump feeding district heating along the roads touching it, 12 road tiles out. ' +
    'Buildings beside those roads get their heat from the network at the pump’s COP instead ' +
    'of heating themselves — the colder it gets, the lower the COP. Needs grid power.',
  'tool.plant-heatstore.desc':
    'A hot-water tank. Surplus fills it through the heat plants while the nights are cold, ' +
    'and it covers the evening heat peak later. Heat never turns back into electricity.',
```

DE after `'tool.plant-geothermal.desc'`:

```ts
  'tool.plant-heat.desc':
    'Eine große Wärmepumpe, die Fernwärme entlang der Straßen am Heizwerk 12 Straßenkacheln weit ' +
    'einspeist. Gebäude an diesen Straßen beziehen ihre Wärme aus dem Netz mit dem COP der Pumpe, ' +
    'statt selbst zu heizen — je kälter, desto niedriger der COP. Braucht Netzstrom.',
  'tool.plant-heatstore.desc':
    'Ein Warmwasserspeicher. Überschuss füllt ihn über die Heizwerke, solange die Nächte kalt sind, ' +
    'und er deckt später die abendliche Wärmespitze. Wärme wird nie wieder zu Strom.',
```

If `BuildBar` looks tool descriptions up as `` `tool.${id}.desc` `` the
keys above already match; verify by grepping `.desc` in `BuildBar.tsx`.
The "12" in the copy is the spec's `reachHops`; if the probe (Task 14)
changes it, change the copy.

- [ ] **Step 4: Run the tests**

Run: `pnpm typecheck && pnpm vitest run src/ui/useTools.test.ts`
Expected: PASS. Note: the e2e "build menu shows every tool in one row"
test already fails off the Mac (see memory note) and two more buttons
widen the row further — leave it, it is a known font-metrics issue.

- [ ] **Step 5: Format and commit**

```bash
pnpm format
git add -A
git commit -m "feat(ui): heat plant and heat store build tools

Two buttons in the energy category with hotkeys r and o, mapped to the
new plant types, with EN/DE descriptions.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: The energy panel shows the heat pumps and the store

**Files:**

- Modify: `src/ui/EnergyPanel.tsx` (`totalConsumption` ~line 86, rows ~line 150-165, `SocBlock`s ~line 205-220)
- Modify: `src/ui/i18n.tsx` (after `'energy.electrolysis'` and `'energy.hydrogenStorage'`)

- [ ] **Step 1: Add the rows**

In `EnergyPanel`, `totalConsumption` adds `+ energy.consumption.heatPumps`.

After the electrolysis `Row`:

```tsx
        <Row
          label={t('energy.heatPumps', { cop: energy.heatCop.toFixed(1) })}
          value={energy.consumption.heatPumps}
          testId="detail-energy-heat-pumps"
        />
        <Row
          label={t('energy.networkHeat')}
          value={energy.networkHeat}
          testId="detail-energy-network-heat"
        />
```

After the hydrogen `SocBlock`:

```tsx
<SocBlock
  label={t('energy.heatStorage')}
  stored={energy.heatStored}
  capacity={energy.heatCapacity}
  testId="energy-heat-soc"
/>
```

Check how `t` interpolates (`t('disaster.warning', { hours, minutes })`
exists, so `{cop}` placeholders work the same way).

- [ ] **Step 2: Strings**

EN after `'energy.electrolysis': 'Electrolysis',`:

```ts
  'energy.heatPumps': '♨️ Heat pumps (COP {cop})',
  'energy.networkHeat': '🏘 District heat',
```

EN after `'energy.hydrogenStorage': 'Hydrogen tank',`:

```ts
  'energy.heatStorage': 'Heat store',
```

DE after `'energy.electrolysis': 'Elektrolyse',`:

```ts
  'energy.heatPumps': '♨️ Wärmepumpen (COP {cop})',
  'energy.networkHeat': '🏘 Fernwärme',
```

DE after `'energy.hydrogenStorage': 'Wasserstofftank',`:

```ts
  'energy.heatStorage': 'Wärmespeicher',
```

- [ ] **Step 3: Typecheck, smoke**

Run: `pnpm typecheck && pnpm test && node scripts/smoke.mjs`
Expected: clean; the smoke script boots the app headless without console errors.

- [ ] **Step 4: Format and commit**

```bash
pnpm format
git add -A
git commit -m "feat(ui): heat pumps, district heat and the heat store in the energy panel

Two consumption rows (pump electricity with the live COP, heat
delivered) and a state-of-charge bar for the pooled hot-water store.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: The Heat overlay

**Files:**

- Modify: `src/shared/types.ts` (`OverlayMode` line 82-91)
- Modify: `src/render/overlays.ts` (`OverlayTile` ~line 60, `applyDiffs` ~line 120, `rebuild` ~line 165)
- Modify: `src/ui/OverlayToggle.tsx` (`MODES` after Damage)
- Modify: `src/ui/i18n.tsx` (after `'overlay.damage.title'`)
- Test: `src/render/overlays.test.ts`

**Interfaces:**

- Produces: `OverlayMode.Heat = 8`;
  `heatColor(tile: { tileType, density, heated, heatDemand: boolean }): number | null`
  exported from `overlays.ts` for the test.

- [ ] **Step 1: Write the failing test**

Append to `src/render/overlays.test.ts`:

```ts
import { HEATED_NONE, HEATED_SERVED, HEATED_TRUNK, TileType } from '../shared/types.ts';
import { heatColor } from './overlays.ts';

describe('heatColor', () => {
  it('tints trunk roads, served buildings and unserved buildings differently', () => {
    const trunk = heatColor({ tileType: TileType.Road, density: 0, heated: HEATED_TRUNK });
    const served = heatColor({ tileType: TileType.Empty, density: 1, heated: HEATED_SERVED });
    const unserved = heatColor({ tileType: TileType.Empty, density: 1, heated: HEATED_NONE });
    expect(trunk).not.toBeNull();
    expect(served).not.toBeNull();
    expect(unserved).not.toBeNull();
    expect(new Set([trunk, served, unserved]).size).toBe(3);
  });

  it('leaves roads outside the network and empty land alone', () => {
    expect(heatColor({ tileType: TileType.Road, density: 0, heated: HEATED_NONE })).toBeNull();
    expect(heatColor({ tileType: TileType.Empty, density: 0, heated: HEATED_NONE })).toBeNull();
  });
});
```

(Merge the import lines with the file's existing imports.)

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/render/overlays.test.ts`
Expected: FAIL — `heatColor` is not exported.

- [ ] **Step 3: Implement**

`src/shared/types.ts`: `OverlayMode` gains `Heat: 8,` after `Damage: 7,`.

`src/render/overlays.ts`:

Import `HEATED_SERVED, HEATED_TRUNK` from `../shared/types.ts`. Add
colours after `DAMAGE_COLORS`:

```ts
const HEAT_COLORS = { trunk: 0xf4a261, served: 0xe76f51, unserved: 0x5b9bd5 } as const;

/** Overlay colour of a tile in the Heat overlay, null when it shows nothing. */
export function heatColor(tile: {
  tileType: TileType;
  density: number;
  heated: number;
}): number | null {
  if (tile.tileType === TileType.Road) {
    return tile.heated === HEATED_TRUNK ? HEAT_COLORS.trunk : null;
  }
  if (tile.tileType === TileType.Empty && tile.density > 0) {
    return tile.heated === HEATED_SERVED ? HEAT_COLORS.served : HEAT_COLORS.unserved;
  }
  return null;
}
```

`OverlayTile` gains `heated: number;`. In `applyDiffs`, the `if` that
decides whether to track a tile gains `|| diff.heated !== 0` and the
literal gains `heated: diff.heated,`. In `rebuild`, after the Damage
branch:

```ts
        } else if (this.mode === OverlayMode.Heat) {
          colorHex = heatColor(tile);
        }
```

Update the class doc comment to mention the heat network.

`src/ui/OverlayToggle.tsx`, `MODES` gains after Damage:

```ts
  { mode: OverlayMode.Heat, id: 'heat', label: 'overlay.heat', title: 'overlay.heat.title' },
```

`src/ui/i18n.tsx`, EN after `'overlay.damage.title'`:

```ts
  'overlay.heat': 'Heat',
  'overlay.heat.title':
    'District heating: orange roads carry the network, red buildings are served, blue buildings heat themselves',
```

DE after `'overlay.damage.title'`:

```ts
  'overlay.heat': 'Wärme',
  'overlay.heat.title':
    'Fernwärme: orange Straßen tragen das Netz, rote Gebäude sind versorgt, blaue Gebäude heizen selbst',
```

- [ ] **Step 4: Run the tests**

Run: `pnpm typecheck && pnpm vitest run src/render/overlays.test.ts`
Expected: PASS.

- [ ] **Step 5: Format and commit**

```bash
pnpm format
git add -A
git commit -m "feat(render): a district-heating overlay

Trunk roads, served buildings and buildings heating themselves in three
tones, so the gap between reach and need reads at a glance.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Plant shapes on the map

**Files:**

- Modify: `src/render/plantsMesh.ts` (`COLORS` ~line 55-70, `plantBoxParts` switch ~line 263-275)

- [ ] **Step 1: Colours and parts**

In `COLORS`, after `geoWellhead`:

```ts
  heatHall: 0x7a4a3a,
  heatStack: 0xd9822b,
  heatRoof: 0xe4e7ea,
  storeTank: 0xc9a227,
  storePlinth: 0x6f7a86,
  storeCap: 0xe6ebee,
```

In `plantBoxParts`, after the `GeothermalPlant` case:

```ts
    case PlantType.HeatPlant:
      return [
        // A low pump hall with a flat roof and one tall slim stack.
        { sx: 0.7, sy: 0.26, sz: 0.46, ox: -0.06, oy: 0, oz: 0.06, color: COLORS.heatHall },
        { sx: 0.74, sy: 0.04, sz: 0.5, ox: -0.06, oy: 0.26, oz: 0.06, color: COLORS.heatRoof },
        { sx: 0.1, sy: 0.62, sz: 0.1, ox: 0.3, oy: 0, oz: -0.26, color: COLORS.heatStack },
      ];
    case PlantType.HeatStore:
      return [
        // A wide cylinder faked by two stepped boxes on a plinth, capped white.
        { sx: 0.7, sy: 0.06, sz: 0.7, ox: 0, oy: 0, oz: 0, color: COLORS.storePlinth },
        { sx: 0.56, sy: 0.4, sz: 0.56, ox: 0, oy: 0.06, oz: 0, color: COLORS.storeTank },
        { sx: 0.46, sy: 0.4, sz: 0.64, ox: 0, oy: 0.06, oz: 0, color: COLORS.storeTank },
        { sx: 0.64, sy: 0.4, sz: 0.46, ox: 0, oy: 0.06, oz: 0, color: COLORS.storeTank },
        { sx: 0.5, sy: 0.05, sz: 0.5, ox: 0, oy: 0.46, oz: 0, color: COLORS.storeCap },
      ];
```

`plantHeight` derives from the parts automatically. Check the `BoxPart`
field names against the interface at the top of the file before
committing (`sx sy sz ox oy oz color` as used by every other case).

- [ ] **Step 2: Verify**

Run: `pnpm typecheck && pnpm test && node scripts/smoke.mjs`
Expected: clean. The real visual check needs the Mac (no WebGL here);
note it for the final visual pass.

- [ ] **Step 3: Format and commit**

```bash
pnpm format
git add src/render/plantsMesh.ts
git commit -m "feat(render): heat plant and heat store meshes

A low hall with a tall stack, and a stepped-box tank on a plinth.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Agent tools and their docs

**Files:**

- Modify: `src/agent/tools.ts` (`PLANT_NAMES` ~line 92, `PLANT_TOOL_KEY` ~line 157, `PLANT_PLACEMENT` ~line 173, `overviewGlyph` ~line 380, `OVERVIEW_LEGEND` ~line 412, `get_game_overview`/`get_energy_report` energy block ~line 550-580, `place_plant` description ~line 950, `inspect_tile` description ~line 753, catalog `plantInfo` ~line 1215, `liveFigures` ~line 1243)
- Modify: `docs/agent-tools.md` (conventions ~line 62-80, table rows for `get_map`, `inspect_tile`, `get_energy_report`)
- Test: `src/agent/tools.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/agent/tools.test.ts` (uses `createHarness`, `findLand`,
`tileIndex`, `SIZE` from the file):

```ts
it('builds a heat plant and a heat store, and reports the heat figures', async () => {
  const { call, engine } = createHarness();
  const { x, y } = findLand(engine);
  const plant = await call('place_plant', { plant: 'heat_plant', x, y });
  expect(plant).toMatchObject({ ok: true });
  expect(engine.state.layers.plantType[tileIndex(x, y, SIZE)]).toBe(PlantType.HeatPlant);
  const { x: sx, y: sy } = findLand(engine);
  const store = await call('place_plant', { plant: 'heat_store', x: sx, y: sy });
  expect(store).toMatchObject({ ok: true });
  // get_energy_report spreads EnergyStats as-is, so the new fields are there by name.
  const report = (await call('get_energy_report')) as Record<string, any>;
  expect(report.consumption).toHaveProperty('heatPumps');
  expect(report.heatCapacity).toBe(BALANCE.heat.storeCapacity);
  expect(report).toHaveProperty('heatCop');
  // get_game_overview hand-builds energyPerTick and gains a heat block.
  const overview = (await call('get_game_overview')) as Record<string, any>;
  expect(overview.energyPerTick.consumption).toHaveProperty('heatPumps');
  expect(overview.energyPerTick.heat).toMatchObject({ capacity: BALANCE.heat.storeCapacity });
  expect(overview.energyPerTick.heat).toHaveProperty('cop');
});

it('inspect_tile reports district heating on a plant and on a building', async () => {
  const { call, engine } = createHarness();
  const { x, y } = findLand(engine);
  await call('place_plant', { plant: 'heat_plant', x, y });
  const info = (await call('inspect_tile', { x, y })) as Record<string, any>;
  expect(info.ok).toBe(true);
  expect(info.heatPlant).toMatchObject({ reach: expect.any(Number), served: expect.any(Number) });
  expect(info).toHaveProperty('heated');
});

it('the overview map draws heat plants and stores with their own glyphs', async () => {
  const { call, engine } = createHarness();
  const { x, y } = findLand(engine);
  await call('place_plant', { plant: 'heat_plant', x, y });
  const map = (await call('get_map', { layer: 'overview' })) as Record<string, any>;
  expect(map.rows[y][x]).toBe('Q');
  expect(map.legend).toContain('Q heat plant');
});
```

`findLand` may return the same tile twice; if the second placement is
rejected with `tileOccupied`, pick `{ x: x + 2, y }` for the store and
assert `terrain` is land via `engine.state.layers.terrain` first.
The harness's `sendCommand` flushes after every command, so the stats
read after `place_plant` already carry the new capacity.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run src/agent/tools.test.ts`
Expected: FAIL — `heat_plant` is not a valid plant name.

- [ ] **Step 3: Implement**

`PLANT_NAMES` gains `heat_plant: PlantType.HeatPlant, heat_store: PlantType.HeatStore,`.

`PLANT_TOOL_KEY` gains `heat_plant: 'tool.plant-heat', heat_store: 'tool.plant-heatstore',`.

`PLANT_PLACEMENT` gains:

```ts
  heat_plant:
    'any empty land tile; a large heat pump that heats every building beside the roads within ' +
    'reach of the roads touching it (reach in get_build_catalog) — needs grid power and at least one adjacent road to serve anyone',
  heat_store:
    'any empty land tile; a hot-water tank the surplus cascade fills through the heat plants while the nights are cold, drained later for district heat',
```

`overviewGlyph`: `heat_plant: 'Q', heat_store: 'K',`. `OVERVIEW_LEGEND`:
append `, Q heat plant, K heat store` to the plants list (before the
final sentence about roads).

`get_energy_report` spreads `s.energy`, so it already carries the new
`EnergyStats` fields. In `get_game_overview`'s hand-built `energyPerTick`
block, add `heatPumps: round(e.consumption.heatPumps),` to `consumption`
and, after `hydrogen: {…}`:

```ts
            heat: {
              stored: Math.round(e.heatStored),
              capacity: e.heatCapacity,
              networkHeatPerTick: round(e.networkHeat),
              fallbackPerTick: round(e.heatFallback),
              storeChargePerTick: round(e.heatStoreCharge),
              cop: round(e.heatCop, 2),
            },
```

`place_plant` description: add `heat_plant, heat_store` to the list.
`inspect_tile` description: add "On a heat plant a "heatPlant" field
reports its road reach, buildings served, COP and whether it is active;
a building reports `heated` (true when the district network heats it)."

Catalog `plantInfo` switch gains:

```ts
    case PlantType.HeatPlant:
      return {
        pumpPowerLimitPerTick: BALANCE.heat.pumpPowerLimit,
        reachRoadTiles: BALANCE.heat.reachHops,
        copWarm: BALANCE.heat.copWarm,
        copCold: BALANCE.heat.copCold,
      };
    case PlantType.HeatStore:
      return {
        heatCapacity: BALANCE.heat.storeCapacity,
        dischargeLimitPerTick: BALANCE.heat.storeDischargeLimit,
      };
```

`liveFigures` gains `heated: info.heated,` and
`...(info.heatPlant ? { heatPlant: info.heatPlant } : {}),`.

`docs/agent-tools.md`: add `heat_plant`, `heat_store` to the plant list
in Conventions with one sentence each (reach along roads; store fills
from surplus through the plants); mention `Q`/`K` in the `get_map` row;
mention `heated`/`heatPlant` in the `inspect_tile` row; mention the
`heat` block in the `get_energy_report` row.

- [ ] **Step 4: Run the tests**

Run: `pnpm typecheck && pnpm vitest run src/agent/tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Format and commit**

```bash
pnpm format
git add -A
git commit -m "feat(agent): expose district heating

heat_plant and heat_store for place_plant and the catalog, Q/K map
glyphs, a heat block in the energy figures, and heated/heatPlant on
inspect_tile. docs/agent-tools.md follows.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: Help page and the backlog

**Files:**

- Modify: `src/ui/HelpPage.tsx` (`SECTIONS` after `help.seasons`)
- Modify: `src/ui/i18n.tsx` (after `help.seasons.body`, EN ~line 250, DE ~line 753)
- Modify: `docs/idea.md` (the "Heat sector" bullet ~line 216)

- [ ] **Step 1: Help section**

`HelpPage.tsx`, after the seasons entry:

```ts
  { title: 'help.heat.title', body: 'help.heat.body' },
```

EN after `'help.seasons.body'`:

```ts
  'help.heat.title': 'District heating',
  'help.heat.body':
    'A heat plant is a large heat pump. It feeds heat into the roads touching it, 12 road tiles out, and every building beside those roads takes its heat from the network instead of heating itself. The pump’s COP — heat units per electricity unit — is about 3.5 in mild weather and falls towards 1.8 in deep cold, so winter stays hard, but a served building costs a fraction of the electricity. A heat store is a hot-water tank: while the nights are cold, surplus that batteries and pumped storage cannot take fills it through the heat plants before anything is exported, and it covers the evening heat peak later. Heat never turns back into electricity. If the plants and the store cannot cover the network, the rest of the heat is made the old way, on site. Both plants need grid power; the Heat overlay shows the network and who is on it.',
```

DE after `'help.seasons.body'`:

```ts
  'help.heat.title': 'Fernwärme',
  'help.heat.body':
    'Ein Heizwerk ist eine große Wärmepumpe. Es speist Wärme in die Straßen ein, die es berühren, 12 Straßenkacheln weit, und jedes Gebäude an diesen Straßen bezieht seine Wärme aus dem Netz, statt selbst zu heizen. Der COP der Pumpe — Wärmeeinheiten je Stromeinheit — liegt bei mildem Wetter um 3,5 und fällt bei strenger Kälte Richtung 1,8; der Winter bleibt also hart, aber ein versorgtes Gebäude kostet nur einen Bruchteil des Stroms. Ein Wärmespeicher ist ein Warmwassertank: Solange die Nächte kalt sind, füllt ihn Überschuss, den Batterien und Pumpspeicher nicht aufnehmen, über die Heizwerke, bevor etwas exportiert wird — und er deckt später die abendliche Wärmespitze. Wärme wird nie wieder zu Strom. Reichen Heizwerke und Speicher nicht, entsteht der Rest der Wärme wie bisher vor Ort. Beide Anlagen brauchen Netzstrom; das Wärme-Overlay zeigt das Netz und wer daran hängt.',
```

If Task 14 changes `reachHops`, `copWarm` or `copCold`, update the
numbers in both languages (and in the tool descriptions from Task 8).

- [ ] **Step 2: Backlog**

In `docs/idea.md` replace the heat sector bullet with:

```markdown
- **Heat sector** (done): seasons already made heating a winter load;
  district heating turns it into a choice. A heat plant is a large heat
  pump feeding the roads touching it; every building beside those roads
  takes its heat from the network at the pump's COP, which falls with
  the cold. A heat store is a hot-water tank the surplus cascade fills
  through the pumps — after batteries and pumped storage, before
  export, and only while the nights are cold — and drains for the
  evening peak. Heat never turns back into electricity, and whatever the
  network cannot cover is heated on site as before.
```

- [ ] **Step 3: Verify and commit**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

```bash
pnpm format
git add -A
git commit -m "docs: explain district heating in the help page and the backlog

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: Balancing with a headless probe

**Files:**

- Create (temporary): `src/sim/heat.probe.test.ts` — deleted before the commit
- Modify: `src/shared/constants.ts` (`BALANCE.heat`, the two cost rows, the two upkeep rows)
- Modify if numbers move: `src/ui/i18n.tsx` (tool descriptions, help), `docs/superpowers/specs/2026-10-03-heat-sector-design.md` (balance table)

- [ ] **Step 1: Write the probe**

Create `src/sim/heat.probe.test.ts`:

```ts
/**
 * TEMPORARY balancing probe — delete before committing. Runs one
 * scripted city through a winter with and without district heating and
 * prints the pacing the spec asks for.
 */
import { describe, it } from 'vitest';
import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { placePlant } from './energy.ts';
import { buildPowerLines } from './powerLines.ts';
import { buildRoads } from './roads.ts';
import { createSimState, PlantType, Zone, type SimState } from './state.ts';
import { stepTick } from './tick.ts';

const SIZE = 48;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);

function city(withHeat: boolean, stores: number): SimState {
  const state = createSimState(21, SIZE);
  state.money = 1e9;
  // Four east-west streets, 24 tiles long, three rows apart, each carrying
  // a power line (lines share road tiles); a vertical line at x = 6 ties
  // them to the generation block above the town. Without the lines the
  // buildings would sit unconnected and draw no heating at all.
  const streets: number[][] = [];
  for (let row = 0; row < 4; row++) {
    const y = 10 + row * 3;
    const tiles = Array.from({ length: 24 }, (_, i) => at(6 + i, y));
    buildRoads(state, tiles);
    buildPowerLines(state, tiles);
    streets.push(tiles);
    for (let i = 0; i < 24; i += 2) {
      state.layers.zone[at(6 + i, y - 1)] = Zone.Residential;
      state.layers.density[at(6 + i, y - 1)] = 2;
      state.layers.zone[at(7 + i, y + 1)] = Zone.Commercial;
      state.layers.density[at(7 + i, y + 1)] = 1;
    }
  }
  buildPowerLines(
    state,
    Array.from({ length: 18 }, (_, i) => at(6, 2 + i)),
  );
  // Generation above the town: the turbine at (8,2) energises the line's top.
  for (let i = 0; i < 6; i++) placePlant(state, at(8 + i * 2, 2), PlantType.WindTurbine);
  for (let i = 0; i < 4; i++) placePlant(state, at(8 + i * 2, 4), PlantType.SolarFarm);
  placePlant(state, at(4, 8), PlantType.Battery);
  if (withHeat) {
    placePlant(state, at(5, 10), PlantType.HeatPlant); // touches the first street at (6,10)
    placePlant(state, at(5, 16), PlantType.HeatPlant); // touches the third street at (6,16)
    for (let i = 0; i < stores; i++) placePlant(state, at(2, 10 + i * 2), PlantType.HeatStore);
  }
  // Start on the first day of winter (SEASON_ORDER ends with winter).
  state.seasonOriginDay = -BALANCE.seasons.daysPerSeason * 3;
  return state;
}

function runWinter(state: SimState) {
  const days = BALANCE.seasons.daysPerSeason;
  const sums = {
    heating: 0,
    pumps: 0,
    network: 0,
    fallback: 0,
    charge: 0,
    curtail: 0,
    exp: 0,
    deficit: 0,
  };
  let maxStore = 0;
  for (let t = 0; t < days * TICKS_PER_DAY; t++) {
    stepTick(state);
    const e = state.lastEnergy;
    sums.heating += e.heatingConsumption;
    sums.pumps += e.heatPumpConsumption;
    sums.network += e.networkHeat;
    sums.fallback += e.heatFallback;
    sums.charge += e.heatStoreCharge;
    sums.curtail += e.curtailment;
    sums.exp += e.gridExport;
    sums.deficit += e.deficit;
    maxStore = Math.max(maxStore, state.heatStored);
  }
  return { ...sums, maxStore, served: state.layers.heated.filter((v) => v === 2).length };
}

describe.skip('heat probe', () => {
  it('prints winter pacing', () => {
    const base = runWinter(city(false, 0));
    const heat1 = runWinter(city(true, 1));
    const heat2 = runWinter(city(true, 2));
    const fmt = (r: ReturnType<typeof runWinter>) =>
      Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Math.round(v)]));
    console.table({ base: fmt(base), 'heat+1store': fmt(heat1), 'heat+2stores': fmt(heat2) });
    console.log(
      'electricity for heat: base',
      Math.round(base.heating),
      'with network',
      Math.round(heat1.heating + heat1.pumps),
      'ratio',
      ((heat1.heating + heat1.pumps) / base.heating).toFixed(2),
    );
  });
});
```

Flip `describe.skip` to `describe` locally to run it; never commit it.

- [ ] **Step 2: Run the probe and read it against the spec**

Run: `pnpm vitest run src/sim/heat.probe.test.ts`

Judge against the spec's Balancing section:

1. "electricity for heat … ratio" should sit near `1 / mean COP` for the
   served share — with two plants serving most of a 48-building town,
   roughly 0.4–0.6. Far above: raise `pumpPowerLimit` or `reachHops`
   (too few served); far below: COP too generous, lower `copWarm`.
2. `fallback` should be small but not zero in the coldest hours with two
   plants, so a third plant is a real decision.
3. `maxStore` with one store should approach `storeCapacity` on a windy
   night and `charge` should be a visible share of `curtail + exp`
   compared with `base`; if the store never fills, raise
   `pumpPowerLimit` or lower `storeLossPerTick`; if it is always full and
   never drains, lower `storeCapacity` or raise `storeDischargeLimit`.
4. Cost parity: a store shifts about `storeCapacity / cop` electricity
   per cycle; per shifted electricity unit it should cost more than a
   battery (`batteryCapacity` 3 000 for 2 200ish — check
   `costs.plant[Battery]`) only when the COP is counted, never beat it
   electricity-for-electricity. Adjust `costs.plant[HeatStore]`.
5. Two plants should serve a 4-street town; if one plant already serves
   everything, lower `reachHops`.

Change only `BALANCE.heat`, the two cost rows and the two upkeep rows.
Re-run until the five checks hold; note the measured numbers.

- [ ] **Step 3: Propagate changed numbers**

If `reachHops`, `copWarm` or `copCold` changed: update the tool
descriptions (Task 8) and the help text (Task 13) in both languages, and
the balance table in the spec. Add a short "probe-measured" comment to
any value you moved, in the style of the geothermal cost comments.

- [ ] **Step 4: Delete the probe, run everything**

```bash
rm src/sim/heat.probe.test.ts
pnpm typecheck && pnpm lint && pnpm coverage
```

Expected: PASS and the coverage gate ≥ 90 % holds (heat.ts is fully
exercised by `heat.test.ts`; if a branch slipped, add the missing case
there rather than lowering anything).

- [ ] **Step 5: Format and commit**

```bash
pnpm format
git add -A
git commit -m "balance: tune district heating from the headless probe

<one line per value moved and the measurement behind it>

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## After the last task

- Run `pnpm coverage` and `pnpm build` once more on the branch.
- Merge `feat/heat-sector` into `main` locally (`git merge --no-ff`) but
  **do not push** until the Mac visual pass is done: pushing deploys
  Pages. Visual pass checklist: both plant meshes read at the default
  zoom and on a slope; the Heat overlay's three tones are distinguishable
  from the Services overlay next to it; the energy panel's COP label
  updates through a day; the tool tooltips fit the build bar.
