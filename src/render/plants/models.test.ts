import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { PlantType } from '../../shared/types.ts';
import { MAX_PARTS_PER_PLANT_MODEL, plantHeight, plantModel, turnToward } from './models.ts';

const HEIGHT: Record<number, number> = {
  [PlantType.SolarFarm]: 0.16,
  [PlantType.WindTurbine]: 1.27,
  [PlantType.Battery]: 0.56,
  [PlantType.BiogasPlant]: 0.345,
  [PlantType.ChargingHub]: 0.5,
  [PlantType.Park]: 0.52,
  [PlantType.RunOfRiver]: 0.34,
  [PlantType.PumpedStorage]: 0.5,
  [PlantType.FireStation]: 0.66,
  [PlantType.PoliceStation]: 0.53,
  [PlantType.LogisticsDepot]: 0.34,
  [PlantType.BusDepot]: 0.36,
  [PlantType.HydrogenPlant]: 0.56,
  [PlantType.TidalPlant]: 0.62,
  [PlantType.GeothermalPlant]: 0.5,
  [PlantType.HeatPlant]: 0.62,
  [PlantType.HeatStore]: 0.51,
  [PlantType.Substation]: 0.47,
  [PlantType.TrainStation]: 0.42,
  [PlantType.FreightTerminal]: 0.61,
  [PlantType.RailYard]: 0.4,
};
const ENERGY = [
  PlantType.SolarFarm,
  PlantType.WindTurbine,
  PlantType.Battery,
  PlantType.BiogasPlant,
  PlantType.RunOfRiver,
  PlantType.PumpedStorage,
  PlantType.HydrogenPlant,
  PlantType.TidalPlant,
  PlantType.GeothermalPlant,
  PlantType.HeatPlant,
  PlantType.HeatStore,
];
const TYPES = ENERGY; // Task 3: all 21 types
const STAFFED = [PlantType.HydrogenPlant, PlantType.GeothermalPlant, PlantType.HeatPlant]; // Task 3 adds the services
const AVIATION = [PlantType.WindTurbine, PlantType.HeatStore];

function distinctColours(g: THREE.BufferGeometry): number {
  const c = g.getAttribute('color');
  const seen = new Set<string>();
  for (let i = 0; i < c.count; i++)
    seen.add(`${c.getX(i).toFixed(3)},${c.getY(i).toFixed(3)},${c.getZ(i).toFixed(3)}`);
  return seen.size;
}

describe('plant models', () => {
  it.each(TYPES)('type %i: vertex-coloured, within the part budget and the tile', (type) => {
    const m = plantModel(type);
    expect(m.parts).toBeLessThanOrEqual(MAX_PARTS_PER_PLANT_MODEL);
    if (m.geometry) {
      expect(m.geometry.getAttribute('color').count).toBe(
        m.geometry.getAttribute('position').count,
      );
      m.geometry.computeBoundingBox();
      const b = m.geometry.boundingBox!;
      for (const v of [b.min.x, b.max.x, b.min.z, b.max.z])
        expect(Math.abs(v)).toBeLessThanOrEqual(0.5 + 1e-6);
      expect(b.min.y).toBeGreaterThanOrEqual(-1e-6);
      expect(distinctColours(m.geometry)).toBeGreaterThanOrEqual(3);
    }
    if (m.plinth) {
      expect(m.plinth.sx).toBeLessThanOrEqual(1);
      expect(m.plinth.sz).toBeLessThanOrEqual(1);
    }
  });
  it.each(TYPES)('type %i: as tall as before (±0.05)', (type) => {
    expect(Math.abs(plantHeight(type) - HEIGHT[type])).toBeLessThanOrEqual(0.05);
  });
  it.each(TYPES)('type %i: window anchors sit on a wall and face out of it', (type) => {
    const m = plantModel(type);
    for (const w of m.windows) {
      expect(Math.abs(w.x)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(w.z)).toBeLessThanOrEqual(0.5);
      // A ray from just in front of the glass centre back into the wall hits the model within 0.01.
      const yaw = (w.face * Math.PI) / 2;
      const normal = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
      const origin = new THREE.Vector3(w.x, w.y + w.h / 2, w.z).addScaledVector(normal, 0.05);
      const ray = new THREE.Raycaster(origin, normal.clone().negate(), 0, 0.06);
      const mesh = new THREE.Mesh(
        m.geometry!,
        new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
      );
      const hit = ray.intersectObject(mesh)[0];
      expect(hit, `window at ${w.x},${w.y},${w.z} face ${w.face}`).toBeDefined();
      expect(hit.distance).toBeGreaterThan(0.04);
    }
  });
  it.each(STAFFED)('type %i: staffed buildings have at least two windows', (type) => {
    expect(plantModel(type).windows.length).toBeGreaterThanOrEqual(2);
  });
  it.each(AVIATION)('type %i: carries an aviation lamp at its top', (type) => {
    const lamps = plantModel(type).lamps.filter((l) => l.kind === 'aviation');
    expect(lamps.length).toBeGreaterThanOrEqual(1);
    const g = plantModel(type).geometry!;
    g.computeBoundingBox();
    // On the structure's top (for the turbine: the nacelle, below the rotor tip).
    for (const l of lamps) expect(l.y).toBeGreaterThanOrEqual(g.boundingBox!.max.y - 0.1);
  });
  it('wind turbine: rotor hub on the nacelle front, rotor tip sets the height', () => {
    const m = plantModel(PlantType.WindTurbine);
    expect(m.rotorHub).toBeDefined();
    expect(m.rotorHub!.y).toBeCloseTo(0.85, 2);
  });
  it('battery: a state-of-charge bar anchor on the cabinet front', () => {
    const fill = plantModel(PlantType.Battery).socFill!;
    expect(fill).toBeDefined();
    expect(fill.y + 0.04 + fill.maxH).toBeLessThanOrEqual(plantHeight(PlantType.Battery));
  });
  it('turnToward points model +z at the given neighbour', () => {
    expect(turnToward(0, 1)).toBeCloseTo(0);
    expect(turnToward(1, 0)).toBeCloseTo(Math.PI / 2);
    expect(Math.abs(turnToward(0, -1))).toBeCloseTo(Math.PI);
    expect(turnToward(-1, 0)).toBeCloseTo(-Math.PI / 2);
    expect(turnToward(0, 0)).toBe(0);
    const v = new THREE.Vector3(0, 0, 1).applyAxisAngle(
      new THREE.Vector3(0, 1, 0),
      turnToward(1, 0),
    );
    expect(v.x).toBeCloseTo(1);
  });
  it('caches one model per type', () => {
    expect(plantModel(PlantType.Battery)).toBe(plantModel(PlantType.Battery));
  });
});
