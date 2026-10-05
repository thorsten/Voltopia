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
 * brick, cool grey and glass, rose and apricot, corrugated grey with
 * rust and safety yellow) so zones still read at a glance with several
 * hues each.
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
  [Zone.Industrial]: {
    walls: colors(0x9aa0a6, 0xb5b0a3, 0x8c8f93, 0xa7a295),
    roofs: colors(0x5b5f66, 0x8a4b3a, 0x6f7378),
    trims: colors(0xe0b030, 0x3f4650),
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

/** Visual age of a building (TileDiff.ageStage). */
export const AgeStage = { New: 0, LivedIn: 1, Weathered: 2 } as const;
export type AgeStage = (typeof AgeStage)[keyof typeof AgeStage];

/** How far toward its own grey a lived-in / weathered surface fades. */
const LIVED_IN_DESATURATE = 0.12;
const WEATHERED_DESATURATE = 0.3;
/** Lightness multipliers per stage. */
const LIVED_IN_DARKEN = 0.96;
const WEATHERED_DARKEN = 0.9;
/** Muted slate-green that weathered pitched roofs lean toward. */
const ROOF_PATINA = new THREE.Color(0x6f7a74);
const WEATHERED_PATINA_BLEND = 0.3;

const grey = new THREE.Color();

/** Blend `out` toward its own luminance grey by `amount` (hue is kept). */
function desaturate(out: THREE.Color, amount: number): void {
  const luminance = 0.299 * out.r + 0.587 * out.g + 0.114 * out.b;
  out.lerp(grey.setRGB(luminance, luminance, luminance), amount);
}

/**
 * Colour-only ageing. New copies the colour; lived-in dulls and darkens
 * a little; weathered more so, and a pitched roof additionally takes on
 * a patina. Accents never go through this. Writes into `out`.
 */
export function applyAgeTint(
  color: THREE.Color,
  stage: number,
  roof: boolean,
  out: THREE.Color,
): THREE.Color {
  out.copy(color);
  if (stage <= AgeStage.New) return out;
  if (stage === AgeStage.LivedIn) {
    desaturate(out, LIVED_IN_DESATURATE);
    return out.multiplyScalar(LIVED_IN_DARKEN);
  }
  desaturate(out, WEATHERED_DESATURATE);
  out.multiplyScalar(WEATHERED_DARKEN);
  if (roof) out.lerp(ROOF_PATINA, WEATHERED_PATINA_BLEND);
  return out;
}
