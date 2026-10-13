import { PlantType } from '../../shared/types.ts';
import type * as THREE from 'three';
import { box, cone, cylinder, gable, merge } from '../modelKit.ts';
import { FULL_PLINTH, TONE, win, yardLamp } from './common.ts';
import type { GroundProp, LampAnchor, PlantModel } from './models.ts';

/** Service palette: today's service colours plus the structural tones. */
const C = {
  ...TONE,
  asphalt: 0x5a5f66,
  hubCanopy: 0x58b7a4,
  hubScreen: 0x7be0c8,
  fireHall: 0xc0392b,
  fireRoof: 0xf4f1ec,
  fireTower: 0x8e2a1f,
  policeBlock: 0x2f5fa8,
  policeRoof: 0xd7dde8,
  policeLight: 0x7fd0ff,
  policeCar: 0xf0f2f4,
  depotHall: 0x8d99a6,
  depotRoof: 0xe4e7ea,
  depotRamp: 0x6f7a86,
  van: 0xf0c419,
  busHall: 0x5b8fc7,
  busRoof: 0xe4e7ea,
  bus: 0x4a9a6a,
  washBrush: 0x54b8c9,
  substationBox: 0x4b5563,
  substationInsulator: 0xd7dde8,
  hut: 0xb8b2a6,
  platform: 0xb5b8bd,
  safetyLine: 0xe8c33a,
  stationWall: 0xd9cbb0,
  stationRoof: 0xd84a3a,
  clockFace: 0xf4f1ec,
  gantry: 0xd9a441,
  containerGreen: 0x4f6b3a,
  containerRust: 0xb5482f,
  containerBlue: 0x2f5fa8,
  yardHall: 0x6e5a9e,
  yardRoof: 0xe4e7ea,
  loco: 0xd84a3a,
  ballast: 0x8a8075,
  rail: 0x4a4d52,
} as const;

/** Doors are thin slabs proud of their wall. */
const DOOR_DEPTH = 0.01;
/** Roof slab thickness and its overhang per side. */
const SLAB = 0.03;
const EAVE = 0.02;
/** Ground markings: painted lines this thick. */
const MARK = 0.004;
/** A lamp hanging under a canopy: its centre sits half a lamp below the soffit. */
const HANGING_LAMP_DROP = 0.015;

/** Door slab on the wall facing +z at `wallZ`, standing on `base`. */
function frontDoor(w: number, h: number, x: number, wallZ: number, color: number, base = 0) {
  return box(w, h, DOOR_DEPTH, x, base + h / 2, wallZ + DOOR_DEPTH / 2, color);
}

/** Flat roof slab over a w × d body whose top is at `top`, overhanging by EAVE. */
function roofSlab(w: number, d: number, x: number, top: number, z: number, color: number) {
  return box(w + 2 * EAVE, SLAB, d + 2 * EAVE, x, top + SLAB / 2, z, color);
}

// --- Charging hub -----------------------------------------------------------

const HUB_CANOPY = { w: 0.84, h: 0.04, d: 0.6, top: 0.5, z: -0.04 };
const HUB_COLUMN = { size: 0.03, x: 0.38, z: [-0.3, 0.22] };
const HUB_CHARGER = { w: 0.05, h: 0.16, d: 0.04, z: -0.06, x: [-0.24, 0, 0.24] };
const HUB_SCREEN = { w: 0.035, h: 0.04, d: 0.005, y: 0.12 };
/** Bay lines between the chargers, running from the chargers to the front edge. */
const HUB_BAY = { w: 0.02, z0: 0, z1: 0.3, x: [-0.12, 0.12] };

function chargingHub(): PlantModel {
  const soffit = HUB_CANOPY.top - HUB_CANOPY.h;
  const parts = [
    box(
      HUB_CANOPY.w,
      HUB_CANOPY.h,
      HUB_CANOPY.d,
      0,
      soffit + HUB_CANOPY.h / 2,
      HUB_CANOPY.z,
      C.hubCanopy,
    ),
    ...[-HUB_COLUMN.x, HUB_COLUMN.x].flatMap((x) =>
      HUB_COLUMN.z.map((z) =>
        box(HUB_COLUMN.size, soffit, HUB_COLUMN.size, x, soffit / 2, z, C.FRAME),
      ),
    ),
    // Charger pillars facing the bays (+z), each with a screen.
    ...HUB_CHARGER.x.flatMap((x) => [
      box(
        HUB_CHARGER.w,
        HUB_CHARGER.h,
        HUB_CHARGER.d,
        x,
        HUB_CHARGER.h / 2,
        HUB_CHARGER.z,
        C.FRAME,
      ),
      box(
        HUB_SCREEN.w,
        HUB_SCREEN.h,
        HUB_SCREEN.d,
        x,
        HUB_SCREEN.y,
        HUB_CHARGER.z + HUB_CHARGER.d / 2 + HUB_SCREEN.d / 2,
        C.hubScreen,
      ),
    ]),
    // Grid cabinet behind the canopy.
    box(0.14, 0.22, 0.1, 0.3, 0.11, -0.42, C.STEEL),
    ...HUB_BAY.x.map((x) =>
      box(
        HUB_BAY.w,
        MARK,
        HUB_BAY.z1 - HUB_BAY.z0,
        x,
        MARK / 2,
        (HUB_BAY.z0 + HUB_BAY.z1) / 2,
        C.MARKING,
      ),
    ),
  ];
  const { geometry, parts: n } = merge(parts);
  const lampY = soffit - HANGING_LAMP_DROP;
  return {
    geometry,
    parts: n,
    plinth: { sx: FULL_PLINTH, sz: FULL_PLINTH, color: C.asphalt },
    windows: [],
    lamps: [
      { x: -0.2, y: lampY, z: 0.1, kind: 'yard' },
      { x: 0.2, y: lampY, z: 0.1, kind: 'yard' },
    ],
  };
}

