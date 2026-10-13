# Road Overpass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A level crossing can be upgraded to a road overpass: a deck over the track with ramps on the two neighbouring road tiles, no barriers, cars never wait there.

**Architecture:** One new `overpass` tile layer in the simulation, set by a `buildOverpass` command with strict build rules and cleared automatically when its crossing or ramp room goes. The renderer derives ramps from the overpass flag of a road tile's neighbours; the road mesh exposes a `lift(x, y)` the vehicle mesh adds to its ground height. UI tool and agent tool follow the bus-stop pattern.

**Tech Stack:** TypeScript, vitest, three.js (render), React 19 (UI). Commands: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format`.

**Spec:** `docs/superpowers/specs/2026-10-13-road-overpass-design.md`

## Global Constraints

- `src/sim/` stays DOM-free and deterministic; no magic numbers — tuning values go in `BALANCE` (`src/shared/constants.ts`).
- Every user-visible string goes through `src/ui/i18n.tsx`, English AND German.
- Save games stay backward compatible: `overpass` is an optional layer, no `SAVE_VERSION` bump.
- New `InstancedMesh`: `frustumCulled = false`.
- Run `pnpm format` after edits; the pre-commit hook runs typecheck, lint, format:check and tests. Never `--no-verify`.
- Commit messages: imperative summary + short body, one change per commit, ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Agent tool parity: new command → `src/agent/tools.ts` tool + `docs/agent-tools.md` row.
- Keep any single sim test under ~15 s.

## Review Focus

1. A click on an overpass tile that already carries one: must be silent and free (no charge, no rejection) — pinned in Task 1.
2. Undo after building an overpass: the tile returns to a plain crossing and the money comes back — pinned in Task 1.
3. Upgrading a ramp road to an avenue (buildRoad over an existing road) must NOT drop the overpass — the ramp stays a road without track — pinned in Task 2.
4. Loading a save written before this feature: all overpasses zero, no error — pinned in Task 4.
5. Vehicles on a ramp of an east-west road and of a north-south road: lifted by the same amounts at the same fraction along the ramp — pinned in Task 8.

---

### Task 1: Simulation layer, command and build rules

**Files:**

- Create: `src/sim/overpass.ts`
- Create: `src/sim/overpass.test.ts`
- Modify: `src/sim/state.ts` (`UndoEntry.tiles` ~214, `TileLayers` ~310, layer allocation ~638, `snapshotTile` ~840, `collectDiffs` ~876)
- Modify: `src/sim/roads.ts` (`undoLastAction` ~194)
- Modify: `src/shared/types.ts` (`TileDiff` ~875)
- Modify: `src/shared/messages.ts` (~33)
- Modify: `src/sim/engine.ts` (~101)
- Modify: `src/shared/constants.ts` (`costs` ~30)
- Modify: `src/render/railMesh.test.ts`, `src/render/roadsMesh.test.ts` (test tile factories gain `overpass: 0`)

**Interfaces:**

- Produces: `layers.overpass: Uint8Array` (1 on an overpass tile); `TileDiff.overpass: number`; command `{ type: 'buildOverpass'; tiles: number[] }`; `buildOverpasses(state, tiles): BuildResult`; `overpassRejection(state, index): string | null`; `BALANCE.costs.overpass = 150`.

- [ ] **Step 1: Write the failing tests**

`src/sim/overpass.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BALANCE } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { buildOverpasses, overpassRejection } from './overpass.ts';
import { buildRail } from './rail.ts';
import { buildRoads, bulldozeTiles, undoLastAction } from './roads.ts';
import { collectDiffs, createSimState, Terrain, type SimState } from './state.ts';

const SIZE = 16;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);
const CROSSING = at(5, 8);

/** A north-south road crossed by an east-west track at (5, 8). */
function crossingTown(): SimState {
  const state = createSimState(1, SIZE);
  state.layers.elevation.fill(0);
  state.money = 1e6;
  buildRoads(
    state,
    Array.from({ length: 12 }, (_, i) => at(5, i + 2)),
  );
  buildRail(
    state,
    Array.from({ length: 12 }, (_, i) => at(i + 2, 8)),
  );
  return state;
}

describe('buildOverpasses', () => {
  it('upgrades a straight level crossing for the overpass price', () => {
    const state = crossingTown();
    const before = state.money;
    expect(buildOverpasses(state, [CROSSING])).toEqual({});
    expect(state.layers.overpass[CROSSING]).toBe(1);
    expect(state.money).toBe(before - BALANCE.costs.overpass);
    expect(collectDiffs(state).find((d) => d.index === CROSSING)?.overpass).toBe(1);
  });

  it('a second click on the same tile is silent and free', () => {
    const state = crossingTown();
    buildOverpasses(state, [CROSSING]);
    const before = state.money;
    expect(buildOverpasses(state, [CROSSING])).toEqual({});
    expect(state.money).toBe(before);
  });

  it('undo restores the plain crossing and refunds the price', () => {
    const state = crossingTown();
    const before = state.money;
    buildOverpasses(state, [CROSSING]);
    expect(undoLastAction(state)).toEqual({});
    expect(state.layers.overpass[CROSSING]).toBe(0);
    expect(state.money).toBe(before);
  });

  it('rejects a tile that is no level crossing', () => {
    const state = crossingTown();
    expect(overpassRejection(state, at(5, 4))).toBe('needsLevelCrossing'); // road, no track
    expect(overpassRejection(state, at(3, 8))).toBe('needsLevelCrossing'); // track, no road
    expect(overpassRejection(state, at(9, 12))).toBe('needsLevelCrossing'); // empty
    expect(buildOverpasses(state, [at(5, 4)])).toEqual({ rejected: 'needsLevelCrossing' });
  });

  it('rejects a crossing on a river tile', () => {
    const state = crossingTown();
    state.layers.terrain[CROSSING] = Terrain.River;
    expect(overpassRejection(state, CROSSING)).toBe('needsLevelCrossing');
  });

  it('rejects a bend or junction of the track', () => {
    const state = crossingTown();
    buildRail(state, [at(5, 7)]); // spur north out of the crossing: a junction
    expect(overpassRejection(state, CROSSING)).toBe('needsLevelCrossing');
  });

  it('rejects a road that is not straight across the track', () => {
    const state = crossingTown();
    buildRoads(state, [at(6, 8)]); // a road arm east along the track: T-junction
    expect(overpassRejection(state, CROSSING)).toBe('needsStraightCrossing');
  });

  it('rejects a crossing without ramp room', () => {
    const state = crossingTown();
    bulldozeTiles(state, [at(5, 9)]); // south neighbour gone
    expect(overpassRejection(state, CROSSING)).toBe('needsRampRoom');
    const river = crossingTown();
    river.layers.terrain[at(5, 7)] = Terrain.River; // under the north ramp
    expect(overpassRejection(river, CROSSING)).toBe('needsRampRoom');
    const stacked = crossingTown();
    buildRail(
      stacked,
      Array.from({ length: 12 }, (_, i) => at(i + 2, 10)),
    );
    buildOverpasses(stacked, [at(5, 10)]); // (5, 9) is now that overpass's ramp
    expect(overpassRejection(stacked, CROSSING)).toBe('needsRampRoom');
  });

  it('rejects a damaged tile and short funds', () => {
    const state = crossingTown();
    state.layers.damage[CROSSING] = 1;
    expect(overpassRejection(state, CROSSING)).toBe('damaged');
    const poor = crossingTown();
    poor.money = BALANCE.costs.overpass - 1;
    expect(buildOverpasses(poor, [CROSSING])).toEqual({ rejected: 'notEnoughMoney' });
    expect(poor.layers.overpass[CROSSING]).toBe(0);
  });
});
```

The `stacked` case: (5, 10) is a crossing whose ramps are (5, 9) and (5, 11); its north ramp (5, 9) is the south ramp of (5, 8). Ramps are not stored, so the rule is: a ramp neighbour must not itself be an overpass tile AND must not be the ramp of another overpass — implemented as: the neighbour's far neighbour along the road axis is an overpass whose road runs along the same axis.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/sim/overpass.test.ts`
Expected: FAIL — `Cannot find module './overpass.ts'`.

