# Disasters & Events — Design

Date: 2026-09-27
Status: approved for planning
Backlog entry: "Disasters/events" in `docs/idea.md`

## Goal

Everything the city has built so far is tested only by the weather's
averages: a Dunkelflaute is a slow squeeze, a dry spell a slow dip. No
event has ever taken a working asset away. Disasters add that missing
pressure — a storm that feathers every rotor at the moment the wind
peaks, a fire that eats a block the fire stations do not reach, a spring
flood that drowns the plant somebody built in the floodplain.

The point is not punishment; it is that **preparation becomes a
mechanic**. Storms and floods announce themselves hours ahead, so the
player can fill storage, charge the hydrogen tank, or buy expensively
from the market before the hit. Fires do not announce themselves, which
is precisely why fire stations are worth their upkeep: coverage lowers
the chance of ignition and stops a fire spreading. Every risk is driven
by the city's own state, so the player can read it and reduce it, rather
than merely suffer it.

## Scope

In scope:

- A generic disaster lifecycle: risk → warning with countdown → active
  event → tile damage → paid-for repair over time.
- Three event kinds: storm (global, announced), fire (local, sudden),
  river flood (area, long announced).
- A repairable `damage` tile layer that gates generation, grid
  conduction and building operation.
- Wind turbine cut-out at storm wind speeds (`windFactor` gains the
  branch real turbines have).
- A disaster intensity setting in the new-game dialog (off / mild /
  normal / harsh), persisted in the save.
- Rendering (damage decals, fire glow and smoke, flood tint), UI
  (warning banner, toast, minimap marker, damage overlay, repair budget
  line, help), i18n (EN + DE), agent tools, one city goal, save
  compatibility, tests, balancing.

Out of scope (not built now):

- Destruction: nothing is ever removed by an event. Damage is always
  repairable. (The "damage escalates into loss" variant was considered
  and rejected: two states, much more balancing, and a mass rebuild
  after a big storm is click work, not play.)
- Manual repair: no repair tool, no per-tile click. Repair is automatic
  and paid for, so it scales to 200 damaged tiles without micromanagement.
- Population loss: residents and jobs of a damaged building keep
  counting. Coupling disasters straight into the demand model makes
  growth and tax income swing; the existing decay/abandonment logic
  already punishes long outages.
- Storm surge at the sea, earthquakes (including geothermally induced
  ones), hail, heat waves as events, insurance, emergency budgets.
- Repair crews dispatched from stations: fire coverage influences fires,
  not repair speed.
- Runtime toggling: intensity is chosen when a city is founded, not
  switched off when a warning appears.

## Data model

### The damage layer

A new `damage: Uint8Array` layer in `state.layers`, alongside `forest`
and `geothermal`: `0` = intact, `1..255` = damage points. One number
carries everything the rest of the system needs — it gates operation,
sets the repair bill, and scales the render intensity. `TileDiff` gains
`damage` so the renderer follows through the normal diff path.

### Event state

Pending and active events cannot be re-derived from `(seed, tick)` — the
RNG is reseeded as `seed ^ tick` on load — so they are part of the saved
state:

```ts
export const DisasterKind = { Storm: 0, Fire: 1, Flood: 2 } as const;
export type DisasterKind = (typeof DisasterKind)[keyof typeof DisasterKind];

export interface DisasterEvent {
  /** Monotonic id: stable React keys, agent-tool references. */
  id: number;
  kind: DisasterKind;
  /** 0..1; scales area and damage rate. */
  severity: number;
  /** Tick the event turns active (warning runs until here). */
  startTick: number;
  /** Hard end of the event; a fire may end earlier once extinguished. */
  endTick: number;
  /** Affected tiles: struck for a storm, grown for a fire, computed for a flood. */
  tiles: number[];
  /** Tile for the minimap marker and camera jump. */
  origin: number;
  /**
   * Per-tile intensity, parallel to `tiles`: burn ticks left for a fire,
   * water depth in elevation levels for a flood, unused for a storm.
   */
  intensity: number[];
}
```