// --- Park -------------------------------------------------------------------

/** Five trees in three sizes and two benches, clear of each other and inside the tile. */
const PARK_PROPS: GroundProp[] = [
  { kind: 'tree', x: -0.24, z: -0.2, scale: 1.25, turn: 0 },
  { kind: 'tree', x: 0.22, z: -0.12, scale: 1, turn: 0.7 },
  { kind: 'tree', x: -0.05, z: 0.3, scale: 0.8, turn: 1.9 },
  { kind: 'tree', x: 0.32, z: 0.28, scale: 1, turn: 2.6 },
  { kind: 'tree', x: -0.34, z: 0.12, scale: 0.8, turn: 4.1 },
  { kind: 'bench', x: 0.02, z: 0.05, scale: 1, turn: 0 },
  { kind: 'bench', x: 0.12, z: 0.18, scale: 1, turn: Math.PI / 2 },
];

function park(): PlantModel {
  return { geometry: null, parts: 0, windows: [], lamps: [], groundProps: PARK_PROPS };
}

// --- Fire station -----------------------------------------------------------

const FIRE_HALL = { w: 0.62, h: 0.3, d: 0.44, x: -0.15, z: 0.02 };
const FIRE_DOOR = { w: 0.14, h: 0.2, x: [-0.36, -0.15, 0.06] };
/** Hose tower against the hall's east wall, toward the back. */
const FIRE_TOWER = { w: 0.18, h: 0.62, d: 0.18, x: 0.25, z: -0.11, cap: 0.04 };
const FLAG = { x: 0.4, z: 0.36, r: 0.008, h: 0.5, w: 0.08, flagH: 0.05 };

function fireStation(): PlantModel {
  const front = FIRE_HALL.z + FIRE_HALL.d / 2;
  const back = FIRE_HALL.z - FIRE_HALL.d / 2;
  const west = FIRE_HALL.x - FIRE_HALL.w / 2;
  const towerEast = FIRE_TOWER.x + FIRE_TOWER.w / 2;
  const towerFront = FIRE_TOWER.z + FIRE_TOWER.d / 2;
  const parts = [
    box(
      FIRE_HALL.w,
      FIRE_HALL.h,
      FIRE_HALL.d,
      FIRE_HALL.x,
      FIRE_HALL.h / 2,
      FIRE_HALL.z,
      C.fireHall,
    ),
    roofSlab(FIRE_HALL.w, FIRE_HALL.d, FIRE_HALL.x, FIRE_HALL.h, FIRE_HALL.z, C.fireRoof),
    ...FIRE_DOOR.x.map((x) => frontDoor(FIRE_DOOR.w, FIRE_DOOR.h, x, front, C.FRAME)),
    // Sign band above the doors.
    box(0.5, 0.04, DOOR_DEPTH, FIRE_HALL.x, 0.25, front + DOOR_DEPTH / 2, C.fireRoof),
    box(
      FIRE_TOWER.w,
      FIRE_TOWER.h,
      FIRE_TOWER.d,
      FIRE_TOWER.x,
      FIRE_TOWER.h / 2,
      FIRE_TOWER.z,
      C.fireTower,
    ),
    box(
      FIRE_TOWER.w + 2 * EAVE,
      FIRE_TOWER.cap,
      FIRE_TOWER.d + 2 * EAVE,
      FIRE_TOWER.x,
      FIRE_TOWER.h + FIRE_TOWER.cap / 2,
      FIRE_TOWER.z,
      C.ROOF_DARK,
    ),
    cylinder(FLAG.r, FLAG.h, FLAG.x, FLAG.h / 2, FLAG.z, C.FENCE),
    box(
      FLAG.w,
      FLAG.flagH,
      0.005,
      FLAG.x + FLAG.w / 2,
      FLAG.h - FLAG.flagH / 2 - 0.01,
      FLAG.z,
      C.fireHall,
    ),
  ];
  const { geometry, parts: n } = merge(parts);
  const sill = 0.14;
  const towerSill = 0.42;
  return {
    geometry,
    parts: n,
    plinth: { sx: FULL_PLINTH, sz: FULL_PLINTH, color: C.CONCRETE },
    windows: [
      win(-0.34, sill, back, 2),
      win(-0.12, sill, back, 2),
      win(west, sill, FIRE_HALL.z, 3),
      win(towerEast, towerSill, FIRE_TOWER.z, 1),
      win(FIRE_TOWER.x, towerSill, towerFront, 0),
    ],
    lamps: [],
  };
}

// --- Police station ---------------------------------------------------------

const POLICE = { w: 0.5, h: 0.36, d: 0.38, x: -0.12, z: -0.08 };
const POLICE_MAST = { r: 0.008, top: 0.53, x: -0.3, z: -0.2 };
const POLICE_CANOPY = { w: 0.18, h: 0.02, d: 0.1, y: 0.2, post: 0.015 };
const CARPORT = { x0: 0.17, x1: 0.45, z0: -0.13, z1: 0.23, y: 0.2, slab: 0.02, post: 0.02 };
const POLICE_CAR = { w: 0.12, h: 0.06, d: 0.2, cabin: 0.04, bar: 0.015, z: 0.05 };