- [ ] **Step 3: Add the layer, diff field, cost and command plumbing**

`src/shared/constants.ts`, inside `costs` after `railBridgePerTile: 60,`:

```ts
    /** Upgrade of a level crossing to a road overpass (deck plus two ramps). */
    overpass: 150,
```

`src/shared/types.ts`, in `TileDiff` after `rail: number;`:

```ts
/** 1 when a road overpass carries the road over the track on this tile. */
overpass: number;
```

`src/shared/messages.ts`, after the `buildBusStop` line:

```ts
  | { type: 'buildOverpass'; tiles: number[] }
```

`src/sim/state.ts`:

- `UndoEntry.tiles` element: add `overpass: number;` after `rail: number;`.
- `TileLayers`: after `rail: Uint8Array;` add
  ```ts
  /** 1 on a level crossing upgraded to a road overpass (persisted). */
  overpass: Uint8Array;
  ```
- Layer allocation (next to `rail: new Uint8Array(tiles),`): `overpass: new Uint8Array(tiles),`
- `snapshotTile`: add `overpass: layers.overpass[index],` after `rail: …`.
- `collectDiffs`: add `overpass: layers.overpass[index],` after `rail: layers.rail[index],`.

`src/sim/roads.ts`, `undoLastAction`: after `layers.rail[tile.index] = tile.rail;` add `layers.overpass[tile.index] = tile.overpass;`.

`src/sim/engine.ts`: import `buildOverpasses` from `./overpass.ts` and add

```ts
      case 'buildOverpass':
        return this.toEvents(buildOverpasses(state, command.tiles));
```

after the `buildBusStop` case.

Test tile factories: in `src/render/railMesh.test.ts` `baseTiles()` and `src/render/roadsMesh.test.ts` `tiles()` add `overpass: 0,` after `rail: 0,` (both cast, but keep them honest). Also `src/sim/engine.test.ts` or other tests that build a full `TileDiff` literal: run `pnpm typecheck` and add `overpass: 0` wherever it complains.

- [ ] **Step 4: Write `src/sim/overpass.ts`**

```ts
import { BALANCE } from '../shared/constants.ts';
import {
  DIR_E,
  DIR_N,
  DIR_S,
  DIR_W,
  LINE_PRESENT,
  tileIndex,
  tileX,
  tileY,
} from '../shared/grid.ts';
import type { BuildResult } from './roads.ts';
import {
  markDirty,
  snapshotTile,
  Terrain,
  TileType,
  type SimState,
  type UndoEntry,
} from './state.ts';

const AXIS_NS = DIR_N | DIR_S;
const AXIS_EW = DIR_E | DIR_W;
const SIDES = DIR_N | DIR_E | DIR_S | DIR_W;

/** The axis a straight mask runs along: 'ns', 'ew', or null for anything else. */
function straightAxis(bits: number): 'ns' | 'ew' | null {
  if (bits === AXIS_NS) return 'ns';
  if (bits === AXIS_EW) return 'ew';
  return null;
}

/** The two tiles on either side of `index` along `axis` (-1 when off the grid). */
function alongAxis(state: SimState, index: number, axis: 'ns' | 'ew'): [number, number] {
  const x = tileX(index, state.size);
  const y = tileY(index, state.size);
  const inside = (nx: number, ny: number) =>
    nx >= 0 && ny >= 0 && nx < state.size && ny < state.size ? tileIndex(nx, ny, state.size) : -1;
  return axis === 'ns'
    ? [inside(x, y - 1), inside(x, y + 1)]
    : [inside(x - 1, y), inside(x + 1, y)];
}

/**
 * The road axis of an overpass-shaped tile: a road tile with straight
 * track and a straight road across it. Null otherwise.
 */
function crossingRoadAxis(state: SimState, index: number): 'ns' | 'ew' | null {
  const { layers } = state;
  if (layers.tileType[index] !== TileType.Road) return null;
  if ((layers.rail[index] & LINE_PRESENT) === 0) return null;
  const track = straightAxis(layers.rail[index] & SIDES);
  const road = straightAxis(layers.roadMask[index] & SIDES);
  if (track === null || road === null || track === road) return null;
  return road;
}

/** Whether `index` can serve as a ramp of an overpass at `deck` (a plain road tile). */
function isRampRoom(state: SimState, index: number, deck: number, axis: 'ns' | 'ew'): boolean {
  if (index < 0) return false;
  const { layers } = state;
  if (layers.tileType[index] !== TileType.Road) return false;
  if (layers.rail[index] !== 0) return false;
  if (layers.terrain[index] === Terrain.River) return false;
  if (layers.overpass[index] !== 0) return false;
  // Not already the ramp of an overpass on its other side along the same axis.
  const [a, b] = alongAxis(state, index, axis);
  const other = a === deck ? b : a;
  return !(other >= 0 && layers.overpass[other] !== 0 && crossingRoadAxis(state, other) === axis);
}

/**
 * Why an overpass cannot be built on `index`, or null when it can. The
 * checks run in the spec's order: level crossing with straight track,
 * straight road across it, ramp room on both sides, no damage.
 */
export function overpassRejection(state: SimState, index: number): string | null {
  const { layers } = state;
  if (layers.tileType[index] !== TileType.Road || (layers.rail[index] & LINE_PRESENT) === 0)
    return 'needsLevelCrossing';
  if (layers.terrain[index] === Terrain.River) return 'needsLevelCrossing';
  const track = straightAxis(layers.rail[index] & SIDES);
  if (track === null) return 'needsLevelCrossing';
  const road = straightAxis(layers.roadMask[index] & SIDES);
  if (road === null || road === track) return 'needsStraightCrossing';
  const [a, b] = alongAxis(state, index, road);
  if (!isRampRoom(state, a, index, road) || !isRampRoom(state, b, index, road))
    return 'needsRampRoom';
  if (layers.damage[index] !== 0) return 'damaged';
  return null;
}

/** Whether an existing overpass at `index` still meets its build rules. */
export function overpassStillValid(state: SimState, index: number): boolean {
  const axis = crossingRoadAxis(state, index);
  if (axis === null || state.layers.terrain[index] === Terrain.River) return false;
  const [a, b] = alongAxis(state, index, axis);
  return isRampRoom(state, a, index, axis) && isRampRoom(state, b, index, axis);
}

/**
 * Upgrade level crossings to overpasses. Tiles that already carry one
 * are skipped without charge; a click that builds nothing reports the
 * first tile's rejection.
 */
export function buildOverpasses(state: SimState, tiles: number[]): BuildResult {
  const { layers } = state;
  const fresh = tiles.filter((index) => layers.overpass[index] === 0);
  if (fresh.length === 0) return {};
  const buildable = fresh.filter((index) => overpassRejection(state, index) === null);
  if (buildable.length === 0) {
    return { rejected: overpassRejection(state, fresh[0]) ?? 'needsLevelCrossing' };
  }
  const cost = buildable.length * BALANCE.costs.overpass;
  if (cost > state.money) return { rejected: 'notEnoughMoney' };

  const undo: UndoEntry = {
    moneyDelta: cost,
    tiles: buildable.map((index) => snapshotTile(state, index)),
  };
  state.money -= cost;
  for (const index of buildable) {
    layers.overpass[index] = 1;
    markDirty(state, index);
  }
  state.undoStack.push(undo);
  return {};
}

/**
 * Drop every overpass among `tiles` whose crossing or ramp room is gone
 * (no refund). Callers pass the edited tiles plus their 4-neighbours.
 */
export function clearInvalidOverpasses(state: SimState, tiles: Iterable<number>): void {
  const { layers } = state;
  for (const index of tiles) {
    if (layers.overpass[index] === 0) continue;
    if (overpassStillValid(state, index)) continue;
    layers.overpass[index] = 0;
    markDirty(state, index);
  }
}
```

