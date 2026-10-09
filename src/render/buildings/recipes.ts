import * as THREE from 'three';
import { Zone } from '../../shared/types.ts';
import { PartKind } from './primitives.ts';
import { ACCENT, ZONE_FAMILIES, type ZoneFamily } from './palette.ts';

/** Which side of a building faces the street; the value is also the quarter-turn count. */
export const StreetFace = { South: 0, East: 1, North: 2, West: 3 } as const;
export type StreetFace = (typeof StreetFace)[keyof typeof StreetFace];
export const STREET_FACES: readonly StreetFace[] = [
  StreetFace.South,
  StreetFace.East,
  StreetFace.North,
  StreetFace.West,
];

/** Parts the stage 2 effects layer attaches to (smoke, puffs, beacon). */
export const PartRole = { Chimney: 0, Vent: 1, Antenna: 2 } as const;
export type PartRole = (typeof PartRole)[keyof typeof PartRole];

/** Shared stage 4 details; tests and heuristics skip parts carrying this tag. */
export type PartDetail = 'plinth' | 'ridge' | 'gutter';

export interface BuildingPart {
  kind: PartKind;
  /** Footprint (tile fractions) and height, before rotation. */
  sx: number;
  sy: number;
  sz: number;
  /** Offset from the tile centre (tile fractions) and base height. */
  ox: number;
  oy: number;
  oz: number;
  /** Rotation about Y in quarter turns (0..3), applied after `tilt`. */
  turn: number;
  /** Optional rotation about the part's local x axis in radians (rooftop PV on a slope). */
  tilt?: number;
  color: THREE.Color;
  /** The body that carries windows — exactly one per building. */
  main?: boolean;
  /** Accents keep their colour under the supply tint. */
  accent?: boolean;
  /** Effect anchor for buildingFxMesh.ts; the anchor is the part's top centre. */
  role?: PartRole;
  /** Set on the shared details (plinth, ridge cap, gutters). */
  detail?: PartDetail;
  /**
   * A secondary body that carries windows too (semi-detached half, L-house
   * wing, stacked storey); laid out like the main body, see windowLayout.ts.
   */
  windows?: true;
  /**
   * A thin band run across the facade (balcony slab, ledge): windows may sit
   * behind it, so the window layout does not drop frames it crosses.
   */
  band?: true;
}

export const MAX_PARTS_PER_TILE = 16;
/** Slots a tile owns per primitive kind; proven over the whole grid by recipes.test.ts. */
export const MAX_PARTS_PER_KIND: Record<PartKind, number> = {
  [PartKind.Box]: 12,
  [PartKind.GableRoof]: 3,
  [PartKind.HipRoof]: 2,
  [PartKind.Cylinder]: 3,
  [PartKind.ShedRoof]: 2,
};
/** Half of the 0.86 footprint: no part may reach past this from the tile centre. */
export const FOOTPRINT_HALF = 0.43;

/** How far a pitched roof reaches past its body on each side. */
export const ROOF_OVERHANG = 0.02;
/** The market hall's long gable is scaled rather than offset over its wide body. */
const MARKET_HALL_ROOF_MARGIN = 1.04;
/** Extra footprint (both sides together) of the flat roof slabs over a parapet. */
const PARAPET_MARGIN = { apartment: 0.04, shop: 0.02 } as const;
/** Stone base under every main body. */
export const PLINTH_HEIGHT = 0.04;
/** How far the plinth stands proud of the body on each side. */
export const PLINTH_OVERHANG = 0.008;
/** Thin box along a gable's ridge. */
export const RIDGE_CAP = { w: 0.02, h: 0.015 } as const;
/** The ridge cap is the roof colour darkened by this factor (it still ages with the roof). */
export const RIDGE_DARKEN = 0.85;
/** Thin box hanging under each eave of a gable. */
export const GUTTER = { w: 0.015, h: 0.015 } as const;
/** The residential door's footprint, shared with buildingsMesh.ts's window layout. */
export const DOOR = { width: 0.2, height: 0.16, depth: 0.02 };
const ROOFTOP_PV_THICKNESS = 0.02;
/** The residential chimney box (footprint side and height). */
const CHIMNEY = { w: 0.06, h: 0.18 } as const;
/** The semi-detached doors sit this far toward the outer ends (fraction of the free run). */
const SEMI_DOOR_ALONG = 0.6;
/** How far a bay window stands proud of the facade. */
export const BAY_DEPTH = 0.08;
/** Bay window: width along the facade, height as a fraction of the body, glazing. */
const BAY = {
  width: 0.14,
  heightFraction: 0.6,
  roofHeight: 0.05,
  // Keeps the bay clear of the door on the narrow (0.5) east/west facade too.
  sideMargin: 0.01,
  glassFraction: 0.7,
  glassDepth: 0.01,
} as const;
/** Gap between the corner house's door and its facade corner. */
const CORNER_DOOR_INSET = 0.015;
/** How far the stepped block's top storey steps back from the street. */
export const SETBACK = 0.18;
/** The stepped block's top storey height. */
const TOP_STOREY_HEIGHT = 0.24;
/** Roof-terrace railing in front of the stepped block's top storey. */
const RAILING = { h: 0.05, d: 0.015 } as const;
/** Canopy shop: forecourt canopy depth, low-edge height (fraction of the body), posts, sign. */
const CANOPY = {
  depth: 0.22,
  heightFraction: 0.62,
  pitch: 0.05,
  post: 0.025,
  signHeight: 0.055,
} as const;
/** The residential storey over the shop with a flat. */
const FLAT_STOREY_HEIGHT = 0.2;
/** Its shop sign fits between the awning and the cornice. */
const FLAT_SIGN_HEIGHT = 0.055;
/** Supermarket glass entrance and the flat canopy over it. */
const SUPERMARKET_ENTRANCE = { w: 0.26, h: 0.24, d: 0.06 } as const;
const SUPERMARKET_CANOPY = { w: 0.4, h: 0.03, d: 0.1 } as const;
/** Antenna mast diameter (office block, towers). */
const ANTENNA_WIDTH = 0.03;
/** Pavilion: shed roof rise, glass front (fractions of the facade), its fins. */
const PAVILION = {
  roofHeight: 0.08,
  glassWidthFraction: 0.8,
  glassHeightFraction: 0.82,
  glassDepth: 0.02,
  fin: 0.015,
} as const;
/** Atrium office: wing footprint, the atrium between the wings, back wing step up. */
const ATRIUM = {
  wingWidth: 0.58,
  wingDepth: 0.24,
  gap: 0.2,
  glassWidth: 0.46,
  glassHeight: 0.48,
  step: 0.06,
} as const;
/** Twin towers: podium, its roof slab, slim towers and their tops (the tower band). */
const TWIN_TOWERS = {
  podium: { w: 0.8, d: 0.64, h: 0.3 },
  slab: 0.03,
  tower: { w: 0.3, d: 0.32 },
  spacing: 0.2,
  setback: 0.06,
  top: 1.6,
  topRange: 0.3,
} as const;
/** Depth of a roll-up door slab on a factory facade. */
const ROLL_UP_DOOR_DEPTH = 0.02;
/** Rise of the shed roof over a factory hall. */
const HALL_SHED_PITCH = 0.1;
/** PV on a hall's shed roof: its length as a fraction of the slope. */
const SHED_PV_DEPTH_FRACTION = 0.4;
/** Gap between a rooftop PV slab's pivot and the slope under it. */
const PV_LIFT = 0.01;
/** Lean-to against the hall's side wall and its shed roof. */
const LEAN_TO = { w: 0.2, d: 0.36, h: 0.2, pitch: 0.06 } as const;
/** The lean-to hall's roll-up door width as a fraction of the facade. */
const LEAN_TO_DOOR_FRACTION = 0.4;
/** Loading ramp up to the door threshold: slope length and slab thickness. */
const RAMP = { length: 0.14, thickness: 0.02 } as const;
/** Raised dock slab and its two roll-up doors. */
const DOCK = { h: 0.06, d: 0.12, gap: 0.02, doorWidth: 0.16, doorHeightFraction: 0.55 } as const;
/** One-storey office annex beside the dock, below the hall's eave. */
const DOCK_ANNEX = { w: 0.24, d: 0.22, h: 0.3, roof: 0.03 } as const;
/** Silo of the conveyor works: footprint, height, position (u toward the silo side). */
const SILO = { d: 0.18, h: 0.66, u: 0.3, lz: -0.05 } as const;
/** Conveyor bridge: width, thickness and where its foot rests on the hall roof (u). */
const CONVEYOR = { w: 0.07, thickness: 0.04, footU: -0.1 } as const;

export type ResidentialSilhouette =
  | 'detached'
  | 'lHouse'
  | 'semiDetached'
  | 'townHouse'
  | 'bayWindow'
  | 'cornerHouse'
  | 'apartment'
  | 'steppedBlock';
export type RetailSilhouette =
  | 'shop'
  | 'canopyShop'
  | 'wideShop'
  | 'shopWithFlat'
  | 'marketHall'
  | 'supermarket';
export type CommercialSilhouette =
  | 'lowOffice'
  | 'pavilion'
  | 'officeBlock'
  | 'atriumOffice'
  | 'tower'
  | 'twinTowers';
export type IndustrialSilhouette =
  | 'workshop'
  | 'leanToHall'
  | 'plant'
  | 'loadingDock'
  | 'works'
  | 'conveyorWorks';

/**
 * Silhouette choices per density, drawn uniformly from the list. The
 * first is the existing, tuned default and listed most often (3 of 7, or
 * 1 of 2), so it stays the common house on the street.
 */
