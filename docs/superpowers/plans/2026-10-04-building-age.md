# Building Visuals Stage 3 (Age) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Buildings read as new, lived-in (after one season) and
weathered (after one year) through a colour-only tint driven by the
sim's existing per-tile building age.

**Architecture:** The sim quantises `layers.buildingAge` into a
three-valued `ageStage` when it builds a tile diff (a pure function in
`src/sim/state.ts` next to `deliveryStateOfAge`), and the growth step
marks a tile dirty on the exact tick its age crosses a stage threshold
(thresholds in `BALANCE.growth.ageStageTicks`). `TileDiff` gains the
field. The palette gains `applyAgeTint` (desaturate + darken, plus a
patina on pitched roofs when weathered); `BuildingsMesh` stores the
stage per tile, applies the age tint before the supply tint on
non-accent parts, and treats a stage change as a colour-only rewrite.
No save change, no UI, no agent-tool change.

**Tech Stack:** TypeScript (strict), three.js, Vitest, pnpm, oxlint,
oxfmt.

**Spec:** `docs/superpowers/specs/2026-10-04-building-age-design.md`

**Spec deviation decided in planning:** the spec places `ageStageOf` in
`src/sim/growth.ts`; it goes in `src/sim/state.ts` instead, beside its
siblings `deliveryStateOfAge`/`stopStateOfAge`, because `collectDiffs`
lives in `state.ts` and `growth.ts` already imports from `state.ts` (the
other direction would create an import cycle). Task 5 corrects the spec
text.

## Global Constraints

- `ageStage` values: 0 = new, 1 = lived-in, 2 = weathered. Thresholds
  `BALANCE.growth.ageStageTicks = [DAYS_PER_SEASON × TICKS_PER_DAY, SEASON_ORDER.length × DAYS_PER_SEASON × TICKS_PER_DAY]`
  (one season, one year); `BALANCE.seasons.daysPerSeason` must read the
  same hoisted `DAYS_PER_SEASON = 5`. No other balance value changes.
- No save-format change (`SAVE_VERSION` stays 1, `SaveGame` untouched);
  no worker message type change beyond the one `TileDiff` field; no
  agent-tool, i18n or UI change.
- Age has no gameplay effect: nothing but `collectDiffs` reads
  `ageStageOf`, and the only sim behaviour change is the extra
  `markDirty` on threshold ticks.
- `src/render/` never imports from `src/sim/`; sim code has no magic
  numbers (thresholds live in `BALANCE`); render tint strengths are
  module constants in `palette.ts`.
- Accent parts (`p.accent === true`) keep their colour at every stage;
  the age tint applies before the supply tint on all other parts.
- Pitched roofs are `PartKind.GableRoof` and `PartKind.HipRoof`; only
  those get the weathered patina.
- Run `pnpm format` after every edit; the pre-commit hook runs
  `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`.
  Never `--no-verify`. Lint fails on unused imports/bindings.
- Coverage gate ≥ 90 % on `src/sim` and `src/shared` must hold.

---

### Task 1: Age stage in the sim and the tile diff

**Files:**

- Modify: `src/shared/constants.ts` (top-level constants after
  `TICKS_PER_HISTORY_SAMPLE`; `growth` block after `abandonChancePerTick`;
  `seasons.daysPerSeason`)
- Modify: `src/shared/types.ts` (`TileDiff`, after `damage`)
- Modify: `src/sim/state.ts` (new function after `stopStateOfAge`;
  `collectDiffs`)
- Test: `src/sim/state.test.ts`

**Interfaces:**

- Produces: `BALANCE.growth.ageStageTicks: [number, number]`;
  `export function ageStageOf(buildingAge: number): number` in
  `src/sim/state.ts`; `TileDiff.ageStage: number`.

- [ ] **Step 1: Write the failing tests**

Append to `src/sim/state.test.ts` (add `ageStageOf` to the `./state.ts`
import list; `BALANCE`, `TICKS_PER_DAY`, `Zone`, `createSimState`,
`markDirty`, `collectDiffs` are already imported):

