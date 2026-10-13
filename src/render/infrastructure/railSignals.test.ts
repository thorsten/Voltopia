import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DIR_E, DIR_N, DIR_S, DIR_W, LINE_PRESENT } from '../../shared/grid.ts';
import { PlantType, Terrain, TileType } from '../../shared/types.ts';
import { ElevationField } from '../elevationField.ts';
import {
  blockOccupied,
  RailSignals,
  SIGNAL_BLOCK_TILES,
  SIGNAL_GREEN,
  SIGNAL_RED,
  signalTiles,
} from './railSignals.ts';

const SIZE = 6;
const at = (x: number, y: number) => y * SIZE + x;

function world() {
  const tiles = SIZE * SIZE;
  return {
    masks: new Uint8Array(tiles),
    tileTypes: new Uint8Array(tiles),
    terrains: new Uint8Array(tiles).fill(Terrain.Land),
    plantTypes: new Uint8Array(tiles),
  };
}

/** A straight east-west line along row 2. */
function straightLine() {
  const w = world();
  for (let x = 0; x < SIZE; x++) {
    w.masks[at(x, 2)] = LINE_PRESENT | (x > 0 ? DIR_W : 0) | (x < SIZE - 1 ? DIR_E : 0);
  }
  return w;
}

/** The straight line with a train station south of (3,2). */
function withStation() {
  const w = straightLine();
  w.tileTypes[at(3, 3)] = TileType.Plant;
  w.plantTypes[at(3, 3)] = PlantType.TrainStation;
  return w;
}

const tilesOf = (w: ReturnType<typeof world>) =>
  signalTiles(w.masks, w.tileTypes, w.terrains, w.plantTypes, SIZE);

function signalsFor(w: ReturnType<typeof world>) {
  const scene = new THREE.Scene();
  const signals = new RailSignals(scene);
  signals.rebuild(w.masks, w.tileTypes, w.terrains, w.plantTypes, SIZE, new ElevationField(SIZE));
  return signals;
}

const position = (mesh: THREE.InstancedMesh, slot: number) => {
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(slot, matrix);
  return new THREE.Vector3().setFromMatrixPosition(matrix);
};

const lampHex = (signals: RailSignals, slot: number) => {
  const color = new THREE.Color();
  signals.lamps.mesh.getColorAt(slot, color);
  return color.getHex();
};

describe('signalTiles', () => {
  it('puts none on a plain straight', () => {
    expect(tilesOf(straightLine())).toEqual([]);
  });

  it('puts one beside a station and one at a junction', () => {
    expect(tilesOf(withStation())).toEqual([at(3, 2)]);
    const w = straightLine();
    w.masks[at(2, 2)] |= DIR_S;
    w.masks[at(2, 3)] = LINE_PRESENT | DIR_N;
    expect(tilesOf(w)).toEqual([at(2, 2)]);
  });

  it('puts none on a road crossing or a bridge', () => {
    const road = withStation();
    road.tileTypes[at(3, 2)] = TileType.Road;
    expect(tilesOf(road)).toEqual([]);
    const bridge = withStation();
    bridge.terrains[at(3, 2)] = Terrain.River;
    expect(tilesOf(bridge)).toEqual([]);
  });
});

describe('blockOccupied', () => {
  it('measures from the tile centre in tile units (Chebyshev)', () => {
    const tile = at(2, 2);
    expect(blockOccupied(tile, SIZE, [{ x: 2.5 + SIGNAL_BLOCK_TILES, y: 2.5 }])).toBe(true);
    expect(blockOccupied(tile, SIZE, [{ x: 2.5 - 1, y: 2.5 + 1 }])).toBe(true);
    expect(blockOccupied(tile, SIZE, [{ x: 2.5 + SIGNAL_BLOCK_TILES + 0.1, y: 2.5 }])).toBe(false);
    expect(blockOccupied(tile, SIZE, [])).toBe(false);
  });
});

describe('RailSignals', () => {
  it('stands the mast inside the tile, on the side away from the station', () => {
    const signals = signalsFor(withStation());
    expect(signals.masts.mesh.count).toBe(1);
    expect(signals.lamps.mesh.count).toBe(1);
    const foot = position(signals.masts.mesh, 0);
    expect(foot.x).toBeCloseTo(3.5, 6);
    // The station lies south (+z): the mast keeps to the north side.
    expect(foot.z).toBeLessThan(2.5);
    expect(foot.z).toBeGreaterThan(2);
    const lamp = position(signals.lamps.mesh, 0);
    expect(lamp.y).toBeGreaterThan(0.25);
  });

  it('turns red while a wagon is in the block and green once it has left', () => {
    const signals = signalsFor(withStation());
    signals.update();
    expect(lampHex(signals, 0)).toBe(SIGNAL_GREEN);
    signals.setVehicles([{ x: 4.5, y: 2.5 }]);
    signals.update();
    expect(lampHex(signals, 0)).toBe(SIGNAL_RED);
    signals.setVehicles([{ x: 0.5, y: 2.5 }]);
    signals.update();
    expect(lampHex(signals, 0)).toBe(SIGNAL_GREEN);
  });

  it('does not re-upload colours when no aspect changed', () => {
    const signals = signalsFor(withStation());
    signals.update();
    const version = signals.lamps.mesh.instanceColor!.version;
    signals.update();
    expect(signals.lamps.mesh.instanceColor!.version).toBe(version);
  });

  it('evaluates the aspects only after new vehicles or a rebuild', () => {
    const signals = signalsFor(withStation());
    let scans = 0;
    /** Vehicles that count every scan over them. */
    const counted = (list: Array<{ x: number; y: number }>) =>
      Object.assign([...list], {
        [Symbol.iterator]() {
          scans++;
          return list[Symbol.iterator]();
        },
      });
    signals.setVehicles(counted([{ x: 4.5, y: 2.5 }]));
    signals.update();
    expect(scans).toBe(1);
    expect(lampHex(signals, 0)).toBe(SIGNAL_RED);
    signals.update();
    signals.update();
    expect(scans).toBe(1);
    signals.setVehicles(counted([{ x: 0.5, y: 2.5 }]));
    signals.update();
    expect(scans).toBe(2);
    expect(lampHex(signals, 0)).toBe(SIGNAL_GREEN);
  });

  it('glows brighter at night; masts cast shadows, lamps do not', () => {
    const signals = signalsFor(withStation());
    signals.setNight(0);
    const material = signals.lamps.mesh.material as THREE.MeshBasicMaterial;
    expect(material.opacity).toBeCloseTo(0.45, 6);
    signals.setNight(1);
    expect(material.opacity).toBeCloseTo(1, 6);
    expect(signals.masts.mesh.castShadow).toBe(true);
    expect(signals.lamps.mesh.castShadow).toBe(false);
    expect(signals.masts.mesh.frustumCulled).toBe(false);
    expect(signals.lamps.mesh.frustumCulled).toBe(false);
  });
});
