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
}

export const MAX_PARTS_PER_TILE = 8;
/** Slots a tile owns per primitive kind; proven over the whole grid by recipes.test.ts. */
export const MAX_PARTS_PER_KIND: Record<PartKind, number> = {
  [PartKind.Box]: 7,
  [PartKind.GableRoof]: 2,
  [PartKind.HipRoof]: 1,
  [PartKind.Cylinder]: 2,
};
/** Half of the 0.86 footprint: no part may reach past this from the tile centre. */
export const FOOTPRINT_HALF = 0.43;

const ROOF_OVERHANG = 0.04;
const DOOR = { width: 0.2, height: 0.16, depth: 0.02 };
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
  flags: { main?: boolean; accent?: boolean } = {},
): BuildingPart {
  return { kind: PartKind.Box, sx, sy, sz, ox, oy, oz, turn: 0, color, ...flags };
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
    parts.push(body);
    const roofHeight = 0.14;
    if (p.chance(0.25)) {
      parts.push({
        kind: PartKind.HipRoof,
        sx: w + ROOF_OVERHANG,
        sy: roofHeight,
        sz: d + ROOF_OVERHANG,
        ox,
        oy: h,
        oz,
        turn: 0,
        color: roof,
      });
    } else {
      const turn = p.pick(2);
      parts.push({
        kind: PartKind.GableRoof,
        sx: turn === 0 ? w + ROOF_OVERHANG : d + ROOF_OVERHANG,
        sy: roofHeight,
        sz: turn === 0 ? d + ROOF_OVERHANG : w + ROOF_OVERHANG,
        ox,
        oy: h,
        oz,
        turn,
        color: roof,
      });
    }
    const sideX = p.chance(0.5) ? 1 : -1;
    const sideZ = p.chance(0.5) ? 1 : -1;
    parts.push(
      box(0.06, 0.18, 0.06, ox + sideX * w * 0.3, h, oz + sideZ * d * 0.25, ACCENT.chimney, {
        accent: true,
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
      const side = ox >= 0 ? -1 : 1;
      const ew = 0.16;
      const eh = h * 0.7;
      const ed = d * 0.7;
      const ex = ox + side * (w / 2 + ew / 2);
      parts.push(box(ew, eh, ed, ex, 0, oz, wall));
      parts.push({
        kind: PartKind.GableRoof,
        sx: ed,
        sy: 0.08,
        sz: ew,
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
    parts.push(body);
    const roofHeight = 0.16;
    const roofW = faceWidth(body, face) + ROOF_OVERHANG;
    const roofD = faceDepth(body, face) + ROOF_OVERHANG;
    // Ridge runs along the street face so the PV slope faces the street.
    parts.push(
      facePart(
        PartKind.GableRoof,
        body,
        face,
        { w: roofW, h: roofHeight, d: roofD, lx: 0, ly: h, lz: 0 },
        roof,
      ),
    );
    if (p.chance(0.5)) {
      // Dormer on the back slope, so it never collides with the PV slab.
      parts.push(
        facePart(
          PartKind.Box,
          body,
          face,
          { w: 0.14, h: 0.1, d: 0.12, lx: (p.unit() - 0.5) * 0.2, ly: h + 0.02, lz: -roofD / 4 },
          wall,
        ),
      );
      parts.push(
        facePart(
          PartKind.GableRoof,
          body,
          face,
          { w: 0.16, h: 0.06, d: 0.14, lx: 0, ly: h + 0.12, lz: -roofD / 4 },
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
    parts.push(body);
    parts.push(box(w + 0.04, 0.04, w + 0.04, 0, h, 0, roof));
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
    parts.push(body);
    parts.push(box(w + 0.04, 0.03, w + 0.04, 0, h - 0.03, 0, trim, { accent: true }));
    parts.push(onStreetFace(body, face, 0.5, 0.03, 0.1, h * 0.55, trim));
    parts.push(box(0.1, 0.08, 0.1, 0.15, h, -0.15, ACCENT.acUnit, { accent: true }));
  } else if (density === 2) {
    // Office block: two facade bands, two AC units, antenna, flat PV.
    const w = 0.62;
    const h = 1.0 + p.unit() * 0.1;
    const body = box(w, h, w, 0, 0, 0, wall, { main: true });
    parts.push(body);
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
    parts.push(body);
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
    });
    parts.push(
      box(0.3, ROOFTOP_PV_THICKNESS, 0.2, -0.02, h, -0.02, ACCENT.rooftopPv, { accent: true }),
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