```ts
describe('ageStageOf (building visuals stage 3)', () => {
  it('buckets a building age into new, lived-in and weathered at the thresholds', () => {
    const [livedIn, weathered] = BALANCE.growth.ageStageTicks;
    expect(ageStageOf(0)).toBe(0);
    expect(ageStageOf(livedIn - 1)).toBe(0);
    expect(ageStageOf(livedIn)).toBe(1);
    expect(ageStageOf(weathered - 1)).toBe(1);
    expect(ageStageOf(weathered)).toBe(2);
    expect(ageStageOf(weathered * 10)).toBe(2);
  });

  it('turns lived-in after one season and weathered after one year', () => {
    const [livedIn, weathered] = BALANCE.growth.ageStageTicks;
    expect(livedIn).toBe(BALANCE.seasons.daysPerSeason * TICKS_PER_DAY);
    expect(weathered).toBe(4 * BALANCE.seasons.daysPerSeason * TICKS_PER_DAY);
  });

  it('carries the age stage in diffs and reports 0 for an empty tile', () => {
    const state = createSimState(1, 8);
    const [livedIn, weathered] = BALANCE.growth.ageStageTicks;
    state.layers.zone[10] = Zone.Residential;
    state.layers.density[10] = 1;
    state.layers.buildingAge[10] = livedIn;
    state.layers.zone[11] = Zone.Commercial;
    state.layers.density[11] = 2;
    state.layers.buildingAge[11] = weathered + 5;
    markDirty(state, 10);
    markDirty(state, 11);
    markDirty(state, 12);
    const diffs = collectDiffs(state);
    expect(diffs.find((d) => d.index === 10)?.ageStage).toBe(1);
    expect(diffs.find((d) => d.index === 11)?.ageStage).toBe(2);
    expect(diffs.find((d) => d.index === 12)?.ageStage).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/sim/state.test.ts`
Expected: FAIL — `ageStageOf` is not exported; `ageStageTicks` undefined.

- [ ] **Step 3: Add the constants**

In `src/shared/constants.ts`, change the first import line to also bring
in the season list:

```ts
import { PlantType, SEASON_ORDER, Zone } from './types.ts';
```

After the `TICKS_PER_HISTORY_SAMPLE` line add:

```ts
/** In-game days per season; a year is SEASON_ORDER.length seasons. */
export const DAYS_PER_SEASON = 5;
```

In `BALANCE.seasons` replace `daysPerSeason: 5,` with
`daysPerSeason: DAYS_PER_SEASON,` (keep its doc comment).

In `BALANCE.growth`, after `abandonChancePerTick: 0.01,` add:

```ts
    /**
     * Visual age stages (render only, no gameplay effect): ticks of
     * buildingAge at which a building turns lived-in, then weathered.
     * One season, then one year.
     */
    ageStageTicks: [
      DAYS_PER_SEASON * TICKS_PER_DAY,
      SEASON_ORDER.length * DAYS_PER_SEASON * TICKS_PER_DAY,
    ] as [number, number],
```

- [ ] **Step 4: Add the diff field and the stage function**

In `src/shared/types.ts`, inside `TileDiff` directly after the `damage`
field:

```ts
/** Visual age stage of a building: 0 = new, 1 = lived-in, 2 = weathered (render only). */
ageStage: number;
```

In `src/sim/state.ts`, after `stopStateOfAge`:

```ts
/**
 * Visual age bucket of a building given its ticks since the last rebuild
 * (placement, densify or decay): 0 = new, 1 = lived-in, 2 = weathered.
 * Render only; nothing in the sim reads it.
 */
export function ageStageOf(buildingAge: number): number {
  const [livedIn, weathered] = BALANCE.growth.ageStageTicks;
  if (buildingAge >= weathered) return 2;
  if (buildingAge >= livedIn) return 1;
  return 0;
}
```

In `collectDiffs`, after the `damage: layers.damage[index],` line add:

```ts
      ageStage: ageStageOf(layers.buildingAge[index]),
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `pnpm format && pnpm typecheck && pnpm vitest run src/sim/state.test.ts src/sim/seasons.test.ts src/sim/goals.test.ts`
Expected: PASS. `tsc` must be clean: the only production code that
builds a full `TileDiff` literal is `collectDiffs` (tests use
`as TileDiff` casts and are unaffected).

- [ ] **Step 6: Commit**

```bash
git add src/shared/constants.ts src/shared/types.ts src/sim/state.ts src/sim/state.test.ts
git commit -m "feat(sim): carry a visual age stage in tile diffs

