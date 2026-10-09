import { Zone } from '../../shared/types.ts';
import { PartKind } from './primitives.ts';
import { ACCENT } from './palette.ts';
import {
  type BuildingPart,
  DOOR,
  PLINTH_HEIGHT,
  type StreetFace,
  faceDepth,
  faceOffset,
  faceWidth,
} from './recipes.ts';
import { WINDOW_FRAME_SCALE, WINDOW_SILL_DROP } from './windows.ts';

/** The regular window grid on one facade. */
export const WINDOW_GRID = {
  /** Facade width per window column, before rounding to a column count. */
  colPitch: 0.24,
  /** Body height per window row, before rounding to a row count. */
  rowPitch: 0.28,
  maxCols: 3,
  maxRows: 4,
  /** Columns spread over this fraction of the facade width. */
  spread: 0.8,
  /** A ground-standing body's rows: first glass centre at this fraction of a row ... */
  rowOffset: 0.55,
  /** ... over this fraction of the body height (leaves room under the eaves). */
  rowSpan: 0.82,
  /** Extra gap between a door and a window frame nudged clear of it. */
  doorMargin: 0.01,
} as const;
/**
 * Max window slots (framed windows, lit or dark) per building: the full
 * grid on two faces. Glow quads are a subset, so both meshes share it.
 */
export const WINDOWS_PER_TILE = 2 * WINDOW_GRID.maxCols * WINDOW_GRID.maxRows;
/** Glass size of one regular window. */
export const WINDOW_WIDTH = 0.09;
export const WINDOW_HEIGHT = 0.11;
/** Visible window width: the frame, not the glass. */
export const FRAME_WIDTH = WINDOW_FRAME_SCALE * WINDOW_WIDTH;
/** Top of the retail shopfront glass as a fraction of body height; below the 0.6h awning. */
const SHOPFRONT_TOP_FRACTION = 0.55;
/** Preferred bottom of the shopfront glass; raised when its sill would sink into the plinth. */
const SHOPFRONT_BOTTOM_FRACTION = 0.12;
/** Shopfront glass width as a fraction of the facade width. */
const SHOPFRONT_WIDTH_FRACTION = 0.8;
/** Tolerance for "touches the facade" and for rectangle overlaps. */
const EPS = 1e-6;

/** One laid-out window (or shopfront) on a facade, in tile-local coordinates. */
export interface WindowSlot {
  face: StreetFace;
  /** Offset of the glass centre from the tile centre, on the facade plane. */
  x: number;
  z: number;
  /** Height of the glass centre above the tile's base. */
  y: number;
  /** Glass size. */
  width: number;
  height: number;
  /** The single wide retail shopfront (always lit, no dark pattern). */
  shopfront: boolean;
  /** Stable per-building window number, feeding the deterministic dark pattern. */
  id: number;
}

/** Frame rectangle of a window in its facade's frame: lateral and vertical extents. */
export interface FrameRect {
  left: number;
  right: number;
  bottom: number;
  top: number;
}

/** The frame (with its sill) around glass of `width` × `height` centred at (`lx`, `y`). */
export function frameRect(lx: number, y: number, width: number, height: number): FrameRect {
  const border = ((WINDOW_FRAME_SCALE - 1) / 2) * height;
  return {
    left: lx - (WINDOW_FRAME_SCALE * width) / 2,
    right: lx + (WINDOW_FRAME_SCALE * width) / 2,
    bottom: y - height / 2 - WINDOW_SILL_DROP * height,
    top: y + height / 2 + border,
  };
}

/** Bodies that carry windows: the main body first, then the flagged secondary bodies. */
export function windowBodies(parts: readonly BuildingPart[]): BuildingPart[] {
  const main = parts.find((p) => p.main);
  if (!main) return [];
  return [main, ...parts.filter((p) => !p.main && p.windows)];
}

/**
 * Glass-centre heights of a window body's rows. A ground-standing body
 * keeps the main grid; a storey stacked on another part centres its rows
 * so the sills clear what it stands on.
 */
