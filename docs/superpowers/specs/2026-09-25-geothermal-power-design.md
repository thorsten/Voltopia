# Geothermal Power — Design

Date: 2026-09-25
Status: approved for planning
Backlog entry: "Geothermal plants at special terrain spots" in `docs/idea.md`

## Goal

Give the city its first true baseload: a generator that runs at full
output day and night, in every season, through any Dunkelflaute. Every
source built so far is driven by something outside the player's control
— solar by the sun and clouds, wind by the weather, run-of-river by the
flow, tidal by a clock that drifts against the day. Geothermal answers
none of them: it simply runs.

The price of that reliability is scarcity and depth. Hot rock sits where
the map's relief put it, usually far from the city centre, and each
field holds only so much heat. Drill more wells into one field than it
can sustain and the reservoir cools over days, dragging every well on it
down with it — reversibly, so the field recovers once the load comes
off. The interesting decision is therefore not "where do I put a plant"
but "how hard do I run this field".

## Scope

In scope:

- Geothermal hotspots: clustered tiles generated with the map, visible
  from the start, biased toward the highlands.
- `PlantType.GeothermalPlant`, buildable only on hotspot tiles.
- A per-field heat reservoir that cools under overload and recovers.
- Constant generation scaled by field quality and reservoir temperature.
- Rendering (fumaroles with steam, plant mesh), UI, i18n (EN + DE),
  agent tools, a city goal, save compatibility, tests, balancing.

Out of scope (not built now):

- District heating / heat-sector coupling — that is the separate "Heat
  sector" backlog item, and this design deliberately leaves room for it.
- Drilling risk (failed boreholes), exploration or survey mechanics: the
  hotspots are visible, so there is nothing to explore.
- Permanent reservoir depletion — cooling is always reversible.
- Induced seismicity / earthquakes; that belongs to "Disasters/events".
- Enhanced geothermal on non-hotspot tiles.

## World generation

