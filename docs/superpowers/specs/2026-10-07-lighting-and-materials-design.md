# Lighting and Materials — Design

Date: 2026-10-07
Status: approved for planning
Part 1 of 5 of the visual-detail programme agreed with the user on
2026-10-07: (1) lighting and materials, (2) vehicles, (3) buildings
stage 4, (4) plants and service buildings, (5) infrastructure and
nature. The style stays detailed low-poly (Townscaper, Islanders), as
`docs/idea.md` asks; no textures.

## Goal

Every surface is a flat-coloured `MeshLambertMaterial` lit by one sun
with a fixed 2048² shadow map over ±60 tiles and a hemisphere light;
there is no post-processing and no tone mapping. Low-poly scenes get
most of their depth from contact shading — corners, joints and the
ground under objects darken — and from crisp shadows. Part 1 adds both
without touching a single mesh: a physically based material with flat
colours, ambient occlusion as a post-processing pass, neutral tone
mapping, and a shadow map that follows the visible part of the map.
Render only; sim, worker protocol and save format are untouched.

## Decisions

Made with the user during brainstorming:

- **Material plus post-processing** (rejected: material only with
  per-box gradients — too weak; adding outlines and bloom — taste
  question, extra cost, can come later).
- **Ambient occlusion on by default, with a switch in the settings**
  (rejected: off by default; adaptive switch-off by measured frame time
  — unpredictable and hard to test). The pass runs at half resolution.
- **Neutral tone mapping** (`THREE.NeutralToneMapping`), not ACES: ACES
  desaturates and shifts hues, the neutral curve keeps the tuned palette
  close to what it is today.

## Architecture

### Materials (`src/render/materials.ts`, new)

`surfaceMaterial(options: { color: number; emissive?: number;
emissiveIntensity?: number; transparent?: boolean; opacity?: number;
vertexColors?: boolean; side?: THREE.Side; flatShading?: boolean })`
returns a `THREE.MeshStandardMaterial` with `roughness:
SURFACE_ROUGHNESS` (0.9) and `metalness: 0`, passing every given option
through. The ten files that construct `MeshLambertMaterial` today
(`buildingsMesh`, `forestMesh`, `geothermalMesh`, `plantsMesh`,
`powerLinesMesh`, `railMesh`, `roadsMesh`, `terrain`, `vehiclesMesh`,
`waterMesh`) call the factory instead; their options stay as they are.
`MeshBasicMaterial` (overlays, previews, selection, hover, icons,
headlights) stays unlit and unchanged. Instanced colours
(`setColorAt`) work with the standard material as they do with Lambert.

### Lights (`src/render/scene.ts`, `src/render/renderer.ts`)

`webgl.toneMapping = THREE.NeutralToneMapping`,
`toneMappingExposure` tuned on the Mac. Sun and hemisphere intensities
and the day/dusk/night colour curve in `renderer.ts`
(`sun.intensity = (0.15 + 1.6 * sunFactor) * cloudDimming`,
`ambient.intensity = 0.35 + 0.65 * sunFactor`) get new constants in
`scene.ts` so the standard material and the tone curve reproduce
today's brightness; the values are found in the Mac tuning round and
recorded there. All new numbers are named constants.

### Post-processing (`src/render/postprocessing.ts`, new)

A `PostChain` class owns an `EffectComposer` (three/addons) built on a
`WebGLRenderTarget` with `samples: 4` (multisampling replaces the
`antialias` flag, which a composer's render targets do not inherit):

1. `RenderPass(scene, camera)`
2. `GTAOPass(scene, camera, width / 2, height / 2)` — ambient
   occlusion at half resolution; radius, distance falloff and
   intensity are named constants tuned on the Mac. Disabled (not
   removed) when the setting is off.
3. `OutputPass()` — tone mapping and sRGB conversion.

API: `constructor(webgl, scene, camera)`, `setSize(width, height,
pixelRatio)`, `setAmbientOcclusion(enabled)`, `render()`,
`dispose()`. `Renderer` calls `postChain.render()` where it calls
`webgl.render(scene, camera)` today, forwards resize, and disposes it.
The rotation of the isometric camera replaces `camera` in place, so the
passes keep their reference.

### Shadow frustum (`src/render/shadowFrustum.ts`, new)

Pure function `fitShadowFrustum(input: { viewCorners: Vec3[]; sunDirection:
Vec3; mapSize: number; margin: number }): { center: Vec3; halfWidth:
number; halfHeight: number; near: number; far: number }`: projects the
eight corners of the camera's visible ground box (the orthographic
frustum clipped to the terrain height range) into sun space, takes the
bounding rectangle plus `margin` tiles (objects just outside the view
still cast shadows into it), and snaps the centre to whole shadow
texels so panning does not make edges crawl. `Renderer` calls it each
frame the camera or the sun changed and applies the result to
`sun.shadow.camera` and `sun.target`. Shadow map size stays 2048².
A minimum half-extent keeps extreme zoom-in from degenerating.

### Setting (`src/ui/settings.ts`, `SettingsPage.tsx`, `App.tsx`, `i18n.tsx`)

`Settings.ambientOcclusion: boolean`, default `true`, parsed like
`shadows` (absent in stored settings → default). `App.tsx` forwards it
with `rendererRef.current?.setAmbientOcclusion(settings.ambientOcclusion)`
next to `setShadows`. Strings: `settings.ambientOcclusion` — EN
"Ambient occlusion", DE "Umgebungsverdeckung"; a hint
`settings.ambientOcclusion.hint` — EN "Soft shading in corners and
under objects. Turn off if the game stutters.", DE "Weiche Schatten
in Ecken und unter Objekten. Ausschalten, wenn das Spiel ruckelt."

## Testing

Headless unit tests (no WebGL in the sandbox or in vitest):

- `materials.test.ts`: the factory returns a `MeshStandardMaterial`
  with roughness `SURFACE_ROUGHNESS`, metalness 0, and passes colour,
  emissive, transparency and vertex colours through; no file under
  `src/render` constructs `MeshLambertMaterial` any more (a source grep
  in the test, like the repo's other guard tests).
- `shadowFrustum.test.ts`: a view box straight under the sun gives a
  rectangle that contains every corner plus the margin; moving the view
  by less than one texel leaves the centre unchanged, by one texel moves
  it by exactly one texel; zooming in shrinks the extent down to the
  minimum and not below; the result is finite for every sun direction
  above the horizon.
- `settings.test.ts`: `ambientOcclusion` defaults to `true` and survives
  a round-trip; an old stored settings object without it loads with the
  default.
- `postprocessing.ts` needs a WebGL context; it is covered by the
  existing WebGL e2e test (Mac and CI with SwiftShader): the game boots,
  draws, and toggling the setting does not throw.

Acceptance on the Mac (the user): screenshots before and after at noon,
dusk and night on the same save, ambient occlusion on and off; frame
time with the overlay off at 64×64 and 96×96, AO on and off, recorded
in this spec. Target: the 96×96 frame time with AO on stays under
16.7 ms on the user's Mac; if not, the AO resolution drops to a third
before anything else is cut.

## Out of scope

Outlines, bloom and glow, textures and normal maps, new or changed
geometry (parts 2–5), shadow cascades, per-material roughness
variation, any sim, worker-protocol, save or agent change.
