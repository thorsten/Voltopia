/**
 * Power-line supports: a steel lattice pylon for open land and a slim
 * concrete pole for town (roads, zones, tracks).
 *
 * Conventions: units are tiles; origin at the foot; base at y = 0; the
 * cross-arms run along local x, so the line itself runs along local z.
 */
import * as THREE from 'three';
import { box, cone, merge } from '../modelKit.ts';

export type PylonKind = 'lattice' | 'pole';
export const MAX_PARTS_PER_PYLON = 20;

export interface PylonModel {
  /** Base y = 0, origin at the foot, arms along local x. */
  geometry: THREE.BufferGeometry;
  parts: number;
  /** Conductor attachment points (insulator tips), sorted by x ascending. */
  attachments: ReadonlyArray<{ x: number; y: number; z: number }>;
}

const COLOR = {
  steel: 0x7b8086,
  steelDark: 0x656a70,
  insulator: 0xb9c3c6,
  concrete: 0xc4c1ba,
} as const;

/** Lattice tower: four legs tapering from the foot to the top. */
const LATTICE = {
  footHalf: 0.09,
  topHalf: 0.03,
  top: 0.5,
  leg: 0.018,
  brace: 0.012,
  braceLevels: [0.16, 0.32],
  /** Wide lower arm carrying the two outer conductors on hanging insulators. */
  arm: { y: 0.42, half: 0.19, thickness: 0.022 },
  /** Short top arm carrying the middle conductor on a standing insulator. */
  topArm: { half: 0.06, thickness: 0.02 },
  insulator: { width: 0.016, length: 0.06 },
  outerX: 0.165,
} as const;

/** Radius of the concrete pole's shaft at its foot. */
export const POLE_FOOT_RADIUS = 0.026;

/** Concrete pole: tapered round shaft, one short arm, three standing insulators. */
const POLE = {
  rBottom: POLE_FOOT_RADIUS,
  rTop: 0.016,
  shaft: 0.37,
  segments: 8,
  arm: { half: 0.115, thickness: 0.018, depth: 0.024 },
  insulator: { width: 0.014, length: 0.035 },
  outerX: 0.095,
} as const;

/** Thin box from `a` to `b` (a strut), `t` thick; cut flat where it meets the ground. */
function strut(a: THREE.Vector3, b: THREE.Vector3, t: number, color: number): THREE.BufferGeometry {
  const dir = new THREE.Vector3().subVectors(b, a);
  const g = box(t, dir.length(), t, 0, 0, 0, color);
  g.applyQuaternion(
    new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()),
  );
  const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
  g.translate(mid.x, mid.y, mid.z);
  const position = g.getAttribute('position');
  for (let i = 0; i < position.count; i++) {
    if (position.getY(i) < 0) position.setY(i, 0);
  }
  return g;
}

/** Half width of the lattice tower at height y. */
const latticeHalf = (y: number) =>
  LATTICE.footHalf + (LATTICE.topHalf - LATTICE.footHalf) * (y / LATTICE.top);

function lattice(): PylonModel {
  const L = LATTICE;
  const parts: THREE.BufferGeometry[] = [];
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  // Four tapered legs.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push(
        strut(
          v(sx * L.footHalf, 0, sz * L.footHalf),
          v(sx * L.topHalf, L.top, sz * L.topHalf),
          L.leg,
          COLOR.steel,
        ),
      );
    }
  }
  // Horizontal brace rings.
  for (const y of L.braceLevels) {
    const h = latticeHalf(y);
    for (const s of [-1, 1]) {
      parts.push(box(2 * h, L.brace, L.brace, 0, y, s * h, COLOR.steelDark));
      parts.push(box(L.brace, L.brace, 2 * h, s * h, y, 0, COLOR.steelDark));
    }
  }
  // One diagonal per broad face in the lowest panel: reads as lattice.
  const [low] = L.braceLevels;
  const hl = latticeHalf(low);
  for (const s of [-1, 1]) {
    parts.push(
      strut(
        v(-s * L.footHalf, 0, s * L.footHalf),
        v(s * hl, low, s * hl),
        L.brace,
        COLOR.steelDark,
      ),
    );
  }
  // Wide lower arm with two hanging insulators.
  parts.push(box(2 * L.arm.half, L.arm.thickness, L.arm.thickness, 0, L.arm.y, 0, COLOR.steel));
  const hangTop = L.arm.y - L.arm.thickness / 2;
  const hangTip = hangTop - L.insulator.length;
  for (const s of [-1, 1]) {
    parts.push(
      box(
        L.insulator.width,
        L.insulator.length,
        L.insulator.width,
        s * L.outerX,
        hangTop - L.insulator.length / 2,
        0,
        COLOR.insulator,
      ),
    );
  }
  // Short top arm with one standing insulator in the middle.
  const topArmY = L.top - L.topArm.thickness / 2;
  parts.push(
    box(2 * L.topArm.half, L.topArm.thickness, L.topArm.thickness, 0, topArmY, 0, COLOR.steel),
  );
  const tip = L.top + L.insulator.length;
  parts.push(
    box(
      L.insulator.width,
      L.insulator.length,
      L.insulator.width,
      0,
      L.top + L.insulator.length / 2,
      0,
      COLOR.insulator,
    ),
  );
  const model = merge(parts);
  return {
    ...model,
    attachments: [
      { x: -L.outerX, y: hangTip, z: 0 },
      { x: 0, y: tip, z: 0 },
      { x: L.outerX, y: hangTip, z: 0 },
    ],
  };
}

function pole(): PylonModel {
  const P = POLE;
  const armY = P.shaft + P.arm.thickness / 2;
  const insBase = P.shaft + P.arm.thickness;
  const tip = insBase + P.insulator.length;
  const xs = [-P.outerX, 0, P.outerX];
  const model = merge([
    cone(P.rBottom, P.rTop, P.shaft, 0, P.shaft / 2, 0, COLOR.concrete, P.segments),
    box(2 * P.arm.half, P.arm.thickness, P.arm.depth, 0, armY, 0, COLOR.steelDark),
    ...xs.map((x) =>
      box(
        P.insulator.width,
        P.insulator.length,
        P.insulator.width,
        x,
        insBase + P.insulator.length / 2,
        0,
        COLOR.insulator,
      ),
    ),
  ]);
  return { ...model, attachments: xs.map((x) => ({ x, y: tip, z: 0 })) };
}

const cache = new Map<PylonKind, PylonModel>();

/** The model of a pylon kind (built once, shared). */
export function pylonModel(kind: PylonKind): PylonModel {
  let model = cache.get(kind);
  if (!model) {
    model = kind === 'lattice' ? lattice() : pole();
    cache.set(kind, model);
  }
  return model;
}
