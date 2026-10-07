import * as THREE from 'three';
import { SHADOW_MAP_SIZE } from './shadowFrustum.ts';

export interface SceneLights {
  sun: THREE.DirectionalLight;
  ambient: THREE.HemisphereLight;
}

export const PALETTE = {
  skyDay: 0xbfe0e8,
  skyNight: 0x101a2a,
  ground: 0x9fc37e,
  /** Seasonal ground tints, keyed at mid spring/summer/autumn/winter. */
  groundSpring: 0x9dd27c,
  groundSummer: 0x9fc37e,
  groundAutumn: 0xb9a96a,
  groundWinter: 0x9aa88a,
  groundSnow: 0xe9eef3,
  grid: 0x7fa863,
  road: 0x5a6068,
  roadMarking: 0xd8d8d0,
  river: 0x4d8fc4,
  lake: 0x3f7fb5,
  sea: 0x2f6ea8,
} as const;

export function createScene(): { scene: THREE.Scene; lights: SceneLights } {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PALETTE.skyDay);

  const ambient = new THREE.HemisphereLight(0xdfeef5, 0x8a9a6a, 0.9);
  scene.add(ambient);

  const sun = new THREE.DirectionalLight(0xfff2dd, 1.6);
  sun.position.set(40, 80, 20);
  sun.castShadow = true;
  // Frustum is set per frame by fitShadowToView() to follow the camera.
  sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
  sun.shadow.bias = -0.0005;
  scene.add(sun);
  scene.add(sun.target);

  return { scene, lights: { sun, ambient } };
}
