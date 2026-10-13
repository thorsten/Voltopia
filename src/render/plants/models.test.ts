import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { PlantType } from '../../shared/types.ts';
import {
  BENCH_HEIGHT,
  MAX_PARTS_PER_PLANT_MODEL,
  TREE_HEIGHT,
  benchGeometry,
  plantHeight,
  plantModel,
  treeGeometry,
  turnToward,
} from './models.ts';

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
const TYPES = Object.values(PlantType).filter((t) => t !== PlantType.None);
const STAFFED = [
  PlantType.HydrogenPlant,
  PlantType.GeothermalPlant,
  PlantType.HeatPlant,
  PlantType.FireStation,
  PlantType.PoliceStation,
  PlantType.LogisticsDepot,
  PlantType.BusDepot,
  PlantType.TrainStation,
  PlantType.FreightTerminal,
  PlantType.RailYard,
];
const YARD = [
  PlantType.Substation,
  PlantType.TrainStation,
  PlantType.FreightTerminal,
  PlantType.RailYard,
  PlantType.LogisticsDepot,
];
const AVIATION = [PlantType.WindTurbine, PlantType.HeatStore];
/** Parts reaching below this height count as standing on the ground. */
const LOW_PART_HEIGHT = 0.12;
/** Trim at the tile edge may overhang a full plinth by this much (a 0.015 gap at most). */
const EDGE_OVERHANG = 0.03;

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
  // The model base sits PLINTH_RISE above the ground: anything near the
  // ground beyond the plinth would hover. The tidal buoy stands in the
  // sea, whose surface never drops below the model base.
  it.each(TYPES.filter((t) => t !== PlantType.TidalPlant))(
    'type %i: low parts stand on the plinth',
    (type) => {
      const m = plantModel(type);
      if (!m.geometry || !m.plinth) return;
      const pos = m.geometry.getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        if (pos.getY(i) > LOW_PART_HEIGHT) continue;
        const overhang = Math.max(
          Math.abs(pos.getX(i)) - m.plinth.sx / 2,
          Math.abs(pos.getZ(i)) - m.plinth.sz / 2,
        );
        expect(overhang, `vertex ${i}`).toBeLessThanOrEqual(EDGE_OVERHANG + 1e-6);
      }
    },
  );
  it.each(TYPES)('type %i: as tall as before (±0.05)', (type) => {
    expect(Math.abs(plantHeight(type) - HEIGHT[type])).toBeLessThanOrEqual(0.05);
  });
  it.each(TYPES)('type %i: window anchors sit on a wall and face out of it', (type) => {
    const m = plantModel(type);
    for (const w of m.windows) {
      expect(Math.abs(w.x)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(w.z)).toBeLessThanOrEqual(0.5);
      const label = `window at ${w.x},${w.y},${w.z} face ${w.face}`;
      const yaw = (w.face * Math.PI) / 2;
      const normal = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
      const glass = new THREE.Vector3(w.x, w.y + w.h / 2, w.z);
      const mesh = new THREE.Mesh(
        m.geometry!,
        new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
      );
      // A ray from just in front of the glass centre back into the wall hits the model within 0.01 ...
      const origin = glass.clone().addScaledVector(normal, 0.05);
      const hit = new THREE.Raycaster(origin, normal.clone().negate(), 0, 0.06).intersectObject(
        mesh,
      )[0];
      expect(hit, label).toBeDefined();
      expect(hit.distance, label).toBeGreaterThan(0.04);
      // ... on a wall that faces the window's way (a flipped face would hit the wall from inside) ...
      expect(hit.face!.normal.dot(normal), label).toBeGreaterThan(0.9);
      // ... and nothing stands right in front of the glass.
      const front = glass.clone().addScaledVector(normal, 0.001);
      const blocked = new THREE.Raycaster(front, normal, 0, 0.02).intersectObject(mesh);
      expect(blocked, label).toHaveLength(0);
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
  it.each(YARD)('type %i: has yard lamps', (type) => {
    expect(plantModel(type).lamps.some((l) => l.kind === 'yard')).toBe(true);
  });
  it('park: ground props only — trees in three sizes and benches, no plinth', () => {
    const m = plantModel(PlantType.Park);
    expect(m.geometry).toBeNull();
    expect(m.plinth).toBeUndefined();
    const trees = m.groundProps!.filter((p) => p.kind === 'tree');
    expect(new Set(trees.map((t) => t.scale)).size).toBe(3);
    expect(m.groundProps!.some((p) => p.kind === 'bench')).toBe(true);
    for (const p of m.groundProps!) {
      expect(Math.abs(p.x)).toBeLessThanOrEqual(0.42);
      expect(Math.abs(p.z)).toBeLessThanOrEqual(0.42);
    }
  });
  it.each([PlantType.TrainStation, PlantType.FreightTerminal, PlantType.RailYard])(
    'type %i: drawn with the track side at +z (platform/loading edge at z > 0.25)',
    (type) => {
      const g = plantModel(type).geometry!;
      g.computeBoundingBox();
      expect(g.boundingBox!.max.z).toBeGreaterThan(0.25);
    },
  );
  it('rail yard: a siding on the centre line runs from the shed to the track edge', () => {
    const g = plantModel(PlantType.RailYard).geometry!;
    const position = g.getAttribute('position');
    // Rails either side of x = 0 (gauge 0.09) reaching z = 0.5, where the
    // track tile's stub meets them.
    let reachesEdge = false;
    for (let i = 0; i < position.count; i++) {
      if (Math.abs(Math.abs(position.getX(i)) - 0.09) < 0.02 && position.getZ(i) >= 0.5 - 1e-6)
        reachesEdge = true;
    }
    expect(reachesEdge).toBe(true);
  });
  it.each([
    ['tree', treeGeometry, TREE_HEIGHT],
    ['bench', benchGeometry, BENCH_HEIGHT],
  ] as const)('%s prop: vertex-coloured, base on the ground, stated height', (_, build, height) => {
    const g = build();
    expect(g.getAttribute('color').count).toBe(g.getAttribute('position').count);
    expect(distinctColours(g)).toBeGreaterThanOrEqual(2);
    g.computeBoundingBox();
    expect(g.boundingBox!.min.y).toBeCloseTo(0, 6);
    expect(g.boundingBox!.max.y).toBeCloseTo(height, 6);
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