function policeStation(): PlantModel {
  const front = POLICE.z + POLICE.d / 2;
  const back = POLICE.z - POLICE.d / 2;
  const roofTop = POLICE.h + SLAB;
  const mastH = POLICE_MAST.top - roofTop;
  const canopyZ = front + POLICE_CANOPY.d / 2;
  const portX = (CARPORT.x0 + CARPORT.x1) / 2;
  const inset = CARPORT.post / 2 + 0.01;
  const carX = portX;
  const parts = [
    box(POLICE.w, POLICE.h, POLICE.d, POLICE.x, POLICE.h / 2, POLICE.z, C.policeBlock),
    roofSlab(POLICE.w, POLICE.d, POLICE.x, POLICE.h, POLICE.z, C.policeRoof),
    cylinder(POLICE_MAST.r, mastH, POLICE_MAST.x, roofTop + mastH / 2, POLICE_MAST.z, C.FENCE),
    // Entrance: door under a canopy on two posts.
    frontDoor(0.08, 0.16, POLICE.x, front, C.FRAME),
    box(
      POLICE_CANOPY.w,
      POLICE_CANOPY.h,
      POLICE_CANOPY.d,
      POLICE.x,
      POLICE_CANOPY.y + POLICE_CANOPY.h / 2,
      canopyZ,
      C.policeRoof,
    ),
    ...[-1, 1].map((s) =>
      box(
        POLICE_CANOPY.post,
        POLICE_CANOPY.y,
        POLICE_CANOPY.post,
        POLICE.x + s * (POLICE_CANOPY.w / 2 - POLICE_CANOPY.post),
        POLICE_CANOPY.y / 2,
        front + POLICE_CANOPY.d - POLICE_CANOPY.post,
        C.FRAME,
      ),
    ),
    // Car port: slab on four posts, a patrol car with its light bar under it.
    box(
      CARPORT.x1 - CARPORT.x0,
      CARPORT.slab,
      CARPORT.z1 - CARPORT.z0,
      portX,
      CARPORT.y + CARPORT.slab / 2,
      (CARPORT.z0 + CARPORT.z1) / 2,
      C.ROOF_DARK,
    ),
    ...[CARPORT.x0 + inset, CARPORT.x1 - inset].flatMap((x) =>
      [CARPORT.z0 + inset, CARPORT.z1 - inset].map((z) =>
        box(CARPORT.post, CARPORT.y, CARPORT.post, x, CARPORT.y / 2, z, C.FRAME),
      ),
    ),
    box(
      POLICE_CAR.w,
      POLICE_CAR.h,
      POLICE_CAR.d,
      carX,
      POLICE_CAR.h / 2,
      POLICE_CAR.z,
      C.policeCar,
    ),
    box(
      POLICE_CAR.w - 0.02,
      POLICE_CAR.cabin,
      POLICE_CAR.d / 2,
      carX,
      POLICE_CAR.h + POLICE_CAR.cabin / 2,
      POLICE_CAR.z - 0.01,
      C.policeBlock,
    ),
    box(
      POLICE_CAR.w - 0.04,
      POLICE_CAR.bar,
      0.025,
      carX,
      POLICE_CAR.h + POLICE_CAR.cabin + POLICE_CAR.bar / 2,
      POLICE_CAR.z - 0.01,
      C.policeLight,
    ),
  ];
  const { geometry, parts: n } = merge(parts);
  const ground = 0.06;
  const upper = 0.22;
  return {
    geometry,
    parts: n,
    plinth: { sx: FULL_PLINTH, sz: FULL_PLINTH, color: C.CONCRETE },
    windows: [
      win(-0.3, ground, front, 0),
      win(0.06, ground, front, 0),
      win(-0.3, upper, front, 0),
      win(-0.12, upper, front, 0),
      win(0.06, upper, front, 0),
      win(-0.25, upper, back, 2),
      win(0.01, upper, back, 2),
    ],
    lamps: [],
  };
}

// --- Logistics depot --------------------------------------------------------

const DEPOT_HALL = { w: 0.6, h: 0.3, d: 0.42, x: -0.08, z: -0.18 };
const DEPOT_DOCK = { w: 0.5, h: 0.06, d: 0.1 };
const DEPOT_DOOR = { w: 0.16, h: 0.2, x: [-0.24, 0.06] };
/** Office annex against the hall's east wall. */
const DEPOT_OFFICE = { w: 0.2, h: 0.22, d: 0.24, z: -0.18 };
const DEPOT_LINE = { w: 0.015, z0: 0.18, z1: 0.42, x: [-0.33, -0.08, 0.17] };
/** Delivery van parked nose to +z between the first two lines. */
const VAN = { w: 0.1, x: -0.205, box: { h: 0.1, d: 0.14, z0: 0.21 }, cab: { h: 0.07, d: 0.06 } };
/** The depot's yard lamp stays below the hall roof so it does not set the height. */
const DEPOT_LAMP_HEIGHT = 0.3;