A new module `src/sim/geothermal.ts`, pure sim, with its own seed salt so
map generation stays a set of independent deterministic streams
(`terrain.ts`, `water.ts`, `forest.ts`, `sea.ts` each already have one).
`generateGeothermal(state)` runs after terrain, water and sea are final —
it needs the finished elevation and the finished coastline — and before
forest generation, which may then grow woods over a hotspot (felling a
hotspot's woods costs the usual fee).

### Where the hotspots go

Hotspots are **clusters**, not single tiles. That is the premise of the
whole reservoir mechanic: several plants must be able to tap one field.

1. Candidate seed tiles are land tiles that are buildable (not water, not
   `tooSteep`), weighted toward the highlands: a tile with
   `elevation >= BALANCE.geothermal.highlandLevel` counts
   `highlandWeight` times as often as a lowland tile. Hot rock near the
   mountains, but never _only_ there — a map whose highlands are all too
   steep still gets its fields.
2. Seeds are drawn one at a time and rejected if they lie within
   `minSpotDistance` (Chebyshev) of an accepted seed, so fields never
   merge into one super-field.
3. Each accepted seed grows into a cluster of `clusterSizeRange` tiles by
   random flood fill over buildable land.
4. The target number of fields is
   `clamp(round(tiles / tilesPerSpot), minSpots, maxSpots)`. If candidate
   tiles run out, fewer fields are placed; `minSpots` is a target, not a
   guarantee, and the generator never loops forever.

Every tile of a cluster carries the same **quality** 1..3: a base of 1 or
2 drawn with equal probability, plus one step when the seed sits at or
above `highlandLevel`, capped at 3. Quality maps to an output factor
through `BALANCE.geothermal.qualityFactor`.

### Layers

Two new tile layers on `TileLayers` (both `Uint8Array`, both persisted
through the existing `optionalLayers` mechanism in
`src/storage/serialization.ts`):

- `geothermal` — 0 = no hotspot, else quality 1..3. Immutable after
  generation, exactly like `terrain` and `elevation`.
- `reservoirHeat` — 0..255, quantised reservoir temperature
  (`heat = value / 255`). Mutable, starts at 255 (a cold-started field is
  full of heat). All tiles of one cluster always carry the same value.

Field membership itself is **not** persisted. It is recomputed as
connected components of the `geothermal` layer whenever the state is
created or loaded (`state.geothermalFields: { tiles: number[]; quality:
number }[]`, transient), and the field's heat is read from its first
tile. That keeps the save format a pure layer dump and makes old saves
load without special cases.

## Reservoir model

Each field has a **sustainable well count**:

```
capacity = max(1, round(tiles.length * sustainablePerTile * qualityFactor[quality]))
```

`load` is the number of geothermal plants standing on that field's tiles,
whether or not they are connected to the grid — the same convention
`censusPlants` already uses for every other generator, so output and
drain are always counted over the same wells. Heat then follows, per
tick:

```
heat += recharge * (1 - heat) - drain * max(0, load - capacity) * heat
heat = clamp(heat, 0, 1)
```

Two properties make this the right shape:

- **Self-limiting and reversible.** Up to `capacity` wells the field
  stays at heat 1. Beyond it the temperature settles at a new equilibrium
  `recharge / (recharge + drain * excess)` instead of running to zero,
  and it climbs back toward 1 as soon as wells are removed. Nothing is
  ever lost permanently.
- **Diminishing, never punitive.** Total field output is
  `load * heat`, which keeps rising with each extra well but flattens
  toward an asymptote of `recharge / drain` well-equivalents. Overdrilling
  wastes capital and upkeep; it does not destroy what was already there.

With the starting values below, one well over capacity settles a field
near 77 % after roughly five in-game days, with the bulk of the drop in
the first day and a half — slow enough that overload is a late surprise,
fast enough to notice within a session.

Heat is only recomputed for tiles whose quantised value actually changed,
so a slow drift does not flood the diff channel. A field with no plants
on it and full heat costs nothing per tick.

## Energy

Following the `tidalCapacity` pattern in `src/sim/energy.ts`:

- `censusPlants` gains `geothermalPlants` and
  `geothermalCapacity = Σ qualityFactor[quality] * heat` over all
  geothermal plants.
- `geothermal = census.geothermalCapacity * BALANCE.energy.geothermalPeakOutput`,
  with **no** weather, daylight, season or tide factor — that absence is
  the feature.
- The term joins `generation` in `energyStep` and gets its own field in
  the energy stats and its own row in the energy panel breakdown. The
  history graph keeps only aggregate generation per sample
  (`EnergyHistoryPoint`), so geothermal shows inside the total line there;
  giving every source its own series is a separate change to the history
  format and is out of scope here.

Reservoir heat is stepped once per tick from the same place the census is
available, so output and drain always agree on the same `load`.

## Build rules

- `PlantType.GeothermalPlant = 15`.
- Buildable only where `geothermal[tile] > 0`; anything else is rejected
  with a new reason `needsHotspot` (i18n EN + DE).
- One plant per tile as usual, so a cluster's tile count is also its hard
  well limit — the reservoir curve governs everything below that.
- The slope surcharge applies (highland fields are expensive to develop)
  and so does the forest felling fee. No offshore case exists: hotspots
  are land only.
- Cost model: expensive to drill, cheap to run — a high build cost and an
  upkeep slightly below run-of-river.

## Rendering

- `src/render/geothermalMesh.ts`: per hotspot tile a small instanced
  fumarole cone plus a translucent steam billboard that rises and fades
  on `nowSeconds`. `frustumCulled = false` on every instanced mesh, per
  the project rule. Steam holds still under reduced motion, and dims with
  `nightFactor` like the other environment-driven layers.
- Steam opacity scales with the field's heat, so a cooled field visibly
  stops steaming — the mechanic is readable from the map, not only from
  the inspector.
- `plantsMesh.ts` gains the plant itself: a low turbine hall, a wellhead
  and a cooling tower, in new `PALETTE`/`COLORS` entries.
- `minimapLayer.ts` marks hotspot tiles so a field is findable when
  zoomed out.

## UI, i18n and agent tools

- `useTools.ts`: tool id `plant-geothermal`, hotkey `e` (Erdwärme; `e` is
  free today).
- `BuildBar.tsx`: button in the energy category with cost and tooltip.
- `TileInspector.tsx`: on a hotspot tile, show quality, reservoir
  temperature, well count and the field's sustainable well count — the
  player must be able to see _why_ output fell.
- `EnergyPanel.tsx`: generation row `energy.geothermal`.
- `i18n.tsx`: every new string in English **and** German, including the
  help-page paragraph explaining baseload and the reservoir.
- `src/agent/tools.ts` and `docs/agent-tools.md`: the new plant type for
  `build`, a `geothermal_hotspot` kind for `find`, the hotspot glyph in
  the tile map, and hotspot quality plus reservoir heat in `inspect_tile`.
- One city goal `geothermalBaseload`: hold at least 15 % of generation
  from geothermal for one full in-game day, tracked with a tick counter
  in `goalProgress` like the existing season streaks.

## Save compatibility

`SAVE_VERSION` stays 1. Both new layers join `optionalLayers` in
`src/storage/serialization.ts`. A save written before this feature has
neither layer; on load, `geothermal` is regenerated from the seed — the
generator is a pure function of seed, terrain and elevation, all of which
the save already carries — and `reservoirHeat` starts full. Old cities
therefore gain their hotspots in exactly the places a new game with the
same seed would have put them, with no plants on them yet.

## Balancing

Starting values for `BALANCE.geothermal`, to be refined with a temporary
headless probe (script a city via `SimEngine`, run ~20 in-game days, print
per-source generation shares and reservoir curves, then delete the probe):

| Value                              | Start                          | Reasoning                                                  |
| ---------------------------------- | ------------------------------ | ---------------------------------------------------------- |
| `tilesPerSpot`                     | 700                            | ~6 fields on a 64×64 map                                   |
| `minSpots` / `maxSpots`            | 3 / 8                          | never a map without geothermal, never a map made of it     |
| `minSpotDistance`                  | 8                              | fields stay distinct decisions                             |
| `clusterSizeRange`                 | [2, 5]                         | 2–5 wells per field before the hard tile limit             |
| `highlandLevel` / `highlandWeight` | 3 / 4                          | highlands are four times as likely, not exclusive          |
| `qualityFactor`                    | [0, 0.7, 1.0, 1.3]             | index = quality 1..3                                       |
| `sustainablePerTile`               | 0.5                            | a 4-tile field sustains 2 wells                            |
| `recharge`                         | 0.0005 / tick                  | recovery time constant ≈ 2 in-game days                    |
| `drain`                            | 0.00015 / tick per excess well | one excess well settles at ≈ 77 %                          |
| `energy.geothermalPeakOutput`      | 24                             | ≈ a run-of-river plant's _average_, but constant           |
| `costs.plant`                      | 3_200                          | drilling premium over the ≈2_600 its output would price at |
| `upkeepPerTick.plant`              | 0.05                           | below run-of-river (0.06): cheap to run                    |

The targets the probe checks: a fully developed field is a meaningful but
not dominating share of a mid-game city's mix, and a field drilled to its
last tile yields clearly less than its well count suggests — with the
values above, four wells on a four-tile, two-well field settle at 2.5
well-equivalents rather than 4.

## Tests

- `geothermal.test.ts` — determinism per seed; field count within bounds;
  clusters only on buildable land; minimum distance held; highland bias
  measurable over many seeds; quality within 1..3; a map whose highlands
  are all too steep still gets fields.
- Reservoir — heat holds at 1 at or below capacity; falls under overload
  and settles at the predicted equilibrium; recovers to 1 after wells are
  removed; stays within 0..1; all tiles of a field share one value.
- `energy.test.ts` — geothermal output is identical at noon and midnight,
  in a storm and in a Dunkelflaute; scales with quality and heat; a
  cooled field generates proportionally less.
- `serialization.test.ts` — both layers round-trip; a save without them
  loads and regenerates the hotspots identically to a fresh map.
- `goals.test.ts` — the baseload goal fires on a day at share, not below.
- `tools.test.ts` — build, find and inspect cover the new plant and the
  hotspots.

## Implementation order

Each step leaves the game runnable:

1. Layers, generation module, tests.
2. Field discovery, reservoir step, tests.
3. Plant type, build rules, census, energy contribution, tests.
4. Rendering: fumaroles, steam, plant mesh, minimap.
5. UI, i18n, help, tile inspector, energy panel.
6. Agent tools, docs, city goal.
7. Balancing probe, tune `BALANCE`, delete the probe.