const RESIDENTIAL_SILHOUETTES: Record<1 | 2 | 3, readonly ResidentialSilhouette[]> = {
  1: ['detached', 'detached', 'detached', 'lHouse', 'lHouse', 'semiDetached', 'semiDetached'],
  2: [
    'townHouse',
    'townHouse',
    'townHouse',
    'bayWindow',
    'bayWindow',
    'cornerHouse',
    'cornerHouse',
  ],
  3: ['apartment', 'steppedBlock'],
};
const RETAIL_SILHOUETTES: Record<1 | 2 | 3, readonly RetailSilhouette[]> = {
  1: ['shop', 'canopyShop'],
  2: ['wideShop', 'shopWithFlat'],
  3: ['marketHall', 'supermarket'],
};
const COMMERCIAL_SILHOUETTES: Record<1 | 2 | 3, readonly CommercialSilhouette[]> = {
  1: ['lowOffice', 'pavilion'],
  2: ['officeBlock', 'atriumOffice'],
  3: ['tower', 'twinTowers'],
};
const INDUSTRIAL_SILHOUETTES: Record<1 | 2 | 3, readonly IndustrialSilhouette[]> = {
  1: ['workshop', 'leanToHall'],
  2: ['plant', 'loadingDock'],
  3: ['works', 'conveyorWorks'],
};
/** The silhouette lists of every zone with recipes, for `silhouetteOf`. */
const ZONE_SILHOUETTES: Record<number, Record<1 | 2 | 3, readonly string[]>> = {
  [Zone.Residential]: RESIDENTIAL_SILHOUETTES,
  [Zone.Commercial]: COMMERCIAL_SILHOUETTES,
  [Zone.Retail]: RETAIL_SILHOUETTES,
  [Zone.Industrial]: INDUSTRIAL_SILHOUETTES,
};

export interface Picker {
  /** Stable integer in 0..n-1. */
  pick(n: number): number;
  /** Stable float in [0, 1). */
  unit(): number;
  chance(probability: number): boolean;
  from<T>(list: readonly T[]): T;
}

/**
 * Seeded picker over (variant, tile index): the same tile always builds
 * the same house on every client; neighbours with the same variant differ.
 * mulberry32 over a hash of both inputs.
 */
export function createPicker(variant: number, index: number): Picker {
  let state = (Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(variant + 1, 0x85ebca77)) | 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let x = Math.imul(state ^ (state >>> 15), 1 | state);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return (x ^ (x >>> 14)) >>> 0;
  };
  const unit = (): number => next() / 4294967296;
  return {
    pick: (n) => next() % n,
    unit,
    chance: (probability) => unit() < probability,
    from: (list) => list[next() % list.length],
  };
}

/** Rotate an offset given in the south-facing frame (street at +z) onto `face`. */
export function faceOffset(lx: number, lz: number, face: StreetFace): [number, number] {
  switch (face) {
    case StreetFace.South:
      return [lx, lz];
    case StreetFace.East:
      return [lz, -lx];
    case StreetFace.North:
      return [-lx, -lz];
    default:
      return [-lz, lx];
  }
}

/** Extent of `body` along the given face (its width as seen from the street). */
export function faceWidth(body: BuildingPart, face: StreetFace): number {
  return face === StreetFace.East || face === StreetFace.West ? body.sz : body.sx;
}

/** Extent of `body` perpendicular to the given face (depth away from the street). */
export function faceDepth(body: BuildingPart, face: StreetFace): number {
  return face === StreetFace.East || face === StreetFace.West ? body.sx : body.sz;
}

/** First adjacent road in the order south, east, west, north; south when none. */
export function streetFaceFor(
  index: number,
  gridSize: number,
  isRoad: (index: number) => boolean,
): StreetFace {
  const x = index % gridSize;
  const z = Math.floor(index / gridSize);
  if (z + 1 < gridSize && isRoad(index + gridSize)) return StreetFace.South;
  if (x + 1 < gridSize && isRoad(index + 1)) return StreetFace.East;
  if (x > 0 && isRoad(index - 1)) return StreetFace.West;
  if (z > 0 && isRoad(index - gridSize)) return StreetFace.North;
  return StreetFace.South;
}

interface Local {
  /** Size in the south frame: w along the face, h up, d away from the street. */
  w: number;
  h: number;
  d: number;
  /** Offset from the body centre in the south frame; +lz is toward the street. */
  lx: number;
  ly: number;
  lz: number;
  /** Extra quarter turns on top of the face rotation. */
  turn?: number;
  tilt?: number;
}

function box(
  sx: number,
  sy: number,
  sz: number,
  ox: number,
  oy: number,
  oz: number,
  color: THREE.Color,
  flags: { main?: boolean; accent?: boolean; role?: PartRole; band?: true; windows?: true } = {},
): BuildingPart {
  return { kind: PartKind.Box, sx, sy, sz, ox, oy, oz, turn: 0, color, ...flags };
}

/** True for the shared details (plinth, ridge cap, gutters). */
export function isDetailPart(part: BuildingPart): boolean {
  return part.detail !== undefined;
}

/** Stone base hugging the bottom of `body`, a hair proud of its walls. */
function plinth(body: BuildingPart, family: ZoneFamily): BuildingPart {
  return {
    ...box(
      body.sx + 2 * PLINTH_OVERHANG,
      PLINTH_HEIGHT,
      body.sz + 2 * PLINTH_OVERHANG,
      body.ox,
      body.oy,
      body.oz,
      family.plinth,
    ),
    detail: 'plinth',
  };
}

const ridgeColors = new Map<number, THREE.Color>();

/** Darkened roof colour, shared per hue like the palette colours. */
function ridgeColor(color: THREE.Color): THREE.Color {
  const hex = color.getHex();
  let ridge = ridgeColors.get(hex);
  if (!ridge) {
    ridge = color.clone().multiplyScalar(RIDGE_DARKEN);
    ridgeColors.set(hex, ridge);
  }
  return ridge;
}

/** Thin box along a gable's ridge (local x), centred on the ridge line. */
function ridgeCap(roof: BuildingPart, color: THREE.Color): BuildingPart {
  return {
    kind: PartKind.Box,
    sx: roof.sx,
    sy: RIDGE_CAP.h,
    sz: RIDGE_CAP.w,
    ox: roof.ox,
    oy: roof.oy + roof.sy - RIDGE_CAP.h / 2,
    oz: roof.oz,
    turn: roof.turn,
    color: ridgeColor(color),
    detail: 'ridge',
  };
}

/** One gutter under each eave of a gable (its local ±z edges), honouring the roof's turn. */
function gutters(roof: BuildingPart): BuildingPart[] {
  return [-1, 1].map((side) => {
    const [dx, dz] = faceOffset(0, side * (roof.sz / 2 - GUTTER.w / 2), roof.turn as StreetFace);
    return {
      kind: PartKind.Box,
      sx: roof.sx,
      sy: GUTTER.h,
      sz: GUTTER.w,
      ox: roof.ox + dx,
      oy: roof.oy - GUTTER.h,
      oz: roof.oz + dz,
      turn: roof.turn,
      color: ACCENT.gutter,
      accent: true,
      detail: 'gutter',
    };
  });
}

/** Ridge cap and both gutters of a gable. */
function gableDetails(roof: BuildingPart): BuildingPart[] {
  return [ridgeCap(roof, roof.color), ...gutters(roof)];
}

/**
 * A part described relative to `body` in the street-facing frame and
 * rotated onto `face`. The geometry turns with the face so `w` always runs
 * along the facade.
 */
function facePart(
  kind: PartKind,
  body: Pick<BuildingPart, 'ox' | 'oy' | 'oz'>,
  face: StreetFace,
  local: Local,
  color: THREE.Color,
  flags: { main?: boolean; accent?: boolean } = {},
): BuildingPart {
  const [dx, dz] = faceOffset(local.lx, local.lz, face);
  const part: BuildingPart = {
    kind,
    sx: local.w,
    sy: local.h,
    sz: local.d,
    ox: body.ox + dx,
    oy: body.oy + local.ly,
    oz: body.oz + dz,
    turn: ((local.turn ?? 0) + face) % 4,
    color,
    ...flags,
  };
  if (local.tilt) part.tilt = local.tilt;
  return part;
}

/** A thin slab hugging the street face of `body`. */
function onStreetFace(
  body: BuildingPart,
  face: StreetFace,
  widthFraction: number,
  height: number,
  depth: number,
  ly: number,
  color: THREE.Color,
  along = 0,
): BuildingPart {
  const w = faceWidth(body, face) * widthFraction;
  return facePart(
    PartKind.Box,
    body,
    face,
    {
      w,
      h: height,
      d: depth,
      lx: along * (faceWidth(body, face) / 2 - w / 2),
      ly,
      lz: faceDepth(body, face) / 2 + depth / 2,
    },
    color,
    { accent: true },
  );
}

/** Slab size as fractions of the roof width and slope, centred `at` that fraction up the slope. */
interface PvFit {
  w: number;
  d: number;
  at: number;
}
const GABLE_PV_FIT: PvFit = { w: 0.6, d: 0.6, at: 0.5 };
/** Lower and narrower on a hip roof, whose front face narrows toward the apex. */
const HIP_PV_FIT: PvFit = { w: 0.3, d: 0.3, at: 0.35 };

/**
 * Rooftop PV lying on the street-facing slope of a gable roof whose
 * eaves span `roofDepth` (in the face frame) and whose ridge is `roofHeight`
 * above the eaves at `ly`. The slab pivots at its base, so the pivot sits a
 * hair above the slope midpoint along the slope normal.
 */
function pvOnSlope(
  body: BuildingPart,
  face: StreetFace,
  roofWidth: number,
  roofDepth: number,
  roofHeight: number,
  ly: number,
  fit: PvFit = GABLE_PV_FIT,
): BuildingPart {
  const run = roofDepth / 2;
  const angle = Math.atan2(roofHeight, run);
  const slope = Math.hypot(run, roofHeight);
  const lift = PV_LIFT;
  return facePart(
    PartKind.Box,
    body,
    face,
    {
      w: roofWidth * fit.w,
      h: ROOFTOP_PV_THICKNESS,
      d: slope * fit.d,
      lx: 0,
      ly: ly + roofHeight * fit.at + lift * Math.cos(angle),
      lz: run * (1 - fit.at) + lift * Math.sin(angle),
      tilt: angle,
    },
    ACCENT.rooftopPv,
    { accent: true },
  );
}

/** The colours every recipe draws first, in this order. */
interface Look {
  wall: THREE.Color;
  roof: THREE.Color;
  trim: THREE.Color;
}

type Builder = (p: Picker, face: StreetFace, family: ZoneFamily, look: Look) => BuildingPart[];

