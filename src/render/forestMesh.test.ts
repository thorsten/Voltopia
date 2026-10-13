import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { TileDiff } from '../shared/types.ts';
import { Terrain } from '../shared/types.ts';
import { ElevationField } from './elevationField.ts';
import { CONIFER_COLOR, ForestMesh } from './forestMesh.ts';
import type { RenderEnvironment } from './renderer.ts';

const SIZE = 20;

/** A flat or tilted land map with the given forest stage per tile. */
function woods(
  forest: (index: number) => number,
  elevation: (index: number) => number = () => 0,
): { scene: THREE.Scene; field: ElevationField; layer: ForestMesh; diffs: TileDiff[] } {
  const scene = new THREE.Scene();
  const field = new ElevationField(SIZE);
  const diffs: TileDiff[] = [];
  for (let index = 0; index < SIZE * SIZE; index++) {
    diffs.push({
      index,
      elevation: elevation(index),
      terrain: Terrain.Land,
      forest: forest(index),
    } as TileDiff);
  }
  field.applyDiffs(diffs);
  const layer = new ForestMesh(scene, SIZE, field);
  layer.applyDiffs(diffs);
  return { scene, field, layer, diffs };
}

const total = (layer: ForestMesh) => layer.counts.conifer + layer.counts.broadleaf;

function mesh(scene: THREE.Scene, name: string): THREE.InstancedMesh {
  const found = scene.getObjectByName(name);
  expect(found).toBeInstanceOf(THREE.InstancedMesh);
  return found as THREE.InstancedMesh;
}

function matrices(m: THREE.InstancedMesh): number[] {
  return Array.from(m.instanceMatrix.array.slice(0, m.count * 16));
}

/** Most triangles one tree (trunk and crown) may cost: forests hold thousands. */
const TREE_TRIANGLE_BUDGET = 96;

const triangles = (m: THREE.InstancedMesh) => m.geometry.getAttribute('position').count / 3;

const autumn = (snowCover: number) => ({ phase: 0.6, snowCover }) as RenderEnvironment;

describe('ForestMesh', () => {
  it('draws 2, 3 and 5 trees on stage 1, 2 and 3 tiles', () => {
    for (const [stage, trees] of [
      [1, 2],
      [2, 3],
      [3, 5],
    ]) {
      const { layer } = woods((index) => (index === 0 ? stage : 0));
      expect(total(layer)).toBe(trees);
    }
  });

  it('mixes both species in lowland woods', () => {
    const { layer } = woods(() => 3);
    expect(layer.counts.conifer).toBeGreaterThan(0);
    expect(layer.counts.broadleaf).toBeGreaterThan(0);
  });

  it('grows mostly conifers on the highest ground', () => {
    const { layer } = woods(
      () => 3,
      () => 7,
    );
    expect(layer.counts.conifer).toBeGreaterThan(layer.counts.broadleaf);
  });

  it('keeps conifers evergreen while broadleaves turn', () => {
    const { scene, layer } = woods((index) => (index < 10 ? 3 : 0));
    layer.setEnvironment(autumn(0));
    const color = new THREE.Color();
    const conifers = mesh(scene, 'forest-conifer-crowns');
    const broadleaves = mesh(scene, 'forest-broadleaf-crowns');
    expect(conifers.count).toBeGreaterThan(0);
    expect(broadleaves.count).toBeGreaterThan(0);
    conifers.getColorAt(0, color);
    expect(color.getHex()).toBe(CONIFER_COLOR);
    broadleaves.getColorAt(0, color);
    expect(color.getHex()).not.toBe(CONIFER_COLOR);
  });

  it('whitens conifers under snow', () => {
    const { scene, layer } = woods((index) => (index < 10 ? 3 : 0));
    const conifers = mesh(scene, 'forest-conifer-crowns');
    const bare = new THREE.Color();
    const snowy = new THREE.Color();
    layer.setEnvironment(autumn(0));
    conifers.getColorAt(0, bare);
    layer.setEnvironment(autumn(1));
    conifers.getColorAt(0, snowy);
    expect(snowy.getHSL({ h: 0, s: 0, l: 0 }).l).toBeGreaterThan(
      bare.getHSL({ h: 0, s: 0, l: 0 }).l,
    );
  });

  it('keeps tree positions across rebuilds', () => {
    const { scene, layer } = woods((index) => (index < 4 ? 3 : 0));
    const names = ['forest-conifer-trunks', 'forest-broadleaf-trunks'];
    const before = names.map((name) => matrices(mesh(scene, name)));
    layer.applyDiffs([{ index: 0, forest: 0 } as TileDiff]);
    layer.applyDiffs([{ index: 0, forest: 3 } as TileDiff]);
    // The tile re-enters the map at its end, so compare as sets of trees.
    const sorted = (list: number[]) =>
      Array.from({ length: list.length / 16 }, (_, i) => list.slice(i * 16, i * 16 + 16).join())
        .sort()
        .join('|');
    const after = names.map((name) => matrices(mesh(scene, name)));
    expect(after.map(sorted)).toEqual(before.map(sorted));
  });

  it('stands every tree on its ground point', () => {
    const { scene, field } = woods(
      (index) => (index % 3 === 0 ? 3 : 0),
      (index) => (index % SIZE) % 4,
    );
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    for (const name of ['forest-conifer-trunks', 'forest-broadleaf-trunks']) {
      const trunks = mesh(scene, name);
      expect(trunks.count).toBeGreaterThan(0);
      for (let i = 0; i < trunks.count; i++) {
        trunks.getMatrixAt(i, matrix);
        position.setFromMatrixPosition(matrix);
        expect(position.y).toBeCloseTo(field.surfaceY(position.x, position.z), 6);
      }
    }
  });

  it('drops the trees of a cleared tile', () => {
    const { layer } = woods((index) => (index < 2 ? 3 : 0));
    expect(total(layer)).toBe(10);
    layer.applyDiffs([{ index: 0, forest: 0 } as TileDiff]);
    expect(total(layer)).toBe(5);
  });

  it('keeps every tree model within its triangle budget', () => {
    const { scene } = woods(() => 0);
    for (const species of ['conifer', 'broadleaf']) {
      const trunk = mesh(scene, `forest-${species}-trunks`);
      const crown = mesh(scene, `forest-${species}-crowns`);
      expect(triangles(trunk) + triangles(crown)).toBeLessThanOrEqual(TREE_TRIANGLE_BUDGET);
    }
  });

  it('lets only the crowns cast shadows', () => {
    const { scene } = woods(() => 0);
    for (const species of ['conifer', 'broadleaf']) {
      expect(mesh(scene, `forest-${species}-trunks`).castShadow).toBe(false);
      expect(mesh(scene, `forest-${species}-crowns`).castShadow).toBe(true);
    }
  });

  it('sizes its meshes to the woods, not to the map', () => {
    const { scene } = woods((index) => (index === 0 ? 3 : 0));
    for (const species of ['conifer', 'broadleaf']) {
      for (const part of ['trunks', 'crowns']) {
        const capacity = mesh(scene, `forest-${species}-${part}`).instanceMatrix.count;
        expect(capacity).toBeLessThan((SIZE * SIZE * 5) / 10);
      }
    }
  });
});