Check `Terrain` is exported from `./state.ts` (it is re-exported there; `isBuildable` uses `Terrain.Lake`). If `tileX`/`tileY` live elsewhere, import from `../shared/grid.ts` as `rail.ts` does.

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run src/sim/overpass.test.ts && pnpm typecheck`
Expected: all PASS; typecheck clean (fix any `TileDiff` literal missing `overpass`).

- [ ] **Step 6: Format and commit**

```bash
pnpm format
git add src/sim/overpass.ts src/sim/overpass.test.ts src/sim/state.ts src/sim/roads.ts src/sim/engine.ts src/shared/types.ts src/shared/messages.ts src/shared/constants.ts src/render/railMesh.test.ts src/render/roadsMesh.test.ts
git commit -m "feat(sim): upgrade a level crossing to a road overpass

A new overpass layer, set by the buildOverpass command on a straight
level crossing whose road runs straight across the track and has a
plain road tile on either side for the ramps. Undo refunds it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Automatic removal when the crossing or ramp room goes

**Files:**

- Modify: `src/sim/roads.ts` (`buildRoads` end ~93, `bulldozeTiles` end ~188)
- Modify: `src/sim/rail.ts` (`buildRail` end ~110, `clearRail` ~117)
- Test: `src/sim/overpass.test.ts`

**Interfaces:**

- Consumes: `clearInvalidOverpasses(state, tiles)` from Task 1.

- [ ] **Step 1: Write the failing tests** (append to `src/sim/overpass.test.ts`)

```ts
describe('overpass removal', () => {
  it('goes when its track is removed', () => {
    const state = crossingTown();
    buildOverpasses(state, [CROSSING]);
    bulldozeTiles(state, [CROSSING]); // clears the track (and the road)
    expect(state.layers.overpass[CROSSING]).toBe(0);
  });

  it('goes when a ramp road is bulldozed', () => {
    const state = crossingTown();
    buildOverpasses(state, [CROSSING]);
    bulldozeTiles(state, [at(5, 7)]);
    expect(state.layers.overpass[CROSSING]).toBe(0);
  });

  it('goes when the track becomes a junction', () => {
    const state = crossingTown();
    buildOverpasses(state, [CROSSING]);
    buildRail(state, [at(5, 7)]);
    expect(state.layers.overpass[CROSSING]).toBe(0);
  });

  it('goes when the road grows an arm along the track', () => {
    const state = crossingTown();
    buildOverpasses(state, [CROSSING]);
    buildRoads(state, [at(6, 8)]);
    expect(state.layers.overpass[CROSSING]).toBe(0);
  });

  it('survives an avenue upgrade of its ramps and of itself', () => {
    const state = crossingTown();
    buildOverpasses(state, [CROSSING]);
    buildRoads(state, [at(5, 7), CROSSING, at(5, 9)], true);
    expect(state.layers.overpass[CROSSING]).toBe(1);
  });

  it('removal is covered by the undo of the removing action', () => {
    const state = crossingTown();
    buildOverpasses(state, [CROSSING]);
    bulldozeTiles(state, [at(5, 9)]);
    undoLastAction(state);
    expect(state.layers.overpass[CROSSING]).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/sim/overpass.test.ts -t removal`
Expected: the bulldoze/junction/arm cases FAIL (overpass still 1); the avenue and undo cases may pass already.

- [ ] **Step 3: Hook `clearInvalidOverpasses` into every road and track edit**

`src/sim/roads.ts`: import `clearInvalidOverpasses` from `./overpass.ts`.

- `buildRoads`: after `for (const index of affected) recomputeRoadMask(state, index);` add `clearInvalidOverpasses(state, affected);`.
- `bulldozeTiles`: in the `for (const index of clearable)` block add `layers.overpass[index] = 0;` after `layers.rail[index] = 0;`; after `for (const index of affected) recomputeRoadMask(state, index);` add `clearInvalidOverpasses(state, affected);`.

Watch the import cycle: `overpass.ts` imports the `BuildResult` type from `roads.ts` (type-only, erased) and `roads.ts` imports a function from `overpass.ts` — fine at runtime.

`src/sim/rail.ts`: import `clearInvalidOverpasses` from `./overpass.ts`.

- `buildRail`: after `for (const index of affected) recomputeRailMask(state, index);` add `clearInvalidOverpasses(state, affected);`.
- `clearRail`: after the `recomputeRailMask` loop add `clearInvalidOverpasses(state, withNeighbors(state, tiles));`.

The undo case works because `bulldozeTiles` snapshots `withNeighbors(...)`, which includes the crossing tile, and `undoLastAction` restores `overpass` (Task 1).

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run src/sim/overpass.test.ts src/sim/roads.test.ts src/sim/rail.test.ts`
Expected: PASS.

- [ ] **Step 5: Format and commit**

```bash
pnpm format
git add src/sim/roads.ts src/sim/rail.ts src/sim/overpass.test.ts
git commit -m "feat(sim): drop an overpass whose crossing or ramp room goes

Road and track edits re-check the overpasses among the affected tiles;
one that lost its straight crossing or a ramp road is cleared without
refund, and the undo of that edit brings it back.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Overpasses never close

**Files:**

- Modify: `src/sim/crossings.ts` (~36)
- Test: `src/sim/crossings.test.ts`

- [ ] **Step 1: Write the failing test** (append inside `describe('closedCrossings', …)` in `src/sim/crossings.test.ts`)

```ts
it('never closes an overpass, while the plain crossing beside it still closes', () => {
  const state = crossingTown();
  // A second north-south road two tiles east crosses the same track.
  buildRoads(
    state,
    Array.from({ length: 12 }, (_, i) => at(7, i + 2)),
  );
  buildOverpasses(state, [at(5, 8)]);
  runningTrain(state, 6, 8.5);
  expect([...closedCrossings(state)]).toEqual([at(7, 8)]);
});
```