`SimState.disasters = { pending: DisasterEvent[]; active: DisasterEvent[];
nextId: number; cooldownTicks: number }`. The cooldown is what keeps
three events from starting at once; together with the intensity factor it
is the only global frequency control.

The per-tile numbers two kinds need — how long a tile still burns, how
deep the water stands — share the one `intensity` array above, so a save
holds nothing but plain number lists.

### Intensity

`NewGameOptions.disasterScale` — `0` off, `0.5` mild, `1` normal, `1.6`
harsh — multiplies every risk. Persisted as `disasterScale?: number` and
exposed in `GlobalStats`. **Saves without the field load with `0`**: an
existing city never suddenly starts burning; disasters begin with a city
founded after the feature ships.

### Stats

```ts
GlobalStats.disasters: {
  scale: number;
  pending: DisasterInfo[];   // id, kind, severity, ticks, origin, tiles
  active: DisasterInfo[];    // the same, ticks counting down to the end
  damagedTiles: number;
  repairPerTick: number;
}
```

Never the layer — the HUD, the minimap markers and the agent tools work
off this summary, the renderer off tile diffs. The one exception is each
event's tile list: the renderer has to know which tiles carry embers and
which lie under the flood film, and the diff channel carries only the
damage. A fire covers a handful of tiles and a flood a few hundred, so
this stays well below a single tile diff burst, and it only moves while an
event runs.

### Balance

One `BALANCE.disasters` block: `cooldownTicks`, `repair: { pointsPerTick,
costPerPoint }`, and per kind `baseRisk`, its risk weights, `warnTicks`,
`durationTicks`, `severityRange` and damage rates. `BALANCE.energy` gains
`windCutOutSpeed`. No number lives outside `BALANCE`.

## Lifecycle

`src/sim/disasters.ts` owns the lifecycle; the kind-specific physics sits
in three flat neighbours — `storm.ts`, `fire.ts`, `flood.ts` — each
contributing a risk function, an area function and a per-tick apply
function. The framework is written once: warning, damage, repair, stats,
notification and tick integration.

`disastersStep(state)` runs **after `updateWeather`** and **before**
`reservoirStep`/`energyStep`: this tick's weather sets the risk, and the
damage must stand before generation and grid connectivity are computed.
Four phases:

1. **Retire** — events past `endTick` (or fully extinguished) leave
   `active`. Their damage stays; it heals separately.
2. **Activate** — events in `pending` whose `startTick` has come become
   active and write their first damage.
3. **Apply** — every active event runs its kind's apply function: the
   storm rolls fresh strikes across the city, the fire spreads to
   neighbours and burns down its timers, the flood damages its area by
   depth.
4. **Roll** — when `cooldownTicks === 0` and `disasterScale > 0`, each
   kind's risk is computed and drawn with
   `state.rng.chance(risk * scale)`. A hit appends a `pending` event
   with the kind's lead time (storm and flood hours ahead, fire
   `warnTicks = 0`) and sets the cooldown.

`repairStep(state)` is the second entry point. Every damaged tile that is
not inside an active event loses `pointsPerTick` damage and costs
`costPerPoint`. **With an empty treasury, damage freezes** instead of
going into debt — the city stays repairable once money flows again. The
spend is reported as a `repair` line in `BudgetStats`.

## The three kinds

One in-game day is 960 ticks, one in-game hour 40 ticks.

### Storm — global, announced

- **Risk** from the _front_ wind mean rather than the momentary wind:
  `baseRisk * ramp(windMean, stormWindThreshold)`, with a winter factor.
  A building wind high is therefore the warning behind the warning,
  readable in the existing wind display.
