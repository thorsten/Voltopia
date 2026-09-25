# Geothermal Power Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add geothermal power — clustered hotspots generated with the map, a plant that produces constant baseload on them, and a per-field heat reservoir that cools reversibly when a field is drilled beyond its sustainable well count.

**Architecture:** Two new `Uint8Array` tile layers (`geothermal` = quality 1..3, `reservoirHeat` = quantised temperature) follow the existing layer pipeline: generation → diffs → save → render. Fields (connected components of the hotspot layer) are derived state on `SimState`, recomputed after generation and after loading, never persisted. A per-tick reservoir step runs before the energy step, so output and heat drain always agree on the same well count.

**Tech Stack:** TypeScript (strict), Vite, vitest, three.js, React 19, pnpm.

**Spec:** `docs/superpowers/specs/2026-09-25-geothermal-power-design.md`

## Global Constraints

- `src/sim/` is pure: **no DOM and no three.js imports**, deterministic, all randomness through a seeded `Rng`.
- **No magic numbers in sim code** — every tuning value lives in `BALANCE` in `src/shared/constants.ts`.
- Every user-visible string goes through `src/ui/i18n.tsx` in **both** English and German.
- New `THREE.InstancedMesh` → always `frustumCulled = false`.
- React effects depend on stable identities (`bridge.send`), never on the `bridge` object.
- Save games stay backward compatible via optional fields; `SAVE_VERSION` stays `1`.
- Run `pnpm format` after edits; the pre-commit hook runs `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` and must pass — never use `--no-verify`.
- Tests are colocated as `*.test.ts`; coverage gate is ≥90 % on `src/sim` and `src/shared` (`pnpm coverage`).
- Commit messages: imperative summary + short body, one feature/fix per commit.
- Energy terminology: generation, consumption, state of charge, curtailment, peak load.

## File Structure

**Created:**

- `src/sim/geothermal.ts` — hotspot generation, field discovery, reservoir step. The only place that knows the reservoir maths.
- `src/sim/geothermal.test.ts` — generation and reservoir tests.
- `src/render/geothermalMesh.ts` — fumarole cones and steam billboards on hotspot tiles.

**Modified:**

- `src/shared/types.ts` — `PlantType.GeothermalPlant`, `TileDiff.geothermal` / `.reservoirHeat`, `GlobalStats.generation.geothermal`.
- `src/shared/constants.ts` — `BALANCE.geothermal`, cost, upkeep, `energy.geothermalPeakOutput`.
- `src/sim/state.ts` — two layers, `geothermalFields` on `SimState`, `lastEnergy.geothermal`, diff collection, build rejection, save/restore.
- `src/sim/engine.ts` — call generation and field discovery on a new game.
- `src/sim/tick.ts` — reservoir step before the energy step; stats.
- `src/sim/energy.ts` — census and generation term.
- `src/sim/inspect.ts` — hotspot facts for the tile inspector.
- `src/sim/goals.ts` — the `geothermalBaseload` goal.
- `src/storage/serialization.ts` — both layers as optional layers.
- `src/render/plantsMesh.ts`, `src/render/minimapLayer.ts`, `src/render/renderer.ts` — plant shape, minimap colour, layer registration.
- `src/ui/useTools.ts`, `BuildBar.tsx`, `EnergyPanel.tsx`, `TileInspector.tsx`, `i18n.tsx` — tool, hotkey, panels, strings.
- `src/agent/tools.ts`, `docs/agent-tools.md` — agent parity.

---

### Task 1: Constants, layers and diff plumbing

Lays the data foundation: the plant type, both layers, the balance values. No behaviour yet — but `PlantType` is used in exhaustive `Record` maps, so those must be filled in the same commit or `pnpm typecheck` fails.

**Files:**

- Modify: `src/shared/types.ts`, `src/shared/constants.ts`, `src/sim/state.ts`, `src/ui/TileInspector.tsx`, `src/ui/i18n.tsx`
- Test: `src/sim/state.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `PlantType.GeothermalPlant = 15`; `layers.geothermal: Uint8Array` (0 = none, else quality 1..3); `layers.reservoirHeat: Uint8Array` (0..255); `BALANCE.geothermal`; `BALANCE.energy.geothermalPeakOutput: number`; `TileDiff.geothermal: number`; `TileDiff.reservoirHeat: number`.

- [ ] **Step 1: Write the failing test**

In `src/sim/state.test.ts`:

```ts
it('carries the geothermal layers in tile diffs', () => {
  const state = createSimState(7, 8);
  state.layers.geothermal[5] = 2;
  state.layers.reservoirHeat[5] = 200;
  markDirty(state, 5);
  const diff = collectDiffs(state).find((d) => d.index === 5);
  expect(diff?.geothermal).toBe(2);
  expect(diff?.reservoirHeat).toBe(200);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/sim/state.test.ts -t geothermal`
Expected: FAIL — `geothermal` does not exist on the layers.

- [ ] **Step 3: Add the plant type and diff fields**

In `src/shared/types.ts`, extend `PlantType` and `TileDiff`:

```ts
  HydrogenPlant: 13,
  TidalPlant: 14,
  GeothermalPlant: 15,
} as const;
```

```ts
/** Forest growth stage on this tile: 0 = none, 1..maxStage. */
forest: number;
/** Geothermal hotspot quality on this tile: 0 = none, 1..3. */
geothermal: number;
/** Quantised reservoir temperature 0..255 of this tile's field (0 off a hotspot). */
reservoirHeat: number;
```

And in `GlobalStats.generation`, after `tidal`:

```ts
/** Geothermal baseload output this tick. */
geothermal: number;
```

- [ ] **Step 4: Add the balance values**

In `src/shared/constants.ts`, add to `costs.plant` and `upkeepPerTick.plant`:

```ts
      /**
       * Drilling is the cost: at geothermalPeakOutput 24 the output alone
       * would price near 2_600 (the ~110 per effective peak unit that
       * run-of-river and tidal share); the rest is the borehole.
       */
      [PlantType.GeothermalPlant]: 3_200,
```

```ts
      /** Below run-of-river (0.06): no fuel, no moving water, just pumps. */
      [PlantType.GeothermalPlant]: 0.05,
```

In the `energy` section, after `tidalPeakOutput`:

```ts
    /**
     * Geothermal output per plant per tick at quality factor 1 and a full
     * reservoir — constant, with no weather, daylight or tide factor.
     * Starting value ≈ a run-of-river plant's daily *average*; tuned by
     * the probe in the last task of this plan.
     */
    geothermalPeakOutput: 24,
```

And a new top-level section after `sea`:

```ts
  geothermal: {
    /** One hotspot field per this many map tiles, before the clamp. */
    tilesPerSpot: 700,
    /** Field count is clamped into this range (target, not a guarantee). */
    minSpots: 3,
    maxSpots: 8,
    /** Chebyshev distance kept between two field seeds. */
    minSpotDistance: 8,
    /** A field grows to this many tiles (inclusive). */
    clusterSizeRange: [2, 5],
    /** Elevation from which a tile counts as highland. */
    highlandLevel: 3,
    /** How much more often a highland tile is drawn as a field seed. */
    highlandWeight: 4,
    /** Output factor by quality; index 0 is unused (0 = no hotspot). */
    qualityFactor: [0, 0.7, 1.0, 1.3],
    /** Wells one field tile sustains before the reservoir starts cooling. */
    sustainablePerTile: 0.5,
    /**
     * Heat recovered per tick toward a full reservoir. 1/recharge ≈ 2000
     * ticks ≈ 2 in-game days, so recovery is slow but within a session.
     */
    recharge: 0.0005,
    /**
     * Heat drawn per tick per well above capacity. One excess well settles
     * a field at recharge/(recharge+drain) ≈ 77 %; total field output rises
     * with every extra well but flattens toward recharge/drain ≈ 3.3
     * well-equivalents, so overdrilling wastes capital, never destroys.
     */
    drain: 0.00015,
  },
```

- [ ] **Step 5: Add the layers and the diff fields**

In `src/sim/state.ts`, in `TileLayers` after `forest`:

```ts
/** Geothermal hotspot quality per tile: 0 = none, 1..3. Immutable after generation. */
geothermal: Uint8Array;
/** Quantised reservoir temperature 0..255 (all tiles of a field share one value). */
reservoirHeat: Uint8Array;
```

In `createTileLayers`, after `forest: new Uint8Array(tiles),`:

```ts
    geothermal: new Uint8Array(tiles),
    reservoirHeat: new Uint8Array(tiles),
```

In `collectDiffs`, after `forest: layers.forest[index],`:

```ts
      geothermal: layers.geothermal[index],
      reservoirHeat: layers.reservoirHeat[index],
```

- [ ] **Step 6: Fill the exhaustive maps typecheck now demands**

`src/ui/TileInspector.tsx` — `PLANT_LABEL` is a full `Record<PlantType, …>`:

```ts
  [PlantType.GeothermalPlant]: 'tool.plant-geothermal',
```

`src/ui/i18n.tsx` — add the key in **both** language blocks:

```ts
  'tool.plant-geothermal': 'Geothermal plant',
```

```ts
  'tool.plant-geothermal': 'Geothermiekraftwerk',
```

- [ ] **Step 7: Run the test and the typecheck**

Run: `pnpm vitest run src/sim/state.test.ts -t geothermal && pnpm typecheck`
Expected: PASS, and no type errors.

- [ ] **Step 8: Commit**

```bash
pnpm format
git add src/shared src/sim/state.ts src/sim/state.test.ts src/ui/TileInspector.tsx src/ui/i18n.tsx
git commit -m "feat(sim): geothermal plant type and hotspot layers"
```

---

### Task 2: Hotspot generation

**Files:**

- Create: `src/sim/geothermal.ts`, `src/sim/geothermal.test.ts`
- Modify: `src/sim/engine.ts:43-52`

**Interfaces:**

- Consumes: `BALANCE.geothermal`, `layers.geothermal`, `layers.reservoirHeat` (Task 1).
- Produces: `generateGeothermal(state: SimState): void`; `FULL_HEAT = 255`; `chebyshev(a, b, size): number` in `src/shared/grid.ts`.

- [ ] **Step 1: Write the failing tests**

Create `src/sim/geothermal.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BALANCE } from '../shared/constants.ts';
import { chebyshev } from '../shared/grid.ts';
import { Terrain } from '../shared/types.ts';
import { generateGeothermal, FULL_HEAT } from './geothermal.ts';
import { createSimState, slopeAt, type SimState } from './state.ts';
import { generateTerrain } from './terrain.ts';
import { generateWater } from './water.ts';

