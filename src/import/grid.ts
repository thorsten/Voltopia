/** Grid primitives of the rasteriser: 4-connected lines, scanline fill, components. */

export type Point = [number, number];

/**
 * Visit every tile of the line from (x0, y0) to (x1, y1), stepping only
 * north/east/south/west (never diagonally) so the sim's 4-neighbour
 * adjacency sees one connected run. Coordinates are floored to tiles.
 */
export function line4(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  visit: (x: number, y: number) => void,
): void {
  let x = Math.floor(x0);
  let y = Math.floor(y0);
  const tx = Math.floor(x1);
  const ty = Math.floor(y1);
  const dx = Math.abs(tx - x);
  const dy = Math.abs(ty - y);
  const sx = x < tx ? 1 : -1;
  const sy = y < ty ? 1 : -1;
  let err = dx - dy;
  visit(x, y);
  while (x !== tx || y !== ty) {
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    } else {
      err += dx;
      y += sy;
    }
    visit(x, y);
  }
}

/**
 * Scanline fill (even-odd rule) of one or more rings on a `size` grid: a
 * tile is inside when its centre is. Rings with fewer than three points
 * are ignored.
 */
export function fillPolygon(
  rings: Point[][],
  size: number,
  visit: (x: number, y: number) => void,
): void {
  const usable = rings.filter((ring) => ring.length >= 3);
  if (usable.length === 0) return;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const ring of usable) {
    for (const [, y] of ring) {
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  const firstRow = Math.max(0, Math.floor(minY));
  const lastRow = Math.min(size - 1, Math.ceil(maxY));
  const crossings: number[] = [];
  for (let y = firstRow; y <= lastRow; y++) {
    const yc = y + 0.5;
    crossings.length = 0;
    for (const ring of usable) {
      for (let i = 0; i < ring.length; i++) {
        const [ax, ay] = ring[i];
        const [bx, by] = ring[(i + 1) % ring.length];
        if (ay <= yc === by <= yc) continue;
        crossings.push(ax + ((yc - ay) * (bx - ax)) / (by - ay));
      }
    }
    crossings.sort((a, b) => a - b);
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const from = Math.max(0, Math.floor(crossings[i] + 0.5));
      const to = Math.min(size, Math.floor(crossings[i + 1] + 0.5));
      for (let x = from; x < to; x++) visit(x, y);
    }
  }
}

/** Area of a ring (shoelace), in squared grid units. */
export function ringArea(ring: Point[]): number {
  let twice = 0;
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[(i + 1) % ring.length];
    twice += ax * by - bx * ay;
  }
  return Math.abs(twice) / 2;
}

/** Number of 4-connected components of the set tiles (non-zero) of a mask. */
export function countComponents(mask: Uint8Array, size: number): number {
  const seen = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  let components = 0;
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] === 0 || seen[start] !== 0) continue;
    components++;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    while (top > 0) {
      const index = stack[--top];
      const x = index % size;
      const y = (index - x) / size;
      if (y > 0) top = pushUnseen(mask, seen, stack, top, index - size);
      if (x < size - 1) top = pushUnseen(mask, seen, stack, top, index + 1);
      if (y < size - 1) top = pushUnseen(mask, seen, stack, top, index + size);
      if (x > 0) top = pushUnseen(mask, seen, stack, top, index - 1);
    }
  }
  return components;
}

function pushUnseen(
  mask: Uint8Array,
  seen: Uint8Array,
  stack: Int32Array,
  top: number,
  index: number,
): number {
  if (mask[index] === 0 || seen[index] !== 0) return top;
  seen[index] = 1;
  stack[top] = index;
  return top + 1;
}

/** Whether any 4-neighbour of (x, y) is set in the mask. */
export function hasSetNeighbor(mask: Uint8Array, size: number, x: number, y: number): boolean {
  const index = y * size + x;
  return (
    (y > 0 && mask[index - size] !== 0) ||
    (x < size - 1 && mask[index + 1] !== 0) ||
    (y < size - 1 && mask[index + size] !== 0) ||
    (x > 0 && mask[index - 1] !== 0)
  );
}