ageStageOf buckets the existing buildingAge counter into new / lived-in
/ weathered at one season and one year (BALANCE.growth.ageStageTicks)
when a diff is built. No gameplay effect, no save change."
```

---

### Task 2: Mark buildings dirty when they cross an age threshold

**Files:**

- Modify: `src/sim/growth.ts` (the `buildingAge` increment loop at the
  top of `growthStep`)
- Test: `src/sim/growth.test.ts`

**Interfaces:**

- Consumes: `BALANCE.growth.ageStageTicks`, `ageStageOf` (Task 1),
  `markDirty` (already imported in `growth.ts`).

- [ ] **Step 1: Write the failing tests**

Append to `src/sim/growth.test.ts` (add `ageStageOf` and `collectDiffs`
to the `./state.ts` import list):

```ts
describe('age stages (building visuals stage 3)', () => {
  it('marks a building dirty on exactly the ticks its age reaches a threshold', () => {
    // No roads: nothing can spawn or densify, so the only dirty marks
    // come from the age loop.
    const state = createSimState(7, SIZE);
    const index = at(3, 3);
    state.layers.zone[index] = Zone.Residential;
    state.layers.density[index] = 1;
    for (const threshold of BALANCE.growth.ageStageTicks) {
      state.layers.buildingAge[index] = threshold - 2;
      state.dirty.clear();
      growthStep(state, computeDemand(state)); // -> threshold - 1
      expect(state.dirty.has(index)).toBe(false);
      growthStep(state, computeDemand(state)); // -> threshold
      expect(state.dirty.has(index)).toBe(true);
      state.dirty.clear();
      growthStep(state, computeDemand(state)); // -> threshold + 1
      expect(state.dirty.has(index)).toBe(false);
    }
  });

  it('does not age or dirty an empty tile', () => {
    const state = createSimState(7, SIZE);
    const index = at(3, 3);
    state.layers.buildingAge[index] = BALANCE.growth.ageStageTicks[0] - 1;
    state.dirty.clear();
    growthStep(state, computeDemand(state));
    expect(state.layers.buildingAge[index]).toBe(BALANCE.growth.ageStageTicks[0] - 1);
    expect(state.dirty.has(index)).toBe(false);
  });

  it('a densified building starts over as new', () => {
    const state = cityWithRoad();
    const index = at(4, 4);
    paintZones(state, [index], Zone.Residential);
    state.layers.density[index] = 1;
    state.layers.supplied[index] = SupplyStatus.Supplied;
    // Old enough to be weathered and to densify.
    state.layers.buildingAge[index] = BALANCE.growth.ageStageTicks[1] + 10;
    expect(ageStageOf(state.layers.buildingAge[index])).toBe(2);
    for (
      let t = 0;
      t < BALANCE.growth.densifyMinAge * 30 && state.layers.density[index] === 1;
      t++
    ) {
      growthStep(state, computeDemand(state));
    }
    expect(state.layers.density[index]).toBe(2);
    expect(state.layers.buildingAge[index]).toBe(0);
    const diff = collectDiffs(state).find((d) => d.index === index);
    expect(diff?.ageStage).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/sim/growth.test.ts`
Expected: the first test FAILS (`dirty.has(index)` is false at the
threshold tick); the other two pass already (they pin existing
behaviour).

- [ ] **Step 3: Add the threshold check**

In `src/sim/growth.ts` replace

```ts
layers.buildingAge.forEach((_, i) => {
  if (layers.density[i] > 0) layers.buildingAge[i]++;
});
```

with

```ts
const [livedInAge, weatheredAge] = BALANCE.growth.ageStageTicks;
layers.buildingAge.forEach((_, i) => {
  if (layers.density[i] === 0) return;
  const age = ++layers.buildingAge[i];
  // The renderer only hears about dirty tiles: tell it the moment a
  // building turns lived-in or weathered (ageStageOf in state.ts).
  if (age === livedInAge || age === weatheredAge) markDirty(state, i);
});
```

- [ ] **Step 4: Run the tests**

Run: `pnpm format && pnpm typecheck && pnpm vitest run src/sim/growth.test.ts src/sim/integration.test.ts`
Expected: PASS (the integration test confirms the extra dirty marks do
not disturb growth or determinism).

- [ ] **Step 5: Commit**

```bash
git add src/sim/growth.ts src/sim/growth.test.ts
git commit -m "feat(sim): flag buildings for a redraw when they turn lived-in or weathered

One integer comparison per building per tick in the existing age loop;
nothing else in growth changes."
```

---

### Task 3: Age tint in the palette

**Files:**

- Modify: `src/render/buildings/palette.ts` (after `applySupplyTint`)
- Test: `src/render/buildings/palette.test.ts`

**Interfaces:**

- Produces (in `palette.ts`):

```ts
export const AgeStage = { New: 0, LivedIn: 1, Weathered: 2 } as const;
export type AgeStage = (typeof AgeStage)[keyof typeof AgeStage];
export function applyAgeTint(
  color: THREE.Color,
  stage: number,
  roof: boolean,
  out: THREE.Color,
): THREE.Color;
```

- [ ] **Step 1: Write the failing tests**

Append to `src/render/buildings/palette.test.ts` (add `AgeStage` and
`applyAgeTint` to the `./palette.ts` import):

```ts
describe('age tint (building visuals stage 3)', () => {
  const hsl = (c: THREE.Color) => {
    const out = { h: 0, s: 0, l: 0 };
    c.getHSL(out);
    return out;
  };
  const wall = new THREE.Color(0xe3cfa6);
  const roof = new THREE.Color(0xb85c45);

  it('leaves a new building untouched', () => {
    expect(applyAgeTint(wall, AgeStage.New, false, new THREE.Color()).getHex()).toBe(0xe3cfa6);
    expect(applyAgeTint(roof, AgeStage.New, true, new THREE.Color()).getHex()).toBe(0xb85c45);
  });

  it('loses saturation and lightness with every stage, keeping the hue', () => {
    const livedIn = applyAgeTint(wall, AgeStage.LivedIn, false, new THREE.Color());
    const weathered = applyAgeTint(wall, AgeStage.Weathered, false, new THREE.Color());
    expect(hsl(livedIn).s).toBeLessThan(hsl(wall).s);
    expect(hsl(weathered).s).toBeLessThan(hsl(livedIn).s);
    expect(hsl(livedIn).l).toBeLessThan(hsl(wall).l);
    expect(hsl(weathered).l).toBeLessThan(hsl(livedIn).l);
    expect(hsl(livedIn).h).toBeCloseTo(hsl(wall).h, 2);
  });

  it('gives weathered pitched roofs a patina that walls and lived-in roofs do not get', () => {
    const weatheredRoof = applyAgeTint(roof, AgeStage.Weathered, true, new THREE.Color());
    const weatheredAsWall = applyAgeTint(roof, AgeStage.Weathered, false, new THREE.Color());
    const livedInRoof = applyAgeTint(roof, AgeStage.LivedIn, true, new THREE.Color());
    const livedInAsWall = applyAgeTint(roof, AgeStage.LivedIn, false, new THREE.Color());
    expect(weatheredRoof.getHex()).not.toBe(weatheredAsWall.getHex());
    expect(livedInRoof.getHex()).toBe(livedInAsWall.getHex());
  });

  it('treats a stage beyond weathered as weathered', () => {
    const a = applyAgeTint(wall, AgeStage.Weathered, false, new THREE.Color());
    const b = applyAgeTint(wall, 7, false, new THREE.Color());
    expect(b.getHex()).toBe(a.getHex());
  });

  it('keeps every channel in range for every family hue at every stage', () => {
    for (const family of Object.values(ZONE_FAMILIES)) {
      for (const list of [family.walls, family.roofs, family.trims]) {
        for (const c of list) {
          for (const stage of [AgeStage.New, AgeStage.LivedIn, AgeStage.Weathered]) {
            for (const isRoof of [false, true]) {
              const out = applyAgeTint(c, stage, isRoof, new THREE.Color());
              for (const channel of [out.r, out.g, out.b]) {
                expect(channel).toBeGreaterThanOrEqual(0);
                expect(channel).toBeLessThanOrEqual(1);
              }
            }
          }
        }
      }
    }
  });

  it('does not mutate its input', () => {
    applyAgeTint(wall, AgeStage.Weathered, true, new THREE.Color());
    expect(wall.getHex()).toBe(0xe3cfa6);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/render/buildings/palette.test.ts`
Expected: FAIL — `AgeStage`/`applyAgeTint` not exported.

- [ ] **Step 3: Implement the tint**

Append to `src/render/buildings/palette.ts`:

```ts
/** Visual age of a building (TileDiff.ageStage). */
export const AgeStage = { New: 0, LivedIn: 1, Weathered: 2 } as const;
export type AgeStage = (typeof AgeStage)[keyof typeof AgeStage];

/** How far toward its own grey a lived-in / weathered surface fades. */
const LIVED_IN_DESATURATE = 0.12;
const WEATHERED_DESATURATE = 0.3;
/** Lightness multipliers per stage. */
const LIVED_IN_DARKEN = 0.96;
const WEATHERED_DARKEN = 0.9;
/** Muted slate-green that weathered pitched roofs lean toward. */
const ROOF_PATINA = new THREE.Color(0x6f7a74);
const WEATHERED_PATINA_BLEND = 0.3;

const grey = new THREE.Color();

/** Blend `out` toward its own luminance grey by `amount` (hue is kept). */
function desaturate(out: THREE.Color, amount: number): void {
  const luminance = 0.299 * out.r + 0.587 * out.g + 0.114 * out.b;
  out.lerp(grey.setRGB(luminance, luminance, luminance), amount);
}

/**
 * Colour-only ageing. New copies the colour; lived-in dulls and darkens
 * a little; weathered more so, and a pitched roof additionally takes on
 * a patina. Accents never go through this. Writes into `out`.
 */
export function applyAgeTint(
  color: THREE.Color,
  stage: number,
  roof: boolean,
  out: THREE.Color,
): THREE.Color {
  out.copy(color);
  if (stage <= AgeStage.New) return out;
  if (stage === AgeStage.LivedIn) {
    desaturate(out, LIVED_IN_DESATURATE);
    return out.multiplyScalar(LIVED_IN_DARKEN);
  }
  desaturate(out, WEATHERED_DESATURATE);
  out.multiplyScalar(WEATHERED_DARKEN);
  if (roof) out.lerp(ROOF_PATINA, WEATHERED_PATINA_BLEND);
  return out;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm format && pnpm typecheck && pnpm vitest run src/render/buildings/palette.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render/buildings/palette.ts src/render/buildings/palette.test.ts
git commit -m "feat(render): age tint for walls and pitched roofs

Lived-in dulls and darkens a little, weathered more so with a slate
patina on gable and hip roofs. Pure colour function; accents excluded."
```

---

### Task 4: Buildings mesh applies the age stage

**Files:**

- Modify: `src/render/buildingsMesh.ts` (`TileBuilding`, `applyDiffs`,
  the `reissue` loop, `place`, `writeColors`, imports, scratch colour)
- Test: `src/render/buildingsMesh.test.ts`

**Interfaces:**

- Consumes: `TileDiff.ageStage` (Task 1), `applyAgeTint` (Task 3),
  `PartKind.GableRoof`/`PartKind.HipRoof`.
- Produces: `BuildingsMesh` recolours on an age-stage change with no
  matrix, window or accent-sink work.

- [ ] **Step 1: Write the failing tests**

Append to `src/render/buildingsMesh.test.ts` (the helpers `setup`,
`setupWithSink`, `building`, `drawn`, `CENTRE` and the `ACCENT` import
already exist; add `applyAgeTint` to the `./buildings/palette.ts`
import):

```ts
describe('BuildingsMesh age stages', () => {
  /** A building diff at the given age stage. */
  function aged(index: number, zone: Zone, density: number, ageStage: number): TileDiff {
    return { ...building(index, zone, density, 0), ageStage } as TileDiff;
  }

  function bodyColor(mesh: BuildingsMesh): THREE.Color {
    const main = mesh.partsAt(CENTRE)!.find((p) => p.main)!;
    const parts = mesh.partsAt(CENTRE)!;
    // Slot of the main body within the Box block: boxes are written in
    // recipe order, and the first building owns block 0.
    const slot = parts.filter((p) => p.kind === PartKind.Box).indexOf(main);
    const c = new THREE.Color();
    mesh.kindMeshes[PartKind.Box].getColorAt(slot, c);
    return c;
  }

  it('recolours the body on an age flip without touching matrices, windows or the sink', () => {
    const { mesh, sink } = setupWithSink();
    mesh.applyDiffs([aged(CENTRE, Zone.Residential, 1, 0)]);
    const boxMesh = mesh.kindMeshes[PartKind.Box];
    const matricesBefore = drawn(boxMesh).map((m) => m.toArray());
    const windowsBefore = mesh.windowCount();
    const colorBefore = bodyColor(mesh);
    sink.calls = [];
    mesh.applyDiffs([aged(CENTRE, Zone.Residential, 1, 2)]);
    expect(drawn(boxMesh).map((m) => m.toArray())).toEqual(matricesBefore);
    expect(mesh.windowCount()).toBe(windowsBefore);
    expect(sink.calls).toEqual([]);
    expect(bodyColor(mesh).getHex()).not.toBe(colorBefore.getHex());
  });

  it('applies the palette age tint before the supply tint, leaving accents alone', () => {
    const { mesh } = setup();
    mesh.setReducedMotion(true);
    mesh.applyDiffs([
      { ...aged(CENTRE, Zone.Residential, 1, 2), supplied: SupplyStatus.Undersupplied } as TileDiff,
    ]);
    const parts = mesh.partsAt(CENTRE)!;
    const main = parts.find((p) => p.main)!;
    const expected = applySupplyTint(
      applyAgeTint(main.color, 2, false, new THREE.Color()),
      SupplyStatus.Undersupplied,
      new THREE.Color(),
    );
    expect(bodyColor(mesh).getHex()).toBe(expected.getHex());
    // The chimney is an accent: same colour at every stage.
    const boxes = parts.filter((p) => p.kind === PartKind.Box);
    const chimneySlot = boxes.findIndex((p) => p.color.getHex() === ACCENT.chimney.getHex());
    expect(chimneySlot).toBeGreaterThanOrEqual(0);
    const chimney = new THREE.Color();
    mesh.kindMeshes[PartKind.Box].getColorAt(chimneySlot, chimney);
    expect(chimney.getHex()).toBe(ACCENT.chimney.getHex());
  });

  it('gives a weathered gable roof the patina and a new one none', () => {
    const { mesh } = setup();
    mesh.setReducedMotion(true);
    // Residential density 2 (town house) always has a gable roof.
    mesh.applyDiffs([aged(CENTRE, Zone.Residential, 2, 0)]);
    const gable = mesh.partsAt(CENTRE)!.find((p) => p.kind === PartKind.GableRoof)!;
    const fresh = new THREE.Color();
    mesh.kindMeshes[PartKind.GableRoof].getColorAt(0, fresh);
    expect(fresh.getHex()).toBe(gable.color.getHex());
    mesh.applyDiffs([aged(CENTRE, Zone.Residential, 2, 2)]);
    const old = new THREE.Color();
    mesh.kindMeshes[PartKind.GableRoof].getColorAt(0, old);
    expect(old.getHex()).toBe(applyAgeTint(gable.color, 2, true, new THREE.Color()).getHex());
  });

  it('a densify returns the tile to stage 0 colours', () => {
    const { mesh } = setup();
    mesh.setReducedMotion(true);
    mesh.applyDiffs([aged(CENTRE, Zone.Commercial, 1, 2)]);
    mesh.applyDiffs([aged(CENTRE, Zone.Commercial, 2, 0)]);
    const main = mesh.partsAt(CENTRE)!.find((p) => p.main)!;
    expect(bodyColor(mesh).getHex()).toBe(main.color.getHex());
  });

  it('ignores a re-sent identical age stage', () => {
    const { mesh } = setup();
    mesh.setReducedMotion(true);
    mesh.applyDiffs([aged(CENTRE, Zone.Retail, 1, 1)]);
    const attr = mesh.kindMeshes[PartKind.Box].instanceColor!;
    attr.clearUpdateRanges();
    mesh.applyDiffs([aged(CENTRE, Zone.Retail, 1, 1)]);
    expect(attr.updateRanges).toEqual([]);
  });
});
```

`windowCount()` does not exist yet: add it as a tiny public accessor in
Step 3 (`return this.windowsMesh.count;`) — the existing window tests
read the mesh through the scene; this accessor keeps the age test from
depending on scene child order. (`applySupplyTint` is exported from the
palette; import it in the test too.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/render/buildingsMesh.test.ts`
Expected: FAIL — `windowCount` missing; the age flip does not recolour.

- [ ] **Step 3: Implement**

In `src/render/buildingsMesh.ts`:

Imports — extend the palette import and the primitives import:

```ts
import { PART_KINDS, PartKind, createPartGeometry } from './buildings/primitives.ts';
import { ACCENT, applyAgeTint, applySupplyTint } from './buildings/palette.ts';
```

(`PartKind` was a type-only import; it is now also used as a value.)

`TileBuilding` gains, after `damaged: boolean;`:

```ts
/** TileDiff.ageStage: 0 new, 1 lived-in, 2 weathered. */
ageStage: number;
```

Add a second scratch colour next to `private readonly color = new THREE.Color();`:

```ts
  /** Scratch for the age tint, which feeds the supply tint. */
  private readonly agedColor = new THREE.Color();
```

Public accessor, next to `partsAt`:

```ts
  /** Number of lit window quads currently laid out, for tests. */
  windowCount(): number {
    return this.windowsMesh.count;
  }
```

`applyDiffs`: after `const damaged = (diff.damage ?? 0) > 0;` add

```ts
const ageStage = diff.ageStage ?? 0;
```

Pass `ageStage` into `place` (new-building branch) right after
`damaged`, and in the `else` branch add, after the `supplyFlip` block
and before the accent `setState` block:

```ts
if (existing.ageStage !== ageStage) {
  // Age flips are colour-only: no animation, no window or anchor work.
  existing.ageStage = ageStage;
  if (!supplyFlip) this.writeColors(diff.index);
}
```

In the `reissue` loop pass `b.ageStage` after `b.damaged`.

`place` signature and body: add `ageStage: number,` after
`damaged: boolean,`; set `ageStage,` in the new-building literal after
`damaged,` and `building.ageStage = ageStage;` after
`building.damaged = damaged;` in the re-issue branch.

`writeColors`: replace the colour line with

```ts
const color = p.accent
  ? p.color
  : applySupplyTint(
      applyAgeTint(p.color, building.ageStage, isRoofKind(p.kind), this.agedColor),
      building.supplied,
      this.color,
    );
```

and add a module-level helper near `accentState`:

```ts
/** Pitched roofs take the weathered patina; flat slabs are boxes and do not. */
function isRoofKind(kind: PartKind): boolean {
  return kind === PartKind.GableRoof || kind === PartKind.HipRoof;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm vitest run src/render`
Expected: PASS, including every pre-existing buildings-mesh test (the
default stage 0 is an identity tint, so colours of unchanged tests are
unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/render/buildingsMesh.ts src/render/buildingsMesh.test.ts
git commit -m "feat(render): tint buildings by age stage

The buildings mesh stores TileDiff.ageStage per tile, applies the age
tint before the supply tint on non-accent parts, and treats a stage
change as a colour-only rewrite."
```

---

### Task 5: Docs, spec correction and full checks

**Files:**

- Modify: `docs/superpowers/specs/2026-10-04-building-age-design.md`
  (the `src/sim/growth.ts — exports` bullet in "Architecture → Sim")
- Modify: `docs/plan.md:38,46` (module map lines for `state.ts` and
  `growth.ts`)
- Test: full checks + `node scripts/smoke.mjs`

- [ ] **Step 1: Correct the spec**

In the spec's Sim section, change the bullet that begins
"`src/sim/growth.ts` — exports" so that `ageStageOf` is described as
living in `src/sim/state.ts` beside `deliveryStateOfAge` and
`stopStateOfAge` (reason: `collectDiffs` is in `state.ts` and
`growth.ts` imports from `state.ts`; the reverse import would cycle),
and that `growth.ts` only adds the threshold `markDirty` in its age
loop. Keep everything else.

- [ ] **Step 2: Update the module map**

In `docs/plan.md` change the two lines to:

```
    state.ts       # SimState: typed-array layers, placement rules (incl. tooSteep), diff buckets (delivery, stop, age stage)
    growth.ts      # demand model, building spawn/densify/decay, abandonment, age-stage dirty marks
```

- [ ] **Step 3: Run everything**

Run: `pnpm format && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm coverage && node scripts/smoke.mjs`
Expected: all PASS; coverage thresholds hold. (In this sandbox the dev
server for the smoke script may need `pnpm dev --host 127.0.0.1 --port 5173 --strictPort`
started manually; stop it afterwards.)

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-10-04-building-age-design.md docs/plan.md
git commit -m "docs: record where ageStageOf lives and the age-stage diff bucket"
```

- [ ] **Step 5: Hand back for the Mac visual pass**

Report what to look at (from the spec): a one-year-old city next to a
fresh district (contrast readable, not dirty); weathered roofs against
the Supply overlay; whether the lived-in step is visible at all. Tuning
knobs: the five constants above `applyAgeTint` in
`src/render/buildings/palette.ts`; pacing in
`BALANCE.growth.ageStageTicks`.
