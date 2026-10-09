import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { TileDiff } from '../shared/types.ts';
import { HEATED_SERVED, SupplyStatus, TileType, Zone } from '../shared/types.ts';
import { ElevationField } from './elevationField.ts';
import { BuildingsMesh, isRoofKind } from './buildingsMesh.ts';
import { PART_KINDS, PartKind } from './buildings/primitives.ts';
import { ACCENT, applyAgeTint, applySupplyTint } from './buildings/palette.ts';
import { DOOR, MAX_PARTS_PER_KIND, PartRole, StreetFace, faceDepth } from './buildings/recipes.ts';
import { type AccentAnchor, type AccentSink, type AccentState } from './buildings/accents.ts';

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
    expect(PART_KINDS).toHaveLength(5);
    expect(mesh.kindMeshes).toHaveLength(PART_KINDS.length);
    expect(mesh.kindMeshes[PartKind.ShedRoof].instanceMatrix.count).toBe(
      SIZE * SIZE * MAX_PARTS_PER_KIND[PartKind.ShedRoof],
    );
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

  it('never doubles up street-face window quads on a residential d2/d3 building', () => {
    const indices = [10, CENTRE, 40];
    const variants = [0, 1, 2, 3, 4, 5, 6, 7];
    for (const density of [2, 3]) {
      for (const index of indices) {
        for (const variant of variants) {
          const { scene, mesh } = setup();
          mesh.setReducedMotion(true);
          mesh.applyDiffs([building(index, Zone.Residential, density, variant)]);
          expect(mesh.streetFaceAt(index)).toBe(StreetFace.South);
          const main = mesh.partsAt(index)!.find((p) => p.main)!;
          const windows = scene.children.find(
            (c): c is THREE.InstancedMesh =>
              c instanceof THREE.InstancedMesh && !mesh.kindMeshes.includes(c),
          )!;
          const cz = Math.floor(index / SIZE) + 0.5 + main.oz;
          const m = new THREE.Matrix4();
          const p = new THREE.Vector3();
          const street: THREE.Vector3[] = [];
          for (let i = 0; i < windows.count; i++) {
            windows.getMatrixAt(i, m);
            p.setFromMatrixPosition(m);
            if (p.z > cz) street.push(p.clone());
          }
          for (let a = 0; a < street.length; a++) {
            for (let b = a + 1; b < street.length; b++) {
              if (Math.abs(street[a].z - street[b].z) > 1e-9) continue; // not the same quad plane
              const dx = Math.abs(street[a].x - street[b].x);
              const dy = Math.abs(street[a].y - street[b].y);
              const overlaps = dx < WINDOW_WIDTH && dy < WINDOW_HEIGHT;
              expect(overlaps, `density ${density}/variant ${variant}/index ${index}`).toBe(false);
            }
          }
        }
      }
    }
  });

  it('nudges density-2 street-face windows clear of the real (possibly off-centre) door', () => {
    for (let variant = 0; variant < 8; variant++) {
      const { scene, mesh } = setup();
      mesh.setReducedMotion(true);
      mesh.applyDiffs([building(CENTRE, Zone.Residential, 2, variant)]);
      const parts = mesh.partsAt(CENTRE)!;
      const main = parts.find((p) => p.main)!;
      const door = parts.find((p) => p.accent && p.color.getHex() === ACCENT.door.getHex())!;
      expect(door).toBeDefined();
      const windows = scene.children.find(
        (c): c is THREE.InstancedMesh =>
          c instanceof THREE.InstancedMesh && !mesh.kindMeshes.includes(c),
      )!;
      const cx = 3 + 0.5 + main.ox;
      const cz = 3 + 0.5 + main.oz;
      // South face: the door's local sideways offset is simply ox - main.ox.
      const doorLx = door.ox - main.ox;
      const doorLeft = cx + doorLx - DOOR.width / 2;
      const doorRight = cx + doorLx + DOOR.width / 2;
      const doorTop = door.oy + DOOR.height;
      const m = new THREE.Matrix4();
      const p = new THREE.Vector3();
      let streetWindows = 0;
      for (let i = 0; i < windows.count; i++) {
        windows.getMatrixAt(i, m);
        p.setFromMatrixPosition(m);
        if (p.z > cz) {
          streetWindows++;
          const quadLeft = p.x - WINDOW_WIDTH / 2;
          const quadRight = p.x + WINDOW_WIDTH / 2;
          const quadBottom = p.y - WINDOW_HEIGHT / 2;
          const intersectsDoor =
            quadLeft < doorRight && quadRight > doorLeft && quadBottom < doorTop;
          expect(intersectsDoor, `variant ${variant}`).toBe(false);
        }
      }
      expect(streetWindows, `variant ${variant}`).toBeGreaterThan(0);
    }
  });

  it('never nudges a density-3 apartment (no door part to clear)', () => {
    const { scene, mesh } = setup();
    mesh.setReducedMotion(true);
    mesh.applyDiffs([building(CENTRE, Zone.Residential, 3, 0)]);
    const main = mesh.partsAt(CENTRE)!.find((p) => p.main)!;
    const windows = scene.children.find(
      (c): c is THREE.InstancedMesh =>
        c instanceof THREE.InstancedMesh && !mesh.kindMeshes.includes(c),
    )!;
    const cx = 3 + 0.5 + main.ox;
    const cz = 3 + 0.5 + main.oz;
    const width = main.sx; // South face: faceWidth === sx
    const cols = Math.min(3, Math.max(1, Math.round(width / 0.24)));
    const colLx = Array.from({ length: cols }, (_, c) => ((c + 0.5) / cols - 0.5) * width * 0.8);
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    let streetWindows = 0;
    for (let i = 0; i < windows.count; i++) {
      windows.getMatrixAt(i, m);
      p.setFromMatrixPosition(m);
      if (p.z > cz) {
        streetWindows++;
        const lx = p.x - cx;
        expect(colLx.some((c) => Math.abs(c - lx) < 1e-6)).toBe(true);
      }
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
      tideLevel: 0,
      demand: { residential: 0, commercial: 0, retail: 0, industrial: 0 },
      islands: [],
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

/** Records every sink call so tests can assert what the mesh forwarded. */
class RecordingSink implements AccentSink {
  calls: Array<
    | { op: 'set'; index: number; anchors: readonly AccentAnchor[]; state: AccentState }
    | { op: 'setState'; index: number; state: AccentState }
    | { op: 'remove'; index: number }
  > = [];
  set(index: number, anchors: readonly AccentAnchor[], state: AccentState): void {
    this.calls.push({ op: 'set', index, anchors, state });
  }
  setState(index: number, state: AccentState): void {
    this.calls.push({ op: 'setState', index, state });
  }
  remove(index: number): void {
    this.calls.push({ op: 'remove', index });
  }
}

function setupWithSink(): { mesh: BuildingsMesh; sink: RecordingSink } {
  const sink = new RecordingSink();
  const mesh = new BuildingsMesh(new THREE.Scene(), SIZE, flatField(), sink);
  mesh.setReducedMotion(true);
  return { mesh, sink };
}

describe('BuildingsMesh accent sink', () => {
  it('forwards one chimney anchor at the chimney top when a house is placed', () => {
    const { mesh, sink } = setupWithSink();
    mesh.applyDiffs([building(CENTRE, Zone.Residential, 1, 3)]);
    const chimney = mesh.partsAt(CENTRE)!.find((p) => p.role === PartRole.Chimney)!;
    expect(sink.calls).toHaveLength(1);
    const call = sink.calls[0];
    expect(call.op).toBe('set');
    if (call.op !== 'set') return;
    expect(call.index).toBe(CENTRE);
    expect(call.anchors).toHaveLength(1);
    expect(call.anchors[0].role).toBe(PartRole.Chimney);
    expect(call.anchors[0].x).toBeCloseTo(3.5 + chimney.ox, 9);
    expect(call.anchors[0].z).toBeCloseTo(3.5 + chimney.oz, 9);
    expect(call.anchors[0].y).toBeCloseTo(chimney.oy + chimney.sy, 9);
    expect(call.state).toEqual({ heated: false, supplied: SupplyStatus.Supplied, damaged: false });
  });

  it('forwards two vent anchors for a market hall and nothing for a shop', () => {
    const { mesh, sink } = setupWithSink();
    mesh.applyDiffs([building(CENTRE, Zone.Retail, 3, 0), building(CENTRE + 1, Zone.Retail, 1, 0)]);
    const sets = sink.calls.filter((c) => c.op === 'set');
    expect(sets).toHaveLength(1);
    const first = sets[0];
    expect(first.index).toBe(CENTRE);
    if (first.op !== 'set') return;
    expect(first.anchors.map((a) => a.role)).toEqual([PartRole.Vent, PartRole.Vent]);
  });

  it('sends only a state update on a supply, heat or damage flip', () => {
    const { mesh, sink } = setupWithSink();
    mesh.applyDiffs([building(CENTRE, Zone.Residential, 1, 0)]);
    sink.calls = [];
    mesh.applyDiffs([
      { ...building(CENTRE, Zone.Residential, 1, 0), heated: HEATED_SERVED } as TileDiff,
    ]);
    mesh.applyDiffs([
      {
        ...building(CENTRE, Zone.Residential, 1, 0),
        heated: HEATED_SERVED,
        damage: 40,
      } as TileDiff,
    ]);
    mesh.applyDiffs([building(CENTRE, Zone.Residential, 1, 0, SupplyStatus.NotConnected)]);
    expect(sink.calls.map((c) => c.op)).toEqual(['setState', 'setState', 'setState']);
    expect(sink.calls[0]).toMatchObject({ state: { heated: true, damaged: false } });
    expect(sink.calls[1]).toMatchObject({ state: { heated: true, damaged: true } });
    expect(sink.calls[2]).toMatchObject({
      state: { heated: false, damaged: false, supplied: SupplyStatus.NotConnected },
    });
    // An unchanged re-send is not a flip.
    sink.calls = [];
    mesh.applyDiffs([building(CENTRE, Zone.Residential, 1, 0, SupplyStatus.NotConnected)]);
    expect(sink.calls).toEqual([]);
  });

  it('re-issues anchors when a road beside the house turns it, and removes them with the building', () => {
    const { mesh, sink } = setupWithSink();
    mesh.applyDiffs([building(CENTRE, Zone.Residential, 1, 0)]);
    sink.calls = [];
    mesh.applyDiffs([road(CENTRE + 1)]); // east of the house → face flips from South to East
    expect(sink.calls.map((c) => c.op)).toEqual(['set']);
    sink.calls = [];
    mesh.applyDiffs([building(CENTRE, Zone.Residential, 2, 0)]); // densify: town house has no roles
    expect(sink.calls.map((c) => c.op)).toEqual(['remove']);
    sink.calls = [];
    mesh.applyDiffs([building(CENTRE, Zone.Residential, 1, 0)]);
    mesh.applyDiffs([empty(CENTRE)]);
    expect(sink.calls.map((c) => c.op)).toEqual(['set', 'remove']);
  });
});

describe('BuildingsMesh age stages', () => {
  /** A building diff at the given age stage. */
  function aged(index: number, zone: Zone, density: number, ageStage: number): TileDiff {
    return { ...building(index, zone, density, 0), ageStage } as TileDiff;
  }

  function bodyColor(mesh: BuildingsMesh): THREE.Color {
    const main = mesh.partsAt(CENTRE)!.find((p) => p.main)!;
    const parts = mesh.partsAt(CENTRE)!;
    // Slot of the main body within the Box block: boxes are written in
    // recipe order, and the first building owns block 0.
    const slot = parts.filter((p) => p.kind === PartKind.Box).indexOf(main);
    const c = new THREE.Color();
    mesh.kindMeshes[PartKind.Box].getColorAt(slot, c);
    return c;
  }

  it('recolours the body on an age flip without touching matrices, windows or the sink', () => {
    const { mesh, sink } = setupWithSink();
    mesh.applyDiffs([aged(CENTRE, Zone.Residential, 1, 0)]);
    const boxMesh = mesh.kindMeshes[PartKind.Box];
    const matricesBefore = drawn(boxMesh).map((m) => m.toArray());
    const windowsBefore = mesh.windowCount();
    const colorBefore = bodyColor(mesh);
    sink.calls = [];
    mesh.applyDiffs([aged(CENTRE, Zone.Residential, 1, 2)]);
    expect(drawn(boxMesh).map((m) => m.toArray())).toEqual(matricesBefore);
    expect(mesh.windowCount()).toBe(windowsBefore);
    expect(sink.calls).toEqual([]);
    expect(bodyColor(mesh).getHex()).not.toBe(colorBefore.getHex());
  });

  it('applies the palette age tint before the supply tint, leaving accents alone', () => {
    const { mesh } = setup();
    mesh.setReducedMotion(true);
    mesh.applyDiffs([
      { ...aged(CENTRE, Zone.Residential, 1, 2), supplied: SupplyStatus.Undersupplied } as TileDiff,
    ]);
    const parts = mesh.partsAt(CENTRE)!;
    const main = parts.find((p) => p.main)!;
    const expected = applySupplyTint(
      applyAgeTint(main.color, 2, false, new THREE.Color()),
      SupplyStatus.Undersupplied,
      new THREE.Color(),
    );
    expect(bodyColor(mesh).getHex()).toBe(expected.getHex());
    // The chimney is an accent: same colour at every stage.
    const boxes = parts.filter((p) => p.kind === PartKind.Box);
    const chimneySlot = boxes.findIndex((p) => p.color.getHex() === ACCENT.chimney.getHex());
    expect(chimneySlot).toBeGreaterThanOrEqual(0);
    const chimney = new THREE.Color();
    mesh.kindMeshes[PartKind.Box].getColorAt(chimneySlot, chimney);
    expect(chimney.getHex()).toBe(ACCENT.chimney.getHex());
  });

  it('gives a weathered gable roof the patina and a new one none', () => {
    const { mesh } = setup();
    mesh.setReducedMotion(true);
    // Residential density 2 (town house) always has a gable roof.
    mesh.applyDiffs([aged(CENTRE, Zone.Residential, 2, 0)]);
    const gable = mesh.partsAt(CENTRE)!.find((p) => p.kind === PartKind.GableRoof)!;
    const fresh = new THREE.Color();
    mesh.kindMeshes[PartKind.GableRoof].getColorAt(0, fresh);
    expect(fresh.getHex()).toBe(gable.color.getHex());
    mesh.applyDiffs([aged(CENTRE, Zone.Residential, 2, 2)]);
    const old = new THREE.Color();
    mesh.kindMeshes[PartKind.GableRoof].getColorAt(0, old);
    expect(old.getHex()).toBe(applyAgeTint(gable.color, 2, true, new THREE.Color()).getHex());
  });

  it('treats every pitched roof kind, including the shed roof, as a roof for the patina', () => {
    expect(isRoofKind(PartKind.GableRoof)).toBe(true);
    expect(isRoofKind(PartKind.HipRoof)).toBe(true);
    expect(isRoofKind(PartKind.ShedRoof)).toBe(true);
    expect(isRoofKind(PartKind.Box)).toBe(false);
    expect(isRoofKind(PartKind.Cylinder)).toBe(false);
  });

  it('ages and supply-tints plinths like walls and ridge caps like the roof, never gutters', () => {
    const { mesh } = setup();
    mesh.setReducedMotion(true);
    mesh.applyDiffs([
      { ...aged(CENTRE, Zone.Residential, 2, 2), supplied: SupplyStatus.Undersupplied } as TileDiff,
    ]);
    const boxes = mesh.partsAt(CENTRE)!.filter((p) => p.kind === PartKind.Box);
    const colorOf = (detail: string): [THREE.Color, THREE.Color] => {
      const slot = boxes.findIndex((p) => p.detail === detail);
      expect(slot).toBeGreaterThanOrEqual(0);
      const c = new THREE.Color();
      mesh.kindMeshes[PartKind.Box].getColorAt(slot, c);
      return [boxes[slot].color, c];
    };
    const tint = (color: THREE.Color, roof: boolean) =>
      applySupplyTint(
        applyAgeTint(color, 2, roof, new THREE.Color()),
        SupplyStatus.Undersupplied,
        new THREE.Color(),
      ).getHex();
    const [plinth, plinthDrawn] = colorOf('plinth');
    expect(plinthDrawn.getHex()).toBe(tint(plinth, false));
    const [ridge, ridgeDrawn] = colorOf('ridge');
    expect(ridgeDrawn.getHex()).toBe(tint(ridge, true));
    const [, gutterDrawn] = colorOf('gutter');
    expect(gutterDrawn.getHex()).toBe(ACCENT.gutter.getHex());
  });

  it('a densify returns the tile to stage 0 colours', () => {
    const { mesh } = setup();
    mesh.setReducedMotion(true);
    mesh.applyDiffs([aged(CENTRE, Zone.Commercial, 1, 2)]);
    mesh.applyDiffs([aged(CENTRE, Zone.Commercial, 2, 0)]);
    const main = mesh.partsAt(CENTRE)!.find((p) => p.main)!;
    expect(bodyColor(mesh).getHex()).toBe(main.color.getHex());
  });

  it('ignores a re-sent identical age stage', () => {
    const { mesh } = setup();
    mesh.setReducedMotion(true);
    mesh.applyDiffs([aged(CENTRE, Zone.Retail, 1, 1)]);
    const attr = mesh.kindMeshes[PartKind.Box].instanceColor!;
    attr.clearUpdateRanges();
    mesh.applyDiffs([aged(CENTRE, Zone.Retail, 1, 1)]);
    expect(attr.updateRanges).toEqual([]);
  });

  it('paints the new stage when supply and age flip in the same diff', () => {
    const { mesh } = setup();
    mesh.setReducedMotion(true);
    mesh.applyDiffs([aged(CENTRE, Zone.Residential, 1, 0)]);
    mesh.applyDiffs([
      { ...aged(CENTRE, Zone.Residential, 1, 2), supplied: SupplyStatus.Undersupplied } as TileDiff,
    ]);
    const main = mesh.partsAt(CENTRE)!.find((p) => p.main)!;
    const expected = applySupplyTint(
      applyAgeTint(main.color, 2, false, new THREE.Color()),
      SupplyStatus.Undersupplied,
      new THREE.Color(),
    );
    expect(bodyColor(mesh).getHex()).toBe(expected.getHex());
  });

  it('keeps the age tint when a road beside the building re-issues it', () => {
    const { mesh } = setup();
    mesh.setReducedMotion(true);
    mesh.applyDiffs([aged(CENTRE, Zone.Residential, 1, 2)]);
    mesh.applyDiffs([road(CENTRE + 1)]); // east of the house: face flips South -> East, recipe re-issued
    const main = mesh.partsAt(CENTRE)!.find((p) => p.main)!;
    expect(bodyColor(mesh).getHex()).toBe(
      applyAgeTint(main.color, 2, false, new THREE.Color()).getHex(),
    );
  });
});

describe('BuildingsMesh foundations on sloped ground', () => {
  function rampField(): ElevationField {
    const field = new ElevationField(SIZE);
    const diffs: TileDiff[] = [];
    for (let z = 0; z < SIZE; z++) {
      for (let x = 0; x < SIZE; x++) {
        diffs.push({ index: z * SIZE + x, elevation: x } as TileDiff);
      }
    }
    field.applyDiffs(diffs);
    return field;
  }

  function instances(mesh: THREE.InstancedMesh): { p: THREE.Vector3; s: THREE.Vector3 }[] {
    return drawn(mesh).map((m) => ({
      p: new THREE.Vector3().setFromMatrixPosition(m),
      s: new THREE.Vector3().setFromMatrixScale(m),
    }));
  }

  it('drops every ground-standing part to the lowest ground under its footprint and keeps its top', () => {
    const ramp = rampField();
    const mesh = new BuildingsMesh(new THREE.Scene(), SIZE, ramp);
    mesh.setReducedMotion(true);
    mesh.applyDiffs([building(CENTRE, Zone.Commercial, 3, 0)]);
    const lift = ramp.centerY(CENTRE);
    const cx = 3.5;
    const cz = 3.5;
    let grounded = 0;
    for (const kind of PART_KINDS) {
      const parts = mesh.partsAt(CENTRE)!.filter((p) => p.kind === kind);
      const drawnParts = instances(mesh.kindMeshes[kind]);
      expect(drawnParts).toHaveLength(parts.length);
      for (const part of parts) {
        let expectedY = lift + part.oy;
        let expectedSize = part.sy;
        if (part.oy === 0 && part.tilt === undefined) {
          grounded++;
          const [fx, fz] = part.turn % 2 === 0 ? [part.sx, part.sz] : [part.sz, part.sx];
          const downhill = ramp.surfaceY(cx + part.ox - fx / 2, cz + part.oz - fz / 2);
          expect(downhill).toBeLessThan(lift);
          expectedY = downhill;
          expectedSize = lift + part.sy - downhill;
        }
        const hit = drawnParts.find(
          (i) =>
            Math.abs(i.p.x - (cx + part.ox)) < 1e-6 &&
            Math.abs(i.p.z - (cz + part.oz)) < 1e-6 &&
            Math.abs(i.p.y - expectedY) < 1e-5 &&
            Math.abs(i.s.y - expectedSize) < 1e-5,
        );
        expect(hit, `${part.kind} at ${part.ox},${part.oy},${part.oz}`).toBeDefined();
      }
    }
    expect(grounded).toBeGreaterThan(0);
  });

  it('grows a foundation with the building so the top still rises from the tile centre', () => {
    const ramp = rampField();
    const mesh = new BuildingsMesh(new THREE.Scene(), SIZE, ramp);
    mesh.applyDiffs([building(CENTRE, Zone.Residential, 1, 0)]);
    const main = mesh.partsAt(CENTRE)!.find((p) => p.main)!;
    const lift = ramp.centerY(CENTRE);
    // Boxes are written in recipe order from slot 0, so the main body's slot
    // is its index among the boxes (the plinth below it is wider).
    const slot = mesh
      .partsAt(CENTRE)!
      .filter((p) => p.kind === PartKind.Box)
      .indexOf(main);
    const body = () => instances(mesh.kindMeshes[PartKind.Box])[slot];
    const small = body();
    expect(small.p.y).toBeLessThan(lift);
    expect(small.p.y + small.s.y).toBeLessThan(lift + main.sy * 0.2);
    mesh.update(10);
    const full = body();
    expect(full.p.y + full.s.y).toBeCloseTo(lift + main.sy, 6);
  });

  it('changes nothing on flat ground', () => {
    const { mesh } = setup();
    mesh.setReducedMotion(true);
    mesh.applyDiffs([building(CENTRE, Zone.Retail, 2, 0)]);
    for (const kind of PART_KINDS) {
      const parts = mesh.partsAt(CENTRE)!.filter((p) => p.kind === kind);
      const sizes = instances(mesh.kindMeshes[kind])
        .map((i) => i.s.y)
        .sort((a, b) => a - b);
      const expected = parts.map((p) => p.sy).sort((a, b) => a - b);
      expect(sizes).toHaveLength(expected.length);
      sizes.forEach((size, i) => expect(size).toBeCloseTo(expected[i], 6));
    }
  });
});
