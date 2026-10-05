# Per-District Grids Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every connected grid component (island) balances generation, storage, flexible load and demand response on its own; import and export run through a new substation plant; islands are visible as an overlay, a district list and an inspector line.

**Architecture:** `recomputeGrid` labels islands into a derived `island` layer (union-find over the line flood and the supply rings). The cascade of `energyStep` moves into a pure `balanceIsland` function that runs once per island; storage levels move from three global numbers into a per-tile `stored` layer so islands split and merge for free; the smart-meter backlog and the demand-response budget live in a per-island map keyed by the island's lowest tile index. `energyStep` orchestrates, sums the island results into the unchanged `lastEnergy` and publishes `lastIslands` for UI and agent.

**Tech Stack:** TypeScript strict, vitest, React 19, three.js, pnpm. Sim stays DOM-free; renderer stays three.js-only; all strings via `src/ui/i18n.tsx` in EN and DE.

**Spec:** `docs/superpowers/specs/2026-10-05-district-grids-design.md`

## Global Constraints

- `src/sim/` never imports DOM or three.js; all randomness through `state.rng`.
- No magic numbers in sim code: every tuning value lives in `BALANCE` (`src/shared/constants.ts`).
- Every user-visible string is an i18n key with an EN and a DE entry.
- `SAVE_VERSION` stays 1; every new save field is optional and old saves load.
- Worker → main sends tile diffs and `GlobalStats`, never the full state.
- New `InstancedMesh` → `frustumCulled = false`.
- New sim command or feature → agent tool parity (`src/agent/tools.ts`, `docs/agent-tools.md`).
- Run `pnpm format` after edits; the pre-commit hook runs `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` and must pass; never `--no-verify`.
- Keep temporary probe files out of `src/` when committing (the hook runs the whole suite).
- Spec deviation decided while planning (flag to the user at hand-off): islands without a substation are **dimmed** in the Grid overlay instead of getting a dashed border — a dashed edge pass is a second mesh with per-edge instances for a cue the dimming already gives; the spec's "dashed border" wording is updated in Task 10.
- Spec refinement: storage charge is spread over an island's tiles in proportion to **headroom** and discharge in proportion to **stored energy** (not capacity) — that is exactly one shared pool and never overfills a tile after a merge. Task 10 updates the spec wording.

---

## File map

| File                                                                           | Responsibility                                                                                                                                                                |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/types.ts`                                                          | `PlantType.Substation`, `OverlayMode.Grid`, `TileDiff.island`, `TileDiff.stored`, `IslandStats`, `GlobalStats.islands`, `TileInfo.island`, `TileInfo.substation`, save fields |
| `src/shared/plants.ts`                                                         | `SUPPLY_SOURCES` gains `Substation`                                                                                                                                           |
| `src/shared/constants.ts`                                                      | substation cost/upkeep, `goals.districtGrid`, comments on the per-substation link                                                                                             |
| `src/sim/powerGrid.ts`                                                         | island labelling (`island` layer, `islandKeys`), `islandOf`, `islandKey`                                                                                                      |
| `src/sim/storage.ts` (new)                                                     | per-tile storage: `storageCapacityAt`, `poolOf`, `chargeTiles`, `dischargeTiles`, `storedByKind`                                                                              |
| `src/sim/islandPools.ts` (new)                                                 | `IslandPool`, `syncIslandPools` (merge/split/prune), daily refill                                                                                                             |
| `src/sim/islandBalance.ts` (new)                                               | `balanceIsland` — the pure cascade for one island                                                                                                                             |
| `src/sim/demandResponse.ts`                                                    | `dispatchCall` pure per-pool form; `callHoursLeft` over pools                                                                                                                 |
| `src/sim/energy.ts`                                                            | orchestrator: per-island census/demand, calls `balanceIsland`, sums, `lastIslands`, flicker                                                                                   |
| `src/sim/heat.ts`                                                              | heat store level per tile, `chargeHeatStore` per island tiles                                                                                                                 |
| `src/sim/vehicles.ts`                                                          | `Vehicle.chargeTile`, `chargingDemandByIsland`                                                                                                                                |
| `src/sim/state.ts`                                                             | layers `island`/`stored`, `islandKeys`, `islandPools`, `lastIslands`, save/load, bulldoze clears `stored`                                                                     |
| `src/sim/tick.ts`                                                              | `buildStats` islands + storage sums                                                                                                                                           |
| `src/sim/inspect.ts`                                                           | `plantStorage` from the tile, `island`, `substation` info                                                                                                                     |
| `src/sim/goals.ts`                                                             | `districtGrid`                                                                                                                                                                |
| `src/agent/tileMirror.ts`, `src/agent/tools.ts`                                | `island` mirror, substation, find kinds, overview/energy_report/inspect fields                                                                                                |
| `src/render/overlays.ts`, `src/render/renderer.ts`, `src/render/plantsMesh.ts` | Grid overlay + selection, per-tile SoC fill, substation recipe                                                                                                                |
| `src/ui/*`                                                                     | tool, panel district list, HUD note, inspector rows, overlay toggle, help, tutorial, i18n                                                                                     |
| `docs/agent-tools.md`, `docs/idea.md`, `docs/plan.md`, spec                    | docs                                                                                                                                                                          |

---

### Task 1: Island labelling in `recomputeGrid`

**Files:**

- Modify: `src/shared/types.ts` (PlantType, TileDiff), `src/shared/plants.ts`, `src/shared/constants.ts`, `src/sim/state.ts` (layers, `islandKeys`, `collectDiffs`), `src/sim/powerGrid.ts`, `src/agent/tileMirror.ts`, `src/ui/TileInspector.tsx:49`, `src/ui/BudgetPanel.tsx:35`, `src/ui/i18n.tsx`
- Test: `src/sim/powerGrid.test.ts`

**Interfaces:**

- Produces: `TileLayers.island: Uint16Array` (0 = none; `energized[i] === 1` iff `island[i] !== 0`), `SimState.islandKeys: number[]` (`islandKeys[n]` = lowest tile index of island n; `islandKeys[0] = -1`), `islandOf(state, index): number`, `islandKey(state, number): number`, `islandCount(state): number`, `PlantType.Substation = 18`, `TileDiff.island: number`.

- [ ] **Step 1: Add the plant type, supply source, costs and the i18n names (keeps typecheck green)**

`src/shared/types.ts`, after `HeatStore: 17,`:

```ts
  /** Gate of a grid island to the outer grid: carries import and export. Generates nothing. */
  Substation: 18,
```

`src/shared/plants.ts`: add `PlantType.Substation,` to `SUPPLY_SOURCES` and extend the comment: "The substation seeds the flood like a generator (it is the island's gate) but generates nothing."

`src/shared/constants.ts` `costs.plant`, after the HeatStore entry:

```ts
      /** Gate to the outer grid, one per island at least: between the heat plant (2_800) and wind (4_500). Probe-tuned in Task 11. */
      [PlantType.Substation]: 3_000,
```

`upkeepPerTick.plant`, after the HeatStore entry:

```ts
      /** Transformer yard: no fuel, no moving parts. */
      [PlantType.Substation]: 0.05,
```

`src/ui/TileInspector.tsx:49` and `src/ui/BudgetPanel.tsx:35`: add `[PlantType.Substation]: 'tool.plant-substation',` beside the HeatStore line.

`src/ui/i18n.tsx` EN, after `'tool.plant-heatstore': 'Heat store',`:

```ts
  'tool.plant-substation': 'Substation',
```

DE, after `'tool.plant-heatstore': 'Wärmespeicher',`:

```ts
  'tool.plant-substation': 'Umspannwerk',
```

(The tool descriptions come in Task 6.) Run `pnpm typecheck`; fix any `Record<PlantType, …>` the compiler flags the same way (`src/agent/tools.ts` maps are keyed by `PlantName`, not `PlantType`, so they stay).

- [ ] **Step 2: Write the failing island tests**

Append to `src/sim/powerGrid.test.ts` (imports: add `islandOf, islandKey, islandCount` to the `./powerGrid.ts` import; `buildRoads` and `placePlant` are already imported; add `import { addDamage } from './disasters.ts';`):

```ts
describe('islands', () => {
  function town(): SimState {
    const state = makeState();
    // Island A: a turbine with a line east; island B: a solar farm far away.
    placePlant(state, at(2, 2), PlantType.WindTurbine);
    buildPowerLines(state, [at(3, 2), at(4, 2), at(5, 2)]);
    placePlant(state, at(20, 20), PlantType.SolarFarm);
    return state;
  }

  it('numbers separate networks ascending by their lowest tile and keys them by it', () => {
    const state = town();
    recomputeGrid(state);
    expect(islandCount(state)).toBe(2);
    expect(islandOf(state, at(2, 2))).toBe(1);
    expect(islandOf(state, at(5, 2))).toBe(1);
    expect(islandOf(state, at(20, 20))).toBe(2);
    expect(islandOf(state, at(12, 12))).toBe(0);
    expect(islandKey(state, 1)).toBe(at(0, 0)); // top-left of the turbine's ring, clipped to the map
    expect(islandKey(state, 2)).toBe(at(20 - R, 20 - R));
  });

  it('energized is exactly island !== 0', () => {
    const state = town();
    recomputeGrid(state);
    const { energized, island } = state.layers;
    for (let i = 0; i < island.length; i++) expect(energized[i] === 1).toBe(island[i] !== 0);
  });

  it('merges islands through a line, through overlapping rings and through a plant in a ring', () => {
    const byLine = town();
    buildPowerLines(
      byLine,
      Array.from({ length: 14 }, (_, i) => at(6 + i, 2)),
    );
    buildPowerLines(
      byLine,
      Array.from({ length: 18 }, (_, i) => at(19, 3 + i)),
    );
    recomputeGrid(byLine);
    expect(islandCount(byLine)).toBe(1);

    const byRing = makeState();
    placePlant(byRing, at(5, 5), PlantType.WindTurbine);
    placePlant(byRing, at(5 + 2 * R, 5), PlantType.SolarFarm); // rings overlap on x = 5 + R
    recomputeGrid(byRing);
    expect(islandCount(byRing)).toBe(1);

    const byPlant = makeState();
    placePlant(byPlant, at(5, 5), PlantType.WindTurbine);
    placePlant(byPlant, at(5 + R, 5), PlantType.Battery); // inside the turbine's ring
    recomputeGrid(byPlant);
    expect(islandCount(byPlant)).toBe(1);
    expect(islandOf(byPlant, at(5 + R, 5))).toBe(1);
  });

  it('a damaged line stretch longer than two rings splits an island and the lower key survives', () => {
    const state = makeState();
    placePlant(state, at(2, 2), PlantType.WindTurbine);
    buildPowerLines(
      state,
      Array.from({ length: 12 }, (_, i) => at(3 + i, 2)),
    );
    placePlant(state, at(15, 2), PlantType.SolarFarm);
    recomputeGrid(state);
    expect(islandCount(state)).toBe(1);
    const keyBefore = islandKey(state, 1);
    // Rings are connections: one dead tile leaves the rings of both ends
    // overlapping, so the gap has to exceed 2 * R tiles (7 here) to split.
    for (let x = 6; x <= 12; x++) addDamage(state, at(x, 2), 10);
    bumpGridVersion(state);
    recomputeGrid(state);
    expect(islandCount(state)).toBe(2);
    expect(islandKey(state, 1)).toBe(keyBefore);
    expect(islandOf(state, at(15, 2))).toBe(2);
  });

  it('a substation seeds the flood and belongs to its island', () => {
    const state = makeState();
    placePlant(state, at(8, 8), PlantType.Substation);
    buildPowerLines(state, [at(9, 8), at(10, 8)]);
    recomputeGrid(state);
    expect(islandCount(state)).toBe(1);
    expect(islandOf(state, at(10 + R, 8))).toBe(1);
  });
});
```

Check `addDamage`'s signature in `src/sim/disasters.ts` (`addDamage(state, index, points)`); adapt the call if it differs.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run src/sim/powerGrid.test.ts`
Expected: FAIL — `islandOf is not a function` / layer `island` undefined.

- [ ] **Step 4: Add the layer, the keys and the diff field**

`src/sim/state.ts` `TileLayers`, after `energized`:

```ts
/** Island number 1.. of the grid component this tile is energised by; 0 = none. Derived, not persisted. */
island: Uint16Array;
```

`createTileLayers`: `island: new Uint16Array(tiles),` after `energized`.
`SimState`, after `gridComputedVersion`:

```ts
  /** islandKeys[n] = lowest tile index of island n (its stable key); islandKeys[0] = -1. Rebuilt by recomputeGrid. */
  islandKeys: number[];
```

`createSimState`: `islandKeys: [-1],` after `gridComputedVersion: -1,`.
`collectDiffs`: add `island: layers.island[index],` after `heated`.

`src/shared/types.ts` `TileDiff`, after `heated`:

```ts
/** Grid island number (1..) this tile belongs to, 0 when not energised. */
island: number;
```

`src/agent/tileMirror.ts`: add `island: number` to the diff shape it reads, a `readonly island: Uint16Array` field, allocate `new Uint16Array(count)` and copy `this.island[i] = diff.island` beside `transitCover` (the three existing spots at lines ~31, 48, 69, 88).

Fix every test helper that builds a `TileDiff` literal by hand with `as TileDiff` casts (they stay valid); `src/render/*.test.ts` literals use casts too.

- [ ] **Step 5: Implement the labelling**

Replace `recomputeGrid` in `src/sim/powerGrid.ts`:

