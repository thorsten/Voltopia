# Building Visuals Stage 2 (Animated Accents) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chimney smoke on self-heated houses in the cold, faint puffs
from the market hall's vent stacks, and a night-only red blinking beacon
on the office block and tower antennas — all render-only.

**Architecture:** Recipe parts gain an optional role tag (chimney, vent,
antenna). `BuildingsMesh` derives world-space anchors of tagged parts
and forwards them, with the tile's heat/supply/damage state, through a
small `AccentSink` interface to a new `BuildingFxMesh` diff layer that
owns two instanced meshes (puff spheres, beacon boxes), rebuilt per
frame with motion on and only on change with reduced motion. The sim's
heating-degree curve moves to `src/shared/heating.ts` so the renderer
can share it without importing from `src/sim/`.

**Tech Stack:** TypeScript (strict), three.js, Vitest, pnpm, oxlint,
oxfmt.

**Spec:** `docs/superpowers/specs/2026-10-03-building-accents-design.md`

## Global Constraints

- No sim behaviour, worker protocol (`src/shared/types.ts`,
  `src/shared/messages.ts`) or save-format change. The only `src/sim/`
  edits are import moves.
- `src/render/` never imports from `src/sim/`; shared logic lives in
  `src/shared/`.
- Every `InstancedMesh` sets `frustumCulled = false`.
- No `Math.random`: emitter phases are a hash of the tile index.
- Effect constants are module constants in `buildingFxMesh.ts`; `BALANCE`
  is only read (`BALANCE.seasons.heating`), never extended.
- Recipes stay deterministic and every existing part stays identical:
  adding `role` must not change the picker stream or any geometry.
- Run `pnpm format` after every edit; the pre-commit hook runs
  `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`.
  Never `--no-verify`.
- Coverage gate: `src/shared/**` must stay ≥ 90 %, so the new shared
  module ships with its tests in the same task.

---

### Task 1: Move the heating/cooling degree curves to `src/shared/heating.ts`

**Files:**

- Create: `src/shared/heating.ts`
- Create: `src/shared/heating.test.ts`
- Modify: `src/sim/seasons.ts:30-40` (delete the two functions)
- Modify: `src/sim/seasons.test.ts:3,116-139` (drop the moved tests and import)
- Modify: `src/sim/energy.ts:9`
- Modify: `src/sim/heat.ts:19`

**Interfaces:**

- Produces: `heatingDegree(temperature: number): number` and
  `coolingDegree(temperature: number): number` exported from
  `src/shared/heating.ts`, same bodies as today.

- [ ] **Step 1: Write the failing test**

```ts
// src/shared/heating.test.ts
import { describe, expect, it } from 'vitest';
import { BALANCE } from './constants.ts';
import { coolingDegree, heatingDegree } from './heating.ts';

const { seasons } = BALANCE;

describe('heatingDegree', () => {
  it('is 0 at or above the comfort temperature', () => {
    expect(heatingDegree(seasons.heating.comfortTemperature)).toBe(0);
    expect(heatingDegree(30)).toBe(0);
  });

  it('reaches 1 at the bottom of the heating range and is linear between', () => {
    const { comfortTemperature, heatingRange } = seasons.heating;
    expect(heatingDegree(comfortTemperature - heatingRange)).toBe(1);
    expect(heatingDegree(comfortTemperature - heatingRange - 10)).toBe(1);
    expect(heatingDegree(comfortTemperature - heatingRange / 2)).toBeCloseTo(0.5, 9);
  });
});

describe('coolingDegree', () => {
  it('is 0 at or below the cooling comfort temperature', () => {
    expect(coolingDegree(seasons.cooling.comfortTemperature)).toBe(0);
    expect(coolingDegree(-10)).toBe(0);
  });

  it('reaches 1 at the top of the cooling range and is linear between', () => {
    const { comfortTemperature, coolingRange } = seasons.cooling;
    expect(coolingDegree(comfortTemperature + coolingRange)).toBe(1);
    expect(coolingDegree(comfortTemperature + coolingRange + 10)).toBe(1);
    expect(coolingDegree(comfortTemperature + coolingRange / 2)).toBeCloseTo(0.5, 9);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/shared/heating.test.ts`
Expected: FAIL — cannot resolve `./heating.ts`.

- [ ] **Step 3: Create the shared module and move the functions**

```ts
// src/shared/heating.ts
import { BALANCE } from './constants.ts';

/**
 * Degree curves shared by the sim (heating/cooling load) and the
 * renderer (chimney smoke strength), so a house stops smoking at exactly
 * the temperature where its heating load reaches zero.
 */

/** 0..1 heating demand share: 0 at comfort temperature, 1 heatingRange below it. */
export function heatingDegree(temperature: number): number {
  const { comfortTemperature, heatingRange } = BALANCE.seasons.heating;
  return Math.min(1, Math.max(0, (comfortTemperature - temperature) / heatingRange));
}

/** 0..1 cooling demand share: 0 at comfort temperature, 1 coolingRange above it. */
export function coolingDegree(temperature: number): number {
  const { comfortTemperature, coolingRange } = BALANCE.seasons.cooling;
  return Math.min(1, Math.max(0, (temperature - comfortTemperature) / coolingRange));
}
```

In `src/sim/seasons.ts` delete the `heatingDegree` and `coolingDegree`
functions (lines 30–40, including their doc comments). In
`src/sim/energy.ts` replace line 9 with:

```ts
import { coolingDegree, heatingDegree } from '../shared/heating.ts';
```

In `src/sim/heat.ts` replace line 19 with:

```ts
import { heatingDegree } from '../shared/heating.ts';
```

In `src/sim/seasons.test.ts` change the import on line 3 to
`import { daysPerYear, seasonState, yearPhase } from './seasons.ts';`
and delete the two `describe('heatingDegree', …)` and
`describe('coolingDegree', …)` blocks (they now live in
`src/shared/heating.test.ts`). If `const { seasons } = BALANCE;` is then
unused in that file, delete it and the `BALANCE` import too (lint fails
on unused bindings).

- [ ] **Step 4: Run the tests and typecheck**

Run: `pnpm format && pnpm typecheck && pnpm vitest run src/shared src/sim/seasons.test.ts src/sim/energy.test.ts src/sim/heat.test.ts`
Expected: PASS; no remaining references
(`grep -rn "heatingDegree\|coolingDegree" src/sim/seasons.ts` prints nothing).

- [ ] **Step 5: Commit**

