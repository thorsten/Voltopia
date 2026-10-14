# Cycling and Walking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bike lanes and pedestrian streets as road upgrades; commuters within reach walk or cycle, leave the car at home and so lower the evening charging peak; pedestrian streets block motor traffic.

**Architecture:** One new per-tile layer `roadLane` (0 none / 1 bike / 2 pedestrian) travels the same path as `roadClass` and `overpass`: sim layer → undo snapshot → save → `TileDiff` → renderer, inspector, agent mirror. A new sim module `src/sim/lanes.ts` owns the build command and the two trip rules (walk, cycle), both bounded Dijkstra searches over the existing `distances` helper. Motor routing switches from `isRoad` to `isMotorRoad` so cars, vans and buses avoid pedestrian tiles. The commuter decision in `vehicles.ts` gains two rider modes ahead of bus and rail; stats, a goal, UI tools, rendering and an agent tool follow the overpass pattern.

**Tech Stack:** TypeScript strict, vitest, three.js (instanced meshes), React 19, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-14-cycling-walking-design.md`

## Global Constraints

- `src/sim/` imports no DOM or three.js; all randomness through `state.rng`.
- No magic numbers in sim code: every tuning value lives in `BALANCE` (`src/shared/constants.ts`).
- All user-visible strings in `src/ui/i18n.tsx`, English AND German.
- New `InstancedMesh` / `GrowingMesh` in render: `frustumCulled = false` (the `setupFlat` / `setupRailing` helpers do this).
- `SaveGame` stays backward compatible: new field optional, no `SAVE_VERSION` bump.
- Run `pnpm format` after edits; `pnpm test` must pass before every commit; never `--no-verify`.
- Any single sim test under ~15 s.
- React effects depend on `bridge.send`, never on `bridge`.
- Commit messages: imperative summary + short body, one change per commit, ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. **Undo of a lane build on a tile that is then bulldozed** — undoing the bulldoze must restore the lane (snapshot carries `roadLane`); undo of the lane build before the bulldoze must restore `None` and refund. Test in Task 2.
2. **Converting a tile to pedestrian while a car is parked there or routing through it** — the car must not teleport or crash; it stays parked / finishes its path and finds no new path. Test in Task 3 (vehicle with home on a now-pedestrian tile stays parked, sim keeps stepping).
3. **A cyclist whose only lane route is longer than `bikeTiles` but whose plain-road route is shorter** — must drive, not cycle (lanes decide). Test in Task 4.
4. **Pedestrian tile under a bus route after the fact** — a bus mid-path through a tile that turns pedestrian; the next tour routes around it, `stopsInReach` for the depot drops stops it can no longer reach. Test in Task 3.
5. **Old save without the `roadLane` field** — loads with all `None`, no crash in renderer or mirror. Test in Task 1 (serialization) and Task 6 (mirror default).

---

### Task 1: Shared layer, types, constants, save and diff plumbing

**Files:**

- Modify: `src/shared/types.ts` (RoadClass at ~line 11; TileDiff ~line 826; SaveGame layers ~line 990)
- Modify: `src/shared/constants.ts` (costs ~line 35, upkeepPerTick ~line 195, goals ~line 1734; new `cycling` block)
- Modify: `src/shared/messages.ts:31-35`
- Modify: `src/sim/state.ts` (UndoEntry tiles ~line 231, TileLayers ~line 313, init ~line 643, snapshotTile ~line 859, collectDiffs ~line 915, save ~line 1341, load ~line 1453)
- Modify: `src/sim/roads.ts:183,211` (bulldoze reset, undo restore)
- Modify: `src/storage/serialization.ts:263-274`
- Test: `src/storage/serialization.test.ts`, `src/sim/state.test.ts`

**Interfaces:**

- Produces: `RoadLane = { None: 0, Bike: 1, Pedestrian: 2 }` + type; `TileLayers.roadLane: Uint8Array`; `TileDiff.roadLane: number`; `SaveGame.layers.roadLane?: ArrayBuffer`; `SimCommand { type: 'buildLanes'; tiles: number[]; kind: RoadLane }`; `BALANCE.costs.bikeLanePerTile = 15`, `BALANCE.costs.pedestrianPerTile = 40`, `BALANCE.upkeepPerTick.bikeLanePerTile = 0.002`, `BALANCE.upkeepPerTick.pedestrianPerTile = 0.003`, `BALANCE.cycling = { walkTiles: 4, bikeTiles: 20 }`, `BALANCE.goals.activeCity = { minPopulation: 150, share: 0.25 }`.

- [ ] **Step 1: Write the failing serialization test**

In `src/storage/serialization.test.ts`, after the overpass round-trip test (~line 315):

```ts
it('round-trips the optional roadLane layer and tolerates its absence', () => {
  const save = sampleSave();
  save.layers.roadLane = new Uint8Array(save.size * save.size).fill(2).buffer as ArrayBuffer;
  const restored = deserializeSave(serializeSave(save));
  expect(new Uint8Array(restored.layers.roadLane!)).toEqual(new Uint8Array(save.layers.roadLane));
  const legacy = deserializeSave(serializeSave(sampleSave()));
  expect(legacy.layers.roadLane).toBeUndefined();
});
```

(Use the same fixture/function names the overpass test at line 308 uses; copy them exactly.)

- [ ] **Step 2: Write the failing state snapshot test**

In `src/sim/state.test.ts`, add:

```ts
it('persists the roadLane layer and defaults it to None on old saves', () => {
  const state = createSimState(1, 8);
  const tile = 10;
  buildRoads(state, [tile]);
  state.layers.roadLane[tile] = RoadLane.Pedestrian;
  const save = serializeState(state);
  const restored = deserializeState(save);
  expect(restored.layers.roadLane[tile]).toBe(RoadLane.Pedestrian);
  delete save.layers.roadLane;
  expect(deserializeState(save).layers.roadLane[tile]).toBe(RoadLane.None);
});
```

(`serializeState` / `deserializeState` are exported by `state.ts`; import `RoadLane` from `../shared/types.ts`, `buildRoads` from `./roads.ts`.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run src/storage/serialization.test.ts src/sim/state.test.ts`
Expected: FAIL — `roadLane` does not exist on the layers / `RoadLane` not exported.

- [ ] **Step 4: Add the shared types and constants**

`src/shared/types.ts`, after `RoadClass`:

```ts
/** Lane kind of a TileType.Road tile: a bike lane, or a pedestrian street closed to motor traffic. */
export const RoadLane = { None: 0, Bike: 1, Pedestrian: 2 } as const;
export type RoadLane = (typeof RoadLane)[keyof typeof RoadLane];
```

In `TileDiff` after `roadClass`:

```ts
/** RoadLane of a road tile (0 elsewhere). */
roadLane: number;
```

In `SaveGame.layers` after `overpass?`:

```ts
    /** Lane layer (bike lanes, pedestrian streets); absent in saves from before cycling. */
    roadLane?: ArrayBuffer;
```

`src/shared/constants.ts`, in `costs` after `overpass: 150,`:

```ts
    /** Bike lane painted on an existing road tile (street or avenue). */
    bikeLanePerTile: 15,
    /** Pedestrian street: an existing road tile closed to cars, vans and buses. */
    pedestrianPerTile: 40,
```

In `upkeepPerTick` after `railPerTile`:

```ts
    /** Lane maintenance on top of the road tile's own upkeep. */
    bikeLanePerTile: 0.002,
    pedestrianPerTile: 0.003,
```

New top-level block (next to `vehicles`):

```ts
  cycling: {
    /** A commuter walks when home and work lie this many road tiles apart or fewer. */
    walkTiles: 4,
    /** A commuter cycles when a route over bike lanes / pedestrian streets of at most this many tiles joins home and work. */
    bikeTiles: 20,
  },
```

In `goals` after `railCity`:

```ts
    activeCity: {
      /** Population the activeCity goal requires. */
      minPopulation: 150,
      /** Share of commuters walking or cycling for the activeCity goal. */
      share: 0.25,
    },
```

`src/shared/messages.ts`, after `buildOverpass`:

```ts
  | { type: 'buildLanes'; tiles: number[]; kind: RoadLane }
```

(import `RoadLane` type.)

- [ ] **Step 5: Add the layer to state, snapshot, diff, save, load, bulldoze, undo**

`src/sim/state.ts`:

- `UndoEntry.tiles` element: add `roadLane: number;` after `roadClass`.
- `TileLayers`: `/** RoadLane per road tile (persisted). */ roadLane: Uint8Array;` after `roadClass`.
- init (~line 643): `roadLane: new Uint8Array(tiles),`.
- `snapshotTile`: `roadLane: layers.roadLane[index],`.
- `collectDiffs` (~line 915): `roadLane: layers.roadLane[index],` after `roadClass`.
- save (~line 1341): `roadLane: copyBuffer(layers.roadLane),`.
- load (~line 1453): `if (save.layers.roadLane) state.layers.roadLane.set(new Uint8Array(save.layers.roadLane));`.

`src/sim/roads.ts`:

- bulldoze loop (~line 183): `layers.roadLane[index] = RoadLane.None;` (import `RoadLane`).
- `undoLastAction` (~line 211): `layers.roadLane[tile.index] = tile.roadLane;`.

`src/storage/serialization.ts`: add `'roadLane'` to `optionalLayers` (line ~263-274); check whether the serializer's write side iterates the same list or a separate one (`grep -n overpass src/storage/serialization.ts`) and add `roadLane` wherever `overpass` appears.

Anywhere else the compiler now complains about a missing `roadLane` on a `TileDiff` literal (render tests build `TileDiff` via `as unknown as TileDiff[]`, so they do not): fix with `roadLane: 0`.

- [ ] **Step 6: Run tests and typecheck**

Run: `pnpm typecheck && pnpm vitest run src/storage/serialization.test.ts src/sim/state.test.ts`
Expected: PASS.

- [ ] **Step 7: Format, full test, commit**

