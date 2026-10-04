# Building Visuals, Stage 3: Age — Design

Date: 2026-10-04
Status: approved for planning
Backlog entry: stage 3 of the three stages listed in
`2026-10-03-building-visuals-design.md`

## Goal

Every building currently looks freshly painted forever. Stage 3 lets a
city show its history: a building is clean when it goes up, lived-in
after a season, weathered after a year. A long-running city gets an old
core and clean new districts at its edge; a densified building is a new
facade and starts clean again.

Purely visual. Age has no effect on happiness, growth, costs or any
other mechanic.

## Decisions

Decisions made with the user during brainstorming:

- **Age is time since the last rebuild.** The sim already keeps
  `layers.buildingAge` (ticks since the tile was placed, densified or
  decayed; reset to 0 on each of those) and already saves it. Stage 3
  reuses it. A separate "time since first built" counter that survives
  densification was rejected: it needs a new layer and a save-format
  addition for a distinction the player cannot see.
- **Three stages, paced to the calendar.** New until one season (5
  days) has passed, lived-in until one year (20 days), weathered after
  that. Faster pacing (everything weathered after a year) and slower
  pacing (most sessions never see the third stage) were rejected.
- **Colour only.** Walls lose saturation and darken a little, pitched
  roofs gain a patina, accents keep their colour. Extra "lived-in"
  parts were rejected because the apartment block already uses all
  eight part slots, so they could not be uniform; a sparser night
  window pattern was rejected to keep the recently fixed window layout
  untouched.
- **The sim quantises at diff time.** The tile diff carries a
  three-valued `ageStage`, derived from `buildingAge` when the diff is
  built, the same way `deliveryState` and `stopState` are derived from
  their age counters. Sending the raw age (would need every building
  re-sent each tick) and renderer-side timers (lose age on load, drift
  with game speed) were rejected.

## Architecture

### Sim

- `src/shared/constants.ts` — `BALANCE.growth` gains

  ```ts
  /**
   * Visual age stages (render only): ticks of buildingAge at which a
   * building turns lived-in, then weathered. One season, then one year.
   */
  ageStageTicks: [daysPerSeason * TICKS_PER_DAY, 4 * daysPerSeason * TICKS_PER_DAY],
  ```

  where `daysPerSeason` is the same value `BALANCE.seasons.daysPerSeason`
  uses (hoist it to a module constant so both read one number). No
  other balance value changes.

- `src/sim/state.ts` — exports

  ```ts
  /** 0 = new, 1 = lived-in, 2 = weathered. */
  export function ageStageOf(buildingAge: number): number;
  ```

  returning 0 below the first threshold, 1 below the second, 2 at or
  above it. It lives beside `deliveryStateOfAge` and `stopStateOfAge`
  rather than in `growth.ts`, because `collectDiffs` (which calls it)
  is in `state.ts`, and `growth.ts` already imports from `state.ts` —
  the reverse import would cycle. The per-tick age increment in
  `growthStep` (in `growth.ts`) gains one check: when the incremented
  age equals either threshold, the tile is marked dirty. Placement,
  densify and abandonment decay already reset the age to 0 and mark
  the tile dirty, so a rebuilt facade reads as new at once. Nothing
  else in the sim changes.

- `src/sim/state.ts` — `collectDiffs` writes
  `ageStage: ageStageOf(layers.buildingAge[index])` into every diff
  (0 for tiles without a building, since their age never increments).
  Loading a save re-sends every tile, so stages survive reloads
  without any save-format change.

### Protocol

`TileDiff` in `src/shared/types.ts` gains one required field:

```ts
/** Visual age stage: 0 = new, 1 = lived-in, 2 = weathered (render only). */
ageStage: number;
```

No change to `SaveGame`, `SAVE_VERSION`, the worker message types, the
agent tools or `docs/agent-tools.md`: the inspector and `get_tile`
already expose `buildingAge` in ticks, from which an agent can derive
the stage with the published thresholds.

### Render

