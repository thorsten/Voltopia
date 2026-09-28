import * as THREE from 'three';
import type { TileDiff } from '../shared/types.ts';
import {
  DeliveryState,
  OverlayMode,
  PlantType,
  SERVICE_FIRE,
  SERVICE_POLICE,
  StopState,
  SupplyStatus,
  TileType,
  trafficLevel,
  Zone,
} from '../shared/types.ts';
import type { DiffLayer, RenderEnvironment } from './renderer.ts';
import type { ElevationField } from './elevationField.ts';

const SUPPLY_COLORS: Record<number, number> = {
  [SupplyStatus.Supplied]: 0x4cd964,
  [SupplyStatus.Undersupplied]: 0xffb347,
  [SupplyStatus.NotConnected]: 0xe05263,
};

const SERVICE_COLORS = {
  both: 0x4cd964,
  fireOnly: 0xffb347,
  policeOnly: 0x5b9bd5,
  none: 0xe05263,
};

const TRAFFIC_COLORS = { free: 0x4cd964, busy: 0xf4d35e, slow: 0xffb347, jammed: 0xe05263 };

const DELIVERY_COLORS = {
  [DeliveryState.Supplied]: 0x4cd964,
  [DeliveryState.Due]: 0xffb347,
  [DeliveryState.Unsupplied]: 0xe05263,
  depot: 0x5b9bd5,
} as const;

const TRANSIT_COLORS = {
  [StopState.Served]: 0x4cd964,
  [StopState.Due]: 0xffb347,
  [StopState.Unserved]: 0xe05263,
  covered: 0x8fd6a4,
  uncovered: 0x6b7280,
  depot: 0x5b9bd5,
} as const;

const DAMAGE_COLORS = { intact: 0x4cd964, light: 0xffb347, heavy: 0xe05263 } as const;

/** Overlay colour of a tile by its damage points. */
export function damageColor(damage: number): number {
  if (damage === 0) return DAMAGE_COLORS.intact;
  return damage < 128 ? DAMAGE_COLORS.light : DAMAGE_COLORS.heavy;
}

interface OverlayTile {
  zone: Zone;
  density: number;
  supplied: SupplyStatus;
  tileType: TileType;
  services: number;
  trafficLoad: number;
  deliveryState: number;
  plantType: PlantType;
  busStop: number;
  stopState: number;
  transitCover: number;
  damage: number;
}

/**
 * Toggleable color maps over the city: supply status of every building,
 * growth demand tinting all zoned tiles, fire/police service coverage of
 * every building, per-tile traffic congestion on roads, delivery status
 * of shops and depots, or bus coverage and stop service.
 */
export class OverlaysMesh implements DiffLayer {
  private readonly mesh: THREE.InstancedMesh;
  private readonly gridSize: number;
  private readonly tiles = new Map<number, OverlayTile>();
  private mode: OverlayMode = OverlayMode.None;
  private demand = { residential: 0, commercial: 0, retail: 0 };
  private readonly matrix = new THREE.Matrix4();
  private readonly color = new THREE.Color();

