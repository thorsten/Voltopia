import type * as THREE from 'three';

/**
 * Roughness of the water: low enough that the sun's specular highlight
 * shows and moves with the ripples (at the shared SURFACE_ROUGHNESS the
 * highlights would smear into nothing).
 */
export const WATER_ROUGHNESS = 0.35;
/** Angular frequency of the base wave, in radians per tile. */
const RIPPLE_SCALE = 4.0;
/** Phase speed of the base wave, in radians per second. */
const RIPPLE_SPEED = 1.2;
/** Scale of the summed wave slopes: small, so the water tilts only a few degrees. */
const RIPPLE_STRENGTH = 0.12;

/** Uniforms the water mesh advances every frame. */
export interface RippleUniforms {
  time: { value: number };
}

/** A GLSL float literal (`4` would be an int and break the arithmetic). */
function glslFloat(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}

const VERTEX_DECLARATIONS = /* glsl */ `
varying vec3 vRippleWorld;
`;

const VERTEX_POSITION = /* glsl */ `
vec4 rippleWorld = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
  rippleWorld = instanceMatrix * rippleWorld;
#endif
vRippleWorld = (modelMatrix * rippleWorld).xyz;
`;

/**
 * Three sine waves with unit directions spread around the compass, so
 * no grid pattern shows; higher waves are shorter, faster and weaker.
 */
const FRAGMENT_DECLARATIONS = /* glsl */ `
uniform float rippleTime;
varying vec3 vRippleWorld;
const float RIPPLE_SCALE = ${glslFloat(RIPPLE_SCALE)};
const float RIPPLE_SPEED = ${glslFloat(RIPPLE_SPEED)};
const float RIPPLE_STRENGTH = ${glslFloat(RIPPLE_STRENGTH)};
const vec2 RIPPLE_DIR_A = vec2(0.8, 0.6);
const vec2 RIPPLE_DIR_B = vec2(-0.385, 0.923);
const vec2 RIPPLE_DIR_C = vec2(-0.471, -0.882);
const vec3 RIPPLE_FREQUENCY = vec3(1.0, 1.7, 2.6);
const vec3 RIPPLE_WEIGHT = vec3(1.0, 0.6, 0.35);

// Slope (d/dx, d/dz) of one wave weight * sin(phase), per unit of its amplitude.
vec2 rippleSlope(vec2 p, vec2 dir, float frequency, float weight) {
  float phase = (dot(dir, p) * RIPPLE_SCALE + rippleTime * RIPPLE_SPEED) * frequency;
  return dir * (weight * cos(phase));
}
`;

const FRAGMENT_NORMAL = /* glsl */ `
vec2 rippleSum = rippleSlope(vRippleWorld.xz, RIPPLE_DIR_A, RIPPLE_FREQUENCY.x, RIPPLE_WEIGHT.x)
  + rippleSlope(vRippleWorld.xz, RIPPLE_DIR_B, RIPPLE_FREQUENCY.y, RIPPLE_WEIGHT.y)
  + rippleSlope(vRippleWorld.xz, RIPPLE_DIR_C, RIPPLE_FREQUENCY.z, RIPPLE_WEIGHT.z);
vec2 rippleGrad = rippleSum * RIPPLE_STRENGTH;
vec3 rippleN = normalize(vec3(-rippleGrad.x, 1.0, -rippleGrad.y));
vec3 rippleView = normalize((viewMatrix * vec4(rippleN, 0.0)).xyz);
// Only the water's top faces ripple; the slab sides keep their normal.
vec3 rippleUp = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
float rippleTop = step(0.5, dot(normal, rippleUp));
normal = normalize(mix(normal, rippleView, rippleTop));
`;

/**
 * Patches the water material in place: a world-space position varying
 * and a fragment-shader normal perturbation from summed sine waves, so
 * specular highlights move across lake, river and sea. The geometry
 * stays flat — it has only a few vertices per tile, so a real heave
 * would rock whole tiles. Sets roughness to WATER_ROUGHNESS.
 */
export function applyRipples(material: THREE.MeshStandardMaterial): RippleUniforms {
  const uniforms: RippleUniforms = { time: { value: 0 } };
  material.roughness = WATER_ROUGHNESS;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.rippleTime = uniforms.time;
    shader.vertexShader =
      VERTEX_DECLARATIONS +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\n${VERTEX_POSITION}`,
      );
    shader.fragmentShader =
      FRAGMENT_DECLARATIONS +
      shader.fragmentShader.replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>\n${FRAGMENT_NORMAL}`,
      );
  };
  // The patched program must not be shared with plain surface materials.
  material.customProgramCacheKey = () => 'voltopia-water-ripples';
  return uniforms;
}