- `src/render/buildings/palette.ts` — exports

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

  Stage 0 copies the colour unchanged. Lived-in blends the colour
  toward its own grey (desaturates) by `LIVED_IN_DESATURATE = 0.12` and
  multiplies by `LIVED_IN_DARKEN = 0.96`. Weathered desaturates by
  `WEATHERED_DESATURATE = 0.3` and darkens by `WEATHERED_DARKEN = 0.9`;
  when `roof` is true it additionally lerps toward
  `ROOF_PATINA = 0x6f7a74` (a muted slate-green) by
  `WEATHERED_PATINA_BLEND = 0.3`. Lived-in roofs get the wall treatment
  only. All five numbers are module constants in `palette.ts`; they are
  render tuning, not balance.

  Desaturation is a lerp toward the colour's luminance grey
  (`0.299 r + 0.587 g + 0.114 b`), so hue is kept and a cream wall
  stays cream, just duller.

- `src/render/buildingsMesh.ts` — `TileBuilding` gains
  `ageStage: number`. `applyDiffs` reads `diff.ageStage ?? 0`
  (test fixtures build partial diffs) and treats a stage change like a
  supply flip: `writeColors` only, no matrices, no window rebuild, no
  accent-sink call. `place` takes the stage with the other tile state.
  `writeColors` applies, for non-accent parts,
  `applyAgeTint(p.color, building.ageStage, isRoofKind(p.kind), tmp)`
  and then `applySupplyTint(tmp, building.supplied, out)` on the result,
  so a weathered, undersupplied building is both duller and greyer.
  `isRoofKind` is true for `PartKind.GableRoof` and `PartKind.HipRoof`;
  flat roof slabs are boxes and get the wall treatment, which is
  acceptable at isometric distance. Accents (doors, PV, chimneys,
  antennas, AC units, water tanks) keep their colour at every stage, as
  they do under the supply tint.

- Nothing changes in `recipes.ts`, `accents.ts`, `buildingFxMesh.ts`,
  `renderer.ts`, the windows or the grow animation.

### Determinism and performance

The stage is a pure function of a saved counter, so every client shows
the same age. The sim's extra work is one integer comparison per
building per tick inside a loop that already runs. The renderer does
one extra colour blend per part when a tile is placed or changes stage,
and nothing per frame.

## Testing

- `src/sim/growth.test.ts`: `ageStageOf` returns 0, 1, 2 at and around
  both thresholds; a building is marked dirty on exactly the ticks its
  age reaches each threshold and not on the ticks before or after; a
  densify resets the age so the next diff carries stage 0.
- `src/sim/state.test.ts`: `collectDiffs` carries `ageStage` 0, 1 and 2
  for buildings whose `buildingAge` is set below, between and above the
  thresholds; an empty tile reports 0.
- `src/render/buildings/palette.test.ts`: stage 0 is identity for walls
  and roofs; saturation and lightness fall from stage 0 to 1 to 2 for a
  wall colour; the patina applies to roofs at stage 2 only (a stage 2
  roof differs from a stage 2 wall of the same input colour, a stage 1
  roof does not); every channel stays within 0..1 for every family hue
  at every stage; an unknown stage above 2 is treated as weathered.
- `src/render/buildingsMesh.test.ts`: an age-stage flip changes the
  body colour but not the matrices, the window slots or the accent sink
  (recording sink receives no call); accent parts keep their colour
  across stages; a densify (stage back to 0) restores the stage 0
  colour; a stage 2 building that is also undersupplied differs from
  both a stage 2 supplied and a stage 0 undersupplied one.
- `node scripts/smoke.mjs` still passes; coverage gate holds.
- Mac visual pass: a one-year-old city next to a fresh district — the
  contrast should be readable but not dirty; weathered roofs against
  the Supply overlay; check the lived-in step is visible at all.

## Out of scope

Any gameplay effect of age, a separate first-built counter, extra
age-dependent parts, window-pattern changes, inspector or agent-tool
exposure of the stage (the raw age is already exposed), i18n, save
format.
