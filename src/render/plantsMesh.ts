import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { TileDiff } from '../shared/types.ts';
import { PlantType, Terrain, TileType } from '../shared/types.ts';
import type { DiffLayer, RenderEnvironment } from './renderer.ts';
import type { ElevationField } from './elevationField.ts';
import { composePrismOnGround, createHalfTilePrism } from './decal.ts';
import { surfaceMaterial } from './materials.ts';

const MAX_BOX_PARTS_PER_PLANT = 8;
const ROTOR_MAX_SPEED_RAD_PER_S = 6;
const HUB_HEIGHT = 0.85;
const DOME_RADIUS = 0.3;
const DOME_SQUASH = 0.75;
const DOME_BASE = 0.12;
const BIOGAS_DOME_TOP = DOME_BASE + DOME_RADIUS * DOME_SQUASH;
/** Park lawn: a near-full-tile decal, thin like a road pad. */
const PARK_PAD_SIZE = 0.94;
const PARK_PAD_HEIGHT = 0.03;

export interface BoxPart {
  sx: number;
  sy: number;
  sz: number;
  ox: number;
  oy: number;
  oz: number;
  color: number;
  /** Rotation around the x axis (e.g. tilted solar panels). */
  rotX?: number;
}

const COLORS = {
  pedestal: 0x8a9099,
  panel: 0x2b3d66,
  pole: 0xe8eaec,
  nacelle: 0xd5d8db,
  batteryCabinet: 0x4d6b57,
  batteryFrame: 0x3a4048,
  biogasTank: 0x6c7f5a,
  biogasDome: 0x93ab6d,
  hubCanopy: 0x58b7a4,
  hubPillar: 0x3a4048,
  parkGrass: 0x7cb35e,
  treeTrunk: 0x6e4f36,
  treeFoliage: 0x3f7d46,
  treeFoliageLight: 0x549a54,
  weir: 0x9aa3ad,
  powerhouse: 0x5d6b7a,
  penstock: 0x7a8593,
  waterLight: 0x7fb6dd,
  fireHall: 0xc0392b,
  fireRoof: 0xf4f1ec,
  fireTower: 0x8e2a1f,
  policeBlock: 0x2f5fa8,
  policeRoof: 0xd7dde8,
  policeLight: 0x7fd0ff,
  depotHall: 0x8d99a6,
  depotRoof: 0xe4e7ea,
  depotDoor: 0x3a4048,
  depotRamp: 0x6f7a86,
  busHall: 0x5b8fc7,
  hydrogenTank: 0xe6ebee,
  hydrogenBand: 0x54b8c9,
  hydrogenHall: 0x9aa3ad,
  busRoof: 0xe4e7ea,
  busDoor: 0x3a4048,
  busApron: 0x6f7a86,
  tidalHousing: 0x4d6b73,
  tidalPylon: 0x9aa3ad,
  tidalBuoy: 0xe8a23a,
  geoHall: 0x6b5f57,
  geoTower: 0xd7d2c8,
  geoWellhead: 0xb5482f,
  heatHall: 0x7a4a3a,
  heatStack: 0xd9822b,
  heatRoof: 0xe4e7ea,
  storeTank: 0xc9a227,
  storePlinth: 0x6f7a86,
  storeCap: 0xe6ebee,
  substationYard: 0x6f7a86,
  substationBox: 0x4b5563,
  substationInsulator: 0xd7dde8,
  fencePost: 0x9aa3ad,
  platform: 0x9a9da3,
  stationRoof: 0xd84a3a,
  stationPost: 0x3a4048,
  gantry: 0xd9a441,
  container: 0x4f6b3a,
  yardHall: 0x6e5a9e,
  yardRoof: 0xe4e7ea,
} as const;

/** Where a plant stands: which neighbours are water (for hydro shapes). */
interface PlantSite {
  /** River continues north/south of the tile (else east/west). */
  riverAlongZ: boolean;
  /** Direction to the nearest lake neighbour (0,0 when none). */
  lakeDx: number;
  lakeDz: number;
  /**
   * Direction to the track a rail plant halts at (0,0 when none): the
   * lowest-index track neighbour, as `plantTrack` in the sim picks it.
   */
  trackDx: number;
  trackDz: number;
}

/**
 * Turn parts drawn with their track side at +z toward the track at
 * (dx, dz): a quarter turn swaps the footprints and permutes the
 * offsets, a half turn mirrors them. No track leaves them as drawn.
 */