/** Recipes keep densities 1 and 2 apart and treat everything else as density 3. */
function densityKey(density: number): 1 | 2 | 3 {
  return density === 1 || density === 2 ? density : 3;
}

/**
 * The three colour draws, then the silhouette — the first draw after the
 * colours. `silhouetteOf` replays exactly this sequence.
 */
function drawLook<S>(
  p: Picker,
  family: ZoneFamily,
  choices: readonly S[],
): { look: Look; silhouette: S } {
  const wall = p.from(family.walls);
  const roof = p.from(family.roofs);
  const trim = p.from(family.trims);
  return { look: { wall, roof, trim }, silhouette: choices[p.pick(choices.length)] };
}

/** A turn-0 Box laid out in the street-facing frame around the tile centre. */
function uprightBox(
  face: StreetFace,
  local: Omit<Local, 'turn' | 'tilt'>,
  color: THREE.Color,
  flags: { main?: boolean; accent?: boolean; role?: PartRole; windows?: true } = {},
): BuildingPart {
  const [ox, oz] = faceOffset(local.lx, local.lz, face);
  // A box is symmetric, so swapping its extents on east/west equals a quarter turn.
  const odd = face % 2 === 1;
  return box(
    odd ? local.d : local.w,
    local.h,
    odd ? local.w : local.d,
    ox,
    local.ly,
    oz,
    color,
    flags,
  );
}

/** The residential door on the street face of `body`, `lx` along the facade from its centre. */
function doorAt(body: BuildingPart, face: StreetFace, lx: number): BuildingPart {
  return facePart(
    PartKind.Box,
    body,
    face,
    {
      w: DOOR.width,
      h: DOOR.height,
      d: DOOR.depth,
      lx,
      ly: 0,
      lz: faceDepth(body, face) / 2 + DOOR.depth / 2,
    },
    ACCENT.door,
    { accent: true },
  );
}

/** A residential chimney: an unturned accent box carrying the stage 2 smoke role. */
function houseChimney(ox: number, oy: number, oz: number, height: number): BuildingPart {
  return box(CHIMNEY.w, height, CHIMNEY.w, ox, oy, oz, ACCENT.chimney, {
    accent: true,
    role: PartRole.Chimney,
  });
}

/** Detached house, off centre, gable or hip roof, chimney, door, maybe an extension. */
function detachedHouse(
  p: Picker,
  face: StreetFace,
  family: ZoneFamily,
  look: Look,
): BuildingPart[] {
  const { wall, roof } = look;
  const parts: BuildingPart[] = [];
  const w = 0.42 + p.unit() * 0.08;
  const d = 0.42 + p.unit() * 0.08;
  const h = 0.3 + p.unit() * 0.08;
  const ox = (p.unit() - 0.5) * 0.2;
  const oz = (p.unit() - 0.5) * 0.2;
  const body = box(w, h, d, ox, 0, oz, wall, { main: true });
  parts.push(body, plinth(body, family));
  const roofHeight = 0.14;
  if (p.chance(0.25)) {
    parts.push({
      kind: PartKind.HipRoof,
      sx: w + 2 * ROOF_OVERHANG,
      sy: roofHeight,
      sz: d + 2 * ROOF_OVERHANG,
      ox,
      oy: h,
      oz,
      turn: 0,
      color: roof,
    });
  } else {
    const turn = p.pick(2);
    const gable: BuildingPart = {
      kind: PartKind.GableRoof,
      sx: (turn === 0 ? w : d) + 2 * ROOF_OVERHANG,
      sy: roofHeight,
      sz: (turn === 0 ? d : w) + 2 * ROOF_OVERHANG,
      ox,
      oy: h,
      oz,
      turn,
      color: roof,
    };
    parts.push(gable, ...gableDetails(gable));
  }
  const sideX = p.chance(0.5) ? 1 : -1;
  const sideZ = p.chance(0.5) ? 1 : -1;
  parts.push(houseChimney(ox + sideX * w * 0.3, h, oz + sideZ * d * 0.25, CHIMNEY.h));
  parts.push(
    onStreetFace(
      body,
      face,
      DOOR.width / faceWidth(body, face),
      DOOR.height,
      DOOR.depth,
      0,
      ACCENT.door,
    ),
  );
  if (p.chance(1 / 3)) {
    // Lower wing on the side with room, with its own small gable (ridge along z).
    // On the east/west faces the door always sits on the face's fixed world
    // side (independent of ox), so the wing must be pinned to the opposite
    // side rather than following ox; on north/south the door runs along z,
    // so the wing keeps defaulting to whichever side ox leaves clearer.
    let side: number;
    if (face === StreetFace.East) side = -1;
    else if (face === StreetFace.West) side = 1;
    else side = ox >= 0 ? -1 : 1;
    let ew = 0.16;
    if ((side < 0 && ox < 0) || (side > 0 && ox > 0)) {
      // The pinned side matches the body's own jitter: shrink the wing so
      // its roof's outer eave (|ox| + w/2 + ew + overhang) stays within FOOTPRINT_HALF.
      ew = Math.min(ew, FOOTPRINT_HALF - Math.abs(ox) - w / 2 - ROOF_OVERHANG);
    }
    const eh = h * 0.7;
    const ed = d * 0.7;
    const ex = ox + side * (w / 2 + ew / 2);
    parts.push(box(ew, eh, ed, ex, 0, oz, wall));
    parts.push({
      kind: PartKind.GableRoof,
      sx: ed + 2 * ROOF_OVERHANG,
      sy: 0.08,
      sz: ew + 2 * ROOF_OVERHANG,
      ox: ex,
      oy: eh,
      oz,
      turn: 1,
      color: roof,
    });
  }
  return parts;
}

/**
 * L-house: a body along the street and a wing of the same eave height
 * behind one end; the two gables meet at right angles and share a pitch.
 */
function lHouse(p: Picker, face: StreetFace, family: ZoneFamily, look: Look): BuildingPart[] {
  const { wall, roof } = look;
  const w = 0.5 + p.unit() * 0.06;
  const h = 0.3 + p.unit() * 0.08;
  const lx = (p.unit() - 0.5) * 0.1;
  const side = p.chance(0.5) ? 1 : -1;
  const doorAlong = p.unit() - 0.5;
  const d = 0.3;
  const wing = { w: 0.22, d: 0.26 };
  const roofHeight = 0.14;
  // The body and the wing together span d + wing.d, centred in depth;
  // the wing touches the body's back edge.
  const body = uprightBox(face, { w, h, d, lx, ly: 0, lz: wing.d / 2 }, wall, { main: true });
  const wingBody = uprightBox(
    face,
    { w: wing.w, h, d: wing.d, lx: lx + side * (w / 2 - wing.w / 2), ly: 0, lz: -d / 2 },
    wall,
    { windows: true },
  );
  const gable = facePart(
    PartKind.GableRoof,
    body,
    face,
    { w: w + 2 * ROOF_OVERHANG, h: roofHeight, d: d + 2 * ROOF_OVERHANG, lx: 0, ly: h, lz: 0 },
    roof,
  );
  // Same pitch as the main gable, so the wing's ridge runs into its back slope.
  const wingRun = wing.w / 2 + ROOF_OVERHANG;
  const wingRoofHeight = (roofHeight * wingRun) / (d / 2 + ROOF_OVERHANG);
  // The wing roof runs forward from its back eave until its ridge meets the
  // main back slope: wingRun in from the main back eave (equal pitch), so
  // the valleys are clean and its front gable end lies inside the main roof.
  // Both in the wing body's face frame (+lz toward the street).
  const wingBack = -wing.d / 2 - ROOF_OVERHANG;
  const mainBackEave = wing.d / 2 - ROOF_OVERHANG;
  const wingFront = mainBackEave + wingRun;
  const wingGable = facePart(
    PartKind.GableRoof,
    wingBody,
    face,
    {
      w: wingFront - wingBack,
      h: wingRoofHeight,
      d: wing.w + 2 * ROOF_OVERHANG,
      lx: 0,
      ly: h,
      lz: (wingFront + wingBack) / 2,
      turn: 1,
    },
    roof,
  );
  // The chimney stands on the body's back slope at the end away from the wing.
  const [cx, cz] = faceOffset(-side * w * 0.3, -d * 0.2, face);
  return [
    body,
    plinth(body, family),
    wingBody,
    plinth(wingBody, family),
    gable,
    ...gableDetails(gable),
    wingGable,
    houseChimney(body.ox + cx, h, body.oz + cz, CHIMNEY.h),
    doorAt(body, face, doorAlong * (w / 2 - DOOR.width / 2)),
  ];
}

/**
 * Semi-detached pair: two narrow houses mirrored about the tile centre,
 * each in its own wall tone with its door at the outer end, under one
 * shared ridge with one chimney on the party wall. The left half is main.
 */
function semiDetached(p: Picker, face: StreetFace, family: ZoneFamily, look: Look): BuildingPart[] {
  const { wall, roof } = look;
  const half = 0.34 + p.unit() * 0.04;
  const d = 0.42 + p.unit() * 0.04;
  const h = 0.3 + p.unit() * 0.08;
  const lz = (p.unit() - 0.5) * 0.08;
  const otherWall = family.walls[(family.walls.indexOf(wall) + 1) % family.walls.length];
  const left = uprightBox(face, { w: half, h, d, lx: -half / 2, ly: 0, lz }, wall, {
    main: true,
  });
  const right = uprightBox(face, { w: half, h, d, lx: half / 2, ly: 0, lz }, otherWall, {
    windows: true,
  });
  const [ox, oz] = faceOffset(0, lz, face);
  const centre = { ox, oy: 0, oz };
  const gable = facePart(
    PartKind.GableRoof,
    centre,
    face,
    {
      w: 2 * half + 2 * ROOF_OVERHANG,
      h: 0.14,
      d: d + 2 * ROOF_OVERHANG,
      lx: 0,
      ly: h,
      lz: 0,
    },
    roof,
  );
  const doorLx = SEMI_DOOR_ALONG * (half / 2 - DOOR.width / 2);
  return [
    left,
    plinth(left, family),
    right,
    plinth(right, family),
    gable,
    ...gableDetails(gable),
    houseChimney(ox, h, oz, CHIMNEY.h),
    // The main half's door first: buildingsMesh.ts clears its windows around it.
    doorAt(left, face, -doorLx),
    doorAt(right, face, doorLx),
  ];
}

