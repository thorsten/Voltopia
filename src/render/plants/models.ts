/**
 * Detailed plant and service building models.
 *
 * Conventions:
 * - Units are tiles; origin at the tile centre; base at y = 0; every vertex
 *   within |x|, |z| ≤ 0.5.
 * - Where a site matters the model is drawn with the water/track side at
 *   +z (`plantsMesh` turns it): run-of-river drawn with the river flowing
 *   along z (weir spanning x); pumped storage with the lake at +z; train
 *   station, freight terminal and rail yard with the track at +z.
 * - Windows: `y` is the glass bottom, `(x, z)` on the wall surface (the
 *   frame mesh adds its own proud offset), `face` the wall's outward
 *   normal. Size `w × h` matches the zone buildings (`WINDOW_WIDTH ×
 *   WINDOW_HEIGHT` from `buildings/windowLayout.ts`) unless a model has a
 *   reason (e.g. a tall station window).
 */
import type * as THREE from 'three';
import { PlantType } from '../../shared/types.ts';
import { energyModels } from './energyModels.ts';
import { serviceModels } from './serviceModels.ts';

export const MAX_PARTS_PER_PLANT_MODEL = 24;
/** Blade length of the wind turbine rotor, measured from the hub outward. */
export const ROTOR_RADIUS = 0.42;
/** Tree prop height at scale 1. */
export const TREE_HEIGHT = 0.26;
export const BENCH_HEIGHT = 0.04;

/** Model face direction as quarter turns: 0 = +z, 1 = +x, 2 = −z, 3 = −x (yaw = face · π/2). */
export type Face = 0 | 1 | 2 | 3;

/** Glass bottom-centre on the wall surface. */
export interface WindowAnchor {
  x: number;
  y: number;
  z: number;
  face: Face;
  w: number;
  h: number;
}

export interface LampAnchor {
  x: number;
  y: number;
  z: number;
  kind: 'aviation' | 'yard';
}

export interface GroundProp {
  kind: 'tree' | 'bench';
  x: number;
  z: number;
  scale: number;
  turn: number;
}

export interface PlantModel {
  /** Merged vertex-coloured geometry, base at y = 0, origin at the tile centre; null when the type draws only ground props (park). */
  geometry: THREE.BufferGeometry | null;
  parts: number;
  /** Plinth under the model (absent for the park). */
  plinth?: { sx: number; sz: number; color: number };
  windows: WindowAnchor[];
  lamps: LampAnchor[];
  /** Wind turbine: where the rotor spins. */
  rotorHub?: { x: number; y: number; z: number };
  /** Battery: state-of-charge bar base; the bar grows by maxH × soc. */
  socFill?: { x: number; y: number; z: number; w: number; d: number; maxH: number };
  /** Park: trees and benches. */
  groundProps?: GroundProp[];
}

const builders: Partial<Record<PlantType, () => PlantModel>> = {
  ...energyModels,
  ...serviceModels,
};
const cache = new Map<PlantType, PlantModel>();

/** The model of a plant type, built once and cached. */
export function plantModel(type: PlantType): PlantModel {
  const cached = cache.get(type);
  if (cached) return cached;
  const build = builders[type];
  if (!build) throw new Error(`plant model missing for type ${type}`);
  const model = build();
  cache.set(type, model);
  return model;
}

/** How high a plant rises: geometry top, rotor tip, or tallest ground prop. */
export function plantHeight(type: PlantType): number {
  const m = plantModel(type);
  let top = 0;
  if (m.geometry) {
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    top = m.geometry.boundingBox!.max.y;
  }
  if (m.rotorHub) top = Math.max(top, m.rotorHub.y + ROTOR_RADIUS);
  for (const p of m.groundProps ?? []) top = Math.max(top, p.scale * TREE_HEIGHT);
  return top;
}

/** Yaw that turns model +z toward (dx, dz); (0, 0) leaves it as drawn. */
export function turnToward(dx: number, dz: number): number {
  return dx === 0 && dz === 0 ? 0 : Math.atan2(dx, dz);
}