```bash
git add src/shared/heating.ts src/shared/heating.test.ts src/sim/seasons.ts src/sim/seasons.test.ts src/sim/energy.ts src/sim/heat.ts
git commit -m "refactor(shared): move the heating/cooling degree curves next to daylight

The renderer will drive chimney smoke from the same heating-degree curve
the sim uses for heating load, and render code must not import from
src/sim, so the two pure functions move to src/shared/heating.ts.
Behaviour unchanged."
```

---

### Task 2: Role tags on recipe parts

**Files:**

- Modify: `src/render/buildings/recipes.ts:16-35` (type), `:137-148`
  (`box` flags), `:293-297` (house chimney), `:463-473` (office
  antenna), `:504-514` (tower antenna), `:610-622` (hall vents)
- Test: `src/render/buildings/recipes.test.ts`

**Interfaces:**

- Produces: `PartRole = { Chimney: 0, Vent: 1, Antenna: 2 }` (const
  object + type, same style as `PartKind`), `BuildingPart.role?: PartRole`.

- [ ] **Step 1: Write the failing tests**

Append to `src/render/buildings/recipes.test.ts` (add `PartRole` to the
`./recipes.ts` import list):

```ts
describe('part roles (stage 2 accents)', () => {
  function roles(parts: readonly BuildingPart[], role: PartRole): BuildingPart[] {
    return parts.filter((p) => p.role === role);
  }

  it('tags exactly one chimney on every detached house', () => {
    for (const index of SAMPLE) {
      for (let variant = 0; variant < VARIANTS; variant++) {
        for (const face of STREET_FACES) {
          const parts = buildingParts(Zone.Residential, 1, variant, index, face);
          const chimneys = roles(parts, PartRole.Chimney);
          expect(chimneys).toHaveLength(1);
          expect(chimneys[0].color.getHex()).toBe(ACCENT.chimney.getHex());
        }
      }
    }
  });

  it('tags one antenna on the office block and the tower', () => {
    for (const index of SAMPLE) {
      for (let variant = 0; variant < VARIANTS; variant++) {
        for (const density of [2, 3]) {
          const parts = buildingParts(Zone.Commercial, density, variant, index, StreetFace.South);
          const antennas = roles(parts, PartRole.Antenna);
          expect(antennas).toHaveLength(1);
          expect(antennas[0].kind).toBe(PartKind.Cylinder);
        }
      }
    }
  });

  it('tags two vents on the market hall', () => {
    for (const index of SAMPLE) {
      for (let variant = 0; variant < VARIANTS; variant++) {
        for (const face of STREET_FACES) {
          const parts = buildingParts(Zone.Retail, 3, variant, index, face);
          expect(roles(parts, PartRole.Vent)).toHaveLength(2);
        }
      }
    }
  });

  it('tags nothing on any other recipe and never rotates a tagged part', () => {
    for (const { zone, density, parts } of allRecipes(SAMPLE)) {
      const tagged = parts.filter((p) => p.role !== undefined);
      const expected =
        (zone === Zone.Residential && density === 1) ||
        (zone === Zone.Commercial && density >= 2) ||
        (zone === Zone.Retail && density === 3);
      if (!expected) expect(tagged).toHaveLength(0);
      for (const p of tagged) {
        expect(p.turn).toBe(0);
        expect(p.tilt).toBeUndefined();
      }
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/render/buildings/recipes.test.ts`
Expected: FAIL — `PartRole` is not exported.

- [ ] **Step 3: Add the role type and tag the four recipes**

In `src/render/buildings/recipes.ts`, after the `StreetFace` block
(before `export interface BuildingPart`):

```ts
/** Parts the stage 2 effects layer attaches to (smoke, puffs, beacon). */
export const PartRole = { Chimney: 0, Vent: 1, Antenna: 2 } as const;
export type PartRole = (typeof PartRole)[keyof typeof PartRole];
```

Add to `BuildingPart` after `accent?: boolean;`:

```ts
  /** Effect anchor for buildingFxMesh.ts; the anchor is the part's top centre. */
  role?: PartRole;
```

Widen the `box` helper's flags parameter:

```ts
  flags: { main?: boolean; accent?: boolean; role?: PartRole } = {},
```

House chimney (the `box(0.06, 0.18, 0.06, …, ACCENT.chimney, …)` call):

```ts
      box(0.06, 0.18, 0.06, ox + sideX * w * 0.3, h, oz + sideZ * d * 0.25, ACCENT.chimney, {
        accent: true,
        role: PartRole.Chimney,
      }),
```

Office-block antenna and tower antenna (the two `kind: PartKind.Cylinder`
literals with `color: ACCENT.antenna` in `commercial`): add
`role: PartRole.Antenna,` after `accent: true,`.

Market-hall vent stacks (the `for (const side of [-1, 1])` loop in
`retail`): add `role: PartRole.Vent,` after `accent: true,`.

- [ ] **Step 4: Run the recipe tests**

Run: `pnpm format && pnpm vitest run src/render/buildings/recipes.test.ts`
Expected: PASS, including the existing determinism and budget tests.

- [ ] **Step 5: Commit**

```bash
git add src/render/buildings/recipes.ts src/render/buildings/recipes.test.ts
git commit -m "feat(render): tag chimney, vent and antenna parts with a role

Stage 2 effects attach to these parts. Pure data: no geometry or picker
change."
```

---

### Task 3: Accent anchors and the sink interface

**Files:**

- Create: `src/render/buildings/accents.ts`
- Create: `src/render/buildings/accents.test.ts`
- Modify: `src/render/buildingsMesh.ts:42-51` (`TileBuilding`),
  `:79-85` (constructor), `:157-199` (`applyDiffs`), `:239-283`
  (`place`), `:284-298` (`remove`)
- Test: `src/render/buildingsMesh.test.ts`

**Interfaces:**

- Consumes: `PartRole`, `BuildingPart.role` (Task 2).
- Produces (all in `src/render/buildings/accents.ts`):

```ts
export interface AccentAnchor {
  role: PartRole;
  x: number;
  y: number;
  z: number;
}
export interface AccentState {
  heated: boolean;
  supplied: SupplyStatus;
  damaged: boolean;
}
export interface AccentSink {
  set(index: number, anchors: readonly AccentAnchor[], state: AccentState): void;
  setState(index: number, state: AccentState): void;
  remove(index: number): void;
}
export function accentAnchors(
  parts: readonly BuildingPart[],
  cx: number,
  cz: number,
  lift: number,
): AccentAnchor[];
```

`BuildingsMesh` constructor becomes
`(scene, gridSize, elevation, accents?: AccentSink)`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/render/buildings/accents.test.ts
import { describe, expect, it } from 'vitest';
import { Zone } from '../../shared/types.ts';
import { PartRole, StreetFace, buildingParts } from './recipes.ts';
import { accentAnchors } from './accents.ts';