```bash
pnpm format && pnpm test
git add -A src docs
git commit -m "feat(shared): roadLane layer, lane costs and the buildLanes command

Bike lanes and pedestrian streets need a per-tile lane kind that
survives undo, save and the tile diff; nothing builds it yet.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `lanes.ts` — build command, pricing, rejections, undo, upkeep

**Files:**

- Create: `src/sim/lanes.ts`
- Create: `src/sim/lanes.test.ts`
- Modify: `src/sim/engine.ts:104` (dispatch)
- Modify: `src/sim/economy.ts:79-104` (upkeep)
- Modify: `src/sim/tick.ts:168-178` and the `counts` type at ~line 150 (`bikeLaneTiles`, `pedestrianTiles`) and `src/sim/economy.ts:19,130`, `src/sim/state.ts:785` if the counts type is shared there
- Modify: `src/ui/i18n.tsx` rejection block (~line 286 EN, ~966 DE)

**Interfaces:**

- Consumes: `RoadLane`, `BALANCE.costs.bikeLanePerTile/pedestrianPerTile`, `snapshotTile`, `markDirty`, `BuildResult` from `./roads.ts`.
- Produces: `buildLanes(state: SimState, tiles: number[], kind: RoadLane): BuildResult`; `laneRejection(state, index, kind): string | null`; rejection reasons `'needsExistingRoad'`, `'pedestrianBlocked'`, `'notEnoughMoney'`.

- [ ] **Step 1: Write failing tests**

`src/sim/lanes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BALANCE } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { RoadLane, Terrain } from '../shared/types.ts';
import { buildLanes } from './lanes.ts';
import { buildOverpasses } from './overpass.ts';
import { buildRail } from './rail.ts';
import { buildRoads, bulldozeTiles, undoLastAction } from './roads.ts';
import { createSimState, type SimState } from './state.ts';
import { buildBusStops } from './transit.ts';

const SIZE = 16;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);

function town(): SimState {
  const state = createSimState(1, SIZE);
  state.layers.elevation.fill(0);
  state.layers.terrain.fill(Terrain.Land);
  state.money = 100_000;
  buildRoads(
    state,
    Array.from({ length: 10 }, (_, x) => at(x + 2, 8)),
  );
  return state;
}

describe('buildLanes', () => {
  it('paints bike lanes on road tiles, skips the rest, charges per changed tile', () => {
    const state = town();
    const before = state.money;
    const result = buildLanes(state, [at(2, 8), at(3, 8), at(3, 3)], RoadLane.Bike);
    expect(result).toEqual({});
    expect(state.layers.roadLane[at(2, 8)]).toBe(RoadLane.Bike);
    expect(state.layers.roadLane[at(3, 3)]).toBe(RoadLane.None);
    expect(before - state.money).toBe(2 * BALANCE.costs.bikeLanePerTile);
  });

  it('does not charge tiles that already carry the kind, rejects a batch with nothing to build', () => {
    const state = town();
    buildLanes(state, [at(2, 8)], RoadLane.Bike);
    const before = state.money;
    expect(buildLanes(state, [at(2, 8)], RoadLane.Bike)).toEqual({});
    expect(state.money).toBe(before);
    expect(buildLanes(state, [at(3, 3)], RoadLane.Bike)).toEqual({ rejected: 'needsExistingRoad' });
  });

  it('switching kinds pays the full price of the new kind; None is free', () => {
    const state = town();
    buildLanes(state, [at(2, 8)], RoadLane.Bike);
    const before = state.money;
    buildLanes(state, [at(2, 8)], RoadLane.Pedestrian);
    expect(before - state.money).toBe(BALANCE.costs.pedestrianPerTile);
    const mid = state.money;
    buildLanes(state, [at(2, 8)], RoadLane.None);
    expect(state.money).toBe(mid);
    expect(state.layers.roadLane[at(2, 8)]).toBe(RoadLane.None);
  });

  it('rejects when the treasury cannot pay', () => {
    const state = town();
    state.money = BALANCE.costs.pedestrianPerTile - 1;
    expect(buildLanes(state, [at(2, 8)], RoadLane.Pedestrian)).toEqual({
      rejected: 'notEnoughMoney',
    });
    expect(state.layers.roadLane[at(2, 8)]).toBe(RoadLane.None);
  });

  it('refuses a pedestrian street on a bus stop, a bridge, a level crossing or an overpass', () => {
    const state = town();
    buildBusStops(state, [at(2, 8)]);
    expect(buildLanes(state, [at(2, 8)], RoadLane.Pedestrian)).toEqual({
      rejected: 'pedestrianBlocked',
    });
    // Bike lanes are fine there.
    expect(buildLanes(state, [at(2, 8)], RoadLane.Bike)).toEqual({});

    state.layers.terrain[at(4, 8)] = Terrain.River;
    expect(buildLanes(state, [at(4, 8)], RoadLane.Pedestrian)).toEqual({
      rejected: 'pedestrianBlocked',
    });

    buildRail(state, [at(6, 6), at(6, 7), at(6, 8), at(6, 9), at(6, 10)]);
    expect(buildLanes(state, [at(6, 8)], RoadLane.Pedestrian)).toEqual({
      rejected: 'pedestrianBlocked',
    });
    expect(buildOverpasses(state, [at(6, 8)])).toEqual({});
    // Ramp tiles (5,8) and (7,8) are blocked too.
    expect(buildLanes(state, [at(7, 8)], RoadLane.Pedestrian)).toEqual({
      rejected: 'pedestrianBlocked',
    });
    // A mixed batch builds the allowed tiles and stays silent about the rest.
    expect(buildLanes(state, [at(7, 8), at(9, 8)], RoadLane.Pedestrian)).toEqual({});
    expect(state.layers.roadLane[at(9, 8)]).toBe(RoadLane.Pedestrian);
  });

  it('undo restores the previous lanes and refunds', () => {
    const state = town();
    buildLanes(state, [at(2, 8), at(3, 8)], RoadLane.Bike);
    const before = state.money;
    buildLanes(state, [at(2, 8)], RoadLane.Pedestrian);
    undoLastAction(state);
    expect(state.money).toBe(before);
    expect(state.layers.roadLane[at(2, 8)]).toBe(RoadLane.Bike);
  });

  it('bulldozing a road clears its lane; undoing the bulldoze brings the lane back', () => {
    const state = town();
    buildLanes(state, [at(2, 8)], RoadLane.Pedestrian);
    bulldozeTiles(state, [at(2, 8)]);
    expect(state.layers.roadLane[at(2, 8)]).toBe(RoadLane.None);
    undoLastAction(state);
    expect(state.layers.roadLane[at(2, 8)]).toBe(RoadLane.Pedestrian);
  });
});
```

Add to `src/sim/economy.test.ts`:

```ts
it('charges lane upkeep on top of the road tile', () => {
  const state = createSimState(1, 16);
  state.layers.elevation.fill(0);
  state.money = 1e6;
  state.lastServices = { fire: 1, police: 1 };
  buildRoads(state, [at(4, 4), at(5, 4)]);
  const plain = economyStep(state, 0, 0).gridUpkeep;
  buildLanes(state, [at(4, 4)], RoadLane.Bike);
  buildLanes(state, [at(5, 4)], RoadLane.Pedestrian);
  const laned = economyStep(state, 0, 0).gridUpkeep;
  expect(laned - plain).toBeCloseTo(
    BALANCE.upkeepPerTick.bikeLanePerTile + BALANCE.upkeepPerTick.pedestrianPerTile,
    9,
  );
});
```

(`economyStep(state, population, jobs)` returns an `EconomyBreakdown` with `gridUpkeep`; `at` and `SIZE` exist in that file. Import `buildLanes` and `RoadLane`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/sim/lanes.test.ts src/sim/economy.test.ts`
Expected: FAIL — cannot resolve `./lanes.ts`.

- [ ] **Step 3: Implement `src/sim/lanes.ts`**

```ts
import { BALANCE } from '../shared/constants.ts';
import { LINE_PRESENT } from '../shared/grid.ts';
import { RoadLane } from '../shared/types.ts';
import type { BuildResult } from './roads.ts';
import {
  markDirty,
  snapshotTile,
  Terrain,
  TileType,
  type SimState,
  type UndoEntry,
} from './state.ts';
import { isOverpassRamp } from './overpass.ts';

/** Price of putting `kind` on one road tile (None is free). */
export function lanePrice(kind: RoadLane): number {
  if (kind === RoadLane.Bike) return BALANCE.costs.bikeLanePerTile;
  if (kind === RoadLane.Pedestrian) return BALANCE.costs.pedestrianPerTile;
  return 0;
}

/**
 * Why `kind` cannot go on `index`, or null when it can. A pedestrian
 * street closes the tile to motor traffic, so it is refused where a bus
 * stop stands, where the road bridges the river, on a level crossing
 * and on an overpass deck or ramp.
 */
export function laneRejection(state: SimState, index: number, kind: RoadLane): string | null {
  const { layers } = state;
  if (layers.tileType[index] !== TileType.Road) return 'needsExistingRoad';
  if (kind !== RoadLane.Pedestrian) return null;
  if (layers.busStop[index] !== 0) return 'pedestrianBlocked';
  if (layers.terrain[index] === Terrain.River) return 'pedestrianBlocked';
  if ((layers.rail[index] & LINE_PRESENT) !== 0) return 'pedestrianBlocked';
  if (layers.overpass[index] !== 0 || isOverpassRamp(state, index)) return 'pedestrianBlocked';
  return null;
}

/**
 * Put `kind` on the given road tiles. Tiles already carrying it are
 * skipped and not charged; tiles that refuse it are skipped silently
 * unless nothing at all is built, when the first reason is reported.
 */
export function buildLanes(state: SimState, tiles: number[], kind: RoadLane): BuildResult {
  const { layers } = state;
  const built: number[] = [];
  let firstRejection: string | null = null;
  for (const index of tiles) {
    if (layers.tileType[index] === TileType.Road && layers.roadLane[index] === kind) continue;
    const rejection = laneRejection(state, index, kind);
    if (rejection !== null) {
      firstRejection ??= rejection;
      continue;
    }
    built.push(index);
  }
  if (built.length === 0) return firstRejection ? { rejected: firstRejection } : {};
  const cost = built.length * lanePrice(kind);
  if (cost > state.money) return { rejected: 'notEnoughMoney' };
  const undo: UndoEntry = {
    moneyDelta: cost,
    tiles: built.map((index) => snapshotTile(state, index)),
  };
  state.money -= cost;
  for (const index of built) {
    layers.roadLane[index] = kind;
    markDirty(state, index);
  }
  state.undoStack.push(undo);
  return {};
}
```