function mapWithHotspots(seed: number, size = 64): SimState {
  const state = createSimState(seed, size);
  generateTerrain(state);
  generateWater(state);
  generateGeothermal(state);
  return state;
}

/** Tile indices of every hotspot tile. */
function hotspots(state: SimState): number[] {
  const tiles: number[] = [];
  for (let i = 0; i < state.layers.geothermal.length; i++) {
    if (state.layers.geothermal[i] !== 0) tiles.push(i);
  }
  return tiles;
}

describe('geothermal generation', () => {
  it('is deterministic per seed', () => {
    expect(hotspots(mapWithHotspots(99))).toEqual(hotspots(mapWithHotspots(99)));
    expect(hotspots(mapWithHotspots(99))).not.toEqual(hotspots(mapWithHotspots(100)));
  });

  it('places hotspots only on buildable land', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const state = mapWithHotspots(seed);
      for (const index of hotspots(state)) {
        expect(state.layers.terrain[index]).toBe(Terrain.Land);
        expect(slopeAt(state, index)).toBeLessThanOrEqual(BALANCE.terrain.maxBuildSlope);
      }
    }
  });

  it('gives every hotspot tile a quality of 1..3 and a full reservoir', () => {
    const state = mapWithHotspots(7);
    for (const index of hotspots(state)) {
      expect(state.layers.geothermal[index]).toBeGreaterThanOrEqual(1);
      expect(state.layers.geothermal[index]).toBeLessThanOrEqual(3);
      expect(state.layers.reservoirHeat[index]).toBe(FULL_HEAT);
    }
    // Off a hotspot the reservoir layer stays empty.
    const off = state.layers.geothermal.findIndex((q) => q === 0);
    expect(state.layers.reservoirHeat[off]).toBe(0);
  });

  it('keeps fields apart and within the configured count', () => {
    const cfg = BALANCE.geothermal;
    for (const seed of [11, 12, 13]) {
      const state = mapWithHotspots(seed);
      const fields = componentsOf(state);
      expect(fields.length).toBeGreaterThanOrEqual(1);
      expect(fields.length).toBeLessThanOrEqual(cfg.maxSpots);
      for (const field of fields) {
        expect(field.length).toBeGreaterThanOrEqual(cfg.clusterSizeRange[0]);
        expect(field.length).toBeLessThanOrEqual(cfg.clusterSizeRange[1]);
      }
      // Seeds are minSpotDistance apart, so two fields never touch.
      for (let a = 0; a < fields.length; a++) {
        for (let b = a + 1; b < fields.length; b++) {
          const nearest = Math.min(
            ...fields[a].flatMap((i) => fields[b].map((j) => chebyshev(i, j, state.size))),
          );
          expect(nearest).toBeGreaterThan(1);
        }
      }
    }
  });

  it('favours the highlands without requiring them', () => {
    let highland = 0;
    let total = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const state = mapWithHotspots(seed);
      for (const index of hotspots(state)) {
        total++;
        if (state.layers.elevation[index] >= BALANCE.geothermal.highlandLevel) highland++;
      }
    }
    expect(total).toBeGreaterThan(0);
    // Highland tiles are a minority of any map, so an unbiased draw would
    // land far below this; the weight has to show.
    expect(highland / total).toBeGreaterThan(0.3);
  });

  it('still places fields on a map with no highland at all', () => {
    const state = createSimState(4, 64);
    // Flat map: no tile reaches highlandLevel.
    state.layers.elevation.fill(0);
    generateGeothermal(state);
    expect(hotspots(state).length).toBeGreaterThan(0);
  });
});