- **Lead time** ~4 in-game hours (160 ticks), duration ~3 hours.
- **Effect.** The storm adds a **gust** on top of the weather's random
  walk (`Weather.gust`, derived every tick from the active storms), so the
  wind the turbines see genuinely rises and the wind readout, the energy
  graph and the balance follow with no special path. A bias on the front
  _mean_ would not do: the walk reverts toward its mean far too slowly to
  move inside a three-hour storm, and would then stay high for hours
  afterwards. `windFactor` gains a
  **cut-out branch** at `BALANCE.energy.windCutOutSpeed`: above it the
  rotors feather and produce **nothing** — physically correct, and the
  heart of the mechanic, because the city loses its wind fleet exactly
  when the wind is strongest. On top of that, each tick a few tiles take
  damage, drawn from a weighted pool across the whole city: pylons and
  wind turbines heavily, other plants less, buildings lightly. (An earlier
  draft confined the strikes to a rolled band. A band needs its axis
  persisted on the event for no gameplay gain — the cut-out hits every
  turbine on the map anyway — so the storm simply strikes city-wide.)

### Fire — local, no warning

- **Risk** `baseRisk * dryness * exposure`. `dryness` from temperature,
  absent snowpack and a run of low cloud cover; `exposure` from the
  share of dense buildings **without** `SERVICE_FIRE` coverage plus
  mature forest in a drought. Every fire station therefore lowers the
  probability, not just the consequences.
- **Ignition site**: weighted pick among candidates — dense uncovered
  buildings, stage-3 forest tiles.
- **Spread**: each tick a chance to ignite 4-neighbours that are
  flammable (buildings, forest). Roads, water and empty tiles are
  firebreaks. Inside fire coverage the spread chance is heavily reduced
  and burn timers run out faster: a fire in a well-covered district
  stays one tile, one in an outlying district eats a block. Burning
  tiles accumulate damage per tick; forest tiles are cleared to stage 0
  instead of damaged.
- **End**: when every tile is extinguished, at the latest after a cap
  (~2 hours), so nothing ever burns forever.

### River flood — area, long announced

- **Risk** from `riverFlow` near its maximum, snowmelt (a falling
  `snowpack` in warm weather) and sustained rain — the spring melt peak
  that `seasons.ts` and `weather.ts` already produce.
- **Lead time** ~6 hours (the gauge rises visibly before it spills),
  duration ~8 hours.
- **Area is computed, not rolled**: every tile whose `elevation` is at
  most `floodRise(severity)` above the level at the water's edge and
  that is connected over land to river or lake, via a height-ordered
  flood fill from the water tiles. The same map floods the same
  floodplain at the same severity, so building there is an informed
  choice after the first flood.
- The `terrain` layer is **not** touched — the inundation lives only in
  `damage` and the event's tile list. Overwriting terrain would destroy
  the real terrain underneath, the exact class of bug this project has
  already been bitten by.
- **Effect**: buildings, plants and lines in the floodplain take damage
  per tick, faster the deeper they sit. Run-of-river keeps generating —
  a flood means plenty of river, and the irony is intended.

## Effects on existing systems

- **`energy.ts` / `censusPlants`** — tiles with `damage > 0` drop out:
  no generation, no storage capacity. `storedEnergy` (battery, pumped,
  hydrogen) must be clamped to the shrunken capacity, or more energy
  sits in the fleet than fits. The content of a damaged battery is not
  lost, only unreachable until it is repaired.
- **`powerGrid.ts` / `recomputeGrid`** — damaged line tiles do not
  conduct (treated as "no line" in the flood fill) and damaged plants
  are not supply sources, so a downed pylon can island a whole district:
  the real threat of a storm. Every `damage` transition 0 ↔ non-zero
  calls `bumpGridVersion`.
- **Buildings** — a damaged building consumes nothing and is marked
  unsupplied through the **existing** path. Population and jobs keep
  counting (see Scope).
- **Roads are never damaged.** No event writes damage to a road tile.
  Damaged roads would have to be removed from the road graph, which
  reaches into routing, commutes, deliveries and transit lines all at
  once — far beyond this feature. Roads stay passable and keep working as
  firebreaks.
