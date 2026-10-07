import * as THREE from 'three';

/**
 * Roughness of every lit surface: high enough that the flat low-poly
 * colours read as matte paint, not plastic. Shared so a later tuning
 * round changes one number.
 */
export const SURFACE_ROUGHNESS = 0.9;

export type SurfaceOptions = Omit<THREE.MeshStandardMaterialParameters, 'roughness' | 'metalness'>;

/**
 * The one material for lit, opaque-or-tinted surfaces: a physically
 * based standard material with flat colour, high roughness and no
 * metal. It replaces the Lambert shading so every lit surface responds
 * to the ambient-occlusion pass consistently. Unlit helpers
 * (overlays, previews, icons, headlights) keep MeshBasicMaterial.
 */
export function surfaceMaterial(options: SurfaceOptions = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    ...options,
    roughness: SURFACE_ROUGHNESS,
    metalness: 0,
  });
}
