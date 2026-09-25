import { describe, expect, it } from 'vitest';
import { PlantType, SupplyStatus, Terrain, TileType, Zone } from '../shared/types.ts';
import { SimEngine } from '../sim/engine.ts';
import { TileMirror } from './tileMirror.ts';

describe('TileMirror', () => {
  it('mirrors the full grid from the first tick and follows later diffs', () => {
    const engine = new SimEngine(7, 16);
    engine.applyCommand({ type: 'init', seed: 7, size: 16 });
    const mirror = new TileMirror(16);
    const first = engine.tick();
    if (first.type !== 'tick') throw new Error('expected tick');
    mirror.applyDiffs(first.diffs);
    // A new game only diffs the generated water; untouched land tiles stay
    // at the all-zero default, which is exactly what the sim holds too.
    expect(mirror.updates).toBeGreaterThan(0);
    expect(Array.from(mirror.terrain)).toEqual(Array.from(engine.state.layers.terrain));

    // Find a land tile, pave it and check the mirror tracks the change.
    const land = Array.from(engine.state.layers.terrain).findIndex((t) => t === Terrain.Land);
    engine.applyCommand({ type: 'buildRoad', tiles: [land] });
    const flushed = engine.flush();
    if (!flushed || flushed.type !== 'tick') throw new Error('expected flush');
    mirror.applyDiffs(flushed.diffs);
    const tile = mirror.at(land % 16, Math.floor(land / 16));
    expect(tile.tileType).toBe(TileType.Road);
    expect(tile.zone).toBe(Zone.None);
    expect(tile.plantType).toBe(PlantType.None);
    expect(tile.supplied).toBe(SupplyStatus.NotConnected);
    expect(tile.index).toBe(land);
  });

  it('ignores out-of-range diffs and reports bounds', () => {
    const mirror = new TileMirror(4);
    mirror.applyDiffs([
      {
        index: 99,
        tileType: TileType.Road,
        roadMask: 0,
        roadClass: 0,
        forest: 0,
        geothermal: 0,
        reservoirHeat: 0,
        trafficLoad: 0,
        powerLine: 0,
        zone: Zone.None,
        density: 0,
        variant: 0,
        supplied: SupplyStatus.NotConnected,
        services: 0,
        plantType: PlantType.None,
        terrain: Terrain.Land,
        elevation: 0,
        deliveryState: 0,
        busStop: 0,
        stopState: 0,
        transitCover: 0,
      },
    ]);
    expect(Array.from(mirror.tileType)).toEqual(Array.from({ length: 16 }, () => 0));
    expect(mirror.inBounds(3, 3)).toBe(true);
    expect(mirror.inBounds(4, 0)).toBe(false);
    expect(mirror.inBounds(-1, 0)).toBe(false);
  });
});