/** Town house: gable roof with a dormer on half the variants, ledge band, PV on the slope. */
function townHouseParts(
  p: Picker,
  face: StreetFace,
  family: ZoneFamily,
  look: Look,
): { parts: BuildingPart[]; body: BuildingPart; doorLx: number } {
  const { wall, roof, trim } = look;
  const parts: BuildingPart[] = [];
  const w = 0.6;
  const d = 0.5;
  const h = 0.55 + p.unit() * 0.1;
  const body = box(w, h, d, 0, 0, 0, wall, { main: true });
  parts.push(body, plinth(body, family));
  const roofHeight = 0.16;
  const roofW = faceWidth(body, face) + 2 * ROOF_OVERHANG;
  const roofD = faceDepth(body, face) + 2 * ROOF_OVERHANG;
  // Ridge runs along the street face so the PV slope faces the street.
  const gable = facePart(
    PartKind.GableRoof,
    body,
    face,
    { w: roofW, h: roofHeight, d: roofD, lx: 0, ly: h, lz: 0 },
    roof,
  );
  parts.push(gable, ...gableDetails(gable));
  if (p.chance(0.5)) {
    // Dormer on the back slope, so it never collides with the PV slab.
    const dormerX = (p.unit() - 0.5) * 0.2;
    const dormerW = 0.14;
    const dormerD = 0.12;
    parts.push(
      facePart(
        PartKind.Box,
        body,
        face,
        { w: dormerW, h: 0.1, d: dormerD, lx: dormerX, ly: h + 0.02, lz: -roofD / 4 },
        wall,
      ),
    );
    parts.push(
      facePart(
        PartKind.GableRoof,
        body,
        face,
        {
          w: dormerW + 2 * ROOF_OVERHANG,
          h: 0.06,
          d: dormerD + 2 * ROOF_OVERHANG,
          lx: dormerX,
          ly: h + 0.12,
          lz: -roofD / 4,
        },
        roof,
      ),
    );
  }
  const along = p.unit() - 0.5;
  parts.push(
    onStreetFace(
      body,
      face,
      DOOR.width / faceWidth(body, face),
      DOOR.height,
      DOOR.depth,
      0,
      ACCENT.door,
      along,
    ),
  );
  parts.push(box(w + 0.02, 0.02, d + 0.02, 0, h * 0.5, 0, trim, { accent: true, band: true }));
  parts.push(pvOnSlope(body, face, roofW, roofD, roofHeight, h));
  return { parts, body, doorLx: along * (faceWidth(body, face) / 2 - DOOR.width / 2) };
}

function townHouse(p: Picker, face: StreetFace, family: ZoneFamily, look: Look): BuildingPart[] {
  return townHouseParts(p, face, family, look).parts;
}

/**
 * The town house with a bay window on the street face, at the end away
 * from the door: a box BAY_DEPTH proud of the facade under a shed roof
 * below the eaves, glazed at the front.
 */
function bayWindow(p: Picker, face: StreetFace, family: ZoneFamily, look: Look): BuildingPart[] {
  const { parts, body, doorLx } = townHouseParts(p, face, family, look);
  const fw = faceWidth(body, face);
  const fd = faceDepth(body, face);
  const lx = (doorLx >= 0 ? -1 : 1) * (fw / 2 - BAY.width / 2 - BAY.sideMargin);
  const bayHeight = body.sy * BAY.heightFraction;
  const lz = fd / 2 + BAY_DEPTH / 2;
  const bay = facePart(
    PartKind.Box,
    body,
    face,
    { w: BAY.width, h: bayHeight, d: BAY_DEPTH, lx, ly: 0, lz },
    look.wall,
  );
  // The shed roof's back eave reaches into the wall like every other overhang.
  const bayRoof = facePart(
    PartKind.ShedRoof,
    body,
    face,
    {
      w: BAY.width + 2 * ROOF_OVERHANG,
      h: BAY.roofHeight,
      d: BAY_DEPTH + 2 * ROOF_OVERHANG,
      lx,
      ly: bayHeight,
      lz,
    },
    look.roof,
  );
  const glass = facePart(
    PartKind.Box,
    body,
    face,
    {
      w: BAY.width * BAY.glassFraction,
      h: bayHeight * BAY.glassFraction,
      d: BAY.glassDepth,
      lx,
      ly: bayHeight * (1 - BAY.glassFraction) * 0.6,
      lz: fd / 2 + BAY_DEPTH + BAY.glassDepth / 2,
    },
    ACCENT.glass,
    { accent: true },
  );
  parts.push(bay, bayRoof, glass);
  return parts;
}

/**
 * Corner house: a square body under a hip roof, the door at one corner
 * of the street face under a small canopy, a corner pilaster beside it.
 */
function cornerHouse(p: Picker, face: StreetFace, family: ZoneFamily, look: Look): BuildingPart[] {
  const { wall, roof, trim } = look;
  const w = 0.6;
  const h = 0.55 + p.unit() * 0.1;
  const corner = p.chance(0.5) ? 1 : -1;
  const body = box(w, h, w, 0, 0, 0, wall, { main: true });
  const roofHeight = 0.2;
  const roofW = w + 2 * ROOF_OVERHANG;
  const doorLx = corner * (w / 2 - DOOR.width / 2 - CORNER_DOOR_INSET);
  const lz = w / 2;
  return [
    body,
    plinth(body, family),
    {
      kind: PartKind.HipRoof,
      sx: roofW,
      sy: roofHeight,
      sz: roofW,
      ox: 0,
      oy: h,
      oz: 0,
      turn: 0,
      color: roof,
    },
    doorAt(body, face, doorLx),
    // Door canopy and the corner pilaster in the trim colour.
    facePart(
      PartKind.Box,
      body,
      face,
      {
        w: DOOR.width + 0.02,
        h: 0.025,
        d: 0.07,
        lx: doorLx,
        ly: DOOR.height + 0.02,
        lz: lz + 0.035,
      },
      trim,
      { accent: true },
    ),
    facePart(
      PartKind.Box,
      body,
      face,
      { w: 0.03, h, d: 0.03, lx: (corner * w) / 2, ly: 0, lz },
      trim,
      { accent: true },
    ),
    box(w + 0.02, 0.02, w + 0.02, 0, h * 0.5, 0, trim, { accent: true, band: true }),
    // A hip's front face shares the gable's plane but narrows to the apex:
    // a smaller slab low on the slope stays on it.
    pvOnSlope(body, face, roofW, roofW, roofHeight, h, HIP_PV_FIT),
  ];
}

/** Apartment block: parapet, stairwell, balconies on the street face, flat PV, maybe a water tank. */
function apartment(p: Picker, face: StreetFace, family: ZoneFamily, look: Look): BuildingPart[] {
  const { wall, roof, trim } = look;
  const parts: BuildingPart[] = [];
  const w = 0.7;
  const h = 1.0 + p.unit() * 0.2;
  const body = box(w, h, w, 0, 0, 0, wall, { main: true });
  parts.push(body, plinth(body, family));
  parts.push(box(w + PARAPET_MARGIN.apartment, 0.04, w + PARAPET_MARGIN.apartment, 0, h, 0, roof));
  parts.push(box(0.2, 0.12, 0.2, -0.18, h, -0.18, wall));
  const balconies = 2 + p.pick(2);
  for (let i = 0; i < balconies; i++) {
    parts.push({
      ...onStreetFace(body, face, 0.7, 0.03, 0.08, (h * (i + 1)) / (balconies + 1), trim),
      band: true,
    });
  }
  parts.push(
    box(0.49, ROOFTOP_PV_THICKNESS, 0.38, 0.12, h + 0.04, 0.12, ACCENT.rooftopPv, {
      accent: true,
    }),
  );
  if (p.chance(1 / 3)) {
    parts.push({
      kind: PartKind.Cylinder,
      sx: 0.12,
      sy: 0.14,
      sz: 0.12,
      ox: -0.22,
      oy: h,
      oz: 0.22,
      turn: 0,
      color: ACCENT.waterTank,
      accent: true,
    });
  }
  return parts;
}

/**
 * Stepped block: the apartment's lower floors (main) and a top storey set
 * back by SETBACK from the street, its roof terrace behind a railing.
 */
function steppedBlock(p: Picker, face: StreetFace, family: ZoneFamily, look: Look): BuildingPart[] {
  const { wall, roof, trim } = look;
  const w = 0.7;
  const h = 1.0 + p.unit() * 0.2;
  const balconies = 2 + p.pick(2);
  const lowerH = h - TOP_STOREY_HEIGHT;
  const body = box(w, lowerH, w, 0, 0, 0, wall, { main: true });
  const terrace = box(
    w + PARAPET_MARGIN.apartment,
    0.04,
    w + PARAPET_MARGIN.apartment,
    0,
    lowerH,
    0,
    roof,
  );
  const upper = uprightBox(
    face,
    { w, h: TOP_STOREY_HEIGHT, d: w - SETBACK, lx: 0, ly: lowerH, lz: -SETBACK / 2 },
    wall,
    { windows: true },
  );
  const parts = [
    body,
    plinth(body, family),
    terrace,
    upper,
    uprightBox(
      face,
      {
        w: w + PARAPET_MARGIN.apartment,
        h: 0.04,
        d: w - SETBACK + PARAPET_MARGIN.apartment,
        lx: 0,
        ly: h,
        lz: -SETBACK / 2,
      },
      roof,
    ),
    // The railing stands on the terrace slab along its street edge.
    uprightBox(
      face,
      { w, h: RAILING.h, d: RAILING.d, lx: 0, ly: lowerH + 0.04, lz: w / 2 - RAILING.d / 2 },
      trim,
      { accent: true },
    ),
  ];
  for (let i = 0; i < balconies; i++) {
    parts.push({
      ...onStreetFace(body, face, 0.7, 0.03, 0.08, (lowerH * (i + 1)) / (balconies + 1), trim),
      band: true,
    });
  }
  parts.push(
    uprightBox(
      face,
      { w: 0.4, h: ROOFTOP_PV_THICKNESS, d: 0.3, lx: 0, ly: h + 0.04, lz: -SETBACK / 2 },
      ACCENT.rooftopPv,
      { accent: true },
    ),
  );
  return parts;
}

