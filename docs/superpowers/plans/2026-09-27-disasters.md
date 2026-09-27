# Disasters & Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Voltopia storms, fires and river floods that damage the
city's assets, announce themselves where the weather allows it, and are
repaired automatically against money over time.

**Architecture:** One generic lifecycle in `src/sim/disasters.ts` (risk →
warning → active event → tile damage → paid repair) driving three
kind-specific modules (`storm.ts`, `fire.ts`, `flood.ts`) that each
contribute a risk function, a planning function and a per-tick apply
function through a `DisasterSpec` interface. A new `damage` tile layer
(Uint8, 0..255) carries the repairable state; it gates generation, grid
conduction, station coverage and building operation, travels to the
renderer as a tile diff, and is saved as an optional layer.

**Tech Stack:** TypeScript (strict), Vitest, React 19, three.js, pnpm.

**Spec:** `docs/superpowers/specs/2026-09-27-disasters-design.md`

## Global Constraints

- `src/sim/` stays pure: no DOM, no three.js imports. All randomness goes
  through `state.rng` (the seeded `Rng`).
- No magic numbers in sim code: every tuning value lives in
  `BALANCE` (`src/shared/constants.ts`).
- `SAVE_VERSION` stays **1**. `damage`, `disasters` and `disasterScale`
  are optional save fields; a save without them loads intact, with no
  damage, no events and `disasterScale = 0`.
- Every user-visible string goes through `src/ui/i18n.tsx` in **both**
  English and German.
- Roads are never damaged. No event writes damage to a road tile, and
  nothing in routing, vehicles, deliveries or transit reads `damage`.
- Coverage gate ≥ 90 % on `src/sim` (`pnpm coverage`).
- Every new `InstancedMesh` sets `frustumCulled = false`.
- Run `pnpm format` (oxfmt) after edits; the pre-commit hook runs
  `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`.
- Correct energy terminology (generation, consumption, state of charge,
  curtailment, peak load) in code and UI.

### Deviation from the spec, decided while planning

The spec describes a storm's hits as falling "in a rolled band across the
map". A band needs its axis and offset persisted on the event for no
gameplay gain — the storm is global either way (the cut-out hits every
turbine on the map). This plan therefore draws a storm's per-tick hits
from a **city-wide weighted pool** of vulnerable tiles (pylons and
turbines weigh heaviest, buildings least) and keeps `origin` as the first
tile struck, for the minimap marker. Everything else follows the spec.

---

## File Structure

**Created:**

| File                              | Responsibility                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------ |
| `src/sim/disasters.ts`            | The lifecycle: `DisasterSpec`, `disastersStep`, `repairStep`, damage helpers, stats export |
| `src/sim/disasters.test.ts`       | Lifecycle, cooldown, intensity, repair, save round trip                                    |
| `src/sim/storm.ts`                | Storm risk, gust, city-wide strikes                                                        |
| `src/sim/storm.test.ts`           | Cut-out, line damage islanding a district                                                  |
| `src/sim/fire.ts`                 | Fire risk, ignition sites, spread, extinguishing                                           |
| `src/sim/fire.test.ts`            | Spread, firebreaks, coverage, woodland                                                     |
| `src/sim/flood.ts`                | Flood risk, the computed floodplain, depth damage                                          |
| `src/sim/flood.test.ts`           | Area determinism, monotony, terrain untouched                                              |
| `src/render/disasterMesh.ts`      | Damage decals, fire embers and smoke, flood film                                           |
| `src/render/disasterMesh.test.ts` | Instance counts per state (no WebGL needed)                                                |
| `src/ui/DisasterBanner.tsx`       | Warning banner with countdown, impact toast                                                |

**Modified:** `src/shared/types.ts` (disaster types, `TileDiff.damage`,
`GlobalStats.disasters`, `BudgetStats.repair`, `TileInfo.damage`,
`SaveGame` fields, `OverlayMode.Damage`), `src/shared/constants.ts`
(`BALANCE.disasters`, `BALANCE.energy.windCutOutSpeed`),
`src/shared/messages.ts` (`init.disasterScale`), `src/sim/state.ts`
(layer, state, undo, save/load), `src/sim/weather.ts` (cut-out, gust),
`src/sim/energy.ts` (census and consumption gating),
`src/sim/powerGrid.ts` (conduction gating), `src/sim/services.ts`
(coverage gating), `src/sim/happiness.ts` (penalties),
`src/sim/roads.ts` (bulldoze clears damage, undo restores it),
`src/sim/goals.ts` (`stormProof`), `src/sim/inspect.ts` (damage fields),
`src/sim/tick.ts` (wiring, stats), `src/sim/engine.ts` (init),
`src/storage/serialization.ts` (JSON export/import), `src/agent/tools.ts`

- `src/agent/tileMirror.ts` (tools), `src/render/renderer.ts`,
  `src/render/overlays.ts`, `src/ui/App.tsx`, `src/ui/OverlayToggle.tsx`,
  `src/ui/NewGamePage.tsx`, `src/ui/newGame.ts`, `src/ui/BudgetPanel.tsx`,
  `src/ui/TileInspector.tsx`, `src/ui/HelpPage.tsx`, `src/ui/i18n.tsx`,
  `src/ui/useSimBridge.ts`, `src/ui/sound.ts`, `docs/agent-tools.md`,
  `docs/idea.md`, `docs/plan.md`.

---

### Task 1: Damage layer, disaster types and the balance block

The data model, end to end: types, tuning values, the tile layer, the
event state on `SimState`, undo, and the save round trip. No behaviour
yet — after this task a damaged tile survives a save/load and shows up in
diffs, and nothing else changes.

**Files:**

- Modify: `src/shared/types.ts`
- Modify: `src/shared/constants.ts`
- Modify: `src/sim/state.ts`
- Modify: `src/sim/roads.ts` (undo restores `damage`)
- Modify: `src/storage/serialization.ts`
- Test: `src/sim/disasters.test.ts` (new), `src/storage/serialization.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `DisasterKind = { Storm: 0, Fire: 1, Flood: 2 }`, `DisasterEvent`,
    `DisasterInfo`, `DisasterStats` in `src/shared/types.ts`
  - `TileLayers.damage: Uint8Array`
  - `SimState.disasters: { pending: DisasterEvent[]; active: DisasterEvent[]; nextId: number; cooldownTicks: number }`
  - `SimState.disasterScale: number`, `SimState.lastRepairCost: number`
  - `SaveGame.layers.damage?: ArrayBuffer`, `SaveGame.disasterScale?: number`,
    `SaveGame.disasters?: SavedDisasters`
  - `BALANCE.disasters`, `BALANCE.energy.windCutOutSpeed`

- [ ] **Step 1: Write the failing test**

Create `src/sim/disasters.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { tileIndex } from '../shared/grid.ts';
import { createSimState, deserializeState, serializeState } from './state.ts';

const SIZE = 32;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);

describe('the damage layer', () => {
  it('starts out intact on every tile', () => {
    const state = createSimState(1, SIZE);
    expect(state.layers.damage).toHaveLength(SIZE * SIZE);
    expect([...state.layers.damage].every((value) => value === 0)).toBe(true);
  });

  it('survives a save/load round trip', () => {
    const state = createSimState(1, SIZE);
    state.layers.damage[at(4, 5)] = 120;
    const loaded = deserializeState(serializeState(state));
    expect(loaded.layers.damage[at(4, 5)]).toBe(120);
  });

  it('starts a city with no events in flight and no repair bill', () => {
    const state = createSimState(1, SIZE);
    expect(state.disasters).toEqual({
      pending: [],
      active: [],
      nextId: 1,
      cooldownTicks: 0,
    });
    expect(state.lastRepairCost).toBe(0);
  });
});