function logisticsDepot(): PlantModel {
  const front = DEPOT_HALL.z + DEPOT_HALL.d / 2;
  const hallEast = DEPOT_HALL.x + DEPOT_HALL.w / 2;
  const officeX = hallEast + DEPOT_OFFICE.w / 2;
  const officeEast = hallEast + DEPOT_OFFICE.w;
  const officeFront = DEPOT_OFFICE.z + DEPOT_OFFICE.d / 2;
  const cabZ = VAN.box.z0 + VAN.box.d + VAN.cab.d / 2;
  const lamp = yardLamp(0.4, 0.4, DEPOT_LAMP_HEIGHT);
  const parts = [
    box(
      DEPOT_HALL.w,
      DEPOT_HALL.h,
      DEPOT_HALL.d,
      DEPOT_HALL.x,
      DEPOT_HALL.h / 2,
      DEPOT_HALL.z,
      C.depotHall,
    ),
    roofSlab(DEPOT_HALL.w, DEPOT_HALL.d, DEPOT_HALL.x, DEPOT_HALL.h, DEPOT_HALL.z, C.depotRoof),
    // Loading dock along the front, roll-up doors opening onto it.
    box(
      DEPOT_DOCK.w,
      DEPOT_DOCK.h,
      DEPOT_DOCK.d,
      DEPOT_HALL.x,
      DEPOT_DOCK.h / 2,
      front + DEPOT_DOCK.d / 2,
      C.depotRamp,
    ),
    ...DEPOT_DOOR.x.map((x) =>
      frontDoor(DEPOT_DOOR.w, DEPOT_DOOR.h, x, front, C.FRAME, DEPOT_DOCK.h),
    ),
    box(
      DEPOT_OFFICE.w,
      DEPOT_OFFICE.h,
      DEPOT_OFFICE.d,
      officeX,
      DEPOT_OFFICE.h / 2,
      DEPOT_OFFICE.z,
      C.CONCRETE,
    ),
    // Office roof, its west eave tucked against the hall wall.
    box(
      DEPOT_OFFICE.w + EAVE,
      SLAB,
      DEPOT_OFFICE.d + 2 * EAVE,
      officeX + EAVE / 2,
      DEPOT_OFFICE.h + SLAB / 2,
      DEPOT_OFFICE.z,
      C.ROOF_DARK,
    ),
    ...DEPOT_LINE.x.map((x) =>
      box(
        DEPOT_LINE.w,
        MARK,
        DEPOT_LINE.z1 - DEPOT_LINE.z0,
        x,
        MARK / 2,
        (DEPOT_LINE.z0 + DEPOT_LINE.z1) / 2,
        C.MARKING,
      ),
    ),
    box(VAN.w, VAN.box.h, VAN.box.d, VAN.x, VAN.box.h / 2, VAN.box.z0 + VAN.box.d / 2, C.van),
    box(VAN.w, VAN.cab.h, VAN.cab.d, VAN.x, VAN.cab.h / 2, cabZ, C.FRAME),
    lamp.part,
  ];
  const { geometry, parts: n } = merge(parts);
  const sill = 0.08;
  return {
    geometry,
    parts: n,
    plinth: { sx: FULL_PLINTH, sz: FULL_PLINTH, color: C.CONCRETE },
    windows: [
      win(officeX - 0.05, sill, officeFront, 0),
      win(officeX + 0.05, sill, officeFront, 0),
      win(officeEast, sill, DEPOT_OFFICE.z, 1),
    ],
    lamps: [lamp.lamp],
  };
}

// --- Bus depot --------------------------------------------------------------

const BUS_SHED = { w: 0.66, h: 0.3, d: 0.5, x: -0.1, z: -0.12, roofH: 0.06 };
const BUS_DOOR = { w: 0.18, h: 0.22, x: [-0.28, 0.02] };
const BUS_OFFICE = { w: 0.2, h: 0.2, d: 0.24, z: -0.25 };
/** Washing bay portal east of the shed: two legs, a beam, two hanging brushes. */
const WASH = {
  x0: 0.28,
  x1: 0.44,
  z: 0.25,
  h: 0.22,
  beam: 0.03,
  leg: 0.025,
  brush: 0.02,
  brushH: 0.18,
};
/** A bus waiting in front of the west door. */
const BUS = { w: 0.12, h: 0.11, d: 0.3, z: 0.3, band: { h: 0.03, y: 0.06 } };