/** Connected components of the hotspot layer, as tile-index lists. */
function componentsOf(state: SimState): number[][] {
  const { geothermal } = state.layers;
  const seen = new Set<number>();
  const out: number[][] = [];
  for (let i = 0; i < geothermal.length; i++) {
    if (geothermal[i] === 0 || seen.has(i)) continue;
    const tiles: number[] = [];
    const stack = [i];
    seen.add(i);
    while (stack.length > 0) {
      const index = stack.pop()!;
      tiles.push(index);
      for (const n of neighbors4(index, state.size)) {
        if (geothermal[n] !== 0 && !seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
    out.push(tiles);
  }
  return out;
}
```

Add the imports the helper needs: `import { chebyshev, neighbors4 } from '../shared/grid.ts';`. If `chebyshev` does not exist in `src/shared/grid.ts`, add it there with a test in `src/shared/grid.test.ts`:

```ts
/** Chebyshev (chessboard) distance between two tile indices. */
export function chebyshev(a: number, b: number, size: number): number {
  return Math.max(
    Math.abs(tileX(a, size) - tileX(b, size)),
    Math.abs(tileY(a, size) - tileY(b, size)),
  );
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/sim/geothermal.test.ts`
Expected: FAIL — cannot resolve `./geothermal.ts`.

- [ ] **Step 3: Write the generator**

Create `src/sim/geothermal.ts`:

```ts
import { BALANCE } from '../shared/constants.ts';
import { neighbors4 } from '../shared/grid.ts';
import { Rng } from '../shared/rng.ts';
import { Terrain } from '../shared/types.ts';
import { markDirty, slopeAt, type SimState } from './state.ts';

/** Keeps the hotspots independent of terrain, water, forest and gameplay RNG. */
const GEOTHERMAL_SEED_SALT = 0x6e07be;

/** A brimful reservoir, as stored in the quantised `reservoirHeat` layer. */
export const FULL_HEAT = 255;

/**
 * Geothermal hotspots: small clusters of hot rock, drawn toward the
 * highlands but never confined to them. Each cluster is one *field* —
 * several wells may tap it, and they share its heat (see reservoirStep).
 *
 * Generation is a pure function of seed, terrain and elevation, so a save
 * written before this feature can regenerate exactly the same hotspots.
 */
export function generateGeothermal(state: SimState): void {
  const rng = new Rng((state.seed ^ GEOTHERMAL_SEED_SALT) >>> 0);
  const { size } = state;
  const cfg = BALANCE.geothermal;
  const { geothermal, reservoirHeat } = state.layers;

  // Candidates are buildable land; highland tiles enter the pool several
  // times so they are drawn more often without ever being required.
  const pool: number[] = [];
  for (let index = 0; index < geothermal.length; index++) {
    if (!isDrillable(state, index)) continue;
    const weight = state.layers.elevation[index] >= cfg.highlandLevel ? cfg.highlandWeight : 1;
    for (let w = 0; w < weight; w++) pool.push(index);
  }
  if (pool.length === 0) return;

  const target = Math.min(
    cfg.maxSpots,
    Math.max(cfg.minSpots, Math.round((size * size) / cfg.tilesPerSpot)),
  );
  const [minSize, maxSize] = cfg.clusterSizeRange;
  const seeds: number[] = [];
  // Bounded: every attempt consumes one draw, so this always terminates.
  const maxAttempts = target * 40;
  for (let attempt = 0; attempt < maxAttempts && seeds.length < target; attempt++) {
    const seed = pool[rng.nextInt(pool.length)];
    if (geothermal[seed] !== 0) continue;
    if (seeds.some((other) => chebyshevDistance(seed, other, size) < cfg.minSpotDistance)) continue;

    const highland = state.layers.elevation[seed] >= cfg.highlandLevel;
    const quality = Math.min(3, 1 + rng.nextInt(2) + (highland ? 1 : 0));
    const wanted = minSize + rng.nextInt(maxSize - minSize + 1);
    const tiles = growField(state, seed, wanted, rng);
    if (tiles.length < minSize) continue;

    for (const index of tiles) {
      geothermal[index] = quality;
      reservoirHeat[index] = FULL_HEAT;
      markDirty(state, index);
    }
    seeds.push(seed);
  }
}

/** True where a well could ever stand: buildable land, no water. */
function isDrillable(state: SimState, index: number): boolean {
  if (state.layers.terrain[index] !== Terrain.Land) return false;
  return slopeAt(state, index) <= BALANCE.terrain.maxBuildSlope;
}

/** Grow a field from its seed by random flood fill over drillable land. */
function growField(state: SimState, seed: number, wanted: number, rng: Rng): number[] {
  const tiles = [seed];
  const frontier = [...neighbors4(seed, state.size)];
  while (tiles.length < wanted && frontier.length > 0) {
    const pick = rng.nextInt(frontier.length);
    const index = frontier.splice(pick, 1)[0];
    if (tiles.includes(index)) continue;
    if (!isDrillable(state, index) || state.layers.geothermal[index] !== 0) continue;
    tiles.push(index);
    frontier.push(...neighbors4(index, state.size));
  }
  return tiles;
}
```

Use the shared `chebyshev` helper from `src/shared/grid.ts` (added in Step 1) for the seed spacing check — do not write a second local copy:

```ts
if (seeds.some((other) => chebyshev(seed, other, size) < cfg.minSpotDistance)) continue;
```

- [ ] **Step 4: Wire it into a new game**

In `src/sim/engine.ts`, import and call it after the water and before the forest, so woods may grow over a field:

```ts
import { generateGeothermal } from './geothermal.ts';
```

```ts
generateTerrain(this.state);
generateWater(this.state);
generateGeothermal(this.state);
generateForest(this.state);
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run src/sim/geothermal.test.ts src/sim/engine.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
pnpm format
git add src/sim/geothermal.ts src/sim/geothermal.test.ts src/sim/engine.ts src/shared/grid.ts src/shared/grid.test.ts
git commit -m "feat(sim): generate geothermal hotspots in the highlands"
```

---

### Task 3: Fields and the reservoir step

**Files:**

- Modify: `src/sim/geothermal.ts`, `src/sim/state.ts` (`SimState`, `createSimState`), `src/sim/tick.ts:57`
- Test: `src/sim/geothermal.test.ts`

**Interfaces:**

- Consumes: `generateGeothermal`, `FULL_HEAT` (Task 2).
- Produces: `interface GeothermalField { tiles: number[]; quality: number; capacity: number; heat: number }`; `discoverGeothermalFields(state): void` (fills `state.geothermalFields`); `reservoirStep(state): void`; `fieldAt(state, index): GeothermalField | undefined`.

- [ ] **Step 1: Write the failing tests**

Append to `src/sim/geothermal.test.ts`:

```ts
import { PlantType, TileType } from '../shared/types.ts';
import { discoverGeothermalFields, fieldAt, reservoirStep } from './geothermal.ts';

/** A 16×16 flat map with one 4-tile field and nothing else. */
function fieldMap(): SimState {
  const state = createSimState(3, 16);
  for (const index of [34, 35, 50, 51]) {
    state.layers.geothermal[index] = 2;
    state.layers.reservoirHeat[index] = FULL_HEAT;
  }
  discoverGeothermalFields(state);
  return state;
}

function drill(state: SimState, index: number): void {
  state.layers.tileType[index] = TileType.Plant;
  state.layers.plantType[index] = PlantType.GeothermalPlant;
}

describe('geothermal fields', () => {
  it('finds one field per connected hotspot cluster', () => {
    const state = fieldMap();
    expect(state.geothermalFields).toHaveLength(1);
    expect(state.geothermalFields[0].tiles.sort((a, b) => a - b)).toEqual([34, 35, 50, 51]);
    expect(state.geothermalFields[0].quality).toBe(2);
    // 4 tiles × sustainablePerTile 0.5 × qualityFactor 1.0 = 2 wells.
    expect(state.geothermalFields[0].capacity).toBe(2);
    expect(fieldAt(state, 35)).toBe(state.geothermalFields[0]);
    expect(fieldAt(state, 0)).toBeUndefined();
  });

  it('holds a full reservoir at or below capacity', () => {
    const state = fieldMap();
    drill(state, 34);
    drill(state, 35);
    for (let i = 0; i < 5000; i++) reservoirStep(state);
    expect(state.geothermalFields[0].heat).toBeCloseTo(1, 6);
    expect(state.layers.reservoirHeat[34]).toBe(FULL_HEAT);
  });

  it('cools toward the predicted equilibrium when overdrilled', () => {
    const state = fieldMap();
    for (const index of [34, 35, 50]) drill(state, index); // one well over capacity
    const { recharge, drain } = BALANCE.geothermal;
    const expected = recharge / (recharge + drain);
    for (let i = 0; i < 20_000; i++) reservoirStep(state);
    expect(state.geothermalFields[0].heat).toBeCloseTo(expected, 3);
    // Every tile of the field carries the same quantised value.
    expect(state.layers.reservoirHeat[51]).toBe(state.layers.reservoirHeat[34]);
    expect(state.layers.reservoirHeat[34]).toBe(Math.round(expected * FULL_HEAT));
  });

  it('recovers once the excess wells are gone', () => {
    const state = fieldMap();
    for (const index of [34, 35, 50]) drill(state, index);
    for (let i = 0; i < 20_000; i++) reservoirStep(state);
    expect(state.geothermalFields[0].heat).toBeLessThan(0.9);
    state.layers.tileType[50] = TileType.Empty;
    state.layers.plantType[50] = PlantType.None;
    for (let i = 0; i < 20_000; i++) reservoirStep(state);
    expect(state.geothermalFields[0].heat).toBeCloseTo(1, 3);
  });

  it('stays within 0..1 under the heaviest possible load', () => {
    const state = fieldMap();
    for (const index of [34, 35, 50, 51]) drill(state, index);
    for (let i = 0; i < 100_000; i++) reservoirStep(state);
    expect(state.geothermalFields[0].heat).toBeGreaterThan(0);
    expect(state.geothermalFields[0].heat).toBeLessThanOrEqual(1);
  });

  it('marks tiles dirty only when the quantised value changes', () => {
    const state = fieldMap();
    for (const index of [34, 35, 50]) drill(state, index);
    state.dirty.clear();
    reservoirStep(state);
    // One tick of drift is far below one 1/255 step.
    expect(state.dirty.size).toBe(0);
    for (let i = 0; i < 200; i++) reservoirStep(state);
    expect(state.dirty.size).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/sim/geothermal.test.ts -t fields`
Expected: FAIL — `discoverGeothermalFields` is not exported.

- [ ] **Step 3: Add the field type and discovery**

Append to `src/sim/geothermal.ts`:

```ts
/**
 * One hotspot cluster: the wells on its tiles share its heat. Derived
 * from the `geothermal` layer, never persisted — `heat` is restored from
 * the quantised `reservoirHeat` layer on load.
 */
export interface GeothermalField {
  tiles: number[];
  /** Hotspot quality 1..3, shared by every tile of the field. */
  quality: number;
  /** Wells the field sustains before its reservoir starts cooling. */
  capacity: number;
  /** Reservoir temperature 0..1; the authoritative, unquantised value. */
  heat: number;
}

/**
 * Recompute `state.geothermalFields` as connected components of the
 * hotspot layer. Call after generating a map and after loading a save.
 */
export function discoverGeothermalFields(state: SimState): void {
  const cfg = BALANCE.geothermal;
  const { geothermal, reservoirHeat } = state.layers;
  const seen = new Uint8Array(geothermal.length);
  const fields: GeothermalField[] = [];
  for (let start = 0; start < geothermal.length; start++) {
    if (geothermal[start] === 0 || seen[start] !== 0) continue;
    const tiles: number[] = [];
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const index = stack.pop()!;
      tiles.push(index);
      for (const n of neighbors4(index, state.size)) {
        if (geothermal[n] !== 0 && seen[n] === 0) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    const quality = geothermal[start];
    fields.push({
      tiles,
      quality,
      capacity: Math.max(
        1,
        Math.round(tiles.length * cfg.sustainablePerTile * cfg.qualityFactor[quality]),
      ),
      heat: reservoirHeat[start] / FULL_HEAT,
    });
  }
  state.geothermalFields = fields;
}

/** The field a tile belongs to, if any. */
export function fieldAt(state: SimState, index: number): GeothermalField | undefined {
  return state.geothermalFields.find((field) => field.tiles.includes(index));
}
```

- [ ] **Step 4: Add the reservoir step**

Append to `src/sim/geothermal.ts`:

```ts
/**
 * Advance every field's reservoir by one tick.
 *
 * `heat += recharge * (1 - heat) - drain * excessWells * heat`
 *
 * Up to `capacity` wells the field stays at heat 1. Beyond it the
 * temperature settles at `recharge / (recharge + drain * excess)` — a
 * lower equilibrium, never zero — and climbs back toward 1 as soon as the
 * excess wells are removed. Total field output (`wells * heat`) therefore
 * keeps rising with every well but flattens toward `recharge / drain`
 * well-equivalents: overdrilling wastes money, it never ruins a field.
 */
export function reservoirStep(state: SimState): void {
  const cfg = BALANCE.geothermal;
  const { tileType, plantType, reservoirHeat } = state.layers;
  for (const field of state.geothermalFields) {
    let wells = 0;
    for (const index of field.tiles) {
      if (tileType[index] === TileType.Plant && plantType[index] === PlantType.GeothermalPlant) {
        wells++;
      }
    }
    const excess = Math.max(0, wells - field.capacity);
    const next = field.heat + cfg.recharge * (1 - field.heat) - cfg.drain * excess * field.heat;
    field.heat = Math.min(1, Math.max(0, next));

    // The layer is only a quantised mirror for diffs, save and render; a
    // slow drift must not flood the diff channel every tick.
    const quantised = Math.round(field.heat * FULL_HEAT);
    if (reservoirHeat[field.tiles[0]] === quantised) continue;
    for (const index of field.tiles) {
      reservoirHeat[index] = quantised;
      markDirty(state, index);
    }
  }
}
```

Extend the imports at the top of the file:

```ts
import { PlantType, Terrain, TileType } from '../shared/types.ts';
```

- [ ] **Step 5: Add the field list to the state**

In `src/sim/state.ts`, import the type and add the property to `SimState` (next to the other transient derived data):

```ts
import type { GeothermalField } from './geothermal.ts';
```

```ts
  /** Hotspot fields, derived from the geothermal layer; never persisted. */
  geothermalFields: GeothermalField[];
```

In `createSimState`'s returned object, next to `vehicles: []`:

```ts
    geothermalFields: [],
```

In `src/sim/engine.ts`, after `generateGeothermal(this.state);`:

```ts
discoverGeothermalFields(this.state);
```

- [ ] **Step 6: Run the reservoir step every tick**

In `src/sim/tick.ts`, import `reservoirStep` and call it immediately before `energyStep`, so the census reads this tick's heat:

```ts
import { reservoirStep } from './geothermal.ts';
```

```ts
updateTrafficLoad(state, occupancy);
// Reservoirs first: this tick's generation reads the heat they leave.
reservoirStep(state);
energyStep(state, { chargingDemand: chargingDemand(state) });
```

- [ ] **Step 7: Run the tests**

Run: `pnpm vitest run src/sim/geothermal.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
pnpm format
git add src/sim/geothermal.ts src/sim/geothermal.test.ts src/sim/state.ts src/sim/engine.ts src/sim/tick.ts
git commit -m "feat(sim): heat reservoir per geothermal field"
```

---

### Task 4: Build rules

**Files:**

- Modify: `src/sim/state.ts:640-700` (`buildRejection`), `src/ui/i18n.tsx`
- Test: `src/sim/state.test.ts`

**Interfaces:**

- Consumes: `layers.geothermal` (Task 1).
- Produces: rejection reason `'needsHotspot'` for `PlantType.GeothermalPlant` off a hotspot.

- [ ] **Step 1: Write the failing test**

In `src/sim/state.test.ts`:

```ts
describe('geothermal build rules', () => {
  it('accepts a hotspot tile and rejects anything else', () => {
    const state = createSimState(5, 8);
    state.layers.geothermal[20] = 2;
    expect(buildRejection(state, 20, BuildIntent.Plant, PlantType.GeothermalPlant)).toBeNull();
    expect(buildRejection(state, 21, BuildIntent.Plant, PlantType.GeothermalPlant)).toBe(
      'needsHotspot',
    );
  });

  it('never lets a hotspot override water or slope rules', () => {
    const state = createSimState(5, 8);
    state.layers.geothermal[20] = 2;
    state.layers.terrain[20] = Terrain.Lake;
    expect(buildRejection(state, 20, BuildIntent.Plant, PlantType.GeothermalPlant)).toBe(
      'cannotBuildOnWater',
    );
  });

  it('leaves other plants unaffected by a hotspot', () => {
    const state = createSimState(5, 8);
    state.layers.geothermal[20] = 2;
    expect(buildRejection(state, 20, BuildIntent.Plant, PlantType.SolarFarm)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/sim/state.test.ts -t "geothermal build"`
Expected: FAIL — the second expectation returns `null` instead of `'needsHotspot'`.

- [ ] **Step 3: Add the rule**

In `src/sim/state.ts`, inside `buildRejection`, next to the other plant-site rules and **after** the water and slope checks (so water and steepness still win):

```ts
const wantsGeothermal = intent === BuildIntent.Plant && plant === PlantType.GeothermalPlant;
```

declared beside `wantsTidal`, and after the `tooSteep` check:

```ts
// Hot rock only: the well has to reach the reservoir underneath.
if (wantsGeothermal && layers.geothermal[index] === 0) return 'needsHotspot';
```

- [ ] **Step 4: Add the rejection text in both languages**

In `src/ui/i18n.tsx`, next to `reject.needsSeaTile`:

```ts
  'reject.needsHotspot': 'A geothermal plant needs a hotspot tile.',
```

```ts
  'reject.needsHotspot': 'Ein Geothermiekraftwerk braucht ein Hotspot-Feld.',
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run src/sim/state.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
pnpm format
git add src/sim/state.ts src/sim/state.test.ts src/ui/i18n.tsx
git commit -m "feat(sim): geothermal plants only on hotspot tiles"
```

---

### Task 5: Generation and stats

**Files:**

- Modify: `src/sim/energy.ts` (`PlantCensus`, `censusPlants`, `energyStep`), `src/sim/state.ts` (`lastEnergy`), `src/sim/tick.ts` (`buildStats`, `recordLifetime`)
- Test: `src/sim/energy.test.ts`

**Interfaces:**

- Consumes: `layers.geothermal`, `layers.reservoirHeat`, `BALANCE.energy.geothermalPeakOutput`.
- Produces: `census.geothermalPlants: number`, `census.geothermalCapacity: number`, `state.lastEnergy.geothermal: number`, `stats.energy.generation.geothermal: number`.

- [ ] **Step 1: Write the failing tests**

In `src/sim/energy.test.ts`:

```ts
describe('geothermal generation', () => {
  /** A map with one full-heat quality-2 hotspot carrying one plant. */
  function plantOnHotspot(): SimState {
    const state = createSimState(5, 16);
    state.layers.geothermal[40] = 2;
    state.layers.reservoirHeat[40] = 255;
    state.layers.tileType[40] = TileType.Plant;
    state.layers.plantType[40] = PlantType.GeothermalPlant;
    return state;
  }

  it('counts the plant with its quality and heat', () => {
    const census = censusPlants(plantOnHotspot());
    expect(census.geothermalPlants).toBe(1);
    // qualityFactor[2] = 1.0 at full heat.
    expect(census.geothermalCapacity).toBeCloseTo(1, 6);
  });

  it('scales with quality and with a cooled reservoir', () => {
    const state = plantOnHotspot();
    state.layers.geothermal[40] = 3;
    expect(censusPlants(state).geothermalCapacity).toBeCloseTo(1.3, 6);
    state.layers.reservoirHeat[40] = 128;
    expect(censusPlants(state).geothermalCapacity).toBeCloseTo(1.3 * (128 / 255), 6);
  });

  it('generates the same at midnight as at noon, in storm and in calm', () => {
    const outputs = [0, TICKS_PER_DAY / 2].flatMap((tick) =>
      [0, 1].map((cloudCover) => {
        const state = plantOnHotspot();
        state.tick = tick;
        state.weather.cloudCover = cloudCover;
        state.weather.windSpeed = cloudCover;
        energyStep(state, { chargingDemand: 0 });
        return state.lastEnergy.geothermal;
      }),
    );
    for (const output of outputs) {
      expect(output).toBeCloseTo(BALANCE.energy.geothermalPeakOutput, 6);
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/sim/energy.test.ts -t geothermal`
Expected: FAIL — `geothermalPlants` is not on the census.

- [ ] **Step 3: Extend the census**

In `src/sim/energy.ts`, add to `PlantCensus`:

```ts
geothermalPlants: number;
/** Sum of geothermal plants' quality factor × reservoir heat. */
geothermalCapacity: number;
```

initialise both to `0` in `censusPlants`, and add the case:

```ts
      case PlantType.GeothermalPlant:
        census.geothermalPlants++;
        census.geothermalCapacity +=
          BALANCE.geothermal.qualityFactor[layers.geothermal[i]] * (layers.reservoirHeat[i] / 255);
        break;
```

`censusPlants` currently destructures only `tileType` and `plantType`; widen that to `const { tileType, plantType, geothermal, reservoirHeat } = state.layers;` and use the local names.

- [ ] **Step 4: Add the generation term**

In `energyStep`, next to the other sources:

```ts
// Baseload: no weather, no daylight, no tide — only the reservoir.
const geothermal = census.geothermalCapacity * BALANCE.energy.geothermalPeakOutput;
```

add it to the sum:

```ts
const generation = solar + wind + rooftop + hydro + tidal + geothermal;
```

and to the `state.lastEnergy` assignment at the end of the step:

```ts
    geothermal,
```

Update the step's doc comment: `renewable generation (solar + wind + rooftop + hydro + tidal + geothermal)`.

- [ ] **Step 5: Plumb the stats**

`src/sim/state.ts` — add `geothermal: number;` to the `lastEnergy` type after `tidal` and `geothermal: 0,` to its initialiser.

`src/sim/tick.ts` — in `buildStats`, after `tidal: e.tidal,`:

```ts
        geothermal: e.geothermal,
```

and in `recordLifetime`:

```ts
sums.generation += e.solar + e.wind + e.rooftop + e.hydro + e.tidal + e.geothermal + e.biogas;
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run src/sim/energy.test.ts src/sim/integration.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
pnpm format
git add src/sim/energy.ts src/sim/energy.test.ts src/sim/state.ts src/sim/tick.ts
git commit -m "feat(sim): geothermal baseload generation"
```

---

### Task 6: Save compatibility

**Files:**

- Modify: `src/sim/state.ts` (`serializeState`, `deserializeState`), `src/storage/serialization.ts:125-131`
- Test: `src/storage/serialization.test.ts`, `src/sim/geothermal.test.ts`

**Interfaces:**

- Consumes: `discoverGeothermalFields`, `generateGeothermal` (Tasks 2-3).
- Produces: both layers in `SaveGame.layers`; old saves regenerate their hotspots.

- [ ] **Step 1: Write the failing tests**

In `src/storage/serialization.test.ts`, next to the forest round-trip test:

```ts
it('round-trips the optional geothermal layers', () => {
  const save = makeSave();
  const geothermal = new Uint8Array(save.size * save.size).fill(3);
  const heat = new Uint8Array(save.size * save.size).fill(120);
  save.layers.geothermal = geothermal.buffer as ArrayBuffer;
  save.layers.reservoirHeat = heat.buffer as ArrayBuffer;
  const restored = saveFromJson(saveToJson(save));
  expect(new Uint8Array(restored.layers.geothermal!)).toEqual(geothermal);
  expect(new Uint8Array(restored.layers.reservoirHeat!)).toEqual(heat);
  expect(saveFromJson(saveToJson(makeSave())).layers.geothermal).toBeUndefined();
});
```

In `src/sim/geothermal.test.ts`:

```ts
describe('geothermal save compatibility', () => {
  it('restores fields and heat from a save', () => {
    const state = fieldMap();
    state.geothermalFields[0].heat = 0.5;
    state.layers.reservoirHeat.fill(0);
    for (const index of state.geothermalFields[0].tiles) {
      state.layers.reservoirHeat[index] = Math.round(0.5 * FULL_HEAT);
    }
    const restored = deserializeState(serializeState(state));
    expect(restored.geothermalFields).toHaveLength(1);
    expect(restored.geothermalFields[0].heat).toBeCloseTo(0.5, 2);
    expect(restored.geothermalFields[0].capacity).toBe(2);
  });

  it('regenerates hotspots for a save written before the feature', () => {
    const fresh = mapWithHotspots(21);
    const save = serializeState(fresh);
    delete save.layers.geothermal;
    delete save.layers.reservoirHeat;
    const restored = deserializeState(save);
    expect([...restored.layers.geothermal]).toEqual([...fresh.layers.geothermal]);
    expect(restored.geothermalFields.every((field) => field.heat === 1)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/storage/serialization.test.ts src/sim/geothermal.test.ts -t save`
Expected: FAIL — the layers are not serialised.

- [ ] **Step 3: Persist both layers**

`src/sim/state.ts`, in `serializeState`'s `layers` object:

```ts
      geothermal: copyBuffer(layers.geothermal),
      reservoirHeat: copyBuffer(layers.reservoirHeat),
```

In `deserializeState`, after the forest restore and **before** `state.lakeLevel = computeLakeLevel(state);`:

```ts
if (save.layers.geothermal) {
  state.layers.geothermal.set(new Uint8Array(save.layers.geothermal));
  if (save.layers.reservoirHeat) {
    state.layers.reservoirHeat.set(new Uint8Array(save.layers.reservoirHeat));
  } else {
    // A half-old save: hotspots but no reservoir — start them full.
    for (let i = 0; i < state.layers.geothermal.length; i++) {
      if (state.layers.geothermal[i] !== 0) state.layers.reservoirHeat[i] = FULL_HEAT;
    }
  }
} else {
  // Saves from before geothermal: the generator is a pure function of
  // seed, terrain and elevation, all of which this save carries, so the
  // city gains exactly the hotspots a fresh map of this seed would have.
  generateGeothermal(state);
}
discoverGeothermalFields(state);
```

Import both from `./geothermal.ts`. If that creates an import cycle (`geothermal.ts` imports `state.ts`), keep the type-only import of `GeothermalField` as `import type` — TypeScript erases it — and import the functions normally; the cycle is resolved at runtime because neither module touches the other at module scope. Verify with `pnpm test` that no test logs a circular-import warning.

- [ ] **Step 4: Accept the layers in the JSON export**

`src/storage/serialization.ts`, extend `optionalLayers`:

```ts
const optionalLayers = [
  'terrain',
  'powerLine',
  'elevation',
  'roadClass',
  'busStop',
  'forest',
  'geothermal',
  'reservoirHeat',
] as const;
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run src/storage src/sim/geothermal.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
pnpm format
git add src/sim/state.ts src/sim/geothermal.test.ts src/storage
git commit -m "feat(sim): persist geothermal hotspots and reservoir heat"
```

---

### Task 7: Tile inspector data and the city goal

**Files:**

- Modify: `src/sim/inspect.ts`, `src/sim/goals.ts`, `src/sim/state.ts` (`goalProgress`), `src/shared/types.ts` (`TileInfo`)
- Test: `src/sim/inspect.test.ts`, `src/sim/goals.test.ts`

**Interfaces:**

- Consumes: `fieldAt` (Task 3), `census.geothermalCapacity` (Task 5).
- Produces: `TileInfo.hotspot?: { quality: number; heat: number; wells: number; capacity: number }`; `GoalId` `'geothermalBaseload'`; `state.goalProgress.geothermalTicks: number`.

- [ ] **Step 1: Write the failing tests**

In `src/sim/inspect.test.ts`:

```ts
it('reports the hotspot and its field on a hotspot tile', () => {
  const state = createSimState(3, 16);
  for (const index of [34, 35, 50, 51]) {
    state.layers.geothermal[index] = 2;
    state.layers.reservoirHeat[index] = 204; // 80 %
  }
  discoverGeothermalFields(state);
  state.layers.tileType[34] = TileType.Plant;
  state.layers.plantType[34] = PlantType.GeothermalPlant;

  const info = inspectTile(state, 35);
  expect(info.hotspot).toEqual({ quality: 2, heat: 204 / 255, wells: 1, capacity: 2 });
  expect(inspectTile(state, 0).hotspot).toBeUndefined();
});

it('shows a geothermal plant generating at its quality and heat', () => {
  const state = createSimState(3, 16);
  state.layers.geothermal[34] = 3;
  state.layers.reservoirHeat[34] = 255;
  discoverGeothermalFields(state);
  state.layers.tileType[34] = TileType.Plant;
  state.layers.plantType[34] = PlantType.GeothermalPlant;
  const info = inspectTile(state, 34);
  expect(info.generation).toBeCloseTo(BALANCE.energy.geothermalPeakOutput * 1.3, 6);
  expect(info.peak).toBeCloseTo(BALANCE.energy.geothermalPeakOutput * 1.3, 6);
});
```

In `src/sim/goals.test.ts`:

```ts
it('achieves the baseload goal after a day at share', () => {
  const state = createSimState(3, 16);
  state.lastEnergy.geothermal = 30;
  state.lastEnergy.solar = 70;
  for (let i = 0; i < TICKS_PER_DAY; i++) goalsStep(state);
  expect(state.goalsAchieved.has('geothermalBaseload')).toBe(true);
});

it('does not achieve it below the share', () => {
  const state = createSimState(3, 16);
  state.lastEnergy.geothermal = 5;
  state.lastEnergy.solar = 95;
  for (let i = 0; i < TICKS_PER_DAY * 2; i++) goalsStep(state);
  expect(state.goalsAchieved.has('geothermalBaseload')).toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/sim/inspect.test.ts src/sim/goals.test.ts -t geothermal`
Expected: FAIL — `hotspot` is not on `TileInfo`; `'geothermalBaseload'` is not a `GoalId`.

- [ ] **Step 3: Report the hotspot from the inspector**

In `src/shared/types.ts`, add to `TileInfo`:

```ts
  /** Present on a hotspot tile: the field this tile belongs to. */
  hotspot?: {
    /** Hotspot quality 1..3. */
    quality: number;
    /** Reservoir temperature 0..1. */
    heat: number;
    /** Wells currently drilled into this field. */
    wells: number;
    /** Wells the field sustains before it starts cooling. */
    capacity: number;
  };
```

In `src/sim/inspect.ts`, add the plant's generation case next to the tidal one:

```ts
    case PlantType.GeothermalPlant: {
      const factor =
        BALANCE.geothermal.qualityFactor[layers.geothermal[index]] *
        (layers.reservoirHeat[index] / 255);
      return {
        generation: e.geothermalPeakOutput * factor,
        // A geothermal plant is always at its peak — the peak is what moves.
        peak: e.geothermalPeakOutput * factor,
      };
    }
```

and build the `hotspot` block in the returned object:

```ts
const field = fieldAt(state, index);
const hotspot = field
  ? {
      quality: field.quality,
      heat: field.heat,
      wells: field.tiles.filter(
        (tile) =>
          layers.tileType[tile] === TileType.Plant &&
          layers.plantType[tile] === PlantType.GeothermalPlant,
      ).length,
      capacity: field.capacity,
    }
  : undefined;
```

added to the returned object as `...(hotspot ? { hotspot } : {}),`.

- [ ] **Step 4: Add the goal**

`src/sim/state.ts` — add `geothermalTicks: 0,` to `goalProgress` and `geothermalTicks: number;` to its type.

`src/sim/goals.ts` — add `'geothermalBaseload'` to `GOAL_IDS`, and:

```ts
/** Share of generation that must come from geothermal for the goal. */
const GEOTHERMAL_SHARE = 0.15;
```

In `goalsStep`:

```ts
const e = state.lastEnergy;
const generation = e.solar + e.wind + e.rooftop + e.hydro + e.tidal + e.geothermal + e.biogas;
if (generation > 0 && e.geothermal / generation >= GEOTHERMAL_SHARE) {
  progress.geothermalTicks++;
} else {
  progress.geothermalTicks = 0;
}
if (!achieved.has('geothermalBaseload') && progress.geothermalTicks >= TICKS_PER_DAY) {
  achieved.add('geothermalBaseload');
}
```

The counter is a streak, so it is not persisted — like `cleanDayTicks`, a reload restarts the day.

- [ ] **Step 5: Add the goal strings in both languages**

`src/ui/i18n.tsx`, next to the tidal goal:

```ts
  'goal.geothermalBaseload.title': 'Baseload',
  'goal.geothermalBaseload.body': 'Cover 15 % of your generation from geothermal for a full day.',
```

```ts
  'goal.geothermalBaseload.title': 'Grundlast',
  'goal.geothermalBaseload.body':
    'Decke einen ganzen Tag lang 15 % deiner Erzeugung mit Geothermie.',
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run src/sim/inspect.test.ts src/sim/goals.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
pnpm format
git add src/sim/inspect.ts src/sim/inspect.test.ts src/sim/goals.ts src/sim/goals.test.ts src/sim/state.ts src/shared/types.ts src/ui/i18n.tsx
git commit -m "feat(sim): inspect hotspots and a baseload goal"
```

---

### Task 8: Rendering

**Files:**

- Create: `src/render/geothermalMesh.ts`
- Modify: `src/render/plantsMesh.ts`, `src/render/minimapLayer.ts`, `src/render/renderer.ts:188-195`
- Test: `src/render/geothermalMesh.test.ts`

**Interfaces:**

- Consumes: `TileDiff.geothermal`, `TileDiff.reservoirHeat` (Task 1); `ElevationField`, `DiffLayer`, `RenderEnvironment` (existing).
- Produces: `class GeothermalMesh implements DiffLayer` with `constructor(scene, gridSize, elevation)`.

- [ ] **Step 1: Write the failing test**

Create `src/render/geothermalMesh.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { TileDiff } from '../shared/types.ts';
import { ElevationField } from './elevationField.ts';
import { GeothermalMesh } from './geothermalMesh.ts';

const SIZE = 8;

function sceneWith(diffs: TileDiff[]): { steam: THREE.InstancedMesh; cones: THREE.InstancedMesh } {
  const scene = new THREE.Scene();
  const field = new ElevationField(SIZE);
  field.applyDiffs(diffs);
  const mesh = new GeothermalMesh(scene, SIZE, field);
  mesh.applyDiffs(diffs);
  mesh.update(0.25, 0);
  const instanced = scene.children.filter(
    (child): child is THREE.InstancedMesh => child instanceof THREE.InstancedMesh,
  );
  return { cones: instanced[0], steam: instanced[1] };
}

function tiles(hotspots: Record<number, number>): TileDiff[] {
  return Array.from({ length: SIZE * SIZE }, (_, index) => ({
    index,
    elevation: 0,
    geothermal: hotspots[index] ?? 0,
    reservoirHeat: hotspots[index] ? 255 : 0,
  })) as TileDiff[];
}

describe('geothermal mesh', () => {
  it('draws one fumarole per hotspot tile and nothing elsewhere', () => {
    const { cones, steam } = sceneWith(tiles({ 9: 2, 10: 2 }));
    expect(cones.count).toBe(2);
    expect(steam.count).toBe(2);
    expect(cones.frustumCulled).toBe(false);
    expect(steam.frustumCulled).toBe(false);
  });

  it('draws nothing on a map without hotspots', () => {
    const { cones } = sceneWith(tiles({}));
    expect(cones.count).toBe(0);
  });

  it('fades the steam with the reservoir', () => {
    const hot = sceneWith(tiles({ 9: 2 }));
    const cold: TileDiff[] = tiles({ 9: 2 }).map((diff) =>
      diff.index === 9 ? { ...diff, reservoirHeat: 20 } : diff,
    );
    const cooled = sceneWith(cold);
    expect(cooled.steam.material).toBeDefined();
    // Opacity is carried per instance in the alpha of the instance colour.
    const hotColor = new THREE.Color();
    const coldColor = new THREE.Color();
    hot.steam.getColorAt(0, hotColor);
    cooled.steam.getColorAt(0, coldColor);
    expect(coldColor.r).toBeLessThan(hotColor.r);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/render/geothermalMesh.test.ts`
Expected: FAIL — cannot resolve `./geothermalMesh.ts`.

- [ ] **Step 3: Write the mesh**

Create `src/render/geothermalMesh.ts`, following `forestMesh.ts`:

```ts
import * as THREE from 'three';
import type { TileDiff } from '../shared/types.ts';
import type { ElevationField } from './elevationField.ts';
import type { DiffLayer, RenderEnvironment } from './renderer.ts';

/** Fumarole cone: a small vent cone sitting on the ground. */
const CONE_RADIUS = 0.16;
const CONE_HEIGHT = 0.12;
const CONE_COLOR = 0x8c5a3c;
/** Steam plume above the vent. */
const STEAM_SIZE = 0.3;
const STEAM_HEIGHT = 0.45;
const STEAM_COLOR = new THREE.Color(0xe8eef0);
const STEAM_RISE_SPEED = 0.35;
const NIGHT_DIM = 0.45;

/**
 * Hotspots: a vent cone per hotspot tile with a steam plume that drifts
 * upward. The plume's brightness follows the field's reservoir heat, so a
 * cooled field visibly stops steaming — the mechanic is readable from the
 * map, not only from the inspector.
 */
export class GeothermalMesh implements DiffLayer {
  private readonly cones: THREE.InstancedMesh;
  private readonly steam: THREE.InstancedMesh;
  private readonly steamMaterial: THREE.MeshBasicMaterial;
  /** Tile index -> quantised reservoir heat, for every hotspot tile. */
  private readonly hotspots = new Map<number, number>();
  private readonly gridSize: number;
  private readonly matrix = new THREE.Matrix4();
  private nightFactor = 0;
  private reducedMotion = false;

  constructor(
    scene: THREE.Scene,
    gridSize: number,
    private readonly elevation: ElevationField,
  ) {
    this.gridSize = gridSize;
    const tiles = gridSize * gridSize;

    this.cones = new THREE.InstancedMesh(
      new THREE.ConeGeometry(CONE_RADIUS, CONE_HEIGHT, 6),
      new THREE.MeshLambertMaterial({ color: CONE_COLOR }),
      tiles,
    );
    // Instance transforms span the whole grid; the base geometry's bounds
    // would wrongly cull the mesh, so culling is disabled.
    this.cones.frustumCulled = false;
    this.cones.count = 0;
    scene.add(this.cones);

    this.steamMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    this.steam = new THREE.InstancedMesh(
      new THREE.SphereGeometry(STEAM_SIZE / 2, 8, 6),
      this.steamMaterial,
      tiles,
    );
    this.steam.frustumCulled = false;
    this.steam.count = 0;
    scene.add(this.steam);
  }

  applyDiffs(diffs: TileDiff[]): void {
    let changed = false;
    for (const diff of diffs) {
      const previous = this.hotspots.get(diff.index);
      if (diff.geothermal === 0) {
        if (previous !== undefined) {
          this.hotspots.delete(diff.index);
          changed = true;
        }
        continue;
      }
      if (previous !== diff.reservoirHeat) {
        this.hotspots.set(diff.index, diff.reservoirHeat);
        changed = true;
      }
    }
    if (changed) this.rebuild(0);
  }

  setEnvironment(environment: RenderEnvironment): void {
    this.nightFactor = environment.nightFactor;
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
  }

  update(_deltaSeconds: number, nowSeconds: number): void {
    this.rebuild(this.reducedMotion ? 0 : nowSeconds);
  }

  /** Place every vent and its plume; `time` drives the plume's rise. */
  private rebuild(time: number): void {
    const color = new THREE.Color();
    let count = 0;
    for (const [index, heat] of this.hotspots) {
      const x = (index % this.gridSize) + 0.5;
      const z = Math.floor(index / this.gridSize) + 0.5;
      const groundY = this.elevation.centerY(index);

      this.matrix.makeScale(1, 1, 1);
      this.matrix.setPosition(x, groundY + CONE_HEIGHT / 2, z);
      this.cones.setMatrixAt(count, this.matrix);

      // The plume loops from the vent upward and fades as it climbs.
      const phase = (time * STEAM_RISE_SPEED + index * 0.37) % 1;
      const scale = 0.6 + phase * 0.8;
      this.matrix.makeScale(scale, scale, scale);
      this.matrix.setPosition(x, groundY + CONE_HEIGHT + phase * STEAM_HEIGHT, z);
      this.steam.setMatrixAt(count, this.matrix);

      // Brightness carries both the reservoir heat and the plume's fade,
      // dimmed at night like the other environment-driven layers.
      const strength = (heat / 255) * (1 - phase * 0.6) * (1 - NIGHT_DIM * this.nightFactor);
      this.steam.setColorAt(count, color.copy(STEAM_COLOR).multiplyScalar(strength));
      count++;
    }
    this.cones.count = count;
    this.cones.instanceMatrix.needsUpdate = true;
    this.steam.count = count;
    this.steam.instanceMatrix.needsUpdate = true;
    if (this.steam.instanceColor) this.steam.instanceColor.needsUpdate = true;
  }
}
```

- [ ] **Step 4: Add the plant shape and the minimap colour**

`src/render/plantsMesh.ts` — new colours next to the tidal ones:

```ts
  geoHall: 0x6b5f57,
  geoTower: 0xd7d2c8,
  geoWellhead: 0xb5482f,
```

and the part list next to `case PlantType.TidalPlant:`:

```ts
    case PlantType.GeothermalPlant:
      return [
        // Turbine hall, a wellhead stub and the cooling tower above it.
        { sx: 0.6, sy: 0.24, sz: 0.4, ox: -0.08, oy: 0, oz: 0.1, color: COLORS.geoHall },
        { sx: 0.12, sy: 0.3, sz: 0.12, ox: 0.28, oy: 0, oz: -0.22, color: COLORS.geoWellhead },
        { sx: 0.3, sy: 0.5, sz: 0.3, ox: 0.2, oy: 0, oz: 0.22, color: COLORS.geoTower },
      ];
```

`src/render/minimapLayer.ts` — in the plant colour table:

```ts
    [PlantType.GeothermalPlant]: '#b5482f',
```

- [ ] **Step 5: Register the layer**

`src/render/renderer.ts`, next to the forest layer (hotspots sit on the ground, so they go before roads and plants):

```ts
this.addDiffLayer(new GeothermalMesh(scene, gridSize, this.elevation));
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run src/render && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
pnpm format
git add src/render
git commit -m "feat(render): fumaroles, steam and the geothermal plant"
```

---

### Task 9: Tool, panels and help

**Files:**

- Modify: `src/ui/useTools.ts:29,42-66,73-88`, `src/ui/BuildBar.tsx:69`, `src/ui/EnergyPanel.tsx:84,109-111`, `src/ui/TileInspector.tsx`, `src/ui/i18n.tsx`
- Test: `src/ui/useTools.test.ts`

**Interfaces:**

- Consumes: `PlantType.GeothermalPlant` (Task 1), `TileInfo.hotspot` (Task 7), `stats.energy.generation.geothermal` (Task 5).
- Produces: tool id `'plant-geothermal'` on hotkey `e`.

- [ ] **Step 1: Write the failing test**

`src/ui/useTools.test.ts` already asserts that every entry of `PLANT_BY_TOOL` has a hotkey. Add the tool-specific check:

```ts
it('binds the geothermal plant to E', () => {
  expect(TOOL_HOTKEYS.e).toBe('plant-geothermal');
  expect(PLANT_BY_TOOL['plant-geothermal']).toBe(PlantType.GeothermalPlant);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/ui/useTools.test.ts`
Expected: FAIL — `TOOL_HOTKEYS.e` is `undefined`.

- [ ] **Step 3: Add the tool**

`src/ui/useTools.ts` — add `| 'plant-geothermal'` to `ToolId`, `e: 'plant-geothermal',` to `TOOL_HOTKEYS`, and `'plant-geothermal': PlantType.GeothermalPlant,` to `PLANT_BY_TOOL`.

`src/ui/BuildBar.tsx` — in the energy category, after the tidal entry:

```ts
      { id: 'plant-geothermal', icon: '♨️', cost: BALANCE.costs.plant[PlantType.GeothermalPlant] },
```

- [ ] **Step 4: Show the generation and the reservoir**

`src/ui/EnergyPanel.tsx` — add `energy.generation.geothermal` to the generation total on line 84 and a row next to the tidal one:

```tsx
<DetailRow
  label={t('energy.geothermal')}
  value={energy.generation.geothermal}
  testId="detail-energy-geothermal"
/>
```

`src/ui/TileInspector.tsx` — render two rows with the file's own `Row` component (`label`, `value`, optional `hint`/`tone`/`testId`) when `info.hotspot` is present, in the terrain section:

```tsx
{
  info.hotspot && (
    <>
      <Row
        label={t('inspect.hotspot')}
        value={`${t('inspect.hotspotQuality')} ${info.hotspot.quality} · ${Math.round(
          info.hotspot.heat * 100,
        )} %`}
        hint={t('inspect.hotspotHint')}
        testId="inspect-hotspot"
      />
      <Row
        label={t('inspect.hotspotWells')}
        value={`${info.hotspot.wells} / ${info.hotspot.capacity}`}
        tone={info.hotspot.wells > info.hotspot.capacity ? 'negative' : 'muted'}
        testId="inspect-hotspot-wells"
      />
    </>
  );
}
```

- [ ] **Step 5: Add every string in both languages**

`src/ui/i18n.tsx` — English:

```ts
  'energy.geothermal': '♨️ Geothermal',
  'inspect.hotspot': 'Geothermal hotspot',
  'inspect.hotspotQuality': 'Quality',
  'inspect.hotspotWells': 'Wells / sustainable',
  'inspect.hotspotHint': 'Hotspot quality and the reservoir temperature of its field.',
  'tool.plant-geothermal.desc':
    'Drilled into a geothermal hotspot. It generates the same amount day and night, in any weather ' +
    'and any season — the only true baseload in the city. Each field sustains a limited number of ' +
    'wells; drill more and its reservoir cools over days, dragging every well on it down until you ' +
    'take the load off again.',
```

German:

```ts
  'energy.geothermal': '♨️ Geothermie',
  'inspect.hotspot': 'Geothermie-Hotspot',
  'inspect.hotspotQuality': 'Ergiebigkeit',
  'inspect.hotspotWells': 'Bohrungen / nachhaltig',
  'inspect.hotspotHint': 'Ergiebigkeit des Hotspots und Reservoirtemperatur seines Feldes.',
  'tool.plant-geothermal.desc':
    'Wird in einen Geothermie-Hotspot gebohrt. Erzeugt Tag und Nacht, bei jedem Wetter und in jeder ' +
    'Jahreszeit gleich viel — die einzige echte Grundlast der Stadt. Jedes Feld trägt nur eine ' +
    'begrenzte Zahl Bohrungen; bohrst du mehr hinein, kühlt das Reservoir über Tage aus und zieht ' +
    'alle Anlagen darauf mit, bis du die Last wieder wegnimmst.',
```

Extend the help page's energy paragraph (`i18n.tsx:220` in English and its German counterpart) with one sentence on geothermal baseload and the reservoir.

- [ ] **Step 6: Run the tests and the e2e suite**

Run: `pnpm vitest run src/ui && pnpm typecheck && pnpm lint`
Expected: PASS. (The WebGL e2e test needs the Mac or CI; this sandbox has no WebGL.)

- [ ] **Step 7: Commit**

```bash
pnpm format
git add src/ui
git commit -m "feat(ui): geothermal plant tool, reservoir readout and help"
```

---

### Task 10: Agent tools and docs

**Files:**

- Modify: `src/agent/tools.ts:85-91,135-160,166-180,338-360`, `docs/agent-tools.md`
- Test: `src/agent/tools.test.ts`

**Interfaces:**

- Consumes: everything from Tasks 1-7.
- Produces: `PLANT_NAMES.geothermal`, find kind `'geothermal_hotspot'`, tile glyph `G`.

- [ ] **Step 1: Write the failing tests**

In `src/agent/tools.test.ts`:

The file drives the tools through its own `createHarness()` helper, which returns `{ engine, call }` where `call(name, input)` runs one tool by name. Follow that shape:

```ts
it('builds a geothermal plant on a hotspot and rejects it elsewhere', async () => {
  const { engine, call } = createHarness();
  const hotspot = tileIndex(6, 6, SIZE);
  engine.state.layers.geothermal[hotspot] = 2;
  engine.state.layers.reservoirHeat[hotspot] = 255;
  discoverGeothermalFields(engine.state);
  engine.tick(); // let the diff reach the tile mirror

  const built = await call('place_plant', { plant: 'geothermal', x: 6, y: 6 });
  expect(built.rejected).toBeUndefined();
  const refused = await call('place_plant', { plant: 'geothermal', x: 1, y: 1 });
  expect(refused.rejected).toBe('needsHotspot');
});

it('finds geothermal hotspots', async () => {
  const { engine, call } = createHarness();
  engine.state.layers.geothermal[tileIndex(6, 6, SIZE)] = 2;
  engine.tick();
  const found = await call('find_tiles', { kind: 'geothermal_hotspot' });
  expect(found.tiles).toContainEqual({ x: 6, y: 6 });
});
```

Check the exact key names (`plant` vs `type`, the `find_tiles` result shape) against the neighbouring `place_plant` and `find_tiles` tests in that file before writing — those tests are the contract.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/agent/tools.test.ts -t geothermal`
Expected: FAIL — `'geothermal'` is not a plant name.

- [ ] **Step 3: Extend the tools**

`src/agent/tools.ts`:

```ts
  geothermal: PlantType.GeothermalPlant,
```

in `PLANT_NAMES`, plus the matching entries:

```ts
  geothermal: 'tool.plant-geothermal',
```

```ts
  geothermal:
    'an empty land tile carrying a geothermal hotspot; constant output, but a field only sustains so many wells before its reservoir cools',
```

Add `'geothermal_hotspot'` to the find kinds with a predicate mirroring `isCoastalSeaTile`:

```ts
/** True on a tile that carries a geothermal hotspot. */
function isHotspotTile(tiles: TileMirror, index: number): boolean {
  return tiles.geothermal[index] !== 0;
}
```

and the glyph `geothermal: 'G',` in the plant glyph table.

The tile mirror must carry the new layer. In `src/agent/tileMirror.ts`, add it beside the other `readonly … : Uint8Array` fields, allocate it in the constructor and copy it in `applyDiffs` exactly as `terrain` is handled:

```ts
  readonly geothermal: Uint8Array;
```

```ts
this.geothermal[diff.index] = diff.geothermal;
```

Then mark hotspots in the `terrain` map layer (a `~` for water, so use `^` for a hotspot tile) and document the glyph in the layer legend that tool returns.

- [ ] **Step 4: Update the docs**

`docs/agent-tools.md` — add the `geothermal` row to the plant table (cost, placement rule, output behaviour), the `geothermal_hotspot` find kind, and the `G` glyph to the map legend.

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run src/agent`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
pnpm format
git add src/agent docs/agent-tools.md
git commit -m "feat(agent): expose geothermal plants and hotspots"
```

---

### Task 11: Balance with a headless probe

**Files:**

- Create (temporary): `scripts/probe-geothermal.mjs`
- Modify: `src/shared/constants.ts`, `docs/idea.md`

**Interfaces:**

- Consumes: the finished feature.
- Produces: tuned `BALANCE.geothermal` and `BALANCE.energy.geothermalPeakOutput`; the probe is deleted again.

- [ ] **Step 1: Write the probe**

Create `scripts/probe-geothermal.mjs`, scripting a city through `SimEngine` the way the deleted `scripts/probe-tidal.mjs` did (see the commit "balance: tune tidal power from the headless probe" for the pattern). It must print, over ~20 in-game days:

- per-source generation shares (solar, wind, rooftop, hydro, tidal, geothermal, biogas),
- the reservoir curve of one overdrilled field, tick by day,
- total output of a field at 1, 2, 3 and 4 wells once settled.

- [ ] **Step 2: Run it and read the numbers**

Run: `node scripts/probe-geothermal.mjs`
Expected targets:

- A fully developed field is a meaningful but not dominating share of a mid-game mix — in the ballpark of the tidal and hydro shares, not above their sum.
- A four-well field on a four-tile, two-well field settles near 2.5 well-equivalents, not 4.
- One excess well settles near 77 % heat, with the bulk of the drop inside the first one and a half in-game days.

- [ ] **Step 3: Tune the constants**

Adjust `geothermalPeakOutput`, `costs.plant[PlantType.GeothermalPlant]`, `recharge` and `drain` in `src/shared/constants.ts` until the probe hits those targets. Record the measured numbers in the comments next to each value, the way `tidalPeakOutput` documents its probe.

- [ ] **Step 4: Re-run the full suite**

Run: `pnpm test && pnpm coverage`
Expected: PASS, and the sim/shared coverage gate (≥90 %) still holds.

- [ ] **Step 5: Delete the probe and close the backlog entry**

Remove `scripts/probe-geothermal.mjs`. In `docs/idea.md`, mark the geothermal backlog entry as done with a one-line summary, following the style of the hydrogen, market, forest and sea entries.

- [ ] **Step 6: Commit**

```bash
pnpm format
git add src/shared/constants.ts docs/idea.md
git commit -m "balance: tune geothermal power from the headless probe"
```

---

## Notes for the executor

- **No WebGL in the Linux sandbox.** Render changes are verified by the headless three.js tests and `node scripts/smoke.mjs`; the visual pass and the WebGL e2e test need the Mac or CI.
- **Import cycle watch.** `geothermal.ts` imports from `state.ts` and `state.ts` imports `geothermal.ts` back (Task 6). Keep `GeothermalField` a `import type` in `state.ts` and never call geothermal functions at module scope.
- **`fieldAt` is a linear scan** over a handful of fields with a handful of tiles each — fine for the inspector, which runs once per selected tile. Do not call it inside a per-tile loop.
- **Determinism.** Every random draw in `geothermal.ts` goes through the salted `Rng`; never use `Math.random()`. The generation tests compare whole layers across two runs of the same seed.
- **No new graph series.** `EnergyHistoryPoint` stores aggregate generation per sample, so geothermal appears inside the graph's total line and gets a breakdown row in the panel instead. Per-source history series would change the save-relevant history format and are deliberately out of scope (the spec's Energy section says so).
