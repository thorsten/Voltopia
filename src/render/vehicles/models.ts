import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** Upper bound on boxes per model, so 220 cars stay cheap. */
export const MAX_PARTS_PER_MODEL = 16;

/** Vertex colours. BODY is white so the instance colour paints it; the rest are fixed. */
export const BODY = 0xffffff;
export const GLASS = 0x2b3440;
export const TYRE = 0x1f2224;
export const TRIM = 0x5a5f66;
export const LENS_FRONT = 0xf4f0d8;
export const LENS_REAR = 0xb03030;
export const PANTOGRAPH = 0x2b2f33;
/** Livery band on delivery vans (the van body itself is white). */
export const VAN_STRIPE = 0x3f8fd6;

/**
 * Drawn body lengths in tiles. BALANCE.rail.wagonGap (sim) is measured
 * centre to centre; vehiclesMesh.test.ts holds the two in step.
 */
export const LOCOMOTIVE_LENGTH = 0.52;
export const WAGON_LENGTH = 0.5;

export interface VehicleModel {
  geometry: THREE.BufferGeometry;
  /** Number of merged parts (≤ MAX_PARTS_PER_MODEL). */
  parts: number;
  /** Length along +x in tiles: places head and tail lights. */
  length: number;
}

const scratch = new THREE.Color();

/** A box of size (w along x, h, d along z) centred at (x, y, z) with one vertex colour. */
function part(
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  color: number,
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  scratch.setHex(color);
  const n = g.getAttribute('position').count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) colors.set([scratch.r, scratch.g, scratch.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

const TUBE_SEGMENTS = 8;

/** A cylinder along x (radius r, length l) centred at (x, y, z), for tank wagons. */
function tube(
  r: number,
  l: number,
  x: number,
  y: number,
  z: number,
  color: number,
): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, l, TUBE_SEGMENTS);
  g.rotateZ(Math.PI / 2);
  g.translate(x, y, z);
  scratch.setHex(color);
  const n = g.getAttribute('position').count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) colors.set([scratch.r, scratch.g, scratch.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

function model(parts: THREE.BufferGeometry[], length: number): VehicleModel {
  const geometry = mergeGeometries(parts);
  if (!geometry) throw new Error('vehicle model: parts do not merge');
  return { geometry, parts: parts.length, length };
}

/** Tyre size and ride height shared by road vehicles. */
const TYRE_LENGTH = 0.06;
const TYRE_HEIGHT = 0.05;
const TYRE_DEPTH = 0.02;
const SILL = 0.03; // body bottom: the tyres stick out below it
const LENS = { w: 0.004, h: 0.012, d: 0.025 } as const;

function tyres(length: number, width: number, axleInset: number): THREE.BufferGeometry[] {
  const ax = length / 2 - axleInset;
  const z = width / 2 - TYRE_DEPTH / 2;
  const out: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1])
    for (const sz of [-1, 1])
      out.push(part(TYRE_LENGTH, TYRE_HEIGHT, TYRE_DEPTH, sx * ax, TYRE_HEIGHT / 2, sz * z, TYRE));
  return out;
}

function lenses(length: number, width: number, y: number): THREE.BufferGeometry[] {
  const x = length / 2 - LENS.w / 2;
  const z = width / 2 - 0.03;
  return [
    part(LENS.w, LENS.h, LENS.d, x, y, z, LENS_FRONT),
    part(LENS.w, LENS.h, LENS.d, x, y, -z, LENS_FRONT),
    part(LENS.w, LENS.h, LENS.d, -x, y, z, LENS_REAR),
    part(LENS.w, LENS.h, LENS.d, -x, y, -z, LENS_REAR),
  ];
}