function busDepot(): PlantModel {
  const front = BUS_SHED.z + BUS_SHED.d / 2;
  const back = BUS_SHED.z - BUS_SHED.d / 2;
  const west = BUS_SHED.x - BUS_SHED.w / 2;
  const shedEast = BUS_SHED.x + BUS_SHED.w / 2;
  const officeX = shedEast + BUS_OFFICE.w / 2;
  const officeEast = shedEast + BUS_OFFICE.w;
  const officeFront = BUS_OFFICE.z + BUS_OFFICE.d / 2;
  const washX = (WASH.x0 + WASH.x1) / 2;
  const legH = WASH.h - WASH.beam;
  const busX = BUS_DOOR.x[0];
  const parts = [
    box(BUS_SHED.w, BUS_SHED.h, BUS_SHED.d, BUS_SHED.x, BUS_SHED.h / 2, BUS_SHED.z, C.busHall),
    gable(
      BUS_SHED.w + 2 * EAVE,
      BUS_SHED.roofH,
      BUS_SHED.d + 2 * EAVE,
      BUS_SHED.x,
      BUS_SHED.h + BUS_SHED.roofH / 2,
      BUS_SHED.z,
      C.busRoof,
    ),
    ...BUS_DOOR.x.map((x) => frontDoor(BUS_DOOR.w, BUS_DOOR.h, x, front, C.FRAME)),
    box(
      BUS_OFFICE.w,
      BUS_OFFICE.h,
      BUS_OFFICE.d,
      officeX,
      BUS_OFFICE.h / 2,
      BUS_OFFICE.z,
      C.CONCRETE,
    ),
    box(
      BUS_OFFICE.w + EAVE,
      SLAB,
      BUS_OFFICE.d + 2 * EAVE,
      officeX + EAVE / 2,
      BUS_OFFICE.h + SLAB / 2,
      BUS_OFFICE.z,
      C.ROOF_DARK,
    ),
    ...[WASH.x0, WASH.x1].map((x) => box(WASH.leg, legH, WASH.leg, x, legH / 2, WASH.z, C.STEEL)),
    box(
      WASH.x1 - WASH.x0 + WASH.leg,
      WASH.beam,
      WASH.leg + 0.01,
      washX,
      legH + WASH.beam / 2,
      WASH.z,
      C.STEEL,
    ),
    ...[WASH.x0 + 0.04, WASH.x1 - 0.04].map((x) =>
      cylinder(WASH.brush, WASH.brushH, x, legH - WASH.brushH / 2, WASH.z, C.washBrush),
    ),
    box(BUS.w, BUS.h, BUS.d, busX, BUS.h / 2, BUS.z, C.bus),
    // Window band, a hair proud of the bus sides.
    box(BUS.w + 0.004, BUS.band.h, BUS.d - 0.02, busX, BUS.band.y + BUS.band.h / 2, BUS.z, C.GLASS),
  ];
  const { geometry, parts: n } = merge(parts);
  const officeSill = 0.06;
  const shedSill = 0.16;
  return {
    geometry,
    parts: n,
    plinth: { sx: FULL_PLINTH, sz: FULL_PLINTH, color: C.CONCRETE },
    windows: [
      win(officeX, officeSill, officeFront, 0),
      win(officeEast, officeSill, BUS_OFFICE.z, 1),
      win(west, shedSill, BUS_SHED.z, 3),
      win(-0.25, shedSill, back, 2),
      win(0.05, shedSill, back, 2),
    ],
    lamps: [],
  };
}

// --- Substation -------------------------------------------------------------

const TRANSFORMER = { w: 0.18, h: 0.2, d: 0.14, z: 0.08, x: [-0.2, 0.1] };
/** Radiator fin pack on each transformer's front (+z). */
const RADIATOR = { w: 0.14, h: 0.16, d: 0.03 };
/** Busbar gantries spanning x; the back one carries the hanging insulators. */
const SUB_GANTRY = { x: 0.3, z: [-0.34, -0.12], post: 0.03, h: 0.44, beam: 0.03 };
const INSULATOR = { r: 0.015, h: 0.08, x: [-0.18, 0, 0.18] };
const HUT = { w: 0.2, h: 0.18, d: 0.16, x: 0.3, z: 0.3 };
/** Low mesh fence around the yard, standing on the ground. */
const SUB_FENCE = { at: 0.45, h: 0.1, t: 0.012 };

function substation(): PlantModel {
  const radiatorZ = TRANSFORMER.z + TRANSFORMER.d / 2 + RADIATOR.d / 2;
  const hutFront = HUT.z + HUT.d / 2;
  const span = 2 * SUB_GANTRY.x + SUB_GANTRY.post;
  const lamps = [yardLamp(-0.4, 0.38), yardLamp(0.4, -0.22)];
  const fenceLen = 2 * SUB_FENCE.at;
  const sideLen = fenceLen - SUB_FENCE.t;
  const parts = [
    ...TRANSFORMER.x.flatMap((x) => [
      box(
        TRANSFORMER.w,
        TRANSFORMER.h,
        TRANSFORMER.d,
        x,
        TRANSFORMER.h / 2,
        TRANSFORMER.z,
        C.substationBox,
      ),
      box(RADIATOR.w, RADIATOR.h, RADIATOR.d, x, RADIATOR.h / 2, radiatorZ, C.STEEL),
    ]),
    ...SUB_GANTRY.z.flatMap((z) => [
      ...[-SUB_GANTRY.x, SUB_GANTRY.x].map((x) =>
        box(SUB_GANTRY.post, SUB_GANTRY.h, SUB_GANTRY.post, x, SUB_GANTRY.h / 2, z, C.FENCE),
      ),
      box(
        span,
        SUB_GANTRY.beam,
        SUB_GANTRY.post,
        0,
        SUB_GANTRY.h + SUB_GANTRY.beam / 2,
        z,
        C.FENCE,
      ),
    ]),
    ...INSULATOR.x.map((x) =>
      cylinder(
        INSULATOR.r,
        INSULATOR.h,
        x,
        SUB_GANTRY.h - INSULATOR.h / 2,
        SUB_GANTRY.z[0],
        C.substationInsulator,
      ),
    ),
    box(HUT.w, HUT.h, HUT.d, HUT.x, HUT.h / 2, HUT.z, C.hut),
    roofSlab(HUT.w, HUT.d, HUT.x, HUT.h, HUT.z, C.ROOF_DARK),
    ...[-SUB_FENCE.at, SUB_FENCE.at].flatMap((at) => [
      box(fenceLen, SUB_FENCE.h, SUB_FENCE.t, 0, SUB_FENCE.h / 2, at, C.FENCE),
      box(SUB_FENCE.t, SUB_FENCE.h, sideLen, at, SUB_FENCE.h / 2, 0, C.FENCE),
    ]),
    ...lamps.map((l) => l.part),
  ];
  const { geometry, parts: n } = merge(parts);
  return {
    geometry,
    parts: n,
    plinth: { sx: 0.96, sz: 0.96, color: C.GRAVEL },
    windows: [win(HUT.x, 0.05, hutFront, 0)],
    lamps: lamps.map((l) => l.lamp),
  };
}

