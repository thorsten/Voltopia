# Building Visuals, Stage 1: Shape, Variety and Detail — Design

Date: 2026-10-03
Status: approved for planning
Backlog entry: none ("Visual Style" section of `docs/idea.md`)

## Goal

Zone buildings are the most common object on the map, and today they
are the plainest: one to three flat-coloured boxes per tile from a
per-zone recipe in `src/render/buildingsMesh.ts`, eight variants that
only jitter height and wall lightness, a rooftop PV slab from density 2,
and warm window quads at night. Plants, forests, water and terrain have
all grown richer since; the city itself still reads as stacked blocks.

Stage 1 gives every building a recognisable low-poly silhouette in the
spirit the design doc asks for (Townscaper, Islanders): pitched and
hipped roofs, chimneys, dormers, balconies, awnings, signs and rooftop
clutter, drawn from a per-zone colour family with several hues, so a
street of houses no longer looks stamped. Buildings also hint at their
supply status on their own body. The sim, the worker protocol and the
save format are untouched; this is a render-only change.

Stage 1 is the first of three stages agreed with the user:

1. **Shape, variety and detail** (this spec, render only).
2. **Animated accents** (render only): chimney smoke for self-heated
   buildings in the cold, rooftop vents, night-blinking antennas.
3. **Age** (sim + render): a per-tile age counter so buildings go from
   clean to lived-in to weathered.

Each stage gets its own spec and plan. Stage 1 leaves a reserved slot
for the stage 2 antenna light and keeps recipes data-driven so stage 3
can add age-dependent parts.

## Decisions

Decisions made with the user during brainstorming:

- **Procedural primitive kit, not models.** Buildings stay composed
  from instanced primitives generated in code. Hand-modelled GLTF
  assets and merged per-chunk geometry were considered and rejected:
  they need an asset pipeline or a chunk-rebuild scheme, and neither
  reacts to state as cheaply as per-instance colour.
- **Performance envelope: mid-range laptop at 60 fps.** Up to 8 parts
  per tile across a handful of instanced meshes; effects (stage 2) scale
  down with the existing reduced-motion and shadow settings. Phones get
  the same geometry.
- **Zones keep their identity colour.** Residential stays warm cream and
  brick, commercial cool grey and glass, retail rose and apricot, so the
  zone reads at a glance even with four wall hues each.
- **Supply status shows on the body, gently.** Undersupplied and
  disconnected buildings grey out a little; the Supply overlay remains
  the diagnostic tool.
- **Street side matters.** Doors, awnings and signs face an adjacent
  road, defaulting to the south face when there is none.

## Architecture

### Modules

`src/render/buildingsMesh.ts` currently mixes recipe generation,
instance bookkeeping and window layout. Stage 1 splits it:

- `src/render/buildings/recipes.ts` — pure, deterministic. Exports
  `buildingParts(zone, density, variant, index, streetFace)`,
  `buildingHeight(zone, density, variant, index)` and `mainBody(parts)`. No scene objects; only
  `THREE.Color` values and plain numbers, so it is unit-testable in
  node.
- `src/render/buildings/palette.ts` — per-zone colour families, shared
  accent colours, and `applySupplyTint(color, status)`.
- `src/render/buildingsMesh.ts` — the `DiffLayer`. Owns one
  `InstancedMesh` per primitive kind plus the window mesh, slot
  bookkeeping, the grow animation, street-side tracking, and the
  window layout.

`src/render/renderer.ts` keeps importing `buildingHeight` for picking
and icon placement; the signature gains the tile index (the call site
already has the diff). The street face only places doors, awnings and
signs and never changes a building's height, so `buildingHeight` does
not take it.

### Primitive kinds

```ts
export const PartKind = { Box: 0, GableRoof: 1, HipRoof: 2, Cylinder: 3 } as const;

export interface BuildingPart {
  kind: PartKind;
  /** Footprint (tile fractions) and height. */
  sx: number;
  sy: number;
  sz: number;
  /** Offset from tile centre (tile fractions) and base height. */
  ox: number;
  oy: number;
  oz: number;
  /** Rotation about Y in quarter turns (0..3). */
  turn: number;
  color: THREE.Color;
  /** Marks the body that carries windows (exactly one per building). */
  main?: boolean;
}
```

