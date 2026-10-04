import { describe, expect, it } from 'vitest';
import { Zone } from '../../shared/types.ts';
import { PartRole, StreetFace, buildingParts } from './recipes.ts';
import { accentAnchors } from './accents.ts';

describe('accentAnchors', () => {
  it('places the chimney anchor at the chimney top, offset from the tile centre and lifted', () => {
    const parts = buildingParts(Zone.Residential, 1, 0, 11, StreetFace.South);
    const chimney = parts.find((p) => p.role === PartRole.Chimney)!;
    const anchors = accentAnchors(parts, 3.5, 7.5, 0.4);
    expect(anchors).toHaveLength(1);
    expect(anchors[0].role).toBe(PartRole.Chimney);
    expect(anchors[0].x).toBeCloseTo(3.5 + chimney.ox, 9);
    expect(anchors[0].z).toBeCloseTo(7.5 + chimney.oz, 9);
    expect(anchors[0].y).toBeCloseTo(0.4 + chimney.oy + chimney.sy, 9);
  });

  it('returns both vents of a market hall and nothing for an untagged recipe', () => {
    const hall = buildingParts(Zone.Retail, 3, 2, 5, StreetFace.East);
    expect(accentAnchors(hall, 0.5, 0.5, 0).map((a) => a.role)).toEqual([
      PartRole.Vent,
      PartRole.Vent,
    ]);
    const shop = buildingParts(Zone.Retail, 1, 2, 5, StreetFace.East);
    expect(accentAnchors(shop, 0.5, 0.5, 0)).toEqual([]);
  });
});