Add `import { buildOverpasses } from './overpass.ts';` at the top.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/sim/crossings.test.ts`
Expected: FAIL — received `[at(5, 8), at(7, 8)]`.

- [ ] **Step 3: Skip overpass tiles**

In `closedCrossings`, destructure `overpass` too (`const { tileType, rail, overpass } = state.layers;`) and after `if (tileType[index] !== TileType.Road) continue;` add:

```ts
// A road overpass carries the road over the track: nothing to close.
if (overpass[index] !== 0) continue;
```

Update the doc comment's first paragraph: "Only straight crossings count — those are the ones that carry barriers … — and an overpass has none."

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run src/sim/crossings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add src/sim/crossings.ts src/sim/crossings.test.ts
git commit -m "fix(sim): road traffic never waits at an overpass

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Save and load

**Files:**

- Modify: `src/shared/types.ts` (`SaveGame.layers` ~990)
- Modify: `src/sim/state.ts` (`serializeState` ~1333, `deserializeState` ~1444)
- Modify: `src/storage/serialization.ts` (`optionalLayers` ~262)
- Test: `src/storage/serialization.test.ts`, `src/sim/overpass.test.ts`

- [ ] **Step 1: Write the failing tests**

`src/storage/serialization.test.ts`, after the rail round-trip test:

```ts
it('round-trips the optional overpass layer and tolerates its absence', () => {
  const save = makeSave();
  save.layers.overpass = new Uint8Array(save.size * save.size).fill(1).buffer as ArrayBuffer;
  const restored = saveFromJson(saveToJson(save));
  expect(new Uint8Array(restored.layers.overpass!)).toEqual(new Uint8Array(save.layers.overpass));
  const legacy = saveFromJson(saveToJson(makeSave()));
  expect(legacy.layers.overpass).toBeUndefined();
});
```

`src/sim/overpass.test.ts`:

```ts
import { deserializeState, serializeState } from './state.ts';