export function windowRows(body: BuildingPart, isMain: boolean): number[] {
  const rows = Math.min(
    WINDOW_GRID.maxRows,
    Math.max(1, Math.round(body.sy / WINDOW_GRID.rowPitch)),
  );
  return Array.from({ length: rows }, (_, row) =>
    isMain || body.oy === 0
      ? body.oy + ((row + WINDOW_GRID.rowOffset) / rows) * body.sy * WINDOW_GRID.rowSpan
      : body.oy + ((row + 0.5) / rows) * body.sy,
  );
}

/** Parts that can hide a window frame: every non-detail Box or shed roof, upright. */
function isOccluder(part: BuildingPart): boolean {
  return (
    (part.kind === PartKind.Box || part.kind === PartKind.ShedRoof) &&
    part.detail === undefined &&
    part.tilt === undefined &&
    !part.band
  );
}

/** Undo the face rotation: an offset from the tile centre in the face's own (south) frame. */
function toFaceFrame(x: number, z: number, face: StreetFace): [number, number] {
  return faceOffset(x, z, ((4 - face) % 4) as StreetFace);
}

/**
 * Axis-aligned extent of `part` in the frame of `face`: lateral, vertical
 * and normal (toward that face's street) ranges.
 */
function extentOnFace(
  part: BuildingPart,
  face: StreetFace,
): { lat: [number, number]; y: [number, number]; n: [number, number] } {
  const [lat, n] = toFaceFrame(part.ox, part.oz, face);
  // World half extents, then swapped once more when the face itself is turned.
  const [hx, hz] = part.turn % 2 === 0 ? [part.sx / 2, part.sz / 2] : [part.sz / 2, part.sx / 2];
  const [hLat, hN] = face % 2 === 0 ? [hx, hz] : [hz, hx];
  return {
    lat: [lat - hLat, lat + hLat],
    y: [part.oy, part.oy + part.sy],
    n: [n - hN, n + hN],
  };
}

/**
 * The sideways extent (face frame) of the first part other than `body`
 * that touches the facade plane at `plane` and overlaps the frame
 * rectangle `rect` — the part that would cut the window — or undefined.
 */
function clipper(
  parts: readonly BuildingPart[],
  body: BuildingPart,
  face: StreetFace,
  plane: number,
  rect: FrameRect,
): [number, number] | undefined {
  for (const part of parts) {
    if (part === body || !isOccluder(part)) continue;
    const e = extentOnFace(part, face);
    if (e.n[0] > plane + EPS || e.n[1] < plane - EPS) continue;
    if (
      e.lat[0] < rect.right - EPS &&
      e.lat[1] > rect.left + EPS &&
      e.y[0] < rect.top - EPS &&
      e.y[1] > rect.bottom + EPS
    ) {
      return e.lat;
    }
  }
  return undefined;
}

/** Sideways offset (face frame, from the body centre) of a door on `body`'s street face. */
function doorOn(
  parts: readonly BuildingPart[],
  body: BuildingPart,
  face: StreetFace,
): number | undefined {
  const width = faceWidth(body, face);
  const depth = faceDepth(body, face);
  for (const part of parts) {
    if (!part.accent || part.color.getHex() !== ACCENT.door.getHex()) continue;
    const [lx, lz] = toFaceFrame(part.ox - body.ox, part.oz - body.oz, face);
    if (Math.abs(lz - (depth / 2 + DOOR.depth / 2)) < EPS && Math.abs(lx) <= width / 2) return lx;
  }
  return undefined;
}

/**
 * The window's sideways position after clearing the door at `doorLx`:
 * unchanged when the frame misses the door, nudged to the nearer side that
 * still fits the facade and clears the other columns, or undefined (drop).
 */
