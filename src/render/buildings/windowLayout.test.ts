import { describe, expect, it } from 'vitest';
import { Zone } from '../../shared/types.ts';
import { PartKind } from './primitives.ts';
import {
  type BuildingPart,
  STREET_FACES,
  type StreetFace,
  buildingParts,
  faceOffset,
  silhouetteOf,
} from './recipes.ts';
import { WINDOW_FRAME_SCALE, WINDOW_SILL_DROP } from './windows.ts';
import { WINDOWS_PER_TILE, type WindowSlot, layoutWindows, windowBodies } from './windowLayout.ts';

const VARIANTS = 8;
const SAMPLE = Array.from({ length: 64 }, (_, i) => i * 61 + 7);
const ZONES = [Zone.Residential, Zone.Commercial, Zone.Retail, Zone.Industrial];
const EPS = 1e-6;

function* allBuildings(): Generator<{
  tag: string;
  name: string;
  zone: Zone;
  density: number;
  face: StreetFace;
  parts: BuildingPart[];
  slots: WindowSlot[];
}> {
  for (const zone of ZONES) {
    for (const density of [1, 2, 3]) {
      for (let variant = 0; variant < VARIANTS; variant++) {
        for (const index of SAMPLE) {
          const name = silhouetteOf(zone, density, variant, index);
          for (const face of STREET_FACES) {
            const parts = buildingParts(zone, density, variant, index, face);
            yield {
              tag: `${zone}/${density}/${name}/v${variant}/f${face}/${index}`,
              name,
              zone,
              density,
              face,
              parts,
              slots: layoutWindows(parts, face, zone, density),
            };
          }
        }
      }
    }
  }
}

/** World-axis extents of a part: [min, max] along x, y and z. */
function extents(p: BuildingPart): {
  x: [number, number];
  y: [number, number];
  z: [number, number];
} {
  const [hx, hz] = p.turn % 2 === 0 ? [p.sx / 2, p.sz / 2] : [p.sz / 2, p.sx / 2];
  return {
    x: [p.ox - hx, p.ox + hx],
    y: [p.oy, p.oy + p.sy],
    z: [p.oz - hz, p.oz + hz],
  };
}

/** Range of a part along the world axis of a unit direction (±x or ±z). */
function along(p: BuildingPart, dir: [number, number]): [number, number] {
  const e = extents(p);
  const [a, b] = dir[0] !== 0 ? e.x : e.z;
  const sign = dir[0] !== 0 ? dir[0] : dir[1];
  return sign > 0 ? [a, b] : [-b, -a];
}

/** The window body whose facade carries `slot` (plane and span match). */
function hostOf(parts: readonly BuildingPart[], slot: WindowSlot): BuildingPart | undefined {
  const normal = faceOffset(0, 1, slot.face);
  const tangent = faceOffset(1, 0, slot.face);
  const plane = slot.x * normal[0] + slot.z * normal[1];
  const lateral = slot.x * tangent[0] + slot.z * tangent[1];
  return windowBodies(parts).find((b) => {
    const n = along(b, normal);
    const t = along(b, tangent);
    return (
      Math.abs(n[1] - plane) < EPS &&
      lateral > t[0] &&
      lateral < t[1] &&
      slot.y > b.oy &&
      slot.y < b.oy + b.sy
    );
  });
}

describe('window layout', () => {
  it(`never lays out more than ${WINDOWS_PER_TILE} windows on any silhouette`, () => {
    const most = new Map<string, number>();
    for (const { name, slots } of allBuildings()) {
      most.set(name, Math.max(most.get(name) ?? 0, slots.length));
    }
    for (const [name, count] of most) {
      expect(count, name).toBeLessThanOrEqual(WINDOWS_PER_TILE);
    }
    // The stepped block (lower block plus the top storey) fills the budget exactly.
    expect(most.get('steppedBlock')).toBe(WINDOWS_PER_TILE);
  });

  it('gives every flagged secondary body windows of its own', () => {
    const expected = new Set(['semiDetached', 'lHouse', 'steppedBlock', 'shopWithFlat']);
    const flaggedIn = new Set<string>();
    const violations: string[] = [];
    for (const { tag, name, parts, slots } of allBuildings()) {
      const secondary = windowBodies(parts).slice(1);
      if (secondary.length === 0) continue;
      flaggedIn.add(name);
      for (const body of secondary) {
        const own = slots.filter((s) => hostOf(parts, s) === body);
        if (own.length === 0) violations.push(`${tag}: a flagged body without windows`);
      }
    }
    expect(violations).toEqual([]);
    expect([...flaggedIn].sort()).toEqual([...expected].sort());
  });

  it('keeps the L-house wing windows off its buried street face', () => {
    for (const { tag, name, face, parts, slots } of allBuildings()) {
      if (name !== 'lHouse') continue;
      const wing = windowBodies(parts)[1];
      for (const s of slots.filter((slot) => hostOf(parts, slot) === wing)) {
        expect(s.face, tag).toBe((face + 2) % 4);
      }
    }
  });

  it('never lays out a frame that another body, bay, canopy, sign or door cuts', () => {
    // An occluder: any upright, non-detail Box or shed roof except the
    // window's own body and the facade bands (balconies, ledges) windows
    // deliberately run behind, touching the facade plane.
    const violations: string[] = [];
    let checked = 0;
    for (const { tag, parts, slots } of allBuildings()) {
      for (const slot of slots) {
        if (slot.shopfront) continue;
        const host = hostOf(parts, slot);
        if (!host) {
          violations.push(`${tag}: window off every window body`);
          continue;
        }
        checked++;
        const normal = faceOffset(0, 1, slot.face);
        const tangent = faceOffset(1, 0, slot.face);
        const plane = slot.x * normal[0] + slot.z * normal[1];
        const lateral = slot.x * tangent[0] + slot.z * tangent[1];
        const halfWidth = (WINDOW_FRAME_SCALE * slot.width) / 2;
        const bottom = slot.y - slot.height / 2 - WINDOW_SILL_DROP * slot.height;
        const top = slot.y + slot.height / 2 + ((WINDOW_FRAME_SCALE - 1) / 2) * slot.height;
        for (const p of parts) {
          if (p === host || p.detail || p.band || p.tilt !== undefined) continue;
          if (p.kind !== PartKind.Box && p.kind !== PartKind.ShedRoof) continue;
          const n = along(p, normal);
          if (n[0] > plane + EPS || n[1] < plane - EPS) continue;
          const t = along(p, tangent);
          const cut =
            t[0] < lateral + halfWidth - EPS &&
            t[1] > lateral - halfWidth + EPS &&
            p.oy < top - EPS &&
            p.oy + p.sy > bottom + EPS;
          if (cut) violations.push(`${tag}: frame at ${lateral.toFixed(3)} cut by a part`);
        }
      }
    }
    expect(violations.slice(0, 10)).toEqual([]);
    expect(checked).toBeGreaterThan(0);
  });
});