```ts
/** Union-find over tile indices (parent[i] === -1: not in any set yet). */
function findRoot(parent: Int32Array, i: number): number {
  let root = i;
  while (parent[root] !== root) root = parent[root];
  while (parent[i] !== root) {
    const next = parent[i];
    parent[i] = root;
    i = next;
  }
  return root;
}
function unite(parent: Int32Array, a: number, b: number): void {
  const ra = findRoot(parent, a);
  const rb = findRoot(parent, b);
  if (ra === rb) return;
  // The lower root wins so the final numbering by lowest tile is stable.
  if (ra < rb) parent[rb] = ra;
  else parent[ra] = rb;
}

/**
 * Rebuild the energized and island layers when plants or lines changed:
 * flood-fill from every supply plant over 4-connected, undamaged line
 * tiles, then stamp the connection radius around every energised line
 * tile and every supply plant. Tiles stamped from two components unite
 * them (rings are connections, never borders), so every energised tile
 * belongs to exactly one island. Islands are numbered 1.. ascending by
 * their lowest tile index, which is also the island's key.
 */
export function recomputeGrid(state: SimState): void {
  if (state.gridComputedVersion === state.gridVersion) return;
  const { layers } = state;
  const size = state.size;
  const { powerLine, energized, island, tileType, plantType, damage } = layers;
  const radius = BALANCE.energy.lineSupplyRadius;
  const tiles = size * size;

  // 1. Components of sources and the line tiles they reach.
  const parent = new Int32Array(tiles).fill(-1);
  const reached = new Uint8Array(tiles);
  const queue: number[] = [];
  const stamps: number[] = []; // every source and reached line tile
  for (let i = 0; i < tiles; i++) {
    if (tileType[i] !== TileType.Plant || !isSupplySource(plantType[i] as PlantType)) continue;
    if (damage[i] !== 0) continue; // a damaged plant feeds nothing
    parent[i] = i;
    stamps.push(i);
    for (const n of neighbors4(i, size)) {
      if (powerLine[n] === 0 || damage[n] !== 0) continue;
      if (reached[n] === 0) {
        reached[n] = 1;
        parent[n] = n;
        stamps.push(n);
        queue.push(n);
      }
      unite(parent, i, n);
    }
  }
  while (queue.length > 0) {
    const index = queue.pop()!;
    for (const n of neighbors4(index, size)) {
      if (powerLine[n] === 0 || damage[n] !== 0) continue;
      if (reached[n] === 0) {
        reached[n] = 1;
        parent[n] = n;
        stamps.push(n);
        queue.push(n);
      }
      unite(parent, index, n);
    }
  }

  // 2. Stamp rings; a tile in two rings unites their components.
  const stampedBy = new Int32Array(tiles).fill(-1);
  for (const source of stamps) {
    const cx = tileX(source, size);
    const cy = tileY(source, size);
    const x0 = Math.max(0, cx - radius);
    const x1 = Math.min(size - 1, cx + radius);
    const y0 = Math.max(0, cy - radius);
    const y1 = Math.min(size - 1, cy + radius);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const t = tileIndex(x, y, size);
        if (stampedBy[t] === -1) stampedBy[t] = source;
        else unite(parent, stampedBy[t], source);
      }
    }
  }

  // 3. Number islands ascending by lowest tile; the lowest tile is the key.
  energized.fill(0);
  island.fill(0);
  const numberOfRoot = new Map<number, number>();
  const keys: number[] = [-1];
  for (let t = 0; t < tiles; t++) {
    if (stampedBy[t] === -1) continue;
    const root = findRoot(parent, stampedBy[t]);
    let n = numberOfRoot.get(root);
    if (n === undefined) {
      n = keys.length;
      numberOfRoot.set(root, n);
      keys.push(t); // first tile in index order == lowest tile of the island
    }
    island[t] = n;
    energized[t] = 1;
  }
  state.islandKeys = keys;
  state.gridComputedVersion = state.gridVersion;
}

/** Island number of a tile (0 = not energised). Recomputes the grid if stale. */
export function islandOf(state: SimState, index: number): number {
  recomputeGrid(state);
  return state.layers.island[index];
}

/** Stable key (lowest tile index) of island `number`; -1 for 0 or unknown. */
export function islandKey(state: SimState, number: number): number {
  recomputeGrid(state);
  return state.islandKeys[number] ?? -1;
}

/** Number of islands on the map. */
export function islandCount(state: SimState): number {
  recomputeGrid(state);
  return state.islandKeys.length - 1;
}
```

`Uint16Array` caps islands at 65 535 — far above any 128×128 map's possible components; note that in the layer comment.

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run src/sim/powerGrid.test.ts src/sim/energy.test.ts src/agent`
Expected: PASS (the energized semantics are unchanged, so existing tests hold).

- [ ] **Step 7: Format, full checks, commit**

```bash
pnpm format && pnpm typecheck && pnpm lint && pnpm test
git add -A src
git commit -m "feat(sim): label grid islands in recomputeGrid; Substation plant type

recomputeGrid now labels every energised tile with its island number
(union-find over the line flood and the supply rings), numbered
ascending by lowest tile index, which is the island's stable key.
energized stays exactly island !== 0. PlantType.Substation joins the
supply sources (it seeds the flood, generates nothing); cost, upkeep
and names so the type checks; the tool and mesh follow later."
```

---

### Task 2: Storage per tile

**Files:**

- Create: `src/sim/storage.ts`, `src/sim/storage.test.ts`
- Modify: `src/sim/state.ts` (layer `stored`, save/load, bulldoze), `src/shared/types.ts` (SaveGame `stored`, `TileDiff.stored`), `src/sim/heat.ts`, `src/sim/inspect.ts` (`plantStorage`), `src/sim/tick.ts` (`buildStats`), `src/sim/energy.ts` (placePlant resets `stored`), `src/sim/roads.ts` (bulldoze), `src/render/plantsMesh.ts` (per-tile SoC fill)
- Test: `src/sim/storage.test.ts`, `src/sim/state.test.ts`, `src/sim/heat.test.ts`, `src/render/plantsMesh.test.ts`

**Interfaces:**

- Produces:
  ```ts
  // src/sim/storage.ts
  export function storageCapacityAt(state: SimState, index: number): number; // 0 unless an intact Battery/PumpedStorage/HydrogenPlant/HeatStore tile
  export function storageTilesOfKind(
    state: SimState,
    plant: PlantType,
    islandNumber?: number,
  ): number[];
  export function poolOf(
    state: SimState,
    tiles: readonly number[],
  ): { stored: number; capacity: number };
  export function chargeTiles(state: SimState, tiles: readonly number[], energy: number): void; // ∝ headroom, clamps at capacity
  export function dischargeTiles(state: SimState, tiles: readonly number[], energy: number): void; // ∝ stored, never below 0
  export function scaleTiles(state: SimState, tiles: readonly number[], factor: number): void; // standing losses
  export function storedByKind(state: SimState, plant: PlantType): number;
  ```
- The global `storedEnergy`, `pumpedStorageEnergy`, `hydrogenEnergy`, `heatStored` are **removed** from `SimState` in this task; `energyStep` keeps compiling by reading/writing the pools through these helpers (its per-island rewrite is Task 5, but this task already routes the single global cascade through tile pools so every step is green).

- [ ] **Step 1: Write the failing storage tests**

`src/sim/storage.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BALANCE } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { PlantType } from '../shared/types.ts';
import { addDamage } from './disasters.ts';
import { placePlant } from './energy.ts';
import { createSimState, type SimState } from './state.ts';
import {
  chargeTiles,
  dischargeTiles,
  poolOf,
  scaleTiles,
  storageCapacityAt,
  storageTilesOfKind,
  storedByKind,
} from './storage.ts';

const SIZE = 16;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);

function withBatteries(): SimState {
  const state = createSimState(1, SIZE);
  state.money = 1e9;
  placePlant(state, at(2, 2), PlantType.Battery);
  placePlant(state, at(6, 2), PlantType.Battery);
  return state;
}