// --- Train station ----------------------------------------------------------

/** Platform along the track edge (+z), adjoining the station building's front. */
const PLATFORM = { w: 0.96, h: 0.06, z0: 0.24, z1: 0.49 };
const STATION = { w: 0.5, h: 0.26, z0: -0.1, roofH: 0.16 };
const PLATFORM_CANOPY = {
  w: 0.8,
  h: 0.02,
  top: 0.32,
  z0: 0.3,
  z1: 0.46,
  column: 0.02,
  x: [-0.3, 0, 0.3],
};
const CLOCK = { x: 0.44, z: 0.38, r: 0.008, postH: 0.2, size: 0.05, d: 0.02 };
const SAFETY_LINE = { w: 0.02, inset: 0.03 };

function trainStation(): PlantModel {
  const platformD = PLATFORM.z1 - PLATFORM.z0;
  const platformZ = (PLATFORM.z0 + PLATFORM.z1) / 2;
  const stationD = PLATFORM.z0 - STATION.z0;
  const stationZ = (PLATFORM.z0 + STATION.z0) / 2;
  const canopySoffit = PLATFORM_CANOPY.top - PLATFORM_CANOPY.h;
  const columnH = canopySoffit - PLATFORM.h;
  const canopyZ = (PLATFORM_CANOPY.z0 + PLATFORM_CANOPY.z1) / 2;
  const clockY = PLATFORM.h + CLOCK.postH;
  const poleLamp = yardLamp(-0.45, canopyZ, 0.32, PLATFORM.h);
  const hangingY = canopySoffit - HANGING_LAMP_DROP;
  const hanging: LampAnchor[] = [-0.15, 0.15].map((x) => ({
    x,
    y: hangingY,
    z: canopyZ,
    kind: 'yard',
  }));
  const parts = [
    box(PLATFORM.w, PLATFORM.h, platformD, 0, PLATFORM.h / 2, platformZ, C.platform),
    box(
      PLATFORM.w,
      MARK,
      SAFETY_LINE.w,
      0,
      PLATFORM.h + MARK / 2,
      PLATFORM.z1 - SAFETY_LINE.inset,
      C.safetyLine,
    ),
    box(
      PLATFORM_CANOPY.w,
      PLATFORM_CANOPY.h,
      PLATFORM_CANOPY.z1 - PLATFORM_CANOPY.z0,
      0,
      canopySoffit + PLATFORM_CANOPY.h / 2,
      canopyZ,
      C.ROOF_DARK,
    ),
    ...PLATFORM_CANOPY.x.map((x) =>
      box(
        PLATFORM_CANOPY.column,
        columnH,
        PLATFORM_CANOPY.column,
        x,
        PLATFORM.h + columnH / 2,
        canopyZ,
        C.FRAME,
      ),
    ),
    box(STATION.w, STATION.h, stationD, 0, STATION.h / 2, stationZ, C.stationWall),
    gable(
      STATION.w + 2 * EAVE,
      STATION.roofH,
      stationD + 2 * EAVE,
      0,
      STATION.h + STATION.roofH / 2,
      stationZ,
      C.stationRoof,
    ),
    // Entrance onto the platform.
    frontDoor(0.08, 0.15, 0, PLATFORM.z0, C.FRAME, PLATFORM.h),
    cylinder(CLOCK.r, CLOCK.postH, CLOCK.x, PLATFORM.h + CLOCK.postH / 2, CLOCK.z, C.FRAME),
    box(CLOCK.size, CLOCK.size, CLOCK.d, CLOCK.x, clockY + CLOCK.size / 2, CLOCK.z, C.clockFace),
    poleLamp.part,
  ];
  const { geometry, parts: n } = merge(parts);
  const sill = 0.08;
  return {
    geometry,
    parts: n,
    plinth: { sx: FULL_PLINTH, sz: FULL_PLINTH, color: C.CONCRETE },
    windows: [
      win(-0.15, sill, PLATFORM.z0, 0),
      win(0.15, sill, PLATFORM.z0, 0),
      win(-0.15, sill, STATION.z0, 2),
      win(0.15, sill, STATION.z0, 2),
    ],
    lamps: [poleLamp.lamp, ...hanging],
  };
}

// --- Freight terminal -------------------------------------------------------

/** Gantry crane: a beam along z reaching over the track edge (+z), on two legs. */
const CRANE = {
  x: 0,
  legZ: [-0.28, 0.44],
  leg: 0.04,
  top: 0.61,
  beam: 0.04,
  beamW: 0.06,
  z0: -0.31,
  z1: 0.47,
};
/** Trolley on the beam, lowering a container on its cable. */
const TROLLEY = { size: 0.08, h: 0.04, z: 0.3, cable: 0.006, cableH: 0.2 };
const CONTAINER = { l: 0.26, h: 0.08, w: 0.1 };
/** Stacks under the crane (x = 0) and one beside it, bottom to top. */
const STACKS: { x: number; z: number; colors: number[] }[] = [
  { x: 0, z: -0.15, colors: [C.containerGreen, C.containerRust] },
  { x: 0, z: -0.03, colors: [C.containerBlue, C.containerGreen] },
  { x: 0, z: 0.09, colors: [C.containerRust] },
  { x: 0.3, z: -0.3, colors: [C.containerBlue, C.containerRust] },
];
const FREIGHT_OFFICE = { w: 0.24, h: 0.2, d: 0.2, x: -0.32, z: -0.3 };