export function orientToTrack(parts: BoxPart[], dx: number, dz: number): BoxPart[] {
  if (dz === 1 || (dx === 0 && dz === 0)) return parts;
  return parts.map((p) => {
    if (dz === -1) return { ...p, ox: -p.ox, oz: -p.oz };
    if (dx === 1) return { ...p, sx: p.sz, sz: p.sx, ox: p.oz, oz: -p.ox };
    return { ...p, sx: p.sz, sz: p.sx, ox: -p.oz, oz: p.ox };
  });
}

/** Static box parts per plant type (rotors/domes/fills are separate). */
function plantBoxParts(plant: PlantType, site: PlantSite): BoxPart[] {
  switch (plant) {
    case PlantType.SolarFarm: {
      const rows: BoxPart[] = [];
      for (let i = 0; i < 3; i++) {
        rows.push({
          sx: 0.8,
          sy: 0.02,
          sz: 0.24,
          ox: 0,
          oy: 0.14,
          oz: -0.3 + i * 0.3,
          color: COLORS.panel,
          rotX: -0.5,
        });
        rows.push({
          sx: 0.8,
          sy: 0.1,
          sz: 0.04,
          ox: 0,
          oy: 0,
          oz: -0.3 + i * 0.3,
          color: COLORS.pedestal,
        });
      }
      return rows;
    }
    case PlantType.WindTurbine:
      return [
        { sx: 0.07, sy: HUB_HEIGHT, sz: 0.07, ox: 0, oy: 0, oz: 0, color: COLORS.pole },
        {
          sx: 0.1,
          sy: 0.09,
          sz: 0.2,
          ox: 0,
          oy: HUB_HEIGHT,
          oz: 0.03,
          color: COLORS.nacelle,
        },
      ];
    case PlantType.Battery:
      return [
        { sx: 0.55, sy: 0.5, sz: 0.4, ox: 0, oy: 0, oz: 0, color: COLORS.batteryCabinet },
        { sx: 0.62, sy: 0.06, sz: 0.46, ox: 0, oy: 0.5, oz: 0, color: COLORS.batteryFrame },
      ];
    case PlantType.BiogasPlant:
      return [{ sx: 0.34, sy: 0.34, sz: 0.34, ox: 0.22, oy: 0, oz: 0.2, color: COLORS.biogasTank }];
    case PlantType.ChargingHub:
      return [
        { sx: 0.08, sy: 0.45, sz: 0.08, ox: -0.3, oy: 0, oz: -0.3, color: COLORS.hubPillar },
        { sx: 0.08, sy: 0.45, sz: 0.08, ox: 0.3, oy: 0, oz: -0.3, color: COLORS.hubPillar },
        { sx: 0.9, sy: 0.05, sz: 0.9, ox: 0, oy: 0.45, oz: 0, color: COLORS.hubCanopy },
        { sx: 0.2, sy: 0.35, sz: 0.12, ox: 0, oy: 0, oz: 0.32, color: COLORS.batteryFrame },
      ];
    case PlantType.Park:
      // The lawn is not a part: it is laid as two ground-fitted prisms in
      // rebuild(), like a road pad, so it never floats on a slope.
      return [
        // three low-poly trees: trunk + foliage cube each
        { sx: 0.05, sy: 0.16, sz: 0.05, ox: -0.24, oy: 0.03, oz: -0.2, color: COLORS.treeTrunk },
        { sx: 0.22, sy: 0.26, sz: 0.22, ox: -0.24, oy: 0.17, oz: -0.2, color: COLORS.treeFoliage },
        { sx: 0.05, sy: 0.2, sz: 0.05, ox: 0.22, oy: 0.03, oz: -0.05, color: COLORS.treeTrunk },
        {
          sx: 0.26,
          sy: 0.32,
          sz: 0.26,
          ox: 0.22,
          oy: 0.2,
          oz: -0.05,
          color: COLORS.treeFoliageLight,
        },
        { sx: 0.05, sy: 0.13, sz: 0.05, ox: -0.05, oy: 0.03, oz: 0.28, color: COLORS.treeTrunk },
        { sx: 0.18, sy: 0.2, sz: 0.18, ox: -0.05, oy: 0.14, oz: 0.28, color: COLORS.treeFoliage },
      ];
    case PlantType.RunOfRiver: {
      // A weir across the river with a small powerhouse at one bank.
      const across = site.riverAlongZ;
      return [
        {
          sx: across ? 0.96 : 0.3,
          sy: 0.2,
          sz: across ? 0.3 : 0.96,
          ox: 0,
          oy: 0,
          oz: 0,
          color: COLORS.weir,
        },
        {
          sx: across ? 0.9 : 0.08,
          sy: 0.26,
          sz: across ? 0.08 : 0.9,
          ox: 0,
          oy: 0,
          oz: 0,
          color: COLORS.waterLight,
        },
        {
          sx: 0.3,
          sy: 0.34,
          sz: 0.3,
          ox: across ? 0.3 : 0,
          oy: 0,
          oz: across ? 0 : 0.3,
          color: COLORS.powerhouse,
        },
      ];
    }
    case PlantType.PumpedStorage: {
      // Powerhouse with a penstock pipe running toward the lake.
      const alongX = site.lakeDx !== 0;
      return [
        { sx: 0.6, sy: 0.45, sz: 0.5, ox: 0, oy: 0, oz: 0, color: COLORS.powerhouse },
        { sx: 0.66, sy: 0.05, sz: 0.56, ox: 0, oy: 0.45, oz: 0, color: COLORS.batteryFrame },
        {
          sx: alongX ? 0.5 : 0.12,
          sy: 0.1,
          sz: alongX ? 0.12 : 0.5,
          ox: site.lakeDx * 0.3,
          oy: 0.3,
          oz: site.lakeDz * 0.3,
          color: COLORS.penstock,
        },
        {
          sx: alongX ? 0.5 : 0.12,
          sy: 0.1,
          sz: alongX ? 0.12 : 0.5,
          ox: site.lakeDx * 0.3,
          oy: 0.16,
          oz: site.lakeDz * 0.3,
          color: COLORS.penstock,
        },
      ];
    }
    case PlantType.FireStation:
      return [
        // Hall with a white roof stripe and a hose tower at the back.
        { sx: 0.8, sy: 0.36, sz: 0.6, ox: 0, oy: 0, oz: 0.05, color: COLORS.fireHall },
        { sx: 0.84, sy: 0.05, sz: 0.64, ox: 0, oy: 0.36, oz: 0.05, color: COLORS.fireRoof },
        { sx: 0.2, sy: 0.62, sz: 0.2, ox: 0.25, oy: 0, oz: -0.3, color: COLORS.fireTower },
        { sx: 0.24, sy: 0.04, sz: 0.24, ox: 0.25, oy: 0.62, oz: -0.3, color: COLORS.fireRoof },
      ];
    case PlantType.PoliceStation:
      return [
        // Blue block with a pale roof and a light bar.
        { sx: 0.74, sy: 0.42, sz: 0.66, ox: 0, oy: 0, oz: 0, color: COLORS.policeBlock },
        { sx: 0.78, sy: 0.05, sz: 0.7, ox: 0, oy: 0.42, oz: 0, color: COLORS.policeRoof },
        { sx: 0.3, sy: 0.06, sz: 0.1, ox: 0, oy: 0.47, oz: 0, color: COLORS.policeLight },
      ];
    case PlantType.LogisticsDepot:
      return [
        // Flat warehouse with a pale roof, a dark roller door and a loading ramp.
        { sx: 0.84, sy: 0.3, sz: 0.62, ox: 0, oy: 0, oz: 0.06, color: COLORS.depotHall },
        { sx: 0.88, sy: 0.04, sz: 0.66, ox: 0, oy: 0.3, oz: 0.06, color: COLORS.depotRoof },
        { sx: 0.3, sy: 0.22, sz: 0.03, ox: -0.15, oy: 0, oz: -0.26, color: COLORS.depotDoor },
        { sx: 0.5, sy: 0.06, sz: 0.2, ox: 0, oy: 0, oz: -0.36, color: COLORS.depotRamp },
      ];
    case PlantType.BusDepot:
      return [
        // Long garage hall with a pale roof, a wide door and a bus apron.
        { sx: 0.86, sy: 0.32, sz: 0.5, ox: 0, oy: 0, oz: 0.12, color: COLORS.busHall },
        { sx: 0.9, sy: 0.04, sz: 0.54, ox: 0, oy: 0.32, oz: 0.12, color: COLORS.busRoof },
        { sx: 0.5, sy: 0.24, sz: 0.03, ox: 0, oy: 0, oz: -0.14, color: COLORS.busDoor },
        { sx: 0.8, sy: 0.03, sz: 0.24, ox: 0, oy: 0, oz: -0.3, color: COLORS.busApron },
      ];
    case PlantType.HydrogenPlant:
      return [
        // Horizontal storage tank (stepped boxes fake the round shell)
        // with a teal H2 band, next to the electrolyser hall and a vent.
        { sx: 0.62, sy: 0.2, sz: 0.3, ox: -0.12, oy: 0.06, oz: 0.24, color: COLORS.hydrogenTank },
        { sx: 0.54, sy: 0.3, sz: 0.24, ox: -0.12, oy: 0.02, oz: 0.24, color: COLORS.hydrogenTank },
        { sx: 0.1, sy: 0.34, sz: 0.26, ox: -0.12, oy: 0, oz: 0.24, color: COLORS.hydrogenBand },
        { sx: 0.7, sy: 0.34, sz: 0.44, ox: 0, oy: 0, oz: -0.2, color: COLORS.hydrogenHall },
        { sx: 0.74, sy: 0.04, sz: 0.48, ox: 0, oy: 0.34, oz: -0.2, color: COLORS.depotRoof },
        { sx: 0.07, sy: 0.56, sz: 0.07, ox: 0.28, oy: 0, oz: -0.3, color: COLORS.batteryFrame },
      ];
    case PlantType.TidalPlant:
      return [
        // Submerged turbine housing with a slim pylon and a surface buoy.
        { sx: 0.5, sy: 0.14, sz: 0.34, ox: 0, oy: 0.02, oz: 0, color: COLORS.tidalHousing },
        { sx: 0.08, sy: 0.4, sz: 0.08, ox: 0, oy: 0.14, oz: 0, color: COLORS.tidalPylon },
        { sx: 0.22, sy: 0.12, sz: 0.22, ox: 0, oy: 0.5, oz: 0, color: COLORS.tidalBuoy },
      ];
    case PlantType.GeothermalPlant:
      return [
        // Turbine hall, a wellhead stub and the cooling tower above it.
        { sx: 0.6, sy: 0.24, sz: 0.4, ox: -0.08, oy: 0, oz: 0.1, color: COLORS.geoHall },
        { sx: 0.12, sy: 0.3, sz: 0.12, ox: 0.28, oy: 0, oz: -0.22, color: COLORS.geoWellhead },
        { sx: 0.3, sy: 0.5, sz: 0.3, ox: 0.2, oy: 0, oz: 0.22, color: COLORS.geoTower },
      ];
    case PlantType.HeatPlant:
      return [
        // A low pump hall with a flat roof and one tall slim stack.
        { sx: 0.7, sy: 0.26, sz: 0.46, ox: -0.06, oy: 0, oz: 0.06, color: COLORS.heatHall },
        { sx: 0.74, sy: 0.04, sz: 0.5, ox: -0.06, oy: 0.26, oz: 0.06, color: COLORS.heatRoof },
        { sx: 0.1, sy: 0.62, sz: 0.1, ox: 0.3, oy: 0, oz: -0.26, color: COLORS.heatStack },
      ];
    case PlantType.HeatStore:
      return [
        // A wide cylinder faked by two stepped boxes on a plinth, capped white.
        { sx: 0.7, sy: 0.06, sz: 0.7, ox: 0, oy: 0, oz: 0, color: COLORS.storePlinth },
        { sx: 0.56, sy: 0.4, sz: 0.56, ox: 0, oy: 0.06, oz: 0, color: COLORS.storeTank },
        { sx: 0.46, sy: 0.4, sz: 0.64, ox: 0, oy: 0.06, oz: 0, color: COLORS.storeTank },
        { sx: 0.64, sy: 0.4, sz: 0.46, ox: 0, oy: 0.06, oz: 0, color: COLORS.storeTank },
        { sx: 0.5, sy: 0.05, sz: 0.5, ox: 0, oy: 0.46, oz: 0, color: COLORS.storeCap },
      ];
    case PlantType.Substation:
      return [
        { sx: 0.84, sy: 0.03, sz: 0.84, ox: 0, oy: 0, oz: 0, color: COLORS.substationYard },
        ...[-0.38, 0.38].flatMap((px) =>
          [-0.38, 0.38].map((pz) => ({
            sx: 0.04,
            sy: 0.22,
            sz: 0.04,
            ox: px,
            oy: 0.03,
            oz: pz,
            color: COLORS.fencePost,
          })),
        ),
        { sx: 0.36, sy: 0.3, sz: 0.26, ox: 0, oy: 0.03, oz: 0.05, color: COLORS.substationBox },
        {
          sx: 0.05,
          sy: 0.14,
          sz: 0.05,
          ox: -0.08,
          oy: 0.33,
          oz: 0.05,
          color: COLORS.substationInsulator,
        },
        {
          sx: 0.05,
          sy: 0.14,
          sz: 0.05,
          ox: 0.08,
          oy: 0.33,
          oz: 0.05,
          color: COLORS.substationInsulator,
        },
      ];
    // The three rail plants are drawn with the track at +z and turned
    // toward the track they actually stand beside.
    case PlantType.TrainStation:
      return orientToTrack(
        [
          // Platform slab along the track, two posts and a red roof over the waiting area.
          { sx: 0.9, sy: 0.08, sz: 0.44, ox: 0, oy: 0, oz: 0.1, color: COLORS.platform },
          { sx: 0.05, sy: 0.3, sz: 0.05, ox: -0.3, oy: 0.08, oz: 0.1, color: COLORS.stationPost },
          { sx: 0.05, sy: 0.3, sz: 0.05, ox: 0.3, oy: 0.08, oz: 0.1, color: COLORS.stationPost },
          { sx: 0.8, sy: 0.04, sz: 0.4, ox: 0, oy: 0.38, oz: 0.1, color: COLORS.stationRoof },
        ],
        site.trackDx,
        site.trackDz,
      );
    case PlantType.FreightTerminal:
      return orientToTrack(
        [
          // Apron, a gantry crane along the track and a container on the track side.
          { sx: 0.9, sy: 0.05, sz: 0.9, ox: 0, oy: 0, oz: 0, color: COLORS.platform },
          { sx: 0.06, sy: 0.5, sz: 0.06, ox: -0.35, oy: 0.05, oz: 0, color: COLORS.gantry },
          { sx: 0.06, sy: 0.5, sz: 0.06, ox: 0.35, oy: 0.05, oz: 0, color: COLORS.gantry },
          { sx: 0.8, sy: 0.06, sz: 0.1, ox: 0, oy: 0.55, oz: 0, color: COLORS.gantry },
          { sx: 0.4, sy: 0.18, sz: 0.2, ox: 0, oy: 0.05, oz: 0.2, color: COLORS.container },
        ],
        site.trackDx,
        site.trackDz,
      );
    case PlantType.RailYard:
      return orientToTrack(
        [
          // Long shed with a pale roof and a wide door facing the track.
          { sx: 0.9, sy: 0.36, sz: 0.5, ox: 0, oy: 0, oz: -0.1, color: COLORS.yardHall },
          { sx: 0.94, sy: 0.04, sz: 0.54, ox: 0, oy: 0.36, oz: -0.1, color: COLORS.yardRoof },
          { sx: 0.5, sy: 0.28, sz: 0.03, ox: 0, oy: 0, oz: 0.16, color: COLORS.busDoor },
        ],
        site.trackDx,
        site.trackDz,
      );
    default:
      return [];
  }
}