All four geometries share one convention: unit footprint centred on the
origin in x/z, base at y = 0, height 1, so the matrix code is one path
(`scale(sx, sy, sz)`, `rotateY(turn)`, `translate`).

- `Box`: `BoxGeometry(1, 1, 1)` translated up by 0.5 (as today).
- `GableRoof`: triangular prism, ridge along x, built once from six
  vertices with flat normals.
- `HipRoof`: four-sided pyramid, apex centred, flat normals.
- `Cylinder`: `CylinderGeometry(0.5, 0.5, 1, 8)` translated up by 0.5.

Each kind is one `InstancedMesh` with `MeshLambertMaterial`,
per-instance colour, `castShadow`, `receiveShadow`, and
`frustumCulled = false` (instance transforms span the grid; the base
geometry bounds would cull them).

### Capacity

Slots per kind are derived at startup: the recipe table is evaluated
once for every zone, density and variant with both street-face
orientations, and the maximum part count per kind becomes that mesh's
per-tile capacity. Total capacity is `gridSize² × maxPerKind`. The
richest recipe has 8 parts, so a 64×64 grid uses at most 32k instance
slots across the four meshes. Only built tiles consume slots at draw
time.

### Determinism

Recipes take a seeded picker over `variant` and `index`:
`pick(n)` returns a stable integer in `0..n-1` from a small hash of
`(variant, index, callCounter)`. The same tile always builds the same
house, every client renders the same city, and two neighbours with the
same variant still differ. `BUILDING_VARIANTS` (8, in
`src/sim/growth.ts`) is unchanged.

## Recipes

Footprints stay inside 0.86 of the tile so roads and zone tints stay
visible. Sizes are tile fractions; heights are world units (today a
density-3 commercial tower is 1.7 to 1.86 high, which stays the tallest
thing in the city).

### Residential

- **Density 1, detached house.** Body 0.42–0.5 wide, 0.3–0.38 high,
  offset up to 0.12 off centre so houses do not sit dead centre. Gable
  roof in one of two orientations, hip roof one time in four. Chimney
  (thin box) on one roof side. Door slab on the street face. One in
  three gets a side extension: a lower box with its own small gable.
  The rest of the tile stays bare (garden).
- **Density 2, town house.** Body 0.6 × 0.5, 0.55–0.65 high. Gable roof;
  half the variants add a dormer (small box plus mini gable). Door, a
  ledge band between floors, rooftop PV on the roof slope.
- **Density 3, apartment block.** Body 0.7 × 0.7, 1.0–1.2 high. Flat
  roof with a parapet (a thin box slightly wider than the body, sitting
  on the roof edge), stairwell box on top, two or three balcony slabs on
  the long face, rooftop PV, water-tank cylinder one time in three.

### Commercial

- **Density 1, low office.** Body 0.62 wide, 0.4 high, flat roof with a
  cornice band, entrance canopy slab on the street face, one AC unit
  box on the roof.
- **Density 2, office block.** Body 0.62, 1.0–1.1 high, glass-tone wall,
  two horizontal facade bands, two AC units and an antenna cylinder on
  the roof.
- **Density 3, tower.** Body 0.66, 1.6–1.9 high with a setback upper
  third (narrower box on top); one in two gets a cylindrical core or a
  rooftop plant room. The antenna position is a reserved part so stage 2
  can attach a blinking light.

### Retail

- **Density 1, shop.** Body 0.72 × 0.6, 0.3 high. Awning slab in the
  trim colour along the street face, sign box above the awning.
- **Density 2, wider shop.** Body 0.78 × 0.7, 0.45 high. Gable or hip
  roof over the back half, flat front with awning and sign.
- **Density 3, market hall.** Body 0.8 × 0.78, 0.8 high. Long gable roof
  across the full width, two awnings, two cylinder vent stacks.

### Rooftop PV

Appears from density 2 in every zone as today (mirrors the sim's
rooftop feed-in). On a pitched roof it lies on the slope; on a flat roof
it keeps the current slab.