describe('storage per tile', () => {
  it('capacity comes from the plant on the tile and is 0 for damaged or other tiles', () => {
    const state = withBatteries();
    expect(storageCapacityAt(state, at(2, 2))).toBe(BALANCE.energy.batteryCapacity);
    expect(storageCapacityAt(state, at(3, 3))).toBe(0);
    placePlant(state, at(10, 2), PlantType.SolarFarm);
    expect(storageCapacityAt(state, at(10, 2))).toBe(0);
    addDamage(state, at(2, 2), 10);
    expect(storageCapacityAt(state, at(2, 2))).toBe(0);
  });

  it('charges in proportion to headroom and never past capacity', () => {
    const state = withBatteries();
    const tiles = storageTilesOfKind(state, PlantType.Battery);
    state.layers.stored[at(2, 2)] = 1_000; // headroom 2_000 vs 3_000
    chargeTiles(state, tiles, 500);
    expect(state.layers.stored[at(2, 2)]).toBeCloseTo(1_000 + 200, 3);
    expect(state.layers.stored[at(6, 2)]).toBeCloseTo(300, 3);
    chargeTiles(state, tiles, 1e9);
    expect(poolOf(state, tiles).stored).toBeCloseTo(2 * BALANCE.energy.batteryCapacity, 3);
  });

  it('discharges in proportion to stored energy and never below zero', () => {
    const state = withBatteries();
    const tiles = storageTilesOfKind(state, PlantType.Battery);
    state.layers.stored[at(2, 2)] = 900;
    state.layers.stored[at(6, 2)] = 300;
    dischargeTiles(state, tiles, 400);
    expect(state.layers.stored[at(2, 2)]).toBeCloseTo(600, 3);
    expect(state.layers.stored[at(6, 2)]).toBeCloseTo(200, 3);
    dischargeTiles(state, tiles, 1e9);
    expect(poolOf(state, tiles).stored).toBe(0);
  });

  it('pool and storedByKind sum the tiles; scaleTiles applies a standing loss', () => {
    const state = withBatteries();
    state.layers.stored[at(2, 2)] = 100;
    state.layers.stored[at(6, 2)] = 50;
    expect(storedByKind(state, PlantType.Battery)).toBeCloseTo(150, 6);
    scaleTiles(state, storageTilesOfKind(state, PlantType.Battery), 0.5);
    expect(storedByKind(state, PlantType.Battery)).toBeCloseTo(75, 6);
    expect(poolOf(state, []).capacity).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/sim/storage.test.ts`
Expected: FAIL — module `./storage.ts` not found.

- [ ] **Step 3: Implement `src/sim/storage.ts` and the `stored` layer**

`src/sim/state.ts` `TileLayers`, after `damage`:

```ts
/** Energy held on a storage plant tile (battery / pumped / hydrogen energy units, heat units on a heat store). Persisted. */
stored: Float32Array;
```

`createTileLayers`: `stored: new Float32Array(tiles),`.

`src/sim/storage.ts`:

```ts
import { BALANCE } from '../shared/constants.ts';
import { PlantType, TileType } from '../shared/types.ts';
import { pumpedHeadAt } from './terrain.ts';
import type { SimState } from './state.ts';

/**
 * Storage lives on the plant tiles: `layers.stored` holds what each
 * battery, pumped-storage plant, hydrogen plant or heat store holds. An
 * island's pool is the sum over its tiles of one kind; charging spreads
 * in proportion to headroom and discharging in proportion to stored
 * energy, which is exactly one shared pool and never overfills a tile
 * after islands merge. A damaged plant has no capacity (its level is
 * frozen until repaired).
 */
export function storageCapacityAt(state: SimState, index: number): number {
  const { tileType, plantType, damage } = state.layers;
  if (tileType[index] !== TileType.Plant || damage[index] !== 0) return 0;
  switch (plantType[index] as PlantType) {
    case PlantType.Battery:
      return BALANCE.energy.batteryCapacity;
    case PlantType.PumpedStorage:
      return (
        BALANCE.energy.pumpedStorageCapacity *
        (1 + BALANCE.terrain.headBonusPerLevel * pumpedHeadAt(state, index))
      );
    case PlantType.HydrogenPlant:
      return BALANCE.hydrogen.capacity;
    case PlantType.HeatStore:
      return BALANCE.heat.storeCapacity;
    default:
      return 0;
  }
}

/** Intact tiles of one storage kind, optionally only those on island `islandNumber`. */
export function storageTilesOfKind(
  state: SimState,
  plant: PlantType,
  islandNumber?: number,
): number[] {
  const { tileType, plantType, damage, island } = state.layers;
  const tiles: number[] = [];
  for (let i = 0; i < tileType.length; i++) {
    if (tileType[i] !== TileType.Plant || plantType[i] !== plant || damage[i] !== 0) continue;
    if (islandNumber !== undefined && island[i] !== islandNumber) continue;
    tiles.push(i);
  }
  return tiles;
}

export function poolOf(
  state: SimState,
  tiles: readonly number[],
): { stored: number; capacity: number } {
  let stored = 0;
  let capacity = 0;
  for (const t of tiles) {
    const cap = storageCapacityAt(state, t);
    // Clamp here too: a save edited by hand may hold more than fits.
    if (state.layers.stored[t] > cap) state.layers.stored[t] = cap;
    stored += state.layers.stored[t];
    capacity += cap;
  }
  return { stored, capacity };
}

export function chargeTiles(state: SimState, tiles: readonly number[], energy: number): void {
  if (energy <= 0) return;
  let headroom = 0;
  for (const t of tiles) headroom += storageCapacityAt(state, t) - state.layers.stored[t];
  if (headroom <= 0) return;
  const share = Math.min(1, energy / headroom);
  for (const t of tiles) {
    const room = storageCapacityAt(state, t) - state.layers.stored[t];
    state.layers.stored[t] += room * share;
  }
}

export function dischargeTiles(state: SimState, tiles: readonly number[], energy: number): void {
  if (energy <= 0) return;
  let stored = 0;
  for (const t of tiles) stored += state.layers.stored[t];
  if (stored <= 0) return;
  const share = Math.min(1, energy / stored);
  for (const t of tiles) state.layers.stored[t] -= state.layers.stored[t] * share;
}

export function scaleTiles(state: SimState, tiles: readonly number[], factor: number): void {
  for (const t of tiles) state.layers.stored[t] *= factor;
}

export function storedByKind(state: SimState, plant: PlantType): number {
  return poolOf(state, storageTilesOfKind(state, plant)).stored;
}
```

Check where `pumpedHeadAt` lives (`grep -n 'export function pumpedHeadAt' src/sim/*.ts`) and import from there.

- [ ] **Step 4: Remove the global pools and route every reader through the tiles**

1. `src/sim/state.ts`: delete `storedEnergy`, `pumpedStorageEnergy`, `hydrogenEnergy`, `heatStored` from `SimState` and `createSimState`. In `placePlant` (`src/sim/energy.ts`, after `layers.plantType[tile] = plant;`) add `layers.stored[tile] = 0;`. In the bulldoze path of `src/sim/roads.ts` (where a plant tile is cleared — `grep -n 'plantType\[.*\] = PlantType.None' src/sim/roads.ts`) add `layers.stored[index] = 0;`.
2. `src/sim/energy.ts` (the still-global cascade, until Task 5): at the top of the cascade read
   ```ts
   const batteryTiles = storageTilesOfKind(state, PlantType.Battery);
   const pumpedTiles = storageTilesOfKind(state, PlantType.PumpedStorage);
   const hydrogenTiles = storageTilesOfKind(state, PlantType.HydrogenPlant);
   const batteryPool = poolOf(state, batteryTiles);
   const pumpedPool = poolOf(state, pumpedTiles);
   const hydrogenPool = poolOf(state, hydrogenTiles);
   ```
   Replace `state.storedEnergy` reads by `batteryPool.stored` (same for pumped/hydrogen) and every write `state.storedEnergy = x.stored` by `chargeTiles(state, batteryTiles, absorbed * efficiency)` / `dischargeTiles(state, batteryTiles, released)` and the trading writes by `dischargeTiles(..., fromBattery)` / `chargeTiles(..., bought * efficiency)`. `storageCapacity` becomes `batteryPool.capacity`, `pumpedCapacity` → `pumpedPool.capacity`, `hydrogenCapacity` → `hydrogenPool.capacity`. The history `soc` reads `(batteryPool.stored + pumpedPool.stored) / totalCapacity` after the cascade via fresh `poolOf` calls.
3. `src/sim/heat.ts`: `heatStep` — replace `state.heatStored` with the heat-store tiles:
   ```ts
   const stores = storageTilesOfKind(state, PlantType.HeatStore);
   const pool = poolOf(state, stores);
   const capacity = pool.capacity;
   ...
   const fromStore = Math.min(demand, census.heatStores * cfg.storeDischargeLimit, pool.stored);
   dischargeTiles(state, stores, fromStore);
   ...
   scaleTiles(state, stores, 1 - cfg.storeLossPerTick);
   return { ..., headroom: Math.max(0, capacity - (pool.stored - fromStore) * (1 - cfg.storeLossPerTick)), capacity, ... };
   ```
   `chargeHeatStore(state, heat, surplus, stores: readonly number[])`: same maths, then `chargeTiles(state, stores, absorbed * heat.cop)`. The call in `energy.ts` passes `storageTilesOfKind(state, PlantType.HeatStore)` for now.
4. `src/sim/inspect.ts` `plantStorage`: replace the census-average arithmetic with
   ```ts
   const capacity = storageCapacityAt(state, index);
   return capacity > 0
     ? { stored: state.layers.stored[index], capacity }
     : { stored: 0, capacity: 0 };
   ```
5. `src/sim/tick.ts` `buildStats`: `storedEnergy: storedByKind(state, PlantType.Battery)`, `pumpedStoredEnergy: storedByKind(state, PlantType.PumpedStorage)`, `hydrogenStoredEnergy: storedByKind(state, PlantType.HydrogenPlant)`, `heatStored: storedByKind(state, PlantType.HeatStore)`.
6. Save/load — `src/shared/types.ts` `SaveGame`: keep the four old fields but make them optional (`storedEnergy?: number`), add
   ```ts
   /** Storage per plant tile as [index, value, index, value, …] (absent in older saves: the pool fields above are spread over the tiles). */
   stored?: number[];
   ```
   `serializeState`: drop the four fields, emit `stored` for every tile with `layers.stored[i] > 0`. `deserializeState`: after the layers are restored (plantType and damage must be in place), if `save.stored` → write pairs (clamped by `storageCapacityAt`), else spread each legacy field over the intact tiles of its kind in proportion to capacity:
   ```ts
   function spreadLegacyPool(state: SimState, plant: PlantType, total: number | undefined): void {
     if (!total || !Number.isFinite(total) || total <= 0) return;
     const tiles = storageTilesOfKind(state, plant);
     const { capacity } = poolOf(state, tiles);
     if (capacity <= 0) return;
     const share = Math.min(1, total / capacity);
     for (const t of tiles) state.layers.stored[t] = storageCapacityAt(state, t) * share;
   }
   spreadLegacyPool(state, PlantType.Battery, save.storedEnergy);
   spreadLegacyPool(state, PlantType.PumpedStorage, save.pumpedStorageEnergy);
   spreadLegacyPool(state, PlantType.HydrogenPlant, save.hydrogenEnergy);
   spreadLegacyPool(state, PlantType.HeatStore, save.heatStored);
   ```
7. `TileDiff.stored` (share 0..1 of capacity, 0 off storage tiles) in `src/shared/types.ts` and `collectDiffs`: `stored: storageCapacityAt(state, index) > 0 ? layers.stored[index] / storageCapacityAt(state, index) : 0,` (import from `./storage.ts`; storage.ts imports only a type from state.ts, so no cycle). Mark a storage tile dirty whenever its share crosses a 1/64 step: in `energyStep` after the cascade, for each storage tile compare `Math.floor(64 * share)` with the previous value kept in a module-level `Map<number, number>` on the state — simpler: add `lastStoredStep: Uint8Array` to `TileLayers` (derived, not persisted) and in `energyStep`'s end loop `if (step !== layers.lastStoredStep[i]) { layers.lastStoredStep[i] = step; markDirty(state, i); }`.
8. `src/render/plantsMesh.ts`: the SoC fill is per tile now. Keep `batteryPositions` but store `{ position, index }`; `applyDiffs` records `diff.stored` per battery tile in a `Map<number, number>`; `writeSocFills` uses the tile's share; `setEnvironment` no longer reads `stateOfCharge` (leave the field in `RenderEnvironment` for now — Task 7 removes it). Update `plantsMesh.test.ts` expectations that the fill follows `diff.stored`.
9. Fix compile errors across tests that set `state.storedEnergy` etc.: replace with `state.layers.stored[tile] = value` on the plant tile the test built (every such test places its storage plant on a known tile), or with `chargeTiles(state, storageTilesOfKind(state, PlantType.Battery), value)`.

- [ ] **Step 5: Serialization tests**

Append to `src/sim/state.test.ts`:

```ts
describe('storage per tile in saves', () => {
  it('round-trips stored energy per tile and spreads legacy pool fields over the tiles', () => {
    const state = createSimState(3, SIZE);
    state.money = 1e9;
    placePlant(state, at(2, 2), PlantType.Battery);
    placePlant(state, at(5, 2), PlantType.Battery);
    state.layers.stored[at(2, 2)] = 1_234;
    const loaded = deserializeState(serializeState(state));
    expect(loaded.layers.stored[at(2, 2)]).toBeCloseTo(1_234, 3);
    expect(loaded.layers.stored[at(5, 2)]).toBe(0);

    const legacy = serializeState(state);
    delete legacy.stored;
    legacy.storedEnergy = 3_000; // one battery's worth across two batteries
    const migrated = deserializeState(legacy);
    expect(migrated.layers.stored[at(2, 2)]).toBeCloseTo(1_500, 3);
    expect(migrated.layers.stored[at(5, 2)]).toBeCloseTo(1_500, 3);
  });
});
```

(Use the file's existing `SIZE`/`at`/imports; add `placePlant`, `serializeState`, `deserializeState` imports if missing.)

- [ ] **Step 6: Run everything**

Run: `pnpm typecheck && pnpm vitest run src/sim src/render src/agent`
Expected: PASS. Pay attention to `heat.test.ts` (store level now on tiles) and `energy.test.ts` (tests that read `state.storedEnergy`).

- [ ] **Step 7: Format, commit**

```bash
pnpm format && pnpm lint && pnpm format:check
git add -A src
git commit -m "refactor(sim): storage levels live on the plant tiles

layers.stored replaces the four global pools; charging spreads in
proportion to headroom, discharging in proportion to stored energy,
which is exactly one shared pool and lets islands split and merge
without redistribution. Saves carry stored per tile (sparse pairs);
older saves spread their pool fields over the tiles by capacity. The
battery SoC fill and the inspector read the tile."
```

---

### Task 3: Per-island pools (flex backlog, call budget)

**Files:**

- Create: `src/sim/islandPools.ts`, `src/sim/islandPools.test.ts`
- Modify: `src/sim/state.ts` (`islandPools`, save/load; remove `flexBacklog` and `demandResponse.callBudget`), `src/shared/types.ts` (SaveGame `islandPools`), `src/sim/demandResponse.ts` (`dispatchCall`, `callHoursLeft`), `src/sim/energy.ts` (use the largest island's pool until Task 5), `src/sim/tick.ts`
- Test: `src/sim/islandPools.test.ts`, `src/sim/demandResponse.test.ts`, `src/sim/state.test.ts`

**Interfaces:**

- Produces:
  ```ts
  // src/sim/islandPools.ts
  export interface IslandPool {
    flexBacklog: number;
    callBudget: number;
  }
  export function syncIslandPools(state: SimState): void; // after recomputeGrid: merge, split, prune, daily refill
  export function poolForIsland(state: SimState, islandNumber: number): IslandPool; // throws on 0
  // src/sim/demandResponse.ts
  export function dispatchCall(
    pool: IslandPool,
    active: boolean,
    businessDemand: number,
    industrialDemand: number,
    shortfall: number,
    spotPrice: number,
    importCapacity: number,
  ): DemandResponseCall;
  export function callHoursLeft(state: SimState): number; // minimum over islands, full when none
  ```
- `SimState.islandPools: Map<number, IslandPool>` keyed by island key; `SimState.poolsSyncedVersion: number`.

- [ ] **Step 1: Write the failing tests**

`src/sim/islandPools.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { TICKS_PER_DAY } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { PlantType } from '../shared/types.ts';
import { addDamage } from './disasters.ts';
import { callBudgetTicks } from './demandResponse.ts';
import { placePlant } from './energy.ts';
import { poolForIsland, syncIslandPools } from './islandPools.ts';
import { buildPowerLines } from './powerLines.ts';
import { islandCount, islandKey, recomputeGrid } from './powerGrid.ts';
import { bumpGridVersion, createSimState, type SimState } from './state.ts';

const SIZE = 24;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);

function twoIslands(): SimState {
  const state = createSimState(1, SIZE);
  state.money = 1e9;
  placePlant(state, at(2, 2), PlantType.WindTurbine);
  placePlant(state, at(18, 18), PlantType.SolarFarm);
  recomputeGrid(state);
  syncIslandPools(state);
  return state;
}

describe('island pools', () => {
  it('gives every island a fresh pool and prunes vanished keys', () => {
    const state = twoIslands();
    expect(islandCount(state)).toBe(2);
    expect(poolForIsland(state, 1)).toEqual({ flexBacklog: 0, callBudget: callBudgetTicks() });
    expect(state.islandPools.size).toBe(2);
  });

  it('a merge adds the backlogs and keeps the smaller budget under the surviving key', () => {
    const state = twoIslands();
    poolForIsland(state, 1).flexBacklog = 100;
    poolForIsland(state, 1).callBudget = 10;
    poolForIsland(state, 2).flexBacklog = 50;
    poolForIsland(state, 2).callBudget = 4;
    buildPowerLines(
      state,
      Array.from({ length: 16 }, (_, i) => at(3 + i, 2)),
    );
    buildPowerLines(
      state,
      Array.from({ length: 16 }, (_, i) => at(18, 3 + i)),
    );
    recomputeGrid(state);
    syncIslandPools(state);
    expect(islandCount(state)).toBe(1);
    expect(state.islandPools.size).toBe(1);
    expect(poolForIsland(state, 1)).toEqual({ flexBacklog: 150, callBudget: 4 });
  });

  it('a split leaves the surviving key everything and starts the new island fresh', () => {
    const state = createSimState(1, SIZE);
    state.money = 1e9;
    placePlant(state, at(2, 2), PlantType.WindTurbine);
    buildPowerLines(
      state,
      Array.from({ length: 12 }, (_, i) => at(3 + i, 2)),
    );
    placePlant(state, at(15, 2), PlantType.SolarFarm);
    recomputeGrid(state);
    syncIslandPools(state);
    poolForIsland(state, 1).flexBacklog = 80;
    poolForIsland(state, 1).callBudget = 3;
    for (let x = 6; x <= 12; x++) addDamage(state, at(x, 2), 10); // a gap longer than two rings
    bumpGridVersion(state);
    recomputeGrid(state);
    syncIslandPools(state);
    expect(islandCount(state)).toBe(2);
    expect(poolForIsland(state, 1)).toEqual({ flexBacklog: 80, callBudget: 3 });
    expect(poolForIsland(state, 2)).toEqual({ flexBacklog: 0, callBudget: callBudgetTicks() });
    expect(state.islandPools.get(islandKey(state, 2))).toBeDefined();
  });

  it('refills every budget on the first tick of a day', () => {
    const state = twoIslands();
    poolForIsland(state, 1).callBudget = 0;
    state.tick = TICKS_PER_DAY;
    syncIslandPools(state);
    expect(poolForIsland(state, 1).callBudget).toBe(callBudgetTicks());
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/sim/islandPools.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/sim/islandPools.ts`:

```ts
import { TICKS_PER_DAY } from '../shared/constants.ts';
import { callBudgetTicks } from './demandResponse.ts';
import { recomputeGrid } from './powerGrid.ts';
import type { SimState } from './state.ts';

/** Per-island state that must survive a grid recompute: keyed by the island's lowest tile index. */
export interface IslandPool {
  /** Deferred flexible energy waiting for renewable surplus (energy units). */
  flexBacklog: number;
  /** Ticks of full-pool demand-response shedding still allowed today (fractions for partial calls). */
  callBudget: number;
}

function freshPool(): IslandPool {
  return { flexBacklog: 0, callBudget: callBudgetTicks() };
}

/**
 * Bring `state.islandPools` in line with the islands of this tick.
 * Merge: a vanished key whose tile now sits on another island adds its
 * backlog to that island's pool and takes the smaller budget. Split: the
 * surviving key keeps everything, the new key starts fresh. Keys whose
 * tile is no longer energised are dropped. The daily budget refill runs
 * here for every pool on the first tick of a day.
 */
export function syncIslandPools(state: SimState): void {
  recomputeGrid(state);
  const { island } = state.layers;
  const keys = state.islandKeys;
  if (state.poolsSyncedVersion !== state.gridComputedVersion) {
    const current = new Set<number>();
    for (let n = 1; n < keys.length; n++) current.add(keys[n]);
    for (const [key, pool] of [...state.islandPools]) {
      if (current.has(key)) continue;
      const n = island[key];
      if (n !== 0) {
        const target = keys[n];
        const into = state.islandPools.get(target) ?? freshPool();
        into.flexBacklog += pool.flexBacklog;
        into.callBudget = Math.min(into.callBudget, pool.callBudget);
        state.islandPools.set(target, into);
      }
      state.islandPools.delete(key);
    }
    for (const key of current) {
      if (!state.islandPools.has(key)) state.islandPools.set(key, freshPool());
    }
    state.poolsSyncedVersion = state.gridComputedVersion;
  }
  if (state.tick % TICKS_PER_DAY === 0) {
    for (const pool of state.islandPools.values()) pool.callBudget = callBudgetTicks();
  }
}

export function poolForIsland(state: SimState, islandNumber: number): IslandPool {
  const key = state.islandKeys[islandNumber];
  const pool = key === undefined || key < 0 ? undefined : state.islandPools.get(key);
  if (!pool) throw new Error(`no pool for island ${islandNumber}`);
  return pool;
}
```

`src/sim/state.ts`: `SimState` gains `islandPools: Map<number, IslandPool>` and `poolsSyncedVersion: number` (init `new Map()` / `-1`); remove `flexBacklog` and `demandResponse.callBudget` (`demandResponse: { active: boolean }`). `serializeState`: `islandPools: [...state.islandPools].map(([key, p]) => [key, p.flexBacklog, p.callBudget])`, drop `flexBacklog` and `demandResponse.callBudget`. `deserializeState`: if `save.islandPools` → restore (skip non-finite); else, if `save.flexBacklog` or `save.demandResponse?.callBudget` exist, after `recomputeGrid(state)` put them on the largest island's key (most tiles; none → ignore). `SaveGame` (`src/shared/types.ts`): `islandPools?: [number, number, number][]`, keep `flexBacklog?` and `demandResponse?.callBudget?` optional for reading.

`src/sim/demandResponse.ts`: replace `dispatchDemandResponse` with the pure form and a thin wrapper used by the still-global `energyStep` until Task 5:

```ts
export function dispatchCall(
  pool: IslandPool,
  active: boolean,
  businessDemand: number,
  industrialDemand: number,
  shortfall: number,
  spotPrice: number,
  importCapacity: number,
): DemandResponseCall {
  if (!active) return { pool: 0, shed: 0 };
  const { shedShare, industrialShedShare, activationPricePerEnergyUnit } = BALANCE.demandResponse;
  const { importCostPerEnergyUnit } = BALANCE.market;
  const size = shedShare * businessDemand + industrialShedShare * industrialDemand;
  if (size <= 0 || shortfall <= 0) return { pool: size, shed: 0 };
  const available = size * Math.min(1, Math.max(0, pool.callBudget));
  const importPrice = importCostPerEnergyUnit * spotPrice;
  const economic = importPrice >= activationPricePerEnergyUnit ? Math.min(shortfall, available) : 0;
  const secure = Math.min(Math.max(0, shortfall - importCapacity), available);
  const shed = Math.max(economic, secure);
  pool.callBudget = Math.max(0, pool.callBudget - shed / size);
  return { pool: size, shed };
}

/** Call hours left today, for the HUD: the tightest island, or the full day without any. */
export function callHoursLeft(state: SimState): number {
  let budget = callBudgetTicks();
  for (const pool of state.islandPools.values()) budget = Math.min(budget, pool.callBudget);
  return (budget * 24) / TICKS_PER_DAY;
}
```

`energyStep` (still global until Task 5): call `syncIslandPools(state)` right after `recomputeGrid`, pick `const pool = state.islandKeys.length > 1 ? poolForIsland(state, largestIsland(state)) : freshScratchPool` where `largestIsland` counts tiles per island number (a short loop), read/write `pool.flexBacklog` instead of `state.flexBacklog`, and call `dispatchCall(pool, state.demandResponse.active, businessDemand, industrialDemand, shortfall, spotPrice, BALANCE.market.importCapacity)`. `setDemandResponse` unchanged. Update `demandResponse.test.ts` to the new signature (build a pool literal) and `smartMeters`/`energy` tests that read `state.flexBacklog` to read the island's pool (`poolForIsland(state, 1).flexBacklog`).

- [ ] **Step 4: Run tests, format, commit**

Run: `pnpm typecheck && pnpm vitest run src/sim src/agent`
Expected: PASS.

```bash
pnpm format && pnpm lint
git add -A src
git commit -m "feat(sim): per-island pools for the flex backlog and the call budget

islandPools keys the smart-meter backlog and the demand-response budget
by the island's lowest tile index; a merge adds backlogs and keeps the
smaller budget, a split starts the new island fresh, vanished keys are
pruned, the daily refill runs per pool. dispatchCall is the pure
per-pool form of the contract. Saves carry the pools; the old global
fields load onto the largest island."
```

---

### Task 4: `balanceIsland` — the pure cascade

**Files:**

- Create: `src/sim/islandBalance.ts`, `src/sim/islandBalance.test.ts`
- Modify: `src/sim/energy.ts` (export `chargePool`/`dischargePool` or move them), `src/sim/heat.ts` (`chargeHeatStore` pure variant)

**Interfaces:**

- Produces:

  ```ts
  export interface StoragePool {
    stored: number;
    capacity: number;
    powerLimit: number;
    efficiency: number;
  }
  export interface IslandInput {
    timeOfDay: number;
    season: { sunrise: number; sunset: number };
    spotPrice: number;
    marketTrading: boolean;
    demandResponseActive: boolean;
    coverage: number; // metered coverage 0..1
    generation: {
      solar: number;
      wind: number;
      rooftop: number;
      hydro: number;
      tidal: number;
      geothermal: number;
    };
    biogasCapacity: number; // biogasPlants * biogasMaxOutput
    demand: {
      buildings: number;
      heating: number;
      cooling: number;
      charging: number;
      heatPumps: number;
    };
    businessDemand: number;
    industrialDemand: number;
    contractedBuildings: number;
    battery: StoragePool;
    pumped: StoragePool;
    hydrogen: {
      stored: number;
      capacity: number;
      electrolyserLimit: number;
      fuelCellLimit: number;
      efficiency: number;
    };
    heatStore: { headroom: number; pumpPowerLeft: number; cop: number; nightNeedsHeat: boolean };
    substations: number;
  }
  export interface IslandResult {
    // every field of state.lastEnergy that is a per-tick flow (same names), plus:
    importCapacity: number;
    exportCapacity: number;
    batteryDelta: number;
    pumpedDelta: number;
    hydrogenDelta: number; // signed energy to apply to the tiles
    heatStoreCharge: number; // electricity absorbed (heat = * cop)
    consumptionThisTick: number;
    unshifted: number;
  }
  export function balanceIsland(input: IslandInput, pool: IslandPool): IslandResult;
  ```

- [ ] **Step 1: Write the failing tests**

`src/sim/islandBalance.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BALANCE } from '../shared/constants.ts';
import { callBudgetTicks } from './demandResponse.ts';
import { balanceIsland, type IslandInput } from './islandBalance.ts';
import type { IslandPool } from './islandPools.ts';

function pool(): IslandPool {
  return { flexBacklog: 0, callBudget: callBudgetTicks() };
}

function input(over: Partial<IslandInput> = {}): IslandInput {
  return {
    timeOfDay: 0.5,
    season: { sunrise: 0.25, sunset: 0.75 },
    spotPrice: 1,
    marketTrading: false,
    demandResponseActive: false,
    coverage: 0,
    generation: { solar: 0, wind: 0, rooftop: 0, hydro: 0, tidal: 0, geothermal: 0 },
    biogasCapacity: 0,
    demand: { buildings: 0, heating: 0, cooling: 0, charging: 0, heatPumps: 0 },
    businessDemand: 0,
    industrialDemand: 0,
    contractedBuildings: 0,
    battery: {
      stored: 0,
      capacity: 0,
      powerLimit: 0,
      efficiency: BALANCE.energy.batteryChargeEfficiency,
    },
    pumped: {
      stored: 0,
      capacity: 0,
      powerLimit: 0,
      efficiency: BALANCE.energy.pumpedStorageChargeEfficiency,
    },
    hydrogen: {
      stored: 0,
      capacity: 0,
      electrolyserLimit: 0,
      fuelCellLimit: 0,
      efficiency: BALANCE.hydrogen.chargeEfficiency,
    },
    heatStore: { headroom: 0, pumpPowerLeft: 0, cop: 1, nightNeedsHeat: false },
    substations: 0,
    ...over,
  };
}

describe('balanceIsland', () => {
  it('serves demand from generation and curtails the rest without storage or a substation', () => {
    const r = balanceIsland(
      input({
        generation: { solar: 100, wind: 0, rooftop: 0, hydro: 0, tidal: 0, geothermal: 0 },
        demand: { buildings: 40, heating: 0, cooling: 0, charging: 0, heatPumps: 0 },
      }),
      pool(),
    );
    expect(r.curtailment).toBeCloseTo(60, 9);
    expect(r.deficit).toBe(0);
    expect(r.gridExport).toBe(0);
    expect(r.exportCapacity).toBe(0);
  });

  it('a deficit without a substation cannot import; with one it imports up to the link, two double it', () => {
    const short = input({
      demand: { buildings: 100, heating: 0, cooling: 0, charging: 0, heatPumps: 0 },
    });
    expect(balanceIsland(short, pool()).gridImport).toBe(0);
    expect(balanceIsland(short, pool()).deficit).toBeCloseTo(100, 9);
    const one = balanceIsland({ ...short, substations: 1 }, pool());
    expect(one.gridImport).toBeCloseTo(BALANCE.market.importCapacity, 9);
    expect(one.importCapacity).toBe(BALANCE.market.importCapacity);
    const two = balanceIsland({ ...short, substations: 2 }, pool());
    expect(two.gridImport).toBeCloseTo(Math.min(100, 2 * BALANCE.market.importCapacity), 9);
  });

  it('surplus charges the battery before exporting and reports the signed delta', () => {
    const r = balanceIsland(
      input({
        generation: { solar: 200, wind: 0, rooftop: 0, hydro: 0, tidal: 0, geothermal: 0 },
        battery: { stored: 0, capacity: 3_000, powerLimit: 120, efficiency: 0.92 },
        substations: 1,
      }),
      pool(),
    );
    expect(r.batteryDelta).toBeCloseTo(120 * 0.92, 9);
    expect(r.gridExport).toBeCloseTo(80, 9);
    expect(r.curtailment).toBe(0);
  });

  it('a deficit discharges the battery, then biogas, then sheds under the contract, then imports', () => {
    const p = pool();
    const r = balanceIsland(
      input({
        demand: { buildings: 400, heating: 0, cooling: 0, charging: 0, heatPumps: 0 },
        businessDemand: 200,
        contractedBuildings: 10,
        demandResponseActive: true,
        spotPrice: 2,
        battery: { stored: 1_000, capacity: 3_000, powerLimit: 120, efficiency: 0.92 },
        biogasCapacity: 90,
        substations: 1,
      }),
      p,
    );
    expect(r.batteryDelta).toBeCloseTo(-120, 9);
    expect(r.biogas).toBeCloseTo(90, 9);
    expect(r.shed).toBeCloseTo(BALANCE.demandResponse.shedShare * 200, 9);
    expect(r.gridImport).toBeCloseTo(BALANCE.market.importCapacity, 9);
    expect(r.deficit).toBeCloseTo(400 - 120 - 90 - r.shed - r.gridImport, 9);
    expect(p.callBudget).toBeLessThan(callBudgetTicks());
  });

  it('defers metered flexible load at night and keeps the backlog in the pool', () => {
    const p = pool();
    const r = balanceIsland(
      input({
        timeOfDay: 0.1,
        coverage: 1,
        demand: { buildings: 100, heating: 0, cooling: 0, charging: 0, heatPumps: 0 },
      }),
      p,
    );
    expect(r.flexDeferred).toBeCloseTo(BALANCE.smartMeters.householdFlexShare * 100, 9);
    expect(p.flexBacklog).toBeCloseTo(r.flexDeferred, 9);
    expect(r.consumptionThisTick).toBeCloseTo(100 - r.flexDeferred, 9);
  });

  it('market trading sells only through a substation', () => {
    const base = input({
      marketTrading: true,
      spotPrice: BALANCE.market.trading.sellThreshold,
      generation: { solar: 10, wind: 0, rooftop: 0, hydro: 0, tidal: 0, geothermal: 0 },
      battery: { stored: 3_000, capacity: 3_000, powerLimit: 120, efficiency: 0.92 },
    });
    expect(balanceIsland(base, pool()).tradeSell).toBe(0);
    expect(balanceIsland({ ...base, substations: 1 }, pool()).tradeSell).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/sim/islandBalance.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `balanceIsland`**

Move `chargePool` and `dischargePool` from `energy.ts` into `islandBalance.ts` (exported) and write the function by transplanting the cascade from `energyStep` (the block from "Smart meters: a share of metered household load…" through the trading block), with these substitutions:

- `state.flexBacklog` → `pool.flexBacklog`; `comfortWindowHours(input.timeOfDay, input.season)`.
- `generation = sum of input.generation`; `buildingDemand = input.demand.buildings`, etc.; `heat.pumpPower` → `input.demand.heatPumps`.
- Storage: work on local copies `battery = { ...input.battery }` etc.; report `batteryDelta = battery.stored - input.battery.stored` (same for pumped and hydrogen) — the orchestrator applies deltas to the tiles with `chargeTiles`/`dischargeTiles`.
- Heat store: `heatStoreCharge = input.heatStore.nightNeedsHeat && surplus > 0 ? Math.max(0, Math.min(surplus, input.heatStore.pumpPowerLeft, input.heatStore.headroom / input.heatStore.cop)) : 0` — a pure inline of `chargeHeatStore`'s rule (keep `chargeHeatStore` in heat.ts for the heat-side bookkeeping, it will be called by the orchestrator with the island's tiles).
- Links: `const importCapacity = input.substations * BALANCE.market.importCapacity; const exportCapacity = input.substations * BALANCE.market.exportCapacity;` and use them wherever `BALANCE.market.importCapacity`/`exportCapacity` appeared (gridImport cap, `sellOverLink`, trading room, `dispatchCall`'s `importCapacity` argument).
- Demand response: `dispatchCall(pool, input.demandResponseActive, input.businessDemand, input.industrialDemand, shortfall, input.spotPrice, importCapacity)`.
- Return every flow field with the same names `lastEnergy` uses (`solar, wind, biogas, hydro, tidal, geothermal, rooftop, buildingConsumption, chargingConsumption, heatingConsumption, coolingConsumption, curtailment, deficit, gridImport, gridExport, electrolysis, fuelCell, hydrogenSold, heatPumpConsumption (= demand.heatPumps + heatStoreCharge), heatStoreCharge, spotPrice, tradeSell, tradeBuy, flexDeferred, flexRecovered, flexBacklog (pool after), flexOverflow, unshifted, shed, shedPool, contractedBuildings`) plus `importCapacity, exportCapacity, batteryDelta, pumpedDelta, hydrogenDelta, consumptionThisTick`.

The function must not touch any `SimState`. Write a doc comment that this is the cascade of one island, in the order the spec lists.

- [ ] **Step 4: Run, format, commit**

Run: `pnpm vitest run src/sim/islandBalance.test.ts src/sim/energy.test.ts`
Expected: PASS (energyStep is untouched apart from the moved helpers; import them back from `./islandBalance.ts`).

```bash
pnpm format && pnpm typecheck && pnpm lint
git add -A src
git commit -m "feat(sim): balanceIsland, the pure cascade for one grid island

The surplus/deficit cascade (storage, heat store, hydrogen, export or
sale, curtailment; discharge, fuel cell, biogas, demand response,
import, deficit) and the flexible-load pool run on an IslandInput and
an IslandPool and return signed storage deltas and every flow figure.
The import and export link scale with the island's substations; no
substation, no link. energyStep still runs the old global cascade until
the orchestrator lands."
```

---

### Task 5: `energyStep` as the island orchestrator

**Files:**

- Modify: `src/sim/energy.ts`, `src/sim/vehicles.ts` (`Vehicle.chargeTile`, `chargingDemandByIsland`), `src/sim/state.ts` (`Vehicle`, `lastIslands`), `src/shared/types.ts` (`IslandStats`, `GlobalStats.islands`), `src/sim/tick.ts` (`buildStats`, `energyStep` input), `src/sim/heat.ts`, `src/sim/deliveries.ts`/`src/sim/transit.ts` only if the depot tile is not already on the van/bus (it is: `van.depot`, `bus.depot`)
- Test: `src/sim/energy.test.ts`, `src/sim/vehicles.test.ts`, `src/sim/tick.test.ts` (create if absent; `tick.test.ts` does not exist today — put the sums test into `energy.test.ts`)

**Interfaces:**

- Produces:
  ```ts
  // src/shared/types.ts
  export interface IslandStats {
    number: number;
    key: number;
    tiles: number;
    buildings: number;
    substations: number;
    generation: number;
    consumption: number;
    stored: number;
    capacity: number; // battery + pumped
    deficit: number;
    curtailment: number;
    gridImport: number;
    gridExport: number;
    importCost: number;
  }
  // GlobalStats.islands: IslandStats[]
  // SimState.lastIslands: IslandStats[]
  // src/sim/vehicles.ts
  export function chargingDemandByIsland(state: SimState): Float64Array; // index = island number, [0] = unconnected
  // Vehicle.chargeTile: number  (tile the car is plugged in at: homeRoad or hub, -1 when not charging; not persisted)
  ```
- `EnergyTickInput.chargingDemand: number` becomes `chargingByIsland: Float64Array`.

- [ ] **Step 1: Write the failing tests**

Append to `src/sim/energy.test.ts` (reuse `makeState`, `addBuilding`, `setNoonClearSky`; import `islandOf` from `./powerGrid.ts`, `poolForIsland` from `./islandPools.ts`, `chargeTiles, storageTilesOfKind` from `./storage.ts`):

```ts
describe('per-island balance', () => {
  /** Island A: turbine + houses at the west edge; island B: houses at the east edge with a battery and optional substation. */
  function twoIslandTown(substation: boolean): SimState {
    const state = makeState();
    state.money = 1e9;
    setNoonClearSky(state);
    state.weather.windSpeed = 1;
    placePlant(state, at(2, 2), PlantType.WindTurbine);
    for (let i = 0; i < 3; i++) addBuilding(state, at(3 + i, 4), Zone.Residential, 2);
    placePlant(state, at(26, 26), PlantType.Battery);
    for (let i = 0; i < 3; i++) addBuilding(state, at(27, 23 + i), Zone.Residential, 2);
    if (substation) placePlant(state, at(24, 26), PlantType.Substation);
    bumpGridVersion(state);
    return state;
  }

  it('an island in deficit gets no help from another island in surplus and cannot import without a substation', () => {
    const state = twoIslandTown(false);
    energyStep(state, { chargingByIsland: new Float64Array(8), heat: { ...IDLE_HEAT } });
    const a = state.lastIslands.find((i) => i.number === islandOf(state, at(2, 2)))!;
    const b = state.lastIslands.find((i) => i.number === islandOf(state, at(26, 26)))!;
    expect(a.generation).toBeGreaterThan(a.consumption);
    expect(a.deficit).toBe(0);
    expect(b.generation).toBe(0);
    expect(b.deficit).toBeCloseTo(b.consumption, 6);
    expect(b.gridImport).toBe(0);
    expect(state.lastEnergy.deficit).toBeCloseTo(b.deficit, 6);
    expect(state.lastEnergy.curtailment).toBeCloseTo(a.curtailment, 6);
  });

  it('a substation lets its island import, and the city sums equal the island sums', () => {
    const state = twoIslandTown(true);
    energyStep(state, { chargingByIsland: new Float64Array(8), heat: { ...IDLE_HEAT } });
    const b = state.lastIslands.find((i) => i.number === islandOf(state, at(26, 26)))!;
    expect(b.substations).toBe(1);
    expect(b.gridImport).toBeGreaterThan(0);
    expect(b.gridImport).toBeLessThanOrEqual(BALANCE.market.importCapacity);
    const sum = (f: (i: IslandStats) => number) => state.lastIslands.reduce((s, i) => s + f(i), 0);
    expect(state.lastEnergy.gridImport).toBeCloseTo(
      sum((i) => i.gridImport),
      6,
    );
    expect(state.lastEnergy.deficit).toBeCloseTo(
      sum((i) => i.deficit),
      6,
    );
  });

  it("buildings flicker under their own island's deficit, not the other's", () => {
    const state = twoIslandTown(false);
    for (let t = 0; t < 20; t++) {
      state.tick++;
      energyStep(state, { chargingByIsland: new Float64Array(8), heat: { ...IDLE_HEAT } });
      for (let i = 0; i < 3; i++) {
        expect(state.layers.supplied[at(3 + i, 4)]).toBe(SupplyStatus.Supplied);
      }
    }
    const flickered = [0, 1, 2].some(
      (i) => state.layers.supplied[at(27, 23 + i)] === SupplyStatus.Undersupplied,
    );
    expect(flickered).toBe(true);
  });

  it('storage is charged on the tiles of the island that made the surplus', () => {
    const state = twoIslandTown(false);
    placePlant(state, at(6, 2), PlantType.Battery); // on island A, next to the turbine
    bumpGridVersion(state);
    energyStep(state, { chargingByIsland: new Float64Array(8), heat: { ...IDLE_HEAT } });
    expect(state.layers.stored[at(6, 2)]).toBeGreaterThan(0);
    expect(state.layers.stored[at(26, 26)]).toBe(0);
  });
});
```

Append to `src/sim/vehicles.test.ts` (use its existing town helpers; the test needs one parked car at home):

```ts
describe('chargingDemandByIsland', () => {
  it('buckets a car charging at home by the island of its home road, and sums to chargingDemand', () => {
    const state = commuterTown(); // the file's helper that parks cars at home with a workplace
    vehiclesStep(state);
    const byIsland = chargingDemandByIsland(state);
    let total = 0;
    for (const v of byIsland) total += v;
    expect(total).toBeCloseTo(chargingDemand(state), 9);
    const charging = state.vehicles.find((v) => v.charging)!;
    expect(charging.chargeTile).toBe(charging.homeRoad);
    expect(byIsland[islandOf(state, charging.homeRoad)]).toBeGreaterThan(0);
  });
});
```

(Replace `commuterTown()` with the helper the file actually uses to get charging cars — check `grep -n 'charging' src/sim/vehicles.test.ts`.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/sim/energy.test.ts src/sim/vehicles.test.ts`
Expected: FAIL — `chargingByIsland` unknown, `lastIslands` undefined.

- [ ] **Step 3: Vehicles: record the charging tile, bucket by island**

`src/sim/state.ts` `Vehicle`: add `/** Tile the car is plugged in at (home road or hub), -1 while not charging. Not persisted. */ chargeTile: number;` — initialise `-1` wherever vehicles are created (`grep -n 'charging: false' src/sim/vehicles.ts`). In `decideCharging` return the tile instead of a boolean: `-1` for no, `vehicle.homeRoad` at home, `hub` at a hub; the caller sets `vehicle.chargeTile = tile; vehicle.charging = tile >= 0;`. Add:

```ts
/**
 * Charging demand per island this tick (index = island number, 0 = not
 * energised): cars at their home road or hub, vans and buses at their
 * depot tile. Sums to chargingDemand().
 */
export function chargingDemandByIsland(state: SimState): Float64Array {
  recomputeGrid(state);
  const { island } = state.layers;
  const out = new Float64Array(state.islandKeys.length);
  for (const v of state.vehicles) {
    if (v.charging && v.chargeTile >= 0)
      out[island[v.chargeTile]] += BALANCE.vehicles.chargingEnergyPerVehicle;
  }
  for (const van of state.vans)
    if (van.charging) out[island[van.depot]] += BALANCE.deliveries.chargingEnergyPerVan;
  for (const bus of state.buses)
    if (bus.charging) out[island[bus.depot]] += BALANCE.transit.chargingEnergyPerBus;
  return out;
}
```

Keep `chargingDemand(state)` (the HUD/tests use it). `tick.ts`: `energyStep(state, { chargingByIsland: chargingDemandByIsland(state), heat })`.

- [ ] **Step 4: Rewrite `energyStep`**

Replace the body of `energyStep` in `src/sim/energy.ts` with the orchestrator. Skeleton (fill every `…` with the code from the current function, moved into per-island arrays):

```ts
export function energyStep(state: SimState, input: EnergyTickInput): void {
  const { layers } = state;
  recomputeGrid(state);
  syncIslandPools(state);
  const islands = state.islandKeys.length; // index 0 = unconnected
  const time = timeOfDay(state.tick);
  const heat = input.heat ?? { ...IDLE_HEAT };
  const temperature = state.season.temperature;
  const solarFactorNow = currentSolarFactor(state);
  const windFactorNow = currentWindFactor(state);
  const riverFlowNow = riverFlowFactor(state);
  const tideNow = tideFactor(state.tick);

  // Per-island accumulators.
  const census = censusByIsland(state);            // PlantCensus[] (Task 5 helper: censusPlants with an island bucket)
  const buildingDemand = new Float64Array(islands);
  const heatingDemand = new Float64Array(islands);
  const coolingDemand = new Float64Array(islands);
  const rooftop = new Float64Array(islands);
  const businessDemand = new Float64Array(islands);
  const industrialDemand = new Float64Array(islands);
  const contracted = new Int32Array(islands);
  const servedHeat = new Float64Array(islands);    // heat demand of network-served buildings per island (fallback share)
  const buildings = new Int32Array(islands);
  const tiles = new Int32Array(islands);
  for (let i = 0; i < layers.island.length; i++) tiles[layers.island[i]]++;

  // Stations (per island), buildings (per island) — the two loops of today, indexing by layers.island[i].
  …
  // Heat: the network's pump power and fallback are split over islands.
  const heatPlantsTotal = census.reduce((s, c) => s + c.heatPlants, 0);
  const fallbackShare = heat.demand > 0 ? heat.fallback / heat.demand : 0;

  const connectedByIsland: number[][] = Array.from({ length: islands }, () => []);
  const results: IslandResult[] = [];
  state.lastIslands = [];
  const spotPrice = spotPriceFactor(state);
  const coverage = meteredCoverage(state);
  for (let n = 1; n < islands; n++) {
    const c = census[n];
    const batteryTiles = storageTilesOfKind(state, PlantType.Battery, n);
    const pumpedTiles = storageTilesOfKind(state, PlantType.PumpedStorage, n);
    const hydrogenTiles = storageTilesOfKind(state, PlantType.HydrogenPlant, n);
    const heatStoreTiles = storageTilesOfKind(state, PlantType.HeatStore, n);
    const battery = poolOf(state, batteryTiles);
    const pumped = poolOf(state, pumpedTiles);
    const hydrogen = poolOf(state, hydrogenTiles);
    const heatStore = poolOf(state, heatStoreTiles);
    const pumpShare = heatPlantsTotal > 0 ? c.heatPlants / heatPlantsTotal : 0;
    const result = balanceIsland(
      {
        timeOfDay: time,
        season: state.season,
        spotPrice,
        marketTrading: state.marketTrading,
        demandResponseActive: state.demandResponse.active,
        coverage,
        generation: {
          solar: c.solarFarms * BALANCE.energy.solarPeakOutput * solarFactorNow,
          wind: c.windCapacity * BALANCE.energy.windPeakOutput * windFactorNow,
          rooftop: rooftop[n],
          hydro: c.hydroCapacity * BALANCE.energy.hydroPeakOutput * riverFlowNow,
          tidal: c.tidalCapacity * BALANCE.energy.tidalPeakOutput * tideNow,
          geothermal: c.geothermalCapacity * BALANCE.energy.geothermalPeakOutput,
        },
        biogasCapacity: c.biogasPlants * BALANCE.energy.biogasMaxOutput,
        demand: {
          buildings: buildingDemand[n],
          heating: heatingDemand[n] + servedHeat[n] * fallbackShare,
          cooling: coolingDemand[n],
          charging: Math.max(0, input.chargingByIsland[n] ?? 0),
          heatPumps: heat.pumpPower * pumpShare,
        },
        businessDemand: businessDemand[n],
        industrialDemand: industrialDemand[n],
        contractedBuildings: contracted[n],
        battery: { ...battery, powerLimit: c.batteries * BALANCE.energy.batteryPowerLimit, efficiency: BALANCE.energy.batteryChargeEfficiency },
        pumped: { ...pumped, powerLimit: c.pumpedCapacity * BALANCE.energy.pumpedStoragePowerLimit, efficiency: BALANCE.energy.pumpedStorageChargeEfficiency },
        hydrogen: { ...hydrogen, electrolyserLimit: c.hydrogenPlants * BALANCE.hydrogen.electrolyserPowerLimit, fuelCellLimit: c.hydrogenPlants * BALANCE.hydrogen.fuelCellPowerLimit, efficiency: BALANCE.hydrogen.chargeEfficiency },
        heatStore: { headroom: heatStore.capacity - heatStore.stored, pumpPowerLeft: heat.pumpPowerLeft * pumpShare, cop: heat.cop, nightNeedsHeat: nightNeedsHeat(temperature) },
        substations: c.substations,
      },
      poolForIsland(state, n),
    );
    // Apply the storage deltas to this island's tiles.
    if (result.batteryDelta > 0) chargeTiles(state, batteryTiles, result.batteryDelta); else dischargeTiles(state, batteryTiles, -result.batteryDelta);
    … same for pumped and hydrogen …
    chargeTiles(state, heatStoreTiles, result.heatStoreCharge * heat.cop);
    results.push(result);
    state.lastIslands.push({
      number: n, key: state.islandKeys[n], tiles: tiles[n], buildings: buildings[n], substations: c.substations,
      generation: sum of result.generation fields + result.biogas + result.fuelCell,
      consumption: result.consumptionThisTick,
      stored: battery.stored + result.batteryDelta + pumped.stored + result.pumpedDelta,
      capacity: battery.capacity + pumped.capacity,
      deficit: result.deficit, curtailment: result.curtailment, gridImport: result.gridImport, gridExport: result.gridExport,
      importCost: result.gridImport * BALANCE.market.importCostPerEnergyUnit * spotPrice,
    });
    // Flicker: this island's deficit share over its connected buildings.
    const share = result.consumptionThisTick > 0 ? result.deficit / result.consumptionThisTick : 0;
    for (const index of connectedByIsland[n]) {
      const undersupplied = share > 0 && hashTileTick(index, state.tick) < share;
      setSupplied(state, index, undersupplied ? SupplyStatus.Undersupplied : SupplyStatus.Supplied);
    }
  }
  // Isolated plants (unchanged), then the city sums into state.lastEnergy (every field = Σ results; spotPrice, heatCop, networkHeat, heatFallback from `heat`; flexBacklog = Σ pools), the stored-share dirty marking (Task 2 step 7), and the history accumulation with soc = Σ(battery+pumped stored)/Σ capacity over all islands.
}
```

`censusByIsland(state)` — refactor `censusPlants` so the per-plant `switch` lives in `countPlantInto(census, state, i, plant)`; `censusPlants` keeps its signature (used by inspect/heat) and `censusByIsland` returns `PlantCensus[]` (index 0 for unconnected plants). `PlantCensus` gains `substations: number`.

Heat side: in `heat.ts` the `chargeHeatStore` wrapper is no longer used by energy.ts (the pure rule is inside `balanceIsland`); delete it and its test, or keep it for `heat.test.ts` — delete (YAGNI) and move the covered behaviour into the `balanceIsland` test ("fills the heat store only while the night needs heat").

`hasPowerInfrastructure` unchanged. `EnergyTickInput`:

```ts
export interface EnergyTickInput {
  /** Charging load per island this tick (index = island number; see chargingDemandByIsland). */
  chargingByIsland: Float64Array;
  heat?: HeatTickResult;
}
```

Update every `energyStep(state, { chargingDemand: x })` call in tests to `{ chargingByIsland: oneIsland(x) }` with a helper in the test file: `const oneIsland = (v: number) => { const a = new Float64Array(2); a[1] = v; return a; }` — tests that place one plant have exactly one island.

`src/shared/types.ts`: `IslandStats` (above) and `GlobalStats.islands: IslandStats[]`. `src/sim/tick.ts` `buildStats`: `islands: state.lastIslands.map((i) => ({ ...i }))`. `src/sim/state.ts`: `lastIslands: IslandStats[]` (init `[]`).

- [ ] **Step 5: Run the whole sim suite**

Run: `pnpm typecheck && pnpm vitest run src/sim src/agent`
Expected: PASS. Existing single-island energy tests must give the same numbers as before (one island, one substation only where a test asserts imports — those tests now need `placePlant(state, …, PlantType.Substation)` in their town; the ones asserting `gridImport > 0` or `gridExport > 0` are the ones to touch: `grep -n 'gridImport\|gridExport\|tradeSell\|tradeBuy' src/sim/energy.test.ts src/sim/goals.test.ts src/sim/engine.test.ts src/agent/tools.test.ts`). The `exporter` goal test town gets a substation. `node scripts/smoke.mjs` must still run (starts the dev server; see CLAUDE.md).

- [ ] **Step 6: Format, commit**

```bash
pnpm format && pnpm lint && pnpm format:check
git add -A src
git commit -m "feat(sim): energyStep balances every grid island on its own

The step labels demand, charging, heat and the plant census by island,
runs balanceIsland per island with that island's storage tiles,
substations and pool, applies the storage deltas to the tiles, flickers
buildings under their own island's deficit and sums the results into
lastEnergy. lastIslands carries the per-island figures for the UI and
the agent; GlobalStats.islands publishes them. A plant now serves only
its island; import and export need a substation on it."
```

---

### Task 6: The substation as a plant: placement, tool, mesh, agent

**Files:**

- Modify: `src/sim/state.ts` (placement rule if any — substations go on any empty land tile like a battery; verify `buildRejection` needs no change), `src/sim/inspect.ts` + `src/shared/types.ts` (`TileInfo.substation`), `src/ui/useTools.ts`, `src/ui/BuildBar.tsx`, `src/ui/i18n.tsx`, `src/ui/TileInspector.tsx`, `src/render/plantsMesh.ts`, `src/agent/tools.ts`, `docs/agent-tools.md`, `e2e/game.spec.ts`
- Test: `src/sim/state.test.ts`, `src/sim/inspect.test.ts`, `src/render/plantsMesh.test.ts`, `src/ui/useTools.test.ts`, `src/agent/tools.test.ts`

**Interfaces:**

- Produces: tool id `'plant-substation'`, hotkey `x`; `TileInfo.substation?: { island: number; gridImport: number; gridExport: number; importCapacity: number; exportCapacity: number }`; agent plant name `substation`, ASCII glyph `N`, find kind `substation`.

- [ ] **Step 1: Failing tests**

`src/sim/state.test.ts` (in the placement describe):

```ts
it('accepts a substation on empty land and nowhere else', () => {
  const state = createSimState(1, SIZE);
  state.money = 1e9;
  expect(placePlant(state, at(4, 4), PlantType.Substation)).toEqual({});
  expect(buildRejection(state, riverTile, { kind: 'plant', plant: PlantType.Substation })).toBe(
    'water',
  );
});
```

(Match the file's `buildRejection` call shape and its river/lake fixtures.)

`src/sim/inspect.test.ts`:

```ts
it('a substation reports its island link figures', () => {
  const state = createSimState(3, SIZE);
  state.money = 1e9;
  placePlant(state, at(8, 8), PlantType.Substation);
  for (let i = 0; i < 3; i++) {
    state.layers.zone[at(9 + i, 10)] = Zone.Residential;
    state.layers.density[at(9 + i, 10)] = 2;
  }
  bumpGridVersion(state);
  state.tick = TICKS_PER_DAY / 2;
  energyStep(state, { chargingByIsland: new Float64Array(2) });
  const info = inspectTile(state, at(8, 8))!;
  expect(info.substation).toBeDefined();
  expect(info.substation!.importCapacity).toBe(BALANCE.market.importCapacity);
  expect(info.substation!.gridImport).toBeGreaterThan(0);
  expect(info.island?.number).toBe(1);
});
```

`src/ui/useTools.test.ts`: `expect(TOOL_HOTKEYS.x).toBe('plant-substation'); expect(PLANT_BY_TOOL['plant-substation']).toBe(PlantType.Substation);`.
`src/render/plantsMesh.test.ts`: `it('draws a substation yard with a transformer box', …)` — place `PlantType.Substation` on a flat field and expect `boxMesh.count` ≥ 7 (4 posts + box + 2 insulators) and `plantHeight(PlantType.Substation)` > 0.3.
`src/agent/tools.test.ts`: `place_plant` with `plant: 'substation'` succeeds and `get_map` overview shows `N` on that tile; `find_tiles` kind `substation` returns it.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/sim/state.test.ts src/sim/inspect.test.ts src/ui/useTools.test.ts src/render/plantsMesh.test.ts src/agent/tools.test.ts`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement**

1. `src/sim/state.ts` `buildRejection`: a substation follows the Battery branch (empty land). Verify with the test; if the plant switch has an explicit list, add `PlantType.Substation` beside `Battery`.
2. `src/sim/inspect.ts`: add to `TileInfo` (types.ts, after `heatPlant?`):
   ```ts
   /** Present on every energised tile: its grid island and that island's figures this tick. */
   island?: { number: number; key: number; generation: number; consumption: number; deficit: number; substations: number };
   /** Present on a substation: the link figures of its island this tick. */
   substation?: { island: number; gridImport: number; gridExport: number; importCapacity: number; exportCapacity: number };
   ```
   In `inspectTile`: `const n = islandOf(state, index); const islandStats = state.lastIslands.find((i) => i.number === n);` → `island: islandStats ? { number: n, key: islandStats.key, generation: islandStats.generation, consumption: islandStats.consumption, deficit: islandStats.deficit, substations: islandStats.substations } : undefined`; `substation` when `plant === PlantType.Substation && islandStats`: `{ island: n, gridImport: islandStats.gridImport, gridExport: islandStats.gridExport, importCapacity: islandStats.substations * BALANCE.market.importCapacity, exportCapacity: islandStats.substations * BALANCE.market.exportCapacity }`.
3. `src/ui/useTools.ts`: `ToolId` gains `'plant-substation'`; `TOOL_HOTKEYS.x = 'plant-substation'` (update the doc comment list); `PLANT_BY_TOOL['plant-substation'] = PlantType.Substation`.
4. `src/ui/BuildBar.tsx` energy category, after `plant-heatstore`: `{ id: 'plant-substation', icon: '🏗', cost: BALANCE.costs.plant[PlantType.Substation] }`.
5. `src/ui/i18n.tsx` EN:
   ```ts
   'tool.plant-substation.desc':
     'The gate of a grid island to the outer grid. Only an island with a substation can import in a shortfall or export its surplus; each one adds a link of ' +
     '60 in and 80 out per tick. Islands are the separate networks your lines and plants form — see the Grid overlay.',
   ```
   DE:
   ```ts
   'tool.plant-substation.desc':
     'Das Tor einer Netzinsel zum Außennetz. Nur eine Insel mit Umspannwerk kann im Defizit importieren oder Überschuss exportieren; jedes Werk bringt einen Link von ' +
     '60 Einheiten hinein und 80 hinaus pro Tick. Inseln sind die getrennten Netze, die deine Leitungen und Anlagen bilden – siehe Overlay „Netz“.',
   ```
   Inspector keys EN: `'inspect.district': 'District'`, `'inspect.districtFigures': '{generation} in, {consumption} out'`, `'inspect.districtDeficit': 'in deficit'`, `'inspect.substationLink': 'Link'`, `'inspect.substationFlow': 'import {importValue} / export {exportValue}'`, `'inspect.substationCapacity': '{importCapacity} in / {exportCapacity} out per tick'`; DE: `'Bezirk'`, `'{generation} rein, {consumption} raus'`, `'im Defizit'`, `'Link'`, `'Import {importValue} / Export {exportValue}'`, `'{importCapacity} rein / {exportCapacity} raus pro Tick'`.
6. `src/ui/TileInspector.tsx`: after the supply rows, when `info.island`: a `Row` "District" with value `#${info.island.number}` and a second `Row` with `inspect.districtFigures` (rounded) with tone `negative` + suffix `inspect.districtDeficit` when `info.island.deficit > 0`; when `info.substation`: rows `inspect.substationLink` (`inspect.substationFlow`) and `inspect.substationCapacity`. Test ids `inspect-district`, `inspect-substation`.
7. `src/render/plantsMesh.ts` `COLORS`: `substationYard: 0x6f7a86, substationBox: 0x4b5563, substationInsulator: 0xd7dde8, fencePost: 0x9aa3ad`. Recipe:
   ```ts
   case PlantType.Substation:
     return [
       { sx: 0.84, sy: 0.03, sz: 0.84, ox: 0, oy: 0, oz: 0, color: COLORS.substationYard },
       ...[-0.38, 0.38].flatMap((px) => [-0.38, 0.38].map((pz) => ({ sx: 0.04, sy: 0.22, sz: 0.04, ox: px, oy: 0.03, oz: pz, color: COLORS.fencePost }))),
       { sx: 0.36, sy: 0.3, sz: 0.26, ox: 0, oy: 0.03, oz: 0.05, color: COLORS.substationBox },
       { sx: 0.05, sy: 0.14, sz: 0.05, ox: -0.08, oy: 0.33, oz: 0.05, color: COLORS.substationInsulator },
       { sx: 0.05, sy: 0.14, sz: 0.05, ox: 0.08, oy: 0.33, oz: 0.05, color: COLORS.substationInsulator },
     ];
   ```
   (The foundation rule in `plantsMesh` applies to the yard and posts automatically.)
8. `src/agent/tools.ts`: `PLANT_NAMES.substation = PlantType.Substation`; `PLANT_TOOL_KEYS.substation = 'tool.plant-substation'`; `PLANT_PLACEMENT.substation = 'any empty land tile; the gate of its grid island to the outer grid — import and export need one (60 in / 80 out per substation and tick)'`; glyph `substation: 'N'` and the overview legend gains `N substation`; `FIND_KINDS` gains `'substation'` with `tiles.tileType[i] === TileType.Plant && tiles.plantType[i] === PlantType.Substation`; the `place_plant` description's plant list gains `substation`. `docs/agent-tools.md`: `place_plant` row lists the plant, `find_tiles` row lists `substation`, the legend line mentions `N`.
9. `e2e/game.spec.ts`: in the build-bar test add `await expect(page.getByTestId('tool-plant-substation')).toBeVisible();`.

- [ ] **Step 4: Run, format, commit**

Run: `pnpm typecheck && pnpm vitest run src/sim src/ui src/render src/agent`
Expected: PASS.

```bash
pnpm format && pnpm lint
git add -A src docs e2e
git commit -m "feat: substation plant — tool (x), yard mesh, inspector link rows, agent name and glyph"
```

---

### Task 7: Grid overlay and island selection in the renderer

**Files:**

- Modify: `src/shared/types.ts` (`OverlayMode.Grid`), `src/render/overlays.ts`, `src/render/renderer.ts` (`RenderEnvironment.islands`, `selectedIsland`, `setSelectedIsland`, drop `stateOfCharge`), `src/ui/OverlayToggle.tsx`, `src/ui/i18n.tsx`
- Test: `src/render/overlays.test.ts` (create if absent; check `ls src/render/*.test.ts`)

**Interfaces:**

- Produces: `OverlayMode.Grid = 9`; `gridColor(tile: { island: number }, islands: Map<number, { deficit: boolean; substations: number }>, selected: number): number | null` exported from `overlays.ts`; `GameRenderer.setSelectedIsland(n: number)`; `RenderEnvironment.islands: { number: number; deficit: boolean; substations: number }[]`.

- [ ] **Step 1: Failing tests**

`src/render/overlays.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { gridColor, ISLAND_PALETTE } from './overlays.ts';

const islands = new Map([
  [1, { deficit: false, substations: 1 }],
  [2, { deficit: true, substations: 1 }],
  [3, { deficit: false, substations: 0 }],
]);

describe('gridColor', () => {
  it('colours islands from the palette by number and leaves island 0 blank', () => {
    expect(gridColor({ island: 0 }, islands, 0)).toBeNull();
    expect(gridColor({ island: 1 }, islands, 0)).toBe(ISLAND_PALETTE[1 % ISLAND_PALETTE.length]);
    expect(gridColor({ island: 9 }, islands, 0)).toBe(ISLAND_PALETTE[9 % ISLAND_PALETTE.length]);
  });

  it('blends a deficit island toward red and dims one without a substation', () => {
    const plain = new THREE.Color(gridColor({ island: 1 }, islands, 0)!);
    const deficit = new THREE.Color(gridColor({ island: 2 }, islands, 0)!);
    const noLink = new THREE.Color(gridColor({ island: 3 }, islands, 0)!);
    expect(deficit.r).toBeGreaterThan(deficit.g);
    expect(noLink.getHSL({ h: 0, s: 0, l: 0 }).l).toBeLessThan(
      plain.getHSL({ h: 0, s: 0, l: 0 }).l,
    );
  });

  it('desaturates every island but the selected one', () => {
    const selected = new THREE.Color(gridColor({ island: 1 }, islands, 1)!);
    const other = new THREE.Color(gridColor({ island: 2 }, islands, 1)!);
    const hsl = { h: 0, s: 0, l: 0 };
    expect(other.getHSL(hsl).s).toBeLessThan(selected.getHSL({ h: 0, s: 0, l: 0 }).s);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/render/overlays.test.ts`
Expected: FAIL — `gridColor` not exported.

- [ ] **Step 3: Implement**

`src/shared/types.ts`: `Grid: 9,` in `OverlayMode` with the comment `/** Grid islands: one colour per island, red-tinted in deficit, dimmed without a substation. */`.

`src/render/overlays.ts`:

```ts
/** Eight distinguishable hues for island numbers (cycled by number % length). */
export const ISLAND_PALETTE = [
  0x5b9bd5, 0x4cd964, 0xf4d35e, 0xc77dff, 0xff9f68, 0x48cae4, 0xb5e48c, 0xf28482,
] as const;
const DEFICIT_TINT = 0xe05263;

export function gridColor(
  tile: { island: number },
  islands: ReadonlyMap<number, { deficit: boolean; substations: number }>,
  selected: number,
): number | null {
  if (tile.island === 0) return null;
  const color = new THREE.Color(ISLAND_PALETTE[tile.island % ISLAND_PALETTE.length]);
  const info = islands.get(tile.island);
  if (info?.deficit) color.lerp(new THREE.Color(DEFICIT_TINT), 0.6);
  if (info && info.substations === 0) color.multiplyScalar(0.55);
  if (selected !== 0 && selected !== tile.island) {
    const hsl = { h: 0, s: 0, l: 0 };
    color.getHSL(hsl);
    color.setHSL(hsl.h, hsl.s * 0.25, hsl.l);
  }
  return color.getHex();
}
```

`OverlayTile` gains `island: number`; `applyDiffs` keeps a tile when `diff.island !== 0` too (add `|| diff.island !== 0` to the condition) and stores `island: diff.island`. The class gains `private islands = new Map<number, { deficit: boolean; substations: number }>()` and `private selectedIsland = 0`; `setEnvironment` rebuilds `this.islands` from `environment.islands` and rebuilds when in Grid mode; `setSelection(n)` sets and rebuilds. In `rebuild`: `else if (this.mode === OverlayMode.Grid) colorHex = gridColor(tile, this.islands, this.selectedIsland);`.

`src/render/renderer.ts`: `RenderEnvironment` drops `stateOfCharge` (Task 2 moved the fill to tiles; remove the `stats.energy.storageCapacity` computation) and gains `islands: { number: number; deficit: boolean; substations: number }[]` filled from `stats.islands.map((i) => ({ number: i.number, deficit: i.deficit > 0, substations: i.substations }))`; `setSelectedIsland(n: number): void { this.overlays.setSelection(n); }`. Fix `plantsMesh.setEnvironment` (no longer reads `stateOfCharge`) and `buildingFxMesh.test.ts`'s environment literal.

`src/ui/OverlayToggle.tsx`: add `{ mode: OverlayMode.Grid, id: 'grid', label: 'overlay.grid', title: 'overlay.grid.title' }` after `heat`. i18n EN: `'overlay.grid': 'Grid'`, `'overlay.grid.title': 'Grid islands: one colour per island, red-tinted while it is in deficit, dimmed when it has no substation'`; DE: `'overlay.grid': 'Netz'`, `'overlay.grid.title': 'Netzinseln: eine Farbe je Insel, rot getönt im Defizit, abgedunkelt ohne Umspannwerk'`.

- [ ] **Step 4: Run, format, commit**

Run: `pnpm typecheck && pnpm vitest run src/render src/ui`
Expected: PASS.

```bash
pnpm format && pnpm lint
git add -A src
git commit -m "feat(render): Grid overlay colours islands, tints deficits, dims islands without a substation; island selection"
```

---

### Task 8: Energy panel district list, HUD note, App wiring

**Files:**

- Modify: `src/ui/EnergyPanel.tsx`, `src/ui/EnergyStrip.tsx`, `src/ui/HudConsole.tsx`, `src/ui/App.tsx`, `src/ui/i18n.tsx`, `src/ui/app.css`
- Test: `src/ui/EnergyPanel.test.tsx` (create; the project tests React with vitest + `@testing-library/react` — check `ls src/ui/*.test.ts*` and `package.json` for the renderer in use; if the UI is only e2e-tested, put the checks into `e2e/game.spec.ts` instead), `e2e/game.spec.ts`

**Interfaces:**

- `EnergyPanel` props gain `islands: IslandStats[]`, `selectedIsland: number`, `onSelectIsland: (n: number) => void`. `EnergyStrip` gains `islandsInDeficit: number`. `HudConsole` passes them through from `stats` and new props `selectedIsland`, `onSelectIsland`. `App` owns `selectedIsland` state: selecting sets the overlay to `OverlayMode.Grid` and calls `rendererRef.current?.setSelectedIsland(n)`; selecting the same island again clears (0).

- [ ] **Step 1: Failing e2e / unit checks**

`e2e/game.spec.ts`, new test:

```ts
test('energy drawer lists grid districts and the Grid overlay toggles', async ({ page }) => {
  await page.getByTestId('hud-details-toggle').click();
  await expect(page.getByTestId('district-list')).toBeVisible();
  await page.getByTestId('overlay-grid').click();
  await expect(page.getByTestId('overlay-grid')).toHaveClass(/active/);
});
```

If a unit renderer exists, add `src/ui/EnergyPanel.test.tsx` rendering the panel with two `IslandStats` rows and asserting two `district-row` elements, the deficit class on the second, and that clicking a row calls `onSelectIsland(2)`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/ui` (and `pnpm e2e` on the Mac/CI) — Expected: FAIL, no `district-list`.

- [ ] **Step 3: Implement**

`src/ui/EnergyPanel.tsx`, after the heat `SocBlock`:

```tsx
<div className="district-list" data-testid="district-list">
  <h3>{t('energy.districts', { count: islands.length })}</h3>
  {islands.length === 0 && <p className="muted">{t('energy.districts.none')}</p>}
  {[...islands]
    .sort((a, b) => b.tiles - a.tiles)
    .map((island) => {
      const status = island.deficit > 0 ? 'deficit' : island.curtailment > 0 ? 'curtailing' : 'ok';
      return (
        <button
          type="button"
          key={island.number}
          className={`district-row ${status} ${selectedIsland === island.number ? 'selected' : ''}`}
          data-testid="district-row"
          onClick={() => onSelectIsland(selectedIsland === island.number ? 0 : island.number)}
          title={t('energy.districts.select')}
        >
          <span className="district-name">#{island.number}</span>
          <span>
            {t('energy.districts.figures', {
              generation: formatEnergy(island.generation),
              consumption: formatEnergy(island.consumption),
            })}
          </span>
          <span className="district-soc">
            <span className="soc-track">
              <span
                className="soc-fill"
                style={{
                  width: `${island.capacity > 0 ? (100 * island.stored) / island.capacity : 0}%`,
                }}
              />
            </span>
          </span>
          <span className={`district-link ${island.substations === 0 ? 'none' : ''}`}>
            ⇄ {island.substations}
          </span>
          <span className="district-status">{t(`energy.districts.${status}`)}</span>
        </button>
      );
    })}
</div>
```

i18n EN: `'energy.districts': 'Districts ({count})'`, `'energy.districts.none': 'No grid yet — place a plant.'`, `'energy.districts.select': 'Highlight this district on the map'`, `'energy.districts.figures': '{generation} in / {consumption} out'`, `'energy.districts.ok': 'ok'`, `'energy.districts.deficit': 'deficit'`, `'energy.districts.curtailing': 'curtailing'`, `'hud.districtsInDeficit': '{count} districts in deficit'`; DE: `'Bezirke ({count})'`, `'Noch kein Netz – setze eine Anlage.'`, `'Diesen Bezirk auf der Karte hervorheben'`, `'{generation} rein / {consumption} raus'`, `'ok'`, `'Defizit'`, `'abgeregelt'`, `'{count} Bezirke im Defizit'`.

`src/ui/EnergyStrip.tsx`: prop `islandsInDeficit: number`; after the balance chip, when `> 0`: `<span className="energy-chip negative" data-testid="energy-districts-deficit" title={t('hud.districtsInDeficit', { count: islandsInDeficit })}>⚠ {islandsInDeficit}</span>`.

`src/ui/HudConsole.tsx`: props `selectedIsland`, `onSelectIsland`; pass `islands={stats.islands}` and the two to `EnergyPanel`, `islandsInDeficit={stats.islands.filter((i) => i.deficit > 0).length}` to `EnergyStrip`.

`src/ui/App.tsx`: `const [selectedIsland, setSelectedIsland] = useState(0);` and

```ts
const selectIsland = (n: number): void => {
  setSelectedIsland(n);
  rendererRef.current?.setSelectedIsland(n);
  if (n !== 0) setOverlay(OverlayMode.Grid);
};
```

pass to `HudConsole`. Clear the selection (`selectIsland(0)`) when the overlay is switched away from Grid (in the `useEffect` on `overlay`).

`src/ui/app.css`: `.district-list`, `.district-row` (flex row, full width, inherits the panel font, `.selected` outline, `.deficit` text colour `var(--negative)` or the colour the balance row uses, `.curtailing` muted), `.district-soc .soc-track` reuse the existing track styles at 60 px width, `.district-link.none { opacity: .5 }`.

- [ ] **Step 4: Run, format, commit**

Run: `pnpm typecheck && pnpm vitest run src/ui && pnpm build`
Expected: PASS (e2e on the Mac or CI).

```bash
pnpm format && pnpm lint
git add -A src e2e
git commit -m "feat(ui): district list in the energy panel with map highlighting, HUD districts-in-deficit note"
```

---

### Task 9: Agent parity

**Files:**

- Modify: `src/agent/tools.ts`, `docs/agent-tools.md`
- Test: `src/agent/tools.test.ts`

**Interfaces:**

- `get_game_overview` gains `islands` (count) and `islandsInDeficit`; `get_energy_report` gains `islands: IslandStats[]` (rounded); `find_tiles` gains `island_without_substation`; `inspect_tile` already returns `island`/`substation` through `TileInfo`.

- [ ] **Step 1: Failing tests**

Append to `src/agent/tools.test.ts` (use `createHarness`, `absorb`-style helpers of the file):

```ts
describe('district grids', () => {
  it('overview and energy report list islands; find_tiles names islands without a substation', async () => {
    const { call, engine } = createHarness();
    engine.applyCommand({
      type: 'placePlant',
      index: tileIndex(4, 4, SIZE),
      plant: PlantType.WindTurbine,
    });
    engine.applyCommand({
      type: 'placePlant',
      index: tileIndex(18, 18, SIZE),
      plant: PlantType.SolarFarm,
    });
    engine.applyCommand({
      type: 'placePlant',
      index: tileIndex(16, 18, SIZE),
      plant: PlantType.Substation,
    });
    absorbTicks(2); // the harness's helper that ticks and absorbs events
    const overview = await call('get_game_overview');
    expect(overview.islands).toBe(2);
    const report = await call('get_energy_report');
    expect((report.islands as unknown[]).length).toBe(2);
    const missing = await call('find_tiles', { kind: 'island_without_substation' });
    expect((missing.tiles as { x: number; y: number }[]).length).toBe(1);
    const inspected = await call('inspect_tile', { x: 16, y: 18 });
    expect((inspected as { substation?: unknown }).substation).toBeDefined();
  });
});
```

(Check the real command shapes in `src/shared/messages.ts` — `placePlant` may take `x`/`y` — and the harness's tick helper name.)

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run src/agent/tools.test.ts`, FAIL on `overview.islands`.

- [ ] **Step 3: Implement**

`get_game_overview` result: `islands: s.islands.length, islandsInDeficit: s.islands.filter((i) => i.deficit > 0).length,` and extend the description with "grid islands (count, in deficit)". `get_energy_report`: `islands: s.islands.map((i) => ({ ...i, generation: round(i.generation), consumption: round(i.consumption), stored: Math.round(i.stored), deficit: round(i.deficit), curtailment: round(i.curtailment), gridImport: round(i.gridImport), gridExport: round(i.gridExport), importCost: round(i.importCost) }))` and describe it. `FIND_KINDS` gains `'island_without_substation'`: the tile matches when it is the island's key tile (`tiles.island[i] !== 0 && i === keyOf(island)`) of an island whose `substations === 0` — the kinds filter gets access to `ctx` stats: build `const keysWithoutSubstation = new Set(stats.islands.filter((i) => i.substations === 0).map((i) => i.key))` before the scan and match `keysWithoutSubstation.has(i)`. Describe both new kinds in the `find_tiles` description and in `docs/agent-tools.md` (`get_game_overview`, `get_energy_report`, `find_tiles`, `inspect_tile` rows: `island` / `substation` fields). Add a short "District grids" paragraph to the docs' feature notes (next to the isolated-plant note): a plant serves only its island; import/export need a substation.

- [ ] **Step 4: Run, format, commit**

```bash
pnpm format && pnpm typecheck && pnpm lint && pnpm vitest run src/agent
git add -A src docs
git commit -m "feat(agent): islands in overview and energy report, island_without_substation find kind, docs"
```

---

### Task 10: Goal, help, tutorial, docs

**Files:**

- Modify: `src/sim/goals.ts`, `src/shared/constants.ts` (`goals.districtGrid`), `src/ui/i18n.tsx`, `src/ui/Tutorial.tsx`, `src/ui/HelpPage.tsx`, `docs/idea.md`, `docs/plan.md`, `docs/superpowers/specs/2026-10-05-district-grids-design.md`
- Test: `src/sim/goals.test.ts`

- [ ] **Step 1: Failing goal test**

Append to `src/sim/goals.test.ts`:

```ts
describe('districtGrid', () => {
  function city(substations: number, deficitTicks: number): SimState {
    const state = createSimState(1, SIZE);
    state.lastIslands = [
      {
        number: 1,
        key: 0,
        tiles: 40,
        buildings: BALANCE.goals.districtGrid.minBuildings,
        substations,
        generation: 10,
        consumption: 5,
        stored: 0,
        capacity: 0,
        deficit: 0,
        curtailment: 0,
        gridImport: 0,
        gridExport: 0,
        importCost: 0,
      },
      {
        number: 2,
        key: 300,
        tiles: 10,
        buildings: 2,
        substations: 0,
        generation: 1,
        consumption: 1,
        stored: 0,
        capacity: 0,
        deficit: 0,
        curtailment: 0,
        gridImport: 0,
        gridExport: 0,
        importCost: 0,
      },
    ];
    state.goalProgress.districtDeficitTicks = deficitTicks;
    state.tick = TICKS_PER_DAY;
    return state;
  }

  it('unlocks at the day boundary when every sizeable island has a substation and the day was deficit-free', () => {
    const state = city(1, 0);
    goalsStep(state);
    expect(state.goalsAchieved.has('districtGrid')).toBe(true);
  });

  it('does not unlock without a substation on a sizeable island, or after a deficit tick', () => {
    const noLink = city(0, 0);
    goalsStep(noLink);
    expect(noLink.goalsAchieved.has('districtGrid')).toBe(false);
    const hadDeficit = city(1, 1);
    goalsStep(hadDeficit);
    expect(hadDeficit.goalsAchieved.has('districtGrid')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run src/sim/goals.test.ts`.

- [ ] **Step 3: Implement**

`src/shared/constants.ts` — find the goals block (`grep -n 'goals: {' src/shared/constants.ts`; if there is none, add `goals: { districtGrid: { minBuildings: 20 } }` as a new top-level block with the comment `/** Islands with at least this many buildings need a substation for the districtGrid goal. */`).

`src/sim/goals.ts`: `GOAL_IDS` gains `'districtGrid'`; `goalProgress.districtDeficitTicks: number` (state.ts, init 0, persisted as optional `districtDeficitTicks?` in `SaveGame`/serialize/deserialize like `warmWinterTicks`). In `goalsStep`:

```ts
// Every sizeable island has a substation and the day stayed deficit-free in every island.
if (state.lastIslands.some((i) => i.deficit > 0)) progress.districtDeficitTicks++;
if (state.tick % TICKS_PER_DAY === 0) {
  const { minBuildings } = BALANCE.goals.districtGrid;
  const sizeable = state.lastIslands.filter((i) => i.buildings >= minBuildings);
  if (
    !achieved.has('districtGrid') &&
    sizeable.length > 0 &&
    sizeable.every((i) => i.substations > 0) &&
    progress.districtDeficitTicks === 0
  ) {
    achieved.add('districtGrid');
  }
  progress.districtDeficitTicks = 0;
}
```

i18n EN: `'goal.districtGrid.title': 'Every district on the grid'`, `'goal.districtGrid.body': 'Every grid island with at least 20 buildings has a substation, and no island saw a deficit all day.'`; DE: `'Jeder Bezirk am Netz'`, `'Jede Netzinsel mit mindestens 20 Gebäuden hat ein Umspannwerk, und keine Insel hatte den ganzen Tag ein Defizit.'`.

Help: `src/ui/HelpPage.tsx` sections gain `{ title: 'help.districts.title', body: 'help.districts.body' }` after `help.grid`. EN body: `'Your lines and plants form grid islands — every connected network is one. A plant serves only its island; what it cannot use there is stored, exported or curtailed, never carried to another island. Import and export run through substations (🏗, key X): an island without one is on its own. The Grid overlay colours the islands, the energy drawer lists them, and the inspector names a tile’s district. Cities built before districts: your park may now be an island of its own — draw a line to the town and add a substation.'` DE: `'Deine Leitungen und Anlagen bilden Netzinseln – jedes zusammenhängende Netz ist eine. Eine Anlage versorgt nur ihre Insel; was dort nicht gebraucht wird, wird gespeichert, exportiert oder abgeregelt, nie in eine andere Insel getragen. Import und Export laufen über Umspannwerke (🏗, Taste X): eine Insel ohne ist auf sich gestellt. Das Overlay „Netz“ färbt die Inseln, die Energie-Schublade listet sie, der Inspektor nennt den Bezirk einer Kachel. Städte von vor den Bezirken: dein Park kann jetzt eine eigene Insel sein – ziehe eine Leitung zur Stadt und setze ein Umspannwerk.'` Update `help.grid.body` (EN/DE) first sentence to say lines tie plants into islands.

Tutorial: `src/ui/Tutorial.tsx` after the `grid` step: `{ id: 'substation', title: 'tutorial.substation.title', body: 'tutorial.substation.body', isComplete: (stats) => stats.islands.some((i) => i.substations > 0) }`. i18n EN: `'Build a substation'` / `'Your network is a grid island. Give it a gate to the outer grid: place a substation (🏗, key X) next to your lines so a shortfall can import and a surplus can export.'`; DE: `'Baue ein Umspannwerk'` / `'Dein Netz ist eine Netzinsel. Gib ihr ein Tor zum Außennetz: setze ein Umspannwerk (🏗, Taste X) neben deine Leitungen, damit ein Defizit importieren und ein Überschuss exportieren kann.'`.

Docs: `docs/idea.md` "Per-district grids" entry → `(done)` with a three-sentence summary (islands, substations as gates, overlay/list/inspector); `docs/plan.md` module map: `powerGrid.ts   # connectivity: islands (connected components), energised tiles`, add `islandBalance.ts # the pure per-island cascade`, `islandPools.ts # per-island flex backlog and call budget`, `storage.ts # storage levels per plant tile`, `overlays.ts` row mentions grid. Spec: replace "gets a dashed border" with "is dimmed" in the Rendering section; in Islands, after "A damaged line tile or plant splits an island as it does today." add "— but since rings are connections, a dead stretch has to be longer than `2 * lineSupplyRadius` tiles (7) before the two ends stop touching; a single struck pylon leaves the island whole", and soften the Goal's "a storm that cuts a pylon splits an island" to "a storm that takes out a stretch of line splits an island" and "proportional to each tile's capacity" with "charge in proportion to headroom, discharge in proportion to stored energy" in Storage per tile; note both as planning refinements.

- [ ] **Step 4: Run, format, commit**

```bash
pnpm format && pnpm typecheck && pnpm lint && pnpm vitest run src/sim src/ui
git add -A src docs
git commit -m "feat: districtGrid goal, help and tutorial step for substations; docs"
```

---

### Task 11: Pacing probe, balance freeze, full checks

**Files:**

- Create (temporary, deleted before the commit): `src/sim/_districtProbe.test.ts`
- Modify: `src/shared/constants.ts` (substation cost/upkeep comments and values if the probe says so), spec (probe record), `docs/idea.md`

- [ ] **Step 1: Write the probe**

`src/sim/_districtProbe.test.ts` — the 560-building probe town of the industrial probe (`docs/superpowers/specs/2026-10-05-industrial-zone-design.md` describes it; the layout code is in `docs/superpowers/plans/2026-10-05-industrial-zone.md` Task 9 plus the park wiring from this session's probes: a trunk line down x = 45 joined to every band line, line rows through the park every fourth row) laid as **two islands**: bands y 6..21 with a park at x ≥ 46, y ≤ 24 as island A; bands y 26..41 with a park at x ≥ 46, y ≥ 28 as island B; no line between y = 24 and y = 28. Variants per seed (7, 11): (1) one island (a joining line, today's behaviour), (2) two islands, no substations, (3) two islands, one substation each, (4) two islands, two substations each. 20 days each; print per variant: deficit ticks per island and city, unserved energy, import cost, export revenue, curtailment per island, net money; and for (1) the baseline. Mutate `BALANCE.costs.plant[PlantType.Substation]` through `(BALANCE.costs.plant as Record<number, number>)` if a cost variant is needed.

Run: `pnpm vitest run src/sim/_districtProbe.test.ts --reporter=verbose 2>&1 | grep --line-buffered -E 'seed|island|TOTAL' | tee /tmp/district-probe.txt` (move the probe file out of `src/` before any commit).

- [ ] **Step 2: Decide and freeze**

Targets: two islands with one substation each must land within ~10 % of the one-island baseline on net money and deficit ticks (the link is the only coupling, so a gap is expected but must not be a wall); a substation must pay back within an in-game year on a mid-size island (import avoided × price ≥ cost + upkeep); two substations should matter only on the deficit-heavy seed. Adjust cost (3_000) and, if islands starve behind the 60/80 link, the per-substation capacities; record the measurements in the constants' comments and the spec's Testing section (a table like the industrial probe's).

- [ ] **Step 3: Delete the probe, run everything**

```bash
rm src/sim/_districtProbe.test.ts
pnpm format && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm coverage && pnpm build && node scripts/smoke.mjs
```

Expected: all PASS; coverage ≥ 90 % on `src/sim` + `src/shared`.

- [ ] **Step 4: Commit**

```bash
git add src/shared/constants.ts docs
git commit -m "balance: freeze the substation from a two-island probe; docs"
```

- [ ] **Step 5: Hand back for the Mac visual pass**

Report: the Grid overlay's eight hues and the deficit tint at noon and at night; the dimming of an island without a substation; the district list with a selection; the substation yard on flat and sloped tiles; the inspector rows; an old save (park unwired) loading and showing its park as an isolated island; frame time on a 64×64 map with the overlay on.