/** Blade length, measured from the hub outward. */
const ROTOR_RADIUS = 0.42;

/**
 * How high a plant rises above its tile. Site-independent: the hydro
 * shapes change orientation with the river/lake, never height.
 */
export function plantHeight(plant: PlantType): number {
  const site: PlantSite = { riverAlongZ: false, lakeDx: 0, lakeDz: 0, trackDx: 0, trackDz: 0 };
  let top = 0;
  for (const part of plantBoxParts(plant, site)) top = Math.max(top, part.oy + part.sy);
  // Rotor and dome are separate meshes, so they are not in the box parts.
  if (plant === PlantType.WindTurbine) top = Math.max(top, HUB_HEIGHT + ROTOR_RADIUS);
  if (plant === PlantType.BiogasPlant) top = Math.max(top, BIOGAS_DOME_TOP);
  return top;
}

/** Three thin blades merged into one rotor geometry, hub at the origin. */
function createRotorGeometry(): THREE.BufferGeometry {
  const blades: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) {
    const blade = new THREE.BoxGeometry(0.015, ROTOR_RADIUS, 0.05);
    blade.translate(0, ROTOR_RADIUS / 2, 0);
    blade.rotateX((i * 2 * Math.PI) / 3);
    blades.push(blade);
  }
  const merged = mergeGeometries(blades);
  // Blades live in the yz-plane and spin around the x axis.
  merged.rotateY(Math.PI / 2);
  return merged;
}

