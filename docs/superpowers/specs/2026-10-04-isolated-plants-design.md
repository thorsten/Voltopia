# Isolated Plants: Grid-Connection Feedback — Design

Date: 2026-10-04
Status: approved for planning
Backlog entry: none (user report: "viele Kraftwerke ohne Netzanschluss,
das wird mir nur durch Anklicken angezeigt")

## Goal

The energy balance is global: every intact supply plant feeds it whether
or not a power line is attached. Lines only extend the 3-tile supply
ring to consumers. Yet the inspector shows "Grid connection: no" for a
supply plant without a line, which players read as "this plant is
useless", and nothing on the map shows which plants actually reach no
building. This feature gives that fact a map marker and clearer words.

A supply plant is **isolated** when no power line touches any of its
four sides and no building stands within its supply ring
(`BALANCE.energy.lineSupplyRadius`, Chebyshev). Isolated plants get a
permanent blue-grey bolt above them, a red tint in the Supply overlay,
a clear inspector line in both languages, and an agent `find_tiles`
kind. Generation is untouched.

## Decisions

Decisions made with the user:

- **Mark "serves no building", not "no line attached".** A village
  plant with houses in its ring is working as intended; only plants
  whose ring reaches nothing and that have no line are flagged. "No
  line attached" was rejected because it marks working plants.
- **Bolt icon plus overlay plus help text.** A permanent icon above the
  plant (like the red bolt above unconnected buildings) so the problem
  is visible without any overlay; the Supply overlay also tints
  isolated plants; the help page explains the new colour. Overlay-only
  was rejected (must switch it on to find them).
- **Not doing:** pylons on steep slopes. The user did not pick that
  gameplay change; the slope rule stays.

## Architecture

### Shared

- `src/shared/plants.ts` (new) — the supply-source set moves here from
  `src/sim/powerGrid.ts` so the renderer can use it without importing
  the sim:

  ```ts
  export const SUPPLY_SOURCES: ReadonlySet<PlantType>;
  export function isSupplySource(plant: PlantType): boolean;
  ```

  `powerGrid.ts` re-exports `isSupplySource` for its existing importers
  (`inspect.ts`, `heat.ts`, tests) so no other sim file changes its
  imports.

### Sim

- `src/sim/powerGrid.ts` — gains

  ```ts
  /** A power line touches one of the tile's four sides. */
  export function hasLineAttached(state: SimState, index: number): boolean;
  /** Supply plant with no line attached and no building in its supply ring. */
  export function isIsolatedPlant(state: SimState, index: number): boolean;
  ```

  `hasLineAttached` moves here from `inspect.ts` (which imports it
  back). `isIsolatedPlant` returns false for non-plant tiles and
  non-supply plants; otherwise `!hasLineAttached && no tile with
tileType Empty and density > 0 within lineSupplyRadius`. Damage is
  not consulted: isolation is about geometry, damage has its own
  overlay and icon.

- `src/sim/energy.ts` — `energyStep` gains a loop over supply plants
  after the building loop: `setSupplied(state, i, isIsolatedPlant(state, i)
? SupplyStatus.NotConnected : SupplyStatus.Supplied)`. `setSupplied`
  already marks the tile dirty only on change, so an unchanged plant
  costs no diff. `placePlant` sets the same status right after placing
  a supply plant so the first diff is correct (no one-tick red flash).
  Bulldozing resets `supplied` with the tile (added in this feature).

  Semantics of `layers.supplied` for a supply plant are therefore:
  `Supplied` = serves something (line attached or building in ring),
  `NotConnected` = isolated; `Undersupplied` never occurs on a plant.
  For every other tile type the field keeps its meaning. Saves need no
  change: the layer is persisted and the first tick refreshes it.

### Render

- `src/render/iconsMesh.ts` — the icon condition becomes "building with
  supply trouble OR isolated supply plant" (`tileType === Plant &&
isSupplySource(plantType) && supplied === NotConnected`). Plant icons
  are permanent (no linger) and tinted `COLOR_ISOLATED_PLANT = 0x7fa7c9`
  (blue-grey), distinct from the red building bolt and the orange
  undersupply bolt. A plant that stops being isolated loses its icon on
  the next diff; a plant that is bulldozed loses it too.
- `src/render/overlays.ts` — Supply mode additionally paints an isolated
  supply plant tile with `SUPPLY_COLORS[NotConnected]`; non-isolated
  plants stay unpainted so the overlay stays quiet.

### UI

- `src/ui/TileInspector.tsx` — for supply plants the "Grid connection"
  row is replaced by two rows: **Line attached** yes/no (from
  `info.connected`, whose meaning for supply plants is already "line
  attached") and **Serves** with either "buildings nearby" (positive)
  or the short "no building" (negative), from `info.supplied`. The
  negative case also renders a wrapping advice line,
  `inspect.servesNothingHint` ("Its output still counts — draw a power
  line toward your homes."), styled like the growth-blocker list.
  Stations, hubs, depots and heat plants keep the existing "Grid
  connection" row, because for them it really means powered or not.
- `src/ui/i18n.tsx` — new keys in English and German:
  `inspect.lineAttached` ("Line attached" / "Leitung angeschlossen"),
  `inspect.serves` ("Serves" / "Versorgt"),
  `inspect.servesNearby` ("buildings nearby" / "Gebäude im Umkreis"),
  `inspect.servesNothing` ("no building" / "kein Gebäude"),
  `inspect.servesNothingHint` ("Its output still counts — draw a power
  line toward your homes." / "Die Erzeugung zählt trotzdem – ziehe eine
  Leitung zu den Häusern."). The bolt help sentence (`help.*` entry
  that explains red and orange bolts) gains: "A blue-grey bolt above a
  plant means it reaches no building; its output still counts, but
  nobody nearby uses it." / "Ein blaugrauer Blitz über einer Anlage: sie
  erreicht kein Gebäude. Ihre Erzeugung zählt trotzdem, aber niemand in
  der Nähe nutzt sie."

### Agent tools

- `src/agent/tools.ts` — `FIND_KINDS` gains `isolated_plant`
  (`tileType === Plant && isSupplySource(plantType) && supplied ===
NotConnected`, evaluated on the tile mirror, which already carries
  `plantType` and `supplied`); the `find_tiles` description lists it.
- `docs/agent-tools.md` — the `find_tiles` row lists the new kind and a
  sentence explains isolation.

## Testing

- `src/sim/powerGrid.test.ts`: `isIsolatedPlant` is true for a lone
  wind turbine on empty land; false once a building stands anywhere in
  the ring (test the ring edge: distance 3 counts, 4 does not); false
  once a line touches a side; false for a non-supply plant (fire
  station) and for an empty tile.
- `src/sim/energy.test.ts`: `placePlant` leaves an isolated plant with
  `supplied === NotConnected` immediately and a plant next to a house
  with `Supplied`; one `energyStep` after a house grows in the ring the
  status flips to `Supplied` and the tile is in the dirty set; attaching
  a line flips it as well; a lone battery is evaluated like any other
  supply source (it is in `SUPPLY_SOURCES`), a fire station is not
  (its `supplied` keeps its old meaning).
- `src/render/iconsMesh.test.ts` (new): an isolated supply plant diff
  yields one icon with the blue-grey colour and no expiry; a
  `Supplied` plant diff removes it; a non-supply plant with
  `NotConnected` yields no icon; a building `NotConnected` still yields
  the red icon.
- `src/render/overlays.test.ts`: Supply mode paints an isolated plant
  red and leaves a supplied plant unpainted.
- `src/sim/inspect.test.ts`: the existing "connected only once a line
  is attached" test keeps passing; `supplied` on an isolated plant is
  `NotConnected`.
- `src/agent/tools.test.ts`: `find_tiles` with `isolated_plant` finds
  the lone turbine and not the one with a line.
- `node scripts/smoke.mjs` passes; coverage gate holds.
- Mac visual pass: the blue-grey bolt reads as "information", not
  "error", next to a red building bolt; the Supply overlay on a map
  with several hill-top turbines.

## Out of scope

Gameplay changes (slope rule, line costs), per-plant attribution of
which buildings a plant actually powers, a new `TileDiff` field, save
format, changes to how generation is counted.