`isOverpassRamp` does not exist yet. Add to `src/sim/overpass.ts` (next to `clearInvalidOverpasses`), reusing `alongAxis` and the stored ramp length:

```ts
/** Whether `index` is a ramp tile of some overpass (deck tiles are not ramps). */
export function isOverpassRamp(state: SimState, index: number): boolean {
  const { overpass } = state.layers;
  if (overpass[index] !== 0) return false;
  for (const axis of ['ns', 'ew'] as const) {
    for (let step = 1; step <= OVERPASS_LONG_RAMP_TILES; step++) {
      for (const deck of alongAxis(state, index, axis, step)) {
        if (deck >= 0 && overpass[deck] >= step && crossingRoadAxis(state, deck) === axis) {
          return true;
        }
      }
    }
  }
  return false;
}
```

Add a test to `src/sim/overpass.test.ts` using its `crossingTown()` and `CROSSING = at(5, 8)`: after `buildOverpasses(state, [CROSSING])`, `isOverpassRamp` is true for `at(5, 6)`, `at(5, 7)`, `at(5, 9)`, `at(5, 10)`, false for `CROSSING`, `at(5, 5)` and `at(5, 11)`.

Dispatch in `src/sim/engine.ts` after `buildOverpass`:

```ts
      case 'buildLanes':
        return this.toEvents(buildLanes(state, command.tiles, command.kind));
```

Upkeep in `src/sim/economy.ts`: in the tile loop next to `avenueTiles`, count `bikeLaneTiles` / `pedestrianTiles` from `layers.roadLane`; add
`bikeLaneTiles * BALANCE.upkeepPerTick.bikeLanePerTile + pedestrianTiles * BALANCE.upkeepPerTick.pedestrianPerTile` to `gridUpkeep`. Do NOT change the `counts` type unless the compiler needs it.

Rejection strings, `src/ui/i18n.tsx` (EN block after `needsRoadTile`, DE block likewise):

```ts
  'rejection.needsExistingRoad': 'Bike lanes and pedestrian streets go on existing roads',
  'rejection.pedestrianBlocked':
    'A pedestrian street cannot take a bus stop, a bridge, a level crossing or an overpass ramp',
```

```ts
  'rejection.needsExistingRoad': 'Radwege und Fußgängerzonen gehören auf bestehende Straßen',
  'rejection.pedestrianBlocked':
    'Eine Fußgängerzone verträgt keine Haltestelle, Brücke, keinen Bahnübergang und keine Überführungsrampe',
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/sim/lanes.test.ts src/sim/economy.test.ts src/sim/overpass.test.ts`
Expected: PASS.

- [ ] **Step 5: Format, full test, commit**

```bash
pnpm format && pnpm test
git add -A src
git commit -m "feat(sim): build bike lanes and pedestrian streets on existing roads

buildLanes paints a lane kind on road tiles, refuses pedestrian
streets where a stop, bridge, crossing or ramp stands, charges per
changed tile and undoes like any build. Lanes carry upkeep.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Pedestrian streets block motor traffic

**Files:**

- Modify: `src/sim/routing.ts:99-114`
- Modify: `src/sim/vehicles.ts:21-35` (`roadTilesNextToZones`)
- Modify: `src/sim/transit.ts:50-56` (`buildBusStops` filter)
- Modify: `src/sim/overpass.ts:139-151` (`overpassRejection`)
- Modify: `src/sim/tick.ts:168-178` (`avenueShare` ignores pedestrian tiles)
- Test: `src/sim/routing.test.ts`, `src/sim/vehicles.test.ts`, `src/sim/transit.test.ts`, `src/sim/deliveries.test.ts`, `src/sim/overpass.test.ts`

**Interfaces:**

- Produces: `isMotorRoad(state)(tile)` exported from `routing.ts`; `findRoadPath` and `roadDistances` use it. Keeps `isRoad` for walking (Task 4).

- [ ] **Step 1: Write failing tests**

`src/sim/routing.test.ts`:

```ts
it('cars route around a pedestrian street and find no path when it cuts the only road', () => {
  const state = createSimState(1, 12);
  state.layers.elevation.fill(0);
  state.money = 1e6;
  const row = (y: number) => Array.from({ length: 8 }, (_, x) => tileIndex(x + 2, y, 12));
  buildRoads(state, [...row(5), ...row(7), tileIndex(2, 6, 12), tileIndex(9, 6, 12)]);
  buildLanes(state, [tileIndex(5, 5, 12)], RoadLane.Pedestrian);
  const path = findRoadPath(state, tileIndex(2, 5, 12), tileIndex(9, 5, 12))!;
  expect(path).not.toContain(tileIndex(5, 5, 12));
  expect(path.some((t) => t === tileIndex(5, 7, 12))).toBe(true);
  buildLanes(state, [tileIndex(5, 7, 12)], RoadLane.Pedestrian);
  expect(findRoadPath(state, tileIndex(2, 5, 12), tileIndex(9, 5, 12))).toBeNull();
  expect(roadDistances(state, tileIndex(2, 5, 12)).has(tileIndex(9, 5, 12))).toBe(false);
});
```

`src/sim/vehicles.test.ts`, inside a new `describe('pedestrian streets', ...)` using the file's `commuterTown`, `setHour`, `runHours`, `stepVehicles`:

```ts
describe('pedestrian streets', () => {
  it('new commuters never get a pedestrian home or work road', () => {
    const state = commuterTown(5, 200);
    buildLanes(state, [at(3, 10), at(15, 10)], RoadLane.Pedestrian);
    setHour(state, BALANCE.vehicles.commute.morningStartHour);
    stepVehicles(state);
    for (const v of state.vehicles) {
      expect(state.layers.roadLane[v.homeRoad]).toBe(RoadLane.None);
      if (v.workRoad >= 0) expect(state.layers.roadLane[v.workRoad]).toBe(RoadLane.None);
    }
  });

  it('a commuter cut off by a pedestrian street stays parked and the sim keeps running', () => {
    const state = commuterTown(5, 200);
    setHour(state, BALANCE.vehicles.commute.morningStartHour - 1);
    stepVehicles(state); // spawn
    // The one street: closing a middle tile strands everyone west of it.
    buildLanes(state, [at(12, 10)], RoadLane.Pedestrian);
    runHours(state, 6);
    for (const v of drivingVehicles(state)) {
      expect(v.path).not.toContain(at(12, 10));
    }
    const stranded = state.vehicles.filter(
      (v) => tileX(v.homeRoad, SIZE) < 12 && v.phase === VehiclePhase.ParkedHome,
    );
    expect(stranded.length).toBeGreaterThan(0);
  });
});
```

(`at`, `tileX`, `drivingVehicles`, `VehiclePhase` are already imported in that file. Import `buildLanes` and `RoadLane`.)

`src/sim/transit.test.ts` (fixtures `street()` = road x=2..20 at y=10; `busTown(seed, stops)` = depot at (2,9) on road (2,10), stops at x=6,9,12,15):

```ts
describe('pedestrian streets', () => {
  it('refuses a bus stop on a pedestrian street', () => {
    const state = street();
    state.money = 1e6;
    buildLanes(state, [at(5, 10)], RoadLane.Pedestrian);
    expect(buildBusStops(state, [at(5, 10)])).toEqual({ rejected: 'needsRoadTile' });
    expect(isBusStop(state, at(5, 10))).toBe(false);
  });

  it('a depot no longer reaches stops behind a pedestrian street', () => {
    const state = busTown(1, 2); // stops at x=6 and x=9
    state.money = 1e6;
    syncBusFleet(state);
    expect(busDepotInfo(state, at(2, 9)).stopsInReach).toBe(2);
    buildLanes(state, [at(8, 10)], RoadLane.Pedestrian);
    expect(busDepotInfo(state, at(2, 9)).stopsInReach).toBe(1);
  });
});
```

`src/sim/deliveries.test.ts` (fixture `shopTown(seed, shops)` = road x=2..20 at y=10, depot at (2,9), shops at (6..6+shops-1, 11); `syncFleet`, `planTour`, `dueTicks` already imported):

```ts
describe('pedestrian streets', () => {
  it('a van never stops on a pedestrian tile; a shop with another road beside it is still served', () => {
    const state = shopTown(1, 1); // one shop at (6, 11), road above it at (6, 10)
    state.money = 1e6;
    // A side road south of the shop gives the van a second kerb to stop at.
    buildRoads(state, [at(6, 12), at(5, 12), at(4, 12), at(3, 12), at(2, 12), at(2, 11)]);
    syncFleet(state);
    state.layers.deliveryAge[at(6, 11)] = dueTicks();
    expect(planTour(state, state.vans[0], new Set())).toEqual([at(6, 10), at(2, 10)]);
    buildLanes(state, [at(6, 10)], RoadLane.Pedestrian);
    const tour = planTour(state, state.vans[0], new Set());
    expect(tour).not.toContain(at(6, 10));
    expect(tour[0]).toBe(at(6, 12));
  });

  it('a shop reachable only through a pedestrian street is not on any tour', () => {
    const state = shopTown(1, 1);
    state.money = 1e6;
    syncFleet(state);
    state.layers.deliveryAge[at(6, 11)] = dueTicks();
    buildLanes(state, [at(4, 10)], RoadLane.Pedestrian);
    expect(planTour(state, state.vans[0], new Set())).toEqual([]);
  });
});
```

(If `planTour` orders the first tour differently — it ends at the depot road `at(2, 10)` — adjust only the expected array shape, not the membership assertions. The shop's stop candidates come from `depotReach`, which now excludes pedestrian tiles; the second kerb at `(6, 12)` touches the shop at `(6, 11)` so `oldestShopAge` finds it.)

`src/sim/overpass.test.ts` (fixture `crossingTown()`: road x=5, y=2..13; track y=8, x=2..13; `CROSSING = at(5, 8)`):

```ts
it('refuses an overpass whose deck or ramp tile is a pedestrian street', () => {
  const state = crossingTown();
  buildLanes(state, [CROSSING], RoadLane.Pedestrian);
  expect(overpassRejection(state, CROSSING)).toBe('needsLevelCrossing');
  buildLanes(state, [CROSSING], RoadLane.None);
  buildLanes(state, [at(5, 7)], RoadLane.Pedestrian);
  expect(overpassRejection(state, CROSSING)).toBe('needsRampRoom');
  buildLanes(state, [at(5, 7)], RoadLane.None);
  expect(overpassRejection(state, CROSSING)).toBeNull();
});
```

(Import `buildLanes` from `./lanes.ts` and `RoadLane` from `../shared/types.ts`. Note the circular import `lanes.ts` → `overpass.ts` → nothing back: `overpass.ts` must NOT import `lanes.ts`; it reads `layers.roadLane` directly.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/sim/routing.test.ts src/sim/vehicles.test.ts src/sim/transit.test.ts src/sim/deliveries.test.ts src/sim/overpass.test.ts`
Expected: the new tests FAIL (paths run through the pedestrian tile; stops accepted).