/**
 * All energy plants: instanced static parts, spinning turbine rotors
 * (speed proportional to wind output), biogas domes, and battery
 * state-of-charge fill bars.
 */
export class PlantsMesh implements DiffLayer {
  readonly boxMesh: THREE.InstancedMesh;
  /** Park lawns: two prisms per park, each flush with one ground triangle. */
  readonly parkPads: THREE.InstancedMesh;
  private readonly rotorMesh: THREE.InstancedMesh;
  private readonly domeMesh: THREE.InstancedMesh;
  /** Front bars showing each battery's state of charge (public for tests). */
  readonly socFillMesh: THREE.InstancedMesh;
  private readonly gridSize: number;
  private readonly plants = new Map<number, PlantType>();
  private readonly terrain: Uint8Array;
  /** Track mask per tile, for turning the rail plants toward their halt. */
  private readonly rail: Uint8Array;
  private readonly rotorPositions: THREE.Vector3[] = [];
  private rotorAngle = 0;
  private rotorSpeedFactor = 0;
  /** Drawn battery cabinets, in instance order, with the tile each stands on. */
  private readonly batteryPositions: Array<{ position: THREE.Vector3; index: number }> = [];
  /** Per-tile state of charge 0..1, from the tile diffs. */
  private readonly stateOfCharge = new Map<number, number>();
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private readonly position = new THREE.Vector3();