function freightTerminal(): PlantModel {
  const legH = CRANE.top - CRANE.beam;
  const trolleyY = legH - TROLLEY.h / 2;
  const cableTop = legH - TROLLEY.h;
  const cableBottom = cableTop - TROLLEY.cableH;
  const officeFront = FREIGHT_OFFICE.z + FREIGHT_OFFICE.d / 2;
  const officeEast = FREIGHT_OFFICE.x + FREIGHT_OFFICE.w / 2;
  const lamp = yardLamp(-0.42, 0.4);
  const parts = [
    ...CRANE.legZ.map((z) => box(CRANE.leg, legH, CRANE.leg, CRANE.x, legH / 2, z, C.gantry)),
    box(
      CRANE.beamW,
      CRANE.beam,
      CRANE.z1 - CRANE.z0,
      CRANE.x,
      legH + CRANE.beam / 2,
      (CRANE.z0 + CRANE.z1) / 2,
      C.gantry,
    ),
    box(TROLLEY.size, TROLLEY.h, TROLLEY.size, CRANE.x, trolleyY, TROLLEY.z, C.FRAME),
    box(
      TROLLEY.cable,
      TROLLEY.cableH,
      TROLLEY.cable,
      CRANE.x,
      (cableTop + cableBottom) / 2,
      TROLLEY.z,
      C.FRAME,
    ),
    box(
      CONTAINER.w,
      CONTAINER.h,
      CONTAINER.l / 2,
      CRANE.x,
      cableBottom - CONTAINER.h / 2,
      TROLLEY.z,
      C.containerBlue,
    ),
    ...STACKS.flatMap((s) =>
      s.colors.map((color, level) =>
        box(CONTAINER.l, CONTAINER.h, CONTAINER.w, s.x, (level + 0.5) * CONTAINER.h, s.z, color),
      ),
    ),
    box(
      FREIGHT_OFFICE.w,
      FREIGHT_OFFICE.h,
      FREIGHT_OFFICE.d,
      FREIGHT_OFFICE.x,
      FREIGHT_OFFICE.h / 2,
      FREIGHT_OFFICE.z,
      C.CONCRETE,
    ),
    roofSlab(
      FREIGHT_OFFICE.w,
      FREIGHT_OFFICE.d,
      FREIGHT_OFFICE.x,
      FREIGHT_OFFICE.h,
      FREIGHT_OFFICE.z,
      C.ROOF_DARK,
    ),
    lamp.part,
  ];
  const { geometry, parts: n } = merge(parts);
  const sill = 0.06;
  return {
    geometry,
    parts: n,
    plinth: { sx: FULL_PLINTH, sz: FULL_PLINTH, color: C.GRAVEL },
    windows: [
      win(FREIGHT_OFFICE.x - 0.06, sill, officeFront, 0),
      win(FREIGHT_OFFICE.x + 0.06, sill, officeFront, 0),
      win(officeEast, sill, FREIGHT_OFFICE.z, 1),
    ],
    lamps: [lamp.lamp],
  };
}

// --- Rail yard --------------------------------------------------------------

/** Engine shed, long along z, its doors facing the track (+z). */
const SHED = { w: 0.44, h: 0.26, d: 0.56, x: -0.12, z: 0, roofH: 0.14 };
/** The east door sits on the centre line, where the track tile's stub meets the siding. */
const SHED_DOOR = { w: 0.14, h: 0.2, x: [-0.23, 0] };
/**
 * Sidings out of both doors: a ballast strip with the rails on it. Its
 * rail tops match the track tile's (trackbed 0.04 + rail 0.03 over the
 * ground; the plinth already lifts the model by 0.015). The east siding
 * runs to the tile edge, the west one ends at a buffer stop.
 */
const SIDING = { w: 0.3, bed: 0.025, gauge: 0.09, railW: 0.03, railH: 0.03, westEnd: 0.44 };
const BUFFER = { w: 0.2, h: 0.06, d: 0.02 };
/** Inspection pit between the rails in front of the west door, up to the buffer stop. */
const PIT = { w: 0.08, z1: 0.42 };
/** Sand tower: column, funnel, hopper and a conical lid. */
const SAND = {
  x: 0.3,
  z: 0.22,
  column: 0.02,
  columnH: 0.2,
  r: 0.06,
  funnel: 0.05,
  hopper: 0.1,
  lid: 0.04,
};
const YARD_OFFICE = { w: 0.18, h: 0.18, d: 0.18, x: 0.3, z: -0.25 };
/** Shunting locomotive standing in front of the east door. */
const LOCO = { w: 0.1, frame: 0.03, body: 0.09, cab: 0.05, z0: 0.3, z1: 0.48, cabD: 0.06 };

