import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';

/** Ambient occlusion renders at this share of the drawing buffer, then blends at full size. */
export const AO_RESOLUTION_SCALE = 0.5;
/** Multisampling of the composer's target: replaces the WebGLRenderer antialias flag. */
const MSAA_SAMPLES = 4;
/** GTAO tuning (world units are tiles): starting values, tuned on the Mac. */
const AO_RADIUS = 0.6;
const AO_DISTANCE_EXPONENT = 1;
const AO_THICKNESS = 0.6;
const AO_SCALE = 1;
const AO_SAMPLES = 16;
const AO_BLEND_INTENSITY = 1;

/**
 * Whether a scene object should darken its surroundings: a mesh with at
 * least one lit (non-basic), opaque material. Overlays, previews, the
 * selection cage, icons and headlights use MeshBasicMaterial and water
 * may be transparent — none of them should leave a shadow in the
 * ambient-occlusion pass.
 */
export function isOcclusionCaster(object: THREE.Object3D): boolean {
  const mesh = object as THREE.Mesh;
  if (!mesh.isMesh) return false;
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  return materials.some(
    (m) => m !== undefined && !(m as THREE.MeshBasicMaterial).isMeshBasicMaterial && !m.transparent,
  );
}

/** Size of the ambient-occlusion buffers for a drawing buffer of width × height. */
export function aoSize(width: number, height: number): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(width * AO_RESOLUTION_SCALE)),
    height: Math.max(1, Math.round(height * AO_RESOLUTION_SCALE)),
  };
}

/**
 * GTAOPass that (a) renders its buffers at AO_RESOLUTION_SCALE and (b)
 * hides every non-caster while it renders its normal/depth buffer, so
 * overlays, previews and other unlit or transparent surfaces do not
 * leave a shadow in the occlusion term.
 *
 * GTAOPass.render refreshes the camera projection uniforms each frame
 * (three r186), so the zoom of the isometric camera needs no extra
 * handling here.
 */
class LitOnlyGTAOPass extends GTAOPass {
  /** Reused across frames instead of allocating a new array per render call. */
  private readonly hidden: THREE.Object3D[] = [];

  override setSize(width: number, height: number): void {
    const size = aoSize(width, height);
    super.setSize(size.width, size.height);
  }

  override render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
    deltaTime: number,
    maskActive: boolean,
  ): void {
    this.scene.traverse((object) => {
      if (object.visible && (object as THREE.Mesh).isMesh && !isOcclusionCaster(object)) {
        object.visible = false;
        this.hidden.push(object);
      }
    });
    // GTAOPass's G-buffer step calls renderer.render(scene, camera) again to
    // capture normals/depth; with shadowMap.autoUpdate left on that would
    // redraw the shadow map a second time this frame (RenderPass already
    // drew it once). Suspend it for the duration of super.render().
    const autoUpdate = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    try {
      super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
    } finally {
      renderer.shadowMap.autoUpdate = autoUpdate;
      for (const object of this.hidden) object.visible = true;
      this.hidden.length = 0;
    }
  }
}

/**
 * The frame pipeline: scene into a multisampled target, ambient
 * occlusion (optional), then the sRGB conversion in the OutputPass
 * (the renderer's toneMapping is NoToneMapping, so no tone curve).
 */
export class PostChain {
  private readonly composer: EffectComposer;
  private readonly ao: LitOnlyGTAOPass;
  private readonly output: OutputPass;

  constructor(webgl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    const size = webgl.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(Math.max(1, size.x), Math.max(1, size.y), {
      type: THREE.HalfFloatType,
      samples: MSAA_SAMPLES,
    });
    this.composer = new EffectComposer(webgl, target);
    this.composer.addPass(new RenderPass(scene, camera));
    const ao = aoSize(size.x, size.y);
    this.ao = new LitOnlyGTAOPass(scene, camera, ao.width, ao.height);
    this.ao.updateGtaoMaterial({
      radius: AO_RADIUS,
      distanceExponent: AO_DISTANCE_EXPONENT,
      thickness: AO_THICKNESS,
      scale: AO_SCALE,
      samples: AO_SAMPLES,
    });
    this.ao.blendIntensity = AO_BLEND_INTENSITY;
    this.composer.addPass(this.ao);
    this.output = new OutputPass();
    this.composer.addPass(this.output);
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
  }

  setAmbientOcclusion(enabled: boolean): void {
    this.ao.enabled = enabled;
  }

  render(): void {
    this.composer.render();
  }

  dispose(): void {
    this.ao.dispose();
    this.output.dispose();
    this.composer.dispose();
  }
}
