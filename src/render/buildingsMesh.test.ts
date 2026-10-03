import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { TileDiff } from '../shared/types.ts';
import { SupplyStatus, TileType, Zone } from '../shared/types.ts';
import { ElevationField } from './elevationField.ts';
import { BuildingsMesh } from './buildingsMesh.ts';
import { PART_KINDS, PartKind } from './buildings/primitives.ts';
import { ACCENT } from './buildings/palette.ts';
import { MAX_PARTS_PER_KIND, StreetFace, faceDepth } from './buildings/recipes.ts';

/** Mirrors buildingsMesh.ts's private WINDOW_HEIGHT/WINDOW_WIDTH; not exported for tests. */
const WINDOW_HEIGHT = 0.11;
const WINDOW_WIDTH = 0.09;

const SIZE = 8;

function flatField(): ElevationField {
  const field = new ElevationField(SIZE);
  field.applyDiffs(
    Array.from({ length: SIZE * SIZE }, (_, index) => ({ index, elevation: 0 }) as TileDiff),
  );
  return field;
}

function building(
  index: number,
  zone: Zone,
  density: number,
  variant = 0,
  supplied: SupplyStatus = SupplyStatus.Supplied,
): TileDiff {
  return {
    index,
    tileType: TileType.Empty,
    zone,
    density,
    variant,
    supplied,
    elevation: 0,
  } as TileDiff;
}

function empty(index: number): TileDiff {
  return {
    index,
    tileType: TileType.Empty,
    zone: Zone.None,
    density: 0,
    variant: 0,
    supplied: SupplyStatus.NotConnected,
    elevation: 0,
  } as TileDiff;
}

function road(index: number): TileDiff {
  return {
    index,
    tileType: TileType.Road,
    zone: Zone.None,
    density: 0,
    variant: 0,
    supplied: SupplyStatus.NotConnected,
    elevation: 0,
  } as TileDiff;
}

function setup(): { scene: THREE.Scene; mesh: BuildingsMesh } {
  const scene = new THREE.Scene();
  const mesh = new BuildingsMesh(scene, SIZE, flatField());
  return { scene, mesh };
}

/** Instance matrices of one kind mesh whose scale is not zero (i.e. drawn parts). */
function drawn(mesh: THREE.InstancedMesh): THREE.Matrix4[] {
  const out: THREE.Matrix4[] = [];
  const m = new THREE.Matrix4();
  const s = new THREE.Vector3();
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, m);
    s.setFromMatrixScale(m);
    if (s.x > 0) out.push(m.clone());
  }
  return out;
}

const CENTRE = 3 * SIZE + 3;