- [ ] **Step 3: Implement**

`src/sim/routing.ts`:

```ts
const isRoad = (state: SimState) => (tile: number) => state.layers.tileType[tile] === TileType.Road;
/** A road tile open to cars, vans and buses: everything but a pedestrian street. */
export const isMotorRoad = (state: SimState) => (tile: number) =>
  state.layers.tileType[tile] === TileType.Road &&
  state.layers.roadLane[tile] !== RoadLane.Pedestrian;
/** Any road tile, pedestrian streets included — the walker's network. */
export const isAnyRoad = isRoad;
```

Switch `findRoadPath` and `roadDistances` to `isMotorRoad(state)`. Import `RoadLane`.

`src/sim/vehicles.ts` `roadTilesNextToZones`: replace `tileType[neighbor] === TileType.Road` with `tileType[neighbor] === TileType.Road && roadLane[neighbor] !== RoadLane.Pedestrian` (destructure `roadLane`, import `RoadLane`).

`src/sim/transit.ts` `buildBusStops`: add `&& layers.roadLane[index] !== RoadLane.Pedestrian` to the `buildable` filter; the rejection stays `needsRoadTile`.

`src/sim/overpass.ts`: in `isRampTile` add `if (layers.roadLane[index] === RoadLane.Pedestrian) return false;` and in `overpassRejection` after the river check add `if (layers.roadLane[index] === RoadLane.Pedestrian) return 'needsLevelCrossing';`.

`src/sim/tick.ts` counts loop: count only tiles with `roadLane !== RoadLane.Pedestrian` toward `roadTiles`/`avenueTiles` for `avenueShare` — simplest: add `motorRoadTiles` and `motorAvenueTiles` locals right there and use them in `avenueShare` only; leave `counts.roadTiles` (used by budget/UI) alone.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/sim`
Expected: PASS, including the existing routing/transit/deliveries suites.

- [ ] **Step 5: Format, full test, commit**

```bash
pnpm format && pnpm test
git add -A src
git commit -m "feat(sim): pedestrian streets are closed to motor traffic

Cars, vans and buses route around pedestrian tiles, commuters never
live or work on one, bus stops and overpasses refuse them.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Walk and cycle decisions, rider stats

**Files:**

- Modify: `src/sim/lanes.ts` (add `canWalk`, `canCycle`)
- Modify: `src/sim/vehicles.ts:375-395` (decision), `src/sim/state.ts:96` (`riderMode` union)
- Modify: `src/sim/transit.ts:395-425` (`transitStats`), `src/shared/types.ts:416-430` (`TransitStats`)
- Modify: every literal `TransitStats` fixture in tests (`goals.test.ts:417-427`, `engine.test.ts`, others found by typecheck) — add `walkRiders: 0, bikeRiders: 0`
- Test: `src/sim/lanes.test.ts`, `src/sim/vehicles.test.ts`

**Interfaces:**

- Produces: `canWalk(state, homeRoad, workRoad): boolean`, `canCycle(state, homeRoad, workRoad): boolean` in `lanes.ts`; `Vehicle.riderMode: 'walk' | 'bike' | 'bus' | 'rail'`; `TransitStats.walkRiders`, `TransitStats.bikeRiders`.

- [ ] **Step 1: Write failing tests**

`src/sim/lanes.test.ts`:

```ts
describe('trip rules', () => {
  it('walks when home and work lie within walkTiles over any road', () => {
    const state = town(); // street x=2..11 at y=8
    const w = BALANCE.cycling.walkTiles;
    expect(canWalk(state, at(2, 8), at(2 + w, 8))).toBe(true);
    expect(canWalk(state, at(2, 8), at(3 + w, 8))).toBe(false);
    // A pedestrian street is walkable.
    buildLanes(state, [at(3, 8)], RoadLane.Pedestrian);
    expect(canWalk(state, at(2, 8), at(2 + w, 8))).toBe(true);
  });

  it('cycles only along bike lanes or pedestrian streets, within bikeTiles', () => {
    const state = town();
    expect(canCycle(state, at(2, 8), at(9, 8))).toBe(false);
    buildLanes(state, [at(3, 8), at(4, 8), at(5, 8), at(6, 8), at(7, 8), at(8, 8)], RoadLane.Bike);
    // Home and work tiles themselves need no lane.
    expect(canCycle(state, at(2, 8), at(9, 8))).toBe(true);
    // One gap breaks the route.
    buildLanes(state, [at(5, 8)], RoadLane.None);
    expect(canCycle(state, at(2, 8), at(9, 8))).toBe(false);
    buildLanes(state, [at(5, 8)], RoadLane.Pedestrian);
    expect(canCycle(state, at(2, 8), at(9, 8))).toBe(true);
  });

  it('respects the bikeTiles bound even on a fully laned road', () => {
    const state = createSimState(1, 40);
    state.layers.elevation.fill(0);
    state.layers.terrain.fill(Terrain.Land);
    state.money = 1e6;
    const n = BALANCE.cycling.bikeTiles + 3;
    const row = Array.from({ length: n }, (_, x) => tileIndex(x + 1, 5, 40));
    buildRoads(state, row);
    buildLanes(state, row, RoadLane.Bike);
    expect(canCycle(state, row[0], row[BALANCE.cycling.bikeTiles])).toBe(true);
    expect(canCycle(state, row[0], row[BALANCE.cycling.bikeTiles + 1])).toBe(false);
  });
});
```

`src/sim/vehicles.test.ts`, new `describe('walking and cycling', ...)`:

```ts
describe('walking and cycling', () => {
  it('a commuter on a laned street cycles, stays parked and does not charge', () => {
    const state = commuterTown(7, 200);
    // Lane the whole street: every home-to-work route runs over lanes.
    buildLanes(
      state,
      Array.from({ length: 16 }, (_, x) => at(x + 3, 10)),
      RoadLane.Bike,
    );
    setHour(state, BALANCE.vehicles.commute.morningStartHour);
    stepVehicles(state);
    runHours(state, 4);
    expect(drivingVehicles(state)).toHaveLength(0);
    expect(state.vehicles.every((v) => isRider(state, v))).toBe(true);
    expect(
      state.vehicles.filter((v) => v.riderMode === 'bike' || v.riderMode === 'walk'),
    ).toHaveLength(state.vehicles.length);
    const stats = transitStats(state);
    expect(stats.bikeRiders + stats.walkRiders).toBe(stats.commuters);
    expect(stats.riderShare).toBe(1);
    // Evening: nobody plugs in.
    setHour(state, 20);
    runHours(state, 2);
    expect(chargingDemand(state)).toBe(0);
  });

  it('walking wins over the bus, cycling over the train', () => {
    const state = commuterTown(7, 200);
    for (let i = 0; i < state.layers.tileType.length; i++) {
      state.layers.transitCover[i] = state.layers.tileType[i] === TileType.Road ? 1 : 0;
    }
    buildLanes(
      state,
      Array.from({ length: 16 }, (_, x) => at(x + 3, 10)),
      RoadLane.Bike,
    );
    setHour(state, BALANCE.vehicles.commute.morningStartHour);
    stepVehicles(state);
    runHours(state, 4);
    expect(state.vehicles.some((v) => v.riderMode === 'bus')).toBe(false);
  });

  it('a short plain-road route does not make a cyclist; lanes decide', () => {
    const state = commuterTown(7, 200);
    setHour(state, BALANCE.vehicles.commute.morningStartHour);
    stepVehicles(state);
    runHours(state, 4);
    // Homes x=3.., jobs x=15..: well over walkTiles apart, no lanes → everyone drives.
    expect(state.vehicles.some((v) => v.riderMode === 'bike' && isRider(state, v))).toBe(false);
    expect(
      drivingVehicles(state).length +
        state.vehicles.filter((v) => v.phase === VehiclePhase.ParkedWork).length,
    ).toBe(state.vehicles.length);
  });

  it('is deterministic with lanes', () => {
    const run = () => {
      const state = commuterTown(9, 200);
      buildLanes(
        state,
        Array.from({ length: 8 }, (_, x) => at(x + 7, 10)),
        RoadLane.Bike,
      );
      setHour(state, BALANCE.vehicles.commute.morningStartHour);
      runHours(state, 30);
      return state.vehicles
        .map((v) => `${v.riderMode}:${v.riderDay}:${v.phase}:${v.charge.toFixed(4)}`)
        .join('|');
    };
    expect(run()).toBe(run());
  });
});
```