  constructor(
    scene: THREE.Scene,
    gridSize: number,
    private readonly elevation: ElevationField,
  ) {
    this.gridSize = gridSize;
    const capacity = gridSize * gridSize;
    this.terrain = new Uint8Array(capacity);
    this.rail = new Uint8Array(capacity);

    const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
    boxGeometry.translate(0, 0.5, 0);
    this.boxMesh = new THREE.InstancedMesh(
      boxGeometry,
      surfaceMaterial(),
      capacity * MAX_BOX_PARTS_PER_PLANT,
    );
    // Instance transforms live across the whole grid; the base geometry's
    // bounds would wrongly cull the mesh, so culling is disabled.
    this.boxMesh.frustumCulled = false;
    this.boxMesh.castShadow = true;
    this.boxMesh.count = 0;
    scene.add(this.boxMesh);

    this.parkPads = new THREE.InstancedMesh(
      createHalfTilePrism(),
      surfaceMaterial({ color: COLORS.parkGrass }),
      capacity * 2,
    );
    // Instance transforms live across the whole grid; the base geometry's
    // bounds would wrongly cull the mesh, so culling is disabled.
    this.parkPads.frustumCulled = false;
    this.parkPads.receiveShadow = true;
    this.parkPads.count = 0;
    scene.add(this.parkPads);

    this.rotorMesh = new THREE.InstancedMesh(
      createRotorGeometry(),
      surfaceMaterial({ color: COLORS.pole }),
      capacity,
    );
    // Instance transforms live across the whole grid; the base geometry's
    // bounds would wrongly cull the mesh, so culling is disabled.
    this.rotorMesh.frustumCulled = false;
    this.rotorMesh.count = 0;
    scene.add(this.rotorMesh);

    const domeGeometry = new THREE.SphereGeometry(DOME_RADIUS, 10, 6);
    this.domeMesh = new THREE.InstancedMesh(
      domeGeometry,
      surfaceMaterial({ color: COLORS.biogasDome }),
      capacity,
    );
    // Instance transforms live across the whole grid; the base geometry's
    // bounds would wrongly cull the mesh, so culling is disabled.
    this.domeMesh.frustumCulled = false;
    this.domeMesh.castShadow = true;
    this.domeMesh.count = 0;
    scene.add(this.domeMesh);

    const fillGeometry = new THREE.BoxGeometry(1, 1, 1);
    fillGeometry.translate(0, 0.5, 0);
    this.socFillMesh = new THREE.InstancedMesh(
      fillGeometry,
      new THREE.MeshBasicMaterial({ color: 0x7be07f }),
      capacity,
    );
    // Instance transforms live across the whole grid; the base geometry's
    // bounds would wrongly cull the mesh, so culling is disabled.
    this.socFillMesh.frustumCulled = false;
    this.socFillMesh.count = 0;
    scene.add(this.socFillMesh);
  }