function clearOfDoor(
  lx: number,
  y: number,
  doorLx: number,
  body: BuildingPart,
  width: number,
  colLx: readonly number[],
  col: number,
): number | undefined {
  // The whole frame (sill included) must clear the door, not just the glass.
  const frame = frameRect(lx, y, WINDOW_WIDTH, WINDOW_HEIGHT);
  const intersectsDoor =
    frame.left < doorLx + DOOR.width / 2 &&
    frame.right > doorLx - DOOR.width / 2 &&
    frame.bottom < body.oy + DOOR.height &&
    frame.top > body.oy;
  if (!intersectsDoor) return lx;
  // Clear the door by the whole frame, not just the glass: a door margin
  // where the facade has room, else slid back to the facade edge as long
  // as the frame still misses the door.
  const clear = DOOR.width / 2 + FRAME_WIDTH / 2;
  const limit = width / 2 - FRAME_WIDTH / 2 - EPS;
  const beside = (side: 1 | -1): number | undefined => {
    const ideal = doorLx + side * (clear + WINDOW_GRID.doorMargin);
    const at = Math.max(-limit, Math.min(limit, ideal));
    return side * (at - doorLx) >= clear ? at : undefined;
  };
  const rightLx = beside(1);
  const leftLx = beside(-1);
  let nudged: number | undefined;
  if (rightLx !== undefined && leftLx !== undefined) {
    nudged = Math.abs(rightLx - lx) <= Math.abs(leftLx - lx) ? rightLx : leftLx;
  } else {
    nudged = rightLx ?? leftLx;
  }
  if (nudged === undefined) return undefined;
  const target = nudged;
  if (colLx.some((other, i) => i !== col && Math.abs(target - other) < FRAME_WIDTH)) {
    return undefined;
  }
  return target;
}

/** Gap between a moved-aside frame and the part it steps around. */
export const ASIDE_GAP = 0.01;
/** How many occluder edges one window may try before it is dropped. */
const ASIDE_TRIES = 6;

/**
 * Where a window cut by an occluder can go instead: the nearest spot just
 * beside an occluder edge (body-relative, face frame) that fits the facade,
 * is cut by nothing and stays a frame width clear of `taken` — or undefined.
 */
function stepAside(
  lx: number,
  hit: [number, number],
  bodyLat: number,
  width: number,
  taken: readonly number[],
  cuts: (lx: number) => [number, number] | undefined,
): number | undefined {
  const half = FRAME_WIDTH / 2;
  const edges = (span: [number, number]): number[] => [
    span[0] - bodyLat - half - ASIDE_GAP,
    span[1] - bodyLat + half + ASIDE_GAP,
  ];
  const frontier = edges(hit);
  const tried: number[] = [];
  for (let i = 0; i < ASIDE_TRIES; i++) {
    const open = frontier.filter((c) => !tried.some((t) => Math.abs(t - c) < EPS));
    if (open.length === 0) return undefined;
    // Nearest first; ties go to the right, deterministically.
    const c = open.reduce((best, x) =>
      Math.abs(x - lx) < Math.abs(best - lx) - EPS ||
      (Math.abs(Math.abs(x - lx) - Math.abs(best - lx)) <= EPS && x > best)
        ? x
        : best,
    );
    tried.push(c);
    if (Math.abs(c) + half >= width / 2) continue;
    const next = cuts(c);
    if (next) {
      frontier.push(...edges(next));
      continue;
    }
    if (taken.some((t) => Math.abs(t - c) < FRAME_WIDTH)) continue;
    return c;
  }
  return undefined;
}

/**
 * Framed windows on the street face and its opposite of every window
 * body (the main body and the parts flagged `windows`), as a column/row
 * grid per facade. Retail densities 1-2 get one wide shopfront on the
 * main body's street face instead. A window over a door is nudged aside;
 * a window whose frame another part (bay, canopy, sign, roll-up door,
 * neighbouring body...) would cut steps aside to the nearest free spot
 * beside that part in its row, or is dropped when there is none. Frames
 * never overlap one another. At most `WINDOWS_PER_TILE`.
 */
