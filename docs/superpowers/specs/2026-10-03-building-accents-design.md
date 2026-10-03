# Building Visuals, Stage 2: Animated Accents — Design

Date: 2026-10-03
Status: approved for planning
Backlog entry: stage 2 of the three stages listed in
`2026-10-03-building-visuals-design.md`

## Goal

Stage 1 gave every zone building a low-poly silhouette with chimneys,
vent stacks and antennas. Nothing on a building moves yet apart from
the grow-in, so a city at night or in winter is as still as a model.
Stage 2 adds three small, cheap animations that make the city feel
inhabited and make one mechanic readable from the map:

- **Chimney smoke** on detached houses that heat themselves in the
  cold. A street connected to a heat plant stops smoking, so the
  district-heating reward is visible without the Heat overlay.
- **Vent puffs** from the market hall's two rooftop stacks while the
  hall has full power: faint, in any season, a sign of a busy shop.
- **Antenna beacon** on the office block and the tower: a small red
  light that blinks at night, each on its own phase.

Render only. The sim, the worker protocol and the save format are
untouched; the sim already sends a per-tile district-heating flag, the
supply status, damage and the air temperature.

## Decisions

Decisions made with the user during brainstorming:

- **Smoke only where a chimney already exists.** Only the detached
  house recipe (residential density 1) has a chimney, so only houses
  smoke. Adding flues to town houses, apartment blocks, offices or
  shops was rejected: offices with chimneys look odd and the extra
  parts would eat recipe slots.
- **Beacon at night only.** Real aircraft-warning lights are mostly a
  night thing, and a blink in daylight is noise. Under reduced motion
  the beacon stays lit instead of blinking.
- **Vents puff, AC units stay static.** A heat shimmer over office AC
  units would need a second effect type and reads poorly at isometric
  distance.
- **Effects live in their own layer.** The buildings mesh keeps to
  shapes, slot blocks and windows; a new effects layer owns the
  particles and beacons. Both are testable on their own. Putting the
  per-frame particle logic inside `buildingsMesh.ts` (already the
  largest render file) and re-deriving recipes from tile diffs in a
  standalone layer (would duplicate the street-face logic) were
  rejected.

## Architecture

### Modules

- `src/render/buildings/recipes.ts` — `BuildingPart` gains an optional
  `role?: PartRole` with `PartRole = { Chimney, Vent, Antenna }`. The
  house recipe tags its chimney, the market hall its two vent
  cylinders, the office block and the tower their antenna cylinder.
  Nothing else changes; the picker stream and every existing part stay
  identical, so recipe determinism tests keep passing.
- `src/render/buildingsMesh.ts` — on `place`, re-issue and `remove`,
  derives the world-space anchors of the tagged parts and forwards
  them, with the tile's effect state, to a sink. On a diff that only
  flips supply, heat or damage it forwards the new state alone. The
  sink is a small interface so the mesh does not depend on the
  effects class:

  ```ts
  export interface AccentAnchor {
    role: PartRole;
    x: number; // world x of the part's top centre
    y: number; // world y of the part's top
    z: number; // world z
  }
  export interface AccentState {
    heated: boolean; // on the district network this tick
    supplied: SupplyStatus;
    damaged: boolean; // damage > 0: out of service
  }
  export interface AccentSink {
    set(index: number, anchors: readonly AccentAnchor[], state: AccentState): void;
    setState(index: number, state: AccentState): void;
    remove(index: number): void;
  }
  ```

  The anchor of a part is the point the matrix composer would place at
  the part's top centre: tile centre plus `ox`/`oz`, elevation lift plus
  `oy + sy`. Parts with a `turn` other than zero are not tagged in any
  recipe, so no rotation is applied; a test guards that.
  `TileBuilding` gains `heated` and `damaged` so flips are detected the
  same way supply flips are today.

- `src/render/buildingFxMesh.ts` — new `DiffLayer` and `AccentSink`.
  Owns two instanced meshes (puffs, beacons), the emitter table, and
  the per-frame rebuild. It has no `applyDiffs` work of its own
  (the method is a no-op required by the interface); everything it
  knows arrives through the sink.
- `src/render/renderer.ts` — constructs the effects layer, passes it
  to the buildings mesh constructor as the sink, and registers both as
  diff layers so environment, reduced motion and update calls reach
  them.

### Emitters

The effects layer keeps `Map<number, Emitter>` keyed by tile index:

```ts
interface Emitter {
  anchors: AccentAnchor[];
  state: AccentState;
  /** Stable 0..1 phase so neighbours never puff or blink in step. */
  phase: number;
}
```

`phase` is a hash of the tile index (same `hash01` idea as
`weatherFx.ts`). An emitter is created by `set`, its anchors replaced by
a later `set`, its state replaced by `setState`, and it is dropped by
`remove`.

Activity per role, evaluated at rebuild time:

| role    | active when                                                      | strength                     |
| ------- | ---------------------------------------------------------------- | ---------------------------- |
| chimney | `!heated && supplied !== NotConnected && !damaged && degree > 0` | `degree` (0..1)              |
| vent    | `supplied === Supplied && !damaged`                              | fixed `VENT_STRENGTH` (0.45) |
| antenna | `supplied !== NotConnected && !damaged`                          | night fade, see beacon       |