/** One parametric car: lower body, cabin with a glass band, tyres, bumpers, lenses, optional roof rails. */
function car(p: {
  length: number;
  width: number;
  bodyH: number;
  cabinH: number;
  cabinL: number;
  cabinX: number;
  rails?: boolean;
}): VehicleModel {
  const bodyW = p.width - 0.01;
  const bodyY = SILL + p.bodyH / 2;
  const cabinBottom = SILL + p.bodyH;
  const cabinY = cabinBottom + p.cabinH / 2;
  const railH = p.rails ? 0.005 : 0;
  const parts = [
    part(p.length - 0.02, p.bodyH, bodyW, 0, bodyY, 0, BODY),
    part(
      p.cabinL,
      p.cabinH - railH,
      bodyW - 0.01,
      p.cabinX,
      cabinBottom + (p.cabinH - railH) / 2,
      0,
      BODY,
    ),
    part(
      p.cabinL + 0.002,
      (p.cabinH - railH) * 0.6,
      bodyW - 0.008,
      p.cabinX,
      cabinY - railH / 2,
      0,
      GLASS,
    ),
    ...tyres(p.length, p.width, 0.06),
    part(0.01, 0.02, bodyW, p.length / 2 - 0.005, SILL + 0.01, 0, TRIM),
    part(0.01, 0.02, bodyW, -p.length / 2 + 0.005, SILL + 0.01, 0, TRIM),
    ...lenses(p.length, bodyW, bodyY),
  ];
  if (p.rails) {
    for (const s of [-1, 1])
      parts.push(
        part(
          p.cabinL * 0.9,
          railH,
          0.005,
          p.cabinX,
          SILL + p.bodyH + p.cabinH - railH / 2,
          s * (bodyW / 2 - 0.02),
          TRIM,
        ),
      );
  }
  return model(parts, p.length);
}

export const hatchbackModel = (): VehicleModel =>
  car({ length: 0.26, width: 0.14, bodyH: 0.05, cabinH: 0.05, cabinL: 0.14, cabinX: -0.03 });
export const sedanModel = (): VehicleModel =>
  car({ length: 0.3, width: 0.14, bodyH: 0.05, cabinH: 0.05, cabinL: 0.15, cabinX: -0.01 });
export const estateModel = (): VehicleModel =>
  car({ length: 0.3, width: 0.14, bodyH: 0.05, cabinH: 0.06, cabinL: 0.2, cabinX: -0.04 });
export const suvModel = (): VehicleModel =>
  car({
    length: 0.3,
    width: 0.15,
    bodyH: 0.07,
    cabinH: 0.06,
    cabinL: 0.19,
    cabinX: -0.04,
    rails: true,
  });

export function vanModel(): VehicleModel {
  const L = 0.34,
    W = 0.15,
    H = 0.18;
  const bodyW = W - 0.004;
  return model(
    [
      // Box body from the rear to just behind the cab, full height.
      part(0.23, H - SILL, bodyW, -L / 2 + 0.115, SILL + (H - SILL) / 2, 0, BODY),
      // Lip around the top edge of the box.
      part(0.232, 0.01, W, -L / 2 + 0.115, H - 0.005, 0, TRIM),
      // Livery stripe along both sides.
      part(0.232, 0.02, W, -L / 2 + 0.115, SILL + 0.06, 0, VAN_STRIPE),
      // Cab at the front, lower than the box, with a windscreen.
      part(0.11, 0.11, bodyW, L / 2 - 0.055, SILL + 0.055, 0, BODY),
      part(0.004, 0.04, bodyW - 0.02, L / 2 - 0.002, SILL + 0.085, 0, GLASS),
      ...tyres(L, W, 0.07),
      ...lenses(L, bodyW, SILL + 0.03),
    ],
    L,
  );
}

export function busModel(): VehicleModel {
  const L = 0.4,
    W = 0.16,
    top = 0.18;
  const bodyW = W - 0.008;
  return model(
    [
      part(L, top - SILL, bodyW, 0, SILL + (top - SILL) / 2, 0, BODY),
      // Window band along both sides, slightly proud of the body.
      part(L - 0.04, 0.05, W, 0, top - 0.05, 0, GLASS),
      // Windscreen.
      part(0.004, 0.07, bodyW - 0.02, L / 2 - 0.002, top - 0.06, 0, GLASS),
      // Two door marks below the window band, on the right-hand side and mirrored.
      part(0.04, 0.065, W, 0.12, SILL + 0.0425, 0, TRIM),
      part(0.04, 0.065, W, -0.03, SILL + 0.0425, 0, TRIM),
      // Battery packs on the roof.
      part(0.12, 0.02, 0.1, 0.08, top + 0.01, 0, TRIM),
      part(0.12, 0.02, 0.1, -0.08, top + 0.01, 0, TRIM),
      ...tyres(L, W, 0.07),
      ...lenses(L, bodyW, SILL + 0.03),
    ],
    L,
  );
}

