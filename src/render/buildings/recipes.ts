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
  flags: { main?: boolean; accent?: boolean; role?: PartRole } = {},
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
  body: BuildingPart,
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
): BuildingPart {
  const run = roofDepth / 2;
  const angle = Math.atan2(roofHeight, run);
  const slope = Math.hypot(run, roofHeight);
  const lift = 0.01;
  return facePart(
    PartKind.Box,
    body,
    face,
    {
      w: roofWidth * 0.6,
      h: ROOFTOP_PV_THICKNESS,
      d: slope * 0.6,
      lx: 0,
      ly: ly + roofHeight / 2 + lift * Math.cos(angle),
      lz: run / 2 + lift * Math.sin(angle),
      tilt: angle,
    },
    ACCENT.rooftopPv,
    { accent: true },
  );
}

function residential(
  density: number,
  p: Picker,
  face: StreetFace,
  family: ZoneFamily,
): BuildingPart[] {
  const wall = p.from(family.walls);
  const roof = p.from(family.roofs);
  const trim = p.from(family.trims);
  const parts: BuildingPart[] = [];

  if (density === 1) {
    // Detached house, off centre, gable or hip roof, chimney, door, maybe an extension.
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
    parts.push(
      box(0.06, 0.18, 0.06, ox + sideX * w * 0.3, h, oz + sideZ * d * 0.25, ACCENT.chimney, {
        accent: true,
        role: PartRole.Chimney,
      }),
    );
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
  } else if (density === 2) {
    // Town house: gable roof with a dormer on half the variants, ledge band, PV on the slope.
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
    parts.push(
      onStreetFace(
        body,
        face,
        DOOR.width / faceWidth(body, face),
        DOOR.height,
        DOOR.depth,
        0,
        ACCENT.door,
        p.unit() - 0.5,
      ),
    );
    parts.push(box(w + 0.02, 0.02, d + 0.02, 0, h * 0.5, 0, trim, { accent: true }));
    parts.push(pvOnSlope(body, face, roofW, roofD, roofHeight, h));
  } else {
    // Apartment block: parapet, stairwell, balconies on the street face, flat PV, maybe a water tank.
    const w = 0.7;
    const h = 1.0 + p.unit() * 0.2;
    const body = box(w, h, w, 0, 0, 0, wall, { main: true });
    parts.push(body, plinth(body, family));
    parts.push(
      box(w + PARAPET_MARGIN.apartment, 0.04, w + PARAPET_MARGIN.apartment, 0, h, 0, roof),
    );
    parts.push(box(0.2, 0.12, 0.2, -0.18, h, -0.18, wall));
    const balconies = 2 + p.pick(2);
    for (let i = 0; i < balconies; i++) {
      parts.push(onStreetFace(body, face, 0.7, 0.03, 0.08, (h * (i + 1)) / (balconies + 1), trim));
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
  }
  return parts;
}

function commercial(
  density: number,
  p: Picker,
  face: StreetFace,
  family: ZoneFamily,
): BuildingPart[] {
  const wall = p.from(family.walls);
  const roof = p.from(family.roofs);
  const trim = p.from(family.trims);
  const parts: BuildingPart[] = [];

  if (density === 1) {
    // Low office: cornice band, entrance canopy, one AC unit.
    const w = 0.62;
    const h = 0.4 + p.unit() * 0.06;
    const body = box(w, h, w, 0, 0, 0, wall, { main: true });
    parts.push(body, plinth(body, family));
    parts.push(box(w + 0.04, 0.03, w + 0.04, 0, h - 0.03, 0, trim, { accent: true }));
    parts.push(onStreetFace(body, face, 0.5, 0.03, 0.1, h * 0.55, trim));
    parts.push(box(0.1, 0.08, 0.1, 0.15, h, -0.15, ACCENT.acUnit, { accent: true }));
  } else if (density === 2) {
    // Office block: two facade bands, two AC units, antenna, flat PV.
    const w = 0.62;
    const h = 1.0 + p.unit() * 0.1;
    const body = box(w, h, w, 0, 0, 0, wall, { main: true });
    parts.push(body, plinth(body, family));
    parts.push(box(w + 0.02, 0.025, w + 0.02, 0, h / 3, 0, trim, { accent: true }));
    parts.push(box(w + 0.02, 0.025, w + 0.02, 0, (2 * h) / 3, 0, trim, { accent: true }));
    parts.push(box(0.1, 0.08, 0.1, 0.15, h, -0.15, ACCENT.acUnit, { accent: true }));
    parts.push(box(0.1, 0.08, 0.1, -0.15, h, -0.15, ACCENT.acUnit, { accent: true }));
    parts.push({
      kind: PartKind.Cylinder,
      sx: 0.03,
      sy: 0.25,
      sz: 0.03,
      ox: 0.2,
      oy: h,
      oz: 0.2,
      turn: 0,
      color: ACCENT.antenna,
      accent: true,
      role: PartRole.Antenna,
    });
    parts.push(
      box(0.4, ROOFTOP_PV_THICKNESS, 0.3, -0.1, h, 0.12, ACCENT.rooftopPv, { accent: true }),
    );
  } else {
    // Tower with a setback upper third; a cylindrical core or a plant room; antenna; PV.
    const w = 0.66;
    const h = 1.6 + p.unit() * 0.3;
    const lowerH = h * 0.67;
    const upperH = h - lowerH;
    const body = box(w, lowerH, w, 0, 0, 0, wall, { main: true });
    parts.push(body, plinth(body, family));
    const setback = -0.08;
    parts.push(box(0.46, upperH, 0.46, setback, lowerH, setback, wall));
    parts.push(box(w + 0.04, 0.03, w + 0.04, 0, lowerH - 0.03, 0, trim, { accent: true }));
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
    parts.push({
      kind: PartKind.Cylinder,
      sx: 0.03,
      sy: 0.3,
      sz: 0.03,
      ox: -0.25,
      oy: h,
      oz: -0.25,
      turn: 0,
      color: ACCENT.antenna,
      accent: true,
      role: PartRole.Antenna,
    });
    parts.push(
      box(0.3, ROOFTOP_PV_THICKNESS, 0.2, -0.02, h, -0.02, ACCENT.rooftopPv, { accent: true }),
    );
  }
  return parts;
}

function retail(density: number, p: Picker, face: StreetFace, family: ZoneFamily): BuildingPart[] {
  const wall = p.from(family.walls);
  const roof = p.from(family.roofs);
  const trim = p.from(family.trims);
  const sign = family.trims[(family.trims.indexOf(trim) + 1) % family.trims.length];
  const parts: BuildingPart[] = [];

  if (density === 1) {
    // Shop: flat roof slab, awning and sign on the street face.
    const w = 0.7;
    const d = 0.6;
    const h = 0.3 + p.unit() * 0.05;
    const body = box(w, h, d, 0, 0, 0, wall, { main: true });
    parts.push(body, plinth(body, family));
    parts.push(box(w + PARAPET_MARGIN.shop, 0.03, d + PARAPET_MARGIN.shop, 0, h, 0, roof));
    parts.push(onStreetFace(body, face, 0.9, 0.04, 0.08, h * 0.6, trim));
    parts.push(onStreetFace(body, face, 0.6, 0.08, 0.03, h * 0.6 + 0.05, sign));
  } else if (density === 2) {
    // Wider shop: pitched roof over the back half, flat front with awning, sign and PV.
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
  } else {
    // Market hall: long gable across the full width, two awnings, two vent stacks, PV on the slope.
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
    for (const side of [-1, 1]) {
      const [vx, vz] = faceOffset(side * 0.2, 0, face);
      parts.push({
        kind: PartKind.Cylinder,
        sx: 0.06,
        sy: 0.1,
        sz: 0.06,
        ox: vx,
        oy: h + roofHeight - 0.04,
        oz: vz,
        turn: 0,
        color: ACCENT.antenna,
        accent: true,
        role: PartRole.Vent,
      });
    }
    parts.push(pvOnSlope(body, face, roofW, roofD, roofHeight, h));
  }
  return parts;
}

/**
 * Factories: low halls under a saw-tooth roof (two gable parts side by
 * side), a roll-up door on the street face, a chimney for the stage 2
 * smoke; the bigger plants add a tank or a silo and flat PV.
 */
function industrial(
  density: number,
  p: Picker,
  face: StreetFace,
  family: ZoneFamily,
): BuildingPart[] {
  const wall = p.from(family.walls);
  const roof = p.from(family.roofs);
  const trim = p.from(family.trims);
  const parts: BuildingPart[] = [];

  // The two halves meet over the middle of the hall; each overhangs only
  // its outer side, so together they overhang the hall all round.
  const sawTooth = (w: number, d: number, top: number, ox: number, oz: number): void => {
    const half = w / 2;
    for (const side of [-1, 1]) {
      parts.push({
        kind: PartKind.GableRoof,
        sx: half + ROOF_OVERHANG,
        sy: 0.1,
        sz: d + 2 * ROOF_OVERHANG,
        ox: ox + (side * (half + ROOF_OVERHANG)) / 2,
        oy: top,
        oz,
        turn: 0,
        color: roof,
      });
    }
  };
  const chimney = (sx: number, sy: number, ox: number, oy: number, oz: number): BuildingPart => ({
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
  });

  if (density === 1) {
    // Workshop: one hall, saw-tooth roof, door, chimney at the back.
    const w = 0.7;
    const d = 0.5;
    const h = 0.28 + p.unit() * 0.04;
    const body = box(w, h, d, 0, 0, 0, wall, { main: true });
    parts.push(body, plinth(body, family));
    sawTooth(w, d, h, 0, 0);
    parts.push(onStreetFace(body, face, 0.4, h * 0.7, 0.02, 0, trim));
    parts.push(chimney(0.06, 0.22, -0.25, h, -0.15));
  } else if (density === 2) {
    // Plant: main hall behind, lower annex in front, tank, chimney, PV.
    const w = 0.7;
    const h = 0.36 + p.unit() * 0.04;
    const body = box(w, h, 0.34, 0, 0, -0.12, wall, { main: true });
    parts.push(body, plinth(body, family));
    sawTooth(w, 0.34, h, 0, -0.12);
    const annexH = h * 0.7;
    const annex = box(0.5, annexH, 0.22, -0.08, 0, 0.19, wall);
    parts.push(annex);
    parts.push(onStreetFace(annex, face, 0.5, annexH * 0.7, 0.02, 0, trim));
    parts.push({
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
    });
    parts.push(chimney(0.06, 0.34, -0.27, h, -0.2));
    parts.push(
      box(0.3, ROOFTOP_PV_THICKNESS, 0.16, 0.1, annexH, 0.19, ACCENT.rooftopPv, { accent: true }),
    );
  } else {
    // Works: long hall, trim band, silo, tall chimney, door, PV.
    const w = 0.74;
    const d = 0.5;
    const h = 0.42 + p.unit() * 0.06;
    const body = box(w, h, d, 0, 0, -0.04, wall, { main: true });
    parts.push(body, plinth(body, family));
    sawTooth(w, d, h, 0, -0.04);
    parts.push(box(w + 0.02, 0.03, d + 0.02, 0, h * 0.5, -0.04, trim, { accent: true }));
    parts.push(onStreetFace(body, face, 0.3, h * 0.6, 0.02, 0, trim));
    parts.push({
      kind: PartKind.Cylinder,
      sx: 0.18,
      sy: 0.7,
      sz: 0.18,
      ox: 0.3,
      oy: 0,
      oz: 0.3,
      turn: 0,
      color: ACCENT.waterTank,
      accent: true,
    });
    parts.push(chimney(0.06, 0.55, -0.3, h, -0.25));
    parts.push(
      box(0.3, ROOFTOP_PV_THICKNESS, 0.2, -0.15, h + 0.1, 0.1, ACCENT.rooftopPv, { accent: true }),
    );
  }
  return parts;
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
