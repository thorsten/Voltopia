import * as THREE from 'three';
import { SupplyStatus, Zone } from '../../shared/types.ts';

export interface ZoneFamily {
  walls: readonly THREE.Color[];
  roofs: readonly THREE.Color[];
  trims: readonly THREE.Color[];
}

const colors = (...hex: number[]): readonly THREE.Color[] => hex.map((h) => new THREE.Color(h));

/**
 * Per-zone colour families. Each zone keeps its identity (warm cream and
 * brick, cool grey and glass, rose and apricot) so zones still read at a
 * glance with several hues each.
 */
export const ZONE_FAMILIES: Record<number, ZoneFamily> = {
  [Zone.Residential]: {
    walls: colors(0xf1e6cf, 0xe3cfa6, 0xe8c3a6, 0xf6f2ea),
    roofs: colors(0xb85c45, 0x6b7280, 0x7d5a44),
    trims: colors(0xfbf8f1, 0x3d6b4f),
  },
  [Zone.Commercial]: {
    walls: colors(0xaab4bf, 0x8fa3b8, 0x7fb3b8, 0xb9b3a9),
    roofs: colors(0x4f565e, 0x2e3238, 0x7c8792),
    trims: colors(0xf2f4f6, 0x33383f),
  },
  [Zone.Retail]: {
    walls: colors(0xd9a39b, 0xe9b98f, 0xe9d99a, 0xd6b39c),
    roofs: colors(0x8f3b3b, 0x7a7f4a, 0x6f7378),
    trims: colors(0xc9453f, 0x3f8f8a),
  },
};

/** Shared accents; these are never supply-tinted. */
export const ACCENT = {
  door: new THREE.Color(0x4a3426),
  rooftopPv: new THREE.Color(0x2b3d66),
  waterTank: new THREE.Color(0xc8ccd0),
  chimney: new THREE.Color(0x9a4f3b),
  acUnit: new THREE.Color(0xf0f2f4),
  antenna: new THREE.Color(0x4b4f55),
} as const;

const SUPPLY_GREY = new THREE.Color(0x8a8a8a);
const UNDERSUPPLIED_BLEND = 0.35;
const NOT_CONNECTED_BLEND = 0.6;
const NOT_CONNECTED_DARKEN = 0.9;

/**
 * Gentle body tint for the supply status — the Supply overlay stays the
 * diagnostic tool, the building only hints. Writes into `out`.
 */
export function applySupplyTint(
  color: THREE.Color,
  status: SupplyStatus,
  out: THREE.Color,
): THREE.Color {
  out.copy(color);
  if (status === SupplyStatus.Undersupplied) {
    out.lerp(SUPPLY_GREY, UNDERSUPPLIED_BLEND);
  } else if (status === SupplyStatus.NotConnected) {
    out.lerp(SUPPLY_GREY, NOT_CONNECTED_BLEND).multiplyScalar(NOT_CONNECTED_DARKEN);
  }
  return out;
}