describe('overpass save games', () => {
  it('survives serialize → deserialize', () => {
    const state = crossingTown();
    buildOverpasses(state, [CROSSING]);
    const restored = deserializeState(serializeState(state));
    expect(restored.layers.overpass[CROSSING]).toBe(1);
  });

  it('loads a save without the layer as all zeros', () => {
    const state = crossingTown();
    buildOverpasses(state, [CROSSING]);
    const save = serializeState(state);
    delete save.layers.overpass;
    const restored = deserializeState(save);
    expect(restored.layers.overpass.every((v) => v === 0)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/storage/serialization.test.ts src/sim/overpass.test.ts`
Expected: FAIL (typecheck error on `layers.overpass`, or `undefined`).

- [ ] **Step 3: Implement**

`src/shared/types.ts`, `SaveGame.layers`: after `rail?: ArrayBuffer;` add `overpass?: ArrayBuffer;`.

`src/sim/state.ts`:

- `serializeState`: after `rail: copyBuffer(layers.rail),` add `overpass: copyBuffer(layers.overpass),`.
- `deserializeState`: after the `save.layers.rail` line add
  `if (save.layers.overpass) state.layers.overpass.set(new Uint8Array(save.layers.overpass));`

`src/storage/serialization.ts`: add `'overpass',` to `optionalLayers` after `'rail',`.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run src/storage/serialization.test.ts src/sim/overpass.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add src/shared/types.ts src/sim/state.ts src/storage/serialization.ts src/storage/serialization.test.ts src/sim/overpass.test.ts
git commit -m "feat(storage): persist the overpass layer

Optional layer: saves from before it load with no overpasses.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Inspector shows the overpass

**Files:**

- Modify: `src/shared/types.ts` (`RailTileInfo` ~450)
- Modify: `src/sim/rail.ts` (`railTileInfo` ~466)
- Modify: `src/ui/TileInspector.tsx` (~608)
- Modify: `src/ui/i18n.tsx` (EN block near `'inspect.railNetwork.value'` ~571, DE block ~1242)
- Test: `src/sim/inspect.test.ts`

- [ ] **Step 1: Write the failing test** (append to `src/sim/inspect.test.ts`; reuse its state factory, or build one like `crossingTown` in Task 1 with `buildRoads`/`buildRail`)

```ts
it('reports an overpass on its track tile', () => {
  const state = createSimState(1, 16);
  state.layers.elevation.fill(0);
  state.money = 1e6;
  buildRoads(
    state,
    Array.from({ length: 12 }, (_, i) => tileIndex(5, i + 2, 16)),
  );
  buildRail(
    state,
    Array.from({ length: 12 }, (_, i) => tileIndex(i + 2, 8, 16)),
  );
  const crossing = tileIndex(5, 8, 16);
  expect(inspectTile(state, crossing).rail?.overpass).toBe(false);
  buildOverpasses(state, [crossing]);
  expect(inspectTile(state, crossing).rail?.overpass).toBe(true);
});
```

Use the inspect function name the file already imports (`inspectTile` or `tileInfo` — check the top of `src/sim/inspect.test.ts`).

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/sim/inspect.test.ts`
Expected: FAIL — `overpass` undefined.

- [ ] **Step 3: Implement**

`src/shared/types.ts`:

```ts
export interface RailTileInfo {
  networkTiles: number;
  trainsInNetwork: number;
  /** A road overpass carries the road over this track tile. */
  overpass: boolean;
}
```

`src/sim/rail.ts`, `railTileInfo`: return `{ networkTiles: …, trainsInNetwork, overpass: state.layers.overpass[tile] !== 0 }`.

`src/ui/TileInspector.tsx`, inside the `info.rail` section after the network `Row`:

```tsx
{
  info.rail.overpass && <Row label={t('inspect.overpass')} value={t('inspect.overpass.value')} />;
}
```

`src/ui/i18n.tsx`, English near `'inspect.railNetwork.value'`:

```ts
  'inspect.overpass': 'Crossing',
  'inspect.overpass.value': 'Road overpass — traffic never waits here',
```

German near its `'inspect.railNetwork.value'`:

```ts
  'inspect.overpass': 'Kreuzung',
  'inspect.overpass.value': 'Straßenüberführung – der Verkehr wartet hier nie',
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run src/sim/inspect.test.ts src/agent && pnpm typecheck`
Expected: PASS (the agent's `inspect_tile` passes `TileInfo` through, so it gains the field with no change; if a test snapshots the rail info shape, extend it).

- [ ] **Step 5: Commit**

```bash
pnpm format
git add src/shared/types.ts src/sim/rail.ts src/ui/TileInspector.tsx src/ui/i18n.tsx src/sim/inspect.test.ts
git commit -m "feat(ui): show a road overpass in the tile inspector

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Track under an overpass is plain track

**Files:**

- Modify: `src/render/railMesh.ts` (`applyDiffs` ~295, `rebuild` ~530)
- Test: `src/render/railMesh.test.ts`

- [ ] **Step 1: Write the failing test** (append to `describe('RailMesh', …)`)

```ts
it('draws plain ballasted track and no barriers under a road overpass', () => {
  const tiles = baseTiles();
  tiles[at(2, 2)].rail = LINE_PRESENT | DIR_E;
  tiles[at(3, 2)].rail = LINE_PRESENT | DIR_E | DIR_W;
  tiles[at(3, 2)].tileType = TileType.Road;
  tiles[at(3, 2)].roadMask = DIR_N | DIR_S;
  tiles[at(3, 2)].overpass = 1;
  tiles[at(4, 2)].rail = LINE_PRESENT | DIR_W;
  const { segments, crossings, centres, barrierPosts, signalHeads } = sceneWith(tiles);
  expect(crossings.count).toBe(0);
  expect(segments.count).toBe(4);
  expect(centres.count).toBe(3);
  expect(barrierPosts.count).toBe(0);
  expect(signalHeads.count).toBe(0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/render/railMesh.test.ts`
Expected: FAIL — `crossings.count` is 2.

- [ ] **Step 3: Implement**

`RailMesh`: add `private readonly overpasses: Uint8Array;` allocated like `tileTypes`. In `applyDiffs`:

```ts
if (this.overpasses[diff.index] !== diff.overpass) {
  this.overpasses[diff.index] = diff.overpass;
  if (diff.rail !== 0) changed = true;
}
```

In `rebuild`, change `const onRoad = this.tileTypes[index] === TileType.Road;` to

```ts
// Under a road overpass the road is in the air: the track is plain.
const onRoad = this.tileTypes[index] === TileType.Road && this.overpasses[index] === 0;
```

Everything downstream (`crossings`, barriers, signal heads, flush rails) keys off `onRoad`.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/render/railMesh.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add src/render/railMesh.ts src/render/railMesh.test.ts
git commit -m "feat(render): plain track under a road overpass

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Deck and ramps in the road mesh

**Files:**

- Modify: `src/render/roadsMesh.ts`
- Test: `src/render/roadsMesh.test.ts`

**Interfaces:**

- Produces: `RoadsMesh.lift(x: number, y: number): number` (world-space extra height of the road surface over the ground at that point: `OVERPASS_LIFT` on a deck tile, `OVERPASS_LIFT * t` on a ramp with `t` = 0 at the far edge, 1 at the deck edge, 0 elsewhere); exported `OVERPASS_LIFT = 0.3`.

Geometry conventions used below (all in `roadsMesh.ts`):

- A **deck tile** (overpass) is drawn like a river bridge but lifted: pad, arms, dashes, deck slab and railings use `this.flatLift(index) = this.elevation.maxCornerY(index) + OVERPASS_LIFT`.
- A **ramp tile** is a road tile `index` with a 4-neighbour `deck` that is an overpass whose road mask has the bit pointing at `index`. `rampOf(index)` returns `{ dx, dz }` (unit step from the ramp toward the deck) or `null`. Its ground is `g = maxCornerY(index)`; the surface height at along-offset `a` (−0.5 at the far edge, +0.5 at the deck edge, measured toward the deck) is `g + OVERPASS_LIFT * (a + 0.5)`.
- `rampMatrix(index, ramp, a, across, sizeAlong, sizeY, sizeAcross, baseLift)` composes a box centred at along `a`/across offset `across`, resting `baseLift` above the ramp surface, pitched by `θ = atan2(OVERPASS_LIFT, 1)` and stretched along by `hypot(1, OVERPASS_LIFT)`.

- [ ] **Step 1: Write the failing tests** (append to `src/render/roadsMesh.test.ts`)

```ts
import { OVERPASS_LIFT } from './roadsMesh.ts'; // add to the existing import line

/** An east-west track under a north-south street with an overpass at (2, 2). */
function overpassRoad(): TileDiff[] {
  const list = tiles();
  road(list, 2, 0, DIR_S);
  road(list, 2, 1, DIR_N | DIR_S);
  road(list, 2, 2, DIR_N | DIR_S);
  road(list, 2, 3, DIR_N | DIR_S);
  road(list, 2, 4, DIR_N);
  Object.assign(list[at(2, 2)], { rail: LINE_PRESENT | DIR_E | DIR_W, overpass: 1 });
  return list;
}

function position(mesh: THREE.InstancedMesh, slot: number): THREE.Vector3 {
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(slot, matrix);
  return new THREE.Vector3().setFromMatrixPosition(matrix);
}

describe('RoadsMesh overpass', () => {
  it('lifts the road surface on the deck and along the ramps', () => {
    const layer = layerWith(overpassRoad());
    expect(layer.lift(2.5, 2.5)).toBeCloseTo(OVERPASS_LIFT, 6);
    // North ramp (2,1): far edge at z = 1, deck edge at z = 2.
    expect(layer.lift(2.5, 1.0)).toBeCloseTo(0, 6);
    expect(layer.lift(2.5, 1.5)).toBeCloseTo(OVERPASS_LIFT / 2, 6);
    expect(layer.lift(2.5, 2.0)).toBeCloseTo(OVERPASS_LIFT, 6);
    // South ramp (2,3): deck edge at z = 3, far edge at z = 4.
    expect(layer.lift(2.5, 3.25)).toBeCloseTo(OVERPASS_LIFT * 0.75, 6);
    // Plain road and off-road: nothing.
    expect(layer.lift(2.5, 0.5)).toBe(0);
    expect(layer.lift(5.5, 5.5)).toBe(0);
  });

  it('draws a deck with two railings on the overpass and walls on both ramps', () => {
    const layer = layerWith(overpassRoad());
    // One deck slab for the overpass tile plus one wedge per ramp.
    expect(layer.decks.count).toBe(3);
    // Two railings on the deck, two walls per ramp.
    expect(layer.rails.mesh.count).toBe(6);
    const deck = position(layer.decks, 0);
    expect(deck.y).toBeGreaterThan(OVERPASS_LIFT - 0.05);
  });

  it('keeps lamps, kerbs, stripes and shelters off deck and ramps', () => {
    const list = overpassRoad();
    list[at(2, 1)].busStop = 1;
    const layer = layerWith(list);
    // Lamps stand on every other tile: (2,0) and (2,4) only ((2,2) is the deck, (2,1)/(2,3) ramps).
    expect(layer.lampPoles.mesh.count).toBe(2);
    expect(layer.shelters.count).toBe(0);
    // Kerbs: the two plain dead ends only (5 pieces each).
    expect(layer.kerbs.mesh.count).toBe(10);
  });

  it('turns a road tile into a ramp when the overpass appears beside it, and back', () => {
    const list = overpassRoad();
    list[at(2, 2)].overpass = 0;
    const layer = layerWith(list);
    expect(layer.lift(2.5, 1.5)).toBe(0);
    layer.applyDiffs([{ ...list[at(2, 2)], overpass: 1 }]);
    expect(layer.lift(2.5, 1.5)).toBeCloseTo(OVERPASS_LIFT / 2, 6);
    layer.applyDiffs([{ ...list[at(2, 2)], overpass: 0 }]);
    expect(layer.lift(2.5, 1.5)).toBe(0);
  });

  it('a ramp pad is pitched toward the deck', () => {
    const layer = layerWith(overpassRoad());
    // The ramp pad is the single `mesh` instance whose centre lies in tile (2,1).
    let pitched = 0;
    const matrix = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    for (let slot = 0; slot < layer.mesh.count; slot++) {
      layer.mesh.getMatrixAt(slot, matrix);
      matrix.decompose(p, q, s);
      if (Math.floor(p.z) !== 1 || Math.floor(p.x) !== 2) continue;
      const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
      expect(forward.y).toBeGreaterThan(0.2); // +z (toward the deck) climbs
      pitched++;
    }
    expect(pitched).toBe(1);
  });
});
```

`layer.decks` and `layer.rails` are private today: make `decks` `readonly` public and change `rails` to a public `readonly rails: GrowingMesh` (Step 3), then the test reads `layer.rails.mesh.count`.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/render/roadsMesh.test.ts`
Expected: FAIL — `lift` is not a function / `OVERPASS_LIFT` not exported.

- [ ] **Step 3: Implement**

In `src/render/roadsMesh.ts`:

1. Constants, next to `DECK_HEIGHT`:
   ```ts
   /** Road surface of an overpass deck above the tile's ground; ramps climb to it over one tile. */
   export const OVERPASS_LIFT = 0.3;
   const RAMP_PITCH = Math.atan2(OVERPASS_LIFT, 1);
   const RAMP_STRETCH = Math.hypot(1, OVERPASS_LIFT);
   ```
2. State: add `private readonly overpass: Uint8Array;` (allocated `new Uint8Array(gridSize * gridSize)`), make `decks` public readonly, replace `private readonly rails: THREE.InstancedMesh` by `readonly rails: GrowingMesh` built as
   ```ts
   this.rails = new GrowingMesh(
     scene,
     deckGeometry,
     surfaceMaterial({ color: RAIL_COLOR }),
     setupRailing,
     gridSize * 4,
   );
   ```
   with
   ```ts
   function setupRailing(mesh: THREE.InstancedMesh): void {
     mesh.frustumCulled = false;
     mesh.castShadow = true;
     mesh.receiveShadow = true;
   }
   ```
   and in `rebuildBridges` use `this.rails.ensure(railCount + 1)` before each `this.rails.mesh.setMatrixAt(railCount++, …)` and `this.rails.commit(railCount)` at the end instead of `count`/`needsUpdate`. Check `GrowingMesh`'s `ensure` keeps the material and setup (it does: `create` reuses them).
3. `applyDiffs`: track the flag and rebuild when it changes on a road tile or when a road tile changes next to an overpass:
   ```ts
   const overpass = diff.tileType === TileType.Road ? diff.overpass : 0;
   if (this.overpass[diff.index] !== overpass) {
     this.overpass[diff.index] = overpass;
     changed = true;
   }
   ```
   (The whole mesh is rebuilt on any change, so ramps follow automatically.)
4. Helpers:
   ```ts
   /** Step from a ramp tile toward its deck, or null when the tile is no ramp. */
   private rampOf(index: number): { dx: number; dz: number } | null {
     if (this.roadMasks[index] < 0 || this.overpass[index] !== 0) return null;
     const x = index % this.gridSize;
     const z = Math.floor(index / this.gridSize);
     for (const { dx, dy, bit } of DIRECTIONS) {
       const nx = x + dx;
       const nz = z + dy;
       if (nx < 0 || nz < 0 || nx >= this.gridSize || nz >= this.gridSize) continue;
       const deck = nz * this.gridSize + nx;
       if (this.overpass[deck] === 0) continue;
       // The deck's road must point back at this tile.
       const back = dx > 0 ? DIR_W : dx < 0 ? DIR_E : dy > 0 ? DIR_N : DIR_S;
       if ((this.roadMasks[deck] & back) !== 0) return { dx, dz: dy };
     }
     return null;
   }

   /** Flat tiles (river bridges and overpass decks) rest at this height. */
   private flatLift(index: number): number {
     return this.elevation.maxCornerY(index) + (this.overpass[index] !== 0 ? OVERPASS_LIFT : 0);
   }

   /** Extra height of the road surface over the ground at a world point (0 off deck and ramps). */
   lift(x: number, y: number): number {
     const size = this.gridSize;
     const tx = Math.floor(x);
     const tz = Math.floor(y);
     if (tx < 0 || tz < 0 || tx >= size || tz >= size) return 0;
     const index = tz * size + tx;
     if (this.overpass[index] !== 0 && this.roadMasks[index] >= 0) return OVERPASS_LIFT;
     const ramp = this.rampOf(index);
     if (!ramp) return 0;
     const fx = x - tx;
     const fz = y - tz;
     const t = ramp.dx > 0 ? fx : ramp.dx < 0 ? 1 - fx : ramp.dz > 0 ? fz : 1 - fz;
     return OVERPASS_LIFT * t;
   }

   /**
    * A box on a ramp: centred `a` along the ramp (−0.5 far edge … +0.5 deck
    * edge) and `across` beside its centre line, its base `baseLift` above
    * the ramp surface, pitched with the ramp and stretched to its length.
    */
   private rampMatrix(
     index: number,
     ramp: { dx: number; dz: number },
     a: number,
     across: number,
     sizeAlong: number,
     sizeY: number,
     sizeAcross: number,
     baseLift: number,
   ): void {
     const cx = (index % this.gridSize) + 0.5;
     const cz = Math.floor(index / this.gridSize) + 0.5;
     const ground = this.elevation.maxCornerY(index);
     const y = ground + OVERPASS_LIFT * (a + 0.5) + baseLift + sizeY / 2;
     const alongX = ramp.dx !== 0;
     const px = cx + (alongX ? ramp.dx * a : across);
     const pz = cz + (alongX ? across : ramp.dz * a);
     this.rampEuler.set(alongX ? 0 : -ramp.dz * RAMP_PITCH, 0, alongX ? ramp.dx * RAMP_PITCH : 0);
     this.rampQuaternion.setFromEuler(this.rampEuler);
     this.rampScale.set(
       alongX ? sizeAlong * RAMP_STRETCH : sizeAcross,
       sizeY,
       alongX ? sizeAcross : sizeAlong * RAMP_STRETCH,
     );
     this.rampPosition.set(px, y, pz);
     this.matrix.compose(this.rampPosition, this.rampQuaternion, this.rampScale);
   }
   ```
   with fields `private readonly rampEuler = new THREE.Euler(); rampQuaternion = new THREE.Quaternion(); rampPosition = new THREE.Vector3(); rampScale = new THREE.Vector3();`. Sign check for the pitch: rotating about +z by +θ lifts the +x end; rotating about +x by −θ lifts the +z end (`Rx(φ)`: z′ of (0,0,1) is cos φ, y′ is −sin φ, so φ = −θ raises it). That is what the test's `forward.y > 0.2` for a +z ramp asserts.
5. `isBridge(index)` → `this.terrain[index] === Terrain.River || this.overpass[index] !== 0` and every `this.elevation.maxCornerY(index)` used as a bridge lift in `setInstance`, `setLineInstance`, `rebuildLamps`, `rebuildShelters`, `rebuildBridges` → `this.flatLift(index)`.
6. `rebuild()` per tile, before the pad/arm code:
   ```ts
   const ramp = this.rampOf(index);
   if (ramp) {
     // One pitched carriageway from the far edge up to the deck edge.
     this.rampMatrix(index, ramp, 0, 0, 1, ROAD_HEIGHT, size, 0);
     this.mesh.setMatrixAt(count++, this.matrix);
     if (isAvenue) {
       const gap = (1 - 2 * LINE_DASHES_PER_ARM * LINE_DASH_LENGTH) / (2 * LINE_DASHES_PER_ARM);
       for (let dash = 0; dash < 2 * LINE_DASHES_PER_ARM; dash++) {
         const a = -0.5 + gap / 2 + LINE_DASH_LENGTH / 2 + dash * (LINE_DASH_LENGTH + gap);
         this.rampMatrix(index, ramp, a, 0, LINE_DASH_LENGTH, LINE_HEIGHT, LINE_WIDTH, ROAD_HEIGHT);
         this.centreLines.setMatrixAt(lineCount++, this.matrix);
       }
     }
     continue;
   }
   ```
   `INSTANCES_PER_TILE` stays sufficient (a ramp uses 1 of its 5).
7. `rebuildBridges()`: iterate decks for `this.isBridge(index)` tiles (river OR overpass) using `flatLift`; then ramps:
   ```ts
   const ramp = this.rampOf(index);
   if (ramp) {
     this.rampMatrix(index, ramp, 0, 0, 1, DECK_HEIGHT, DECK_SIZE, -DECK_HEIGHT);
     this.decks.setMatrixAt(deckCount++, this.matrix);
     const offset = DECK_SIZE / 2 - RAIL_THICKNESS / 2;
     for (const side of [-1, 1]) {
       this.rails.ensure(railCount + 1);
       this.rampMatrix(index, ramp, 0, side * offset, 1, RAIL_HEIGHT, RAIL_THICKNESS, 0);
       this.rails.mesh.setMatrixAt(railCount++, this.matrix);
     }
     continue;
   }
   ```
   Overpass decks get railings via the existing `hasRailings(mask)` branch (the mask is straight by the build rule).
8. Furniture: in `rebuildFurniture` the `isBridge` guard already skips the deck; add `|| this.rampOf(index)` to that guard so ramps get no kerbs/stripes. In `rebuildLamps` add `if (this.overpass[index] !== 0 || this.rampOf(index)) continue;` after the track check. In `rebuildShelters` add the same skip at the top of the loop body.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run src/render/roadsMesh.test.ts src/render/powerLinesMesh.test.ts && pnpm typecheck`
Expected: PASS. If `powerLinesMesh.test.ts` reads `roadsMesh` internals, adjust for the `rails` GrowingMesh.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add src/render/roadsMesh.ts src/render/roadsMesh.test.ts
git commit -m "feat(render): deck and ramps for a road overpass

An overpass tile is drawn like a river bridge lifted OVERPASS_LIFT over
the ground, with railings; the two road tiles along its road become
pitched ramps with a wedge and side walls. lift(x, y) reports the extra
road height for the vehicles.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Vehicles climb the ramps

**Files:**

- Modify: `src/render/vehiclesMesh.ts` (constructor ~168, `roadY` ~334)
- Modify: `src/render/renderer.ts` (~238)
- Test: `src/render/vehiclesMesh.test.ts`

**Interfaces:**

- Consumes: `RoadsMesh.lift(x, y)` (Task 7).
- Produces: `new VehiclesMesh(scene, elevation, terrainAt, roadLift = () => 0)`.

- [ ] **Step 1: Write the failing tests** (append to `src/render/vehiclesMesh.test.ts`)

```ts
describe('overpass ramps', () => {
  /** A ramp climbing toward +z between z = 1 and z = 2 and one toward +x between x = 1 and x = 2. */
  const lift = (x: number, y: number): number => {
    if (Math.floor(x) === 2 && Math.floor(y) === 1) return 0.3 * (y - 1);
    if (Math.floor(y) === 2 && Math.floor(x) === 1) return 0.3 * (x - 1);
    return 0;
  };

  it('lifts the car by the ramp height under it, on either axis', () => {
    const scene = new THREE.Scene();
    const f = field(() => 0);
    const mesh = new VehiclesMesh(scene, f, () => Terrain.Land, lift);
    mesh.setVehicles([car(2.5, 1.5, Math.PI / 2), { ...car(1.5, 2.5, 0), id: 2 }], 1);
    mesh.update(10);
    const m = new THREE.Matrix4();
    for (const vehicle of [car(2.5, 1.5, Math.PI / 2), { ...car(1.5, 2.5, 0), id: 2 }]) {
      const cars = mesh.modelMeshes().get(carStyleOf(vehicle.id))!;
      cars.getMatrixAt(0, m);
      m.decompose(position, quaternion, scale);
      // Half-way up a 0.3 ramp (lane offset keeps the car on the same ramp tile).
      expect(position.y).toBeCloseTo(0.03 + 0.15, 2);
      const forward = new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion);
      expect(forward.y).toBeGreaterThan(0.2); // nose up toward the deck
    }
  });
});
```

If both cars map to the same style mesh, the second `getMatrixAt(0, …)` reads the first car: use `getMatrixAt(slot)` with the slot matching insertion order, or give the second car an id whose `carStyleOf` differs (check `carStyleOf` in `vehicles/variety.ts`).

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/render/vehiclesMesh.test.ts`
Expected: FAIL — `position.y` is 0.03.

- [ ] **Step 3: Implement**

`vehiclesMesh.ts` constructor: add a fourth parameter `private readonly roadLift: (x: number, y: number) => number = () => 0,`. `roadY`:

```ts
  private roadY(x: number, y: number): number {
    const size = this.elevation.gridSize;
    const tx = Math.min(size - 1, Math.max(0, Math.floor(x)));
    const tz = Math.min(size - 1, Math.max(0, Math.floor(y)));
    const index = tz * size + tx;
    const ground =
      this.terrainAt(index) === Terrain.River
        ? this.elevation.maxCornerY(index)
        : this.elevation.surfaceY(x, y);
    return ground + this.roadLift(x, y);
  }
```

Note: a ramp tile's road is drawn on `maxCornerY` (flat) in Task 7 while `surfaceY` follows the ground triangles; the build rule forbids slopes steeper than `maxBuildSlope`, so the mismatch stays small. If it shows, return `maxCornerY(index) + lift` whenever `lift > 0`.

`renderer.ts`:

```ts
this.vehiclesMesh = new VehiclesMesh(
  scene,
  this.elevation,
  (index) => this.terrainAt(index),
  (x, y) => this.roadsMesh.lift(x, y),
);
```

(`roadsMesh` is constructed before `vehiclesMesh`; it is.)

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/render/vehiclesMesh.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add src/render/vehiclesMesh.ts src/render/renderer.ts src/render/vehiclesMesh.test.ts
git commit -m "feat(render): vehicles climb the overpass ramps

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: The Overpass tool

**Files:**

- Modify: `src/ui/useTools.ts` (`ToolId` ~10, click/drag tools ~255)
- Modify: `src/ui/BuildBar.tsx` (~44)
- Modify: `src/ui/i18n.tsx` (tool names ~52/~718, descriptions ~101/~767, rejections ~282/~950)
- Modify: `src/render/renderer.ts` (expose `overpassAt`), `src/render/roadsMesh.ts` (`hasOverpass`)
- Test: `src/ui/useTools.test.ts`

- [ ] **Step 1: Write the failing test** (append to `src/ui/useTools.test.ts`, following its existing pattern for the bus-stop tool — read the file first and copy how it drives `onBuildStart`/`onBuildEnd` and captures `send`)

```ts
it('the overpass tool sends buildOverpass for the clicked tile', () => {
  const { callbacks, sent } = mountWithTool('overpass'); // use the file's own helper name
  callbacks.onBuildStart?.({ index: 42, x: 10, y: 2 });
  callbacks.onBuildEnd?.({ index: 42, x: 10, y: 2 });
  expect(sent).toContainEqual({ type: 'buildOverpass', tiles: [42] });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/ui/useTools.test.ts`
Expected: FAIL (type error on `'overpass'` or no command sent).

- [ ] **Step 3: Implement**

`useTools.ts`: add `| 'overpass'` to `ToolId` after `'bus-stop'`. In the tool branch add `tool === 'overpass'` to the condition list and

```ts
const overpass = tool === 'overpass';
```

Pass it through `showPathCost(path, line, avenue, stop, rail, overpass)` with a new last parameter; inside, before the `stop` branch:

```ts
if (overpass) {
  // Mirrors src/sim/overpass.ts: one price per level crossing without an overpass.
  const crossing = (renderer?.roadClassAt(index) ?? -1) >= 0 && (renderer?.railAt(index) ?? false);
  const built = renderer?.overpassAt(index) ?? false;
  return sum + (crossing && !built ? BALANCE.costs.overpass : 0);
}
```

In `onBuildEnd`'s `send(...)` chain, first branch: `overpass ? { type: 'buildOverpass', tiles: path } : rail ? …`. A drag still produces an L-path; the sim charges only the valid crossings on it.

`roadsMesh.ts`: `hasOverpass(index: number): boolean { return this.overpass[index] !== 0; }`. `renderer.ts`: `overpassAt(index: number): boolean { return this.roadsMesh.hasOverpass(index); }` next to `busStopAt`.

`BuildBar.tsx` basics buttons, after the rail button:

```ts
      { id: 'overpass', icon: '🌉', cost: BALANCE.costs.overpass, perTile: true },
```

`i18n.tsx` English:

```ts
  'tool.overpass': 'Overpass',
  'tool.overpass.desc':
    'Carry a road over the track. Click a straight level crossing with a plain road tile on either side; the barriers go and traffic never waits.',
  'rejection.needsLevelCrossing': 'Overpasses go on a straight level crossing',
  'rejection.needsStraightCrossing': 'The road must run straight across the track',
  'rejection.needsRampRoom': 'Both road tiles beside the crossing must be plain road for the ramps',
```

German:

```ts
  'tool.overpass': 'Überführung',
  'tool.overpass.desc':
    'Führt eine Straße über das Gleis. Auf einen geraden Bahnübergang klicken, der beidseitig eine freie Straßenkachel hat; die Schranken verschwinden, der Verkehr wartet nie.',
  'rejection.needsLevelCrossing': 'Überführungen gehören auf einen geraden Bahnübergang',
  'rejection.needsStraightCrossing': 'Die Straße muss gerade über das Gleis führen',
  'rejection.needsRampRoom': 'Beide Straßenkacheln neben dem Übergang müssen freie Straße sein (Rampen)',
```

Add the three codes to the rejection list in `docs/agent-tools.md` (~line 142).

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run src/ui && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add src/ui/useTools.ts src/ui/BuildBar.tsx src/ui/i18n.tsx src/render/renderer.ts src/render/roadsMesh.ts src/ui/useTools.test.ts docs/agent-tools.md
git commit -m "feat(ui): overpass tool

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Agent tool `build_overpass`

**Files:**

- Modify: `src/agent/tools.ts` (after `build_bus_stop` ~1116)
- Modify: `docs/agent-tools.md` (table ~169)
- Test: `src/agent/tools.test.ts` (tool list ~139, a new case near the bus-stop test ~598)

- [ ] **Step 1: Write the failing tests**

In the tool-name list test add `'build_overpass',` after `'build_bus_stop',`. Append near the bus stop test:

```ts
it('build_overpass upgrades a level crossing and reports the rejection otherwise', async () => {
  const { call, engine } = harness(); // the file's own setup helper
  engine.state.money = 1e6;
  await call('build_road', { from: { x: 5, y: 2 }, to: { x: 5, y: 13 } });
  await call('build_rail', { from: { x: 2, y: 8 }, to: { x: 13, y: 8 } });
  const plain = await call('build_overpass', { x: 5, y: 4 });
  expect(plain).toMatchObject({ ok: false, error: 'needsLevelCrossing' });
  const built = await call('build_overpass', { x: 5, y: 8 });
  expect(built).toMatchObject({ ok: true });
  expect(engine.state.layers.overpass[tileIndex(5, 8, SIZE)]).toBe(1);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/agent/tools.test.ts`
Expected: FAIL — unknown tool.

- [ ] **Step 3: Implement**

`src/agent/tools.ts`, after the `build_bus_stop` entry (use the file's existing single-tile input schema — the one `place_plant` uses for `x`/`y` — and its tile-reading helper):

```ts
    {
      name: 'build_overpass',
      description:
        'Upgrade the level crossing at x, y to a road overpass: the road crosses the track on a ' +
        'bridge, the barriers go and traffic never waits there. Needs a straight track, a straight ' +
        'road across it and a plain road tile (no track, no overpass, not river) on either side ' +
        'along the road for the ramps. Rejected with needsLevelCrossing, needsStraightCrossing ' +
        'or needsRampRoom; removed automatically when the crossing or a ramp road goes.',
      inputSchema: TILE_SCHEMA,
      async execute(input) {
        const tile = readTile(input, tiles);
        const before = requireStats(ctx).money;
        const outcome = await ctx.sendCommand({ type: 'buildOverpass', tiles: [tile] });
        return outcomeResult(outcome, spent(ctx, before));
      },
    },
```

Replace `TILE_SCHEMA`/`readTile` with the names the file actually uses for `place_plant`'s `x`/`y` input.

`docs/agent-tools.md` table, after the `build_bus_stop` row:

```
| `build_overpass`          | write | `x`, `y` of a straight level crossing; carries the road over the track (no barriers, no waiting). Needs a plain road tile either side along the road for the ramps; rejected with `needsLevelCrossing`, `needsStraightCrossing`, `needsRampRoom` |
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/agent && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add src/agent/tools.ts src/agent/tools.test.ts docs/agent-tools.md
git commit -m "feat(agent): build_overpass tool

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Full gate and help text

**Files:**

- Modify: `src/ui/i18n.tsx` (`help.rail.body` EN ~331 and DE)

- [ ] **Step 1: Add one sentence to the railway help**

English `help.rail.body`, after "…it holds the street up until then.": ` An Overpass on a straight crossing carries the road over the track, so that street never waits.` German equivalent after the matching sentence: ` Eine Überführung auf einem geraden Übergang führt die Straße über das Gleis; diese Straße wartet nie.`

- [ ] **Step 2: Run the whole gate**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add src/ui/i18n.tsx
git commit -m "docs(ui): mention the overpass in the railway help

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 4: Visual check on the Mac** (`pnpm dev`): build a crossing, upgrade it, watch a car take the ramp and a train pass under the deck; the sandbox has no WebGL.
