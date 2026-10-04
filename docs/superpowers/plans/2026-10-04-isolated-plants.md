# Isolated Plants (Grid-Connection Feedback) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Supply plants that reach no building (no line attached, no
building in their supply ring) get a permanent blue-grey bolt, a Supply
overlay tint, clear inspector wording in both languages and an agent
`find_tiles` kind; generation stays untouched.

**Architecture:** The supply-source set moves to `src/shared/plants.ts`
so the renderer can use it. `src/sim/powerGrid.ts` gains
`hasLineAttached` and `isIsolatedPlant`; `energyStep` writes the result
into the plant tile's existing `supplied` layer (`NotConnected` =
isolated, `Supplied` = serves something) and `placePlant` sets it at
once. The icon layer and the Supply overlay react to that status on
supply-plant tiles; the inspector shows "Line attached" and "Serves"
rows for supply plants; `find_tiles` gains `isolated_plant`. No save or
`TileDiff` change.

**Tech Stack:** TypeScript (strict), three.js, React 19, Vitest, pnpm,
oxlint, oxfmt.

**Spec:** `docs/superpowers/specs/2026-10-04-isolated-plants-design.md`

## Global Constraints

- Isolation rule: supply plant (per `isSupplySource`) AND no power line
  on any 4-neighbour AND no tile with `tileType === Empty && density > 0`
  within Chebyshev `BALANCE.energy.lineSupplyRadius`. Damage is not
  consulted. Non-plant tiles and non-supply plants are never isolated.
- `layers.supplied` on a supply-plant tile: `NotConnected` when isolated,
  `Supplied` otherwise; never `Undersupplied`. Every other tile type
  keeps its meaning. No `TileDiff`, save or `SAVE_VERSION` change;
  generation counting is untouched.
- `src/render/` never imports from `src/sim/`; sim code has no magic
  numbers; `pnpm format` after every edit; the pre-commit hook runs
  `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` — never
  `--no-verify`. Lint fails on unused imports/bindings.
- All user-visible strings go through `src/ui/i18n.tsx` with English AND
  German entries.
- Agent-tool parity: new `find_tiles` kind documented in
  `docs/agent-tools.md`.
- Coverage ≥ 90 % on `src/sim` and `src/shared`.
- The suite occasionally hits a transient 30 s timeout on
  `src/sim/integration.test.ts` under sandbox load; retry once.

---

### Task 1: Supply-source set in shared; `hasLineAttached` and `isIsolatedPlant` in the sim

**Files:**

- Create: `src/shared/plants.ts`
- Create: `src/shared/plants.test.ts`
- Modify: `src/sim/powerGrid.ts` (remove the local `SUPPLY_SOURCES`/`isSupplySource`, re-export, add two functions)
- Modify: `src/sim/inspect.ts` (drop the private `hasLineAttached`, import it)
- Test: `src/sim/powerGrid.test.ts`

**Interfaces:**

- Produces: `src/shared/plants.ts` exports `SUPPLY_SOURCES: ReadonlySet<PlantType>` and `isSupplySource(plant: PlantType): boolean`. `src/sim/powerGrid.ts` re-exports `isSupplySource` and exports `hasLineAttached(state, index): boolean` and `isIsolatedPlant(state, index): boolean`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/shared/plants.test.ts
import { describe, expect, it } from 'vitest';
import { PlantType } from './types.ts';
import { SUPPLY_SOURCES, isSupplySource } from './plants.ts';

