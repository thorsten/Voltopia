import { tileIndex } from '../../../shared/grid.ts';

/** Horizontal run of tiles on row y from x0 to x1 inclusive. */
export function row(size: number, y: number, x0: number, x1: number): number[] {
  const out: number[] = [];
  for (let x = x0; x <= x1; x++) out.push(tileIndex(x, y, size));
  return out;
}

/** Vertical run of tiles on column x from y0 to y1 inclusive. */
export function column(size: number, x: number, y0: number, y1: number): number[] {
  const out: number[] = [];
  for (let y = y0; y <= y1; y++) out.push(tileIndex(x, y, size));
  return out;
}

/** Filled rectangle, inclusive corners. */
export function rect(size: number, x0: number, y0: number, x1: number, y1: number): number[] {
  const out: number[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push(tileIndex(x, y, size));
  return out;
}