const RESIDENTIAL_BUILDERS: Record<ResidentialSilhouette, Builder> = {
  detached: detachedHouse,
  lHouse,
  semiDetached,
  townHouse,
  bayWindow,
  cornerHouse,
  apartment,
  steppedBlock,
};

function residential(
  density: number,
  p: Picker,
  face: StreetFace,
  family: ZoneFamily,
): BuildingPart[] {
  const { look, silhouette } = drawLook(p, family, RESIDENTIAL_SILHOUETTES[densityKey(density)]);
  return RESIDENTIAL_BUILDERS[silhouette](p, face, family, look);
}

/** A rooftop antenna mast carrying the stage 2 beacon. */
function antenna(ox: number, oy: number, oz: number, height: number): BuildingPart {
  return {
    kind: PartKind.Cylinder,
    sx: ANTENNA_WIDTH,
    sy: height,
    sz: ANTENNA_WIDTH,
    ox,
    oy,
    oz,
    turn: 0,
    color: ACCENT.antenna,
    accent: true,
    role: PartRole.Antenna,
  };
}

/** Low office: cornice band, entrance canopy, one AC unit. */
function lowOffice(p: Picker, face: StreetFace, family: ZoneFamily, look: Look): BuildingPart[] {
  const { wall, trim } = look;
  const w = 0.62;
  const h = 0.4 + p.unit() * 0.06;
  const body = box(w, h, w, 0, 0, 0, wall, { main: true });
  return [
    body,
    plinth(body, family),
    box(w + 0.04, 0.03, w + 0.04, 0, h - 0.03, 0, trim, { accent: true, band: true }),
    onStreetFace(body, face, 0.5, 0.03, 0.1, h * 0.55, trim),
    box(0.1, 0.08, 0.1, 0.15, h, -0.15, ACCENT.acUnit, { accent: true }),
  ];
}

/**
 * Pavilion: a low body under a shed roof that rises toward the street over
 * a glass front, two trim fins dividing the glass.
 */
function pavilion(p: Picker, face: StreetFace, family: ZoneFamily, look: Look): BuildingPart[] {
  const { wall, roof, trim } = look;
  const w = 0.66;
  const d = 0.56;
  const h = 0.34 + p.unit() * 0.06;
  const body = box(w, h, d, 0, 0, 0, wall, { main: true });
  const fw = faceWidth(body, face);
  const fd = faceDepth(body, face);
  const glassW = fw * PAVILION.glassWidthFraction;
  const glassH = h * PAVILION.glassHeightFraction;
  const fin = (lx: number): BuildingPart =>
    facePart(
      PartKind.Box,
      body,
      face,
      {
        w: PAVILION.fin,
        h: glassH,
        d: PAVILION.fin,
        lx,
        ly: 0,
        lz: fd / 2 + PAVILION.glassDepth + PAVILION.fin / 2,
      },
      trim,
      { accent: true },
    );
  return [
    body,
    plinth(body, family),
    // Turned half way: the high edge (local -z) stands over the street.
    facePart(
      PartKind.ShedRoof,
      body,
      face,
      {
        w: fw + 2 * ROOF_OVERHANG,
        h: PAVILION.roofHeight,
        d: fd + 2 * ROOF_OVERHANG,
        lx: 0,
        ly: h,
        lz: 0,
        turn: 2,
      },
      roof,
    ),
    onStreetFace(
      body,
      face,
      PAVILION.glassWidthFraction,
      glassH,
      PAVILION.glassDepth,
      0,
      ACCENT.glass,
    ),
    fin(-glassW / 6),
    fin(glassW / 6),
  ];
}

/** Office block: two facade bands, two AC units, antenna, flat PV. */
function officeBlock(p: Picker, _face: StreetFace, family: ZoneFamily, look: Look): BuildingPart[] {
  const { wall, trim } = look;
  const w = 0.62;
  const h = 1.0 + p.unit() * 0.1;
  const body = box(w, h, w, 0, 0, 0, wall, { main: true });
  return [
    body,
    plinth(body, family),
    box(w + 0.02, 0.025, w + 0.02, 0, h / 3, 0, trim, { accent: true, band: true }),
    box(w + 0.02, 0.025, w + 0.02, 0, (2 * h) / 3, 0, trim, { accent: true, band: true }),
    box(0.1, 0.08, 0.1, 0.15, h, -0.15, ACCENT.acUnit, { accent: true }),
    box(0.1, 0.08, 0.1, -0.15, h, -0.15, ACCENT.acUnit, { accent: true }),
    antenna(0.2, h, 0.2, 0.25),
    box(0.4, ROOFTOP_PV_THICKNESS, 0.3, -0.1, h, 0.12, ACCENT.rooftopPv, { accent: true }),
  ];
}

/**
 * Atrium office: a street-side wing (main) and a taller back wing, a
 * lower glass atrium filling the gap between them; PV on the front wing,
 * the antenna on the taller back wing.
 */
function atriumOffice(p: Picker, face: StreetFace, family: ZoneFamily, look: Look): BuildingPart[] {
  const { wall, trim } = look;
  const { wingWidth: w, wingDepth: d, gap } = ATRIUM;
  // Under 0.98 high and 0.6 wide each wing lays out 3 rows × 2 columns,
  // so both wings together stay within WINDOWS_PER_TILE (2 × 12).
  const frontH = 0.84 + p.unit() * 0.06;
  const backH = frontH + ATRIUM.step;
  const wingZ = gap / 2 + d / 2;
  const front = uprightBox(face, { w, h: frontH, d, lx: 0, ly: 0, lz: wingZ }, wall, {
    main: true,
  });
  const back = uprightBox(face, { w, h: backH, d, lx: 0, ly: 0, lz: -wingZ }, wall, {
    windows: true,
  });
  const cornice = (wing: BuildingPart): BuildingPart =>
    box(wing.sx + 0.04, 0.03, wing.sz + 0.04, wing.ox, wing.sy - 0.03, wing.oz, trim, {
      accent: true,
      band: true,
    });
  const [ax, az] = faceOffset(-0.2, -wingZ, face);
  return [
    front,
    plinth(front, family),
    back,
    plinth(back, family),
    uprightBox(
      face,
      { w: ATRIUM.glassWidth, h: ATRIUM.glassHeight, d: gap, lx: 0, ly: 0, lz: 0 },
      ACCENT.glass,
      { accent: true },
    ),
    cornice(front),
    cornice(back),
    uprightBox(
      face,
      { w: 0.4, h: ROOFTOP_PV_THICKNESS, d: 0.14, lx: 0, ly: frontH, lz: wingZ },
      ACCENT.rooftopPv,
      { accent: true },
    ),
    uprightBox(face, { w: 0.1, h: 0.08, d: 0.1, lx: 0.15, ly: backH, lz: -wingZ }, ACCENT.acUnit, {
      accent: true,
    }),
    antenna(ax, backH, az, 0.25),
  ];
}

/** Tower with a setback upper third; a cylindrical core or a plant room; antenna; PV. */
function tower(p: Picker, _face: StreetFace, family: ZoneFamily, look: Look): BuildingPart[] {
  const { wall, roof, trim } = look;
  const w = 0.66;
  const h = 1.6 + p.unit() * 0.3;
  const lowerH = h * 0.67;
  const upperH = h - lowerH;
  const body = box(w, lowerH, w, 0, 0, 0, wall, { main: true });
  const setback = -0.08;
  const parts = [
    body,
    plinth(body, family),
    box(0.46, upperH, 0.46, setback, lowerH, setback, wall),
    box(w + 0.04, 0.03, w + 0.04, 0, lowerH - 0.03, 0, trim, { accent: true, band: true }),
  ];
  if (p.chance(0.5)) {
    parts.push({
      kind: PartKind.Cylinder,
      sx: 0.16,
      sy: upperH + 0.1,
      sz: 0.16,
      ox: 0.24,
      oy: lowerH,
      oz: 0.24,
      turn: 0,
      color: roof,
    });
  } else {
    parts.push(box(0.16, 0.1, 0.16, 0.24, lowerH, 0.24, roof));
  }
  parts.push(
    antenna(-0.25, h, -0.25, 0.3),
    box(0.3, ROOFTOP_PV_THICKNESS, 0.2, -0.02, h, -0.02, ACCENT.rooftopPv, { accent: true }),
  );
  return parts;
}

/**
 * Twin towers: a low podium (main) under a roof slab, two slim towers of
 * equal height on it, set back from the street; entrance canopy, PV on the
 * podium in front of the towers, the antenna on one tower.
 */
function twinTowers(p: Picker, face: StreetFace, family: ZoneFamily, look: Look): BuildingPart[] {
  const { wall, roof, trim } = look;
  const { podium: pd, tower: tw, spacing, setback } = TWIN_TOWERS;
  const podiumH = pd.h + p.unit() * 0.04;
  // Inside the single tower's 1.6-1.9 band, so commercial d3 stays the tallest.
  const towerTop = TWIN_TOWERS.top + p.unit() * TWIN_TOWERS.topRange;
  const base = podiumH + TWIN_TOWERS.slab;
  const podium = uprightBox(face, { w: pd.w, h: podiumH, d: pd.d, lx: 0, ly: 0, lz: 0 }, wall, {
    main: true,
  });
  // One column of four rows per tower facade: 2 × 8 tower windows plus the
  // podium's single row stay within WINDOWS_PER_TILE.
  const slimTower = (side: number): BuildingPart =>
    uprightBox(
      face,
      { w: tw.w, h: towerTop - base, d: tw.d, lx: side * spacing, ly: base, lz: -setback },
      wall,
      { windows: true },
    );
  const crown = (t: BuildingPart): BuildingPart =>
    box(t.sx + 0.02, 0.03, t.sz + 0.02, t.ox, towerTop - 0.03, t.oz, trim, {
      accent: true,
      band: true,
    });
  const left = slimTower(-1);
  const right = slimTower(1);
  return [
    podium,
    plinth(podium, family),
    uprightBox(
      face,
      {
        w: pd.w + PARAPET_MARGIN.shop,
        h: TWIN_TOWERS.slab,
        d: pd.d + PARAPET_MARGIN.shop,
        lx: 0,
        ly: podiumH,
        lz: 0,
      },
      roof,
    ),
    left,
    right,
    crown(left),
    crown(right),
    onStreetFace(podium, face, 0.4, 0.03, 0.1, podiumH * 0.55, trim),
    uprightBox(
      face,
      { w: 0.44, h: ROOFTOP_PV_THICKNESS, d: 0.14, lx: 0, ly: base, lz: 0.2 },
      ACCENT.rooftopPv,
      { accent: true },
    ),
    antenna(left.ox, towerTop, left.oz, 0.3),
  ];
}