describe('accentAnchors', () => {
  it('places the chimney anchor at the chimney top, offset from the tile centre and lifted', () => {
    const parts = buildingParts(Zone.Residential, 1, 0, 11, StreetFace.South);
    const chimney = parts.find((p) => p.role === PartRole.Chimney)!;
    const anchors = accentAnchors(parts, 3.5, 7.5, 0.4);
    expect(anchors).toHaveLength(1);
    expect(anchors[0].role).toBe(PartRole.Chimney);
    expect(anchors[0].x).toBeCloseTo(3.5 + chimney.ox, 9);
    expect(anchors[0].z).toBeCloseTo(7.5 + chimney.oz, 9);
    expect(anchors[0].y).toBeCloseTo(0.4 + chimney.oy + chimney.sy, 9);
  });

  it('returns both vents of a market hall and nothing for an untagged recipe', () => {
    const hall = buildingParts(Zone.Retail, 3, 2, 5, StreetFace.East);
    expect(accentAnchors(hall, 0.5, 0.5, 0).map((a) => a.role)).toEqual([
      PartRole.Vent,
      PartRole.Vent,
    ]);
    const shop = buildingParts(Zone.Retail, 1, 2, 5, StreetFace.East);
    expect(accentAnchors(shop, 0.5, 0.5, 0)).toEqual([]);
  });
});
```

Append to `src/render/buildingsMesh.test.ts` (add
`import { type AccentAnchor, type AccentSink, type AccentState } from './buildings/accents.ts';`
and `PartRole` to the `./buildings/recipes.ts` import):

```ts
/** Records every sink call so tests can assert what the mesh forwarded. */
class RecordingSink implements AccentSink {
  calls: Array<
    | { op: 'set'; index: number; anchors: readonly AccentAnchor[]; state: AccentState }
    | { op: 'setState'; index: number; state: AccentState }
    | { op: 'remove'; index: number }
  > = [];
  set(index: number, anchors: readonly AccentAnchor[], state: AccentState): void {
    this.calls.push({ op: 'set', index, anchors, state });
  }
  setState(index: number, state: AccentState): void {
    this.calls.push({ op: 'setState', index, state });
  }
  remove(index: number): void {
    this.calls.push({ op: 'remove', index });
  }
}

function setupWithSink(): { mesh: BuildingsMesh; sink: RecordingSink } {
  const sink = new RecordingSink();
  const mesh = new BuildingsMesh(new THREE.Scene(), SIZE, flatField(), sink);
  mesh.setReducedMotion(true);
  return { mesh, sink };
}

