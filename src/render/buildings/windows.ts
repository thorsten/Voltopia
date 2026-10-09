import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Depth step (world units) between the window's layers — frame, glass,
 * mullions — so nothing z-fights with the wall or with each other. The
 * window instance keeps a z scale of 1, so this is a true world offset.
 */
export const WINDOW_PROUD = 0.004;
/** The frame plane is this much larger than the glass (both axes). */
export const WINDOW_FRAME_SCALE = 1.18;
/** Vertex budget of one window (four planes and a box). */
export const WINDOW_MAX_VERTICES = 48;

export const FRAME = 0xf2efe8;
export const GLASS = 0x2b3440;
export const SILL = 0xd8d4cc;

/** Mullion bar thickness, in glass units. */
const MULLION = 0.08;
/** Sill height, in glass units. */
const SILL_HEIGHT = 0.08;
/**
 * Sill depth in world units, not glass units: instances scale x/y to the
 * window but keep z at 1 so `WINDOW_PROUD` stays a true world offset. A
 * slim ledge just proud of the mullions, well short of a balcony or door.
 */
const SILL_DEPTH = 0.016;
/**
 * Drop from the glass bottom to the sill bottom, in glass units (the frame
 * border below the glass plus the sill), so callers can keep sills clear
 * of the plinth.
 */
export const WINDOW_SILL_DROP = (WINDOW_FRAME_SCALE - 1) / 2 + SILL_HEIGHT;

function coloured(geometry: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const color = new THREE.Color(hex);
  const count = geometry.getAttribute('position').count;
  const data = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) data.set([color.r, color.g, color.b], i * 3);
  geometry.setAttribute('color', new THREE.BufferAttribute(data, 3));
  return geometry;
}

/**
 * One unit window facing +z: glass spanning x −0.5..0.5 and y 0..1 (its
 * base at y = 0), a frame plane `WINDOW_FRAME_SCALE` larger behind it, a
 * mullion cross in front of it and a sill below, its back on the wall
 * (z = 0). Vertex colours carry `FRAME`, `GLASS` and `SILL`. Instances
 * scale x/y to the window size and keep z at 1.
 */
export function windowGeometry(): THREE.BufferGeometry {
  const frameBottom = 0.5 - WINDOW_FRAME_SCALE / 2;
  const frame = new THREE.PlaneGeometry(WINDOW_FRAME_SCALE, WINDOW_FRAME_SCALE);
  frame.translate(0, 0.5, WINDOW_PROUD);
  const glass = new THREE.PlaneGeometry(1, 1);
  glass.translate(0, 0.5, 2 * WINDOW_PROUD);
  const vertical = new THREE.PlaneGeometry(MULLION, 1);
  vertical.translate(0, 0.5, 3 * WINDOW_PROUD);
  const horizontal = new THREE.PlaneGeometry(1, MULLION);
  horizontal.translate(0, 0.5, 3 * WINDOW_PROUD);
  const sill = new THREE.BoxGeometry(WINDOW_FRAME_SCALE, SILL_HEIGHT, SILL_DEPTH);
  sill.translate(0, frameBottom - SILL_HEIGHT / 2, SILL_DEPTH / 2);
  const merged = mergeGeometries([
    coloured(frame, FRAME),
    coloured(glass, GLASS),
    coloured(vertical, FRAME),
    coloured(horizontal, FRAME),
    coloured(sill, SILL),
  ]);
  if (!merged) throw new Error('windowGeometry: attribute mismatch while merging');
  return merged;
}