describe('disaster intensity', () => {
  it('defaults to normal for a new city', () => {
    expect(createSimState(1, SIZE).disasterScale).toBe(1);
  });

  it('is zero for a save from before disasters', () => {
    const save = serializeState(createSimState(1, SIZE));
    delete save.disasterScale;
    expect(deserializeState(save).disasterScale).toBe(0);
  });

  it('round-trips a chosen intensity', () => {
    const state = createSimState(1, SIZE);
    state.disasterScale = 1.6;
    expect(deserializeState(serializeState(state)).disasterScale).toBe(1.6);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/sim/disasters.test.ts`
Expected: FAIL — `state.layers.damage` is undefined, `state.disasters`
and `state.disasterScale` do not exist.

- [ ] **Step 3: Add the disaster types to `src/shared/types.ts`**

Insert next to `GlobalStats` (before `SERVICE_FIRE`):

```ts
/** The three kinds of disaster the city can face. */
export const DisasterKind = { Storm: 0, Fire: 1, Flood: 2 } as const;
export type DisasterKind = (typeof DisasterKind)[keyof typeof DisasterKind];

/**
 * One disaster in flight: warned about (`startTick` in the future) or
 * active. Part of the saved state — pending and active events cannot be
 * re-derived, because the RNG is reseeded as `seed ^ tick` on load.
 */
export interface DisasterEvent {
  /** Monotonic id: stable React keys and agent-tool references. */
  id: number;
  kind: DisasterKind;
  /** 0..1; scales area and damage rate. */
  severity: number;
  /** Tick the event turns active; the warning runs until then. */
  startTick: number;
  /** Hard end of the event; a fire can end earlier once it is out. */
  endTick: number;
  /** Tile for the minimap marker and the camera jump. */
  origin: number;
  /** Affected tiles: struck (storm), grown (fire) or computed (flood). */
  tiles: number[];
  /**
   * Per-tile intensity, parallel to `tiles`: burn ticks left for a fire,
   * water depth in elevation levels for a flood, unused (0) for a storm.
   */
  intensity: number[];
}

/** One event as the HUD, the renderer and the agent tools see it. */
export interface DisasterInfo {
  id: number;
  kind: DisasterKind;
  severity: number;
  /** Ticks until it strikes (pending) or until it is over (active). */
  ticks: number;
  origin: number;
  /**
   * Tiles the event covers. The renderer needs them to draw embers and
   * the flood film, and the tile diff channel only carries the damage. A
   * fire is a handful of tiles and a flood a few hundred — far less than
   * one diff burst, and only while an event runs.
   */
  tiles: number[];
}

export interface DisasterStats {
  /** Intensity factor of this city: 0 = off, 1 = normal. */
  scale: number;
  pending: DisasterInfo[];
  active: DisasterInfo[];
  damagedTiles: number;
  repairPerTick: number;
}

/** Disasters in flight, as stored in a save game. */
export interface SavedDisasters {
  nextId: number;
  cooldownTicks: number;
  events: Array<{
    id: number;
    kind: number;
    severity: number;
    startTick: number;
    endTick: number;
    origin: number;
    tiles: number[];
    intensity: number[];
    /** False while the event is still only a warning. */
    active: boolean;
  }>;
}
```

In `GlobalStats`, after `services`:

```ts
/** Disasters in flight, damage and the repair bill. */
disasters: DisasterStats;
```

In `TileDiff`, after `reservoirHeat`:

```ts
/** Damage points 0..255 of this tile (0 = intact). */
damage: number;
```

In `BudgetStats`, after `biogasFuelCost`:

```ts
/** Repair spend on damaged tiles this tick. */
repair: number;
```

In `TileInfo`, after `troubledTicks`:

```ts
/** Damage points 0..255 (0 = intact); a damaged tile is out of service. */
damage: number;
/** Kind of the active event covering this tile, null when none does. */
disaster: DisasterKind | null;
```

In `SaveGame`, after `transitTicks`:

```ts
  /** Disaster intensity of this city (absent in older saves → 0 = off). */
  disasterScale?: number;
  /** Events in flight (absent in older saves → none). */
  disasters?: SavedDisasters;
```

and inside `SaveGame.layers`, after `reservoirHeat`:

```ts
    /** Damage layer; absent in saves from before disasters (all intact). */
    damage?: ArrayBuffer;
```

Finally extend `OverlayMode` (used in Task 13, added here so the enum is
never touched twice):

```ts
export const OverlayMode = {
  None: 0,
  Supply: 1,
  Demand: 2,
  Services: 3,
  Traffic: 4,
  Deliveries: 5,
  Transit: 6,
  Damage: 7,
} as const;
```

- [ ] **Step 4: Add the balance block to `src/shared/constants.ts`**

Inside `BALANCE.energy`, next to `windCutInSpeed`:

```ts
    /**
     * Normalised wind speed at which turbines feather their blades and
     * stop. Real turbines cut out in a storm; only a severe storm's gust
     * pushes the city's wind this high (see BALANCE.disasters.storm.gust),
     * so a moderate storm merely runs the fleet flat out.
     */
    windCutOutSpeed: 0.92,
```

As a new top-level block after `services`:

```ts
  disasters: {
    /**
     * Ticks after one event is scheduled before another may be rolled
     * (half an in-game day), so a storm, a fire and a flood never pile
     * onto the same evening by accident.
     */
    cooldownTicks: 480,
    repair: {
      /** Damage points a tile heals per tick (1 point = 1 tick of work). */
      pointsPerTick: 1,
      /** Money per healed damage point. */
      costPerPoint: 0.5,
    },
    /** Happiness: standing penalty weight on the damaged-building share. */
    damagedPenaltyWeight: 0.35,
    /** Happiness: acute penalty while any event is active. */
    activeEventPenalty: 0.05,
    storm: {
      /** Risk per tick at the highest wind mean, before the intensity scale. */
      baseRisk: 0.0008,
      /** Front wind mean from which a storm becomes possible at all. */
      windThreshold: 0.6,
      /** Risk factor in winter. */
      winterFactor: 1.5,
      /** Warning lead and duration in ticks (4 h / 3 h). */
      warnTicks: 160,
      durationTicks: 120,
      severityRange: [0.4, 1] as const,
      /** Added to the wind speed while the storm blows (× severity). */
      gust: 0.6,
      /** Tiles struck per tick at severity 1. */
      hitsPerTick: 3,
      /** Draw weights of the target pool. */
      weights: { line: 4, turbine: 4, plant: 2, building: 1 },
      /** Damage points per strike, before severity. */
      damage: { line: 90, turbine: 120, plant: 60, building: 30 },
    },
    fire: {
      baseRisk: 0.0022,
      /** Fires strike without warning — that is why fire stations pay off. */
      warnTicks: 0,
      /** Hard cap (~2 h): nothing burns forever. */
      durationTicks: 80,
      severityRange: [0.5, 1] as const,
      /** Temperature (°C) at which the city starts drying out, and the span to full dryness. */
      dryTemperature: 8,
      dryTemperatureSpan: 14,
      /** Cloud cover from which nothing is dry any more. */
      dryCloudCeiling: 0.6,
      /** Ignition draw weight per density level, covered and uncovered. */
      coveredIgnitionWeight: 1,
      uncoveredIgnitionWeight: 4,
      /** Candidate pool size at which the exposure factor saturates at 1. */
      exposureSaturation: 400,
      /** Ticks one tile burns; a covered tile loses this many per tick instead of one. */
      burnTicks: 24,
      extinguishCovered: 4,
      /** Per-neighbour ignition chance per tick (× severity). */
      spreadChance: 0.06,
      spreadChanceCovered: 0.01,
      /** Damage points a burning tile takes per tick (× severity). */
      damagePerTick: 4,
    },
    flood: {
      baseRisk: 0.0018,
      /** River flow from which a flood becomes possible. */
      flowThreshold: 0.75,
      /** Risk factor while a snowpack is melting. */
      meltFactor: 2,
      /** Warning lead and duration in ticks (6 h / 8 h). */
      warnTicks: 240,
      durationTicks: 320,
      severityRange: [0.4, 1] as const,
      /** Elevation levels the water rises above its bed at severity 1. */
      maxRise: 2,
      /** Damage points per tick (× severity), plus this much per level of depth. */
      damagePerTick: 2,
      depthFactor: 0.5,
    },
  },
```

> These are starting values. Task 17 tunes them with a headless probe.

- [ ] **Step 5: Extend `src/sim/state.ts`**

Add to the `TileLayers` interface, after `reservoirHeat`:

```ts
/** Damage points per tile: 0 = intact, 1..255 = out of service (persisted). */
damage: Uint8Array;
```

In `createTileLayers`, after `reservoirHeat`: `damage: new Uint8Array(tiles),`.

Add to the `UndoEntry` tile snapshot type, after `forest`:

```ts
damage: number;
```

and to `snapshotTile`'s returned object: `damage: layers.damage[index],`.

Add to `SimState`, after `geothermalFields`:

```ts
  /**
   * Disasters in flight. Pending events are warnings with a countdown,
   * active ones are striking right now. Persisted: the RNG is reseeded on
   * load, so an event cannot be re-derived from (seed, tick).
   */
  disasters: {
    pending: DisasterEvent[];
    active: DisasterEvent[];
    nextId: number;
    cooldownTicks: number;
  };
  /** Disaster intensity: 0 = off, 0.5 mild, 1 normal, 1.6 harsh. */
  disasterScale: number;
  /** Money spent on repairs last tick (feeds the budget panel). */
  lastRepairCost: number;
```

In `createSimState`, after `geothermalFields: []`:

```ts
    disasters: { pending: [], active: [], nextId: 1, cooldownTicks: 0 },
    disasterScale: 1,
    lastRepairCost: 0,
```

In `collectDiffs`, add `damage: layers.damage[index],` to the pushed diff.

In `serializeState`, add `damage: copyBuffer(layers.damage),` to
`layers`, and next to the goal streak fields:

```ts
    disasterScale: state.disasterScale,
    disasters: {
      nextId: state.disasters.nextId,
      cooldownTicks: state.disasters.cooldownTicks,
      events: [
        ...state.disasters.pending.map((event) => savedEvent(event, false)),
        ...state.disasters.active.map((event) => savedEvent(event, true)),
      ],
    },
```

with a local helper above `serializeState`:

```ts
function savedEvent(event: DisasterEvent, active: boolean): SavedDisasters['events'][number] {
  return {
    id: event.id,
    kind: event.kind,
    severity: event.severity,
    startTick: event.startTick,
    endTick: event.endTick,
    origin: event.origin,
    tiles: [...event.tiles],
    intensity: [...event.intensity],
    active,
  };
}
```

In `deserializeState`, after the `busStop` layer restore:

```ts
if (save.layers.damage) state.layers.damage.set(new Uint8Array(save.layers.damage));
// A save from before disasters keeps its calm: the city only faces them
// when it was founded with an intensity (see NewGameOptions).
state.disasterScale = save.disasterScale ?? 0;
if (save.disasters) {
  state.disasters.nextId = save.disasters.nextId;
  state.disasters.cooldownTicks = save.disasters.cooldownTicks;
  for (const saved of save.disasters.events) {
    const event: DisasterEvent = {
      id: saved.id,
      kind: saved.kind as DisasterKind,
      severity: saved.severity,
      startTick: saved.startTick,
      endTick: saved.endTick,
      origin: saved.origin,
      tiles: [...saved.tiles],
      intensity: [...saved.intensity],
    };
    if (saved.active) state.disasters.active.push(event);
    else state.disasters.pending.push(event);
  }
}
```

Import `DisasterKind` (value) and `type DisasterEvent`, `type SavedDisasters`
from `../shared/types.ts` in the existing import blocks.

- [ ] **Step 6: Make undo restore the damage in `src/sim/roads.ts`**

In `undoLastAction`, next to the other layer restores:

```ts
layers.damage[tile.index] = tile.damage;
```

- [ ] **Step 7: Extend the JSON save format in `src/storage/serialization.ts`**

Add to `SaveGameJson` after `transitTicks`:

```ts
  disasterScale?: number;
  disasters?: SavedDisasters;
```

(import `type SavedDisasters` from `../shared/types.ts`), add to
`saveToJson`'s spread list:

```ts
    ...(save.disasterScale !== undefined ? { disasterScale: save.disasterScale } : {}),
    ...(save.disasters !== undefined ? { disasters: save.disasters } : {}),
```

add `'damage'` to the `optionalLayers` tuple, and to `saveFromJson`'s
result spread:

```ts
    ...(typeof parsed.disasterScale === 'number' ? { disasterScale: parsed.disasterScale } : {}),
    ...(isSavedDisasters(parsed.disasters) ? { disasters: parsed.disasters } : {}),
```

with a guard above `saveFromJson` (hand-edited exports must not crash the
loader):

```ts
/** Shallow shape check: a hand-edited export must not break the loader. */
function isSavedDisasters(value: unknown): value is SavedDisasters {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<SavedDisasters>;
  return typeof candidate.nextId === 'number' && Array.isArray(candidate.events);
}
```

- [ ] **Step 8: Add the serialization test**

Append to `src/storage/serialization.test.ts`:

```ts
it('round-trips the damage layer, intensity and events in flight', () => {
  const save = baseSave();
  save.disasterScale = 1.6;
  save.disasters = {
    nextId: 7,
    cooldownTicks: 42,
    events: [
      {
        id: 6,
        kind: 1,
        severity: 0.8,
        startTick: 100,
        endTick: 180,
        origin: 5,
        tiles: [5, 6],
        intensity: [24, 12],
        active: true,
      },
    ],
  };
  save.layers.damage = new Uint8Array([9, 0, 0, 0]).buffer as ArrayBuffer;
  const restored = saveFromJson(saveToJson(save));
  expect(restored.disasterScale).toBe(1.6);
  expect(restored.disasters?.events[0].intensity).toEqual([24, 12]);
  expect(new Uint8Array(restored.layers.damage!)[0]).toBe(9);
});
```

Use the file's existing helper for a minimal save (`baseSave()` in this
snippet stands for however the surrounding tests build one — read the top
of the file and follow it; the grid there is 2×2, so a four-byte layer is
the right size).

- [ ] **Step 9: Run the tests to verify they pass**

Run: `pnpm vitest run src/sim/disasters.test.ts src/storage/serialization.test.ts`
Expected: PASS.

- [ ] **Step 10: Run the whole suite and the type check**

Run: `pnpm typecheck && pnpm test`
Expected: PASS. `collectDiffs` gained a field, so any test constructing a
`TileDiff` by hand may need `damage: 0` — fix those call sites.

- [ ] **Step 11: Commit**

```bash
pnpm format
git add -A
git commit -m "feat(sim): a repairable damage layer and the disaster data model

Adds the damage tile layer (0..255), the disaster event types, the
BALANCE.disasters tuning block and the save fields for damage, events in
flight and a city's disaster intensity. Saves from before disasters load
with intensity 0, so an existing city stays calm.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Damage takes tiles out of service

Damage now means something: damaged plants stop generating, damaged lines
stop conducting, damaged buildings go dark, damaged stations stop
covering, and nothing can be built on a damaged tile. Still no events —
tests set `layers.damage` by hand.

**Files:**

- Modify: `src/sim/energy.ts` (`censusPlants`, `energyStep`)
- Modify: `src/sim/powerGrid.ts` (`recomputeGrid`)
- Modify: `src/sim/services.ts` (`recomputeServices`)
- Modify: `src/sim/state.ts` (`buildRejection`)
- Modify: `src/sim/roads.ts` (`bulldozeTiles` clears damage)
- Test: `src/sim/disasters.test.ts`

**Interfaces:**

- Consumes: `TileLayers.damage` (Task 1).
- Produces: the rule "a tile with `damage !== 0` is out of service" plus
  the rejection code `damaged`. No new exported functions.

- [ ] **Step 1: Write the failing test**

Append to `src/sim/disasters.test.ts`:

```ts
import { BALANCE } from '../shared/constants.ts';
import { PlantType, SupplyStatus, TileType, Zone } from '../shared/types.ts';
import { censusPlants, placePlant } from './energy.ts';
import { recomputeGrid } from './powerGrid.ts';
import { buildPowerLines } from './powerLines.ts';
import { bulldozeTiles, buildRoads } from './roads.ts';
import { recomputeServices, SERVICE_FIRE } from './services.ts';
import { buildRejection, BuildIntent, bumpGridVersion } from './state.ts';
import { stepTick } from './tick.ts';

describe('damage takes a tile out of service', () => {
  it('drops a damaged turbine out of the plant census', () => {
    const state = createSimState(1, SIZE);
    placePlant(state, at(5, 5), PlantType.WindTurbine);
    expect(censusPlants(state).windTurbines).toBe(1);
    state.layers.damage[at(5, 5)] = 50;
    expect(censusPlants(state).windTurbines).toBe(0);
    expect(censusPlants(state).windCapacity).toBe(0);
  });

  it('stops a damaged line from conducting', () => {
    const state = createSimState(1, SIZE);
    placePlant(state, at(2, 2), PlantType.WindTurbine);
    buildPowerLines(state, [at(3, 2), at(4, 2), at(5, 2), at(6, 2)]);
    recomputeGrid(state);
    expect(state.layers.energized[at(6, 2)]).toBe(1);
    state.layers.damage[at(4, 2)] = 90;
    bumpGridVersion(state);
    recomputeGrid(state);
    expect(state.layers.energized[at(6, 2)]).toBe(0);
  });

  it('marks a damaged building as not connected and drops its consumption', () => {
    const state = createSimState(1, SIZE);
    placePlant(state, at(5, 5), PlantType.WindTurbine);
    state.layers.zone[at(5, 6)] = Zone.Residential;
    state.layers.density[at(5, 6)] = 2;
    stepTick(state);
    const withBuilding = state.lastEnergy.buildingConsumption;
    expect(withBuilding).toBeGreaterThan(0);
    state.layers.damage[at(5, 6)] = 30;
    stepTick(state);
    expect(state.lastEnergy.buildingConsumption).toBeLessThan(withBuilding);
    expect(state.layers.supplied[at(5, 6)]).toBe(SupplyStatus.NotConnected);
  });

  it('stops a damaged fire station from covering its ring', () => {
    const state = createSimState(1, SIZE);
    buildRoads(state, [at(4, 5)]);
    placePlant(state, at(4, 4), PlantType.FireStation);
    placePlant(state, at(5, 4), PlantType.WindTurbine);
    recomputeServices(state);
    expect(state.layers.services[at(4, 4)] & SERVICE_FIRE).toBe(SERVICE_FIRE);
    state.layers.damage[at(4, 4)] = 60;
    recomputeServices(state);
    expect(state.layers.services[at(4, 4)] & SERVICE_FIRE).toBe(0);
  });

  it('refuses to build on a damaged tile and clears damage when bulldozing', () => {
    const state = createSimState(1, SIZE);
    placePlant(state, at(7, 7), PlantType.WindTurbine);
    state.layers.damage[at(7, 7)] = 40;
    expect(buildRejection(state, at(7, 7), BuildIntent.Road)).toBe('damaged');
    bulldozeTiles(state, [at(7, 7)]);
    expect(state.layers.damage[at(7, 7)]).toBe(0);
    expect(buildRejection(state, at(7, 7), BuildIntent.Road)).toBe(null);
  });

  it('never damages the road under a damaged power line', () => {
    const state = createSimState(1, SIZE);
    buildRoads(state, [at(3, 3), at(4, 3)]);
    buildPowerLines(state, [at(3, 3)]);
    state.layers.damage[at(3, 3)] = 90;
    // The road is still a road: routing and vehicles ignore damage entirely.
    expect(state.layers.tileType[at(3, 3)]).toBe(TileType.Road);
  });
});

it('keeps the wind cut-out constant above the cut-in speed', () => {
  expect(BALANCE.energy.windCutOutSpeed).toBeGreaterThan(BALANCE.energy.windCutInSpeed);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/sim/disasters.test.ts`
Expected: FAIL — the census still counts the damaged turbine, the line
still conducts, `buildRejection` returns `tileOccupied` instead of
`damaged`.

- [ ] **Step 3: Gate generation and consumption in `src/sim/energy.ts`**

In `censusPlants`, extend the loop guard:

```ts
  for (let i = 0; i < tileType.length; i++) {
    if (tileType[i] !== TileType.Plant) continue;
    // A damaged plant is out of service: no generation, no storage
    // capacity, no coverage. It heals through repairStep.
    if (state.layers.damage[i] !== 0) continue;
```

(the destructuring at the top of the function already has `tileType`,
`plantType`, `geothermal`, `reservoirHeat` — add `damage` there and use
`damage[i] !== 0` instead of `state.layers.damage[i] !== 0`.)

In `energyStep`, the station-consumption loop:

```ts
  for (let i = 0; i < layers.tileType.length; i++) {
    if (layers.tileType[i] !== TileType.Plant) continue;
    if (layers.damage[i] !== 0) continue;
    if (!isStation(layers.plantType[i] as PlantType)) continue;
```

and the building loop, right after the density check:

```ts
// A damaged building draws nothing and reads as cut off, so the
// existing troubled-supply path (happiness, decay) covers it.
if (layers.damage[i] !== 0) {
  setSupplied(state, i, SupplyStatus.NotConnected);
  continue;
}
```

- [ ] **Step 4: Gate conduction in `src/sim/powerGrid.ts`**

In `recomputeGrid`, destructure `damage` alongside `powerLine`, then:

```ts
  for (let i = 0; i < tileType.length; i++) {
    if (tileType[i] !== TileType.Plant || !isSupplySource(plantType[i] as PlantType)) continue;
    if (damage[i] !== 0) continue; // a damaged plant feeds nothing
    sources.push(i);
    for (const n of neighbors4(i, size)) {
      if (powerLine[n] !== 0 && damage[n] === 0 && reached[n] === 0) {
```

and in the flood-fill loop the same condition:

```ts
      if (powerLine[n] !== 0 && damage[n] === 0 && reached[n] === 0) {
```

- [ ] **Step 5: Gate coverage in `src/sim/services.ts`**

```ts
if (layers.tileType[i] !== TileType.Plant || layers.energized[i] !== 1) continue;
// A damaged station stamps nothing: a fire that reaches the fire
// station widens its own path.
if (layers.damage[i] !== 0) continue;
```

- [ ] **Step 6: Refuse building on damaged tiles in `src/sim/state.ts`**

At the top of `buildRejection`, before the PowerLine branch:

```ts
// A damaged tile is a building site only after the repair crews are
// done; the bulldozer may still clear it.
if (layers.damage[index] !== 0) return 'damaged';
```

- [ ] **Step 7: Clear damage when bulldozing in `src/sim/roads.ts`**

In `bulldozeTiles`, inside the `clearable` loop add `layers.damage[index] = 0;`,
and after `clearPowerLines(state, lineTiles)`:

```ts
// Removing the wreck removes the damage with it.
for (const index of lineTiles) layers.damage[index] = 0;
```

Both paths already `markDirty` their tiles.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm vitest run src/sim/disasters.test.ts`
Expected: PASS.

- [ ] **Step 9: Run the whole suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
pnpm format
git add -A
git commit -m "feat(sim): damaged tiles fall out of service

A damaged plant stops generating and stops feeding the grid, a damaged
line stops conducting, a damaged building goes dark through the existing
unsupplied path, and a damaged station stamps no coverage. Building on a
damaged tile is refused; bulldozing clears the damage.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Repair over time, the budget line and the happiness penalty

**Files:**

- Create: `src/sim/disasters.ts`
- Modify: `src/sim/tick.ts` (call `repairStep`, report the budget line)
- Modify: `src/sim/happiness.ts`
- Modify: `src/ui/BudgetPanel.tsx`, `src/ui/i18n.tsx`
- Test: `src/sim/disasters.test.ts`

**Interfaces:**

- Consumes: `TileLayers.damage`, `SimState.lastRepairCost` (Task 1).
- Produces, from `src/sim/disasters.ts`:
  - `addDamage(state: SimState, index: number, points: number): void`
  - `clearDamage(state: SimState, index: number): void`
  - `isDamaged(state: SimState, index: number): boolean`
  - `damagedTileCount(state: SimState): number`
  - `activeDisasterTiles(state: SimState): Set<number>`
  - `repairStep(state: SimState): number`
  - `disasterKindAt(state: SimState, index: number): DisasterKind | null`

- [ ] **Step 1: Write the failing test**

Append to `src/sim/disasters.test.ts`:

```ts
import { addDamage, clearDamage, damagedTileCount, repairStep } from './disasters.ts';

describe('addDamage / clearDamage', () => {
  it('accumulates, saturates at 255 and marks the tile dirty', () => {
    const state = createSimState(1, SIZE);
    addDamage(state, at(1, 1), 200);
    addDamage(state, at(1, 1), 200);
    expect(state.layers.damage[at(1, 1)]).toBe(255);
    expect(state.dirty.has(at(1, 1))).toBe(true);
  });

  it('bumps the grid version only on the transitions that matter', () => {
    const state = createSimState(1, SIZE);
    const before = state.gridVersion;
    addDamage(state, at(1, 1), 10);
    expect(state.gridVersion).toBe(before + 1);
    addDamage(state, at(1, 1), 10);
    expect(state.gridVersion).toBe(before + 1); // still damaged: nothing changed
    clearDamage(state, at(1, 1));
    expect(state.gridVersion).toBe(before + 2);
  });
});

describe('repairStep', () => {
  it('heals damage over time and bills it', () => {
    const state = createSimState(1, SIZE);
    const { pointsPerTick, costPerPoint } = BALANCE.disasters.repair;
    addDamage(state, at(2, 2), 10);
    const money = state.money;
    const spent = repairStep(state);
    expect(state.layers.damage[at(2, 2)]).toBe(10 - pointsPerTick);
    expect(spent).toBeCloseTo(pointsPerTick * costPerPoint);
    expect(state.money).toBeCloseTo(money - spent);
    expect(state.lastRepairCost).toBeCloseTo(spent);
  });

  it('heals a tile all the way to intact', () => {
    const state = createSimState(1, SIZE);
    addDamage(state, at(2, 2), 3);
    for (let i = 0; i < 10; i++) repairStep(state);
    expect(damagedTileCount(state)).toBe(0);
  });

  it('freezes damage when the treasury is empty', () => {
    const state = createSimState(1, SIZE);
    addDamage(state, at(2, 2), 10);
    state.money = 0;
    expect(repairStep(state)).toBe(0);
    expect(state.layers.damage[at(2, 2)]).toBe(10);
    expect(state.money).toBe(0);
  });

  it('leaves tiles inside an active event alone', () => {
    const state = createSimState(1, SIZE);
    addDamage(state, at(2, 2), 10);
    state.disasters.active.push({
      id: 1,
      kind: DisasterKind.Flood,
      severity: 1,
      startTick: 0,
      endTick: state.tick + 100,
      origin: at(2, 2),
      tiles: [at(2, 2)],
      intensity: [1],
    });
    repairStep(state);
    expect(state.layers.damage[at(2, 2)]).toBe(10);
  });
});

describe('happiness', () => {
  it('drops while buildings are damaged', () => {
    const build = (): SimState => {
      const state = createSimState(1, SIZE);
      for (let x = 2; x < 10; x++) {
        state.layers.zone[at(x, 2)] = Zone.Residential;
        state.layers.density[at(x, 2)] = 2;
      }
      return state;
    };
    const calm = build();
    const hit = build();
    for (let x = 2; x < 10; x++) addDamage(hit, at(x, 2), 40);
    for (let i = 0; i < 20; i++) {
      happinessStep(calm, 100);
      happinessStep(hit, 100);
    }
    expect(hit.happiness).toBeLessThan(calm.happiness);
  });
});
```

Add the needed imports (`DisasterKind` from `../shared/types.ts`,
`happinessStep` from `./happiness.ts`, `type SimState` from `./state.ts`).

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/sim/disasters.test.ts`
Expected: FAIL — `./disasters.ts` does not exist.

- [ ] **Step 3: Create `src/sim/disasters.ts` with the damage and repair core**

```ts
import { BALANCE } from '../shared/constants.ts';
import { DisasterKind, type DisasterEvent } from '../shared/types.ts';
import { bumpGridVersion, markDirty, type SimState } from './state.ts';

/** Highest value the quantised damage layer can hold. */
export const MAX_DAMAGE = 255;

/**
 * Add damage points to a tile. The grid is only re-derived on the
 * transition from intact to damaged — that is when a line stops
 * conducting or a plant stops feeding.
 */
export function addDamage(state: SimState, index: number, points: number): void {
  const { damage } = state.layers;
  const before = damage[index];
  const next = Math.min(MAX_DAMAGE, before + Math.max(1, Math.round(points)));
  if (next === before) return;
  damage[index] = next;
  if (before === 0) bumpGridVersion(state);
  markDirty(state, index);
}

/** Make a tile intact again (repaired, or bulldozed away). */
export function clearDamage(state: SimState, index: number): void {
  if (state.layers.damage[index] === 0) return;
  state.layers.damage[index] = 0;
  bumpGridVersion(state);
  markDirty(state, index);
}

export function isDamaged(state: SimState, index: number): boolean {
  return state.layers.damage[index] !== 0;
}

export function damagedTileCount(state: SimState): number {
  const { damage } = state.layers;
  let count = 0;
  for (let i = 0; i < damage.length; i++) {
    if (damage[i] !== 0) count++;
  }
  return count;
}

/** Tiles covered by an active event; they are not repaired while it runs. */
export function activeDisasterTiles(state: SimState): Set<number> {
  const tiles = new Set<number>();
  for (const event of state.disasters.active) {
    for (const index of event.tiles) tiles.add(index);
  }
  return tiles;
}

/** Kind of the active event covering a tile, or null. */
export function disasterKindAt(state: SimState, index: number): DisasterKind | null {
  for (const event of state.disasters.active) {
    if (event.tiles.includes(index)) return event.kind;
  }
  return null;
}

/**
 * One tick of repairs: every damaged tile outside an active event heals
 * `pointsPerTick` damage points and bills `costPerPoint` per point.
 *
 * An empty treasury freezes the damage instead of running into debt, so
 * a city that went broke in a storm stays repairable once money flows
 * again. The scan then stops at the first tile it cannot afford, which
 * favours low tile indices — deterministic, and the alternative (spread
 * the last coins thinly over every wreck) repairs nothing at all.
 */
export function repairStep(state: SimState): number {
  const { pointsPerTick, costPerPoint } = BALANCE.disasters.repair;
  const { damage } = state.layers;
  const blocked = activeDisasterTiles(state);
  let spend = 0;
  for (let i = 0; i < damage.length; i++) {
    if (damage[i] === 0 || blocked.has(i)) continue;
    const points = Math.min(damage[i], pointsPerTick);
    const cost = points * costPerPoint;
    if (cost > state.money - spend) break;
    spend += cost;
    damage[i] -= points;
    if (damage[i] === 0) bumpGridVersion(state);
    markDirty(state, i);
  }
  state.money -= spend;
  state.lastRepairCost = spend;
  return spend;
}

/** Share of buildings that are damaged (0 when the city has none). */
export function damagedBuildingShare(state: SimState): number {
  const { tileType, density, damage } = state.layers;
  let buildings = 0;
  let damaged = 0;
  for (let i = 0; i < tileType.length; i++) {
    if (tileType[i] !== 0 /* TileType.Empty */ || density[i] === 0) continue;
    buildings++;
    if (damage[i] !== 0) damaged++;
  }
  return buildings > 0 ? damaged / buildings : 0;
}
```

Use `TileType.Empty` from `../shared/types.ts` instead of the literal `0`
in `damagedBuildingShare` — import it alongside `DisasterKind`. The
`DisasterEvent` import is used by the lifecycle in Task 4; if the linter
flags it as unused now, add it in Task 4 instead.

- [ ] **Step 4: Wire repairs into the tick in `src/sim/tick.ts`**

Import `repairStep` from `./disasters.ts` and call it after
`economyStep`, before `happinessStep`:

```ts
economyStep(state, population, jobs);
// After the income of this tick has landed: repairs are paid out of it.
repairStep(state);
happinessStep(state, population);
```

In `buildBudget`, add the repair line and subtract it from the net:

```ts
    repair: state.lastRepairCost,
    net:
      b.taxIncome +
      b.gridExportRevenue +
      b.hydrogenRevenue -
      b.gridUpkeep -
      b.plantUpkeep -
      b.biogasFuelCost -
      b.gridImportCost -
      state.lastRepairCost,
```

`buildBudget` takes `state`, so no signature change is needed.

- [ ] **Step 5: Add the happiness penalties in `src/sim/happiness.ts`**

```ts
import { damagedBuildingShare } from './disasters.ts';
```

then, next to the other penalties:

```ts
const disasters = BALANCE.disasters;
// Wrecked homes weigh permanently; an event in progress frightens the
// whole city while it runs.
const damagePenalty = damagedBuildingShare(state) * disasters.damagedPenaltyWeight;
const eventPenalty = state.disasters.active.length > 0 ? disasters.activeEventPenalty : 0;
```

and subtract both inside the `target` expression.

- [ ] **Step 6: Show the repair line in the budget panel**

`src/ui/BudgetPanel.tsx` — follow the file's existing expense rows and
add one for `budget.repair`, using the key `budget.repair`. In
`src/ui/i18n.tsx` add to **both** dictionaries:

```ts
  'budget.repair': 'Repairs',
```

```ts
  'budget.repair': 'Reparaturen',
```

- [ ] **Step 7: Run the tests**

Run: `pnpm vitest run src/sim/disasters.test.ts src/sim/happiness.test.ts`
Expected: PASS.

- [ ] **Step 8: Run the whole suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
pnpm format
git add -A
git commit -m "feat(sim): repair damaged tiles over time, against money

Damage outside an active event heals at a fixed rate and bills per
healed point, reported as its own budget line. An empty treasury freezes
the damage rather than running into debt. Damaged buildings cost
happiness, and an event in progress costs a little more while it runs.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The disaster lifecycle

Risk → warning → active → retired, with the cooldown and the intensity
factor. Kinds are injected as `DisasterSpec` objects, so this task is
tested with a synthetic spec and needs none of the three real kinds.

**Files:**

- Modify: `src/sim/disasters.ts`
- Modify: `src/sim/tick.ts` (call `disastersStep`, export `disasterStats`)
- Test: `src/sim/disasters.test.ts`

**Interfaces:**

- Consumes: `addDamage`, `activeDisasterTiles`, `damagedTileCount` (Task 3).
- Produces:
  - `export interface DisasterSpec { kind, warnTicks, durationTicks, severityRange, risk(state), plan(state, severity), apply(state, event) }`
  - `disastersStep(state: SimState, specs?: readonly DisasterSpec[]): void`
  - `disasterStats(state: SimState): DisasterStats`
  - `DISASTER_SPECS: readonly DisasterSpec[]` (empty until Task 5)

- [ ] **Step 1: Write the failing test**

Append to `src/sim/disasters.test.ts`:

```ts
import { disasterStats, disastersStep, type DisasterSpec } from './disasters.ts';

/** A spec that always fires, hits one tile and never ends early. */
function alwaysSpec(overrides: Partial<DisasterSpec> = {}): DisasterSpec {
  return {
    kind: DisasterKind.Storm,
    warnTicks: 10,
    durationTicks: 5,
    severityRange: [1, 1],
    risk: () => 1,
    plan: () => ({ origin: 0, tiles: [0], intensity: [0] }),
    apply: () => false,
    ...overrides,
  };
}

describe('disastersStep', () => {
  it('schedules a warning, activates it, then retires it', () => {
    const state = createSimState(1, SIZE);
    const specs = [alwaysSpec()];
    disastersStep(state, specs);
    expect(state.disasters.pending).toHaveLength(1);
    expect(state.disasters.active).toHaveLength(0);

    const event = state.disasters.pending[0];
    while (state.tick < event.startTick) {
      state.tick++;
      disastersStep(state, specs);
    }
    expect(state.disasters.active).toHaveLength(1);
    expect(state.disasters.pending).toHaveLength(0);

    while (state.tick < event.endTick) {
      state.tick++;
      disastersStep(state, specs);
    }
    expect(state.disasters.active).toHaveLength(0);
  });

  it('respects the cooldown between two events', () => {
    const state = createSimState(1, SIZE);
    const specs = [alwaysSpec()];
    disastersStep(state, specs);
    expect(state.disasters.nextId).toBe(2);
    for (let i = 0; i < BALANCE.disasters.cooldownTicks - 1; i++) {
      state.tick++;
      disastersStep(state, specs);
    }
    const scheduled = state.disasters.pending.length + state.disasters.active.length;
    expect(scheduled).toBe(1);
    state.tick++;
    disastersStep(state, specs);
    expect(state.disasters.nextId).toBe(3);
  });

  it('never schedules anything with the intensity off', () => {
    const state = createSimState(1, SIZE);
    state.disasterScale = 0;
    for (let i = 0; i < 1000; i++) {
      state.tick++;
      disastersStep(state, [alwaysSpec()]);
    }
    expect(state.disasters.pending).toHaveLength(0);
    expect(state.disasters.active).toHaveLength(0);
  });

  it('scales the risk with the intensity', () => {
    const rolls = (scale: number): number => {
      const state = createSimState(7, SIZE);
      state.disasterScale = scale;
      let count = 0;
      const specs = [alwaysSpec({ risk: () => 0.02, warnTicks: 0, durationTicks: 1 })];
      for (let i = 0; i < 4000; i++) {
        state.tick++;
        const before = state.disasters.nextId;
        disastersStep(state, specs);
        if (state.disasters.nextId > before) count++;
      }
      return count;
    };
    expect(rolls(1.6)).toBeGreaterThan(rolls(0.5));
  });

  it('retires an event early when its kind reports it is over', () => {
    const state = createSimState(1, SIZE);
    const specs = [alwaysSpec({ warnTicks: 0, durationTicks: 500, apply: () => true })];
    disastersStep(state, specs);
    expect(state.disasters.active).toHaveLength(1);
    state.tick++;
    disastersStep(state, specs);
    expect(state.disasters.active).toHaveLength(0);
  });

  it('skips a kind that finds no site', () => {
    const state = createSimState(1, SIZE);
    disastersStep(state, [alwaysSpec({ plan: () => null })]);
    expect(state.disasters.pending).toHaveLength(0);
    expect(state.disasters.nextId).toBe(1);
  });

  it('reports pending and active events in the stats', () => {
    const state = createSimState(1, SIZE);
    disastersStep(state, [alwaysSpec()]);
    addDamage(state, at(3, 3), 20);
    const stats = disasterStats(state);
    expect(stats.scale).toBe(1);
    expect(stats.pending[0].ticks).toBe(10);
    expect(stats.pending[0].kind).toBe(DisasterKind.Storm);
    expect(stats.damagedTiles).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/sim/disasters.test.ts`
Expected: FAIL — `disastersStep` is not exported.

- [ ] **Step 3: Implement the lifecycle in `src/sim/disasters.ts`**

```ts
/**
 * What one kind of disaster contributes to the shared lifecycle. The
 * framework owns warnings, damage bookkeeping, repair and stats; a kind
 * only answers three questions: how likely is it right now, where does it
 * strike, and what does one tick of it do.
 */
export interface DisasterSpec {
  kind: DisasterKind;
  /** Ticks of warning before it becomes active (0 = no warning). */
  warnTicks: number;
  /** Ticks it stays active at most. */
  durationTicks: number;
  /** Severity is drawn uniformly from this range. */
  severityRange: readonly [number, number];
  /** Probability per tick that it starts, before the intensity scale. */
  risk(state: SimState): number;
  /** Where it strikes, or null when the city offers no site. */
  plan(
    state: SimState,
    severity: number,
  ): { origin: number; tiles: number[]; intensity: number[] } | null;
  /** One tick of the active event. Returns true when it is over. */
  apply(state: SimState, event: DisasterEvent): boolean;
}

/** Every kind the game rolls for. Filled in by storm.ts, fire.ts, flood.ts. */
export const DISASTER_SPECS: readonly DisasterSpec[] = [];

/**
 * One tick of the disaster lifecycle: retire what is over, activate what
 * was announced, let active events work, then roll for a new one.
 *
 * Runs after `updateWeather` (the weather of this tick sets the risk) and
 * before generation and grid connectivity, so this tick's damage is
 * already in effect when the energy balance is computed.
 */
export function disastersStep(
  state: SimState,
  specs: readonly DisasterSpec[] = DISASTER_SPECS,
): void {
  const d = state.disasters;
  if (d.cooldownTicks > 0) d.cooldownTicks--;

  if (d.pending.length > 0) {
    const due = d.pending.filter((event) => state.tick >= event.startTick);
    if (due.length > 0) {
      d.pending = d.pending.filter((event) => state.tick < event.startTick);
      d.active.push(...due);
      state.statsDirty = true;
    }
  }

  if (d.active.length > 0) {
    const running: DisasterEvent[] = [];
    for (const event of d.active) {
      const spec = specs.find((candidate) => candidate.kind === event.kind);
      // A kind that is not in the list (a save from a later version, a
      // test with a narrower list) simply runs out its duration.
      const done = spec ? spec.apply(state, event) : false;
      if (done || state.tick >= event.endTick) state.statsDirty = true;
      else running.push(event);
    }
    d.active = running;
  }

  if (d.cooldownTicks > 0 || state.disasterScale <= 0) return;
  for (const spec of specs) {
    const risk = spec.risk(state) * state.disasterScale;
    if (risk <= 0 || !state.rng.chance(risk)) continue;
    if (!schedule(state, spec)) continue;
    // One event per roll: the cooldown spaces the next one out.
    d.cooldownTicks = BALANCE.disasters.cooldownTicks;
    return;
  }
}

/** Put one event of this kind on the calendar. False when there is no site. */
function schedule(state: SimState, spec: DisasterSpec): boolean {
  const [min, max] = spec.severityRange;
  const severity = state.rng.nextRange(min, max);
  const plan = spec.plan(state, severity);
  if (plan === null) return false;
  state.disasters.pending.push({
    id: state.disasters.nextId++,
    kind: spec.kind,
    severity,
    startTick: state.tick + spec.warnTicks,
    endTick: state.tick + spec.warnTicks + spec.durationTicks,
    origin: plan.origin,
    tiles: plan.tiles,
    intensity: plan.intensity,
  });
  state.statsDirty = true;
  return true;
}

/** Everything the HUD and the agent tools need to know about disasters. */
export function disasterStats(state: SimState): DisasterStats {
  const d = state.disasters;
  return {
    scale: state.disasterScale,
    pending: d.pending.map((event) => info(event, event.startTick - state.tick)),
    active: d.active.map((event) => info(event, event.endTick - state.tick)),
    damagedTiles: damagedTileCount(state),
    repairPerTick: state.lastRepairCost,
  };
}

function info(event: DisasterEvent, ticks: number): DisasterInfo {
  return {
    id: event.id,
    kind: event.kind,
    severity: event.severity,
    ticks: Math.max(0, ticks),
    origin: event.origin,
    tiles: [...event.tiles],
  };
}
```

Extend the imports with `type DisasterInfo`, `type DisasterStats`.

- [ ] **Step 4: Wire the lifecycle into the tick in `src/sim/tick.ts`**

Import `disasterStats, disastersStep` and call the step right after
`updateWeather`:

```ts
updateWeather(state);
// Before generation and connectivity: this tick's damage must already
// be in effect when the energy balance is computed.
disastersStep(state);
```

and in `buildStats`, after `services`:

```ts
    disasters: disasterStats(state),
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run src/sim/disasters.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the whole suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS (`GlobalStats` gained a required field — fix any test or
UI helper that builds a `GlobalStats` literal by hand).

- [ ] **Step 7: Commit**

```bash
pnpm format
git add -A
git commit -m "feat(sim): the disaster lifecycle

Risk, warning with a countdown, active event, retirement — one framework
in disasters.ts, with the three kinds injected as DisasterSpec objects.
The cooldown spaces events out, the city's intensity factor scales every
risk, and GlobalStats now carries what is in flight.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Storms — wind cut-out and city-wide strikes

**Files:**

- Create: `src/sim/storm.ts`, `src/sim/storm.test.ts`
- Modify: `src/sim/weather.ts` (cut-out branch, gust in the effective wind)
- Modify: `src/shared/types.ts` (`Weather.gust`)
- Modify: `src/sim/state.ts` (initial `gust`)
- Modify: `src/sim/disasters.ts` (`DISASTER_SPECS`)

**Interfaces:**

- Consumes: `DisasterSpec`, `addDamage` (Tasks 3–4); `frontMeans` from
  `./weather.ts`.
- Produces:
  - `stormSpec: DisasterSpec`, `stormRisk(state): number`,
    `stormGust(state): number` from `src/sim/storm.ts`
  - `effectiveWind(weather: Weather): number` from `src/sim/weather.ts`
  - `Weather.gust: number`

- [ ] **Step 1: Write the failing test**

Create `src/sim/storm.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BALANCE } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { DisasterKind, PlantType } from '../shared/types.ts';
import { placePlant } from './energy.ts';
import { recomputeGrid } from './powerGrid.ts';
import { buildPowerLines } from './powerLines.ts';
import { createSimState, type SimState } from './state.ts';
import { stormGust, stormSpec } from './storm.ts';
import { effectiveWind, windFactor } from './weather.ts';

const SIZE = 24;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);

function storm(state: SimState, severity = 1) {
  const plan = stormSpec.plan(state, severity);
  if (plan === null) throw new Error('the storm found no target');
  return {
    id: 1,
    kind: DisasterKind.Storm,
    severity,
    startTick: state.tick,
    endTick: state.tick + stormSpec.durationTicks,
    ...plan,
  };
}

describe('windFactor', () => {
  it('is zero below the cut-in speed', () => {
    expect(windFactor(BALANCE.energy.windCutInSpeed - 0.01)).toBe(0);
  });

  it('is zero at and above the cut-out speed — the rotors feather', () => {
    expect(windFactor(BALANCE.energy.windCutOutSpeed)).toBe(0);
    expect(windFactor(1)).toBe(0);
  });

  it('peaks just below the cut-out speed', () => {
    expect(windFactor(BALANCE.energy.windCutOutSpeed - 0.01)).toBeGreaterThan(0.9);
  });
});

describe('the storm gust', () => {
  it('is zero without a storm', () => {
    expect(stormGust(createSimState(1, SIZE))).toBe(0);
  });

  it('drives the effective wind over the cut-out speed at full severity', () => {
    const state = createSimState(1, SIZE);
    placePlant(state, at(5, 5), PlantType.WindTurbine);
    state.weather.windSpeed = 0.5;
    state.disasters.active.push(storm(state, 1));
    state.weather.gust = stormGust(state);
    expect(effectiveWind(state.weather)).toBeGreaterThanOrEqual(BALANCE.energy.windCutOutSpeed);
    expect(windFactor(effectiveWind(state.weather))).toBe(0);
  });
});

describe('storm strikes', () => {
  it('damages pylons and can island a district', () => {
    const state = createSimState(3, SIZE);
    placePlant(state, at(2, 2), PlantType.WindTurbine);
    const line = [at(3, 2), at(4, 2), at(5, 2), at(6, 2), at(7, 2), at(8, 2)];
    buildPowerLines(state, line);
    recomputeGrid(state);
    expect(state.layers.energized[at(8, 2)]).toBe(1);

    const event = storm(state, 1);
    state.disasters.active.push(event);
    for (let i = 0; i < stormSpec.durationTicks; i++) stormSpec.apply(state, event);

    expect(event.tiles.length).toBeGreaterThan(0);
    const damagedLines = line.filter((index) => state.layers.damage[index] !== 0);
    expect(damagedLines.length).toBeGreaterThan(0);
    recomputeGrid(state);
    expect(state.layers.energized[at(8, 2)]).toBe(0);
  });

  it('never damages a road', () => {
    const state = createSimState(4, SIZE);
    placePlant(state, at(2, 2), PlantType.WindTurbine);
    for (let x = 3; x < 20; x++) state.layers.tileType[at(x, 10)] = 1; // TileType.Road
    const event = storm(state, 1);
    state.disasters.active.push(event);
    for (let i = 0; i < stormSpec.durationTicks; i++) stormSpec.apply(state, event);
    for (let x = 3; x < 20; x++) {
      if (state.layers.powerLine[at(x, 10)] !== 0) continue;
      expect(state.layers.damage[at(x, 10)]).toBe(0);
    }
  });

  it('runs its full duration', () => {
    const state = createSimState(5, SIZE);
    placePlant(state, at(2, 2), PlantType.WindTurbine);
    const event = storm(state, 1);
    expect(stormSpec.apply(state, event)).toBe(false);
  });

  it('finds no site in an empty city', () => {
    expect(stormSpec.plan(createSimState(1, SIZE), 1)).toBe(null);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/sim/storm.test.ts`
Expected: FAIL — `./storm.ts` does not exist, `effectiveWind` is not
exported.

- [ ] **Step 3: Add the gust to the weather in `src/shared/types.ts`**

In the `Weather` interface:

```ts
/**
 * Storm gust on top of the random walk, 0..1. Derived from the active
 * storms each tick, never persisted: a reloaded city recomputes it.
 */
gust: number;
```

In `src/sim/state.ts`'s `createSimState`, add `gust: 0,` to the
`weather` literal. Anything constructing a `Weather` literal in tests
needs the field too.

- [ ] **Step 4: Cut-out and effective wind in `src/sim/weather.ts`**

```ts
/**
 * Wind speed the turbines actually see: the random walk plus the gust an
 * active storm adds, clamped to 1.
 */
export function effectiveWind(weather: Weather): number {
  return Math.min(1, weather.windSpeed + weather.gust);
}

/**
 * Wind turbine output factor 0..1. Below the cut-in speed the rotor
 * stands still; above it output rises with the cube of wind speed, as
 * with real turbines — until the cut-out speed, where the blades feather
 * and output drops to nothing. A storm is therefore not a windfall but a
 * blackout risk.
 */
export function windFactor(windSpeed: number): number {
  const { windCutInSpeed, windCutOutSpeed } = BALANCE.energy;
  if (windSpeed < windCutInSpeed) return 0;
  if (windSpeed >= windCutOutSpeed) return 0;
  return Math.min(1, windSpeed ** 3 / 0.6 ** 3);
}
```

and let the convenience accessor use it:

```ts
/** Convenience: current wind factor of the simulation state. */
export function currentWindFactor(state: SimState): number {
  return windFactor(effectiveWind(state.weather));
}
```

Import `type Weather` from `../shared/types.ts`.

- [ ] **Step 5: Create `src/sim/storm.ts`**

```ts
import { BALANCE } from '../shared/constants.ts';
import { DisasterKind, PlantType, TileType, type DisasterEvent } from '../shared/types.ts';
import { addDamage, type DisasterSpec } from './disasters.ts';
import type { SimState } from './state.ts';
import { frontMeans } from './weather.ts';

/**
 * Storm risk from the *front's* wind mean, not the momentary wind: a
 * building wind high is the warning behind the warning, and it is
 * readable in the HUD's wind display days ahead. Winter storms are more
 * likely, as they are in reality.
 */
export function stormRisk(state: SimState): number {
  const cfg = BALANCE.disasters.storm;
  const { windMean } = frontMeans(state.seed, state.tick, state.season);
  if (windMean <= cfg.windThreshold) return 0;
  const ramp = (windMean - cfg.windThreshold) / (1 - cfg.windThreshold);
  const winter = state.season.season === 'winter' ? cfg.winterFactor : 1;
  return cfg.baseRisk * ramp * winter;
}

/**
 * Gust the active storms add to the wind. Severe storms push the city
 * over the turbines' cut-out speed, so the wind fleet stops exactly when
 * the wind is strongest; a moderate storm only runs it flat out.
 */
export function stormGust(state: SimState): number {
  const cfg = BALANCE.disasters.storm;
  let gust = 0;
  for (const event of state.disasters.active) {
    if (event.kind !== DisasterKind.Storm) continue;
    gust = Math.max(gust, cfg.gust * event.severity);
  }
  return gust;
}

/** Damage points one strike does to this tile, by what stands on it. */
function strikeDamage(state: SimState, index: number): number {
  const { damage } = BALANCE.disasters.storm;
  const { tileType, plantType, powerLine } = state.layers;
  if (powerLine[index] !== 0) return damage.line;
  if (tileType[index] === TileType.Plant) {
    return plantType[index] === PlantType.WindTurbine ? damage.turbine : damage.plant;
  }
  return damage.building;
}

/**
 * Weighted pool of everything a storm can wreck: pylons and turbines
 * weigh heaviest, other plants less, buildings least. Roads are absent —
 * a storm never damages a road (a line ON a road is a line, and the road
 * under it stays passable, because nothing in routing reads `damage`).
 * Already damaged tiles are absent too, so a storm spreads its hits.
 */
function targets(state: SimState): number[] {
  const cfg = BALANCE.disasters.storm;
  const { tileType, plantType, powerLine, density, damage } = state.layers;
  const pool: number[] = [];
  for (let i = 0; i < tileType.length; i++) {
    if (damage[i] !== 0) continue;
    let weight = 0;
    if (powerLine[i] !== 0) weight = cfg.weights.line;
    else if (tileType[i] === TileType.Plant) {
      weight = plantType[i] === PlantType.WindTurbine ? cfg.weights.turbine : cfg.weights.plant;
    } else if (tileType[i] === TileType.Empty && density[i] > 0) {
      weight = cfg.weights.building;
    }
    for (let w = 0; w < weight; w++) pool.push(i);
  }
  return pool;
}

export const stormSpec: DisasterSpec = {
  kind: DisasterKind.Storm,
  warnTicks: BALANCE.disasters.storm.warnTicks,
  durationTicks: BALANCE.disasters.storm.durationTicks,
  severityRange: BALANCE.disasters.storm.severityRange,
  risk: stormRisk,
  plan(state, _severity) {
    const pool = targets(state);
    if (pool.length === 0) return null;
    // The storm is global; `origin` is only the marker's anchor.
    const origin = pool[state.rng.nextInt(pool.length)];
    return { origin, tiles: [], intensity: [] };
  },
  apply(state, event) {
    const cfg = BALANCE.disasters.storm;
    const pool = targets(state);
    if (pool.length === 0) return false;
    const hits = Math.max(1, Math.round(cfg.hitsPerTick * event.severity));
    for (let n = 0; n < hits; n++) {
      const index = pool[state.rng.nextInt(pool.length)];
      addDamage(state, index, strikeDamage(state, index) * event.severity);
      // Struck tiles join the event so they are not repaired mid-storm.
      // Linear search: a storm collects a few hundred tiles at most.
      if (!event.tiles.includes(index)) {
        event.tiles.push(index);
        event.intensity.push(0);
      }
    }
    return false; // a storm always blows itself out on schedule
  },
};

/** Type-only re-export so the spec's apply signature stays readable. */
export type { DisasterEvent };
```

Drop the final re-export if the linter objects; it is only there for
readability.

- [ ] **Step 6: Register the kind and keep the gust fresh**

In `src/sim/disasters.ts`:

```ts
import { stormGust, stormSpec } from './storm.ts';

export const DISASTER_SPECS: readonly DisasterSpec[] = [stormSpec];
```

and at the end of `disastersStep`, before the roll:

```ts
// The gust is derived state: recomputed every tick from what is active.
state.weather.gust = stormGust(state);
```

Place this assignment after the activate/apply phases and before the
`return`s, so it runs on every tick.

- [ ] **Step 7: Run the tests**

Run: `pnpm vitest run src/sim/storm.test.ts src/sim/disasters.test.ts src/sim/weather.test.ts src/sim/energy.test.ts`
Expected: PASS. If a weather or energy test asserted output at wind speed
1, it now legitimately reads 0 — update it to a speed below the cut-out
and note why.

- [ ] **Step 8: Run the whole suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
pnpm format
git add -A
git commit -m "feat(sim): storms, with a real turbine cut-out

A storm is announced four in-game hours ahead, adds a gust to the wind
and strikes a few pylons, turbines, plants and buildings per tick.
windFactor gains the cut-out branch real turbines have, so a severe
storm takes the whole wind fleet off the grid while the wind peaks.
Roads are never struck.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Fires — ignition where coverage is missing, and spread

**Files:**

- Create: `src/sim/fire.ts`, `src/sim/fire.test.ts`
- Modify: `src/sim/disasters.ts` (`DISASTER_SPECS`)

**Interfaces:**

- Consumes: `DisasterSpec`, `addDamage`; `clearForest` from `./forest.ts`;
  `SERVICE_FIRE` from `./services.ts`; `neighbors4` from `../shared/grid.ts`.
- Produces: `fireSpec: DisasterSpec`, `fireRisk(state): number`,
  `dryness(state): number`, `fireCandidates(state): number[]` from
  `src/sim/fire.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/sim/fire.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BALANCE } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { DisasterKind, PlantType, TileType, Zone } from '../shared/types.ts';
import { placePlant } from './energy.ts';
import { dryness, fireCandidates, fireRisk, fireSpec } from './fire.ts';
import { buildRoads } from './roads.ts';
import { recomputeServices, SERVICE_FIRE } from './services.ts';
import { createSimState, type SimState } from './state.ts';

const SIZE = 24;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);

/** A dry summer city: warm, cloudless, no snow. */
function dryCity(seed = 1): SimState {
  const state = createSimState(seed, SIZE);
  state.season = { ...state.season, temperature: 26 };
  state.weather.cloudCover = 0;
  state.weather.snowpack = 0;
  return state;
}

function block(state: SimState, x0: number, x1: number, y: number, density = 3): void {
  for (let x = x0; x <= x1; x++) {
    state.layers.zone[at(x, y)] = Zone.Residential;
    state.layers.density[at(x, y)] = density;
  }
}

function fire(state: SimState, origin: number, severity = 1) {
  return {
    id: 1,
    kind: DisasterKind.Fire,
    severity,
    startTick: state.tick,
    endTick: state.tick + fireSpec.durationTicks,
    origin,
    tiles: [origin],
    intensity: [BALANCE.disasters.fire.burnTicks],
  };
}

describe('dryness', () => {
  it('is high in a warm, cloudless, snow-free city', () => {
    expect(dryness(dryCity())).toBeGreaterThan(0.8);
  });

  it('is zero under snow', () => {
    const state = dryCity();
    state.weather.snowpack = 1;
    expect(dryness(state)).toBe(0);
  });

  it('is zero in overcast weather', () => {
    const state = dryCity();
    state.weather.cloudCover = 1;
    expect(dryness(state)).toBe(0);
  });
});

describe('fireRisk', () => {
  it('is zero in a city with nothing to burn', () => {
    expect(fireRisk(dryCity())).toBe(0);
  });

  it('falls once the buildings have fire cover', () => {
    const bare = dryCity();
    block(bare, 4, 11, 4);
    const risky = fireRisk(bare);

    const covered = dryCity();
    block(covered, 4, 11, 4);
    buildRoads(covered, [at(7, 6)]);
    placePlant(covered, at(7, 5), PlantType.FireStation);
    placePlant(covered, at(8, 5), PlantType.WindTurbine);
    recomputeServices(covered);
    expect((covered.layers.services[at(7, 4)] & SERVICE_FIRE) !== 0).toBe(true);

    expect(fireRisk(covered)).toBeLessThan(risky);
  });

  it('lists mature woods as ignition candidates in a drought', () => {
    const state = dryCity();
    state.layers.forest[at(9, 9)] = BALANCE.forest.maxStage;
    expect(fireCandidates(state)).toContain(at(9, 9));
  });
});

describe('a burning city', () => {
  it('spreads along a row of buildings', () => {
    const state = dryCity(11);
    block(state, 4, 14, 4);
    const event = fire(state, at(4, 4));
    for (let i = 0; i < fireSpec.durationTicks; i++) fireSpec.apply(state, event);
    expect(event.tiles.length).toBeGreaterThan(1);
    expect(state.layers.damage[at(4, 4)]).toBeGreaterThan(0);
  });

  it('stops at a road — roads are firebreaks', () => {
    const state = dryCity(12);
    block(state, 4, 6, 4);
    buildRoads(state, [at(7, 4)]);
    block(state, 8, 12, 4);
    const event = fire(state, at(4, 4));
    for (let i = 0; i < fireSpec.durationTicks; i++) fireSpec.apply(state, event);
    expect(state.layers.damage[at(7, 4)]).toBe(0);
    for (let x = 8; x <= 12; x++) expect(state.layers.damage[at(x, 4)]).toBe(0);
  });

  it('burns out faster under fire cover', () => {
    const burn = (covered: boolean): number => {
      const state = dryCity(13);
      block(state, 4, 14, 4);
      if (covered) {
        for (let x = 4; x <= 14; x++) state.layers.services[at(x, 4)] = SERVICE_FIRE;
      }
      const event = fire(state, at(4, 4));
      let ticks = 0;
      while (ticks < fireSpec.durationTicks && !fireSpec.apply(state, event)) ticks++;
      return event.tiles.length;
    };
    expect(burn(true)).toBeLessThan(burn(false));
  });

  it('burns woods down to bare ground instead of damaging them', () => {
    const state = dryCity(14);
    state.layers.forest[at(5, 5)] = BALANCE.forest.maxStage;
    const event = fire(state, at(5, 5));
    fireSpec.apply(state, event);
    expect(state.layers.forest[at(5, 5)]).toBe(0);
    expect(state.layers.damage[at(5, 5)]).toBe(0);
  });

  it('reports itself finished once everything is out', () => {
    const state = dryCity(15);
    state.layers.zone[at(5, 5)] = Zone.Residential;
    state.layers.density[at(5, 5)] = 1;
    const event = fire(state, at(5, 5));
    let done = false;
    for (let i = 0; i < fireSpec.durationTicks && !done; i++) done = fireSpec.apply(state, event);
    expect(done).toBe(true);
  });

  it('finds no site when there is nothing flammable', () => {
    const state = dryCity(16);
    state.layers.tileType[at(5, 5)] = TileType.Road;
    expect(fireSpec.plan(state, 1)).toBe(null);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/sim/fire.test.ts`
Expected: FAIL — `./fire.ts` does not exist.

- [ ] **Step 3: Create `src/sim/fire.ts`**

```ts
import { BALANCE } from '../shared/constants.ts';
import { neighbors4 } from '../shared/grid.ts';
import { DisasterKind, TileType } from '../shared/types.ts';
import { addDamage, type DisasterSpec } from './disasters.ts';
import { clearForest } from './forest.ts';
import { SERVICE_FIRE } from './services.ts';
import type { SimState } from './state.ts';

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * How dry the city is, 0..1: warm, cloudless and snow-free weather dries
 * it out. All three factors multiply, so a single wet one keeps the city
 * safe — a winter fire is effectively impossible.
 */
export function dryness(state: SimState): number {
  const cfg = BALANCE.disasters.fire;
  const warm = clamp01((state.season.temperature - cfg.dryTemperature) / cfg.dryTemperatureSpan);
  const clear = clamp01((cfg.dryCloudCeiling - state.weather.cloudCover) / cfg.dryCloudCeiling);
  const snowFree = 1 - clamp01(state.weather.snowpack);
  return warm * clear * snowFree;
}

/**
 * Weighted pool of ignition sites: dense buildings weigh by density, and
 * four times as much without fire cover — so every station measurably
 * lowers the chance of a fire, not just its consequences. Mature woods
 * join the pool: in a drought the forest is fuel.
 */
export function fireCandidates(state: SimState): number[] {
  const cfg = BALANCE.disasters.fire;
  const { tileType, density, services, forest, damage } = state.layers;
  const pool: number[] = [];
  for (let i = 0; i < tileType.length; i++) {
    if (damage[i] !== 0) continue;
    if (tileType[i] === TileType.Empty && density[i] > 0) {
      const covered = (services[i] & SERVICE_FIRE) !== 0;
      const weight =
        density[i] * (covered ? cfg.coveredIgnitionWeight : cfg.uncoveredIgnitionWeight);
      for (let w = 0; w < weight; w++) pool.push(i);
    } else if (forest[i] >= BALANCE.forest.maxStage) {
      pool.push(i);
    }
  }
  return pool;
}

/** Fires need fuel and drought; the exposure saturates on a big city. */
export function fireRisk(state: SimState): number {
  const cfg = BALANCE.disasters.fire;
  const dry = dryness(state);
  if (dry <= 0) return 0;
  const pool = fireCandidates(state);
  if (pool.length === 0) return 0;
  const exposure = Math.min(1, pool.length / cfg.exposureSaturation);
  return cfg.baseRisk * dry * exposure;
}

/** Buildings and woods burn; roads, water, plants and bare land do not. */
function isFlammable(state: SimState, index: number): boolean {
  const { tileType, density, forest, damage } = state.layers;
  if (damage[index] !== 0) return false;
  if (forest[index] !== 0) return true;
  return tileType[index] === TileType.Empty && density[index] > 0;
}

export const fireSpec: DisasterSpec = {
  kind: DisasterKind.Fire,
  warnTicks: BALANCE.disasters.fire.warnTicks,
  durationTicks: BALANCE.disasters.fire.durationTicks,
  severityRange: BALANCE.disasters.fire.severityRange,
  risk: fireRisk,
  plan(state, _severity) {
    const pool = fireCandidates(state);
    if (pool.length === 0) return null;
    const origin = pool[state.rng.nextInt(pool.length)];
    return {
      origin,
      tiles: [origin],
      intensity: [BALANCE.disasters.fire.burnTicks],
    };
  },
  apply(state, event) {
    const cfg = BALANCE.disasters.fire;
    const { services, forest } = state.layers;
    // Snapshot the length: tiles that catch this tick only act from the
    // next one, so a fire cannot race across the map in a single tick.
    const burning = event.tiles.length;
    for (let n = 0; n < burning; n++) {
      if (event.intensity[n] <= 0) continue;
      const index = event.tiles[n];
      const covered = (services[index] & SERVICE_FIRE) !== 0;

      if (forest[index] !== 0) {
        // Woods burn away rather than break: nothing here to repair.
        clearForest(state, index);
      } else {
        addDamage(state, index, cfg.damagePerTick * event.severity);
      }

      event.intensity[n] -= covered ? cfg.extinguishCovered : 1;
      if (event.intensity[n] <= 0) continue;

      const spread = (covered ? cfg.spreadChanceCovered : cfg.spreadChance) * event.severity;
      for (const neighbor of neighbors4(index, state.size)) {
        if (!isFlammable(state, neighbor) || event.tiles.includes(neighbor)) continue;
        if (!state.rng.chance(spread)) continue;
        event.tiles.push(neighbor);
        event.intensity.push(cfg.burnTicks);
      }
    }
    return event.intensity.every((ticks) => ticks <= 0);
  },
};
```

- [ ] **Step 4: Register the kind**

In `src/sim/disasters.ts`:

```ts
import { fireSpec } from './fire.ts';

export const DISASTER_SPECS: readonly DisasterSpec[] = [stormSpec, fireSpec];
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run src/sim/fire.test.ts src/sim/disasters.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the whole suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
pnpm format
git add -A
git commit -m "feat(sim): fires, and a real job for the fire stations

Ignition risk grows with drought and with the share of dense buildings
that have no fire cover, so a station lowers the chance of a fire as well
as its spread. Fires jump to flammable 4-neighbours, are held and put out
faster inside coverage, stop at roads and water, and burn woods down to
bare ground. Nothing burns past the duration cap.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: River floods — a computed floodplain

**Files:**

- Create: `src/sim/flood.ts`, `src/sim/flood.test.ts`
- Modify: `src/sim/disasters.ts` (`DISASTER_SPECS`)

**Interfaces:**

- Consumes: `DisasterSpec`, `addDamage`; `Terrain` from `../shared/types.ts`.
- Produces: `floodSpec: DisasterSpec`, `floodRisk(state): number`,
  `floodArea(state, severity): { tiles: number[]; depth: number[] }` from
  `src/sim/flood.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/sim/flood.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BALANCE } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { DisasterKind, PlantType, Terrain, Zone } from '../shared/types.ts';
import { placePlant } from './energy.ts';
import { floodArea, floodRisk, floodSpec } from './flood.ts';
import { createSimState, type SimState } from './state.ts';
import { generateTerrain } from './terrain.ts';
import { generateWater } from './water.ts';

const SIZE = 32;
const at = (x: number, y: number) => tileIndex(x, y, SIZE);

/** A map with a real river carved into real relief. */
function river(seed = 1): SimState {
  const state = createSimState(seed, SIZE);
  generateTerrain(state);
  generateWater(state);
  return state;
}

/** A flat valley: one river column at elevation 0, land rising to the east. */
function valley(): SimState {
  const state = createSimState(2, SIZE);
  for (let y = 0; y < SIZE; y++) {
    state.layers.terrain[at(0, y)] = Terrain.River;
    for (let x = 1; x < SIZE; x++) state.layers.elevation[at(x, y)] = Math.min(7, x);
  }
  return state;
}

describe('floodRisk', () => {
  it('is zero while the river runs low', () => {
    const state = river();
    state.weather.riverFlow = 0.2;
    expect(floodRisk(state)).toBe(0);
  });

  it('rises with the flow and again with a melting snowpack', () => {
    const state = river();
    state.weather.riverFlow = 1;
    state.weather.snowpack = 0;
    state.season = { ...state.season, temperature: 20 };
    const plain = floodRisk(state);
    state.weather.snowpack = 0.5;
    expect(floodRisk(state)).toBeGreaterThan(plain);
    expect(plain).toBeGreaterThan(0);
  });
});

describe('floodArea', () => {
  it('covers the low ground next to the water and nothing above the water line', () => {
    const state = valley();
    const { tiles, depth } = floodArea(state, 1);
    const rise = BALANCE.disasters.flood.maxRise;
    expect(tiles.length).toBeGreaterThan(0);
    for (const index of tiles) {
      expect(state.layers.elevation[index]).toBeLessThanOrEqual(rise);
      expect(state.layers.terrain[index]).toBe(Terrain.Land);
    }
    expect(tiles).toContain(at(1, 5));
    expect(tiles).not.toContain(at(7, 5));
    expect(depth).toHaveLength(tiles.length);
  });

  it('is deterministic for the same map and severity', () => {
    const a = floodArea(valley(), 0.7).tiles;
    const b = floodArea(valley(), 0.7).tiles;
    expect(a).toEqual(b);
  });

  it('grows with severity and never shrinks', () => {
    const state = valley();
    const small = floodArea(state, 0.2).tiles.length;
    const large = floodArea(state, 1).tiles.length;
    expect(large).toBeGreaterThanOrEqual(small);
  });

  it('leaves the terrain layer untouched', () => {
    const state = river(5);
    const before = Uint8Array.from(state.layers.terrain);
    const plan = floodSpec.plan(state, 1);
    expect(plan).not.toBe(null);
    const event = {
      id: 1,
      kind: DisasterKind.Flood,
      severity: 1,
      startTick: 0,
      endTick: 100,
      ...plan!,
    };
    for (let i = 0; i < 20; i++) floodSpec.apply(state, event);
    expect(state.layers.terrain).toEqual(before);
  });
});

describe('a flood in progress', () => {
  it('damages what stands in the floodplain and leaves bare land alone', () => {
    const state = valley();
    state.layers.zone[at(1, 5)] = Zone.Residential;
    state.layers.density[at(1, 5)] = 2;
    placePlant(state, at(1, 7), PlantType.SolarFarm);
    const plan = floodSpec.plan(state, 1)!;
    const event = {
      id: 1,
      kind: DisasterKind.Flood,
      severity: 1,
      startTick: 0,
      endTick: 100,
      ...plan,
    };
    floodSpec.apply(state, event);
    expect(state.layers.damage[at(1, 5)]).toBeGreaterThan(0);
    expect(state.layers.damage[at(1, 7)]).toBeGreaterThan(0);
    expect(state.layers.damage[at(1, 9)]).toBe(0); // bare land just gets wet
  });

  it('runs its full duration', () => {
    const state = valley();
    const plan = floodSpec.plan(state, 1)!;
    expect(
      floodSpec.apply(state, {
        id: 1,
        kind: DisasterKind.Flood,
        severity: 1,
        startTick: 0,
        endTick: 100,
        ...plan,
      }),
    ).toBe(false);
  });

  it('finds no site on a map without a river', () => {
    expect(floodSpec.plan(createSimState(1, SIZE), 1)).toBe(null);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/sim/flood.test.ts`
Expected: FAIL — `./flood.ts` does not exist.

- [ ] **Step 3: Create `src/sim/flood.ts`**

```ts
import { BALANCE } from '../shared/constants.ts';
import { neighbors4 } from '../shared/grid.ts';
import { DisasterKind, Terrain, TileType } from '../shared/types.ts';
import { addDamage, type DisasterSpec } from './disasters.ts';
import type { SimState } from './state.ts';

/**
 * Flood risk from the river itself: a flow near its maximum, and again
 * as much while a snowpack melts in warm weather — the spring melt peak
 * the seasons already produce.
 */
export function floodRisk(state: SimState): number {
  const cfg = BALANCE.disasters.flood;
  const { riverFlow, snowpack } = state.weather;
  if (riverFlow <= cfg.flowThreshold) return 0;
  const ramp = (riverFlow - cfg.flowThreshold) / (1 - cfg.flowThreshold);
  const melting = snowpack > 0 && state.season.temperature > BALANCE.seasons.meltTemperature;
  return cfg.baseRisk * ramp * (melting ? cfg.meltFactor : 1);
}

/**
 * The floodplain at this severity: a height-ordered fill outward from
 * every river and lake tile. Each water tile floods the land around it up
 * to its own bed elevation plus `rise`, and carries that water line
 * inland as far as the ground stays below it.
 *
 * Purely a function of the map and the severity — the same city floods
 * the same ground every time, so building in the floodplain is an
 * informed choice after the first flood. The terrain layer is never
 * touched: the inundation lives only in `damage` and the event's tiles.
 */
export function floodArea(state: SimState, severity: number): { tiles: number[]; depth: number[] } {
  const cfg = BALANCE.disasters.flood;
  const rise = Math.max(1, Math.round(cfg.maxRise * severity));
  const { terrain, elevation } = state.layers;
  // Water line each tile is reached with; -1 = dry.
  const level = new Int16Array(terrain.length).fill(-1);
  const queue: number[] = [];
  for (let i = 0; i < terrain.length; i++) {
    if (terrain[i] !== Terrain.River && terrain[i] !== Terrain.Lake) continue;
    level[i] = elevation[i] + rise;
    queue.push(i);
  }
  for (let head = 0; head < queue.length; head++) {
    const index = queue[head];
    for (const neighbor of neighbors4(index, state.size)) {
      if (terrain[neighbor] !== Terrain.Land) continue;
      if (elevation[neighbor] > level[index]) continue;
      if (level[neighbor] >= level[index]) continue;
      level[neighbor] = level[index];
      queue.push(neighbor);
    }
  }
  const tiles: number[] = [];
  const depth: number[] = [];
  for (let i = 0; i < terrain.length; i++) {
    if (terrain[i] !== Terrain.Land || level[i] < 0) continue;
    tiles.push(i);
    depth.push(Math.max(0, level[i] - elevation[i]));
  }
  return { tiles, depth };
}

/** Buildings, plants and lines drown; bare land just gets wet. */
function isVulnerable(state: SimState, index: number): boolean {
  const { tileType, density, powerLine } = state.layers;
  if (powerLine[index] !== 0) return true;
  if (tileType[index] === TileType.Plant) return true;
  return tileType[index] === TileType.Empty && density[index] > 0;
}

export const floodSpec: DisasterSpec = {
  kind: DisasterKind.Flood,
  warnTicks: BALANCE.disasters.flood.warnTicks,
  durationTicks: BALANCE.disasters.flood.durationTicks,
  severityRange: BALANCE.disasters.flood.severityRange,
  risk: floodRisk,
  plan(state, severity) {
    const { tiles, depth } = floodArea(state, severity);
    if (tiles.length === 0) return null;
    // The deepest tile anchors the marker: that is where the water is worst.
    let origin = tiles[0];
    let deepest = depth[0];
    for (let i = 1; i < tiles.length; i++) {
      if (depth[i] > deepest) {
        deepest = depth[i];
        origin = tiles[i];
      }
    }
    return { origin, tiles, intensity: depth };
  },
  apply(state, event) {
    const cfg = BALANCE.disasters.flood;
    for (let i = 0; i < event.tiles.length; i++) {
      const index = event.tiles[i];
      if (!isVulnerable(state, index)) continue;
      const deeper = 1 + event.intensity[i] * cfg.depthFactor;
      addDamage(state, index, cfg.damagePerTick * event.severity * deeper);
    }
    return false; // the water recedes on schedule
  },
};
```

- [ ] **Step 4: Register the kind**

In `src/sim/disasters.ts`:

```ts
import { floodSpec } from './flood.ts';

export const DISASTER_SPECS: readonly DisasterSpec[] = [stormSpec, fireSpec, floodSpec];
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run src/sim/flood.test.ts src/sim/disasters.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the whole suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
pnpm format
git add -A
git commit -m "feat(sim): river floods over a computed floodplain

A flood is announced six in-game hours ahead and covers the ground a
height-ordered fill from the river and the lake reaches at its severity —
the same city floods the same plain every time. Buildings, plants and
lines take damage by depth; bare land only gets wet, and the terrain
layer is never overwritten.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Determinism and save/load in the middle of a disaster

**Files:**

- Modify: `src/sim/disasters.test.ts`
- Modify: whatever the tests expose as broken (expected: nothing)

**Interfaces:**

- Consumes: everything from Tasks 1–7.
- Produces: no new API; the guarantee that a reload reproduces the
  disaster sequence.

- [ ] **Step 1: Write the failing test**

Append to `src/sim/disasters.test.ts`:

```ts
import { SimEngine } from './engine.ts';

/** A scripted city that reliably faces events: dry, dense, unprotected. */
function scriptedCity(seed: number): SimEngine {
  const engine = new SimEngine(seed, 32);
  engine.applyCommand({ type: 'init', seed, size: 32 });
  const state = engine.state;
  state.disasterScale = 1.6;
  for (let y = 4; y < 14; y++) {
    for (let x = 4; x < 14; x++) {
      if (state.layers.terrain[tileIndex(x, y, 32)] !== 0) continue;
      state.layers.zone[tileIndex(x, y, 32)] = Zone.Residential;
      state.layers.density[tileIndex(x, y, 32)] = 3;
    }
  }
  return engine;
}

describe('determinism', () => {
  it('produces the same events twice for the same seed', () => {
    const run = (): string => {
      const engine = scriptedCity(42);
      const log: string[] = [];
      for (let i = 0; i < 3000; i++) {
        engine.tick();
        for (const event of engine.state.disasters.active) {
          log.push(`${engine.state.tick}:${event.kind}:${event.id}`);
        }
      }
      return log.join(',');
    };
    expect(run()).toBe(run());
  });

  it('restores a warning and a running fire across a save/load', () => {
    const engine = scriptedCity(7);
    engine.state.disasters.pending.push({
      id: 100,
      kind: DisasterKind.Flood,
      severity: 0.8,
      startTick: engine.state.tick + 200,
      endTick: engine.state.tick + 500,
      origin: at(5, 5),
      tiles: [at(5, 5)],
      intensity: [2],
    });
    engine.state.disasters.active.push({
      id: 101,
      kind: DisasterKind.Fire,
      severity: 1,
      startTick: engine.state.tick,
      endTick: engine.state.tick + 40,
      origin: at(6, 6),
      tiles: [at(6, 6), at(6, 7)],
      intensity: [20, 12],
    });
    addDamage(engine.state, at(6, 6), 30);

    const loaded = deserializeState(serializeState(engine.state));
    expect(loaded.disasters.pending[0].id).toBe(100);
    expect(loaded.disasters.pending[0].startTick).toBe(engine.state.disasters.pending[0].startTick);
    expect(loaded.disasters.active[0].tiles).toEqual([at(6, 6), at(6, 7)]);
    expect(loaded.disasters.active[0].intensity).toEqual([20, 12]);
    expect(loaded.layers.damage[at(6, 6)]).toBe(30);
    expect(loaded.disasterScale).toBe(1.6);
  });

  it('keeps a loaded city running without throwing', () => {
    const engine = scriptedCity(9);
    for (let i = 0; i < 500; i++) engine.tick();
    const loaded = new SimEngine(9, 32);
    loaded.applyCommand({ type: 'init', seed: 9, size: 32, save: serializeState(engine.state) });
    for (let i = 0; i < 500; i++) loaded.tick();
    expect(loaded.state.tick).toBeGreaterThan(engine.state.tick);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `pnpm vitest run src/sim/disasters.test.ts`
Expected: PASS. If the determinism test fails, the cause is
non-RNG randomness or iteration over a `Set`/`Map` whose order depends on
insertion from a non-deterministic source — find it with
`superpowers:systematic-debugging`, do not paper over it by loosening the
assertion.

- [ ] **Step 3: Run the whole suite and the coverage gate**

Run: `pnpm typecheck && pnpm coverage`
Expected: PASS, `src/sim` ≥ 90 %. Add focused tests for any uncovered
branch in the new modules (typically the "no site" and "empty pool"
paths).

- [ ] **Step 4: Commit**

```bash
pnpm format
git add -A
git commit -m "test(sim): disasters are reproducible and survive a reload

Two engines with the same seed face the same events, and a save taken
during a warning and a running fire restores both, with their per-tile
burn timers and the damage already done.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Choosing the intensity when founding a city

**Files:**

- Modify: `src/ui/newGame.ts`, `src/ui/NewGamePage.tsx`
- Modify: `src/shared/messages.ts`, `src/sim/engine.ts`, `src/ui/useSimBridge.ts`
- Modify: `src/ui/App.tsx` (pass the option through)
- Modify: `src/ui/i18n.tsx`
- Test: `src/ui/useTools.test.ts` is unrelated; add a small test file
  `src/ui/newGame.test.ts`

**Interfaces:**

- Consumes: `SimState.disasterScale` (Task 1).
- Produces:
  - `NewGameOptions.disasterScale: number`
  - `DISASTER_LEVELS: ReadonlyArray<{ id: string; scale: number }>` in `src/ui/newGame.ts`
  - `SimCommand` `init` gains `disasterScale?: number`

- [ ] **Step 1: Write the failing test**

Create `src/ui/newGame.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_NEW_GAME, DISASTER_LEVELS } from './newGame.ts';

describe('disaster levels', () => {
  it('offers off, mild, normal and harsh', () => {
    expect(DISASTER_LEVELS.map((level) => level.id)).toEqual(['off', 'mild', 'normal', 'harsh']);
  });

  it('rises monotonically from off to harsh', () => {
    const scales = DISASTER_LEVELS.map((level) => level.scale);
    expect(scales[0]).toBe(0);
    for (let i = 1; i < scales.length; i++) expect(scales[i]).toBeGreaterThan(scales[i - 1]);
  });

  it('defaults a new city to normal', () => {
    expect(DEFAULT_NEW_GAME.disasterScale).toBe(1);
  });
});
```

Also append to `src/sim/engine.test.ts`:

```ts
it('applies the chosen disaster intensity to a new city', () => {
  const engine = new SimEngine(1, 32);
  engine.applyCommand({ type: 'init', seed: 1, size: 32, disasterScale: 0 });
  expect(engine.state.disasterScale).toBe(0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/ui/newGame.test.ts src/sim/engine.test.ts`
Expected: FAIL — `DISASTER_LEVELS` does not exist, `init` rejects
`disasterScale`.

- [ ] **Step 3: Extend `src/ui/newGame.ts`**

```ts
export const DISASTER_LEVELS = [
  { id: 'off', scale: 0 },
  { id: 'mild', scale: 0.5 },
  { id: 'normal', scale: 1 },
  { id: 'harsh', scale: 1.6 },
] as const;
```

Add `disasterScale: number;` to `NewGameOptions`, `disasterScale: 1` to
`DEFAULT_NEW_GAME`, and read it back in `readPendingNewGame`:

```ts
      disasterScale: DISASTER_LEVELS.some((level) => level.scale === parsed.disasterScale)
        ? (parsed.disasterScale as number)
        : DEFAULT_NEW_GAME.disasterScale,
```

- [ ] **Step 4: Carry it to the worker**

`src/shared/messages.ts`, in the `init` command:

```ts
      /** Disaster intensity: 0 = off .. 1.6 = harsh (new games only). */
      disasterScale?: number;
```

`src/sim/engine.ts`, in the `init` case's fresh-city branch, after
`createSimState`:

```ts
if (command.disasterScale !== undefined) {
  this.state.disasterScale = command.disasterScale;
}
```

`src/ui/useSimBridge.ts`: add `disasterScale?: number` to
`SimBridgeOptions` and pass it through the same way `startingMoney` is
passed. `src/ui/App.tsx`: add `disasterScale: options.disasterScale` to
the `useSimBridge({ ... })` call.

- [ ] **Step 5: Add the control to `src/ui/NewGamePage.tsx`**

```tsx
const [disasters, setDisasters] = useState<number>(DEFAULT_NEW_GAME.disasterScale);
```

a section after the difficulty one:

```tsx
<section>
  <h3>{t('newGame.disasters')}</h3>
  <div className="option-row">
    {DISASTER_LEVELS.map((level) => (
      <button
        key={level.id}
        type="button"
        className={disasters === level.scale ? 'active' : ''}
        data-testid={`disasters-${level.id}`}
        onClick={() => setDisasters(level.scale)}
      >
        {t(`newGame.disasters.${level.id}` as TranslationKey)}
      </button>
    ))}
  </div>
  <p className="option-hint">{t('newGame.disasters.hint')}</p>
</section>
```

and `disasterScale: disasters` in the `storePendingNewGame` call.

- [ ] **Step 6: Add the strings to `src/ui/i18n.tsx` (both dictionaries)**

English:

```ts
  'newGame.disasters': 'Disasters',
  'newGame.disasters.off': 'Off',
  'newGame.disasters.mild': 'Mild',
  'newGame.disasters.normal': 'Normal',
  'newGame.disasters.harsh': 'Harsh',
  'newGame.disasters.hint':
    'Storms, fires and floods damage your city; repairs cost money over time. Existing cities keep playing without them.',
```

German:

```ts
  'newGame.disasters': 'Katastrophen',
  'newGame.disasters.off': 'Aus',
  'newGame.disasters.mild': 'Sanft',
  'newGame.disasters.normal': 'Normal',
  'newGame.disasters.harsh': 'Hart',
  'newGame.disasters.hint':
    'Stürme, Brände und Hochwasser beschädigen deine Stadt; Reparaturen kosten über die Zeit Geld. Bestehende Städte spielen ohne sie weiter.',
```

- [ ] **Step 7: Run the tests and the suite**

Run: `pnpm vitest run src/ui/newGame.test.ts src/sim/engine.test.ts && pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
pnpm format
git add -A
git commit -m "feat(ui): choose the disaster intensity when founding a city

Off, mild, normal or harsh in the new-game dialog; the factor scales
every risk and travels with the save. Existing cities keep loading with
disasters off.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: The `stormProof` goal

**Files:**

- Modify: `src/sim/goals.ts`, `src/sim/state.ts` (progress counter), `src/ui/i18n.tsx`
- Test: `src/sim/goals.test.ts`

**Interfaces:**

- Consumes: `SimState.disasters` (Task 1), the storm kind (Task 5).
- Produces: `GoalId` gains `'stormProof'`;
  `SimState.goalProgress.stormTicks: number` (transient, like the other
  single-event streaks).

- [ ] **Step 1: Write the failing test**

Append to `src/sim/goals.test.ts` (follow the file's existing helpers):

```ts
describe('the stormProof goal', () => {
  it('unlocks after riding out a whole storm without a deficit', () => {
    const state = createSimState(1, 32);
    state.disasters.active.push({
      id: 1,
      kind: DisasterKind.Storm,
      severity: 1,
      startTick: 0,
      endTick: 10,
      origin: 0,
      tiles: [],
      intensity: [],
    });
    state.lastEnergy.deficit = 0;
    for (let i = 0; i < 10; i++) {
      state.tick++;
      goalsStep(state);
    }
    state.disasters.active = [];
    goalsStep(state);
    expect(state.goalsAchieved.has('stormProof')).toBe(true);
  });

  it('does not unlock when the storm caused a deficit', () => {
    const state = createSimState(1, 32);
    state.disasters.active.push({
      id: 1,
      kind: DisasterKind.Storm,
      severity: 1,
      startTick: 0,
      endTick: 10,
      origin: 0,
      tiles: [],
      intensity: [],
    });
    for (let i = 0; i < 10; i++) {
      state.tick++;
      state.lastEnergy.deficit = i === 5 ? 12 : 0;
      goalsStep(state);
    }
    state.disasters.active = [];
    goalsStep(state);
    expect(state.goalsAchieved.has('stormProof')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/sim/goals.test.ts`
Expected: FAIL — `'stormProof'` is not a `GoalId`.

- [ ] **Step 3: Implement the goal**

`src/sim/state.ts`: add `stormTicks: number;` to `goalProgress` (with a
comment that it is a single-event streak and stays transient, like
`cleanDayTicks`) and `stormTicks: 0,` to `createSimState`.

`src/sim/goals.ts`: add `'stormProof'` to `GOAL_IDS` and

```ts
// Riding out a storm: count the ticks a storm blows while the grid
// holds, and bank the goal the moment the storm is over. A deficit
// resets the streak, so it must hold from the first gust to the last.
const inStorm = state.disasters.active.some((event) => event.kind === DisasterKind.Storm);
if (inStorm) {
  progress.stormTicks = state.lastEnergy.deficit === 0 ? progress.stormTicks + 1 : -1;
} else {
  if (!achieved.has('stormProof') && progress.stormTicks > 0) achieved.add('stormProof');
  progress.stormTicks = 0;
}
```

Note the ordering: `achieved` is declared further down in the current
function — move this block below `const achieved = state.goalsAchieved;`
so it reads in order. Import `DisasterKind` from `../shared/types.ts`.

- [ ] **Step 4: Add the strings to `src/ui/i18n.tsx` (both dictionaries)**

```ts
  'goal.stormProof.title': 'Storm-proof',
  'goal.stormProof.body': 'Ride out a whole storm without a single undersupplied tick.',
```

```ts
  'goal.stormProof.title': 'Sturmfest',
  'goal.stormProof.body': 'Überstehe einen ganzen Sturm ohne einen einzigen unterversorgten Tick.',
```

- [ ] **Step 5: Run the tests and the suite**

Run: `pnpm vitest run src/sim/goals.test.ts && pnpm typecheck && pnpm test`
Expected: PASS. A test asserting the number of goals needs its count
raised by one.

- [ ] **Step 6: Commit**

```bash
pnpm format
git add -A
git commit -m "feat(sim): a goal for riding out a storm

stormProof banks once a storm has blown over without a single
undersupplied tick — the reward for using the warning to fill storage.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Damage in the tile inspector

**Files:**

- Modify: `src/sim/inspect.ts`, `src/ui/TileInspector.tsx`, `src/ui/i18n.tsx`
- Test: `src/sim/inspect.test.ts`

**Interfaces:**

- Consumes: `TileInfo.damage`, `TileInfo.disaster` (Task 1),
  `disasterKindAt` (Task 3).
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Append to `src/sim/inspect.test.ts`:

```ts
it('reports the damage of a tile and the event covering it', () => {
  const state = createSimState(1, SIZE);
  placePlant(state, at(5, 5), PlantType.WindTurbine);
  addDamage(state, at(5, 5), 60);
  state.disasters.active.push({
    id: 1,
    kind: DisasterKind.Storm,
    severity: 1,
    startTick: 0,
    endTick: 100,
    origin: at(5, 5),
    tiles: [at(5, 5)],
    intensity: [0],
  });
  const info = inspectTile(state, at(5, 5));
  expect(info.damage).toBe(60);
  expect(info.disaster).toBe(DisasterKind.Storm);
});

it('reports an intact tile as undamaged with no event', () => {
  const state = createSimState(1, SIZE);
  const info = inspectTile(state, at(9, 9));
  expect(info.damage).toBe(0);
  expect(info.disaster).toBe(null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/sim/inspect.test.ts`
Expected: FAIL — `info.damage` is undefined.

- [ ] **Step 3: Fill the fields in `src/sim/inspect.ts`**

In the returned object:

```ts
    damage: layers.damage[index],
    disaster: disasterKindAt(state, index),
```

(import `disasterKindAt` from `./disasters.ts`; use whatever local name
the file already has for `state.layers`.)

- [ ] **Step 4: Show it in `src/ui/TileInspector.tsx`**

Add a row, following the file's existing row markup, shown only when
`info.damage > 0`:

```tsx
{
  info.damage > 0 && (
    <div className="inspector-row inspector-damage" data-testid="inspector-damage">
      <span>{t('inspector.damage')}</span>
      <span>
        {t('inspector.damage.value', { points: info.damage })}
        {info.disaster !== null && ` · ${t(disasterLabelKey(info.disaster))}`}
      </span>
    </div>
  );
}
```

with a small helper in the same file:

```tsx
/** i18n key for a disaster kind. */
export function disasterLabelKey(kind: DisasterKind): TranslationKey {
  return kind === DisasterKind.Storm
    ? 'disaster.storm'
    : kind === DisasterKind.Fire
      ? 'disaster.fire'
      : 'disaster.flood';
}
```

- [ ] **Step 5: Add the strings to `src/ui/i18n.tsx` (both dictionaries)**

```ts
  'disaster.storm': 'Storm',
  'disaster.fire': 'Fire',
  'disaster.flood': 'Flood',
  'inspector.damage': 'damage',
  'inspector.damage.value': '{points} points · out of service, repair under way',
```

```ts
  'disaster.storm': 'Sturm',
  'disaster.fire': 'Brand',
  'disaster.flood': 'Hochwasser',
  'inspector.damage': 'Schaden',
  'inspector.damage.value': '{points} Punkte · außer Betrieb, Reparatur läuft',
```

- [ ] **Step 6: Run the tests and the suite**

Run: `pnpm vitest run src/sim/inspect.test.ts && pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
pnpm format
git add -A
git commit -m "feat(ui): the inspector explains a damaged tile

A damaged tile reports its damage points, that it is out of service, and
which event is on top of it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: The warning banner, the impact toast and the alarm

**Files:**

- Create: `src/ui/DisasterBanner.tsx`
- Modify: `src/ui/App.tsx`, `src/ui/app.css`, `src/ui/sound.ts`, `src/ui/i18n.tsx`
- Test: `src/ui/DisasterBanner.test.tsx` — only if the repo already has
  component tests; it does not, so verify this task in the browser and
  keep the logic in a pure helper that IS tested (see Step 1).

**Interfaces:**

- Consumes: `GlobalStats.disasters` (Task 4).
- Produces: `DisasterBanner` component; `countdownLabel(ticks): string`
  helper exported from `src/ui/DisasterBanner.tsx`.

- [ ] **Step 1: Write the failing test for the pure helper**

Create `src/ui/DisasterBanner.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { TICKS_PER_DAY } from '../shared/constants.ts';
import { countdownParts } from './DisasterBanner.tsx';

describe('countdownParts', () => {
  it('turns ticks into in-game hours and minutes', () => {
    const hour = TICKS_PER_DAY / 24;
    expect(countdownParts(hour * 2)).toEqual({ hours: 2, minutes: 0 });
    expect(countdownParts(hour + hour / 2)).toEqual({ hours: 1, minutes: 30 });
  });

  it('never goes negative', () => {
    expect(countdownParts(-10)).toEqual({ hours: 0, minutes: 0 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/ui/DisasterBanner.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Create `src/ui/DisasterBanner.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react';
import { TICKS_PER_DAY } from '../shared/constants.ts';
import { DisasterKind, type DisasterStats } from '../shared/types.ts';
import { useI18n, type TranslationKey } from './i18n.tsx';

const TOAST_MS = 5000;

const ICON: Record<DisasterKind, string> = {
  [DisasterKind.Storm]: '🌪',
  [DisasterKind.Fire]: '🔥',
  [DisasterKind.Flood]: '🌊',
};

const LABEL: Record<DisasterKind, TranslationKey> = {
  [DisasterKind.Storm]: 'disaster.storm',
  [DisasterKind.Fire]: 'disaster.fire',
  [DisasterKind.Flood]: 'disaster.flood',
};

/** In-game hours and minutes left, for the countdown. */
export function countdownParts(ticks: number): { hours: number; minutes: number } {
  const minutes = Math.max(0, Math.round((ticks / TICKS_PER_DAY) * 24 * 60));
  return { hours: Math.floor(minutes / 60), minutes: minutes % 60 };
}

/**
 * Warnings with a countdown while a storm or flood is on its way, plus a
 * toast the moment something strikes. Fires have no warning, so they only
 * ever appear as an active event — which is the point of the mechanic.
 */
export function DisasterBanner({
  disasters,
  onWarning,
  onStrike,
}: {
  disasters: DisasterStats;
  /** Called once per new warning (plays the alarm). */
  onWarning?: (kind: DisasterKind) => void;
  /** Called once per newly active event. */
  onStrike?: (kind: DisasterKind) => void;
}) {
  const { t } = useI18n();
  const [toast, setToast] = useState<{ kind: DisasterKind } | null>(null);
  const knownWarnings = useRef<Set<number>>(new Set());
  const knownActive = useRef<Set<number>>(new Set());
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    for (const event of disasters.pending) {
      if (knownWarnings.current.has(event.id)) continue;
      knownWarnings.current.add(event.id);
      onWarning?.(event.kind);
    }
    for (const event of disasters.active) {
      if (knownActive.current.has(event.id)) continue;
      knownActive.current.add(event.id);
      onStrike?.(event.kind);
      setToast({ kind: event.kind });
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToast(null), TOAST_MS);
    }
  }, [disasters, onWarning, onStrike]);

  const banners = [
    ...disasters.pending.map((event) => ({ event, warning: true })),
    ...disasters.active.map((event) => ({ event, warning: false })),
  ];

  return (
    <>
      {banners.length > 0 && (
        <div className="disaster-banners" data-testid="disaster-banners">
          {banners.map(({ event, warning }) => {
            const { hours, minutes } = countdownParts(event.ticks);
            return (
              <div
                key={event.id}
                className={`disaster-banner ${warning ? 'warning' : 'active'}`}
                data-testid={`disaster-${event.id}`}
              >
                <span aria-hidden="true">{ICON[event.kind]}</span>
                <strong>{t(LABEL[event.kind])}</strong>
                <span>
                  {warning
                    ? t('disaster.warning', { hours, minutes })
                    : t('disaster.active', { hours, minutes })}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {toast && (
        <div className="disaster-toast" data-testid="disaster-toast">
          {ICON[toast.kind]} {t('disaster.toast', { kind: t(LABEL[toast.kind]) })}
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 4: Mount it and wire the sound**

`src/ui/App.tsx`, inside the `hud-slot hud-slot-top` group (below the
console, so it never covers the energy strip):

```tsx
{
  stats && (
    <DisasterBanner
      disasters={stats.disasters}
      onWarning={() => sound.play('alarm')}
      onStrike={() => sound.play('alarm')}
    />
  );
}
```

`src/ui/sound.ts`: add an `alarm` cue next to the existing ones — a
two-tone descending beep built from the file's existing synth helpers.
Follow the shape of the `reject`/`achievement` cues.

`src/ui/app.css`: style `.disaster-banners`, `.disaster-banner.warning`
(amber), `.disaster-banner.active` (red) and `.disaster-toast`, following
the existing `.goal-toast` and `.rejection-toast` rules.

- [ ] **Step 5: Add the strings to `src/ui/i18n.tsx` (both dictionaries)**

```ts
  'disaster.warning': 'warning · strikes in {hours} h {minutes} min',
  'disaster.active': 'under way · {hours} h {minutes} min left',
  'disaster.toast': '{kind} is hitting the city',
```

```ts
  'disaster.warning': 'Warnung · trifft in {hours} h {minutes} min ein',
  'disaster.active': 'läuft · noch {hours} h {minutes} min',
  'disaster.toast': '{kind} trifft die Stadt',
```

- [ ] **Step 6: Run the tests and the suite**

Run: `pnpm vitest run src/ui/DisasterBanner.test.ts && pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 7: Verify in the browser**

Run: `pnpm dev`, start a city with intensity **harsh**, open the console
and force a storm:

```js
// The worker owns the state, so drive it through the agent tools instead:
await window.voltopia.call('advance_time', { days: 3 });
await window.voltopia.call('get_disasters');
```

Expected: within a few in-game days a warning banner with a counting-down
clock, then a toast and a red active banner. (No WebGL in the Linux
sandbox — the HUD still renders there; the 3D layers do not.)

- [ ] **Step 8: Commit**

```bash
pnpm format
git add -A
git commit -m "feat(ui): warning banners, an impact toast and an alarm

Storms and floods announce themselves with a counting-down banner; every
strike raises a toast and an alarm. Fires only ever show as active — they
give no warning, which is what makes fire stations worth their upkeep.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: The damage overlay

**Files:**

- Modify: `src/render/overlays.ts`, `src/ui/OverlayToggle.tsx`, `src/ui/i18n.tsx`
- Test: covered by `src/render/*.test.ts` conventions — add the case to a
  new `src/render/overlays.test.ts` only if the file does not exist; the
  mesh is three.js, so assert on the colour mapping helper instead.

**Interfaces:**

- Consumes: `TileDiff.damage` (Task 1), `OverlayMode.Damage` (Task 1).
- Produces: `damageColor(damage: number): number` exported from
  `src/render/overlays.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/render/overlays.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { damageColor } from './overlays.ts';

describe('damageColor', () => {
  it('greens an intact tile and reds a wrecked one', () => {
    expect(damageColor(0)).not.toBe(damageColor(255));
  });

  it('is monotone in the damage', () => {
    const light = damageColor(30);
    const heavy = damageColor(200);
    expect(light).not.toBe(heavy);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/render/overlays.test.ts`
Expected: FAIL — `damageColor` is not exported.

- [ ] **Step 3: Extend `src/render/overlays.ts`**

```ts
const DAMAGE_COLORS = { intact: 0x4cd964, light: 0xffb347, heavy: 0xe05263 } as const;

/** Overlay colour of a tile by its damage points. */
export function damageColor(damage: number): number {
  if (damage === 0) return DAMAGE_COLORS.intact;
  return damage < 128 ? DAMAGE_COLORS.light : DAMAGE_COLORS.heavy;
}
```

Add `damage: number;` to the `OverlayTile` interface, store
`damage: diff.damage` in `applyDiffs` (and widen the `applyDiffs` filter
so a damaged tile is tracked even when it is neither zoned, built, a
road nor a depot — add `|| diff.damage > 0` to the condition), then a
branch in `rebuild`:

```ts
        } else if (this.mode === OverlayMode.Damage) {
          // Every tile that can break shows its state, so the player can
          // see at a glance what the storm took out.
          if (
            tile.damage > 0 ||
            (tile.tileType === TileType.Empty && tile.density > 0) ||
            tile.tileType === TileType.Plant
          ) {
            colorHex = damageColor(tile.damage);
          }
        }
```

- [ ] **Step 4: Add the toggle entry in `src/ui/OverlayToggle.tsx`**

```ts
  {
    mode: OverlayMode.Damage,
    id: 'damage',
    label: 'overlay.damage',
    title: 'overlay.damage.title',
  },
```

- [ ] **Step 5: Add the strings to `src/ui/i18n.tsx` (both dictionaries)**

```ts
  'overlay.damage': 'Damage',
  'overlay.damage.title': 'Damage: intact / damaged / wrecked, and what is out of service',
```

```ts
  'overlay.damage': 'Schäden',
  'overlay.damage.title': 'Schäden: heil / beschädigt / zerstört, und was außer Betrieb ist',
```

- [ ] **Step 6: Run the tests and the suite**

Run: `pnpm vitest run src/render/overlays.test.ts && pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
pnpm format
git add -A
git commit -m "feat(render): a damage overlay

Toggle the map to damage and every breakable tile shows whether it is
intact, damaged or wrecked.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: Rendering disasters — decals, embers and a water film

**Files:**

- Create: `src/render/disasterMesh.ts`, `src/render/disasterMesh.test.ts`
- Modify: `src/render/renderer.ts`
- Modify: `src/render/minimapLayer.ts` (mark damaged tiles)

**Interfaces:**

- Consumes: `TileDiff.damage`; `DiffLayer`, `RenderEnvironment` from
  `./renderer.ts`; `ElevationField`; the prism helpers from `./decal.ts`.
- Produces: `DisasterMesh implements DiffLayer` with
  `setActiveKinds(kinds: Map<number, DisasterKind>)` — the renderer feeds
  it the per-tile kind of the active events from the stats.

- [ ] **Step 1: Write the failing test**

Create `src/render/disasterMesh.test.ts`, following
`src/render/geothermalMesh.test.ts` (it constructs a `THREE.Scene`, which
needs no WebGL context):

```ts
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DisasterKind, type TileDiff } from '../shared/types.ts';
import { DisasterMesh } from './disasterMesh.ts';
import { ElevationField } from './elevationField.ts';

const SIZE = 8;

function baseDiff(index: number, damage: number): TileDiff {
  // A full TileDiff with everything neutral but the damage; copy the
  // helper the sibling render tests use if one already exists.
  return {
    index,
    tileType: 0,
    roadMask: 0,
    roadClass: 0,
    trafficLoad: 0,
    powerLine: 0,
    zone: 0,
    density: 0,
    variant: 0,
    supplied: 0,
    services: 0,
    plantType: 0,
    terrain: 0,
    elevation: 0,
    forest: 0,
    geothermal: 0,
    reservoirHeat: 0,
    damage,
    deliveryState: 0,
    busStop: 0,
    stopState: 0,
    transitCover: 0,
  } as TileDiff;
}

describe('DisasterMesh', () => {
  it('draws one decal per damaged tile and drops it when repaired', () => {
    const scene = new THREE.Scene();
    const mesh = new DisasterMesh(scene, SIZE, new ElevationField(SIZE));
    mesh.applyDiffs([baseDiff(3, 40), baseDiff(4, 90)]);
    expect(mesh.decalCount).toBe(2);
    mesh.applyDiffs([baseDiff(3, 0)]);
    expect(mesh.decalCount).toBe(1);
  });

  it('draws embers only on tiles that are actually on fire', () => {
    const scene = new THREE.Scene();
    const mesh = new DisasterMesh(scene, SIZE, new ElevationField(SIZE));
    mesh.applyDiffs([baseDiff(3, 40), baseDiff(4, 40)]);
    mesh.setActiveKinds(new Map([[3, DisasterKind.Fire]]));
    mesh.update(0.016, 1);
    expect(mesh.fireCount).toBe(1);
  });

  it('never culls its instanced meshes', () => {
    const scene = new THREE.Scene();
    const mesh = new DisasterMesh(scene, SIZE, new ElevationField(SIZE));
    for (const child of scene.children) {
      if (child instanceof THREE.InstancedMesh) expect(child.frustumCulled).toBe(false);
    }
    expect(mesh).toBeDefined();
  });
});
```

Check `ElevationField`'s real constructor signature before writing this
(`src/render/elevationField.ts`) and match it.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/render/disasterMesh.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Create `src/render/disasterMesh.ts`**

Implement three instanced meshes in one `DiffLayer`, following
`GeothermalMesh` closely (that file is the template for a static layer
plus an animated one):

1. **Damage decals** — a square prism pair per damaged tile via
   `composePrismOnGround`, dark grey, opacity rising with the damage.
   Rebuilt from `applyDiffs` only (static).
2. **Fire** — small emitter spheres on tiles whose active kind is
   `Fire`, warm colour, animated from `update(delta, now)` like the
   geothermal steam (and frozen under `setReducedMotion(true)`), plus a
   grey smoke sphere above each.
3. **Flood film** — a translucent blue square prism pair per tile whose
   active kind is `Flood`, laid slightly above the ground, no animation.

Expose `decalCount`, `fireCount` and `floodCount` getters returning the
meshes' `count` so the test can assert without a GPU. Set
`frustumCulled = false` on all three, `count = 0` initially, and
`renderOrder` above the ground but below the overlays.

- [ ] **Step 4: Feed the active kinds from `src/render/renderer.ts`**

Register the layer next to the others:

```ts
this.disasters = new DisasterMesh(scene, gridSize, this.elevation);
this.addDiffLayer(this.disasters);
```

and in `setStats`, after the environment is built:

```ts
// Which tiles are inside which active event: the mesh needs the kind,
// the tile diff channel only carries the damage.
const kinds = new Map<number, DisasterKind>();
for (const event of stats.disasters.active) {
  for (const index of event.tiles) kinds.set(index, event.kind);
}
this.disasters.setActiveKinds(kinds);
```

`DisasterInfo.tiles` is the list added in Task 1; a fire covers a handful
of tiles and a flood a few hundred, so this stays far below one tile diff
burst and only moves while an event runs.

- [ ] **Step 5: Mark damaged tiles on the minimap**

In `src/render/minimapLayer.ts`, colour a tile with `damage > 0` in the
overlay's heavy-damage red, following the file's existing per-tile colour
decision.

- [ ] **Step 6: Run the tests and the suite**

Run: `pnpm vitest run src/render/disasterMesh.test.ts && pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 7: Verify on the Mac (no WebGL in the Linux sandbox)**

Start a harsh city, `advance_time` until a fire and a flood happen, and
check: damage decals read as wreckage and not as dirt, embers sit on the
burning tiles only, smoke drifts, the flood film covers the floodplain
without sinking under the ground mesh, and everything disappears once
repaired. Note anything off; a follow-up render fix is cheaper than a
wrong shape shipped.

- [ ] **Step 8: Commit**

```bash
pnpm format
git add -A
git commit -m "feat(render): wreckage decals, fire embers and a flood film

One diff layer draws all three: a decal per damaged tile that darkens
with the damage, animated embers and smoke on the tiles that are actually
burning, and a translucent water film over the floodplain. The minimap
marks damaged tiles.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: Agent tools

**Files:**

- Modify: `src/agent/tools.ts`, `src/agent/tileMirror.ts`
- Modify: `docs/agent-tools.md`
- Test: `src/agent/tools.test.ts`, `src/agent/tileMirror.test.ts`

**Interfaces:**

- Consumes: `GlobalStats.disasters` (Task 4), `TileDiff.damage` (Task 1).
- Produces: the `get_disasters` tool; `damage` in `inspect_tile` and
  `describeTile`; the `damaged` find kind; `disasters` in
  `get_game_overview`; `TileMirror.damage`.

- [ ] **Step 1: Write the failing test**

Append to `src/agent/tools.test.ts` (follow the file's existing harness
for a headless engine + context):

```ts
it('get_disasters reports intensity, warnings and active events', async () => {
  const { call, engine } = harness();
  engine.state.disasters.pending.push({
    id: 5,
    kind: DisasterKind.Flood,
    severity: 0.8,
    startTick: engine.state.tick + 120,
    endTick: engine.state.tick + 400,
    origin: 0,
    tiles: [0, 1],
    intensity: [1, 2],
  });
  const result = (await call('get_disasters')) as {
    intensity: number;
    warnings: Array<{ kind: string; ticksAway: number; tiles: number }>;
    active: unknown[];
    damagedTiles: number;
  };
  expect(result.intensity).toBeGreaterThan(0);
  expect(result.warnings[0].kind).toBe('flood');
  expect(result.warnings[0].ticksAway).toBe(120);
  expect(result.active).toHaveLength(0);
  expect(result.damagedTiles).toBe(0);
});

it('find_tiles finds damaged tiles', async () => {
  const { call, engine, sync } = harness();
  addDamage(engine.state, tileIndex(5, 5, 32), 50);
  sync();
  const found = (await call('find_tiles', { kind: 'damaged' })) as {
    tiles: Array<{ x: number; y: number }>;
  };
  expect(found.tiles).toContainEqual(expect.objectContaining({ x: 5, y: 5 }));
});

it('inspect_tile reports the damage', async () => {
  const { call, engine, sync } = harness();
  addDamage(engine.state, tileIndex(6, 6, 32), 42);
  sync();
  const info = (await call('inspect_tile', { x: 6, y: 6 })) as { damage: number };
  expect(info.damage).toBe(42);
});
```

and to `src/agent/tileMirror.test.ts`:

```ts
it('mirrors the damage layer', () => {
  const mirror = new TileMirror(4);
  mirror.applyDiffs([{ ...emptyDiff(2), damage: 77 }]);
  expect(mirror.damage[2]).toBe(77);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/agent/tools.test.ts src/agent/tileMirror.test.ts`
Expected: FAIL — `unknownTool` for `get_disasters`, `invalidInput` for the
`damaged` kind, `mirror.damage` undefined.

- [ ] **Step 3: Mirror the layer in `src/agent/tileMirror.ts`**

Add `damage: number;` to `MirroredTile`, `readonly damage: Uint8Array;`
to the class, `this.damage = new Uint8Array(count);` to the constructor,
`this.damage[i] = diff.damage;` to `applyDiffs`, and `damage: this.damage[index]`
wherever `at()` builds a `MirroredTile`.

- [ ] **Step 4: Add the tool and the extras in `src/agent/tools.ts`**

A kind-name map next to the other name maps:

```ts
const DISASTER_NAME: Record<DisasterKind, string> = {
  [DisasterKind.Storm]: 'storm',
  [DisasterKind.Fire]: 'fire',
  [DisasterKind.Flood]: 'flood',
};
```

`'damaged'` appended to `FIND_KINDS`, and in `matchesKind`:

```ts
    case 'damaged':
      return tiles.damage[i] !== 0;
```

`damage: t.damage` in `describeTile`, `damage: info.damage` in
`liveFigures`, a `disasters` block in `get_game_overview`:

```ts
          disasters: {
            intensity: s.disasters.scale,
            warnings: s.disasters.pending.length,
            active: s.disasters.active.length,
            damagedTiles: s.disasters.damagedTiles,
            repairPerTick: round(s.disasters.repairPerTick, 3),
          },
```

and the new read tool:

```ts
    {
      name: 'get_disasters',
      description:
        'Disasters: this city\'s intensity setting, the warnings currently counting down ' +
        '(storms and floods announce themselves hours ahead, fires never do), the events ' +
        'striking right now with the tiles they cover, how many tiles are damaged, and what ' +
        'repairs cost per tick. A damaged tile is out of service until it is repaired: plants ' +
        'stop generating, power lines stop conducting, buildings go dark. Use a warning to ' +
        'prepare — fill storage, charge the hydrogen tanks, or buy over the link.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      async execute() {
        const s = requireStats(ctx);
        const d = s.disasters;
        const describe = (event: DisasterInfo) => ({
          id: event.id,
          kind: DISASTER_NAME[event.kind],
          severity: round(event.severity, 2),
          ticksAway: event.ticks,
          origin: { x: tileX(event.origin, size), y: tileY(event.origin, size) },
          tiles: event.tiles.length,
        });
        return {
          intensity: d.scale,
          ticksPerDay: TICKS_PER_DAY,
          warnings: d.pending.map(describe),
          active: d.active.map((event) => ({ ...describe(event), ticksLeft: event.ticks })),
          damagedTiles: d.damagedTiles,
          repairPerTick: round(d.repairPerTick, 3),
        };
      },
    },
```

The `ticksAway` field on an active event reads oddly, hence the extra
`ticksLeft`; keep both so a caller never has to know which list it came
from.

- [ ] **Step 5: Update `docs/agent-tools.md`**

- Add a `get_disasters` row to the tools table (kind `read`).
- Add `damaged` to the `find_tiles` kinds in its row.
- Mention `damage` in the `inspect_tile` row.
- Add the rejection code `damaged` to the codes list in _Conventions_.
- Add a short paragraph to _Conventions_ explaining that a damaged tile
  is out of service, repairs itself against money, and cannot be built on
  (but can be bulldozed).
- Update the two tool-count mentions near the top (21 → 22) and the
  `getTools().length` sanity check.

- [ ] **Step 6: Run the tests and the suite**

Run: `pnpm vitest run src/agent/ && pnpm typecheck && pnpm test`
Expected: PASS. The e2e test that counts tools (`pnpm e2e`, if it runs
here) needs the same count bump.

- [ ] **Step 7: Commit**

```bash
pnpm format
git add -A
git commit -m "feat(agent): expose disasters, damage and repairs

get_disasters reports the city's intensity, the countdowns, the active
events and the repair bill; inspect_tile and the tile description carry
the damage, find_tiles gains the \"damaged\" kind, and the overview
summarises it all. Docs updated to match.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 16: Help page and backlog

**Files:**

- Modify: `src/ui/HelpPage.tsx`, `src/ui/i18n.tsx`
- Modify: `docs/idea.md`, `docs/plan.md`

- [ ] **Step 1: Add the help section**

In `src/ui/HelpPage.tsx`, following the existing sections, add one on
disasters: what the three kinds do, that storms and floods warn ahead
while fires do not, that fire stations lower the chance of a fire as well
as its spread, that damage means "out of service until repaired", that
repairs cost money over time and freeze when the treasury is empty, and
that the intensity is chosen when founding a city.

Strings (both dictionaries), e.g.:

```ts
  'help.disasters.title': 'Disasters',
  'help.disasters.body':
    'Storms feather every wind turbine above the cut-out speed and tear at pylons; fires eat blocks the fire stations do not reach; the spring melt floods the low ground by the river. Storms and floods warn you hours ahead — use the time to fill storage. Damaged tiles are out of service until they are repaired, which costs money over time and stalls while you are broke. Pick the intensity when you found a city.',
```

```ts
  'help.disasters.title': 'Katastrophen',
  'help.disasters.body':
    'Stürme fahnen jede Windkraftanlage oberhalb der Abschaltgeschwindigkeit und reißen an den Masten; Brände fressen Blocks, die keine Feuerwache erreicht; die Schneeschmelze überflutet das tiefe Land am Fluss. Sturm und Hochwasser kündigen sich Stunden vorher an — nutze die Zeit, um Speicher zu füllen. Beschädigte Tiles sind außer Betrieb, bis sie repariert sind; das kostet über die Zeit Geld und stockt, solange die Kasse leer ist. Die Stärke wählst du beim Gründen einer Stadt.',
```

- [ ] **Step 2: Mark the backlog entry done in `docs/idea.md`**

Change the bullet to `**Disasters/events** (done): …` and describe what
shipped in one or two sentences, in the same voice as the neighbouring
done entries.

- [ ] **Step 3: Refresh the module map in `docs/plan.md`**

Add to the `src/sim/` list:

```
    disasters.ts   # lifecycle: risk, warning, damage, repair
    storm.ts       # storm risk, gust, city-wide strikes
    fire.ts        # ignition, spread, extinguishing
    flood.ts       # flood risk and the computed floodplain
```

and `disasterMesh.ts` to the render list if that list exists in the file.

- [ ] **Step 4: Run the suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add -A
git commit -m "docs: explain disasters in the help page and the backlog

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 17: Balancing with a headless probe

The numbers from Task 1 are guesses. This task measures and replaces them.

**Files:**

- Create (temporary, deleted at the end): `scripts/disaster-probe.mjs`
- Modify: `src/shared/constants.ts` (final numbers, with the measurements
  in the comments)

- [ ] **Step 1: Write the probe**

`scripts/disaster-probe.mjs`, following the pattern named in
`CLAUDE.md` ("balance: resize energy system"): build a scripted city with
`SimEngine` — roads, a few hundred residents, a mixed generation fleet
with wind turbines and power lines, one fire station covering part of the
city, and some buildings in the floodplain — then run 20 in-game days per
intensity level (0.5, 1, 1.6) and print per level:

- events per kind, and the mean in-game hours between them
- peak and mean damaged tiles
- total repair spend against total tax income
- ticks lost to a deficit caused by a storm cut-out
- how often a fire that started in covered ground stayed a single tile

Run it with `node scripts/disaster-probe.mjs`.

- [ ] **Step 2: Read the numbers and decide**

Target feel at `normal`:

- a storm every few in-game days, more in winter
- a fire only where fire coverage is missing, and single-tile inside it
- a flood roughly once per spring melt
- a repair bill that hurts but stays under a third of tax income for a
  city that prepared

- [ ] **Step 3: Tune `BALANCE.disasters` and re-measure**

Change one group at a time (risks, then damage points, then repair cost),
re-run the probe, and record the measured figures in the block's comments
the way `BALANCE.geothermal` records its probe results.

- [ ] **Step 4: Delete the probe and run everything**

```bash
rm scripts/disaster-probe.mjs
pnpm typecheck && pnpm lint && pnpm format:check && pnpm coverage
```

Expected: PASS, `src/sim` ≥ 90 %.

- [ ] **Step 5: Smoke-test headlessly, then on the Mac**

Run: `node scripts/smoke.mjs`
Expected: PASS.

Then on the Mac: `pnpm dev`, found a harsh city, play a few in-game days
and watch one of each event end to end.

- [ ] **Step 6: Commit**

```bash
pnpm format
git add -A
git commit -m "balance: tune disasters from the headless probe

Risks, damage points and repair costs measured over 20 in-game days per
intensity level; the figures behind each number are in the comments.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage.** Walked every spec section against the tasks:

| Spec section                                                                                        | Tasks              |
| --------------------------------------------------------------------------------------------------- | ------------------ |
| Damage layer                                                                                        | 1, 2, 3            |
| Event state, intensity, stats, balance                                                              | 1, 4, 9            |
| Lifecycle (retire/activate/apply/roll), repair                                                      | 3, 4               |
| Storm (risk, lead, gust, cut-out, strikes)                                                          | 5                  |
| Fire (risk, ignition, spread, coverage, end)                                                        | 6                  |
| Flood (risk, computed area, depth, terrain untouched)                                               | 7                  |
| Energy / grid / buildings / roads / services / happiness / economy / build rules / goal / inspector | 2, 3, 10, 11       |
| Rendering, UI, agent tools                                                                          | 12, 13, 14, 15, 16 |
| Testing (incl. determinism and save/load)                                                           | every task, plus 8 |
| Balancing, save compatibility                                                                       | 17, 1, 8           |

**Two spec deviations, both deliberate and flagged in place:** the storm
strikes city-wide instead of in a rolled band (see _Deviation from the
spec_ above), and `DisasterInfo` carries the event's tile list, which the
spec's stats section had ruled out — the renderer needs those tiles to
place embers and the flood film, and the tile diff channel carries only
the damage (Task 1; the spec was amended to match).

**Placeholders:** none — every code step carries real code. The three
steps that deliberately say "follow the file's existing pattern"
(`BudgetPanel` row, `sound.ts` cue, `app.css` rules,
`minimapLayer` colour) are UI shapes where copying the neighbouring rule
is the correct instruction and inventing markup here would fight the
file.

**Type consistency:** `DisasterEvent` fields (`id`, `kind`, `severity`,
`startTick`, `endTick`, `origin`, `tiles`, `intensity`) are used
identically in Tasks 1, 4–8, 10, 11, 15. `intensity` means burn ticks for
fires and water depth for floods everywhere it appears. `DisasterSpec`'s
`plan` returns `{ origin, tiles, intensity } | null` in Task 4 and in all
three kinds. `addDamage(state, index, points)`, `clearDamage`,
`isDamaged`, `damagedTileCount`, `activeDisasterTiles`, `disasterKindAt`,
`damagedBuildingShare`, `repairStep`, `disastersStep`, `disasterStats`
keep one signature each throughout. `effectiveWind(weather)` and
`windFactor(speed)` are used consistently in Task 5.