describe('BuildingsMesh accent sink', () => {
  it('forwards one chimney anchor at the chimney top when a house is placed', () => {
    const { mesh, sink } = setupWithSink();
    mesh.applyDiffs([building(CENTRE, Zone.Residential, 1, 3)]);
    const chimney = mesh.partsAt(CENTRE)!.find((p) => p.role === PartRole.Chimney)!;
    expect(sink.calls).toHaveLength(1);
    const call = sink.calls[0];
    expect(call.op).toBe('set');
    if (call.op !== 'set') return;
    expect(call.index).toBe(CENTRE);
    expect(call.anchors).toHaveLength(1);
    expect(call.anchors[0].role).toBe(PartRole.Chimney);
    expect(call.anchors[0].x).toBeCloseTo(3.5 + chimney.ox, 9);
    expect(call.anchors[0].z).toBeCloseTo(3.5 + chimney.oz, 9);
    expect(call.anchors[0].y).toBeCloseTo(chimney.oy + chimney.sy, 9);
    expect(call.state).toEqual({ heated: false, supplied: SupplyStatus.Supplied, damaged: false });
  });

  it('forwards two vent anchors for a market hall and nothing for a shop', () => {
    const { mesh, sink } = setupWithSink();
    mesh.applyDiffs([building(CENTRE, Zone.Retail, 3, 0), building(CENTRE + 1, Zone.Retail, 1, 0)]);
    const sets = sink.calls.filter((c) => c.op === 'set');
    expect(sets).toHaveLength(1);
    const first = sets[0];
    expect(first.index).toBe(CENTRE);
    if (first.op !== 'set') return;
    expect(first.anchors.map((a) => a.role)).toEqual([PartRole.Vent, PartRole.Vent]);
  });

  it('sends only a state update on a supply, heat or damage flip', () => {
    const { mesh, sink } = setupWithSink();
    mesh.applyDiffs([building(CENTRE, Zone.Residential, 1, 0)]);
    sink.calls = [];
    mesh.applyDiffs([{ ...building(CENTRE, Zone.Residential, 1, 0), heated: true } as TileDiff]);
    mesh.applyDiffs([
      { ...building(CENTRE, Zone.Residential, 1, 0), heated: true, damage: 40 } as TileDiff,
    ]);
    mesh.applyDiffs([building(CENTRE, Zone.Residential, 1, 0, SupplyStatus.NotConnected)]);
    expect(sink.calls.map((c) => c.op)).toEqual(['setState', 'setState', 'setState']);
    expect(sink.calls[0]).toMatchObject({ state: { heated: true, damaged: false } });
    expect(sink.calls[1]).toMatchObject({ state: { heated: true, damaged: true } });
    expect(sink.calls[2]).toMatchObject({
      state: { heated: false, damaged: false, supplied: SupplyStatus.NotConnected },
    });
    // An unchanged re-send is not a flip.
    sink.calls = [];
    mesh.applyDiffs([building(CENTRE, Zone.Residential, 1, 0, SupplyStatus.NotConnected)]);
    expect(sink.calls).toEqual([]);
  });

  it('re-issues anchors when a road beside the house turns it, and removes them with the building', () => {
    const { mesh, sink } = setupWithSink();
    mesh.applyDiffs([building(CENTRE, Zone.Residential, 1, 0)]);
    sink.calls = [];
    mesh.applyDiffs([road(CENTRE + 1)]); // east of the house → face flips from South to East
    expect(sink.calls.map((c) => c.op)).toEqual(['set']);
    sink.calls = [];
    mesh.applyDiffs([building(CENTRE, Zone.Residential, 2, 0)]); // densify: town house has no roles
    expect(sink.calls.map((c) => c.op)).toEqual(['remove']);
    sink.calls = [];
    mesh.applyDiffs([building(CENTRE, Zone.Residential, 1, 0)]);
    mesh.applyDiffs([empty(CENTRE)]);
    expect(sink.calls.map((c) => c.op)).toEqual(['set', 'remove']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/render/buildings/accents.test.ts src/render/buildingsMesh.test.ts`
Expected: FAIL — cannot resolve `./accents.ts`; `BuildingsMesh` takes
three constructor arguments.

- [ ] **Step 3: Create `accents.ts`**

```ts
// src/render/buildings/accents.ts
import type { SupplyStatus } from '../../shared/types.ts';
import type { BuildingPart, PartRole } from './recipes.ts';

/** World-space top centre of a role-tagged part. */
export interface AccentAnchor {
  role: PartRole;
  x: number;
  y: number;
  z: number;
}

/** The per-tile state the effects depend on. */
export interface AccentState {
  /** On the district-heating network this tick. */
  heated: boolean;
  supplied: SupplyStatus;
  /** damage > 0: the building is out of service. */
  damaged: boolean;
}

/**
 * Receiver of a building's effect anchors. `BuildingsMesh` talks to it
 * instead of to the effects layer directly, so the two stay separately
 * testable.
 */
export interface AccentSink {
  /** Create or replace the anchors (and state) of the building on `index`. */
  set(index: number, anchors: readonly AccentAnchor[], state: AccentState): void;
  /** Only the state changed (supply, heat or damage flip). */
  setState(index: number, state: AccentState): void;
  remove(index: number): void;
}

/**
 * Anchors of every role-tagged part: tile centre plus the part's offset,
 * elevation lift plus the part's top. Tagged parts never carry a `turn`
 * or `tilt` (guarded by recipes.test.ts), so no rotation applies.
 */
export function accentAnchors(
  parts: readonly BuildingPart[],
  cx: number,
  cz: number,
  lift: number,
): AccentAnchor[] {
  const anchors: AccentAnchor[] = [];
  for (const p of parts) {
    if (p.role === undefined) continue;
    anchors.push({ role: p.role, x: cx + p.ox, y: lift + p.oy + p.sy, z: cz + p.oz });
  }
  return anchors;
}
```

- [ ] **Step 4: Wire the sink into `BuildingsMesh`**

In `src/render/buildingsMesh.ts`:

Add the import:

```ts
import { type AccentSink, type AccentState, accentAnchors } from './buildings/accents.ts';
```

Extend `TileBuilding`:

```ts
interface TileBuilding {
  zone: Zone;
  density: number;
  variant: number;
  supplied: SupplyStatus;
  heated: boolean;
  damaged: boolean;
  face: StreetFace;
  parts: BuildingPart[];
  /** Block per primitive kind (index = PartKind). */
  blocks: number[];
}
```

Extend the constructor signature (the body is unchanged):

```ts
  constructor(
    scene: THREE.Scene,
    gridSize: number,
    private readonly elevation: ElevationField,
    /** Optional receiver of effect anchors (stage 2 accents). */
    private readonly accents?: AccentSink,
  ) {
```

Replace the `hasBuilding` branch of `applyDiffs` with:

```ts
      const hasBuilding = diff.tileType === TileType.Empty && diff.density > 0;
      const existing = this.buildings.get(diff.index);
      // Diffs built in tests may omit these fields; normalise to booleans.
      const heated = diff.heated === true;
      const damaged = (diff.damage ?? 0) > 0;
      if (hasBuilding) {
        if (
          !existing ||
          existing.density !== diff.density ||
          existing.zone !== diff.zone ||
          existing.variant !== diff.variant
        ) {
          this.place(diff.index, diff.zone, diff.density, diff.variant, diff.supplied, heated, damaged, true);
          reissue.delete(diff.index);
          windowsDirty = true;
        } else {
          const supplyFlip = existing.supplied !== diff.supplied;
          if (supplyFlip) {
            // Supply flips tint the body and dim the windows; no grow animation.
            existing.supplied = diff.supplied;
            this.writeColors(diff.index);
            windowsDirty = true;
          }
          if (supplyFlip || existing.heated !== heated || existing.damaged !== damaged) {
            existing.heated = heated;
            existing.damaged = damaged;
            this.accents?.setState(diff.index, accentState(existing));
          }
        }
      } else if (existing) {
```

In the `reissue` loop pass the stored flags through:

```ts
this.place(index, b.zone, b.density, b.variant, b.supplied, b.heated, b.damaged, false);
```

Change `place`'s signature and body:

```ts
  /** Create or re-issue the building on `index`; `animate` starts the grow-in. */
  private place(
    index: number,
    zone: Zone,
    density: number,
    variant: number,
    supplied: SupplyStatus,
    heated: boolean,
    damaged: boolean,
    animate: boolean,
  ): void {
    const face = this.streetFace(index);
    const parts = buildingParts(zone, density, variant, index, face);
    let building = this.buildings.get(index);
    if (!building) {
      building = {
        zone,
        density,
        variant,
        supplied,
        heated,
        damaged,
        face,
        parts,
        blocks: this.layers.map((layer) => layer.blocks.alloc()),
      };
      this.buildings.set(index, building);
      this.syncCounts();
    } else {
      building.zone = zone;
      building.density = density;
      building.variant = variant;
      building.supplied = supplied;
      building.heated = heated;
      building.damaged = damaged;
      building.face = face;
      building.parts = parts;
    }
    this.hideUnusedSlots(building);
    if (animate && !this.reducedMotion) {
      this.animations.set(index, 0);
      this.writeMatrices(index, 0.01);
    } else {
      // A re-issue (e.g. a road laid beside a still-growing building, or a
      // road arriving in the same diff batch as the building) must not
      // snap an in-progress grow animation to full size: keep the existing
      // animation entry and resume at its current progress.
      const elapsed = this.animations.get(index);
      if (elapsed === undefined) {
        this.writeMatrices(index, 1);
      } else {
        this.writeMatrices(index, Math.max(0.01, this.growthAt(elapsed)));
      }
    }
    this.writeColors(index);
    this.publishAnchors(index, building);
  }
```

(The `if (animate …) … writeColors` block is the existing code, kept
verbatim; only the signature, the two new fields and the final
`publishAnchors` call are new.)

Add after `place`:

```ts
  /** Hand the role-tagged parts' world anchors to the effects sink. */
  private publishAnchors(index: number, building: TileBuilding): void {
    if (!this.accents) return;
    const cx = (index % this.gridSize) + 0.5;
    const cz = Math.floor(index / this.gridSize) + 0.5;
    const anchors = accentAnchors(building.parts, cx, cz, this.elevation.centerY(index));
    if (anchors.length > 0) this.accents.set(index, anchors, accentState(building));
    else this.accents.remove(index);
  }
```

In `remove`, after `this.animations.delete(index);` add
`this.accents?.remove(index);`.

Add a module-level helper near `HIDDEN`:

```ts
function accentState(b: TileBuilding): AccentState {
  return { heated: b.heated, supplied: b.supplied, damaged: b.damaged };
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm format && pnpm typecheck && pnpm vitest run src/render`
Expected: PASS — the new sink tests and every existing buildings-mesh
test (the three-argument constructor still works because `accents` is
optional).

- [ ] **Step 6: Commit**

```bash
git add src/render/buildings/accents.ts src/render/buildings/accents.test.ts src/render/buildingsMesh.ts src/render/buildingsMesh.test.ts
git commit -m "feat(render): publish chimney, vent and antenna anchors from the buildings mesh

A small AccentSink interface receives world-space anchors on place and
re-issue, a state-only update on supply/heat/damage flips, and a remove.
The buildings mesh stays about shapes; the effects layer comes next."
```

---

### Task 4: `BuildingFxMesh` — emitters and smoke/vent puffs

**Files:**

- Create: `src/render/buildingFxMesh.ts`
- Create: `src/render/buildingFxMesh.test.ts`

**Interfaces:**

- Consumes: `AccentSink`, `AccentAnchor`, `AccentState` (Task 3),
  `PartRole` (Task 2), `heatingDegree` (Task 1), `DiffLayer`,
  `RenderEnvironment` (`src/render/renderer.ts`).
- Produces: `class BuildingFxMesh implements DiffLayer, AccentSink` with
  `constructor(scene: THREE.Scene, gridSize: number)`, public readonly
  `puffs: THREE.InstancedMesh` and `beacons: THREE.InstancedMesh`, and
  `export const PUFFS_PER_EMITTER = 3`. Task 5 fills in the beacon
  branch; this task creates the beacon mesh but leaves it empty.

- [ ] **Step 1: Write the failing tests**

```ts
// src/render/buildingFxMesh.test.ts
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { SupplyStatus } from '../shared/types.ts';
import type { RenderEnvironment } from './renderer.ts';
import { PartRole } from './buildings/recipes.ts';
import type { AccentAnchor, AccentState } from './buildings/accents.ts';
import { BuildingFxMesh, PUFFS_PER_EMITTER } from './buildingFxMesh.ts';

const SIZE = 8;
const TILE = 3 * SIZE + 3;

function environment(temperature: number, nightFactor = 0): RenderEnvironment {
  return {
    nightFactor,
    sunFactor: 1 - nightFactor,
    windFactor: 0.3,
    stateOfCharge: 0.5,
    tideLevel: 0,
    demand: { residential: 0, commercial: 0, retail: 0 },
    phase: 0.75,
    temperature,
    snowCover: 0,
    sunrise: 0.3,
    sunset: 0.7,
    solarStrength: 0.5,
  };
}

function chimney(): AccentAnchor[] {
  return [{ role: PartRole.Chimney, x: 3.5, y: 0.5, z: 3.5 }];
}

function vents(): AccentAnchor[] {
  return [
    { role: PartRole.Vent, x: 3.3, y: 1.0, z: 3.5 },
    { role: PartRole.Vent, x: 3.7, y: 1.0, z: 3.5 },
  ];
}

function state(overrides: Partial<AccentState> = {}): AccentState {
  return { heated: false, supplied: SupplyStatus.Supplied, damaged: false, ...overrides };
}

function setup(): { scene: THREE.Scene; fx: BuildingFxMesh } {
  const scene = new THREE.Scene();
  const fx = new BuildingFxMesh(scene, SIZE);
  return { scene, fx };
}

describe('BuildingFxMesh puffs', () => {
  it('creates culling-free puff and beacon meshes sized for the whole grid', () => {
    const { scene, fx } = setup();
    expect(fx.puffs.frustumCulled).toBe(false);
    expect(fx.beacons.frustumCulled).toBe(false);
    expect(fx.puffs.instanceMatrix.count).toBe(SIZE * SIZE * PUFFS_PER_EMITTER);
    expect(fx.beacons.instanceMatrix.count).toBe(SIZE * SIZE);
    expect(scene.children).toContain(fx.puffs);
    expect(scene.children).toContain(fx.beacons);
    expect(fx.puffs.count).toBe(0);
  });

  it('smokes a cold, self-heated, powered, intact chimney with three puffs', () => {
    const { fx } = setup();
    fx.set(TILE, chimney(), state());
    fx.setEnvironment(environment(0));
    fx.update(0.016, 1);
    expect(fx.puffs.count).toBe(PUFFS_PER_EMITTER);
  });

  it.each([
    ['on district heat', state({ heated: true }), 0, 0],
    ['not connected', state({ supplied: SupplyStatus.NotConnected }), 0, 0],
    ['damaged', state({ damaged: true }), 0, 0],
    ['warm (comfort temperature)', state(), 16, 0],
    [
      'undersupplied (still smokes)',
      state({ supplied: SupplyStatus.Undersupplied }),
      0,
      PUFFS_PER_EMITTER,
    ],
  ])('%s', (_label, s, temperature, expected) => {
    const { fx } = setup();
    fx.set(TILE, chimney(), s);
    fx.setEnvironment(environment(temperature));
    fx.update(0.016, 1);
    expect(fx.puffs.count).toBe(expected);
  });

  it('smokes harder in a deep freeze than on a cool day', () => {
    const cold = setup();
    cold.fx.set(TILE, chimney(), state());
    cold.fx.setEnvironment(environment(-4));
    cold.fx.update(0.016, 1);
    const cool = setup();
    cool.fx.set(TILE, chimney(), state());
    cool.fx.setEnvironment(environment(10));
    cool.fx.update(0.016, 1);
    const a = new THREE.Color();
    const b = new THREE.Color();
    cold.fx.puffs.getColorAt(0, a);
    cool.fx.puffs.getColorAt(0, b);
    expect(a.r).toBeGreaterThan(b.r);
  });

  it('puffs from both vent stacks of a fully supplied hall, in any season', () => {
    const { fx } = setup();
    fx.set(TILE, vents(), state());
    fx.setEnvironment(environment(28));
    fx.update(0.016, 1);
    expect(fx.puffs.count).toBe(2 * PUFFS_PER_EMITTER);
    fx.setState(TILE, state({ supplied: SupplyStatus.Undersupplied }));
    fx.update(0.016, 2);
    expect(fx.puffs.count).toBe(0);
  });

  it('rises between frames with motion on', () => {
    const { fx } = setup();
    fx.set(TILE, chimney(), state());
    fx.setEnvironment(environment(0));
    fx.update(0.016, 0);
    const before = new THREE.Matrix4();
    fx.puffs.getMatrixAt(0, before);
    fx.update(0.016, 0.4);
    const after = new THREE.Matrix4();
    fx.puffs.getMatrixAt(0, after);
    expect(after.equals(before)).toBe(false);
    // Every puff stays above its anchor and inside its rise.
    const p = new THREE.Vector3();
    for (let i = 0; i < fx.puffs.count; i++) {
      fx.puffs.getMatrixAt(i, after);
      p.setFromMatrixPosition(after);
      expect(p.y).toBeGreaterThanOrEqual(0.5);
      expect(p.y).toBeLessThanOrEqual(0.5 + 0.35 + 1e-9);
    }
  });

  it('freezes with reduced motion and skips redundant rebuilds, but rebuilds on a real change', () => {
    const { fx } = setup();
    fx.setReducedMotion(true);
    fx.set(TILE, chimney(), state());
    fx.setEnvironment(environment(0));
    fx.update(0.016, 0);
    const before = new THREE.Matrix4();
    fx.puffs.getMatrixAt(0, before);
    const setMatrixAt = vi.spyOn(fx.puffs, 'setMatrixAt');
    fx.update(0.016, 5);
    expect(setMatrixAt).not.toHaveBeenCalled();
    const after = new THREE.Matrix4();
    fx.puffs.getMatrixAt(0, after);
    expect(after.equals(before)).toBe(true);
    // A heat-network connection is a real change.
    fx.setState(TILE, state({ heated: true }));
    fx.update(0.016, 5);
    expect(fx.puffs.count).toBe(0);
    // So is a temperature move beyond the epsilon, but not a tiny one.
    fx.setState(TILE, state());
    fx.update(0.016, 6);
    setMatrixAt.mockClear();
    fx.setEnvironment(environment(0.1));
    fx.update(0.016, 7);
    expect(setMatrixAt).not.toHaveBeenCalled();
    fx.setEnvironment(environment(-5));
    fx.update(0.016, 8);
    expect(setMatrixAt).toHaveBeenCalled();
  });

  it('frees puffs when a tile is removed', () => {
    const { fx } = setup();
    fx.set(TILE, chimney(), state());
    fx.set(TILE + 1, chimney(), state());
    fx.setEnvironment(environment(0));
    fx.update(0.016, 1);
    expect(fx.puffs.count).toBe(2 * PUFFS_PER_EMITTER);
    fx.remove(TILE);
    fx.update(0.016, 2);
    expect(fx.puffs.count).toBe(PUFFS_PER_EMITTER);
    fx.remove(TILE + 1);
    fx.update(0.016, 3);
    expect(fx.puffs.count).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/render/buildingFxMesh.test.ts`
Expected: FAIL — cannot resolve `./buildingFxMesh.ts`.

- [ ] **Step 3: Implement the layer (puffs; beacon branch left for Task 5)**

```ts
// src/render/buildingFxMesh.ts
import * as THREE from 'three';
import type { TileDiff } from '../shared/types.ts';
import { SupplyStatus } from '../shared/types.ts';
import { heatingDegree } from '../shared/heating.ts';
import type { DiffLayer, RenderEnvironment } from './renderer.ts';
import type { AccentAnchor, AccentSink, AccentState } from './buildings/accents.ts';
import { PartRole } from './buildings/recipes.ts';

/** Puffs per smoking chimney or vent stack. */
export const PUFFS_PER_EMITTER = 3;
/** Seconds for one puff to rise from the stack top to its fade-out. */
const PUFF_CYCLE_SECONDS = 2.4;
/** Rise in tiles over one cycle. */
const CHIMNEY_RISE = 0.35;
const VENT_RISE = 0.2;
/** Vent puffs are thinner than full-cold chimney smoke. */
const VENT_STRENGTH = 0.45;
/** Sideways drift over a cycle along +x (the camera turns in quarter steps, so no direction is privileged). */
const WIND_DRIFT = 0.08;
/** Puff diameter in tiles at birth and at fade-out. */
const PUFF_MIN = 0.03;
const PUFF_MAX = 0.12;
const PUFF_COLOR = new THREE.Color(0xb9bcc0);
const PUFF_OPACITY = 0.5;
/** Night dimming of the puffs, like the geothermal steam. */
const NIGHT_DIM = 0.45;
/** Beacon (Task 5): a tiny box on the antenna tip. */
const BEACON_SIZE = 0.04;
const BEACON_HEIGHT = 0.03;
const BEACON_COLOR = 0xff3b30;
/** Smaller environment moves are not worth a rebuild under reduced motion. */
const TEMPERATURE_EPSILON = 0.25;
const NIGHT_FACTOR_EPSILON = 0.002;

interface Emitter {
  anchors: readonly AccentAnchor[];
  state: AccentState;
  /** Stable 0..1 phase so neighbours never puff or blink in step. */
  phase: number;
}

/** Deterministic hash of a tile index to 0..1 (same scheme as weatherFx.ts). */
function hash01(index: number): number {
  let h = (index * 374761393 + 668265263) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return (h >>> 8) / 16777216;
}

function frac(x: number): number {
  return x - Math.floor(x);
}

function sameState(a: AccentState, b: AccentState): boolean {
  return a.heated === b.heated && a.supplied === b.supplied && a.damaged === b.damaged;
}

/**
 * Animated building accents: chimney smoke on self-heated houses in the
 * cold, vent puffs on a busy market hall, and a night beacon on office
 * antennas. Everything it knows arrives through the `AccentSink` from
 * `BuildingsMesh`; tile diffs are not read here.
 *
 * With motion on, the puffs and beacons rebuild every frame while any
 * emitter exists. With reduced motion, puffs freeze at phase 0 and beacons
 * stay lit, and the layer rebuilds only when something it depends on
 * changed (emitters, state, temperature, night), so an idle map does no
 * per-frame GPU uploads — the same rule as geothermalMesh.ts.
 */
export class BuildingFxMesh implements DiffLayer, AccentSink {
  readonly puffs: THREE.InstancedMesh;
  readonly beacons: THREE.InstancedMesh;
  private readonly beaconMaterial: THREE.MeshBasicMaterial;
  private readonly emitters = new Map<number, Emitter>();
  private nightFactor = 0;
  private temperature = 20;
  private reducedMotion = false;
  /** Something the frozen (reduced-motion) build depends on changed. */
  private dirty = false;
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private readonly color = new THREE.Color();

  constructor(scene: THREE.Scene, gridSize: number) {
    const tiles = gridSize * gridSize;
    this.puffs = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.5, 8, 6),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: PUFF_OPACITY,
        depthWrite: false,
      }),
      tiles * PUFFS_PER_EMITTER,
    );
    // Instance transforms span the whole grid; the base geometry's bounds
    // would wrongly cull the mesh, so culling is disabled.
    this.puffs.frustumCulled = false;
    this.puffs.count = 0;
    scene.add(this.puffs);

    this.beaconMaterial = new THREE.MeshBasicMaterial({
      color: BEACON_COLOR,
      transparent: true,
      opacity: 0,
    });
    this.beacons = new THREE.InstancedMesh(
      new THREE.BoxGeometry(BEACON_SIZE, BEACON_HEIGHT, BEACON_SIZE),
      this.beaconMaterial,
      tiles,
    );
    this.beacons.frustumCulled = false;
    this.beacons.count = 0;
    this.beacons.visible = false;
    scene.add(this.beacons);
  }

  /** Nothing to read from tile diffs: anchors and state arrive through the sink. */
  applyDiffs(_diffs: TileDiff[]): void {}

  set(index: number, anchors: readonly AccentAnchor[], state: AccentState): void {
    this.emitters.set(index, { anchors, state, phase: hash01(index) });
    this.dirty = true;
  }

  setState(index: number, state: AccentState): void {
    const emitter = this.emitters.get(index);
    if (!emitter || sameState(emitter.state, state)) return;
    emitter.state = state;
    this.dirty = true;
  }

  remove(index: number): void {
    if (this.emitters.delete(index)) this.dirty = true;
  }

  setEnvironment(environment: RenderEnvironment): void {
    if (Math.abs(environment.temperature - this.temperature) > TEMPERATURE_EPSILON) {
      this.temperature = environment.temperature;
      this.dirty = true;
    }
    if (Math.abs(environment.nightFactor - this.nightFactor) > NIGHT_FACTOR_EPSILON) {
      this.nightFactor = environment.nightFactor;
      this.dirty = true;
    }
    // Beacons fade in with the night exactly like the window lights.
    const opacity = Math.max(0, environment.nightFactor - 0.25) / 0.75;
    this.beaconMaterial.opacity = opacity;
    this.beacons.visible = opacity > 0.02;
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
    this.dirty = true;
  }

  update(_deltaSeconds: number, nowSeconds: number): void {
    if (this.emitters.size === 0) {
      if (this.puffs.count !== 0 || this.beacons.count !== 0) {
        this.puffs.count = 0;
        this.beacons.count = 0;
        this.puffs.instanceMatrix.needsUpdate = true;
        this.beacons.instanceMatrix.needsUpdate = true;
      }
      this.dirty = false;
      return;
    }
    if (this.reducedMotion && !this.dirty) return;
    this.rebuild(this.reducedMotion ? 0 : nowSeconds);
    this.dirty = false;
  }

  private rebuild(time: number): void {
    const degree = heatingDegree(this.temperature);
    const nightDim = 1 - NIGHT_DIM * this.nightFactor;
    let puffCount = 0;
    let beaconCount = 0;
    for (const emitter of this.emitters.values()) {
      const { state, phase } = emitter;
      const powered = state.supplied !== SupplyStatus.NotConnected && !state.damaged;
      for (const anchor of emitter.anchors) {
        switch (anchor.role) {
          case PartRole.Chimney:
            if (powered && !state.heated && degree > 0) {
              puffCount = this.writePuffs(
                puffCount,
                anchor,
                phase,
                time,
                degree,
                CHIMNEY_RISE,
                nightDim,
              );
            }
            break;
          case PartRole.Vent:
            if (state.supplied === SupplyStatus.Supplied && !state.damaged) {
              puffCount = this.writePuffs(
                puffCount,
                anchor,
                phase,
                time,
                VENT_STRENGTH,
                VENT_RISE,
                nightDim,
              );
            }
            break;
          case PartRole.Antenna:
            // Task 5 fills this in.
            break;
        }
      }
    }
    this.puffs.count = puffCount;
    this.puffs.instanceMatrix.needsUpdate = true;
    if (this.puffs.instanceColor) this.puffs.instanceColor.needsUpdate = true;
    this.beacons.count = beaconCount;
    this.beacons.instanceMatrix.needsUpdate = true;
  }

  /** Three puffs on a repeating rise cycle above `anchor`; returns the next free slot. */
  private writePuffs(
    slot: number,
    anchor: AccentAnchor,
    phase: number,
    time: number,
    strength: number,
    rise: number,
    nightDim: number,
  ): number {
    for (let k = 0; k < PUFFS_PER_EMITTER; k++) {
      const u = frac(time / PUFF_CYCLE_SECONDS + k / PUFFS_PER_EMITTER + phase);
      const size = PUFF_MIN + (PUFF_MAX - PUFF_MIN) * u;
      this.position.set(anchor.x + WIND_DRIFT * u, anchor.y + rise * u, anchor.z);
      this.scale.set(size, size, size);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.puffs.setMatrixAt(slot, this.matrix);
      this.puffs.setColorAt(
        slot,
        this.color.copy(PUFF_COLOR).multiplyScalar(strength * (1 - u) * nightDim),
      );
      slot++;
    }
    return slot;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm vitest run src/render/buildingFxMesh.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render/buildingFxMesh.ts src/render/buildingFxMesh.test.ts
git commit -m "feat(render): chimney smoke and vent puffs in a new building effects layer

Fed by the buildings mesh through the accent sink. A house smokes while
it heats itself (not on district heat) in the cold, strength on the
sim's heating-degree curve; the market hall's vent stacks puff while
fully supplied. Reduced motion freezes the puffs and rebuilds only on
change."
```

---

### Task 5: Antenna beacons

**Files:**

- Modify: `src/render/buildingFxMesh.ts` (the `PartRole.Antenna` case,
  blink constants)
- Test: `src/render/buildingFxMesh.test.ts`

**Interfaces:**

- Consumes: everything from Task 4.
- Produces: beacon instances on `BuildingFxMesh.beacons`, one per
  antenna anchor whose building is powered and intact.

- [ ] **Step 1: Write the failing tests**

Append to `src/render/buildingFxMesh.test.ts`:

```ts
function antenna(): AccentAnchor[] {
  return [{ role: PartRole.Antenna, x: 3.5, y: 1.4, z: 3.5 }];
}

/** True when the instance at `slot` is drawn (non-zero scale). */
function lit(mesh: THREE.InstancedMesh, slot: number): boolean {
  const m = new THREE.Matrix4();
  const s = new THREE.Vector3();
  mesh.getMatrixAt(slot, m);
  s.setFromMatrixScale(m);
  return s.x > 0;
}

describe('BuildingFxMesh beacons', () => {
  it('draws one beacon per powered antenna, hidden by day and shown at night', () => {
    const { fx } = setup();
    fx.set(TILE, antenna(), state());
    fx.setEnvironment(environment(20, 0));
    fx.update(0.016, 1);
    expect(fx.beacons.count).toBe(1);
    expect(fx.beacons.visible).toBe(false);
    fx.setEnvironment(environment(20, 1));
    fx.update(0.016, 2);
    expect(fx.beacons.visible).toBe(true);
    expect((fx.beacons.material as THREE.MeshBasicMaterial).opacity).toBeCloseTo(1, 6);
    fx.setState(TILE, state({ supplied: SupplyStatus.NotConnected }));
    fx.update(0.016, 3);
    expect(fx.beacons.count).toBe(0);
  });

  it('sits just above the antenna tip', () => {
    const { fx } = setup();
    fx.setReducedMotion(true);
    fx.set(TILE, antenna(), state());
    fx.setEnvironment(environment(20, 1));
    fx.update(0.016, 1);
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    fx.beacons.getMatrixAt(0, m);
    p.setFromMatrixPosition(m);
    expect(p.x).toBeCloseTo(3.5, 9);
    expect(p.z).toBeCloseTo(3.5, 9);
    expect(p.y).toBeGreaterThan(1.4);
    expect(p.y).toBeLessThan(1.5);
  });

  it('blinks with motion on and stays lit with reduced motion', () => {
    const { fx } = setup();
    fx.set(TILE, antenna(), state());
    fx.setEnvironment(environment(20, 1));
    let litFrames = 0;
    let darkFrames = 0;
    for (let t = 0; t < 2; t += 0.05) {
      fx.update(0.05, t);
      if (lit(fx.beacons, 0)) litFrames++;
      else darkFrames++;
    }
    expect(litFrames).toBeGreaterThan(0);
    expect(darkFrames).toBeGreaterThan(litFrames); // short flash, long dark
    fx.setReducedMotion(true);
    for (let t = 0; t < 2; t += 0.05) {
      fx.update(0.05, t);
      expect(lit(fx.beacons, 0)).toBe(true);
    }
  });

  it('gives neighbouring towers different blink phases', () => {
    const { fx } = setup();
    fx.set(TILE, antenna(), state());
    fx.set(TILE + 1, antenna(), state());
    fx.setEnvironment(environment(20, 1));
    let differ = false;
    for (let t = 0; t < 2 && !differ; t += 0.05) {
      fx.update(0.05, t);
      differ = lit(fx.beacons, 0) !== lit(fx.beacons, 1);
    }
    expect(differ).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/render/buildingFxMesh.test.ts`
Expected: FAIL — `beacons.count` is 0 (the antenna branch is empty).

- [ ] **Step 3: Implement the beacon branch**

In `src/render/buildingFxMesh.ts` add the blink constants next to the
beacon ones:

```ts
/** Lift above the antenna tip so the box does not z-fight the cylinder cap. */
const BEACON_LIFT = 0.015;
const BLINK_PERIOD_SECONDS = 2;
/** Fraction of the period the beacon is lit: a short flash. */
const BLINK_DUTY = 0.12;
/** Hidden instances: a zero-scale matrix is never rasterised. */
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
```

Replace the `PartRole.Antenna` case in `rebuild`:

```ts
          case PartRole.Antenna:
            if (powered) {
              const on = this.reducedMotion || frac(time / BLINK_PERIOD_SECONDS + phase) < BLINK_DUTY;
              if (on) {
                this.matrix.makeTranslation(anchor.x, anchor.y + BEACON_LIFT, anchor.z);
                this.beacons.setMatrixAt(beaconCount, this.matrix);
              } else {
                this.beacons.setMatrixAt(beaconCount, HIDDEN);
              }
              beaconCount++;
            }
            break;
```

If two neighbouring tiles' hashed phases happen to fall inside the same
0.05 s sample window, the "different blink phases" test can use
`TILE + 2` instead of `TILE + 1`; the hash is deterministic, so pick once.

- [ ] **Step 4: Run the tests**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm vitest run src/render/buildingFxMesh.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render/buildingFxMesh.ts src/render/buildingFxMesh.test.ts
git commit -m "feat(render): red night beacon on office and tower antennas

One instance per powered antenna, fading in with the night like the
windows, a short flash every two seconds on a per-tile phase; steady
under reduced motion."
```

---

### Task 6: Wire the layer into the renderer, docs and smoke check

**Files:**

- Modify: `src/render/renderer.ts:13` (import), `:199` (layer wiring)
- Modify: `docs/plan.md:77-78` (module map)
- Test: `node scripts/smoke.mjs`, full suite

**Interfaces:**

- Consumes: `BuildingFxMesh` (Tasks 4–5), the four-argument
  `BuildingsMesh` constructor (Task 3).

- [ ] **Step 1: Wire the renderer**

In `src/render/renderer.ts` add the import next to the `BuildingsMesh`
import:

```ts
import { BuildingFxMesh } from './buildingFxMesh.ts';
```

Replace the `BuildingsMesh` wiring line with:

```ts
const buildingFx = new BuildingFxMesh(scene, gridSize);
this.addDiffLayer(new BuildingsMesh(scene, gridSize, this.elevation, buildingFx));
this.addDiffLayer(buildingFx);
```

`addDiffLayer` registration is what delivers `setEnvironment`,
`setReducedMotion` and `update` to the effects layer; its `applyDiffs`
is a no-op.

- [ ] **Step 2: Update the module map**

In `docs/plan.md` change the two building lines to:

```
    buildingsMesh.ts # one InstancedMesh per primitive kind, slot blocks per tile, windows, accent anchors
    buildingFxMesh.ts # chimney smoke, vent puffs, antenna beacons fed by the buildings mesh anchors
    buildings/       # recipes (zone/density/variant/tile → parts), palette, primitives, blocks, accents
```

- [ ] **Step 3: Run everything**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm coverage && node scripts/smoke.mjs`
Expected: all PASS; coverage thresholds hold (the new shared module is
fully covered by `heating.test.ts`); the smoke script prints its usual
success line.

- [ ] **Step 4: Commit**

```bash
git add src/render/renderer.ts docs/plan.md
git commit -m "feat(render): switch on the building effects layer

The renderer feeds the buildings mesh's accent anchors into
BuildingFxMesh and registers it as a diff layer so environment, reduced
motion and frame updates reach it."
```

- [ ] **Step 5: Hand back for the Mac visual pass**

Report to the user what to look at (from the spec's testing section):
smoke over a cold village before and after a heat plant is connected,
vent puffs on a market hall, beacons on a commercial district at night,
frame time on a full 64×64 map in winter. Tuning knobs are the module
constants at the top of `src/render/buildingFxMesh.ts`.
