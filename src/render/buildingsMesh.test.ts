import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { TileDiff } from '../shared/types.ts';
import { HEATED_SERVED, SupplyStatus, TileType, Zone } from '../shared/types.ts';
import { ElevationField } from './elevationField.ts';
import { BuildingsMesh, isRoofKind } from './buildingsMesh.ts';
import { PART_KINDS, PartKind } from './buildings/primitives.ts';
import { ACCENT, applyAgeTint, applySupplyTint } from './buildings/palette.ts';
import {
  DOOR,
  MAX_PARTS_PER_KIND,
  PLINTH_HEIGHT,
  PartRole,
  StreetFace,
  faceDepth,
  silhouetteOf,
} from './buildings/recipes.ts';
import { type AccentAnchor, type AccentSink, type AccentState } from './buildings/accents.ts';
import {
  WINDOW_FRAME_SCALE,
  WINDOW_PROUD,
  WINDOW_SILL_DROP,
  windowGeometry,
} from './buildings/windows.ts';
import { WINDOW_HEIGHT, WINDOW_WIDTH } from './buildings/windowLayout.ts';

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

/** The first variant that builds `silhouette` on the centre tile. */
function variantOf(zone: Zone, density: number, silhouette: string): number {
  const variant = Array.from({ length: 8 }, (_, v) => v).find(
    (v) => silhouetteOf(zone, density, v, CENTRE) === silhouette,
  );
  if (variant === undefined) throw new Error(`no ${silhouette} variant on the centre tile`);
  return variant;
}

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
    // Kind meshes, the night glow quads and the window frames.
    expect(instanced).toHaveLength(PART_KINDS.length + 2);
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
    // The detached house keeps its door centred on the facade.
    const variant = variantOf(Zone.Residential, 1, 'detached');
    mesh.applyDiffs([building(CENTRE, Zone.Residential, 1, variant)]);
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

  it.each(['shop', 'canopyShop'])('keeps the retail shopfront quad below the %s shade', (name) => {
    const { scene, mesh } = setup();
    mesh.setReducedMotion(true);
    const variant = variantOf(Zone.Retail, 1, name);
    mesh.applyDiffs([building(CENTRE, Zone.Retail, 1, variant), road(CENTRE + SIZE)]);
    const parts = mesh.partsAt(CENTRE)!;
    const main = parts.find((p) => p.main)!;
    // An awning (thin accent slab) or the canopy shop's shed canopy.
    const awning = parts.find(
      (p) =>
        ((p.accent && p.kind === PartKind.Box && p.sy <= 0.05) || p.kind === PartKind.ShedRoof) &&
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

  describe('window frames', () => {
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

    /** The night glow quads: the one extra instanced mesh that is neither a kind mesh nor the frames. */
    function glowMesh(scene: THREE.Scene, mesh: BuildingsMesh): THREE.InstancedMesh {
      return scene.children.find(
        (c): c is THREE.InstancedMesh =>
          c instanceof THREE.InstancedMesh &&
          !mesh.kindMeshes.includes(c) &&
          c !== mesh.windowFramesMesh,
      )!;
    }

    /** Laid-out slots of a doorless main body: cols × rows on the street face and its opposite. */
    function expectedSlots(main: { sx: number; sy: number }): number {
      const cols = Math.min(3, Math.max(1, Math.round(main.sx / 0.24)));
      const rows = Math.min(4, Math.max(1, Math.round(main.sy / 0.28)));
      return 2 * cols * rows;
    }

    it('is a lit, culling-free, shadow-receiving mesh', () => {
      const { scene, mesh } = setup();
      const frames = mesh.windowFramesMesh;
      expect(scene.children).toContain(frames);
      expect(frames.frustumCulled).toBe(false);
      expect(frames.castShadow).toBe(false);
      expect(frames.receiveShadow).toBe(true);
      expect(frames.material).toBeInstanceOf(THREE.MeshStandardMaterial);
      expect((frames.material as THREE.MeshStandardMaterial).vertexColors).toBe(true);
      expect(frames.instanceMatrix.count).toBe(SIZE * SIZE * 24);
    });

    it('frames every laid-out window, dark ones included, and stays visible by day', () => {
      const { scene, mesh } = setup();
      mesh.setReducedMotion(true);
      mesh.applyDiffs([building(CENTRE, Zone.Residential, 3, 0)]);
      const main = mesh.partsAt(CENTRE)!.find((p) => p.main)!;
      const frames = mesh.windowFramesMesh;
      expect(frames.count).toBe(expectedSlots(main));
      // ~1/3 of the windows are dark: they keep a frame but get no glow.
      expect(mesh.windowCount()).toBeLessThan(frames.count);
      expect(mesh.windowCount()).toBeGreaterThan(0);
      mesh.setEnvironment(env(0));
      expect(frames.visible).toBe(true);
      const glow = glowMesh(scene, mesh);
      expect(glow.visible).toBe(false);
      mesh.setEnvironment(env(1));
      expect(frames.visible).toBe(true);
      expect(glow.visible).toBe(true);
    });

    it('mounts frames on the facade with the glow quad between glass and mullions', () => {
      const geometry = windowGeometry();
      const z = geometry.getAttribute('position');
      const layers = new Set<number>();
      for (let i = 0; i < z.count; i++) layers.add(Math.round(z.getZ(i) / WINDOW_PROUD));
      expect([...layers]).toEqual(expect.arrayContaining([2, 3]));
      const glassZ = 2 * WINDOW_PROUD;
      const mullionZ = 3 * WINDOW_PROUD;
      const { scene, mesh } = setup();
      mesh.setReducedMotion(true);
      mesh.applyDiffs([building(CENTRE, Zone.Residential, 3, 0)]);
      const main = mesh.partsAt(CENTRE)!.find((p) => p.main)!;
      const cz = 3 + 0.5 + main.oz;
      const m = new THREE.Matrix4();
      const p = new THREE.Vector3();
      const s = new THREE.Vector3();
      const frameZ = new Set<number>();
      for (let i = 0; i < mesh.windowFramesMesh.count; i++) {
        mesh.windowFramesMesh.getMatrixAt(i, m);
        p.setFromMatrixPosition(m);
        s.setFromMatrixScale(m);
        expect(s.x).toBeCloseTo(WINDOW_WIDTH, 6);
        expect(s.y).toBeCloseTo(WINDOW_HEIGHT, 6);
        expect(Math.abs(Math.abs(p.z - cz) - main.sz / 2)).toBeLessThan(1e-6);
        frameZ.add(Math.round(p.z * 1e4));
      }
      const glow = glowMesh(scene, mesh);
      for (let i = 0; i < glow.count; i++) {
        glow.getMatrixAt(i, m);
        p.setFromMatrixPosition(m);
        // Over the glass but behind the mullion cross, so the cross reads at night.
        const proud = Math.abs(p.z - cz) - main.sz / 2;
        expect(proud).toBeGreaterThan(glassZ + 1e-6);
        expect(proud).toBeLessThan(mullionZ - 1e-6);
      }
      expect(frameZ.size).toBe(2); // street face and its opposite
    });

    it('gives an unsupplied building frames but no glow', () => {
      const { mesh } = setup();
      mesh.setReducedMotion(true);
      mesh.applyDiffs([building(CENTRE, Zone.Residential, 3, 0, SupplyStatus.NotConnected)]);
      const main = mesh.partsAt(CENTRE)!.find((p) => p.main)!;
      expect(mesh.windowFramesMesh.count).toBe(expectedSlots(main));
      expect(mesh.windowCount()).toBe(0);
    });

    it('frames a retail shopfront with one instance scaled to the shopfront', () => {
      const { scene, mesh } = setup();
      mesh.setReducedMotion(true);
      mesh.applyDiffs([building(CENTRE, Zone.Retail, 1, 0), road(CENTRE + SIZE)]);
      const main = mesh.partsAt(CENTRE)!.find((p) => p.main)!;
      const cz = 3 + 0.5 + main.oz;
      const m = new THREE.Matrix4();
      const p = new THREE.Vector3();
      const s = new THREE.Vector3();
      const street: Array<{ p: THREE.Vector3; s: THREE.Vector3 }> = [];
      for (let i = 0; i < mesh.windowFramesMesh.count; i++) {
        mesh.windowFramesMesh.getMatrixAt(i, m);
        p.setFromMatrixPosition(m);
        s.setFromMatrixScale(m);
        if (p.z > cz) street.push({ p: p.clone(), s: s.clone() });
      }
      expect(street).toHaveLength(1);
      expect(street[0].s.x).toBeCloseTo(main.sx * 0.8, 6);
      // Glass top stays at 0.55h, below the 0.6h awning.
      expect(street[0].p.y + street[0].s.y).toBeCloseTo(main.oy + main.sy * 0.55, 6);
      // The glow quad covers exactly that glass.
      const glow = glowMesh(scene, mesh);
      let glowCentre: number | undefined;
      for (let i = 0; i < glow.count; i++) {
        glow.getMatrixAt(i, m);
        p.setFromMatrixPosition(m);
        s.setFromMatrixScale(m);
        if (p.z > cz) {
          glowCentre = p.y;
          expect(s.y * WINDOW_HEIGHT).toBeCloseTo(street[0].s.y, 6);
        }
      }
      expect(glowCentre).toBeCloseTo(street[0].p.y + street[0].s.y / 2, 6);
    });

    it('keeps every retail d1-d2 shopfront sill clear of the plinth', () => {
      for (const density of [1, 2]) {
        for (let variant = 0; variant < 8; variant++) {
          const { mesh } = setup();
          mesh.setReducedMotion(true);
          mesh.applyDiffs([building(CENTRE, Zone.Retail, density, variant), road(CENTRE + SIZE)]);
          const main = mesh.partsAt(CENTRE)!.find((p) => p.main)!;
          const cz = 3 + 0.5 + main.oz;
          const m = new THREE.Matrix4();
          const p = new THREE.Vector3();
          const s = new THREE.Vector3();
          let shopfronts = 0;
          for (let i = 0; i < mesh.windowFramesMesh.count; i++) {
            mesh.windowFramesMesh.getMatrixAt(i, m);
            p.setFromMatrixPosition(m);
            s.setFromMatrixScale(m);
            // The street face only; the flat above a shop has its own windows.
            if (p.z <= cz || p.y >= main.oy + main.sy) continue;
            shopfronts++;
            const sillBottom = p.y - WINDOW_SILL_DROP * s.y;
            expect(sillBottom, `d${density} v${variant}`).toBeGreaterThanOrEqual(
              main.oy + PLINTH_HEIGHT - 1e-6,
            );
          }
          expect(shopfronts, `d${density} v${variant}`).toBe(1);
        }
      }
    });

    it('never overlaps two window frames on one facade (residential with doors, all faces)', () => {
      const frameHalfWidth = (WINDOW_FRAME_SCALE * WINDOW_WIDTH) / 2;
      const frameAbove = (WINDOW_FRAME_SCALE - 1) / 2; // frame border above the glass, glass units
      const roadFor = [CENTRE + SIZE, CENTRE + 1, CENTRE - SIZE, CENTRE - 1];
      const m = new THREE.Matrix4();
      const p = new THREE.Vector3();
      const s = new THREE.Vector3();
      const lateral = new THREE.Vector3();
      const normal = new THREE.Vector3();
      for (const density of [1, 2]) {
        for (let variant = 0; variant < 8; variant++) {
          for (const roadIndex of roadFor) {
            const { mesh } = setup();
            mesh.setReducedMotion(true);
            mesh.applyDiffs([
              building(CENTRE, Zone.Residential, density, variant),
              road(roadIndex),
            ]);
            const facades = new Map<string, Array<{ x: number; y0: number; y1: number }>>();
            for (let i = 0; i < mesh.windowFramesMesh.count; i++) {
              mesh.windowFramesMesh.getMatrixAt(i, m);
              p.setFromMatrixPosition(m);
              s.setFromMatrixScale(m);
              m.extractBasis(lateral, new THREE.Vector3(), normal);
              lateral.normalize();
              normal.normalize();
              const key = `${normal.x.toFixed(3)},${normal.z.toFixed(3)},${p.dot(normal).toFixed(4)}`;
              const list = facades.get(key) ?? [];
              list.push({
                x: p.dot(lateral),
                y0: p.y - WINDOW_SILL_DROP * s.y,
                y1: p.y + (1 + frameAbove) * s.y,
              });
              facades.set(key, list);
            }
            const label = `d${density} v${variant} road ${roadIndex}`;
            // Street face and its opposite, plus the planes of any secondary
            // window bodies (L-house wing, semi-detached half).
            expect(facades.size, label).toBeGreaterThanOrEqual(2);
            for (const frames of facades.values()) {
              for (let a = 0; a < frames.length; a++) {
                for (let b = a + 1; b < frames.length; b++) {
                  const fa = frames[a];
                  const fb = frames[b];
                  const overlaps =
                    Math.abs(fa.x - fb.x) < 2 * frameHalfWidth - 1e-6 &&
                    fa.y0 < fb.y1 - 1e-6 &&
                    fb.y0 < fa.y1 - 1e-6;
                  expect(overlaps, label).toBe(false);
                }
              }
            }
          }
        }
      }
    });

    it('drops frames and glow together when the building is removed', () => {
      const { mesh } = setup();
      mesh.setReducedMotion(true);
      mesh.applyDiffs([building(CENTRE, Zone.Residential, 2, 0)]);
      expect(mesh.windowFramesMesh.count).toBeGreaterThan(0);
      mesh.applyDiffs([empty(CENTRE)]);
      expect(mesh.windowFramesMesh.count).toBe(0);
      expect(mesh.windowCount()).toBe(0);
    });
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

  /** World corners of a drawn unit-box instance at local y = 0 (its underside). */
  function undersideCorners(m: THREE.Matrix4): THREE.Vector3[] {
    return [-0.5, 0.5].flatMap((x) =>
      [-0.5, 0.5].map((z) => new THREE.Vector3(x, 0, z).applyMatrix4(m)),
    );
  }

  /** The drawn Box instance whose recipe part is `part` (Boxes are written in recipe order). */
  function drawnBox(mesh: BuildingsMesh, part: object): THREE.Matrix4 {
    const boxes = mesh.partsAt(CENTRE)!.filter((p) => p.kind === PartKind.Box);
    return drawn(mesh.kindMeshes[PartKind.Box])[boxes.indexOf(part as (typeof boxes)[number])];
  }

  /** The matrix a part would get on flat ground at the tile's centre height. */
  function flatMatrix(
    part: {
      ox: number;
      oy: number;
      oz: number;
      sx: number;
      sy: number;
      sz: number;
      turn: number;
      tilt?: number;
    },
    lift: number,
  ): THREE.Matrix4 {
    return new THREE.Matrix4().compose(
      new THREE.Vector3(3.5 + part.ox, lift + part.oy, 3.5 + part.oz),
      new THREE.Quaternion().setFromEuler(
        new THREE.Euler(part.tilt ?? 0, part.turn * (Math.PI / 2), 0, 'YXZ'),
      ),
      new THREE.Vector3(part.sx, part.sy, part.sz),
    );
  }

  it.each([
    ['south', CENTRE + SIZE],
    ['east', CENTRE + 1],
    ['west', CENTRE - 1],
    ['north', CENTRE - SIZE],
  ])(
    'pins a ground-touching tilted ramp (lean-to hall, %s face) to the ground, its top end at the door',
    (_, roadIndex) => {
      const field = rampField();
      const mesh = new BuildingsMesh(new THREE.Scene(), SIZE, field);
      mesh.setReducedMotion(true);
      const variant = variantOf(Zone.Industrial, 1, 'leanToHall');
      mesh.applyDiffs([road(roadIndex), building(CENTRE, Zone.Industrial, 1, variant)]);
      const lift = field.centerY(CENTRE);
      const ramp = mesh.partsAt(CENTRE)!.find((p) => p.kind === PartKind.Box && (p.tilt ?? 0) > 0)!;
      expect(ramp).toBeDefined();
      const corners = undersideCorners(drawnBox(mesh, ramp));
      const flat = undersideCorners(flatMatrix(ramp, lift));
      // The flat ramp's two low corners are its foot, the two high ones its top end.
      const order = flat.map((_, i) => i).sort((a, b) => flat[a].y - flat[b].y);
      const foot = order.slice(0, 2).map((i) => corners[i]);
      const head = order.slice(2).map((i) => corners[i]);
      const gaps = foot.map((c) => c.y - field.surfaceY(c.x, c.z));
      // Nothing floats; the lower foot corner touches the ground (the other
      // sinks in by the cross slope only, like a foundation's uphill side).
      for (const g of gaps) expect(g).toBeLessThan(1e-6);
      expect(Math.max(...gaps)).toBeGreaterThan(-1e-6);
      // The top end keeps its place against the door slab, at plinth height.
      for (const [k, i] of order.slice(2).entries()) {
        expect(head[k].distanceTo(flat[i])).toBeLessThan(1e-6);
        expect(head[k].y).toBeCloseTo(lift + PLINTH_HEIGHT, 6);
      }
      // The sample really is sloped under the foot.
      const flatGaps = order
        .slice(0, 2)
        .map((i) => flat[i].y - field.surfaceY(flat[i].x, flat[i].z));
      expect(Math.max(...flatGaps.map(Math.abs))).toBeGreaterThan(0.05);
    },
  );

  it('leaves tilted rooftop PV where the recipe puts it on sloped ground', () => {
    const field = rampField();
    const mesh = new BuildingsMesh(new THREE.Scene(), SIZE, field);
    mesh.setReducedMotion(true);
    mesh.applyDiffs([
      building(CENTRE, Zone.Industrial, 2, variantOf(Zone.Industrial, 2, 'loadingDock')),
    ]);
    const lift = field.centerY(CENTRE);
    const pv = mesh.partsAt(CENTRE)!.find((p) => p.tilt !== undefined)!;
    expect(pv.color.getHex()).toBe(ACCENT.rooftopPv.getHex());
    const drawnPv = drawnBox(mesh, pv).elements;
    const expected = flatMatrix(pv, lift).elements;
    drawnPv.forEach((e, i) => expect(e).toBeCloseTo(expected[i], 6));
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