### Street face

`streetFace` is one of N, E, S, W. `BuildingsMesh` keeps a
`Uint8Array(gridSize²)` of road presence filled from every diff whose
tile type is Road, and chooses the first adjacent road in the order
S, E, W, N when a building is placed or re-issued. No adjacent road
means S. A road change next to an existing building re-issues that
building's parts so its door turns toward the new street.

## Palette

Per zone: 4 wall hues, 3 roof hues, 2 trim hues, chosen per building by
the picker. Shared accents: door dark brown, rooftop PV navy
(`0x2b3d66`, unchanged), water tank light grey, chimney brick, AC units
white, antenna dark grey.

| Zone        | Walls                                        | Roofs                        | Trims             |
| ----------- | -------------------------------------------- | ---------------------------- | ----------------- |
| Residential | cream, sand, pale terracotta, soft white     | brick red, slate grey, brown | white, dark green |
| Commercial  | cool grey, blue-grey, glass teal, warm grey  | dark grey, near-black, steel | white, charcoal   |
| Retail      | dusty rose, apricot, pale yellow, light clay | dark red, olive, grey        | red, teal         |

Exact hex values are chosen in implementation against the existing
`PALETTE` ground tones and checked on the Mac.

### Supply tint

Applied when instance colours are written, to walls and roofs only
(accents keep their colour so the building still reads as the same
object):

- Supplied: unchanged.
- Undersupplied: blend 35 % toward mid grey (`0x8a8a8a`).
- NotConnected: blend 60 % toward mid grey and darken by 10 %.

The Supply overlay keeps its role as the diagnostic view.

## Windows

The layout uses the recipe's `main` part instead of "the first part".
Columns and rows derive from body size as today; roofs and clutter
never get windows. Street-facing shops (retail density 1 and 2) get one
wide shopfront quad instead of a grid. The one-in-three deterministic
dark-window skip and the night fade stay. The per-tile cap rises from
16 to 20 window quads.

## Animation and updates

- **Grow animation.** The ease-out scale-in from the base stays and
  applies to all of a building's parts across the four meshes, so a
  house pops up with its roof and chimney. Densify does the same.
  Reduced motion skips it.
- **Supply flip.** Colour-only update for that tile's slots; matrices
  untouched. Windows rebuild as today.
- **Incremental slots.** Each tile owns fixed slot ranges per kind,
  allocated on first build and released on removal through a free list
  per mesh. Changes touch only the affected tile's matrices and
  colours. A full repack happens only on `reset` for a new or loaded
  game. Freed slots are hidden by a zero-scale matrix until reused;
  `mesh.count` tracks the highest used slot + 1.

## Testing

Render code is outside the coverage gate but the pure parts are
unit-tested in the existing render test style (see
`src/render/vehiclesMesh.test.ts`):

- `src/render/buildings/recipes.test.ts`: for every zone, density,
  variant and street face: at most 8 parts; no part leaves the 0.86
  footprint or sinks below y = 0; exactly one `main` part;
  `buildingHeight` equals the tallest part top; same inputs give equal
  output; neighbouring indices with the same variant differ; rooftop PV
  present from density 2 only; the door/awning sits on the street face
  and defaults to south.
- `src/render/buildings/palette.test.ts`: supply blends keep channels
  in 0..1 and leave Supplied untouched; each zone exposes 4/3/2 hues.
- `src/render/buildingsMesh.test.ts` with a stub scene: build, densify,
  remove and rebuild cycles never leak slots; instance counts per kind
  match the live parts; a supply flip changes colour but not matrices;
  a road placed beside a house rotates its door; reduced motion skips
  the animation.
- `node scripts/smoke.mjs` still passes.
- Mac visual pass: three densities per zone on a fresh city, night
  windows, supply tint against the Supply overlay, frame time on a full
  64×64 map.

## Out of scope

Smoke and ambience (stage 2), age (stage 3), textures, any sim, worker
protocol or save change, agent tools and i18n (nothing user-facing or
command-level changes), plant and service-building meshes.