  applyDiffs(diffs: TileDiff[]): void {
    let changed = false;
    let socChanged = false;
    for (const diff of diffs) {
      if (this.terrain[diff.index] !== diff.terrain) {
        this.terrain[diff.index] = diff.terrain;
        changed = true;
      }
      // Track laid or lifted beside a station turns the station.
      if (this.rail[diff.index] !== diff.rail) {
        this.rail[diff.index] = diff.rail;
        changed = true;
      }
      const plant = diff.tileType === TileType.Plant ? diff.plantType : PlantType.None;
      const existing = this.plants.get(diff.index) ?? PlantType.None;
      if (plant !== existing) {
        if (plant === PlantType.None) this.plants.delete(diff.index);
        else this.plants.set(diff.index, plant);
        changed = true;
      }
      // Every storage plant carries its own level; only batteries draw one.
      if (plant === PlantType.Battery) {
        const soc = diff.stored ?? 0;
        if (this.stateOfCharge.get(diff.index) !== soc) {
          this.stateOfCharge.set(diff.index, soc);
          socChanged = true;
        }
      } else {
        this.stateOfCharge.delete(diff.index);
      }
    }
    if (changed) this.rebuild();
    else if (socChanged) this.writeSocFills();
  }

  setEnvironment(environment: RenderEnvironment): void {
    this.rotorSpeedFactor = environment.windFactor;
  }