const BOGIE = { l: 0.14, h: 0.04, d: 0.14 } as const;
function bogies(length: number): THREE.BufferGeometry[] {
  const x = length / 2 - 0.11;
  return [
    part(BOGIE.l, BOGIE.h, BOGIE.d, x, BOGIE.h / 2, 0, TYRE),
    part(BOGIE.l, BOGIE.h, BOGIE.d, -x, BOGIE.h / 2, 0, TYRE),
  ];
}

export function locomotiveModel(): VehicleModel {
  const L = LOCOMOTIVE_LENGTH,
    W = 0.18,
    bodyTop = 0.21;
  const bodyW = W - 0.01;
  return model(
    [
      ...bogies(L),
      part(L, bodyTop - BOGIE.h, bodyW, 0, BOGIE.h + (bodyTop - BOGIE.h) / 2, 0, BODY),
      // Cab windows: windscreens at both ends, a side band at the front cab.
      part(0.004, 0.05, bodyW - 0.02, L / 2 - 0.002, 0.17, 0, GLASS),
      part(0.004, 0.05, bodyW - 0.02, -L / 2 + 0.002, 0.17, 0, GLASS),
      part(0.08, 0.04, W, L / 2 - 0.06, 0.17, 0, GLASS),
      // Roof and pantograph (base, mast, contact bar).
      part(L - 0.04, 0.02, 0.15, 0, bodyTop + 0.01, 0, TRIM),
      part(0.06, 0.01, 0.06, 0, bodyTop + 0.025, 0, PANTOGRAPH),
      part(0.01, 0.055, 0.01, 0, bodyTop + 0.0575, 0, PANTOGRAPH),
      part(0.01, 0.01, 0.14, 0, 0.295, 0, PANTOGRAPH),
      ...lenses(L, bodyW, 0.09),
    ],
    L,
  );
}

const DECK_TOP = 0.07;
function deck(): THREE.BufferGeometry {
  return part(
    WAGON_LENGTH,
    DECK_TOP - BOGIE.h,
    0.17,
    0,
    BOGIE.h + (DECK_TOP - BOGIE.h) / 2,
    0,
    TRIM,
  );
}

export function passengerWagonModel(): VehicleModel {
  const L = WAGON_LENGTH,
    W = 0.17;
  return model(
    [
      ...bogies(L),
      part(L, 0.15, W - 0.004, 0, BOGIE.h + 0.075, 0, BODY),
      part(L - 0.06, 0.045, W, 0, 0.14, 0, GLASS),
      part(L - 0.02, 0.01, 0.15, 0, 0.195, 0, TRIM),
    ],
    L,
  );
}

export function containerWagonModel(): VehicleModel {
  return model(
    [...bogies(WAGON_LENGTH), deck(), part(0.44, 0.14, 0.15, 0, DECK_TOP + 0.07, 0, BODY)],
    WAGON_LENGTH,
  );
}

export function hopperWagonModel(): VehicleModel {
  return model(
    [
      ...bogies(WAGON_LENGTH),
      deck(),
      part(0.44, 0.13, 0.16, 0, DECK_TOP + 0.065, 0, BODY),
      part(0.4, 0.01, 0.14, 0, DECK_TOP + 0.135, 0, TRIM),
    ],
    WAGON_LENGTH,
  );
}

export function tankWagonModel(): VehicleModel {
  return model(
    [
      ...bogies(WAGON_LENGTH),
      deck(),
      tube(0.07, 0.44, 0, DECK_TOP + 0.07, 0, BODY),
      part(0.04, 0.01, 0.04, 0, DECK_TOP + 0.145, 0, TRIM),
    ],
    WAGON_LENGTH,
  );
}