  constructor(
    scene: THREE.Scene,
    gridSize: number,
    private readonly elevation: ElevationField,
  ) {
    this.gridSize = gridSize;
    const geometry = new THREE.PlaneGeometry(0.96, 0.96).rotateX(-Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    this.mesh = new THREE.InstancedMesh(geometry, material, gridSize * gridSize);
    // Instance transforms live across the whole grid; the base geometry's
    // bounds would wrongly cull the mesh, so culling is disabled.
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.renderOrder = 2;
    scene.add(this.mesh);
  }

  setMode(mode: OverlayMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.rebuild();
  }

  setEnvironment(environment: RenderEnvironment): void {
    this.demand = environment.demand;
    if (this.mode === OverlayMode.Demand) this.rebuild();
  }

  applyDiffs(diffs: TileDiff[]): void {
    for (const diff of diffs) {
      if (
        diff.zone !== Zone.None ||
        diff.density > 0 ||
        diff.tileType === TileType.Road ||
        diff.plantType === PlantType.LogisticsDepot ||
        diff.plantType === PlantType.BusDepot ||
        diff.damage > 0
      ) {
        this.tiles.set(diff.index, {
          zone: diff.zone,
          density: diff.density,
          supplied: diff.supplied,
          tileType: diff.tileType,
          services: diff.services,
          trafficLoad: diff.trafficLoad,
          deliveryState: diff.deliveryState,
          plantType: diff.plantType,
          busStop: diff.busStop,
          stopState: diff.stopState,
          transitCover: diff.transitCover,
          damage: diff.damage,
        });
      } else {
        this.tiles.delete(diff.index);
      }
    }
    if (this.mode !== OverlayMode.None) this.rebuild();
  }

  private demandFor(zone: Zone): number {
    switch (zone) {
      case Zone.Residential:
        return this.demand.residential;
      case Zone.Commercial:
        return this.demand.commercial;
      case Zone.Retail:
        return this.demand.retail;
      default:
        return 0;
    }
  }

  private rebuild(): void {
    let slot = 0;
    if (this.mode !== OverlayMode.None) {
      for (const [index, tile] of this.tiles) {
        let colorHex: number | null = null;
        if (this.mode === OverlayMode.Supply) {
          if (tile.tileType === TileType.Empty && tile.density > 0) {
            colorHex = SUPPLY_COLORS[tile.supplied] ?? null;
          }
        } else if (this.mode === OverlayMode.Demand) {
          if (tile.tileType === TileType.Empty && tile.zone !== Zone.None) {
            const demand = this.demandFor(tile.zone);
            // Hue from red (negative demand) over yellow to green (high).
            this.color.setHSL(THREE.MathUtils.clamp((0.33 * (demand + 1)) / 2, 0, 0.33), 0.85, 0.5);
            colorHex = this.color.getHex();
          }
        } else if (this.mode === OverlayMode.Services) {
          if (tile.tileType === TileType.Empty && tile.density > 0) {
            const fire = (tile.services & SERVICE_FIRE) !== 0;
            const police = (tile.services & SERVICE_POLICE) !== 0;
            colorHex =
              fire && police
                ? SERVICE_COLORS.both
                : fire
                  ? SERVICE_COLORS.fireOnly
                  : police
                    ? SERVICE_COLORS.policeOnly
                    : SERVICE_COLORS.none;
          }
        } else if (this.mode === OverlayMode.Traffic) {
          if (tile.tileType === TileType.Road) {
            const level = trafficLevel(tile.trafficLoad);
            colorHex =
              level <= 1
                ? TRAFFIC_COLORS.free
                : level <= 4
                  ? TRAFFIC_COLORS.busy
                  : level <= 6
                    ? TRAFFIC_COLORS.slow
                    : TRAFFIC_COLORS.jammed;
          }
        } else if (this.mode === OverlayMode.Deliveries) {
          if (tile.tileType === TileType.Plant && tile.plantType === PlantType.LogisticsDepot) {
            colorHex = DELIVERY_COLORS.depot;
          } else if (
            tile.tileType === TileType.Empty &&
            tile.zone === Zone.Retail &&
            tile.density > 0
          ) {
            colorHex = DELIVERY_COLORS[tile.deliveryState as DeliveryState] ?? null;
          }
        } else if (this.mode === OverlayMode.Transit) {
          if (tile.tileType === TileType.Plant && tile.plantType === PlantType.BusDepot) {
            colorHex = TRANSIT_COLORS.depot;
          } else if (tile.tileType === TileType.Road) {
            colorHex =
              tile.busStop !== 0
                ? (TRANSIT_COLORS[tile.stopState as StopState] ?? null)
                : tile.transitCover !== 0
                  ? TRANSIT_COLORS.covered
                  : TRANSIT_COLORS.uncovered;
          }
        } else if (this.mode === OverlayMode.Damage) {
          // Every tile that can break shows its state, so the player can
          // see at a glance what the storm took out. `tile.damage > 0` alone
          // already reaches a wrecked pylon on otherwise-empty ground: the
          // damage layer is per-tile, not per-building, and applyDiffs above
          // tracks any damaged tile regardless of what else is on it.
          if (
            tile.damage > 0 ||
            (tile.tileType === TileType.Empty && tile.density > 0) ||
            tile.tileType === TileType.Plant
          ) {
            colorHex = damageColor(tile.damage);
          }
        }
        if (colorHex === null) continue;
        this.matrix.setPosition(
          (index % this.gridSize) + 0.5,
          0.07 + this.elevation.maxCornerY(index),
          Math.floor(index / this.gridSize) + 0.5,
        );
        this.mesh.setMatrixAt(slot, this.matrix);
        this.mesh.setColorAt(slot, this.color.setHex(colorHex));
        slot++;
      }
    }
    this.mesh.count = slot;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