describe('supply sources', () => {
  it('lists generators and storage, not hubs, parks, stations or heat', () => {
    for (const plant of [
      PlantType.SolarFarm,
      PlantType.WindTurbine,
      PlantType.Battery,
      PlantType.BiogasPlant,
      PlantType.RunOfRiver,
      PlantType.PumpedStorage,
      PlantType.HydrogenPlant,
      PlantType.TidalPlant,
    ]) {
      expect(isSupplySource(plant)).toBe(true);
      expect(SUPPLY_SOURCES.has(plant)).toBe(true);
    }
    for (const plant of [
      PlantType.None,
      PlantType.ChargingHub,
      PlantType.Park,
      PlantType.FireStation,
      PlantType.PoliceStation,
      PlantType.LogisticsDepot,
      PlantType.BusDepot,
      PlantType.HeatPlant,
      PlantType.HeatStore,
    ]) {
      expect(isSupplySource(plant)).toBe(false);
    }
  });
});
```

Note: `GeothermalPlant` is NOT in today's `SUPPLY_SOURCES` (verified with
`grep -n GeothermalPlant src/sim/powerGrid.ts`), so it is deliberately in
neither list — the move must not change membership. Do not "fix" that here;
the controller has logged it as an observation for the user.

Append to `src/sim/powerGrid.test.ts` (add `hasLineAttached`,
`isIsolatedPlant` to the `./powerGrid.ts` import, `buildRoads` from
`./roads.ts`, `Zone`/`TileType` from `./state.ts` if not already there):

```ts
describe('isIsolatedPlant', () => {
  /** A supply plant at (10,10) on an otherwise empty map. */
  function lonePlant(): SimState {
    const state = makeState();
    placePlant(state, at(10, 10), PlantType.WindTurbine);
    return state;
  }
  function house(state: SimState, index: number): void {
    state.layers.zone[index] = Zone.Residential;
    state.layers.density[index] = 1;
  }

  it('flags a supply plant with no line and no building in its ring', () => {
    const state = lonePlant();
    expect(hasLineAttached(state, at(10, 10))).toBe(false);
    expect(isIsolatedPlant(state, at(10, 10))).toBe(true);
  });

  it('is not isolated once a building stands inside the ring, up to the ring edge', () => {
    const inside = lonePlant();
    house(inside, at(10 + R, 10 - R)); // Chebyshev distance exactly R
    expect(isIsolatedPlant(inside, at(10, 10))).toBe(false);
    const outside = lonePlant();
    house(outside, at(10 + R + 1, 10));
    expect(isIsolatedPlant(outside, at(10, 10))).toBe(true);
  });

  it('is not isolated once a power line touches one of its sides', () => {
    const state = lonePlant();
    buildPowerLines(state, [at(11, 10), at(12, 10)]);
    expect(hasLineAttached(state, at(10, 10))).toBe(true);
    expect(isIsolatedPlant(state, at(10, 10))).toBe(false);
  });

  it('never flags empty tiles or non-supply plants', () => {
    const state = makeState();
    expect(isIsolatedPlant(state, at(3, 3))).toBe(false);
    placePlant(state, at(3, 3), PlantType.FireStation);
    expect(isIsolatedPlant(state, at(3, 3))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/shared/plants.test.ts src/sim/powerGrid.test.ts`
Expected: FAIL — `./plants.ts` missing; `isIsolatedPlant` not exported.

- [ ] **Step 3: Create the shared module and move the set**

```ts
// src/shared/plants.ts
import { PlantType } from './types.ts';

/**
 * Plants that feed the grid and seed the line network (hubs, parks,
 * stations, depots and heat plants do not). Shared so the renderer can
 * tell a supply plant from a service building without importing the sim.
 */
export const SUPPLY_SOURCES: ReadonlySet<PlantType> = new Set<PlantType>([
  // copy the exact member list from src/sim/powerGrid.ts here, unchanged
]);

export function isSupplySource(plant: PlantType): boolean {
  return SUPPLY_SOURCES.has(plant);
}
```

In `src/sim/powerGrid.ts`: delete the local `SUPPLY_SOURCES` constant and
`isSupplySource` function, add

```ts
import { isSupplySource } from '../shared/plants.ts';
export { isSupplySource };
```

and append:

```ts
/** A power line touches one of the tile's four sides. */
export function hasLineAttached(state: SimState, index: number): boolean {
  const { powerLine } = state.layers;
  for (const n of neighbors4(index, state.size)) {
    if (powerLine[n] !== 0) return true;
  }
  return false;
}

/**
 * A supply plant that serves nothing: no power line attached and no
 * building anywhere in its supply ring. Pure geometry — damage has its
 * own overlay. Never true for empty tiles or non-supply plants.
 */
export function isIsolatedPlant(state: SimState, index: number): boolean {
  const { tileType, plantType, density } = state.layers;
  if (tileType[index] !== TileType.Plant) return false;
  if (!isSupplySource(plantType[index] as PlantType)) return false;
  if (hasLineAttached(state, index)) return false;
  const size = state.size;
  const radius = BALANCE.energy.lineSupplyRadius;
  const cx = tileX(index, size);
  const cy = tileY(index, size);
  const x0 = Math.max(0, cx - radius);
  const x1 = Math.min(size - 1, cx + radius);
  const y0 = Math.max(0, cy - radius);
  const y1 = Math.min(size - 1, cy + radius);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const t = tileIndex(x, y, size);
      if (tileType[t] === TileType.Empty && density[t] > 0) return false;
    }
  }
  return true;
}
```

(`neighbors4`, `tileIndex`, `tileX`, `tileY`, `TileType`, `PlantType`,
`BALANCE` are already imported in `powerGrid.ts`.)

In `src/sim/inspect.ts`: delete the private `hasLineAttached` function
and add `hasLineAttached` to the existing `from './powerGrid.ts'` import
(`import { hasLineAttached, isSupplySource } from './powerGrid.ts';`).

- [ ] **Step 4: Run the tests and typecheck**

Run: `pnpm format && pnpm typecheck && pnpm vitest run src/shared src/sim/powerGrid.test.ts src/sim/inspect.test.ts src/sim/energy.test.ts`
Expected: PASS. `grep -rn "isSupplySource" src --include=*.ts -l` shows
every importer still resolves (through the re-export or the shared module).

- [ ] **Step 5: Commit**

```bash
git add src/shared/plants.ts src/shared/plants.test.ts src/sim/powerGrid.ts src/sim/inspect.ts src/sim/powerGrid.test.ts
git commit -m "feat(sim): tell isolated supply plants apart; share the supply-source set

isIsolatedPlant: a supply plant with no line attached and no building in
its supply ring. The supply-source set moves to src/shared so the
renderer can use it."
```

---

### Task 2: Write the isolation status into the plant tile's `supplied` layer

**Files:**

- Modify: `src/sim/energy.ts` (`placePlant` tail, `energyStep` after the building loop, import)
- Test: `src/sim/energy.test.ts`, `src/sim/inspect.test.ts`

**Interfaces:**

- Consumes: `isIsolatedPlant` (Task 1); `setSupplied` (private in `energy.ts`, marks dirty on change).
- Produces: `layers.supplied[plant] === NotConnected` iff isolated, `Supplied` otherwise, kept current every `energyStep` and set immediately by `placePlant`.

- [ ] **Step 1: Write the failing tests**

Append to `src/sim/energy.test.ts` (`SupplyStatus`, `Zone`, `placePlant`,
`buildPowerLines`, `energyStep`, `createSimState` are already imported;
add `isIsolatedPlant` from `./powerGrid.ts` if you use it):

```ts
describe('isolated supply plants', () => {
  /** One energy tick with the same minimal input the rest of this file uses. */
  function tick(state: SimState): void {
    energyStep(state, { chargingDemand: 0 });
  }

  it('placePlant marks a lone turbine isolated at once and a village turbine not', () => {
    const lone = createSimState(1, SIZE);
    lone.money = 1e9;
    placePlant(lone, at(10, 10), PlantType.WindTurbine);
    expect(lone.layers.supplied[at(10, 10)]).toBe(SupplyStatus.NotConnected);

    const village = createSimState(1, SIZE);
    village.money = 1e9;
    village.layers.zone[at(12, 10)] = Zone.Residential;
    village.layers.density[at(12, 10)] = 1;
    placePlant(village, at(10, 10), PlantType.WindTurbine);
    expect(village.layers.supplied[at(10, 10)]).toBe(SupplyStatus.Supplied);
  });

  it('a house growing into the ring, or a line attached, lifts the isolation on the next tick', () => {
    const state = createSimState(1, SIZE);
    state.money = 1e9;
    placePlant(state, at(10, 10), PlantType.Battery);
    tick(state);
    expect(state.layers.supplied[at(10, 10)]).toBe(SupplyStatus.NotConnected);

    state.layers.zone[at(13, 13)] = Zone.Residential;
    state.layers.density[at(13, 13)] = 1;
    state.dirty.clear();
    tick(state);
    expect(state.layers.supplied[at(10, 10)]).toBe(SupplyStatus.Supplied);
    expect(state.dirty.has(at(10, 10))).toBe(true);

    state.layers.density[at(13, 13)] = 0;
    tick(state);
    expect(state.layers.supplied[at(10, 10)]).toBe(SupplyStatus.NotConnected);

    buildPowerLines(state, [at(11, 10), at(12, 10)]);
    tick(state);
    expect(state.layers.supplied[at(10, 10)]).toBe(SupplyStatus.Supplied);
  });

  it('leaves non-supply plants alone', () => {
    const state = createSimState(1, SIZE);
    state.money = 1e9;
    placePlant(state, at(10, 10), PlantType.FireStation);
    const before = state.layers.supplied[at(10, 10)];
    tick(state);
    expect(state.layers.supplied[at(10, 10)]).toBe(before);
  });
});
```

Append to `src/sim/inspect.test.ts` inside the existing describe that
holds the "connected only once a line is attached" test:

```ts
it('reports an isolated supply plant as not connected and a village plant as supplied', () => {
  const lone = createSimState(1, SIZE);
  lone.money = 1e9;
  placePlant(lone, at(10, 10), PlantType.WindTurbine);
  expect(inspectTile(lone, at(10, 10))!.supplied).toBe(SupplyStatus.NotConnected);

  const village = createSimState(1, SIZE);
  village.money = 1e9;
  village.layers.zone[at(11, 11)] = Zone.Residential;
  village.layers.density[at(11, 11)] = 1;
  placePlant(village, at(10, 10), PlantType.WindTurbine);
  expect(inspectTile(village, at(10, 10))!.supplied).toBe(SupplyStatus.Supplied);
});
```

(`createSimState`, `PlantType`, `SupplyStatus`, `Zone`, `placePlant`,
`inspectTile` and `at` are already imported/defined in that file.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/sim/energy.test.ts src/sim/inspect.test.ts`
Expected: the new tests FAIL (`supplied` stays 0 for the village plant
after `placePlant`, and never flips to `Supplied`).

- [ ] **Step 3: Implement**

In `src/sim/energy.ts`:

Import: `import { isIsolatedPlant, isSupplySource, recomputeGrid } from './powerGrid.ts';`

Add a helper next to `setSupplied`:

```ts
/**
 * A supply plant's `supplied` flag means "serves something": NotConnected
 * when the plant is isolated (no line, no building in its ring), Supplied
 * otherwise. Buildings keep the usual meaning; other plants are untouched.
 */
function refreshPlantSupply(state: SimState, index: number): void {
  if (!isSupplySource(state.layers.plantType[index] as PlantType)) return;
  setSupplied(
    state,
    index,
    isIsolatedPlant(state, index) ? SupplyStatus.NotConnected : SupplyStatus.Supplied,
  );
}
```

In `placePlant`, after `markDirty(state, tile); bumpGridVersion(state);`
add `refreshPlantSupply(state, tile);`.

In `energyStep`, directly after the building loop (the `for` that ends
with `rooftop += …` and before `// Heat the network could not deliver…`),
add:

```ts
// Supply plants: flag the ones that serve nothing (icon + overlay).
for (let i = 0; i < layers.tileType.length; i++) {
  if (layers.tileType[i] !== TileType.Plant) continue;
  refreshPlantSupply(state, i);
}
```

(`SupplyStatus`, `TileType`, `PlantType` are already imported in
`energy.ts`.)

- [ ] **Step 4: Run the tests**

Run: `pnpm format && pnpm typecheck && pnpm vitest run src/sim/energy.test.ts src/sim/inspect.test.ts src/sim/powerGrid.test.ts src/sim/integration.test.ts src/sim/engine.test.ts`
Expected: PASS, including the determinism tests (the loop adds no RNG).

- [ ] **Step 5: Commit**

```bash
git add src/sim/energy.ts src/sim/energy.test.ts src/sim/inspect.test.ts
git commit -m "feat(sim): flag isolated supply plants through their supplied status

NotConnected = serves nothing, Supplied = a line is attached or a
building stands in the ring; refreshed every tick and on placement."
```

---

### Task 3: Bolt icon and Supply-overlay tint for isolated plants

**Files:**

- Modify: `src/render/iconsMesh.ts`
- Modify: `src/render/overlays.ts`
- Create: `src/render/iconsMesh.test.ts`
- Test: `src/render/overlays.test.ts`

**Interfaces:**

- Consumes: `isSupplySource` from `src/shared/plants.ts` (Task 1); `TileDiff.supplied` on plant tiles (Task 2).
- Produces: `export function supplyColor(tile: { tileType; density; plantType; supplied }): number | null` in `overlays.ts` (pure, used by Supply mode and tests).

- [ ] **Step 1: Write the failing tests**

```ts
// src/render/iconsMesh.test.ts
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { TileDiff } from '../shared/types.ts';
import { PlantType, SupplyStatus, TileType, Zone } from '../shared/types.ts';
import { ElevationField } from './elevationField.ts';
import { IconsMesh } from './iconsMesh.ts';

const SIZE = 8;

function setup(): { icons: THREE.InstancedMesh; layer: IconsMesh } {
  const scene = new THREE.Scene();
  const field = new ElevationField(SIZE);
  field.applyDiffs(
    Array.from({ length: SIZE * SIZE }, (_, index) => ({ index, elevation: 0 }) as TileDiff),
  );
  const layer = new IconsMesh(scene, SIZE, new THREE.PerspectiveCamera(), field);
  const icons = scene.children.find(
    (c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh,
  )!;
  return { icons, layer };
}

function plant(index: number, plantType: PlantType, supplied: SupplyStatus): TileDiff {
  return {
    index,
    tileType: TileType.Plant,
    plantType,
    density: 0,
    zone: Zone.None,
    supplied,
  } as TileDiff;
}

function building(index: number, supplied: SupplyStatus): TileDiff {
  return {
    index,
    tileType: TileType.Empty,
    plantType: PlantType.None,
    density: 1,
    zone: Zone.Residential,
    supplied,
  } as TileDiff;
}

const color = new THREE.Color();

describe('IconsMesh', () => {
  it('shows a permanent blue-grey bolt above an isolated supply plant and drops it when it serves again', () => {
    const { icons, layer } = setup();
    layer.applyDiffs([plant(10, PlantType.WindTurbine, SupplyStatus.NotConnected)]);
    layer.update(0.016, 1);
    expect(icons.count).toBe(1);
    icons.getColorAt(0, color);
    expect(color.getHex()).toBe(0x7fa7c9);
    // Far in the future: a building's undersupply icon would have expired; this one stays.
    layer.update(0.016, 1000);
    expect(icons.count).toBe(1);
    layer.applyDiffs([plant(10, PlantType.WindTurbine, SupplyStatus.Supplied)]);
    layer.update(0.016, 1001);
    expect(icons.count).toBe(0);
  });

  it('ignores non-supply plants and still reds an unconnected building', () => {
    const { icons, layer } = setup();
    layer.applyDiffs([
      plant(10, PlantType.FireStation, SupplyStatus.NotConnected),
      building(20, SupplyStatus.NotConnected),
    ]);
    layer.update(0.016, 1);
    expect(icons.count).toBe(1);
    icons.getColorAt(0, color);
    expect(color.getHex()).toBe(0xe05263);
  });

  it('drops the icon when the plant is bulldozed', () => {
    const { icons, layer } = setup();
    layer.applyDiffs([plant(10, PlantType.SolarFarm, SupplyStatus.NotConnected)]);
    layer.update(0.016, 1);
    expect(icons.count).toBe(1);
    layer.applyDiffs([
      {
        index: 10,
        tileType: TileType.Empty,
        plantType: PlantType.None,
        density: 0,
        zone: Zone.None,
        supplied: SupplyStatus.NotConnected,
      } as TileDiff,
    ]);
    layer.update(0.016, 2);
    expect(icons.count).toBe(0);
  });
});
```

Append to `src/render/overlays.test.ts` (add `PlantType`, `SupplyStatus`
to the types import and `supplyColor` to the overlays import):

```ts
describe('supplyColor', () => {
  it('reds an isolated supply plant and leaves a serving one unpainted', () => {
    const isolated = supplyColor({
      tileType: TileType.Plant,
      density: 0,
      plantType: PlantType.WindTurbine,
      supplied: SupplyStatus.NotConnected,
    });
    const serving = supplyColor({
      tileType: TileType.Plant,
      density: 0,
      plantType: PlantType.WindTurbine,
      supplied: SupplyStatus.Supplied,
    });
    expect(isolated).toBe(0xe05263);
    expect(serving).toBeNull();
  });

  it('keeps colouring buildings by status and ignores stations', () => {
    expect(
      supplyColor({
        tileType: TileType.Empty,
        density: 2,
        plantType: PlantType.None,
        supplied: SupplyStatus.Undersupplied,
      }),
    ).toBe(0xffb347);
    expect(
      supplyColor({
        tileType: TileType.Plant,
        density: 0,
        plantType: PlantType.FireStation,
        supplied: SupplyStatus.NotConnected,
      }),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/render/iconsMesh.test.ts src/render/overlays.test.ts`
Expected: FAIL — plant icons not produced; `supplyColor` not exported.

- [ ] **Step 3: Implement the icon layer**

In `src/render/iconsMesh.ts`:

- Add `import { isSupplySource } from '../shared/plants.ts';` and make sure
  `PlantType` is imported from `../shared/types.ts` (type-only is enough).
- Add the colour after `COLOR_UNDERSUPPLIED`:

```ts
/** Isolated supply plant: information, not an outage, so blue-grey. */
const COLOR_ISOLATED_PLANT = new THREE.Color(0x7fa7c9);
```

- Extend `IconEntry` with `plant: boolean;`.
- Replace the body of `applyDiffs` with:

```ts
  applyDiffs(diffs: TileDiff[]): void {
    for (const diff of diffs) {
      const isBuilding = diff.tileType === TileType.Empty && diff.density > 0;
      const isSupplyPlant =
        diff.tileType === TileType.Plant && isSupplySource(diff.plantType as PlantType);
      if (isSupplyPlant) {
        // A plant that serves nothing (no line, no building in its ring)
        // keeps a permanent marker; it clears the moment it serves again.
        if (diff.supplied === SupplyStatus.NotConnected) {
          this.icons.set(diff.index, {
            status: diff.supplied,
            expiresAt: Number.POSITIVE_INFINITY,
            plant: true,
          });
        } else {
          this.icons.delete(diff.index);
        }
        continue;
      }
      if (isBuilding && diff.supplied !== SupplyStatus.Supplied) {
        this.icons.set(diff.index, {
          status: diff.supplied,
          // Not-connected is a stable status; undersupply lingers so the
          // tick-level flicker does not strobe the icon.
          expiresAt:
            diff.supplied === SupplyStatus.NotConnected
              ? Number.POSITIVE_INFINITY
              : this.nowSeconds + LINGER_SECONDS,
          plant: false,
        });
      } else if (!isBuilding) {
        this.icons.delete(diff.index);
      } else if (this.icons.get(diff.index)?.status === SupplyStatus.NotConnected) {
        // Building became supplied/undersupplied again: drop stale
        // permanent icons, keep lingering ones until they expire.
        this.icons.delete(diff.index);
        if (diff.supplied === SupplyStatus.Undersupplied) {
          this.icons.set(diff.index, {
            status: diff.supplied,
            expiresAt: this.nowSeconds + LINGER_SECONDS,
            plant: false,
          });
        }
      }
    }
  }
```

- In `update`, replace the `setColorAt` colour expression with:

```ts
        entry.plant
          ? COLOR_ISOLATED_PLANT
          : entry.status === SupplyStatus.NotConnected
            ? COLOR_NOT_CONNECTED
            : COLOR_UNDERSUPPLIED,
```

- [ ] **Step 4: Implement the overlay**

In `src/render/overlays.ts`:

- Add `import { isSupplySource } from '../shared/plants.ts';`.
- Add a pure helper next to `damageColor`/`heatColor`:

```ts
/**
 * Supply overlay tint: buildings by status; a supply plant only when it
 * is isolated (serves nothing), so the overlay stays quiet elsewhere.
 */
export function supplyColor(tile: {
  tileType: TileType;
  density: number;
  plantType: PlantType;
  supplied: SupplyStatus;
}): number | null {
  if (tile.tileType === TileType.Empty && tile.density > 0) {
    return SUPPLY_COLORS[tile.supplied] ?? null;
  }
  if (
    tile.tileType === TileType.Plant &&
    isSupplySource(tile.plantType) &&
    tile.supplied === SupplyStatus.NotConnected
  ) {
    return SUPPLY_COLORS[SupplyStatus.NotConnected];
  }
  return null;
}
```

- In `applyDiffs`, extend the "worth storing" condition with
  `|| (diff.tileType === TileType.Plant && isSupplySource(diff.plantType))`
  so supply plants are tracked.
- In `rebuild`, replace the Supply branch body with `colorHex = supplyColor(tile);`.

- [ ] **Step 5: Run the tests**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm vitest run src/render`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/render/iconsMesh.ts src/render/iconsMesh.test.ts src/render/overlays.ts src/render/overlays.test.ts
git commit -m "feat(render): mark isolated supply plants with a blue-grey bolt and in the Supply overlay"
```

---

### Task 4: Inspector wording and help text (EN + DE)

**Files:**

- Modify: `src/ui/TileInspector.tsx` (the `{!isBuilding && (… inspect.connected …)}` block, imports)
- Modify: `src/ui/i18n.tsx` (new keys in both languages; extend `help.icons.body` in both)

**Interfaces:**

- Consumes: `TileInfo.connected` (for supply plants = line attached), `TileInfo.supplied` (Task 2 semantics), `isSupplySource` from `src/shared/plants.ts`.

- [ ] **Step 1: Add the i18n keys**

In the English block of `src/ui/i18n.tsx`, after `'inspect.no': 'no',`:

```ts
  'inspect.lineAttached': 'Line attached',
  'inspect.serves': 'Serves',
  'inspect.servesNearby': 'buildings nearby',
  'inspect.servesNothing': 'no building — output still counts; draw a power line to reach homes',
```

In the German block, after `'inspect.no': 'nein',`:

```ts
  'inspect.lineAttached': 'Leitung angeschlossen',
  'inspect.serves': 'Versorgt',
  'inspect.servesNearby': 'Gebäude im Umkreis',
  'inspect.servesNothing': 'kein Gebäude – Erzeugung zählt trotzdem, Leitung zu den Häusern ziehen',
```

Replace the two `help.icons.body` strings:

EN:

```
'A red bolt above a building means it is not connected to any plant; an orange bolt means the grid cannot cover its demand right now. A blue-grey bolt above a plant means it reaches no building: its output still counts, but nobody nearby uses it — draw a power line toward your homes.'
```

DE:

```
'Ein roter Blitz über einem Gebäude bedeutet: nicht an eine Anlage angeschlossen. Ein oranger Blitz: das Netz kann den Bedarf gerade nicht decken. Ein blaugrauer Blitz über einer Anlage: sie erreicht kein Gebäude. Ihre Erzeugung zählt trotzdem, aber niemand in der Nähe nutzt sie – ziehe eine Leitung zu den Häusern.'
```

If the i18n module has a test asserting EN and DE key sets match, it will
guard the additions.

- [ ] **Step 2: Update the inspector**

In `src/ui/TileInspector.tsx`: import `isSupplySource` from
`'../shared/plants.ts'`, add after `const isStation = …`:

```ts
const isSupplyPlant = info.tileType === TileType.Plant && isSupplySource(info.plantType);
```

Replace the `{!isBuilding && ( <Row label={t('inspect.connected')} … /> )}` block with:

```tsx
{
  !isBuilding && !isSupplyPlant && (
    <Row
      label={t('inspect.connected')}
      value={info.connected ? t('inspect.yes') : t('inspect.no')}
      tone={info.connected ? 'positive' : 'muted'}
    />
  );
}
{
  isSupplyPlant && (
    <>
      <Row
        label={t('inspect.lineAttached')}
        value={info.connected ? t('inspect.yes') : t('inspect.no')}
        tone={info.connected ? 'positive' : 'muted'}
      />
      <Row
        label={t('inspect.serves')}
        value={
          info.supplied === SupplyStatus.NotConnected
            ? t('inspect.servesNothing')
            : t('inspect.servesNearby')
        }
        tone={info.supplied === SupplyStatus.NotConnected ? 'negative' : 'positive'}
        testId="inspect-serves"
      />
    </>
  );
}
```

(`SupplyStatus` is already imported in the file; check that `Row` accepts
`testId` — it does for the supply row above.)

- [ ] **Step 3: Check**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm vitest run src/ui`
Expected: PASS (typecheck catches a missing key in either language).

- [ ] **Step 4: Commit**

```bash
git add src/ui/TileInspector.tsx src/ui/i18n.tsx
git commit -m "feat(ui): say what a plant's grid status means and explain the blue-grey bolt

Supply plants show 'Line attached' and 'Serves' instead of a bare 'Grid
connection' row; the icon help covers the new marker. English and German."
```

---

### Task 5: Agent `find_tiles` kind, docs, full checks

**Files:**

- Modify: `src/agent/tools.ts` (`FIND_KINDS`, the `find_tiles` description, the kind switch)
- Modify: `docs/agent-tools.md:115`
- Test: `src/agent/tools.test.ts`
- Full checks + `node scripts/smoke.mjs`

- [ ] **Step 1: Write the failing test**

Append to `src/agent/tools.test.ts` (reuse `createHarness`, `call`,
`tileIndex`, `SIZE`; import `PlantType`, `SupplyStatus` if missing):

```ts
it('find_tiles isolated_plant lists supply plants that serve nothing', async () => {
  const { call, engine } = createHarness();
  const lone = tileIndex(2, 2, SIZE);
  const wired = tileIndex(20, 20, SIZE);
  engine.state.money = 1e9;
  placePlant(engine.state, lone, PlantType.WindTurbine);
  placePlant(engine.state, wired, PlantType.WindTurbine);
  buildPowerLines(engine.state, [tileIndex(21, 20, SIZE), tileIndex(22, 20, SIZE)]);
  // The tool mirror only sees tiles through tick diffs: advance one tick.
  await call('advance_time', { ticks: 1 });
  const found = await call('find_tiles', { kind: 'isolated_plant' });
  const coords = (found.tiles as Array<{ x: number; y: number }>).map((t) => `${t.x},${t.y}`);
  expect(coords).toContain('2,2');
  expect(coords).not.toContain('20,20');
});
```

`createHarness` returns `{ call, engine }`; other tests in the file read
`engine.state.layers` directly and use `call('advance_time', { ticks: 1 })`
to tick. Import `placePlant` from `../sim/energy.ts` and `buildPowerLines`
from `../sim/powerLines.ts` if the file does not already.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/agent/tools.test.ts`
Expected: FAIL — `isolated_plant` is not a valid kind.

- [ ] **Step 3: Implement**

In `src/agent/tools.ts`:

- Add `'isolated_plant',` to `FIND_KINDS` after `'undersupplied_building',`.
- Import `isSupplySource` from `'../shared/plants.ts'`.
- Add to the kind switch:

```ts
    case 'isolated_plant':
      return (
        tiles.tileType[i] === TileType.Plant &&
        isSupplySource(tiles.plantType[i] as PlantType) &&
        tiles.supplied[i] === SupplyStatus.NotConnected
      );
```

- Extend the `find_tiles` description string: after
  `'undersupplied_building, '` insert
  `'isolated_plant (a supply plant with no power line attached and no building in its supply ring — its output still counts, nobody nearby uses it), '`.

In `docs/agent-tools.md` line 115, add `` `isolated_plant` `` after
`` `undersupplied_building` `` in the kind list and append to the Purpose
cell: `; an isolated plant has no line attached and no building within the supply radius (its output still counts)`.

- [ ] **Step 4: Run everything**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm coverage && node scripts/smoke.mjs`
Expected: all PASS; coverage holds. (Dev server for the smoke script may
need `pnpm dev --host 127.0.0.1 --port 5173 --strictPort` started by hand;
stop it afterwards.)

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools.ts src/agent/tools.test.ts docs/agent-tools.md
git commit -m "feat(agent): find_tiles kind isolated_plant"
```

- [ ] **Step 6: Hand back for the Mac visual pass**

Report: does the blue-grey bolt read as information rather than an
error next to a red building bolt; Supply overlay on a map with several
hill-top turbines; inspector rows on a lone turbine and a village one.
