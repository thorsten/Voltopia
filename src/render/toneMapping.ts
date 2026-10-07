import * as THREE from 'three';

/*
 * CPU copy of three's NeutralToneMapping (Khronos PBR Neutral), as in
 * three r186 `tonemapping_pars_fragment.glsl.js`. The OutputPass applies
 * it to the whole frame, including the `scene.background` clear colour,
 * so the sky colour is pre-inverted here to keep its on-screen value.
 */
const START_COMPRESSION = 0.8 - 0.04;
const DESATURATION = 0.15;
/** Below this minimum channel the curve's toe is quadratic, above it a flat 0.04 offset. */
const TOE_END = 0.08;
const TOE_CURVATURE = 6.25;
const TOE_OFFSET = 0.04;
/** Fixed-point steps of the inverse: well past convergence for in-gamut colours (see the tests). */
const INVERSE_ITERATIONS = 48;

/** Linear colour → tone-mapped linear colour, exactly as the shader does. */
export function neutralToneMap(
  color: THREE.Color,
  exposure: number,
  target = new THREE.Color(),
): THREE.Color {
  let r = color.r * exposure;
  let g = color.g * exposure;
  let b = color.b * exposure;
  const x = Math.min(r, g, b);
  const offset = x < TOE_END ? x - TOE_CURVATURE * x * x : TOE_OFFSET;
  r -= offset;
  g -= offset;
  b -= offset;
  const peak = Math.max(r, g, b);
  if (peak < START_COMPRESSION) return target.setRGB(r, g, b, THREE.LinearSRGBColorSpace);
  const d = 1 - START_COMPRESSION;
  const newPeak = 1 - (d * d) / (peak + d - START_COMPRESSION);
  const scale = newPeak / peak;
  const mix = 1 - 1 / (DESATURATION * (peak - newPeak) + 1);
  return target.setRGB(
    r * scale * (1 - mix) + newPeak * mix,
    g * scale * (1 - mix) + newPeak * mix,
    b * scale * (1 - mix) + newPeak * mix,
    THREE.LinearSRGBColorSpace,
  );
}

const mapped = new THREE.Color();

/**
 * The linear colour that NeutralToneMapping at `exposure` maps onto
 * `color`, found by fixed-point iteration (the curve is close to the
 * identity, so each step moves by the remaining error). Colours the curve
 * cannot reach (a channel at or above 1) come back as close as possible.
 */
export function inverseNeutralToneMap(
  color: THREE.Color,
  exposure: number,
  target = new THREE.Color(),
): THREE.Color {
  const { r, g, b } = color;
  target.setRGB(r, g, b, THREE.LinearSRGBColorSpace);
  for (let i = 0; i < INVERSE_ITERATIONS; i++) {
    neutralToneMap(target, exposure, mapped);
    target.setRGB(
      Math.max(0, target.r + (r - mapped.r) / exposure),
      Math.max(0, target.g + (g - mapped.g) / exposure),
      Math.max(0, target.b + (b - mapped.b) / exposure),
      THREE.LinearSRGBColorSpace,
    );
  }
  return target;
}