/** A siding from the shed front to `end`, centred on `x`: ballast bed and two rails. */
function siding(x: number, from: number, end: number): THREE.BufferGeometry[] {
  const length = end - from;
  const z = (from + end) / 2;
  const parts = [box(SIDING.w, SIDING.bed, length, x, SIDING.bed / 2, z, C.ballast)];
  for (const side of [-1, 1]) {
    parts.push(
      box(
        SIDING.railW,
        SIDING.railH,
        length,
        x + side * SIDING.gauge,
        SIDING.bed + SIDING.railH / 2,
        z,
        C.rail,
      ),
    );
  }
  return parts;
}

function railYard(): PlantModel {
  const shedFront = SHED.z + SHED.d / 2;
  const shedBack = SHED.z - SHED.d / 2;
  const shedEast = SHED.x + SHED.w / 2;
  const funnelY = SAND.columnH;
  const hopperY = funnelY + SAND.funnel;
  const lidY = hopperY + SAND.hopper;
  const locoX = SHED_DOOR.x[1];
  const locoD = LOCO.z1 - LOCO.z0;
  const locoZ = (LOCO.z0 + LOCO.z1) / 2;
  /** The locomotive stands on the east siding's rails. */
  const locoY = SIDING.bed + SIDING.railH;
  const officeFront = YARD_OFFICE.z + YARD_OFFICE.d / 2;
  const officeEast = YARD_OFFICE.x + YARD_OFFICE.w / 2;
  const lamp = yardLamp(0.42, 0.42);
  const parts = [
    box(SHED.w, SHED.h, SHED.d, SHED.x, SHED.h / 2, SHED.z, C.yardHall),
    gable(
      SHED.w + 2 * EAVE,
      SHED.roofH,
      SHED.d + 2 * EAVE,
      SHED.x,
      SHED.h + SHED.roofH / 2,
      SHED.z,
      C.yardRoof,
      'z',
    ),
    ...SHED_DOOR.x.map((x) => frontDoor(SHED_DOOR.w, SHED_DOOR.h, x, shedFront, C.FRAME)),
    ...siding(SHED_DOOR.x[0], shedFront, SIDING.westEnd),
    ...siding(SHED_DOOR.x[1], shedFront, 0.5),
    box(
      BUFFER.w,
      BUFFER.h,
      BUFFER.d,
      SHED_DOOR.x[0],
      SIDING.bed + BUFFER.h / 2,
      SIDING.westEnd + BUFFER.d / 2,
      C.FRAME,
    ),
    box(
      PIT.w,
      MARK,
      PIT.z1 - shedFront - DOOR_DEPTH,
      SHED_DOOR.x[0],
      SIDING.bed + MARK / 2,
      (PIT.z1 + shedFront + DOOR_DEPTH) / 2,
      C.GLASS,
    ),
    cylinder(SAND.column, SAND.columnH, SAND.x, SAND.columnH / 2, SAND.z, C.STEEL),
    cone(SAND.column, SAND.r, SAND.funnel, SAND.x, funnelY + SAND.funnel / 2, SAND.z, C.STEEL),
    cylinder(SAND.r, SAND.hopper, SAND.x, hopperY + SAND.hopper / 2, SAND.z, C.gantry),
    cone(SAND.r + 0.01, 0.01, SAND.lid, SAND.x, lidY + SAND.lid / 2, SAND.z, C.ROOF_DARK),
    box(
      YARD_OFFICE.w,
      YARD_OFFICE.h,
      YARD_OFFICE.d,
      YARD_OFFICE.x,
      YARD_OFFICE.h / 2,
      YARD_OFFICE.z,
      C.CONCRETE,
    ),
    roofSlab(
      YARD_OFFICE.w,
      YARD_OFFICE.d,
      YARD_OFFICE.x,
      YARD_OFFICE.h,
      YARD_OFFICE.z,
      C.ROOF_DARK,
    ),
    box(LOCO.w, LOCO.frame, locoD, locoX, locoY + LOCO.frame / 2, locoZ, C.FRAME),
    box(LOCO.w, LOCO.body, locoD, locoX, locoY + LOCO.frame + LOCO.body / 2, locoZ, C.loco),
    box(
      LOCO.w,
      LOCO.cab,
      LOCO.cabD,
      locoX,
      locoY + LOCO.frame + LOCO.body + LOCO.cab / 2,
      LOCO.z0 + LOCO.cabD / 2,
      C.loco,
    ),
    lamp.part,
  ];
  const { geometry, parts: n } = merge(parts);
  const sill = 0.1;
  return {
    geometry,
    parts: n,
    // The plinth runs to the track edge, under the siding's end.
    plinth: { sx: FULL_PLINTH, sz: 1, color: C.GRAVEL },
    windows: [
      win(shedEast, sill, -0.15, 1),
      win(shedEast, sill, 0.05, 1),
      win(SHED.x, sill, shedBack, 2),
      win(YARD_OFFICE.x, 0.05, officeFront, 0),
      win(officeEast, 0.05, YARD_OFFICE.z, 1),
    ],
    lamps: [lamp.lamp],
  };
}

/** Builders for the service, grid and rail building types. */
export const serviceModels: Partial<Record<PlantType, () => PlantModel>> = {
  [PlantType.ChargingHub]: chargingHub,
  [PlantType.Park]: park,
  [PlantType.FireStation]: fireStation,
  [PlantType.PoliceStation]: policeStation,
  [PlantType.LogisticsDepot]: logisticsDepot,
  [PlantType.BusDepot]: busDepot,
  [PlantType.Substation]: substation,
  [PlantType.TrainStation]: trainStation,
  [PlantType.FreightTerminal]: freightTerminal,
  [PlantType.RailYard]: railYard,
};
