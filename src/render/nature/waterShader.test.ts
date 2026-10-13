import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applyRipples, WATER_ROUGHNESS } from './waterShader.ts';

/** The slice of three's WebGLProgramParametersWithUniforms the patch touches. */
interface StubShader {
  uniforms: Record<string, { value: unknown }>;
  vertexShader: string;
  fragmentShader: string;
}

function stubShader(): StubShader {
  return {
    uniforms: {},
    vertexShader: '#include <begin_vertex>',
    fragmentShader: '#include <normal_fragment_begin>',
  };
}

describe('applyRipples', () => {
  it('sets the compile hook, a cache key and the water roughness', () => {
    const material = new THREE.MeshStandardMaterial();
    const defaultHook = material.onBeforeCompile;
    applyRipples(material);
    expect(material.onBeforeCompile).not.toBe(defaultHook);
    expect(material.customProgramCacheKey()).toBe('voltopia-water-ripples');
    expect(material.roughness).toBe(WATER_ROUGHNESS);
  });

  it('patches both shaders around the original includes', () => {
    const material = new THREE.MeshStandardMaterial();
    const uniforms = applyRipples(material);
    const shader = stubShader();
    material.onBeforeCompile(shader as never, undefined as never);

    expect(shader.vertexShader).toContain('#include <begin_vertex>');
    expect(shader.fragmentShader).toContain('#include <normal_fragment_begin>');
    expect(shader.vertexShader).toContain('vRippleWorld');
    expect(shader.fragmentShader).toContain('vRippleWorld');
    expect(shader.fragmentShader).toContain('uniform float rippleTime');
    // The ripple normal replaces the face normal after it is set up.
    expect(shader.fragmentShader.indexOf('rippleView')).toBeGreaterThan(
      shader.fragmentShader.indexOf('#include <normal_fragment_begin>'),
    );
    expect(shader.uniforms.rippleTime).toBe(uniforms.time);
  });
});