const COMMERCIAL_BUILDERS: Record<CommercialSilhouette, Builder> = {
  lowOffice,
  pavilion,
  officeBlock,
  atriumOffice,
  tower,
  twinTowers,
};

function commercial(
  density: number,
  p: Picker,
  face: StreetFace,
  family: ZoneFamily,
): BuildingPart[] {
  const { look, silhouette } = drawLook(p, family, COMMERCIAL_SILHOUETTES[densityKey(density)]);
  return COMMERCIAL_BUILDERS[silhouette](p, face, family, look);
}

/** Retail recipes draw the sign colour from the trim without consuming a draw. */
function signColor(family: ZoneFamily, trim: THREE.Color): THREE.Color {
  return family.trims[(family.trims.indexOf(trim) + 1) % family.trims.length];
}

/** Shop: flat roof slab, awning and sign on the street face. */
function shop(p: Picker, face: StreetFace, family: ZoneFamily, look: Look): BuildingPart[] {
  const { wall, roof, trim } = look;
  const sign = signColor(family, trim);
  const w = 0.7;
  const d = 0.6;
  const h = 0.3 + p.unit() * 0.05;
  const body = box(w, h, d, 0, 0, 0, wall, { main: true });
  return [
    body,
    plinth(body, family),
    box(w + PARAPET_MARGIN.shop, 0.03, d + PARAPET_MARGIN.shop, 0, h, 0, roof),
    onStreetFace(body, face, 0.9, 0.04, 0.08, h * 0.6, trim),
    onStreetFace(body, face, 0.6, 0.08, 0.03, h * 0.6 + 0.05, sign),
  ];
}

/**
 * Canopy shop: a shallower flat-roofed shop set back from the street, a
 * wide shed-roof canopy on two posts over the forecourt, a sign above it.
 */
function canopyShop(p: Picker, face: StreetFace, family: ZoneFamily, look: Look): BuildingPart[] {
  const { wall, roof, trim } = look;
  const sign = signColor(family, trim);
  const w = 0.7;
  const d = 0.5;
  const h = 0.3 + p.unit() * 0.05;
  const body = uprightBox(face, { w, h, d, lx: 0, ly: 0, lz: -CANOPY.depth / 2 }, wall, {
    main: true,
  });
  // The canopy's low (front) edge stays above the door height.
  const canopyY = h * CANOPY.heightFraction;
  const canopyW = w + 2 * ROOF_OVERHANG;
  const canopyZ = d / 2 + CANOPY.depth / 2;
  const postZ = d / 2 + CANOPY.depth - CANOPY.post;
  const post = (side: number): BuildingPart =>
    facePart(
      PartKind.Box,
      body,
      face,
      {
        w: CANOPY.post,
        h: canopyY,
        d: CANOPY.post,
        lx: side * (canopyW / 2 - CANOPY.post),
        ly: 0,
        lz: postZ,
      },
      trim,
      { accent: true },
    );
  return [
    body,
    plinth(body, family),
    uprightBox(
      face,
      {
        w: w + PARAPET_MARGIN.shop,
        h: 0.03,
        d: d + PARAPET_MARGIN.shop,
        lx: 0,
        ly: h,
        lz: -CANOPY.depth / 2,
      },
      roof,
    ),
    facePart(
      PartKind.ShedRoof,
      body,
      face,
      { w: canopyW, h: CANOPY.pitch, d: CANOPY.depth, lx: 0, ly: canopyY, lz: canopyZ },
      roof,
    ),
    post(-1),
    post(1),
    onStreetFace(body, face, 0.6, CANOPY.signHeight, 0.03, canopyY + CANOPY.pitch + 0.005, sign),
  ];
}

/** Wider shop: pitched roof over the back half, flat front with awning, sign and PV. */
function wideShop(p: Picker, face: StreetFace, family: ZoneFamily, look: Look): BuildingPart[] {
  const { wall, roof, trim } = look;
  const sign = signColor(family, trim);
  const parts: BuildingPart[] = [];
  const w = 0.7;
  const d = 0.66;
  const h = 0.45 + p.unit() * 0.05;
  const body = box(w, h, d, 0, 0, 0, wall, { main: true });
  parts.push(body, plinth(body, family));
  const fw = faceWidth(body, face);
  const fd = faceDepth(body, face);
  const roofKind = p.chance(0.5) ? PartKind.GableRoof : PartKind.HipRoof;
  // The pitched back half overhangs the back and sides, and its front
  // eave reaches the same overhang past the middle over the flat front.
  const backRoof = facePart(
    roofKind,
    body,
    face,
    {
      w: fw + 2 * ROOF_OVERHANG,
      h: 0.14,
      d: fd / 2 + 2 * ROOF_OVERHANG,
      lx: 0,
      ly: h,
      lz: -fd / 4,
    },
    roof,
  );
  parts.push(backRoof);
  if (roofKind === PartKind.GableRoof) parts.push(...gableDetails(backRoof));
  parts.push(
    facePart(
      PartKind.Box,
      body,
      face,
      { w: fw + PARAPET_MARGIN.shop, h: 0.03, d: fd / 2, lx: 0, ly: h, lz: fd / 4 },
      roof,
    ),
  );
  parts.push(onStreetFace(body, face, 0.9, 0.04, 0.08, h * 0.6, trim));
  parts.push(onStreetFace(body, face, 0.6, 0.08, 0.03, h * 0.6 + 0.05, sign));
  parts.push(
    facePart(
      PartKind.Box,
      body,
      face,
      {
        w: fw * 0.5,
        h: ROOFTOP_PV_THICKNESS,
        d: (fd / 2) * 0.6,
        lx: 0,
        ly: h + 0.03,
        lz: fd / 4,
      },
      ACCENT.rooftopPv,
      { accent: true },
    ),
  );
  return parts;
}

/**
 * Shop with a flat above: the shop ground floor (main, so it keeps the
 * shopfront) and a residential-toned storey under a gable with PV.
 */
function shopWithFlat(p: Picker, face: StreetFace, family: ZoneFamily, look: Look): BuildingPart[] {
  const { wall, roof, trim } = look;
  const sign = signColor(family, trim);
  const w = 0.7;
  const d = 0.6;
  const shopH = 0.26 + p.unit() * 0.04;
  const flatWall = p.from(ZONE_FAMILIES[Zone.Residential].walls);
  const body = box(w, shopH, d, 0, 0, 0, wall, { main: true });
  const flat = box(w, FLAT_STOREY_HEIGHT, d, 0, shopH, 0, flatWall, { windows: true });
  const roofHeight = 0.14;
  const roofW = faceWidth(body, face) + 2 * ROOF_OVERHANG;
  const roofD = faceDepth(body, face) + 2 * ROOF_OVERHANG;
  const gable = facePart(
    PartKind.GableRoof,
    flat,
    face,
    { w: roofW, h: roofHeight, d: roofD, lx: 0, ly: FLAT_STOREY_HEIGHT, lz: 0 },
    roof,
  );
  return [
    body,
    plinth(body, family),
    flat,
    // Cornice between the shop and the flat.
    box(w + 0.02, 0.025, d + 0.02, 0, shopH, 0, trim, { accent: true, band: true }),
    gable,
    ...gableDetails(gable),
    onStreetFace(body, face, 0.9, 0.04, 0.08, shopH * 0.6, trim),
    onStreetFace(body, face, 0.6, FLAT_SIGN_HEIGHT, 0.03, shopH * 0.6 + 0.045, sign),
    pvOnSlope(flat, face, roofW, roofD, roofHeight, FLAT_STOREY_HEIGHT),
  ];
}

/** Market hall: long gable across the full width, two awnings, two vent stacks, PV on the slope. */
function marketHall(p: Picker, face: StreetFace, family: ZoneFamily, look: Look): BuildingPart[] {
  const { wall, roof, trim } = look;
  const parts: BuildingPart[] = [];
  const w = 0.8;
  const d = 0.78;
  const h = 0.8 + p.unit() * 0.08;
  const body = box(w, h, d, 0, 0, 0, wall, { main: true });
  parts.push(body, plinth(body, family));
  const fw = faceWidth(body, face);
  const fd = faceDepth(body, face);
  const roofHeight = 0.18;
  const roofW = fw * MARKET_HALL_ROOF_MARGIN;
  const roofD = fd * MARKET_HALL_ROOF_MARGIN;
  parts.push(
    facePart(
      PartKind.GableRoof,
      body,
      face,
      { w: roofW, h: roofHeight, d: roofD, lx: 0, ly: h, lz: 0 },
      roof,
    ),
  );
  parts.push(onStreetFace(body, face, 0.4, 0.04, 0.03, h * 0.6, trim, -1));
  parts.push(onStreetFace(body, face, 0.4, 0.04, 0.03, h * 0.6, trim, 1));
  parts.push(...vents(0, h + roofHeight - 0.04, 0, face));
  parts.push(pvOnSlope(body, face, roofW, roofD, roofHeight, h));
  return parts;
}

/** Two vent stacks along the facade around (ox, oz), the stage 2 puff anchors. */
function vents(ox: number, oy: number, oz: number, face: StreetFace): BuildingPart[] {
  return [-1, 1].map((side) => {
    const [vx, vz] = faceOffset(side * 0.2, 0, face);
    return {
      kind: PartKind.Cylinder,
      sx: 0.06,
      sy: 0.1,
      sz: 0.06,
      ox: ox + vx,
      oy,
      oz: oz + vz,
      turn: 0,
      color: ACCENT.antenna,
      accent: true,
      role: PartRole.Vent,
    };
  });
}