- **`services.ts` / `recomputeServices`** — a damaged fire or police
  station stamps no coverage (the check joins the existing "must be
  energised" condition). A fire that reaches the fire station therefore
  widens its own path, and a storm that islands a district takes its
  protection with it.
- **`happiness.ts`** — two new terms: a standing penalty proportional to
  `damagedBuildings / buildings`, and a smaller acute penalty while any
  event is active. Both from `BALANCE`.
- **`economy.ts`** — a new `repair` budget line. Upkeep for damaged
  plants **continues**: you pay for broken assets, which is the pressure
  to have them repaired.
- **`state.ts`** — building on a damaged or burning tile is refused with
  a new rejection code `damaged` (i18n `rejection.damaged`). Bulldozing
  stays allowed and clears the damage with the tile.
  `snapshotTile`/undo carry `damage`.
- **`goals.ts`** — one goal, `stormProof`: ride out a storm with no
  supply deficit. It rewards exactly the preparation the warning makes
  possible.
- **`inspect.ts`** — `TileInfo` gains `damage` and, inside an active
  event, its kind, so the tile inspector can say "line damaged, repair
  under way".

## Rendering, UI, agent tools

- **Render** — a damage decal over affected tiles (the existing
  `decal.ts` pattern); fire as a small instanced ember/flame mesh with a
  smoke plume (the steam pattern from `geothermalMesh.ts`); flood as a
  tint/water film over the event area rather than a real water surface,
  which leaves `waterMesh.ts` untouched. Every new `InstancedMesh` sets
  `frustumCulled = false`.
- **UI** — warning banner with countdown and kind above the HUD, toast
  on impact, minimap marker, a "Damage" entry in `OverlayToggle`, the
  repair line in `BudgetPanel`, the intensity control in `NewGamePage`, a
  section in `HelpPage`, a warning sound via `sound.ts`. All strings in
  `i18n.tsx`, **English and German**.
- **Agent tools** (`src/agent/tools.ts`, DOM-free, tested against the
  headless `SimEngine`) — `get_disasters` (pending and active events with
  countdown, kind, place, severity), `damage` in the tile inspect
  result, `damaged` as a new `find` kind, `stats.disasters` in the status
  output. The table in `docs/agent-tools.md` is updated in the same
  breath; feature parity there is mandatory.

## Testing

- `disasters.test.ts` — lifecycle (warning → active → retire), cooldown,
  `scale = 0` never produces an event, repair heals and bills, an empty
  treasury freezes damage.
- `storm.test.ts` — cut-out drives wind output to zero; line damage
  islands a district (measured on `energized`).
- `fire.test.ts` — spread stops at roads; coverage lowers spread and
  shortens burn; forest burns down to stage 0.
- `flood.test.ts` — the area is deterministic and monotone in severity;
  `terrain` is unchanged afterwards.
- Determinism — two engines with the same seed produce the same event
  sequence; a save/load in the middle of a warning and of a fire restores
  both. (The RNG is deliberately reseeded on load, so a loaded city is not
  expected to reproduce the unsaved future — only what was already in
  flight at save time.)
- Coverage gate ≥ 90 % on `src/sim` covers the new modules too.

## Balancing

A temporary headless probe (the pattern from the commit
`balance: resize energy system`): a scripted city over ~20 in-game days
per intensity level, printing events per kind, damaged tiles, and repair
cost against income. Target feel at `normal`: a storm every few days, a
fire only where coverage is missing, a flood once per spring melt, and a
repair bill that hurts without being ruinous for a city that prepared.
Deleted once the numbers are in `BALANCE`.

## Save compatibility

`damage`, `disasters` and `disasterScale` are all optional; `SAVE_VERSION`
stays **1**. Old saves load intact, with no damage, no events, and
`disasterScale = 0`.
