import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { PlantType } from '../../shared/types.ts';
import { plantModel } from './models.ts';
import { AVIATION_BLINK_HZ, GLOW_PROUD, PlantLights } from './lights.ts';

const ALL_TYPES = Object.values(PlantType).filter(
  (v): v is PlantType => typeof v === 'number' && v !== PlantType.None,
);
const WITH_WINDOWS = ALL_TYPES.filter((t) => plantModel(t).windows.length > 0);
const WITH_AVIATION = ALL_TYPES.filter((t) =>
  plantModel(t).lamps.some((l) => l.kind === 'aviation'),
);
const WITH_YARD = ALL_TYPES.filter((t) => plantModel(t).lamps.some((l) => l.kind === 'yard'));

function placedOf(types: PlantType[], yaw = 0) {
  return types.map((type, i) => ({ index: i, type, x: i + 0.5, y: 0.2, z: 3.5, yaw }));
}

const material = (mesh: THREE.InstancedMesh) => mesh.material as THREE.MeshBasicMaterial;

describe('PlantLights', () => {
  it('has types with windows, aviation lamps and yard lamps to test against', () => {
    expect(WITH_WINDOWS.length).toBeGreaterThan(1);
    expect(WITH_AVIATION.length).toBeGreaterThan(0);
    expect(WITH_YARD.length).toBeGreaterThan(0);
  });

  it('frames every window, glows only on powered plants', () => {
    const lights = new PlantLights(new THREE.Scene());
    const placed = placedOf(WITH_WINDOWS);
    const unpowered = placed[0].index;
    lights.rebuild(placed, (index) => index !== unpowered);
    const all = WITH_WINDOWS.reduce<number>((n, t) => n + plantModel(t).windows.length, 0);
    const dark = plantModel(WITH_WINDOWS[0]).windows.length;
    expect(lights.frames.mesh.count).toBe(all);
    expect(lights.glow.mesh.count).toBe(all - dark);
  });

  it('lights lamps only on powered plants', () => {
    const lights = new PlantLights(new THREE.Scene());
    const placed = placedOf([...WITH_AVIATION, ...WITH_YARD]);
    lights.rebuild(placed, () => true);
    const count = (kind: 'aviation' | 'yard') =>
      placed.reduce(
        (n, p) => n + plantModel(p.type).lamps.filter((l) => l.kind === kind).length,
        0,
      );
    expect(lights.aviation.mesh.count).toBe(count('aviation'));
    expect(lights.yard.mesh.count).toBe(count('yard'));
    lights.rebuild(placed, () => false);
    expect(lights.aviation.mesh.count).toBe(0);
    expect(lights.yard.mesh.count).toBe(0);
  });

  it('turns a frame and its glow with the plant', () => {
    const lights = new PlantLights(new THREE.Scene());
    const type = WITH_WINDOWS[0];
    const win = plantModel(type).windows[0];
    const yaw = Math.PI / 2;
    const [p] = placedOf([type], yaw);
    lights.rebuild([p], () => true);
    const faceYaw = yaw + (win.face * Math.PI) / 2;
    const normal = new THREE.Vector3(Math.sin(faceYaw), 0, Math.cos(faceYaw));

    const m = new THREE.Matrix4();
    lights.frames.mesh.getMatrixAt(0, m);
    const n = new THREE.Vector3(0, 0, 1).transformDirection(m);
    expect(n.distanceTo(normal)).toBeLessThan(1e-6);
    const anchor = new THREE.Vector3(win.x, win.y, win.z)
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
      .add(new THREE.Vector3(p.x, p.y, p.z));
    const pos = new THREE.Vector3().setFromMatrixPosition(m);
    expect(pos.distanceTo(anchor)).toBeLessThan(1e-6);
    const scale = new THREE.Vector3().setFromMatrixScale(m);
    expect(scale.x).toBeCloseTo(win.w, 6);
    expect(scale.y).toBeCloseTo(win.h, 6);

    lights.glow.mesh.getMatrixAt(0, m);
    const glowPos = new THREE.Vector3().setFromMatrixPosition(m);
    expect(glowPos.distanceTo(anchor.clone().addScaledVector(normal, GLOW_PROUD))).toBeLessThan(
      1e-6,
    );
  });

  it('shows frames always, glow and lamps only at night', () => {
    const lights = new PlantLights(new THREE.Scene());
    lights.rebuild(placedOf([...WITH_WINDOWS, ...WITH_AVIATION, ...WITH_YARD]), () => true);
    lights.setNight(0);
    expect(lights.frames.mesh.visible).toBe(true);
    expect(lights.glow.mesh.visible).toBe(false);
    expect(lights.yard.mesh.visible).toBe(false);
    expect(lights.aviation.mesh.visible).toBe(false);
    lights.setNight(1);
    expect(lights.frames.mesh.visible).toBe(true);
    expect(lights.glow.mesh.visible).toBe(true);
    expect(lights.yard.mesh.visible).toBe(true);
    expect(lights.aviation.mesh.visible).toBe(true);
    expect(material(lights.glow.mesh).opacity).toBe(1);
  });

  it('keeps the night state on meshes replaced by growth', () => {
    const lights = new PlantLights(new THREE.Scene());
    lights.setNight(1);
    const many = Array.from({ length: 40 }, () => WITH_WINDOWS[0]);
    lights.rebuild(placedOf(many), () => true);
    expect(lights.glow.mesh.visible).toBe(true);
  });

  it('blinks every aviation lamp in sync', () => {
    const lights = new PlantLights(new THREE.Scene());
    lights.rebuild(placedOf([...WITH_AVIATION, ...WITH_AVIATION]), () => true);
    expect(lights.aviation.mesh.count).toBeGreaterThan(1);
    lights.setNight(1);
    lights.update(0.5); // phase 0.25
    expect(material(lights.aviation.mesh).opacity).toBe(1);
    expect(lights.aviation.mesh.visible).toBe(true);
    lights.update(1.0); // phase 0.75
    expect(material(lights.aviation.mesh).opacity).toBe(0);
    expect(lights.aviation.mesh.visible).toBe(false);
    // One full period later the lamps are back on.
    lights.update(1 / AVIATION_BLINK_HZ / 2);
    expect(material(lights.aviation.mesh).opacity).toBe(1);
  });

  it('casts no shadows from any light mesh; frames receive them', () => {
    const lights = new PlantLights(new THREE.Scene());
    for (const g of [lights.frames, lights.glow, lights.aviation, lights.yard]) {
      expect(g.mesh.castShadow).toBe(false);
      expect(g.mesh.frustumCulled).toBe(false);
    }
    expect(lights.frames.mesh.receiveShadow).toBe(true);
  });
});