/**
 * Supermarket: a low, wide flat-roofed box, a glass entrance box on the
 * street face under a large flat canopy, two vents and PV on the roof.
 */
function supermarket(p: Picker, face: StreetFace, family: ZoneFamily, look: Look): BuildingPart[] {
  const { wall, roof, trim } = look;
  const sign = signColor(family, trim);
  const w = 0.82;
  const d = 0.7;
  const h = 0.4 + p.unit() * 0.08;
  // Set back so the entrance and its canopy stay inside the footprint.
  const lz = -0.03;
  const front = lz + d / 2;
  const body = uprightBox(face, { w, h, d, lx: 0, ly: 0, lz }, wall, { main: true });
  const roofTop = h + 0.03;
  const [rx, rz] = faceOffset(0, lz + 0.05, face);
  return [
    body,
    plinth(body, family),
    uprightBox(
      face,
      { w: w + PARAPET_MARGIN.shop, h: 0.03, d: d + PARAPET_MARGIN.shop, lx: 0, ly: h, lz },
      roof,
    ),
    uprightBox(
      face,
      {
        w: SUPERMARKET_ENTRANCE.w,
        h: SUPERMARKET_ENTRANCE.h,
        d: SUPERMARKET_ENTRANCE.d,
        lx: 0,
        ly: 0,
        lz: front + SUPERMARKET_ENTRANCE.d / 2,
      },
      ACCENT.glass,
      { accent: true },
    ),
    // The flat canopy rests on the entrance and reaches past it.
    uprightBox(
      face,
      {
        w: SUPERMARKET_CANOPY.w,
        h: SUPERMARKET_CANOPY.h,
        d: SUPERMARKET_CANOPY.d,
        lx: 0,
        ly: SUPERMARKET_ENTRANCE.h,
        lz: front + SUPERMARKET_CANOPY.d / 2,
      },
      trim,
      { accent: true },
    ),
    uprightBox(face, { w: 0.5, h: 0.07, d: 0.03, lx: 0, ly: h - 0.1, lz: front + 0.015 }, sign, {
      accent: true,
    }),
    ...vents(rx, roofTop, rz, face),
    uprightBox(
      face,
      { w: 0.3, h: ROOFTOP_PV_THICKNESS, d: 0.28, lx: 0, ly: roofTop, lz: lz - 0.14 },
      ACCENT.rooftopPv,
      { accent: true },
    ),
  ];
}

const RETAIL_BUILDERS: Record<RetailSilhouette, Builder> = {
  shop,
  canopyShop,
  wideShop,
  shopWithFlat,
  marketHall,
  supermarket,
};

function retail(density: number, p: Picker, face: StreetFace, family: ZoneFamily): BuildingPart[] {
  const { look, silhouette } = drawLook(p, family, RETAIL_SILHOUETTES[densityKey(density)]);
  return RETAIL_BUILDERS[silhouette](p, face, family, look);
}

/**
 * Saw-tooth roof of the classic factories: two gable parts side by side
 * meeting over the middle of the hall; each overhangs only its outer side,
 * so together they overhang the hall all round.
 */
function sawTooth(
  w: number,
  d: number,
  top: number,
  ox: number,
  oz: number,
  color: THREE.Color,
): BuildingPart[] {
  const half = w / 2;
  return [-1, 1].map((side) => ({
    kind: PartKind.GableRoof,
    sx: half + ROOF_OVERHANG,
    sy: 0.1,
    sz: d + 2 * ROOF_OVERHANG,
    ox: ox + (side * (half + ROOF_OVERHANG)) / 2,
    oy: top,
    oz,
    turn: 0,
    color,
  }));
}

/** A factory chimney, the stage 2 smoke anchor. */
function factoryChimney(sx: number, sy: number, ox: number, oy: number, oz: number): BuildingPart {
  return {
    kind: PartKind.Cylinder,
    sx,
    sy,
    sz: sx,
    ox,
    oy,
    oz,
    turn: 0,
    color: ACCENT.chimney,
    accent: true,
    role: PartRole.Chimney,
  };
}

/** Mono-pitch roof over a factory hall, overhanging every side, its high edge at the back. */
function hallShed(hall: BuildingPart, face: StreetFace, color: THREE.Color): BuildingPart {
  return facePart(
    PartKind.ShedRoof,
    hall,
    face,
    {
      w: faceWidth(hall, face) + 2 * ROOF_OVERHANG,
      h: HALL_SHED_PITCH,
      d: faceDepth(hall, face) + 2 * ROOF_OVERHANG,
      lx: 0,
      ly: hall.sy,
      lz: 0,
    },
    color,
  );
}

/**
 * Rooftop PV lying on the street-facing slope of `hallShed(hall)`, `lx`
 * along the facade from the hall centre and centred `at` that fraction up
 * the slope from the front eave; it pivots a hair above the slope.
 */
function pvOnShed(
  hall: BuildingPart,
  face: StreetFace,
  lx: number,
  width: number,
  at: number,
): BuildingPart {
  const run = faceDepth(hall, face) + 2 * ROOF_OVERHANG;
  const angle = Math.atan2(HALL_SHED_PITCH, run);
  const slope = Math.hypot(run, HALL_SHED_PITCH);
  return facePart(
    PartKind.Box,
    hall,
    face,
    {
      w: width,
      h: ROOFTOP_PV_THICKNESS,
      d: slope * SHED_PV_DEPTH_FRACTION,
      lx,
      ly: hall.sy + HALL_SHED_PITCH * at + PV_LIFT * Math.cos(angle),
      lz: run * (0.5 - at) + PV_LIFT * Math.sin(angle),
      tilt: angle,
    },
    ACCENT.rooftopPv,
    { accent: true },
  );
}

/** Workshop: one hall, saw-tooth roof, door, chimney at the back. */
function workshop(p: Picker, face: StreetFace, family: ZoneFamily, look: Look): BuildingPart[] {
  const { wall, roof, trim } = look;
  const w = 0.7;
  const d = 0.5;
  const h = 0.28 + p.unit() * 0.04;
  const body = box(w, h, d, 0, 0, 0, wall, { main: true });
  return [
    body,
    plinth(body, family),
    ...sawTooth(w, d, h, 0, 0, roof),
    onStreetFace(body, face, 0.4, h * 0.7, ROLL_UP_DOOR_DEPTH, 0, trim),
    factoryChimney(0.06, 0.22, -0.25, h, -0.15),
  ];
}

/**
 * Lean-to hall: a hall under a shed roof with a lower lean-to against one
 * side wall, its own shed roof falling away from the hall below the hall's
 * eave; a roll-up door with a ramp up to it, a chimney at the back.
 */
function leanToHall(p: Picker, face: StreetFace, family: ZoneFamily, look: Look): BuildingPart[] {
  const { wall, roof, trim } = look;
  const w = 0.56;
  const d = 0.5;
  const h = 0.28 + p.unit() * 0.04;
  const side = p.chance(0.5) ? 1 : -1;
  // Hall and lean-to together are centred on the tile.
  const lx = (-side * LEAN_TO.w) / 2;
  const lz = -0.06;
  const hall = uprightBox(face, { w, h, d, lx, ly: 0, lz }, wall, { main: true });
  // The lean-to's back is flush with the hall's.
  const leanTo = uprightBox(
    face,
    {
      w: LEAN_TO.w,
      h: LEAN_TO.h,
      d: LEAN_TO.d,
      lx: lx + side * (w / 2 + LEAN_TO.w / 2),
      ly: 0,
      lz: lz - (d - LEAN_TO.d) / 2,
    },
    wall,
  );
  // A quarter turn toward `side` points the low edge (local +z) away from
  // the hall; the high edge reaches ROOF_OVERHANG into the hall wall.
  const leanRoof = facePart(
    PartKind.ShedRoof,
    leanTo,
    face,
    {
      w: LEAN_TO.d + 2 * ROOF_OVERHANG,
      h: LEAN_TO.pitch,
      d: LEAN_TO.w + 2 * ROOF_OVERHANG,
      lx: 0,
      ly: LEAN_TO.h,
      lz: 0,
      turn: side > 0 ? 1 : 3,
    },
    roof,
  );
  // The ramp climbs from the street to the door threshold (plinth height),
  // its upper end against the door slab; it pivots at its base centre.
  const tilt = Math.asin(PLINTH_HEIGHT / RAMP.length);
  const ramp = facePart(
    PartKind.Box,
    hall,
    face,
    {
      w: w * LEAN_TO_DOOR_FRACTION,
      h: RAMP.thickness,
      d: RAMP.length,
      lx: 0,
      ly: PLINTH_HEIGHT / 2,
      lz: d / 2 + ROLL_UP_DOOR_DEPTH + (RAMP.length / 2) * Math.cos(tilt),
      tilt,
    },
    family.plinth,
  );
  const [cx, cz] = faceOffset(lx - side * 0.18, lz - 0.15, face);
  return [
    hall,
    plinth(hall, family),
    hallShed(hall, face, roof),
    leanTo,
    plinth(leanTo, family),
    leanRoof,
    onStreetFace(hall, face, LEAN_TO_DOOR_FRACTION, h * 0.7, ROLL_UP_DOOR_DEPTH, 0, trim),
    ramp,
    factoryChimney(0.06, 0.22, cx, h, cz),
  ];
}

/** Plant: main hall behind, lower annex in front, tank, chimney, PV. */
function plant(p: Picker, face: StreetFace, family: ZoneFamily, look: Look): BuildingPart[] {
  const { wall, roof, trim } = look;
  const w = 0.7;
  const h = 0.36 + p.unit() * 0.04;
  const body = box(w, h, 0.34, 0, 0, -0.12, wall, { main: true });
  const annexH = h * 0.7;
  const annex = box(0.5, annexH, 0.22, -0.08, 0, 0.19, wall);
  return [
    body,
    plinth(body, family),
    ...sawTooth(w, 0.34, h, 0, -0.12, roof),
    annex,
    onStreetFace(annex, face, 0.5, annexH * 0.7, ROLL_UP_DOOR_DEPTH, 0, trim),
    {
      kind: PartKind.Cylinder,
      sx: 0.14,
      sy: 0.3,
      sz: 0.14,
      ox: 0.28,
      oy: 0,
      oz: 0.22,
      turn: 0,
      color: ACCENT.waterTank,
      accent: true,
    },
    factoryChimney(0.06, 0.34, -0.27, h, -0.2),
    box(0.3, ROOFTOP_PV_THICKNESS, 0.16, 0.1, annexH, 0.19, ACCENT.rooftopPv, { accent: true }),
  ];
}

