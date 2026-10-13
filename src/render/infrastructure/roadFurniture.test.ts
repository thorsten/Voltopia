import { describe, expect, it } from 'vitest';
import { DIR_E, DIR_N, DIR_S, DIR_W } from '../../shared/grid.ts';
import {
  KERB_OVERHANG,
  KERB_WIDTH,
  ZEBRA_STRIPES,
  ZEBRA_STRIPE_WIDTH,
  LAMP_REACH,
  MAX_PARTS_PER_LAMP,
  kerbPieces,
  lampModel,
  zebraPieces,
  type FlatPiece,
} from './roadFurniture.ts';

const STREET = 0.62;
const AVENUE = 0.8;
const EPS = 1e-9;

const inside = (p: FlatPiece) =>
  Math.abs(p.cx) + p.sizeX / 2 <= 0.5 + EPS && Math.abs(p.cz) + p.sizeZ / 2 <= 0.5 + EPS;
/** Pieces lying on the pad edge facing the given side. */
const padSide = (pieces: FlatPiece[], side: 'N' | 'E' | 'S' | 'W', pad: number) => {
  const edge = pad / 2 - KERB_WIDTH / 2 + KERB_OVERHANG;
  return pieces.filter((p) => {
    if (side === 'N') return Math.abs(p.cz + edge) < EPS && Math.abs(p.sizeX - pad) < EPS;
    if (side === 'S') return Math.abs(p.cz - edge) < EPS && Math.abs(p.sizeX - pad) < EPS;
    if (side === 'E') return Math.abs(p.cx - edge) < EPS && Math.abs(p.sizeZ - pad) < EPS;
    return Math.abs(p.cx + edge) < EPS && Math.abs(p.sizeZ - pad) < EPS;
  });
};

describe('kerbPieces', () => {
  it('lines a straight east-west street on its long sides only', () => {
    const pieces = kerbPieces(DIR_E | DIR_W, STREET);
    // 2 arms x 2 long sides + the pad's north and south sides.
    expect(pieces).toHaveLength(6);
    for (const p of pieces) {
      expect(p.sizeX).toBeGreaterThan(p.sizeZ); // runs along x, never across an x edge
      expect(p.sizeZ).toBeCloseTo(KERB_WIDTH);
      expect(Math.abs(p.cz)).toBeCloseTo(STREET / 2 - KERB_WIDTH / 2 + KERB_OVERHANG, 9);
    }
    expect(padSide(pieces, 'N', STREET)).toHaveLength(1);
    expect(padSide(pieces, 'S', STREET)).toHaveLength(1);
  });

  it('closes a dead end on its west, north and south pad sides', () => {
    const pieces = kerbPieces(DIR_E, STREET);
    expect(pieces).toHaveLength(5);
    expect(padSide(pieces, 'W', STREET)).toHaveLength(1);
    expect(padSide(pieces, 'N', STREET)).toHaveLength(1);
    expect(padSide(pieces, 'S', STREET)).toHaveLength(1);
    expect(padSide(pieces, 'E', STREET)).toHaveLength(0);
  });

  it('leaves open pad sides open but keeps the arm kerbs', () => {
    const pieces = kerbPieces(DIR_N | DIR_S, STREET, DIR_E | DIR_W);
    expect(pieces).toHaveLength(4);
    expect(padSide(pieces, 'E', STREET)).toHaveLength(0);
    expect(padSide(pieces, 'W', STREET)).toHaveLength(0);
    // An open side that carries an arm changes nothing.
    expect(kerbPieces(DIR_E | DIR_W, STREET, DIR_E)).toHaveLength(6);
  });

  it('keeps every piece inside the tile and widens with the avenue pad', () => {
    for (let mask = 0; mask < 16; mask++) {
      for (const pad of [STREET, AVENUE])
        for (const p of kerbPieces(mask, pad)) expect(inside(p)).toBe(true);
    }
    const street = kerbPieces(DIR_N | DIR_S, STREET);
    const avenue = kerbPieces(DIR_N | DIR_S, AVENUE);
    const widest = (ps: FlatPiece[]) => Math.max(...ps.map((p) => Math.abs(p.cx)));
    expect(widest(avenue)).toBeGreaterThan(widest(street));
  });
});

describe('zebraPieces', () => {
  it('marks every arm of a T-junction and nothing on a straight', () => {
    expect(zebraPieces(DIR_E | DIR_W, STREET)).toHaveLength(0);
    expect(zebraPieces(DIR_E, STREET)).toHaveLength(0);
    const t = zebraPieces(DIR_N | DIR_E | DIR_W, STREET);
    expect(t).toHaveLength(3 * ZEBRA_STRIPES);
    // No stripes on the missing south arm.
    expect(t.every((p) => p.cz <= 0.31 + EPS)).toBe(true);
    expect(zebraPieces(DIR_N | DIR_E | DIR_S | DIR_W, AVENUE)).toHaveLength(4 * ZEBRA_STRIPES);
  });

  it('keeps the stripes on the roadway inside the tile', () => {
    for (const pad of [STREET, AVENUE]) {
      for (const p of zebraPieces(DIR_N | DIR_E | DIR_S | DIR_W, pad)) {
        expect(inside(p)).toBe(true);
        const across = Math.abs(p.sizeX - ZEBRA_STRIPE_WIDTH) < EPS ? p.cx : p.cz;
        expect(Math.abs(across) + ZEBRA_STRIPE_WIDTH / 2).toBeLessThanOrEqual(pad / 2);
      }
    }
  });
});

describe('lampModel', () => {
  it('stands on y = 0 with its head under the housing at the arm tip', () => {
    const lamp = lampModel();
    lamp.geometry.computeBoundingBox();
    expect(lamp.geometry.boundingBox!.min.y).toBeCloseTo(0, 6);
    expect(lamp.head.y).toBeGreaterThan(0.25);
    expect(lamp.head.x).toBeGreaterThanOrEqual(LAMP_REACH - 0.02);
    expect(lamp.geometry.boundingBox!.max.x).toBeLessThanOrEqual(LAMP_REACH + 0.02);
    expect(lamp.parts).toBeLessThanOrEqual(MAX_PARTS_PER_LAMP);
    expect(lampModel()).toBe(lamp);
  });
});