`degree` is the sim's heating-degree curve applied to the environment's
air temperature: 0 at or above `BALANCE.seasons.heating.comfortTemperature`
(16 °C), rising linearly to 1 over `heatingRange` (20 °C) below it.
`heatingDegree` lives in `src/sim/seasons.ts` today, and the render
layer must not import from `src/sim/` (architecture rule). It moves,
together with its sibling `coolingDegree`, to a new pure
`src/shared/heating.ts` next to `shared/daylight.ts`, which the renderer
already imports; `seasons.ts`, `energy.ts` and `heat.ts` import from
there. Behaviour is unchanged. A house therefore stops smoking at
exactly the temperature where its heating load reaches zero, and smokes
hardest in a deep freeze.

### Puffs

One `InstancedMesh` of low-poly spheres (`SphereGeometry(0.5, 8, 6)`,
scaled per instance) with a `MeshBasicMaterial` that is transparent,
does not write depth, and has a mid-grey base colour; per-instance
colour carries the strength and the night dimming. Capacity is
`gridSize² × PUFFS_PER_EMITTER` with `PUFFS_PER_EMITTER = 3`, so no
emitter is ever dropped on a 64×64 map; `count` tracks the live puffs.

Each active chimney or vent anchor owns three puffs on a repeating
cycle. For puff `k` of an emitter at time `t` seconds:

```
u = frac(t / CYCLE + k / PUFFS_PER_EMITTER + phase)
```

- position: anchor, lifted by `u × RISE` and drifted sideways by a small
  `WIND_DRIFT × u` along +x (a fixed direction; the camera rotates in
  quarter turns so no direction is privileged for long).
- scale: `PUFF_MIN + (PUFF_MAX − PUFF_MIN) × u` (0.03 → 0.12 tiles).
- colour: base grey scaled by `strength × (1 − u) × nightDim`, where
  `nightDim = 1 − NIGHT_DIM × nightFactor` as the steam does.

Chimneys use `CYCLE = 2.4 s`, `RISE = 0.35`. Vents use the same cycle but
`RISE = 0.2` and `VENT_STRENGTH = 0.45`, so their puffs are shorter and
thinner. All values are module constants in `buildingFxMesh.ts`; none
are balance values, so `BALANCE` is not touched.

### Beacons

One `InstancedMesh` of small boxes (`0.04 × 0.03 × 0.04`) with a red
`MeshBasicMaterial` (`0xff3b30`, transparent). Capacity `gridSize²`,
one instance per antenna anchor. The material's opacity fades in with
the night exactly like the window lights:
`max(0, nightFactor − 0.25) / 0.75`, and the mesh is hidden while that
is under 0.02, so beacons cost nothing by day.

Blink: a beacon is lit while `frac(t / BLINK_PERIOD + phase) < BLINK_DUTY`
with `BLINK_PERIOD = 2 s` and `BLINK_DUTY = 0.12`. Lit means its matrix
is the box at the anchor; dark means the hidden zero-scale matrix.
Under reduced motion every beacon is lit. Beacons sit on the antenna
tip, 0.015 above the anchor so they do not z-fight the cylinder's cap.

### Updates and reduced motion

- With motion on, `update(delta, now)` rebuilds the puff and beacon
  matrices and colours every frame while at least one emitter is
  active. Uploads cover `0..count` only.
- With reduced motion on, puffs freeze at `t = 0` and beacons stay lit;
  the layer rebuilds only when something it depends on changed: an
  emitter was set, re-stated or removed; the temperature moved by more
  than `TEMPERATURE_EPSILON = 0.25 °C`; or the night factor moved by
  more than `NIGHT_FACTOR_EPSILON = 0.002`. An idle map does no
  per-frame uploads, matching `geothermalMesh.ts`'s rule.
- `setEnvironment` stores the night factor and temperature and marks
  the layer dirty on a meaningful change. `setReducedMotion` marks it
  dirty too, so the freeze/lit state takes effect immediately.
- The grow-in animation does not delay the effects: a freshly placed
  house smokes from its first frame. Rare and harmless.

## Testing

- `src/render/buildings/recipes.test.ts`: every residential density-1
  recipe has exactly one chimney-role part, the market hall has two
  vent-role parts, the office block and tower have one antenna-role
  part each, every other recipe has none, and no role-tagged part has a
  non-zero `turn`.
- `src/render/buildingsMesh.test.ts` with a recording sink: placing a
  house calls `set` with one chimney anchor at the chimney's top
  (tile centre plus offset, lift plus `oy + sy`); placing a hall gives
  two vent anchors; a supply or heat flip calls `setState` only; a
  road laid beside the house re-issues the anchors; removing the
  building calls `remove`.
- `src/render/buildingFxMesh.test.ts` with a stub scene, driving the
  sink directly:
  - a cold (0 °C), self-heated, supplied, intact chimney yields three
    puffs; the same chimney on district heat, or at 16 °C, or not
    connected, or damaged yields none;
  - puff strength at −4 °C exceeds that at 10 °C;
  - a fully supplied hall yields six vent puffs, an undersupplied one
    none;
  - puff matrices differ between two frames with motion on and are
    identical with reduced motion on;
  - the beacon count equals the antenna count, the beacon mesh is
    hidden by day and visible at night, a beacon is dark at some phase
    and lit at another with motion on, and all are lit under reduced
    motion;
  - removing a tile frees its puffs and beacons (counts drop).
- `node scripts/smoke.mjs` still passes.
- Mac visual pass: smoke over a cold village before and after a heat
  plant is connected, vent puffs on a market hall, beacons on a
  commercial district at night, frame time on a full 64×64 map in
  winter.

## Out of scope

Age (stage 3), smoke on any recipe without a chimney, AC-unit shimmer,
daytime beacons, any sim, worker protocol or save change, agent tools,
i18n and settings (the existing reduced-motion switch is reused).