describe('BuildingsMesh', () => {
  it('creates one culling-free instanced mesh per primitive kind plus windows', () => {
    const { scene, mesh } = setup();
    expect(mesh.kindMeshes).toHaveLength(PART_KINDS.length);
    for (const kind of PART_KINDS) {
      const m = mesh.kindMeshes[kind];
      expect(m.frustumCulled).toBe(false);
      expect(m.instanceMatrix.count).toBe(SIZE * SIZE * MAX_PARTS_PER_KIND[kind]);
      expect(scene.children).toContain(m);
    }
    const instanced = scene.children.filter((c) => c instanceof THREE.InstancedMesh);
    expect(instanced).toHaveLength(PART_KINDS.length + 1);
  });

  it('uploads only the placed building block, never the whole instance buffer', () => {
    const { mesh } = setup();
    mesh.setReducedMotion(true);
    mesh.applyDiffs([building(CENTRE, Zone.Residential, 1, 0)]);
    const boxBlockSize = MAX_PARTS_PER_KIND[PartKind.Box];
    const boxRanges = mesh.kindMeshes[PartKind.Box].instanceMatrix.updateRanges;
    expect(boxRanges.length).toBeGreaterThan(0);
    // First building allocated: its Box block starts at slot 0.
    expect(boxRanges.some((r) => r.start === 0 && r.count === boxBlockSize * 16)).toBe(true);
    for (const kind of PART_KINDS) {
      const attr = mesh.kindMeshes[kind].instanceMatrix;
      const fullBufferLength = attr.count * attr.itemSize;
      for (const r of attr.updateRanges) {
        expect(r.count).toBeLessThan(fullBufferLength);
      }
    }
  });

  it('draws exactly the recipe parts of a placed building, grouped by kind', () => {
    const { mesh } = setup();
    mesh.setReducedMotion(true);
    mesh.applyDiffs([building(CENTRE, Zone.Residential, 1, 2)]);
    const parts = mesh.partsAt(CENTRE)!;
    expect(parts.length).toBeGreaterThan(2);
    for (const kind of PART_KINDS) {
      const expected = parts.filter((p) => p.kind === kind).length;
      expect(drawn(mesh.kindMeshes[kind])).toHaveLength(expected);
      expect(mesh.kindMeshes[kind].count).toBe(MAX_PARTS_PER_KIND[kind]);
    }
  });

  it('places parts at full size with reduced motion and at the tile centre', () => {
    const { mesh } = setup();
    mesh.setReducedMotion(true);
    mesh.applyDiffs([building(CENTRE, Zone.Commercial, 1, 0)]);
    const main = mesh.partsAt(CENTRE)!.find((p) => p.main)!;
    const boxes = drawn(mesh.kindMeshes[PartKind.Box]);
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const found = boxes.some((m) => {
      position.setFromMatrixPosition(m);
      scale.setFromMatrixScale(m);
      return (
        Math.abs(scale.x - main.sx) < 1e-6 &&
        Math.abs(scale.y - main.sy) < 1e-6 &&
        Math.abs(position.x - (3 + 0.5 + main.ox)) < 1e-6 &&
        Math.abs(position.z - (3 + 0.5 + main.oz)) < 1e-6
      );
    });
    expect(found).toBe(true);
  });

  it('starts new buildings small and grows them to full size', () => {
    const { mesh } = setup();
    mesh.applyDiffs([building(CENTRE, Zone.Residential, 2, 1)]);
    const main = mesh.partsAt(CENTRE)!.find((p) => p.main)!;
    const scaleOfMain = () => {
      const scale = new THREE.Vector3();
      let best = 0;
      for (const m of drawn(mesh.kindMeshes[PartKind.Box])) {
        scale.setFromMatrixScale(m);
        best = Math.max(best, scale.y);
      }
      return best;
    };
    const before = scaleOfMain();
    expect(before).toBeLessThan(main.sy * 0.2);
    mesh.update(10);
    expect(scaleOfMain()).toBeCloseTo(main.sy, 6);
  });

  it('frees every slot on removal and never leaks across cycles', () => {
    const { mesh } = setup();
    mesh.setReducedMotion(true);
    for (let i = 0; i < 200; i++) {
      mesh.applyDiffs([building(CENTRE, Zone.Retail, 1 + (i % 3), i % 8)]);
      mesh.applyDiffs([empty(CENTRE)]);
    }
    for (const kind of PART_KINDS) {
      expect(mesh.kindMeshes[kind].count).toBe(0);
      expect(drawn(mesh.kindMeshes[kind])).toHaveLength(0);
    }
    expect(mesh.partsAt(CENTRE)).toBeUndefined();
  });

  it('recolours the body on a supply flip without touching matrices', () => {
    const { mesh } = setup();
    mesh.setReducedMotion(true);
    mesh.applyDiffs([building(CENTRE, Zone.Residential, 3, 4)]);
    const boxMesh = mesh.kindMeshes[PartKind.Box];
    const before = drawn(boxMesh);
    const colorBefore = new THREE.Color();
    boxMesh.getColorAt(0, colorBefore);
    mesh.applyDiffs([building(CENTRE, Zone.Residential, 3, 4, SupplyStatus.NotConnected)]);
    const after = drawn(boxMesh);
    expect(after.map((m) => m.toArray())).toEqual(before.map((m) => m.toArray()));
    const colorAfter = new THREE.Color();
    boxMesh.getColorAt(0, colorAfter);
    expect(colorAfter.getHex()).not.toBe(colorBefore.getHex());
  });

  it('tints the body on a supply flip but leaves the accent colour alone', () => {
    const { mesh } = setup();
    mesh.setReducedMotion(true);
    mesh.applyDiffs([building(CENTRE, Zone.Residential, 1, 0)]);
    const parts = mesh.partsAt(CENTRE)!;
    const main = parts.find((p) => p.main)!;
    const door = parts.find((p) => p.accent && p.color.getHex() === ACCENT.door.getHex())!;
    // Parts of a kind are written in recipe order starting at the block's
    // first slot, so a part's slot is its index among same-kind parts.
    const boxParts = parts.filter((p) => p.kind === PartKind.Box);
    const mainSlot = boxParts.indexOf(main);
    const doorSlot = boxParts.indexOf(door);
    expect(mainSlot).toBeGreaterThanOrEqual(0);
    expect(doorSlot).toBeGreaterThanOrEqual(0);
    const boxMesh = mesh.kindMeshes[PartKind.Box];
    const bodyBefore = new THREE.Color();
    const doorBefore = new THREE.Color();
    boxMesh.getColorAt(mainSlot, bodyBefore);
    boxMesh.getColorAt(doorSlot, doorBefore);
    mesh.applyDiffs([building(CENTRE, Zone.Residential, 1, 0, SupplyStatus.NotConnected)]);
    const bodyAfter = new THREE.Color();
    const doorAfter = new THREE.Color();
    boxMesh.getColorAt(mainSlot, bodyAfter);
    boxMesh.getColorAt(doorSlot, doorAfter);
    expect(bodyAfter.getHex()).not.toBe(bodyBefore.getHex());
    expect(doorAfter.getHex()).toBe(doorBefore.getHex());
  });

  it('turns a house toward a road laid beside it afterwards', () => {
    const { mesh } = setup();
    mesh.setReducedMotion(true);
    mesh.applyDiffs([building(CENTRE, Zone.Residential, 1, 0)]);
    expect(mesh.streetFaceAt(CENTRE)).toBe(StreetFace.South);
    const before = drawn(mesh.kindMeshes[PartKind.Box]).map((m) => m.toArray());
    mesh.applyDiffs([road(CENTRE + 1)]);
    expect(mesh.streetFaceAt(CENTRE)).toBe(StreetFace.East);
    const after = drawn(mesh.kindMeshes[PartKind.Box]).map((m) => m.toArray());
    expect(after).not.toEqual(before);
  });

  it('uses a road that arrives in the same batch as the building', () => {
    const { mesh } = setup();
    mesh.setReducedMotion(true);
    mesh.applyDiffs([building(CENTRE, Zone.Residential, 1, 0), road(CENTRE - SIZE)]);
    expect(mesh.streetFaceAt(CENTRE)).toBe(StreetFace.North);
  });

  it('puts windows on the street face and its opposite, never on the side faces', () => {
    const { scene, mesh } = setup();
    mesh.setReducedMotion(true);
    mesh.applyDiffs([building(CENTRE, Zone.Residential, 3, 0), road(CENTRE + 1)]);
    expect(mesh.streetFaceAt(CENTRE)).toBe(StreetFace.East);
    const main = mesh.partsAt(CENTRE)!.find((p) => p.main)!;
    const windows = scene.children.find(
      (c): c is THREE.InstancedMesh =>
        c instanceof THREE.InstancedMesh && !mesh.kindMeshes.includes(c),
    )!;
    expect(windows.count).toBeGreaterThan(0);
    expect(windows.count).toBeLessThanOrEqual(24);
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const cx = 3 + 0.5 + main.ox;
    const cz = 3 + 0.5 + main.oz;
    for (let i = 0; i < windows.count; i++) {
      windows.getMatrixAt(i, m);
      p.setFromMatrixPosition(m);
      // East/west faces: x is pushed past the body's half width, z stays inside it.
      expect(Math.abs(p.x - cx)).toBeGreaterThan(main.sx / 2);
      expect(Math.abs(p.z - cz)).toBeLessThan(main.sz / 2);
    }
  });

  it('gives a shop one wide shopfront quad on the street face', () => {
    const { scene, mesh } = setup();
    mesh.setReducedMotion(true);
    mesh.applyDiffs([building(CENTRE, Zone.Retail, 1, 0), road(CENTRE + SIZE)]);
    const main = mesh.partsAt(CENTRE)!.find((p) => p.main)!;
    const windows = scene.children.find(
      (c): c is THREE.InstancedMesh =>
        c instanceof THREE.InstancedMesh && !mesh.kindMeshes.includes(c),
    )!;
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const cz = 3 + 0.5 + main.oz;
    const wide: THREE.Vector3[] = [];
    for (let i = 0; i < windows.count; i++) {
      windows.getMatrixAt(i, m);
      p.setFromMatrixPosition(m);
      s.setFromMatrixScale(m);
      if (p.z > cz) wide.push(s.clone()); // street (south) face
    }
    expect(wide).toHaveLength(1);
    // Scaled from the 0.09 × 0.11 quad to ~80 % of the facade width.
    expect(wide[0].x * 0.09).toBeCloseTo(main.sx * 0.8, 6);
  });

  it('keeps a density-1 house lit on the street face, clear of the door', () => {
    const { scene, mesh } = setup();
    mesh.setReducedMotion(true);
    mesh.applyDiffs([building(CENTRE, Zone.Residential, 1, 0)]);
    expect(mesh.streetFaceAt(CENTRE)).toBe(StreetFace.South);
    const main = mesh.partsAt(CENTRE)!.find((p) => p.main)!;
    const windows = scene.children.find(
      (c): c is THREE.InstancedMesh =>
        c instanceof THREE.InstancedMesh && !mesh.kindMeshes.includes(c),
    )!;
    const cx = 3 + 0.5 + main.ox;
    const cz = 3 + 0.5 + main.oz;
    // Door rectangle: ±0.1 (DOOR.width/2) around the body centre x, ground
    // (y = 0 on this flat field) up to the door height (0.16).
    const doorLeft = cx - 0.1;
    const doorRight = cx + 0.1;
    const doorTop = 0.16;
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    let streetWindows = 0;
    let oppositeWindows = 0;
    for (let i = 0; i < windows.count; i++) {
      windows.getMatrixAt(i, m);
      p.setFromMatrixPosition(m);
      if (p.z > cz) {
        streetWindows++;
        const quadLeft = p.x - WINDOW_WIDTH / 2;
        const quadRight = p.x + WINDOW_WIDTH / 2;
        const quadBottom = p.y - WINDOW_HEIGHT / 2;
        const intersectsDoor = quadLeft < doorRight && quadRight > doorLeft && quadBottom < doorTop;
        expect(intersectsDoor).toBe(false);
      } else {
        oppositeWindows++;
      }
    }
    // The density-1 house must keep lit street-face windows at night; the
    // opposite face (no door to clear) keeps its window rows too.
    expect(streetWindows).toBeGreaterThan(0);
    expect(oppositeWindows).toBeGreaterThan(0);
  });

  it("still lights a density-3 apartment's street face", () => {
    const { scene, mesh } = setup();
    mesh.setReducedMotion(true);
    mesh.applyDiffs([building(CENTRE, Zone.Residential, 3, 0)]);
    expect(mesh.streetFaceAt(CENTRE)).toBe(StreetFace.South);
    const main = mesh.partsAt(CENTRE)!.find((p) => p.main)!;
    const windows = scene.children.find(
      (c): c is THREE.InstancedMesh =>
        c instanceof THREE.InstancedMesh && !mesh.kindMeshes.includes(c),
    )!;
    const cz = 3 + 0.5 + main.oz;
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    let streetWindows = 0;
    for (let i = 0; i < windows.count; i++) {
      windows.getMatrixAt(i, m);
      p.setFromMatrixPosition(m);
      if (p.z > cz) streetWindows++;
    }
    expect(streetWindows).toBeGreaterThan(0);
  });

  it('keeps the retail shopfront quad below the awning', () => {
    const { scene, mesh } = setup();
    mesh.setReducedMotion(true);
    mesh.applyDiffs([building(CENTRE, Zone.Retail, 1, 0), road(CENTRE + SIZE)]);
    const parts = mesh.partsAt(CENTRE)!;
    const main = parts.find((p) => p.main)!;
    const awning = parts.find(
      (p) =>
        p.accent &&
        p.kind === PartKind.Box &&
        p.sy <= 0.05 &&
        p.oz > main.oz + faceDepth(main, StreetFace.South) / 2,
    )!;
    expect(awning).toBeDefined();
    const windows = scene.children.find(
      (c): c is THREE.InstancedMesh =>
        c instanceof THREE.InstancedMesh && !mesh.kindMeshes.includes(c),
    )!;
    const cz = 3 + 0.5 + main.oz;
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    let shopfrontTop = -Infinity;
    for (let i = 0; i < windows.count; i++) {
      windows.getMatrixAt(i, m);
      p.setFromMatrixPosition(m);
      s.setFromMatrixScale(m);
      if (p.z > cz) shopfrontTop = Math.max(shopfrontTop, p.y + (s.y * WINDOW_HEIGHT) / 2);
    }
    expect(shopfrontTop).toBeLessThan(awning.oy);
  });

  it('keeps growing a building across a same-batch road re-issue', () => {
    const { mesh } = setup();
    mesh.applyDiffs([building(CENTRE, Zone.Residential, 1, 0), road(CENTRE + 1)]);
    const main = mesh.partsAt(CENTRE)!.find((p) => p.main)!;
    const scaleOfMain = () => {
      const scale = new THREE.Vector3();
      let best = 0;
      for (const m of drawn(mesh.kindMeshes[PartKind.Box])) {
        scale.setFromMatrixScale(m);
        best = Math.max(best, scale.y);
      }
      return best;
    };
    expect(scaleOfMain()).toBeLessThan(main.sy * 0.2);
    expect(mesh.streetFaceAt(CENTRE)).toBe(StreetFace.East);
    mesh.update(10);
    expect(scaleOfMain()).toBeCloseTo(main.sy, 6);
  });

  it('isolates neighbouring buildings in their own blocks', () => {
    const { mesh } = setup();
    mesh.setReducedMotion(true);
    mesh.applyDiffs([building(CENTRE, Zone.Residential, 1, 0)]);
    const firstPartsCount = mesh.partsAt(CENTRE)!.length;
    const firstByKind = (kind: PartKind) =>
      drawn(mesh.kindMeshes[kind])
        .map((m) => m.toArray())
        .slice();
    const before = PART_KINDS.map((kind) => firstByKind(kind));
    mesh.applyDiffs([building(CENTRE + 1, Zone.Commercial, 1, 1)]);
    const secondPartsCount = mesh.partsAt(CENTRE + 1)!.length;
    expect(firstPartsCount).toBeGreaterThan(0);
    expect(secondPartsCount).toBeGreaterThan(0);
    for (const kind of PART_KINDS) {
      const expectedFirst = mesh.partsAt(CENTRE)!.filter((p) => p.kind === kind).length;
      const expectedSecond = mesh.partsAt(CENTRE + 1)!.filter((p) => p.kind === kind).length;
      expect(drawn(mesh.kindMeshes[kind])).toHaveLength(expectedFirst + expectedSecond);
    }
    // Placing the second building must not touch the first's slots.
    const after = PART_KINDS.map((kind) => firstByKind(kind).slice(0, before[kind].length));
    for (const kind of PART_KINDS) {
      expect(after[kind]).toEqual(before[kind]);
    }
  });

  it('keeps the window mesh hidden by day and shows it at night', () => {
    const { scene, mesh } = setup();
    mesh.setReducedMotion(true);
    mesh.applyDiffs([building(CENTRE, Zone.Residential, 2, 0)]);
    const windows = scene.children.find(
      (c): c is THREE.InstancedMesh =>
        c instanceof THREE.InstancedMesh && !mesh.kindMeshes.includes(c),
    )!;
    const env = (nightFactor: number) => ({
      nightFactor,
      sunFactor: 1 - nightFactor,
      windFactor: 0,
      stateOfCharge: 0,
      tideLevel: 0,
      demand: { residential: 0, commercial: 0, retail: 0 },
      phase: 0,
      temperature: 15,
      snowCover: 0,
      sunrise: 0.25,
      sunset: 0.75,
      solarStrength: 1,
    });
    mesh.setEnvironment(env(0));
    expect(windows.visible).toBe(false);
    mesh.setEnvironment(env(1));
    expect(windows.visible).toBe(true);
    expect(windows.count).toBeGreaterThan(0);
  });
});
