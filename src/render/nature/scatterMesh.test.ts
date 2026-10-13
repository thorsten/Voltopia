import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { TileDiff } from '../../shared/types.ts';
import { PlantType, Terrain, TileType, Zone } from '../../shared/types.ts';
import { ElevationField } from '../elevationField.ts';
import { SCATTER_SHARE, ScatterMesh } from './scatterMesh.ts';

const SIZE = 16;

/** A free land tile: nothing built, zoned, wooded or wired. */
function freeTile(index: number, elevation: number): TileDiff {
  return {
    index,
    tileType: TileType.Empty,
    zone: Zone.None,
    terrain: Terrain.Land,
    elevation,
    forest: 0,
    powerLine: 0,
    rail: 0,
    geothermal: 0,
    plantType: PlantType.None,
  } as TileDiff;
}

/** A free map of `size`² tiles at the given elevation per tile. */
function freeMap(
  size = SIZE,
  elevation: (index: number) => number = () => 0,
): { scene: THREE.Scene; field: ElevationField; layer: ScatterMesh; diffs: TileDiff[] } {
  const scene = new THREE.Scene();
  const field = new ElevationField(size);
  const diffs = Array.from({ length: size * size }, (_, index) =>
    freeTile(index, elevation(index)),
  );
  field.applyDiffs(diffs);
  const layer = new ScatterMesh(scene, size, field);
  layer.applyDiffs(diffs);
  return { scene, field, layer, diffs };
}

function mesh(scene: THREE.Scene, name: string): THREE.InstancedMesh {
  const found = scene.getObjectByName(name);
  expect(found).toBeInstanceOf(THREE.InstancedMesh);
  return found as THREE.InstancedMesh;
}

const MESHES = ['scatter-bushes', 'scatter-rocks'];

function matrices(m: THREE.InstancedMesh): number[] {
  return Array.from(m.instanceMatrix.array.slice(0, m.count * 16));
}

describe('ScatterMesh', () => {
  it('puts props on about a third of free tiles', () => {
    const size = 64;
    const { layer } = freeMap(size);
    const share = layer.propTiles().size / (size * size);
    expect(Math.abs(share - SCATTER_SHARE)).toBeLessThanOrEqual(0.05);
  });

  it('keeps props off built, zoned, wired, wooded and water tiles', () => {
    const { layer, diffs } = freeMap();
    const tiles = [...layer.propTiles()];
    const changes: Partial<TileDiff>[] = [
      { tileType: TileType.Road },
      { tileType: TileType.Plant, plantType: PlantType.SolarFarm },
      { zone: Zone.Residential },
      { powerLine: 1 },
      { rail: 1 },
      { geothermal: 2 },
      { forest: 1 },
      { terrain: Terrain.Lake },
    ];
    expect(tiles.length).toBeGreaterThanOrEqual(changes.length);
    const built = changes.map((change, i) => ({ ...diffs[tiles[i]], ...change }) as TileDiff);
    layer.applyDiffs(built);
    const after = layer.propTiles();
    for (const diff of built) expect(after.has(diff.index)).toBe(false);
  });

  it('clears the props of a tile a road is built on', () => {
    const { layer, diffs } = freeMap();
    const before = layer.counts.bushes + layer.counts.rocks;
    const [tile] = layer.propTiles();
    layer.applyDiffs([{ ...diffs[tile], tileType: TileType.Road }]);
    expect(layer.propTiles().has(tile)).toBe(false);
    expect(layer.counts.bushes + layer.counts.rocks).toBeLessThan(before);
  });

  it('places the same props for the same diffs', () => {
    const a = freeMap();
    const b = freeMap();
    for (const name of MESHES) {
      expect(matrices(mesh(a.scene, name))).toEqual(matrices(mesh(b.scene, name)));
    }
  });

  it('stands every prop on its ground point, inside its tile', () => {
    const { scene, field } = freeMap(SIZE, (index) => (index % SIZE) % 4);
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const bounds = new THREE.Box3();
    for (const name of MESHES) {
      const props = mesh(scene, name);
      expect(props.count).toBeGreaterThan(0);
      props.geometry.computeBoundingBox();
      for (let i = 0; i < props.count; i++) {
        props.getMatrixAt(i, matrix);
        position.setFromMatrixPosition(matrix);
        expect(position.y).toBeCloseTo(field.surfaceY(position.x, position.z), 6);
        bounds.copy(props.geometry.boundingBox!).applyMatrix4(matrix);
        expect(Math.floor(bounds.min.x)).toBe(Math.floor(position.x));
        expect(Math.floor(bounds.max.x)).toBe(Math.floor(position.x));
        expect(Math.floor(bounds.min.z)).toBe(Math.floor(position.z));
        expect(Math.floor(bounds.max.z)).toBe(Math.floor(position.z));
      }
    }
  });

  it('favours rocks on high ground and bushes on low ground', () => {
    const high = freeMap(SIZE, () => 7).layer.counts;
    expect(high.rocks).toBeGreaterThan(high.bushes);
    const low = freeMap(SIZE, () => 0).layer.counts;
    expect(low.bushes).toBeGreaterThan(low.rocks);
  });
});