export function layoutWindows(
  parts: readonly BuildingPart[],
  face: StreetFace,
  zone: Zone,
  density: number,
): WindowSlot[] {
  const slots: WindowSlot[] = [];
  const bodies = windowBodies(parts);
  const shopfront = zone === Zone.Retail && density < 3;
  let id = 0;
  for (const body of bodies) {
    const isMain = body === bodies[0];
    for (const [side, isStreet] of [
      [face, true],
      [((face + 2) % 4) as StreetFace, false],
    ] as const) {
      const width = faceWidth(body, side);
      const depth = faceDepth(body, side);
      const [, centreN] = toFaceFrame(body.ox, body.oz, side);
      const plane = centreN + depth / 2;
      const [px, pz] = faceOffset(0, depth / 2, side);
      if (isStreet && shopfront && isMain) {
        if (slots.length >= WINDOWS_PER_TILE) return slots;
        // Keep the top fixed below the awning; lift the bottom so the
        // sill (WINDOW_SILL_DROP × height below the glass) clears the
        // plinth: bottom - DROP × (top - bottom) >= PLINTH_HEIGHT.
        const top = body.sy * SHOPFRONT_TOP_FRACTION;
        const bottom = Math.max(
          body.sy * SHOPFRONT_BOTTOM_FRACTION,
          (PLINTH_HEIGHT + WINDOW_SILL_DROP * top) / (1 + WINDOW_SILL_DROP),
        );
        slots.push({
          face: side,
          x: body.ox + px,
          z: body.oz + pz,
          y: body.oy + (top + bottom) / 2,
          width: width * SHOPFRONT_WIDTH_FRACTION,
          height: top - bottom,
          shopfront: true,
          id: -1,
        });
        continue;
      }
      const doorLx = isStreet ? doorOn(parts, body, side) : undefined;
      const cols = Math.min(
        WINDOW_GRID.maxCols,
        Math.max(1, Math.round(width / WINDOW_GRID.colPitch)),
      );
      const rows = windowRows(body, isMain).length;
      const colLx = Array.from(
        { length: cols },
        (_, c) => ((c + 0.5) / cols - 0.5) * width * WINDOW_GRID.spread,
      );
      const [bodyLat] = toFaceFrame(body.ox, body.oz, side);
      const faceSlots: WindowSlot[] = [];
      const rowYs = windowRows(body, isMain);
      for (let row = 0; row < rows; row++) {
        const y = rowYs[row];
        const cuts = (lx: number): [number, number] | undefined =>
          clipper(
            parts,
            body,
            side,
            plane,
            frameRect(bodyLat + lx, y, WINDOW_WIDTH, WINDOW_HEIGHT),
          );
        // Columns that stand free keep their place; cut ones then step aside
        // around the parts that cut them, clear of everything already placed.
        const placed: Array<{ col: number; lx: number }> = [];
        const blocked: Array<{ col: number; lx: number; hit: [number, number] }> = [];
        for (let col = 0; col < cols; col++) {
          const nudged =
            doorLx === undefined
              ? colLx[col]
              : clearOfDoor(colLx[col], y, doorLx, body, width, colLx, col);
          const lx = nudged ?? colLx[col];
          const hit = cuts(lx);
          if (nudged !== undefined && !hit) placed.push({ col, lx });
          else if (hit) blocked.push({ col, lx, hit });
        }
        for (const { col, lx, hit } of blocked) {
          const taken = placed.map((p) => p.lx);
          const aside = stepAside(lx, hit, bodyLat, width, taken, cuts);
          if (aside !== undefined) placed.push({ col, lx: aside });
        }
        for (const { col, lx } of placed) {
          const [fx, fz] = faceOffset(lx, depth / 2, side);
          faceSlots.push({
            face: side,
            x: body.ox + fx,
            z: body.oz + fz,
            y,
            width: WINDOW_WIDTH,
            height: WINDOW_HEIGHT,
            shopfront: false,
            // Column-major numbering, as the grid has always been counted.
            id: id + col * rows + row + 1,
          });
        }
      }
      id += cols * rows;
      faceSlots.sort((a, b) => a.id - b.id);
      for (const slot of faceSlots) {
        if (slots.length >= WINDOWS_PER_TILE) return slots;
        slots.push(slot);
      }
    }
  }
  return slots;
}