  update(deltaSeconds: number): void {
    if (this.rotorPositions.length === 0) return;
    // Rotor speed is proportional to wind output (cut-in below ~10%).
    const speed =
      this.rotorSpeedFactor > 0.05 ? ROTOR_MAX_SPEED_RAD_PER_S * this.rotorSpeedFactor : 0;
    if (speed === 0) return;
    this.rotorAngle = (this.rotorAngle + speed * deltaSeconds) % (2 * Math.PI);
    this.writeRotors();
  }

  private rebuild(): void {
    let boxSlot = 0;
    let domeSlot = 0;
    let padSlot = 0;
    this.rotorPositions.length = 0;
    this.batteryPositions.length = 0;
    const color = new THREE.Color();

    for (const [index, plant] of this.plants) {
      const cx = (index % this.gridSize) + 0.5;
      const cz = Math.floor(index / this.gridSize) + 0.5;
      const lift = this.elevation.centerY(index);
      const site = this.siteOf(index);
      const isPark = plant === PlantType.Park;
      if (isPark) {
        // Lawn flush with the ground on both triangles of the tile.
        for (const high of [false, true]) {
          composePrismOnGround(
            this.matrix,
            this.elevation,
            index,
            high,
            PARK_PAD_SIZE,
            PARK_PAD_HEIGHT,
            0,
          );
          this.parkPads.setMatrixAt(padSlot++, this.matrix);
        }
      }
      for (const part of plantBoxParts(plant, site)) {
        // Trees stand on the ground where they are; everything else keeps
        // the tile-centre lift its recipe was tuned for.
        const partLift = isPark ? this.elevation.surfaceY(cx + part.ox, cz + part.oz) : lift;
        let baseY = part.oy + partLift;
        let sizeY = part.sy;
        if (part.oy === 0 && part.rotX === undefined && !isPark) {
          // Foundation: a box that stands on the ground keeps its top but
          // drops its bottom to the lowest ground under its footprint, so
          // nothing floats on the downhill side of a sloped tile (the
          // uphill side simply sinks in).
          const bottom = Math.min(
            partLift,
            this.lowestGroundUnder(cx + part.ox, cz + part.oz, part.sx, part.sz),
          );
          sizeY = partLift + part.sy - bottom;
          baseY = bottom;
        }
        this.position.set(cx + part.ox, baseY, cz + part.oz);
        this.quaternion.setFromEuler(new THREE.Euler(part.rotX ?? 0, 0, 0));
        this.scale.set(part.sx, sizeY, part.sz);
        this.matrix.compose(this.position, this.quaternion, this.scale);
        this.boxMesh.setMatrixAt(boxSlot, this.matrix);
        this.boxMesh.setColorAt(boxSlot, color.setHex(part.color));
        boxSlot++;
      }
      if (plant === PlantType.WindTurbine) {
        this.rotorPositions.push(new THREE.Vector3(cx, HUB_HEIGHT + lift, cz + 0.09));
      } else if (plant === PlantType.BiogasPlant) {
        this.matrix.makeScale(1, DOME_SQUASH, 1);
        this.matrix.setPosition(cx - 0.12, DOME_BASE + lift, cz - 0.05);
        this.domeMesh.setMatrixAt(domeSlot++, this.matrix);
      } else if (plant === PlantType.Battery) {
        this.batteryPositions.push({ position: new THREE.Vector3(cx, lift, cz), index });
      }
    }

    this.boxMesh.count = boxSlot;
    this.boxMesh.instanceMatrix.needsUpdate = true;
    this.parkPads.count = padSlot;
    this.parkPads.instanceMatrix.needsUpdate = true;
    if (this.boxMesh.instanceColor) this.boxMesh.instanceColor.needsUpdate = true;
    this.domeMesh.count = domeSlot;
    this.domeMesh.instanceMatrix.needsUpdate = true;
    this.writeRotors();
    this.writeSocFills();
  }

