# Infrastructure Detail (5b) — Design

Date: 2026-10-13
Status: approved for planning
Part 5b of the visual-detail programme (2026-10-07), after 5a nature.
Style: detailed low-poly, vertex colours, no textures. Render-only.

## Goal

Power lines are a grey box per tile and one straight bar per span —
not even pitched on slopes. Roads have no kerbs and no crossings for
pedestrians; the streetlamp is a ball on a stick. Track has ballast
and rails but no sleepers, and signals exist only at level crossings.
Part 5b gives the grid recognisable pylons with sagging conductors,
the streets kerbs, zebra crossings and proper lamps, and the railway
sleepers and line-side signals that show whether a block is occupied.

## Decisions (with the user, 2026-10-13)

- **Conductors: three per span, sagging** (rejected: three straight;
  one sagging). Each span is a chain of short pitched segments along a
  parabola.
- **Two pylon types** (rejected: one type everywhere): a steel lattice
  pylon with two cross-arms on open land, a slim concrete pole with one
  short cross-arm on road, zone and plant tiles. Cross-arms stand
  across the line.
- **Signals show occupancy** (rejected: decorative only): red while a
  train stands in the block in front, green otherwise; lit at night.
- **Roads: kerbs, zebra crossings, new lamps; track: sleepers.**

## Architecture

### Pylons and conductors (`src/render/infrastructure/pylonModels.ts` new, `src/render/powerLinesMesh.ts` rewritten)

- `pylonModel(kind: 'lattice' | 'pole'): PylonModel` from `modelKit`:
  `{ geometry, parts, attachments: {x, y, z}[3] }`, base at y = 0,
  origin at the foot, cross-arms along local x (the line runs along
  local z). Lattice: four tapered legs, a few braces, two arms
  (upper arm one conductor in the middle, lower arm two at the ends,
  or three on one wide arm — whichever reads better), insulators;
  height ≈ today's `PYLON_HEIGHT` 0.55; footprint ≤ 0.3. Pole: one
  tapered round shaft, one arm carrying three insulators, height 0.42.
  `MAX_PARTS_PER_PYLON = 20`.
- Kind per tile: `pole` when the tile is a road, a plant or zoned;
  `lattice` otherwise. Road tiles keep the kerb position
  (`KERB_OFFSET`); elsewhere the tile centre.
- Yaw per tile from the connection mask: only E/W bits → line along x;
  only N/S → along z; a corner bisects its two directions (45°); T,
  cross and isolated → along x.
- Conductors: for every E and S connection (each span drawn once),
  three conductors between matching attachments of the two pylons
  (paired by their lateral offset across the span, so conductors never
  cross at corners), each `CABLE_SEGMENTS = 6` thin boxes along a
  parabola with mid-span sag `CABLE_SAG = 0.06`, every segment pitched
  between its end points. Cables cast no shadows; pylons do.
- `GrowingMesh` for pylons (one per kind) and conductors; bounded
  uploads.

### Roads (`src/render/roadsMesh.ts`, `src/render/infrastructure/roadFurniture.ts` new)

- **Kerbs:** a light kerb strip (`KERB_COLOR`, `KERB_WIDTH = 0.03`,
  rising `KERB_RISE = 0.015` above the asphalt) along every open edge
  of a land road tile: pad sides without an arm and both long sides of
  every arm. Laid with `composeBoxOnGround`, so they follow slopes. Not
  on bridges (they have railings).
- **Zebra crossings:** on junction tiles (3+ connections), on every
  connected arm, `ZEBRA_STRIPES = 4` white bars (`LINE_COLOR`) parallel
  to the traffic, spread across the road width, on the road surface
  like the centre line. Avenues and streets alike; not on bridges.
- **Lamps:** a model from `modelKit` — pole, curved-looking arm (two
  boxes) reaching over the road toward the tile centre, a lamp housing;
  the glowing head (existing `MeshBasicMaterial`, night opacity curve
  kept) sits under the housing at the arm's tip. Same lamp tiles and
  corner as today; yaw points the arm at the tile centre.
- Builders live in `roadFurniture.ts` (pure functions returning
  matrices for kerbs and zebra stripes per tile, plus the lamp model) so
  they are testable without the mesh.

### Railway (`src/render/railMesh.ts`, `src/render/infrastructure/railSignals.ts` new)

- **Sleepers** baked into the ballasted half-segment geometry:
  `SLEEPERS_PER_HALF = 3` dark-brown boxes (`SLEEPER_COLOR`) across the
  track on top of the ballast, under the rails. The segment mesh gets
  vertex colours (`modelKit` parts) instead of a single material
  colour. No extra instances. Not on road crossings.
- **Signals:** one mast per track tile that is not on a road or river
  and either borders (4-neighbour) a train station, freight terminal or
  rail yard tile, or has 3+ track connections. The mast stands
  `SIGNAL_OFFSET = 0.25` beside the track (side by tile direction), a
  `modelKit` model (mast, head box, hood) in one `GrowingMesh`; the lamp
  is a small `MeshBasicMaterial` sphere mesh with instance colours
  `SIGNAL_GREEN` / `SIGNAL_RED`.
- **Aspect:** red while any rail vehicle (locomotive or wagon,
  passenger or freight) is within `SIGNAL_BLOCK_TILES = 1.5`
  (Chebyshev, tile units) of the signal's tile centre, else green.
  `RailMesh.setTrains` keeps all rail vehicles for the signals (the
  crossings keep using locomotives only). Re-evaluated in `update`;
  colours re-uploaded only when an aspect changed.
- Lamp opacity `SIGNAL_DAY_OPACITY = 0.45` by day up to 1 at night
  (`setEnvironment`). Reduced motion changes nothing (no animation).
- `RailMesh.applyDiffs` records `plantType` per tile to find station
  neighbours.

## Testing

- `pylonModels.test.ts`: both kinds within the part budget and the
  tile; three attachments each, above 0.3; cross-arms along local x.
- `powerLinesMesh.test.ts` (new): pole on road/zone/plant tiles,
  lattice elsewhere; yaw per mask (straight x, straight z, corner);
  a straight span of 3 tiles gives 2 spans × 3 × 6 segments; every
  conductor segment's ends meet its neighbours (continuity); the
  mid-span point sags `CABLE_SAG` below the chord; on a slope the
  conductor follows the pitch; conductors do not cross at a corner;
  cables cast no shadow.
- `roadFurniture.test.ts`: a straight street has kerbs on both long
  sides and on none of its connected sides; a dead end has a kerb at
  the closed pad side; a T-junction gets zebra stripes on its three
  arms, a straight none; stripes lie inside the road; lamp model base
  at y = 0, arm tip over the road.
- `railMesh.test.ts`: segment geometry has sleeper parts; signals at a
  station neighbour and at a junction, none on a plain straight; aspect
  red with a wagon in the block, green when it leaves; no colour upload
  when nothing changed; day vs night opacity.
- Render-only: nothing under `src/sim`, `src/shared`, `src/storage`,
  `src/agent` changes.

Acceptance on the Mac (the user): lattice pylons in the country, poles
in town, three sagging conductors that follow slopes and turn corners
cleanly; kerbs and zebra crossings read at city zoom; new lamps glow at
night; sleepers visible; signals switch red/green as trains pass and
glow at night; frame time unchanged at 128².

## Out of scope

Traffic lights, sidewalks, road markings beyond zebras, catenary masts
over the track, gameplay or save changes.
