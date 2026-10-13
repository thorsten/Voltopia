# Road overpass over the railway — Design

Date: 2026-10-13
Status: approved for planning

## Goal

Every tile where a road crosses a track is a level crossing with
barriers, and road traffic waits whenever a train approaches. A player
who wants a busy street to flow builds an overpass: the crossing tile
becomes a road bridge over the track, with ramps on the two road tiles
either side. Cars never stop there and the barriers are gone.

## Decisions (with the user, 2026-10-13)

- **Built as an upgrade of an existing level crossing** (rejected:
  automatic for avenues; a separate bridge-building tool). A click
  tool, like the bus stop, paid once per crossing.
- **Ramps on the neighbouring road tiles** (rejected: deck and ramps
  within the crossing tile). The road tiles before and after the
  crossing along the road become ramps; they must exist.
- **Ramps two tiles long** (2026-10-13, after seeing one-tile ramps in
  the game: a 20° ramp reads as a kink in the isometric view). The
  length is `OVERPASS_RAMP_TILES` in `src/shared/constants.ts`.

## Scope

In: one new tile attribute, one build command, build rules, automatic
removal, the crossing logic, rendering of deck and ramps, vehicles
following the ramps, the UI tool, the agent tool, save compatibility.

Out: railway bridges over roads, overpasses at track bends or
junctions, at road junctions, or at crossings on river tiles; a cost
difference between street and avenue.

## Simulation

### State

`layers.overpass: Uint8Array` — 1 on a crossing tile that carries an
overpass, 0 elsewhere. The ramps are not stored: a road tile is a ramp
when its 4-neighbour along the road is an overpass tile whose road runs
toward it. `TileDiff` gains `overpass: number`. `snapshotTile` /
`restoreTile` carry it, so undo works unchanged.

### Command

`{ type: 'buildOverpass'; tiles: number[] }` — like `buildBusStop`, one
tile per click. `buildOverpasses(state, tiles)` in a new
`src/sim/overpass.ts` returns a `BuildResult`.

A tile accepts an overpass when all of these hold, checked in order and
rejected with the first failing reason:

1. `tileType === Road`, `rail` has `LINE_PRESENT`, no overpass yet, not
   a river tile — else `needsLevelCrossing`.
2. The track is straight: the rail bits are exactly `N|S` or exactly
   `E|W` — else `needsLevelCrossing`.
3. The road is straight and perpendicular to the track: its `roadMask`
   bits are exactly the other axis — else `needsStraightCrossing`.
4. The `OVERPASS_RAMP_TILES` (2) road tiles on each side along the
   road axis are plain road: no track, no overpass, not river, straight
   along the axis (the far one may dead-end toward the deck); and no
   other overpass of the same axis within twice that distance, so ramps
   never overlap — else `needsRampRoom`.
5. `damage === 0` (as every build) — else `damaged`.

Cost: `BALANCE.costs.overpass` (150) per tile, regardless of road
class. Undo entry: the crossing tile's snapshot plus the money. Tiles
already carrying an overpass are skipped without charge; a click that
builds nothing reports the rejection of the first tile.

### Automatic removal

`clearInvalidOverpasses(state, tiles)` runs after every road build,
road bulldoze, track build and track removal, over the affected tiles
and their 4-neighbours: an overpass tile whose conditions 1–4 no longer
hold drops to 0 (marked dirty, no refund). Bulldozing the crossing
tile itself clears the road, the track and the overpass as today.

### Traffic

`closedCrossings` skips tiles with `overpass !== 0`: no barrier, no
waiting. Trains ignore the overpass. Routing and lane capacity are
unchanged; the deck and ramps are road tiles like any other.

### Save games

`overpass` joins the optional layers in `serialization.ts`; an old
save without it loads with all zeros. No `SAVE_VERSION` bump.

## Rendering

Constants in `roadsMesh.ts`: `OVERPASS_LIFT = 0.3` (deck road surface
above the tile's ground, with `maxCornerY` as the ground of the deck
and ramp tiles so a sloped site does not tilt the deck).

- **Deck tile:** the road pad and lines are drawn at `ground +
OVERPASS_LIFT`, on a deck slab like the river bridges (`DECK_COLOR`),
  with railings along both sides of the road. The deck is a box with
  the full road width; the space under it is open so the track shows.
  No kerbs, no zebra crossing, no lamp, no bus shelter on the deck.
- **Ramp tiles:** over the `OVERPASS_RAMP_TILES` tiles the road pad
  and lines climb `OVERPASS_LIFT / OVERPASS_RAMP_TILES` per tile, from
  the ground at the far edge to `OVERPASS_LIFT` at the shared edge with
  the deck (per tile one box instance rotated about the axis across the
  road and stretched to the slope length). Under each tile a wedge of
  `DECK_COLOR` one rise high, standing on a plinth of the rises already
  climbed. Low walls along both sides. No lamp, no bus shelter on a
  ramp; the bus stop sign is left where it is.
- **Track under the deck:** `railMesh.ts` treats an overpass tile as
  plain track — ballasted halves, no flush rails, no barriers, no
  signal heads — and the rail stub logic is untouched.
- **Vehicles:** `vehiclesMesh.roadY(x, y)` adds `roadsMesh.lift(x, y)`:
  `OVERPASS_LIFT` on a deck tile, linear from 0 at the far edge of the
  ramp to `OVERPASS_LIFT` at the deck edge across the ramp tiles, 0
  elsewhere. The
  existing pitch sampling then tilts cars on the ramps.
- **Rebuilds:** a diff on an overpass tile re-draws its two ramp
  neighbours; a diff on a road tile re-draws it as a ramp when its
  neighbour is an overpass. `roadsMesh` keeps an `overpass` array
  beside `roadMasks` for that.
- **Picking and minimap:** unchanged.

## UI

- Tool `overpass` in `useTools.ts`, click tool like the bus stop, with
  the hover cost `BALANCE.costs.overpass`. No hotkey (the letters are
  taken).
- i18n keys, English and German: `tool.overpass` ("Overpass" /
  "Überführung"), `tool.overpass.desc`, `rejection.needsLevelCrossing`,
  `rejection.needsStraightCrossing`, `rejection.needsRampRoom`.
- `RailTileInfo` gains `overpass: boolean`; the inspector's track
  section shows an "Overpass" line when it is set. Upkeep: none beyond
  the road and track already on the tile.

## Agent

- Tool `build_overpass` with `x`, `y` (one tile), description naming
  the four build rules; `docs/agent-tools.md` table row.
- `inspect_tile` reports it through `RailTileInfo.overpass`; the
  tile mirror is unchanged.

## Testing

- `src/sim/overpass.test.ts`: each rejection reason; cost and money;
  undo restores the tile and refunds; skip of an existing overpass;
  automatic removal when the track, the road or a ramp neighbour goes;
  save round-trip with and without the layer.
- `src/sim/crossings.test.ts`: an overpass is never closed; the
  neighbouring plain crossing still is.
- `src/render/roadsMesh.test.ts`: deck and ramp instances for an
  overpass; `lift` values at deck, ramp midpoint, plain road; no lamp
  on deck or ramps; rebuild of a ramp when the overpass appears or
  goes.
- `src/render/railMesh.test.ts`: an overpass tile has ballasted halves
  and no barriers.
- `src/render/vehiclesMesh.test.ts`: a car on a ramp is lifted and
  pitched.
- `src/agent/tools.test.ts`: `build_overpass` builds and rejects.