  /**
   * Lowest ground height under a footprint centred on (x, z): the ground
   * is planar per triangle, so sampling the corners, edge midpoints and
   * centre finds the minimum to within the crease.
   */
  private lowestGroundUnder(x: number, z: number, sx: number, sz: number): number {
    const max = this.gridSize - 1e-6;
    let lowest = Infinity;
    for (const fx of [-0.5, 0, 0.5]) {
      for (const fz of [-0.5, 0, 0.5]) {
        const px = Math.min(max, Math.max(0, x + fx * sx));
        const pz = Math.min(max, Math.max(0, z + fz * sz));
        lowest = Math.min(lowest, this.elevation.surfaceY(px, pz));
      }
    }
    return lowest;
  }

  private siteOf(index: number): PlantSite {
    const size = this.gridSize;
    const x = index % size;
    const y = Math.floor(index / size);
    const terrainAt = (tx: number, ty: number): number =>
      tx < 0 || ty < 0 || tx >= size || ty >= size ? Terrain.Land : this.terrain[ty * size + tx];
    const riverAlongZ =
      terrainAt(x, y - 1) === Terrain.River || terrainAt(x, y + 1) === Terrain.River;
    let lakeDx = 0;
    let lakeDz = 0;
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      if (terrainAt(x + dx, y + dz) === Terrain.Lake) {
        lakeDx = dx;
        lakeDz = dz;
        break;
      }
    }
    // Lowest-index track neighbour first (north, west, east, south), the
    // order the sim's plantTrack uses, so the plant faces the halt.
    let trackDx = 0;
    let trackDz = 0;
    for (const [dx, dz] of [
      [0, -1],
      [-1, 0],
      [1, 0],
      [0, 1],
    ] as const) {
      const tx = x + dx;
      const ty = y + dz;
      if (tx < 0 || ty < 0 || tx >= size || ty >= size) continue;
      if (this.rail[ty * size + tx] !== 0) {
        trackDx = dx;
        trackDz = dz;
        break;
      }
    }
    return { riverAlongZ, lakeDx, lakeDz, trackDx, trackDz };
  }

  private writeRotors(): void {
    for (let i = 0; i < this.rotorPositions.length; i++) {
      const hub = this.rotorPositions[i];
      this.matrix.makeRotationZ(this.rotorAngle + i * 0.7);
      this.matrix.setPosition(hub.x, hub.y, hub.z);
      this.rotorMesh.setMatrixAt(i, this.matrix);
    }
    this.rotorMesh.count = this.rotorPositions.length;
    this.rotorMesh.instanceMatrix.needsUpdate = true;
  }

  /** Front bar on each battery cabinet showing that battery's state of charge. */
  private writeSocFills(): void {
    for (let i = 0; i < this.batteryPositions.length; i++) {
      const { position: p, index } = this.batteryPositions[i];
      const height = 0.04 + 0.42 * (this.stateOfCharge.get(index) ?? 0);
      this.matrix.makeScale(0.1, height, 0.03);
      this.matrix.setPosition(p.x + 0.18, 0.03 + p.y, p.z + 0.2);
      this.socFillMesh.setMatrixAt(i, this.matrix);
    }
    this.socFillMesh.count = this.batteryPositions.length;
    this.socFillMesh.instanceMatrix.needsUpdate = true;
  }
}