(`chargingDemand` and `transitStats` are already imported in that file; import `buildLanes` from `./lanes.ts` and `RoadLane`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/sim/lanes.test.ts src/sim/vehicles.test.ts`
Expected: FAIL — `canWalk` not exported; riders drive.

- [ ] **Step 3: Implement trip rules in `lanes.ts`**

```ts
import { distances, isAnyRoad } from './routing.ts';

const unit = () => 1;

/** Home and work at most `walkTiles` road tiles apart (any road; pavements need no lane). */
export function canWalk(state: SimState, homeRoad: number, workRoad: number): boolean {
  if (homeRoad < 0 || workRoad < 0) return false;
  return distances(state, homeRoad, isAnyRoad(state), unit, BALANCE.cycling.walkTiles).has(
    workRoad,
  );
}

/**
 * A route of at most `bikeTiles` from home to work whose inner tiles all
 * carry a bike lane or are pedestrian streets. The end tiles need none.
 */
export function canCycle(state: SimState, homeRoad: number, workRoad: number): boolean {
  if (homeRoad < 0 || workRoad < 0) return false;
  const { tileType, roadLane } = state.layers;
  const bikeFriendly = (tile: number): boolean =>
    tileType[tile] === TileType.Road &&
    (tile === homeRoad || tile === workRoad || roadLane[tile] !== RoadLane.None);
  return distances(state, homeRoad, bikeFriendly, unit, BALANCE.cycling.bikeTiles).has(workRoad);
}
```

`src/sim/state.ts:96`: `riderMode: 'walk' | 'bike' | 'bus' | 'rail';`

`src/sim/vehicles.ts` decision (replace lines 383-389):

```ts
const walk = canWalk(state, vehicle.homeRoad, vehicle.workRoad);
const bike = !walk && canCycle(state, vehicle.homeRoad, vehicle.workRoad);
const busRide =
  !walk && !bike && transitCover[vehicle.homeRoad] === 1 && transitCover[vehicle.workRoad] === 1;
if (walk || bike || busRide || ridesRail(state, vehicle.homeRoad, vehicle.workRoad)) {
  vehicle.riderDay = day;
  vehicle.riderMode = walk ? 'walk' : bike ? 'bike' : busRide ? 'bus' : 'rail';
  break;
}
```

(import `canWalk`, `canCycle` from `./lanes.ts`.)

`src/shared/types.ts` `TransitStats`: after `railRiders: number;` add `walkRiders: number; bikeRiders: number;`.

`src/sim/transit.ts` `transitStats`: count `walkRiders`, `bikeRiders` by `riderMode`, return them; the `else busRiders++` becomes an explicit `=== 'bus'` branch.

Fix every `TransitStats` literal the typecheck flags (`goals.test.ts` `railReady`, `state.ts` initial `lastTransit`, `engine.test.ts`, agent tests): add `walkRiders: 0, bikeRiders: 0`.

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm typecheck && pnpm vitest run src/sim`
Expected: PASS.

- [ ] **Step 5: Format, full test, commit**

```bash
pnpm format && pnpm test
git add -A src
git commit -m "feat(sim): commuters walk or cycle and leave the car at home

A commuter within walkTiles of work walks; one joined to work by a
route over bike lanes or pedestrian streets of at most bikeTiles
cycles. Both decide before bus and rail, park the car for the day and
so draw no charging load. Stats count both modes.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `activeCity` goal

**Files:**

- Modify: `src/sim/goals.ts:8-32` (id), `~108-125` (streak), `~255` (achievement)
- Modify: `src/sim/state.ts:512,763,1308,1425` (`activeTicks`), `src/shared/types.ts:949` (`activeTicks?`), `src/storage/serialization.ts:37,111,331` (persist like `railTicks`)
- Modify: `src/ui/i18n.tsx` (`goal.activeCity.title/body` EN after `goal.railCity.body` ~line 507, DE ~line 1190)
- Test: `src/sim/goals.test.ts`, `src/storage/serialization.test.ts`

- [ ] **Step 1: Write failing tests**

`src/sim/goals.test.ts` after the `railCity` block:

```ts
describe('activeCity', () => {
  function activeReady(state: SimState): void {
    state.lastTransit = {
      riderShare: 0.5,
      riders: 100,
      busRiders: 0,
      railRiders: 0,
      walkRiders: 30,
      bikeRiders: 30,
      commuters: 200,
      driving: 0,
      stops: 0,
      stopsServed: 0,
      depots: 0,
    };
  }

  it('needs a real city with a quarter of commuters on foot or bike for a whole day', () => {
    const state = bigCity();
    activeReady(state);
    for (let t = 0; t < TICKS_PER_DAY - 1; t++) goalsStep(state);
    expect(state.goalsAchieved.has('activeCity')).toBe(false);
    goalsStep(state);
    expect(state.goalsAchieved.has('activeCity')).toBe(true);
  });

  it('resets the streak when the share lapses', () => {
    const state = bigCity();
    activeReady(state);
    for (let t = 0; t < 10; t++) goalsStep(state);
    expect(state.goalProgress.activeTicks).toBe(10);
    state.lastTransit = { ...state.lastTransit, walkRiders: 1, bikeRiders: 1 };
    goalsStep(state);
    expect(state.goalProgress.activeTicks).toBe(0);
  });
});
```

`src/storage/serialization.test.ts`: extend the test that round-trips `railTicks` (grep for it) with `activeTicks: 7` and an assertion that it survives; also that a non-finite value is dropped, mirroring `railTicks`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/sim/goals.test.ts src/storage/serialization.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`goals.ts`: add `'activeCity'` to `GOAL_IDS` after `'railCity'`. After the railCity streak:

```ts
// A whole day with a real share of commuters walking or cycling, in a real town.
const active = BALANCE.goals.activeCity;
const activeShare = t.commuters > 0 ? (t.walkRiders + t.bikeRiders) / t.commuters : 0;
if (population >= active.minPopulation && activeShare >= active.share) {
  progress.activeTicks++;
} else {
  progress.activeTicks = 0;
}
```

After the railCity achievement:

```ts
if (!achieved.has('activeCity') && progress.activeTicks >= TICKS_PER_DAY) {
  achieved.add('activeCity');
}
```

`state.ts`: `activeTicks: number;` in `goalProgress` type with comment `/** Consecutive activeCity ticks; persisted like railTicks. */`, init `activeTicks: 0`, save `activeTicks: state.goalProgress.activeTicks`, load `state.goalProgress.activeTicks = save.activeTicks ?? 0;`.
`types.ts` `SaveGame`: `/** Consecutive activeCity ticks so far (absent in older saves → 0). */ activeTicks?: number;`.
`serialization.ts`: copy each `railTicks` line for `activeTicks` (type, write, finite-checked read).

`i18n.tsx` EN:

```ts
  'goal.activeCity.title': 'Active city',
  'goal.activeCity.body':
    'A whole day with at least 25% of commuters walking or cycling to work, in a town of 150+.',
```

DE:

```ts
  'goal.activeCity.title': 'Aktive Stadt',
  'goal.activeCity.body':
    'Ein ganzer Tag, an dem mindestens 25 % der Pendler zu Fuß oder mit dem Rad zur Arbeit kommen, in einer Stadt ab 150 Einwohnern.',
```

- [ ] **Step 4: Run tests**

Run: `pnpm typecheck && pnpm vitest run src/sim/goals.test.ts src/storage src/ui`
Expected: PASS (an i18n completeness test, if present, is green with both languages).

- [ ] **Step 5: Format, full test, commit**

```bash
pnpm format && pnpm test
git add -A src
git commit -m "feat(sim): activeCity goal for a day of walking and cycling

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Inspector, agent mirror and `build_lanes` tool, docs

**Files:**

- Modify: `src/sim/inspect.ts:373` (+ `roadLane`), `src/shared/types.ts:588` (`TileInfo.roadLane: RoadLane`)
- Modify: `src/agent/tileMirror.ts:17-60,95-140` (`roadLane`), `src/agent/tools.ts` (`inspect_tile` output `lane`, `build_lanes` tool, `get_build_catalog` costs, tool list order), `src/agent/tools.test.ts:140-150,600+`, `src/agent/tileMirror.test.ts`
- Modify: `docs/agent-tools.md` (table row after `build_overpass`, feature bullet after Railways)
- Test: `src/sim/inspect.test.ts`, `src/agent/tools.test.ts`, `src/agent/tileMirror.test.ts`

**Interfaces:**

- Produces: `TileInfo.roadLane`; `MirroredTile.roadLane`; agent tool `build_lanes` with input `{ from, to } | { tiles }` plus `kind: 'bike' | 'pedestrian' | 'none'`; `inspect_tile` reports `lane: 'none' | 'bike' | 'pedestrian'`.

- [ ] **Step 1: Write failing tests**

`src/sim/inspect.test.ts` next to the roadClass test (~line 408):

```ts
buildLanes(state, [streetTile], RoadLane.Bike);
expect(inspectTile(state, streetTile).roadLane).toBe(RoadLane.Bike);
```

(use the fixture variables that test already has.)

`src/agent/tools.test.ts`: add `'build_lanes'` to the expected tool-name list right after `'build_overpass'`, and:

```ts
it('build_lanes paints lanes along a path, reports rejections and shows up in inspect_tile', async () => {
  const { call, engine } = createHarness();
  engine.state.layers.elevation.fill(0);
  engine.state.money = 1e6;
  const { x, y } = findLand(engine);
  await call('build_road', { from: { x, y }, to: { x: x + 4, y } });
  const off = await call('build_lanes', {
    from: { x, y: y + 3 },
    to: { x: x + 2, y: y + 3 },
    kind: 'bike',
  });
  expect(off).toMatchObject({ ok: false, error: 'needsExistingRoad' });
  const bike = await call('build_lanes', { from: { x, y }, to: { x: x + 4, y }, kind: 'bike' });
  expect(bike).toMatchObject({ ok: true });
  expect(engine.state.layers.roadLane[tileIndex(x + 2, y, SIZE)]).toBe(RoadLane.Bike);
  const ped = await call('build_lanes', { tiles: [{ x: x + 2, y }], kind: 'pedestrian' });
  expect(ped).toMatchObject({ ok: true });
  const info = await call('inspect_tile', { x: x + 2, y });
  expect(info).toMatchObject({ lane: 'pedestrian' });
  const bad = await call('build_lanes', { tiles: [{ x: x + 2, y }], kind: 'tram' });
  expect(bad).toMatchObject({ ok: false });
});
```

(Match the `tiles` input shape to what `readPathTiles` accepts — check `PATH_SCHEMA` in `tools.ts`.)

`src/agent/tileMirror.test.ts`: add `roadLane: 0` to the diff fixtures and assert a diff with `roadLane: 2` is mirrored (`mirror.roadLane[index] === 2`), and that `at(x, y).roadLane` reports it.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/sim/inspect.test.ts src/agent`
Expected: FAIL.

- [ ] **Step 3: Implement**

`types.ts` `TileInfo`: after `roadClass: RoadClass;` add `/** Lane kind of a road tile (None for everything else). */ roadLane: RoadLane;`.
`inspect.ts`: `roadLane: (tileType === TileType.Road ? layers.roadLane[index] : RoadLane.None) as RoadLane,`.

`tileMirror.ts`: field `roadLane: number` in `MirroredTile`, `readonly roadLane: Uint8Array`, allocate, copy `this.roadLane[i] = diff.roadLane;`, return in `at()`.

`tools.ts`:

- `inspect_tile` result (~line 405-420): `lane: LANE_NAME[t.roadLane]` with `const LANE_NAME = ['none', 'bike', 'pedestrian'] as const;` and `const LANE_BY_NAME: Record<string, RoadLane> = { none: RoadLane.None, bike: RoadLane.Bike, pedestrian: RoadLane.Pedestrian };`.
- `get_build_catalog` costs (~line 815): add `bikeLanePerTile`, `pedestrianPerTile`; upkeep likewise.
- New tool after `build_overpass`:

```ts
    {
      name: 'build_lanes',
      description:
        'Put a bike lane (kind "bike") or a pedestrian street (kind "pedestrian") on existing road ' +
        'tiles along an L-shaped path (or explicit tiles); kind "none" removes lanes for free. ' +
        'Tiles that are not roads or already carry the kind are skipped; a path with nothing to ' +
        'build is rejected (needsExistingRoad). A pedestrian street is closed to cars, vans and ' +
        'buses, which route around it, and is refused on a bus stop, a river bridge, a level ' +
        'crossing or an overpass ramp (pedestrianBlocked). Commuters within ' +
        `${BALANCE.cycling.walkTiles} road tiles of work walk; a lane route of at most ` +
        `${BALANCE.cycling.bikeTiles} tiles between home and work makes them cycle. Either way the ` +
        'car stays home and draws no evening charging load.',
      inputSchema: {
        type: 'object',
        properties: {
          ...PATH_SCHEMA.properties,
          kind: { type: 'string', enum: ['bike', 'pedestrian', 'none'] },
        },
        required: ['kind'],
      },
      async execute(input) {
        const kindName = String((input as { kind?: unknown }).kind);
        const kind = LANE_BY_NAME[kindName];
        if (kind === undefined) throw new Error(`unknown lane kind "${kindName}"`);
        const path = readPathTiles(input, tiles);
        const before = requireStats(ctx).money;
        const outcome = await ctx.sendCommand({ type: 'buildLanes', tiles: path, kind });
        return outcomeResult(outcome, { tiles: path.length, kind: kindName, ...spent(ctx, before) });
      },
    },
```

(Match how other tools surface input errors — if they return `{ ok: false, error }` instead of throwing, do the same; check `readPoint`'s failure path.)

`docs/agent-tools.md`: table row after `build_overpass`:

```
| `build_lanes`             | write | Same shape as `build_road` plus `kind` (`bike`, `pedestrian`, `none`); paints a bike lane or pedestrian street on existing road tiles. Pedestrian streets are closed to cars, vans and buses and refused on bus stops, bridges, level crossings and overpass ramps (`pedestrianBlocked`); a path with no road tile is `needsExistingRoad` |
```

Feature bullet after Railways: two or three sentences on the walk/bike rules (`walkTiles` 4, `bikeTiles` 20), `inspect_tile.lane`, and the `activeCity` goal.

- [ ] **Step 4: Run tests**

Run: `pnpm typecheck && pnpm vitest run src/sim/inspect.test.ts src/agent`
Expected: PASS.

- [ ] **Step 5: Format, full test, commit**

```bash
pnpm format && pnpm test
git add -A src docs
git commit -m "feat(agent): build_lanes tool and lane kind in inspect_tile

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Rendering — lane strips, paving, bollards

**Files:**

- Modify: `src/render/infrastructure/roadFurniture.ts` (add `laneStripPieces`, `pavingPieces`, `bollardSpots`)
- Modify: `src/render/roadsMesh.ts` (`roadLane` array, three `GrowingMesh`es, `applyDiffs`, `rebuildFurniture`)
- Test: `src/render/infrastructure/roadFurniture.test.ts`, `src/render/roadsMesh.test.ts`

**Interfaces:**

- Consumes: `TileDiff.roadLane`, `FlatPiece`, `kerbPieces`, `GrowingMesh`, `setupFlat`, `setupRailing`, `layFlat`.
- Produces: `RoadsMesh.laneStrips`, `RoadsMesh.paving`, `RoadsMesh.bollards` (public `GrowingMesh`es for tests); `roadLaneAt(index): number` on `RoadsMesh` and `GameRenderer` (for the UI cost preview in Task 8).

- [ ] **Step 1: Write failing tests**

`src/render/infrastructure/roadFurniture.test.ts`:

```ts
describe('lane strips, paving and bollards', () => {
  it('lays one strip per kerb side of every arm, inside the kerb', () => {
    const pieces = laneStripPieces(DIR_E | DIR_W, 0.62);
    expect(pieces).toHaveLength(4);
    for (const p of pieces) expect(Math.abs(p.cz)).toBeLessThan(0.31 - KERB_WIDTH);
  });
  it('paves the pad and every arm', () => {
    expect(pavingPieces(DIR_N | DIR_S | DIR_E, 0.62)).toHaveLength(4);
    expect(pavingPieces(DIR_N, 0.62)).toHaveLength(2);
  });
  it('puts a row of bollards across an arm that meets a motor road', () => {
    // openEnds: direction bits of arms whose neighbour is NOT pedestrian.
    const spots = bollardSpots(DIR_E | DIR_W, DIR_E, 0.62);
    expect(spots.length).toBe(BOLLARDS_PER_ARM);
    for (const s of spots) expect(s.cx).toBeGreaterThan(0.31);
  });
});
```

`src/render/roadsMesh.test.ts`: the `tiles()` fixture gets `roadLane: 0`; add:

```ts
describe('RoadsMesh lanes', () => {
  it('draws strips on bike-laned tiles and nothing on plain ones', () => {
    const list = tJunction();
    list[at(1, 2)].roadLane = RoadLane.Bike;
    const layer = layerWith(list);
    expect(layer.laneStrips.mesh.count).toBe(2); // dead end: one arm, two sides
    expect(layer.paving.mesh.count).toBe(0);
    expect(layer.bollards.mesh.count).toBe(0);
  });

  it('paves a pedestrian tile, drops its zebra, and bollards the ends that meet motor roads', () => {
    const list = tJunction();
    list[at(2, 2)].roadLane = RoadLane.Pedestrian;
    const layer = layerWith(list);
    expect(layer.paving.mesh.count).toBe(4); // pad + 3 arms
    expect(layer.stripes.mesh.count).toBe(0);
    expect(layer.bollards.mesh.count).toBe(3 * BOLLARDS_PER_ARM);
    expect(layer.bollards.mesh.frustumCulled).toBe(false);
  });

  it('two adjacent pedestrian tiles share no bollards on their common edge', () => {
    const list = tJunction();
    list[at(1, 2)].roadLane = RoadLane.Pedestrian;
    list[at(2, 2)].roadLane = RoadLane.Pedestrian;
    const layer = layerWith(list);
    expect(layer.bollards.mesh.count).toBe(2 * BOLLARDS_PER_ARM); // junction's N and E arms only
  });

  it('reports the lane kind for the cost preview', () => {
    const list = tJunction();
    list[at(1, 2)].roadLane = RoadLane.Bike;
    const layer = layerWith(list);
    expect(layer.roadLaneAt(at(1, 2))).toBe(RoadLane.Bike);
    expect(layer.roadLaneAt(at(2, 2))).toBe(RoadLane.None);
    expect(layer.roadLaneAt(at(0, 0))).toBe(-1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/render/infrastructure/roadFurniture.test.ts src/render/roadsMesh.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement furniture helpers** (`roadFurniture.ts`)

```ts
export const LANE_STRIP_WIDTH = 0.035;
/** Gap between kerb and bike strip. */
const LANE_STRIP_INSET = KERB_WIDTH + 0.01;
export const BOLLARDS_PER_ARM = 3;
export const BOLLARD_SIZE = 0.025;
export const BOLLARD_HEIGHT = 0.07;

/** One bike strip along each side of every arm, just inside the kerb. */
export function laneStripPieces(mask: number, padSize: number): FlatPiece[] {
  const half = padSize / 2;
  const armLength = (1 - padSize) / 2;
  const edge = half - LANE_STRIP_INSET - LANE_STRIP_WIDTH / 2;
  const armCentre = half + armLength / 2;
  const pieces: FlatPiece[] = [];
  for (const { dx, dy, bit } of DIRECTIONS) {
    if ((mask & bit) === 0) continue;
    for (const side of [-1, 1]) {
      pieces.push(
        dx !== 0
          ? { cx: dx * armCentre, cz: side * edge, sizeX: armLength, sizeZ: LANE_STRIP_WIDTH }
          : { cx: side * edge, cz: dy * armCentre, sizeX: LANE_STRIP_WIDTH, sizeZ: armLength },
      );
    }
  }
  return pieces;
}

/** Paving over the pad and every arm of a pedestrian street. */
export function pavingPieces(mask: number, padSize: number): FlatPiece[] {
  const half = padSize / 2;
  const armLength = (1 - padSize) / 2;
  const armCentre = half + armLength / 2;
  const pieces: FlatPiece[] = [{ cx: 0, cz: 0, sizeX: padSize, sizeZ: padSize }];
  for (const { dx, dy, bit } of DIRECTIONS) {
    if ((mask & bit) === 0) continue;
    pieces.push(
      dx !== 0
        ? { cx: dx * armCentre, cz: 0, sizeX: armLength, sizeZ: padSize }
        : { cx: 0, cz: dy * armCentre, sizeX: padSize, sizeZ: armLength },
    );
  }
  return pieces;
}

/**
 * Bollard footprints in a row across each arm in `openEnds` (the arms
 * whose neighbour is a motor road), near the tile edge.
 */
export function bollardSpots(mask: number, openEnds: number, padSize: number): FlatPiece[] {
  const half = padSize / 2;
  const along = 0.5 - BOLLARD_SIZE;
  const gap = padSize / (BOLLARDS_PER_ARM + 1);
  const spots: FlatPiece[] = [];
  for (const { dx, dy, bit } of DIRECTIONS) {
    if ((mask & bit) === 0 || (openEnds & bit) === 0) continue;
    for (let k = 1; k <= BOLLARDS_PER_ARM; k++) {
      const across = -half + gap * k;
      spots.push(
        dx !== 0
          ? { cx: dx * along, cz: across, sizeX: BOLLARD_SIZE, sizeZ: BOLLARD_SIZE }
          : { cx: across, cz: dy * along, sizeX: BOLLARD_SIZE, sizeZ: BOLLARD_SIZE },
      );
    }
  }
  return spots;
}
```

- [ ] **Step 4: Implement in `RoadsMesh`**

- Fields: `private readonly roadLane: Uint8Array;` `readonly laneStrips: GrowingMesh; readonly paving: GrowingMesh; readonly bollards: GrowingMesh;`
- Constructor: `this.roadLane = new Uint8Array(gridSize * gridSize);` and three `GrowingMesh`es with the same unit-box geometry the kerbs use: `laneStrips` colour `0x9a4a3c` (muted red-brown) via `setupFlat`; `paving` colour `0xd9d2c3` via `setupFlat`; `bollards` colour `0x3a3f45` via `setupRailing`.
- `applyDiffs`: `const roadLane = diff.tileType === TileType.Road ? diff.roadLane : 0;` compare/store/`changed = true` like `roadClass`.
- `rebuildFurniture`: inside the loop after `kerbs`, for tiles that are not bridges/ramps:
  - `if (this.roadLane[index] === RoadLane.Bike)` lay `laneStripPieces(mask, size)` at `LINE_HEIGHT` lifted `ROAD_HEIGHT` into `laneStrips`.
  - `if (this.roadLane[index] === RoadLane.Pedestrian)` lay `pavingPieces(mask, size)` at `LINE_HEIGHT` lifted `ROAD_HEIGHT` into `paving`; compute `openEnds` = arms whose neighbour tile is a road with `roadLane !== Pedestrian`; lay `bollardSpots(mask, openEnds, size)` as boxes `BOLLARD_HEIGHT` tall lifted `ROAD_HEIGHT` into `bollards`; `continue` BEFORE the zebra stripes (no zebra on a pedestrian street).
  - Commit all three counts after the loop.
- `roadLaneAt(index): number` → `this.roadMasks[index] < 0 ? -1 : this.roadLane[index]`.
- `GameRenderer` (`src/render/renderer.ts` next to `roadClassAt` ~line 436): `roadLaneAt(index) { return this.roadsMesh.roadLaneAt(index); }`.

- [ ] **Step 5: Run tests**

Run: `pnpm typecheck && pnpm vitest run src/render`
Expected: PASS. Existing kerb/zebra counts unchanged.

- [ ] **Step 6: Format, full test, commit**

```bash
pnpm format && pnpm test
git add -A src
git commit -m "feat(render): bike lane strips, paved pedestrian streets and bollards

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: UI — tools, cost preview, inspector row, HUD, help, i18n

**Files:**

- Modify: `src/ui/useTools.ts` (`ToolId`, `lineToolCommand`, drag-tool branch, `showPathCost`)
- Modify: `src/ui/BuildBar.tsx:44-52` (buttons)
- Modify: `src/ui/TileInspector.tsx:453-459` (lane row)
- Modify: `src/ui/CityVitals.tsx:89-96` (tooltip)
- Modify: `src/ui/HelpPage.tsx:19-20` (new topic)
- Modify: `src/ui/i18n.tsx` (tool names/descs, inspect labels, hud tooltip, help topic; EN + DE)
- Test: `src/ui/useTools.test.ts`

**Interfaces:**

- Consumes: `GameRenderer.roadLaneAt`, `BALANCE.costs.bikeLanePerTile/pedestrianPerTile`, `SimCommand buildLanes`.
- Produces: `ToolId` gains `'bike-lane' | 'pedestrian'` (toolbar-only, no hotkey, like `rail`).

- [ ] **Step 1: Write failing tests** (`src/ui/useTools.test.ts`)

```ts
it('the lane tools send buildLanes with their kind', () => {
  expect(lineToolCommand('bike-lane', [1, 2])).toEqual({
    type: 'buildLanes',
    tiles: [1, 2],
    kind: RoadLane.Bike,
  });
  expect(lineToolCommand('pedestrian', [3])).toEqual({
    type: 'buildLanes',
    tiles: [3],
    kind: RoadLane.Pedestrian,
  });
});
```

and extend the "zero for tools that build no bridges" test with `'bike-lane'`, `'pedestrian'`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/ui/useTools.test.ts`
Expected: FAIL (type error / null).

- [ ] **Step 3: Implement**

`useTools.ts`:

- `ToolId`: add `| 'bike-lane' | 'pedestrian'` after `'overpass'`.
- `lineToolCommand`: `case 'bike-lane': return { type: 'buildLanes', tiles: path, kind: RoadLane.Bike }; case 'pedestrian': return { type: 'buildLanes', tiles: path, kind: RoadLane.Pedestrian };`
- Drag branch condition: add `|| tool === 'bike-lane' || tool === 'pedestrian'`. Add `const lane = tool === 'bike-lane' ? RoadLane.Bike : tool === 'pedestrian' ? RoadLane.Pedestrian : RoadLane.None;` and pass `lane` as a new last parameter to `showPathCost` (all three call sites).
- `showPathCost(..., lane: RoadLane)`: first branch:

```ts
if (lane !== RoadLane.None) {
  // Mirrors src/sim/lanes.ts: one price per road tile that does not carry the kind yet.
  const existing = renderer?.roadLaneAt(index) ?? -1; // -1 no road
  if (existing < 0 || existing === lane) return sum;
  return (
    sum + (lane === RoadLane.Bike ? BALANCE.costs.bikeLanePerTile : BALANCE.costs.pedestrianPerTile)
  );
}
```

`BuildBar.tsx` basics group after `overpass`:

```ts
      { id: 'bike-lane', icon: '🚲', cost: BALANCE.costs.bikeLanePerTile, perTile: true },
      { id: 'pedestrian', icon: '🚶', cost: BALANCE.costs.pedestrianPerTile, perTile: true, descVars: { walk: BALANCE.cycling.walkTiles, bike: BALANCE.cycling.bikeTiles } },
```

(check how `descVars` is interpolated for existing buttons; if none use it, interpolate via `t(key, vars)`.)

`TileInspector.tsx` after the roadClass row:

```tsx
{
  info.roadLane !== RoadLane.None && (
    <Row
      label={t('inspect.roadLane')}
      value={
        info.roadLane === RoadLane.Bike
          ? t('inspect.roadLane.bike')
          : t('inspect.roadLane.pedestrian')
      }
    />
  );
}
```

`CityVitals.tsx`: add `walkRiders: stats.transit.walkRiders, bikeRiders: stats.transit.bikeRiders` to the tooltip vars; show the stat also when `stats.transit.walkRiders + stats.transit.bikeRiders > 0` (extend the visibility condition).

`HelpPage.tsx`: `{ title: 'help.cycling.title', body: 'help.cycling.body' },` after rail.

`i18n.tsx` EN:

```ts
  'tool.bike-lane': 'Bike lane',
  'tool.pedestrian': 'Pedestrian street',
  'tool.bike-lane.desc':
    'Paint a bike lane on existing roads. A commuter with a lane route of at most {bike} tiles between home and work cycles and leaves the car at home.',
  'tool.pedestrian.desc':
    'Close an existing road to cars, vans and buses; they drive around it. Counts as a bike route, and anyone within {walk} tiles of work walks anyway. Not on bus stops, bridges, level crossings or overpass ramps.',
  'inspect.roadLane': 'Lane',
  'inspect.roadLane.bike': 'Bike lane',
  'inspect.roadLane.pedestrian': 'Pedestrian street — closed to motor traffic',
  'hud.transit.title':
    '{riders} commuters without a car ({walkRiders} on foot · {bikeRiders} by bike · {busRiders} by bus · {railRiders} by train) · {buses} buses and {trains} trains on the move · {served} of {stops} stops served',
  'help.cycling.title': 'Cycling and walking',
  'help.cycling.body':
    'Short car trips are the most avoidable load on your grid. A commuter who lives within four road tiles of work walks whatever you build. Paint Bike lanes on existing streets and avenues: a commuter whose home and workplace are joined by a lane route of at most twenty tiles cycles instead of driving. A Pedestrian street counts as a bike route and is closed to cars, vans and buses, which drive around it — so it cannot carry a bus stop, a bridge, a level crossing or an overpass ramp, and a shop on it is stocked from a neighbouring street. Every walker or cyclist is a car that stays parked all day and never plugs in at dusk, which is where the evening charging peak comes from.',
```

(The `tool.bike-lane.desc` / `tool.pedestrian.desc` placeholders `{bike}` and `{walk}` come from `descVars`; the help body may spell numbers out because help text is prose — but keep them equal to `BALANCE.cycling`.)

DE:

```ts
  'tool.bike-lane': 'Radweg',
  'tool.pedestrian': 'Fußgängerzone',
  'tool.bike-lane.desc':
    'Markiere einen Radweg auf bestehenden Straßen. Pendler mit einer Radwegroute von höchstens {bike} Kacheln zwischen Wohnung und Arbeit fahren Rad und lassen das Auto stehen.',
  'tool.pedestrian.desc':
    'Sperre eine bestehende Straße für Autos, Lieferwagen und Busse; sie fahren außen herum. Zählt als Radroute, und wer ohnehin binnen {walk} Kacheln zur Arbeit wohnt, geht zu Fuß. Nicht auf Haltestellen, Brücken, Bahnübergängen oder Überführungsrampen.',
  'inspect.roadLane': 'Spur',
  'inspect.roadLane.bike': 'Radweg',
  'inspect.roadLane.pedestrian': 'Fußgängerzone – für Kraftverkehr gesperrt',
  'hud.transit.title':
    '{riders} Pendler ohne Auto ({walkRiders} zu Fuß · {bikeRiders} Rad · {busRiders} Bus · {railRiders} Bahn) · {buses} Busse und {trains} Züge unterwegs · {served} von {stops} Halten bedient',
  'help.cycling.title': 'Rad und Fuß',
  'help.cycling.body':
    'Kurze Autofahrten sind die vermeidbarste Last in deinem Netz. Wer binnen vier Straßenkacheln von der Arbeit wohnt, geht zu Fuß, egal was du baust. Markiere Radwege auf bestehenden Straßen und Alleen: Pendler, deren Wohnung und Arbeitsplatz eine Radwegroute von höchstens zwanzig Kacheln verbindet, fahren Rad statt Auto. Eine Fußgängerzone zählt als Radroute und ist für Autos, Lieferwagen und Busse gesperrt, die außen herum fahren – deshalb verträgt sie keine Haltestelle, Brücke, keinen Bahnübergang und keine Überführungsrampe, und ein Laden dort wird von der Nachbarstraße beliefert. Jeder Fußgänger oder Radler ist ein Auto, das den ganzen Tag steht und abends nicht lädt – und genau daher kommt die Abendladespitze.',
```

Replace the existing `hud.transit.title` strings (EN line ~20, DE ~698) rather than duplicating the key.

- [ ] **Step 4: Run tests + typecheck + lint**

Run: `pnpm typecheck && pnpm lint && pnpm vitest run src/ui`
Expected: PASS.

- [ ] **Step 5: Format, full test, commit**

```bash
pnpm format && pnpm test
git add -A src
git commit -m "feat(ui): bike lane and pedestrian street tools, inspector and help

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Balancing probe and design-doc notes

**Files:**

- Create (temporary, deleted before commit): `scripts/probe-cycling.mjs` or a `*.probe.test.ts` run once with `pnpm vitest run <file>`
- Modify: `docs/idea.md` (Next ideas: mark cycling done with the probe numbers; mark save slots done)
- Modify: `src/shared/constants.ts` (`cycling` values only if the probe says so)

- [ ] **Step 1: Write the probe**

A vitest file `src/sim/cycling.probe.test.ts` (easier than an .mjs because it imports TS directly):

```ts
import { it } from 'vitest';
import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { PlantType, RoadLane, Zone } from '../shared/types.ts';
import { placePlant } from './energy.ts';
import { SimEngine } from './engine.ts';
import { buildLanes } from './lanes.ts';
import { buildPowerLines } from './powerLines.ts';
import { buildRoads } from './roads.ts';
import { countPopulationAndJobs } from './state.ts';
import { paintZones } from './zones.ts';

const SIZE = 48;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);

function city(lanes: boolean) {
  const engine = new SimEngine(3, SIZE);
  const s = engine.state;
  s.layers.elevation.fill(0);
  s.money = 1e9;
  const roads: number[] = [];
  for (let y = 10; y <= 30; y += 4) for (let x = 8; x <= 40; x++) roads.push(at(x, y));
  for (let x = 8; x <= 40; x += 8) for (let y = 10; y <= 30; y++) roads.push(at(x, y));
  buildRoads(s, roads);
  const homes: number[] = [],
    jobs: number[] = [];
  for (let y = 9; y <= 31; y++)
    for (let x = 7; x <= 41; x++) {
      if (s.layers.tileType[at(x, y)] !== 0) continue;
      (x < 24 ? homes : jobs).push(at(x, y));
    }
  paintZones(s, homes, Zone.Residential);
  paintZones(
    s,
    jobs.filter((_, i) => i % 2 === 0),
    Zone.Commercial,
  );
  paintZones(
    s,
    jobs.filter((_, i) => i % 2 === 1),
    Zone.Retail,
  );
  buildPowerLines(s, roads);
  for (let x = 10; x <= 38; x += 7)
    (placePlant(s, at(x, 34), PlantType.SolarFarm),
      placePlant(s, at(x, 36), PlantType.WindTurbine),
      placePlant(s, at(x, 38), PlantType.Battery));
  if (lanes) buildLanes(s, roads, RoadLane.Bike);
  s.money = 50_000;
  return engine;
}

it('probe: cycling vs none', () => {
  for (const lanes of [false, true]) {
    const engine = city(lanes);
    let eveningCharging = 0,
      eveningTicks = 0,
      riders = 0,
      commuters = 0,
      days = 0;
    for (let t = 0; t < 20 * TICKS_PER_DAY; t++) {
      engine.tick();
      const hour = ((engine.state.tick % TICKS_PER_DAY) / TICKS_PER_DAY) * 24;
      if (t > 10 * TICKS_PER_DAY && hour >= 18 && hour < 22) {
        eveningCharging += engine.state.lastEnergy.chargingConsumption;
        eveningTicks++;
      }
      if (engine.state.tick % TICKS_PER_DAY === 0 && t > 10 * TICKS_PER_DAY) {
        riders += engine.state.lastTransit.walkRiders + engine.state.lastTransit.bikeRiders;
        commuters += engine.state.lastTransit.commuters;
        days++;
      }
    }
    console.log(
      JSON.stringify({
        lanes,
        pop: countPopulationAndJobs(engine.state).population,
        activeShare: riders / Math.max(1, commuters),
        eveningChargingPerTick: eveningCharging / Math.max(1, eveningTicks),
        money: engine.state.money,
      }),
    );
  }
});
```

`SimEngine(seed, size)`, `engine.tick()`, `state.lastEnergy.chargingConsumption` and `countPopulationAndJobs` are the real names; check `paintZones`' signature (`grep -n 'export function paintZones' src/sim/zones.ts`) and the `placePlant` return before running.

- [ ] **Step 2: Run it**

Run: `pnpm vitest run src/sim/cycling.probe.test.ts`
Record both JSON lines. Expect `activeShare` clearly above 0 with lanes and the evening charging figure lower. If `activeShare` with lanes is below ~0.15 on this grid, raise `bikeTiles` to 24; if above ~0.7, lower to 16. If the no-lane city already shows walkers above ~0.3, lower `walkTiles` to 3.

- [ ] **Step 3: Delete the probe, record numbers**

```bash
git rm -q --cached src/sim/cycling.probe.test.ts 2>/dev/null; rm src/sim/cycling.probe.test.ts
```

In `docs/idea.md` "Next ideas", change the cycling bullet to `**Cycling and walking** (done): ...` with two sentences on the mechanic and the probe figures (active share and evening charging with vs without lanes, 20-day probe). Change the save-slots bullet to `(done)` too. Keep the spec in sync if a BALANCE value moved.

- [ ] **Step 4: Format, full checks, commit**

```bash
pnpm format && pnpm typecheck && pnpm lint && pnpm test && pnpm coverage
git add -A docs src/shared/constants.ts
git commit -m "docs: record the cycling probe and mark cycling and save slots done

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review notes

- Spec coverage: state layer (T1), building/pricing/rejections/undo/upkeep (T2), motor traffic + stop/overpass refusals + avenueShare (T3), commuter decision + stats (T4), goal (T5), inspector/agent/docs (T6), rendering (T7), UI/help/i18n (T8), probe + idea.md (T9). Save compatibility in T1 and T5. Van stop relocation needs no code (spec: `depotReach` excludes pedestrian tiles automatically) — tested in T3.
- Names used across tasks: `RoadLane`, `roadLane`, `buildLanes`, `laneRejection`, `lanePrice`, `canWalk`, `canCycle`, `isMotorRoad`, `isAnyRoad`, `isOverpassRamp`, `TransitStats.walkRiders/bikeRiders`, `activeTicks`, `roadLaneAt`, `laneStrips/paving/bollards`, `BOLLARDS_PER_ARM`, tool ids `bike-lane`/`pedestrian`, command `buildLanes`, rejections `needsExistingRoad`/`pedestrianBlocked`.
- Review Focus items 1–5 each have a test in T2, T3, T4, T3, T1/T6 respectively.