/**
 * Loading dock: a hall under a shed roof, a raised dock slab along its
 * street face with two roll-up doors on it, a one-storey office annex
 * beside the dock (below the hall's eave), PV on the slope, a chimney.
 */
function loadingDock(p: Picker, face: StreetFace, family: ZoneFamily, look: Look): BuildingPart[] {
  const { wall, roof, trim } = look;
  const w = 0.74;
  const d = 0.44;
  const lz = -0.08;
  const h = 0.36 + p.unit() * 0.04;
  const side = p.chance(0.5) ? 1 : -1;
  const hall = uprightBox(face, { w, h, d, lx: 0, ly: 0, lz }, wall, { main: true });
  const front = lz + d / 2;
  const annexLx = side * (w / 2 - DOCK_ANNEX.w / 2);
  const annex = uprightBox(
    face,
    {
      w: DOCK_ANNEX.w,
      h: DOCK_ANNEX.h,
      d: DOCK_ANNEX.d,
      lx: annexLx,
      ly: 0,
      lz: front + DOCK_ANNEX.d / 2,
    },
    wall,
    { windows: true },
  );
  // Its roof slab overhangs the three free sides and stops at the hall wall.
  const slabD = DOCK_ANNEX.d + PARAPET_MARGIN.shop / 2;
  const annexRoof = uprightBox(
    face,
    {
      w: DOCK_ANNEX.w + PARAPET_MARGIN.shop,
      h: DOCK_ANNEX.roof,
      d: slabD,
      lx: annexLx,
      ly: DOCK_ANNEX.h,
      lz: front + slabD / 2,
    },
    roof,
  );
  const dockW = w - DOCK_ANNEX.w - DOCK.gap;
  const dockLx = -side * (w / 2 - dockW / 2);
  const dock = uprightBox(
    face,
    { w: dockW, h: DOCK.h, d: DOCK.d, lx: dockLx, ly: 0, lz: front + DOCK.d / 2 },
    family.plinth,
  );
  const door = (k: number): BuildingPart =>
    uprightBox(
      face,
      {
        w: DOCK.doorWidth,
        h: h * DOCK.doorHeightFraction,
        d: ROLL_UP_DOOR_DEPTH,
        lx: dockLx + (k * dockW) / 4,
        ly: DOCK.h,
        lz: front + ROLL_UP_DOOR_DEPTH / 2,
      },
      trim,
      { accent: true },
    );
  const [cx, cz] = faceOffset(side * 0.28, lz - 0.14, face);
  return [
    hall,
    plinth(hall, family),
    hallShed(hall, face, roof),
    annex,
    plinth(annex, family),
    annexRoof,
    dock,
    door(-1),
    door(1),
    pvOnShed(hall, face, -side * 0.12, 0.36, 0.4),
    factoryChimney(0.06, 0.34, cx, h, cz),
  ];
}

/** Works: long hall, trim band, silo, tall chimney, door, PV. */
function works(p: Picker, face: StreetFace, family: ZoneFamily, look: Look): BuildingPart[] {
  const { wall, roof, trim } = look;
  const w = 0.74;
  const d = 0.5;
  const h = 0.42 + p.unit() * 0.06;
  const body = box(w, h, d, 0, 0, -0.04, wall, { main: true });
  return [
    body,
    plinth(body, family),
    ...sawTooth(w, d, h, 0, -0.04, roof),
    box(w + 0.02, 0.03, d + 0.02, 0, h * 0.5, -0.04, trim, { accent: true, band: true }),
    onStreetFace(body, face, 0.3, h * 0.6, ROLL_UP_DOOR_DEPTH, 0, trim),
    // The silo stands clear of the saw-tooth's front eave (its overhang included).
    {
      kind: PartKind.Cylinder,
      sx: 0.18,
      sy: 0.7,
      sz: 0.18,
      ox: 0.3,
      oy: 0,
      oz: 0.3 + ROOF_OVERHANG,
      turn: 0,
      color: ACCENT.waterTank,
      accent: true,
    },
    factoryChimney(0.06, 0.55, -0.3, h, -0.25),
    box(0.3, ROOFTOP_PV_THICKNESS, 0.2, -0.15, h + 0.1, 0.1, ACCENT.rooftopPv, { accent: true }),
  ];
}

/**
 * Conveyor works: a hall under a shed roof, a silo beside it clear of the
 * eave, and an inclined conveyor bridge whose foot rests on the hall roof
 * and whose upper end rests on the silo's near rim; trim band, door, PV
 * on the slope, a tall chimney.
 */
function conveyorWorks(
  p: Picker,
  face: StreetFace,
  family: ZoneFamily,
  look: Look,
): BuildingPart[] {
  const { wall, roof, trim } = look;
  const w = 0.56;
  const d = 0.5;
  const lz = -0.08;
  const h = 0.42 + p.unit() * 0.06;
  // `side` is where the silo stands; `u` runs from the hall toward it.
  const side = p.chance(0.5) ? 1 : -1;
  const hallU = -0.12;
  const hall = uprightBox(face, { w, h, d, lx: side * hallU, ly: 0, lz }, wall, { main: true });
  const [sx, sz] = faceOffset(side * SILO.u, SILO.lz, face);
  // The foot rests on the roof slope along the conveyor's back (higher)
  // edge; the slope falls toward the street from the back eave.
  const frontEave = lz + d / 2 + ROOF_OVERHANG;
  const backEdge = SILO.lz - CONVEYOR.w / 2;
  const footY = h + (HALL_SHED_PITCH * (frontEave - backEdge)) / (d + 2 * ROOF_OVERHANG);
  const rimU = SILO.u - SILO.d / 2;
  const run = rimU - CONVEYOR.footU;
  const rise = SILO.h - footY;
  const tilt = Math.atan2(rise, run);
  // Its local +z (the end a positive tilt lowers) points back to the hall.
  const conveyor = facePart(
    PartKind.Box,
    { ox: 0, oy: 0, oz: 0 },
    face,
    {
      w: CONVEYOR.w,
      h: CONVEYOR.thickness,
      d: Math.hypot(run, rise),
      lx: (side * (CONVEYOR.footU + rimU)) / 2,
      ly: (footY + SILO.h) / 2,
      lz: SILO.lz,
      turn: side > 0 ? 3 : 1,
      tilt,
    },
    trim,
    { accent: true },
  );
  const [cx, cz] = faceOffset(side * -0.3, lz - 0.17, face);
  return [
    hall,
    plinth(hall, family),
    hallShed(hall, face, roof),
    box(hall.sx + 0.02, 0.03, hall.sz + 0.02, hall.ox, h * 0.5, hall.oz, trim, {
      accent: true,
      band: true,
    }),
    onStreetFace(hall, face, 0.3, h * 0.6, ROLL_UP_DOOR_DEPTH, 0, trim),
    {
      kind: PartKind.Cylinder,
      sx: SILO.d,
      sy: SILO.h,
      sz: SILO.d,
      ox: sx,
      oy: 0,
      oz: sz,
      turn: 0,
      color: ACCENT.waterTank,
      accent: true,
    },
    conveyor,
    pvOnShed(hall, face, side * -0.15, 0.2, 0.3),
    factoryChimney(0.06, 0.55, cx, h, cz),
  ];
}

const INDUSTRIAL_BUILDERS: Record<IndustrialSilhouette, Builder> = {
  workshop,
  leanToHall,
  plant,
  loadingDock,
  works,
  conveyorWorks,
};

/**
 * Factories: halls under a saw-tooth roof (workshop, plant, works) or a
 * shed roof (the newer silhouettes), roll-up doors on the street face, a
 * chimney for the stage 2 smoke; the bigger plants add a tank or a silo
 * and PV.
 */
function industrial(
  density: number,
  p: Picker,
  face: StreetFace,
  family: ZoneFamily,
): BuildingPart[] {
  const { look, silhouette } = drawLook(p, family, INDUSTRIAL_SILHOUETTES[densityKey(density)]);
  return INDUSTRIAL_BUILDERS[silhouette](p, face, family, look);
}

/**
 * Procedural low-poly building parts for a zone/density/variant/tile
 * triple facing `face`. Deterministic in its inputs so every client
 * renders the same city.
 */
export function buildingParts(
  zone: Zone,
  density: number,
  variant: number,
  index: number,
  face: StreetFace,
): BuildingPart[] {
  const family = ZONE_FAMILIES[zone];
  if (!family) return [];
  const picker = createPicker(variant, index);
  switch (zone) {
    case Zone.Residential:
      return residential(density, picker, face, family);
    case Zone.Commercial:
      return commercial(density, picker, face, family);
    case Zone.Retail:
      return retail(density, picker, face, family);
    case Zone.Industrial:
      return industrial(density, picker, face, family);
    default:
      return [];
  }
}

/**
 * Name of the silhouette a tile builds — replays the recipe's colour and
 * silhouette draws (for tests and debugging).
 */
export function silhouetteOf(zone: Zone, density: number, variant: number, index: number): string {
  const family = ZONE_FAMILIES[zone];
  const choices = ZONE_SILHOUETTES[zone];
  if (!family || !choices) return '';
  return drawLook(createPicker(variant, index), family, choices[densityKey(density)]).silhouette;
}

/** Top of the tallest part — how high the building rises above the tile. */
export function buildingHeight(
  zone: Zone,
  density: number,
  variant: number,
  index: number,
): number {
  let top = 0;
  for (const p of buildingParts(zone, density, variant, index, StreetFace.South)) {
    top = Math.max(top, p.oy + p.sy);
  }
  return top;
}

/** The part that carries windows. */
export function mainBody(parts: readonly BuildingPart[]): BuildingPart | undefined {
  return parts.find((p) => p.main);
}
