import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../buildings/windowLayout.ts';
import { box } from '../modelKit.ts';
import type { Face, LampAnchor, WindowAnchor } from './models.ts';

/** Structural tones shared by the energy and service models. */
export const TONE = {
  CONCRETE: 0x9a9da3,
  GRAVEL: 0x8a8478,
  STEEL: 0x6f7a86,
  ROOF_DARK: 0x4b5563,
  GLASS: 0x2b3440,
  FRAME: 0x3a4048,
  FENCE: 0x9aa3ad,
  MARKING: 0xe8eaec,
} as const;

/** Plinth size for models that fill most of their tile. */
export const FULL_PLINTH = 0.92;
/** Yard lamp: default pole height and its section. */
const LAMP_POLE_HEIGHT = 0.4;
const LAMP_POLE_SIZE = 0.02;

/** A standard-size window with its glass bottom at y on a wall facing `face`. */
export function win(x: number, y: number, z: number, face: Face): WindowAnchor {
  return { x, y, z, face, w: WINDOW_WIDTH, h: WINDOW_HEIGHT };
}

/** Yard lamp pole standing at (x, z) on `base`; returns the part and the lamp at its top. */
export function yardLamp(x: number, z: number, height = LAMP_POLE_HEIGHT, base = 0) {
  const part = box(LAMP_POLE_SIZE, height, LAMP_POLE_SIZE, x, base + height / 2, z, TONE.FRAME);
  const lamp: LampAnchor = { x, y: base + height, z, kind: 'yard' };
  return { part, lamp };
}
