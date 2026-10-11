import { PlantType } from '../../shared/types.ts';
import { WINDOW_HEIGHT, WINDOW_WIDTH } from '../buildings/windowLayout.ts';
import { box, cone, cylinder, dome, gable, merge, sphere, tilted, tube } from '../modelKit.ts';
import type { Face, LampAnchor, PlantModel, WindowAnchor } from './models.ts';

/** Shared palette: today's plant colours plus a few structural tones. */
const C = {
  pedestal: 0x8a9099,
  panel: 0x2b3d66,
  pole: 0xe8eaec,
  nacelle: 0xd5d8db,
  batteryCabinet: 0x4d6b57,
  batteryFrame: 0x3a4048,
  biogasTank: 0x6c7f5a,
  biogasDome: 0x93ab6d,
  silage: 0x8b7d3a,
  weir: 0x9aa3ad,
  powerhouse: 0x5d6b7a,
  penstock: 0x7a8593,
  waterLight: 0x7fb6dd,
  hydrogenTank: 0xe6ebee,
  hydrogenBand: 0x54b8c9,
  hydrogenHall: 0x9aa3ad,
  hallRoof: 0xe4e7ea,
  tidalHousing: 0x4d6b73,
  tidalPylon: 0x9aa3ad,
  tidalBuoy: 0xe8a23a,
  gantry: 0xd9a441,
  geoHall: 0x6b5f57,
  geoTower: 0xd7d2c8,
  geoWellhead: 0xb5482f,
  heatHall: 0x7a4a3a,
  heatStack: 0xd9822b,
  heatRoof: 0xe4e7ea,
  storeTank: 0xc9a227,
  storePlinth: 0x6f7a86,
  storeCap: 0xe6ebee,
  fencePost: 0x9aa3ad,
  CONCRETE: 0x9a9da3,
  GRAVEL: 0x8a8478,
  STEEL: 0x6f7a86,
  ROOF_DARK: 0x4b5563,
  GLASS: 0x2b3440,
} as const;

/** Plinth size for models that fill most of their tile. */
const FULL_PLINTH = 0.92;
/** Yard lamp: pole height and its section. */
const LAMP_POLE_HEIGHT = 0.4;
const LAMP_POLE_SIZE = 0.02;

/** A standard-size window with its glass bottom at y on a wall facing `face`. */
function win(x: number, y: number, z: number, face: Face): WindowAnchor {
  return { x, y, z, face, w: WINDOW_WIDTH, h: WINDOW_HEIGHT };
}

/** Yard lamp pole standing at (x, z); returns the part and the lamp at its top. */
function yardLamp(x: number, z: number) {
  const part = box(
    LAMP_POLE_SIZE,
    LAMP_POLE_HEIGHT,
    LAMP_POLE_SIZE,
    x,
    LAMP_POLE_HEIGHT / 2,
    z,
    C.batteryFrame,
  );
  const lamp: LampAnchor = { x, y: LAMP_POLE_HEIGHT, z, kind: 'yard' };
  return { part, lamp };
}

// --- Solar farm -------------------------------------------------------------

const SOLAR_ROWS = [-0.3, 0, 0.3];
const SOLAR_TILT = 0.25;
const SOLAR_PANEL = { w: 0.74, h: 0.02, d: 0.24, y: 0.12 };
const SOLAR_POST_X = 0.28;
const SOLAR_POST_TOP = 0.11;
const SOLAR_RAIL_Z = 0.47;

function solarFarm(): PlantModel {
  const parts = [];
  for (const z of SOLAR_ROWS) {
    // Panels face −z: the +z edge rises.
    parts.push(
      tilted(
        box(SOLAR_PANEL.w, SOLAR_PANEL.h, SOLAR_PANEL.d, 0, SOLAR_PANEL.y, z, C.panel),
        -SOLAR_TILT,
      ),
    );
    // Mounting rail under the panel, on the posts.
    parts.push(box(SOLAR_PANEL.w, 0.015, 0.02, 0, SOLAR_POST_TOP - 0.0075, z, C.pole));
    for (const x of [-SOLAR_POST_X, SOLAR_POST_X])
      parts.push(box(0.025, SOLAR_POST_TOP, 0.025, x, SOLAR_POST_TOP / 2, z, C.STEEL));
  }
  // Inverter beside the rows.
  parts.push(box(0.08, 0.1, 0.12, 0.43, 0.05, -0.15, C.batteryFrame));
  // Low fence rails front and back.
  for (const z of [-SOLAR_RAIL_Z, SOLAR_RAIL_Z])
    parts.push(box(0.9, 0.04, 0.015, 0, 0.04, z, C.fencePost));
  const { geometry, parts: n } = merge(parts);
  return {
    geometry,
    parts: n,
    plinth: { sx: 0.96, sz: 0.96, color: C.GRAVEL },
    windows: [],
    lamps: [],
  };
}

// --- Wind turbine -----------------------------------------------------------

const HUB_HEIGHT = 0.85;
const TOWER_TOP = 0.8;
const FOUNDATION = { r: 0.1, h: 0.03 };
const NACELLE = { w: 0.1, h: 2 * (HUB_HEIGHT - TOWER_TOP), d: 0.2, z: -0.02 };
const HUB = { r: 0.035, z: 0.09 };

function windTurbine(): PlantModel {
  const nacelleTop = HUB_HEIGHT + NACELLE.h / 2;
  const towerH = TOWER_TOP - FOUNDATION.h;
  const { geometry, parts } = merge([
    cylinder(FOUNDATION.r, FOUNDATION.h, 0, FOUNDATION.h / 2, 0, C.CONCRETE),
    cone(0.06, 0.035, towerH, 0, FOUNDATION.h + towerH / 2, 0, C.pole),
    // Door at the tower foot.
    box(0.03, 0.06, 0.02, 0, FOUNDATION.h + 0.03, 0.052, C.STEEL),
    box(NACELLE.w, NACELLE.h, NACELLE.d, 0, HUB_HEIGHT, NACELLE.z, C.nacelle),
    sphere(HUB.r, 0, HUB_HEIGHT, HUB.z, C.pole),
    // Transformer cabinet beside the foundation.
    box(0.06, 0.07, 0.05, 0.1, 0.035, -0.08, C.STEEL),
  ]);
  return {
    geometry,
    parts,
    plinth: { sx: 0.3, sz: 0.3, color: C.CONCRETE },
    windows: [],
    lamps: [{ x: 0, y: nacelleTop, z: NACELLE.z - 0.06, kind: 'aviation' }],
    rotorHub: { x: 0, y: HUB_HEIGHT, z: HUB.z },
  };
}

// --- Battery ----------------------------------------------------------------

const CABINET = { w: 0.24, h: 0.5, d: 0.44, gap: 0.03, z: -0.06 };
const CABINET_FRONT = CABINET.z + CABINET.d / 2;
const CABINET_CAP = 0.04;
/** Vent louvre beside the SoC bar (bar half-width 0.05 + margin). */
const VENT_OFFSET = 0.075;
const SOC_BAR = { y: 0.03, w: 0.1, d: 0.03, maxH: 0.42 };

function battery(): PlantModel {
  const parts = [];
  const pitch = CABINET.w + CABINET.gap;
  for (const x of [-pitch, 0, pitch]) {
    parts.push(box(CABINET.w, CABINET.h, CABINET.d, x, CABINET.h / 2, CABINET.z, C.batteryCabinet));
    parts.push(
      box(
        CABINET.w + 0.02,
        CABINET_CAP,
        CABINET.d + 0.02,
        x,
        CABINET.h + CABINET_CAP / 2,
        CABINET.z,
        C.batteryFrame,
      ),
    );
    // Vent louvre strip on the door, beside the SoC bar.
    parts.push(box(0.04, 0.3, 0.01, x + VENT_OFFSET, 0.25, CABINET_FRONT + 0.005, C.GLASS));
  }
  // Transformer behind the cabinets, fed by a ground cable tray.
  parts.push(box(0.2, 0.24, 0.12, 0.27, 0.12, -0.42, C.STEEL));
  parts.push(box(0.5, 0.04, 0.06, -0.08, 0.02, -0.33, C.ROOF_DARK));
  const lamp = yardLamp(-0.42, 0.36);
  parts.push(lamp.part);
  const { geometry, parts: n } = merge(parts);
  return {
    geometry,
    parts: n,
    plinth: { sx: FULL_PLINTH, sz: FULL_PLINTH, color: C.CONCRETE },
    windows: [],
    lamps: [lamp.lamp],
    socFill: {
      x: 0,
      y: SOC_BAR.y,
      z: CABINET_FRONT,
      w: SOC_BAR.w,
      d: SOC_BAR.d,
      maxH: SOC_BAR.maxH,
    },
  };
}

// --- Biogas plant -----------------------------------------------------------

const DIGESTER = { r: 0.2, x: 0.18, z: 0.15 };
const DIGESTER_DOME_TOP = 0.345;
const DOME_SQUASH = 0.75;
const SMALL_TANK = { r: 0.12, h: 0.18, x: -0.27, z: 0.22, squash: 0.6 };

function biogasPlant(): PlantModel {
  const domeH = DIGESTER.r * DOME_SQUASH;
  const wallH = DIGESTER_DOME_TOP - domeH;
  const smallDomeH = SMALL_TANK.r * SMALL_TANK.squash;
  const { geometry, parts } = merge([
    cylinder(DIGESTER.r, wallH, DIGESTER.x, wallH / 2, DIGESTER.z, C.biogasTank),
    dome(DIGESTER.r, DOME_SQUASH, DIGESTER.x, wallH + domeH / 2, DIGESTER.z, C.biogasDome),
    cylinder(
      SMALL_TANK.r,
      SMALL_TANK.h,
      SMALL_TANK.x,
      SMALL_TANK.h / 2,
      SMALL_TANK.z,
      C.biogasTank,
    ),
    dome(
      SMALL_TANK.r,
      SMALL_TANK.squash,
      SMALL_TANK.x,
      SMALL_TANK.h + smallDomeH / 2,
      SMALL_TANK.z,
      C.biogasDome,
    ),
    // Silage clamp: a concrete slab with a covered heap on it.
    box(0.44, 0.06, 0.26, -0.2, 0.03, -0.3, C.CONCRETE),
    box(0.38, 0.06, 0.2, -0.2, 0.09, -0.3, C.silage),
    // Combined heat-and-power house.
    box(0.18, 0.14, 0.14, 0.3, 0.07, -0.22, C.pedestal),
    box(0.2, 0.02, 0.16, 0.3, 0.15, -0.22, C.ROOF_DARK),
    // Gas pipes: small tank → digester, digester → CHP house.
    tube(0.02, 0.24, -0.08, 0.06, 0.2, C.STEEL, 'x'),
    tube(0.015, 0.17, 0.26, 0.08, -0.08, C.STEEL, 'z'),
    // Flare stack with its tip.
    cylinder(0.015, 0.3, 0.43, 0.15, -0.42, C.STEEL),
    cylinder(0.025, 0.03, 0.43, 0.315, -0.42, C.heatStack),
  ]);
  return {
    geometry,
    parts,
    plinth: { sx: FULL_PLINTH, sz: FULL_PLINTH, color: C.CONCRETE },
    windows: [],
    lamps: [],
  };
}

// --- Run-of-river -----------------------------------------------------------

const WEIR = { w: 0.96, h: 0.2, d: 0.3 };
const RIVER_HOUSE = { x0: 0.2, x1: 0.49, h: 0.26, d: 0.34, roofH: 0.08 };
const PIER_X = [-0.36, -0.13, 0.1];

function runOfRiver(): PlantModel {
  const houseW = RIVER_HOUSE.x1 - RIVER_HOUSE.x0;
  const houseX = (RIVER_HOUSE.x0 + RIVER_HOUSE.x1) / 2;
  const houseFront = RIVER_HOUSE.d / 2;
  const parts = [
    box(WEIR.w, WEIR.h, WEIR.d, 0, WEIR.h / 2, 0, C.weir),
    // Water spilling over the crest between the piers.
    box(0.64, 0.02, WEIR.d - 0.02, -0.14, WEIR.h + 0.01, 0, C.waterLight),
    ...PIER_X.map((x) => box(0.05, 0.3, 0.34, x, 0.15, 0, C.CONCRETE)),
    box(houseW, RIVER_HOUSE.h, RIVER_HOUSE.d, houseX, RIVER_HOUSE.h / 2, 0, C.powerhouse),
    gable(
      houseW + 0.01,
      RIVER_HOUSE.roofH,
      RIVER_HOUSE.d + 0.02,
      houseX,
      RIVER_HOUSE.h + RIVER_HOUSE.roofH / 2,
      0,
      C.ROOF_DARK,
      'z',
    ),
    // Trash rack in front of the intake (upstream, −z): bars and a top rail.
    ...[0.27, 0.34, 0.41].map((x) => box(0.012, 0.2, 0.012, x, 0.1, -houseFront - 0.02, C.STEEL)),
    box(0.2, 0.015, 0.02, 0.34, 0.2, -houseFront - 0.02, C.STEEL),
  ];
  const { geometry, parts: n } = merge(parts);
  return {
    geometry,
    parts: n,
    plinth: { sx: 0.96, sz: 0.3, color: C.CONCRETE },
    windows: [win(0.28, 0.1, houseFront, 0), win(0.41, 0.1, houseFront, 0)],
    lamps: [],
  };
}

// --- Pumped storage ---------------------------------------------------------

const PUMP_HOUSE = { w: 0.6, h: 0.45, d: 0.5, z: -0.2 };
const PUMP_ROOF = 0.05;
const PENSTOCK = { r: 0.05, y: 0.1, x: 0.15, end: 0.48 };
const VALVE_HOUSE = { w: 0.44, h: 0.2, d: 0.14, z: 0.3 };

function pumpedStorage(): PlantModel {
  const front = PUMP_HOUSE.z + PUMP_HOUSE.d / 2;
  const back = PUMP_HOUSE.z - PUMP_HOUSE.d / 2;
  const pipeStart = front - 0.02;
  const pipeLen = PENSTOCK.end - pipeStart;
  const pipeZ = (PENSTOCK.end + pipeStart) / 2;
  const parts = [
    box(PUMP_HOUSE.w, PUMP_HOUSE.h, PUMP_HOUSE.d, 0, PUMP_HOUSE.h / 2, PUMP_HOUSE.z, C.powerhouse),
    box(
      PUMP_HOUSE.w + 0.04,
      PUMP_ROOF,
      PUMP_HOUSE.d + 0.04,
      0,
      PUMP_HOUSE.h + PUMP_ROOF / 2,
      PUMP_HOUSE.z,
      C.batteryFrame,
    ),
    // Gate door on the back wall.
    box(0.16, 0.2, 0.01, 0, 0.1, back - 0.005, C.batteryFrame),
    // Penstocks toward the lake (+z), with a wall collar each.
    ...[-PENSTOCK.x, PENSTOCK.x].flatMap((x) => [
      tube(PENSTOCK.r, pipeLen, x, PENSTOCK.y, pipeZ, C.penstock, 'z'),
      tube(PENSTOCK.r + 0.015, 0.03, x, PENSTOCK.y, front + 0.015, C.STEEL, 'z'),
    ]),
    // Valve house straddling the penstocks, with a roof slab.
    box(
      VALVE_HOUSE.w,
      VALVE_HOUSE.h,
      VALVE_HOUSE.d,
      0,
      VALVE_HOUSE.h / 2,
      VALVE_HOUSE.z,
      C.CONCRETE,
    ),
    box(
      VALVE_HOUSE.w + 0.03,
      0.03,
      VALVE_HOUSE.d + 0.03,
      0,
      VALVE_HOUSE.h + 0.015,
      VALVE_HOUSE.z,
      C.batteryFrame,
    ),
  ];
  const { geometry, parts: n } = merge(parts);
  const sill = 0.26;
  return {
    geometry,
    parts: n,
    plinth: { sx: FULL_PLINTH, sz: FULL_PLINTH, color: C.CONCRETE },
    windows: [
      win(-0.2, sill, front, 0),
      win(0.2, sill, front, 0),
      win(-0.18, sill, back, 2),
      win(0.18, sill, back, 2),
    ],
    lamps: [],
  };
}

// --- Hydrogen plant ---------------------------------------------------------

const H2_HALL = { w: 0.62, h: 0.34, d: 0.44, x: -0.12, z: -0.2 };
const H2_ROOF = 0.04;
const H2_TANK = { r: 0.08, l: 0.4, x: -0.15, y: 0.11, z: [0.16, 0.36] };
const H2_SPHERE = { r: 0.12, x: 0.3, z: 0.26, skirt: 0.07 };
const H2_STACK = { r: 0.03, h: 0.56, x: 0.36, z: -0.36 };

function hydrogenPlant(): PlantModel {
  const hallFront = H2_HALL.z + H2_HALL.d / 2;
  const hallBack = H2_HALL.z - H2_HALL.d / 2;
  const hallEast = H2_HALL.x + H2_HALL.w / 2;
  const parts = [
    box(H2_HALL.w, H2_HALL.h, H2_HALL.d, H2_HALL.x, H2_HALL.h / 2, H2_HALL.z, C.hydrogenHall),
    box(
      H2_HALL.w + 0.04,
      H2_ROOF,
      H2_HALL.d + 0.04,
      H2_HALL.x,
      H2_HALL.h + H2_ROOF / 2,
      H2_HALL.z,
      C.hallRoof,
    ),
    // Horizontal tanks on two saddles, each with a teal H2 band.
    ...H2_TANK.z.flatMap((z) => [
      tube(H2_TANK.r, H2_TANK.l, H2_TANK.x, H2_TANK.y, z, C.hydrogenTank, 'x'),
      tube(H2_TANK.r + 0.005, 0.04, H2_TANK.x, H2_TANK.y, z, C.hydrogenBand, 'x'),
    ]),
    ...[H2_TANK.x - 0.13, H2_TANK.x + 0.13].map((x) =>
      box(0.03, 0.06, 0.36, x, 0.03, (H2_TANK.z[0] + H2_TANK.z[1]) / 2, C.CONCRETE),
    ),
    // Spherical tank on a short skirt.
    cylinder(0.06, H2_SPHERE.skirt, H2_SPHERE.x, H2_SPHERE.skirt / 2, H2_SPHERE.z, C.STEEL),
    sphere(
      H2_SPHERE.r,
      H2_SPHERE.x,
      H2_SPHERE.skirt + H2_SPHERE.r - 0.02,
      H2_SPHERE.z,
      C.hydrogenTank,
    ),
    // Pipe bridge from the hall front to the tank field.
    tube(0.015, 0.3, 0.1, 0.26, hallFront + 0.13, C.STEEL, 'z'),
    box(0.02, 0.26, 0.02, 0.1, 0.13, hallFront + 0.27, C.STEEL),
    // Vent stack beside the hall.
    cylinder(H2_STACK.r, H2_STACK.h, H2_STACK.x, H2_STACK.h / 2, H2_STACK.z, C.batteryFrame),
    cylinder(H2_STACK.r + 0.01, 0.03, H2_STACK.x, 0.2, H2_STACK.z, C.hydrogenBand),
  ];
  const lamp = yardLamp(0.45, -0.05);
  parts.push(lamp.part);
  const { geometry, parts: n } = merge(parts);
  const sill = 0.14;
  return {
    geometry,
    parts: n,
    plinth: { sx: FULL_PLINTH, sz: FULL_PLINTH, color: C.CONCRETE },
    windows: [
      win(-0.34, sill, hallBack, 2),
      win(-0.12, sill, hallBack, 2),
      win(0.1, sill, hallBack, 2),
      win(hallEast, sill, -0.3, 1),
      win(hallEast, sill, -0.1, 1),
    ],
    lamps: [lamp.lamp],
  };
}

// --- Tidal plant ------------------------------------------------------------

const BARRAGE = { w: 0.96, h: 0.22, d: 0.34 };
const TURBINE_HOUSE = { w: 0.2, h: 0.14, d: 0.24, x: [-0.28, 0, 0.28] };
const TIDAL_GANTRY = { x: 0.42, legZ: 0.13, top: 0.62, beam: 0.04 };

function tidalPlant(): PlantModel {
  const legH = TIDAL_GANTRY.top - TIDAL_GANTRY.beam - BARRAGE.h;
  const parts = [
    box(BARRAGE.w, BARRAGE.h, BARRAGE.d, 0, BARRAGE.h / 2, 0, C.weir),
    ...TURBINE_HOUSE.x.flatMap((x) => [
      box(
        TURBINE_HOUSE.w,
        TURBINE_HOUSE.h,
        TURBINE_HOUSE.d,
        x,
        BARRAGE.h + TURBINE_HOUSE.h / 2,
        0,
        C.tidalHousing,
      ),
      box(
        TURBINE_HOUSE.w + 0.02,
        0.02,
        TURBINE_HOUSE.d + 0.02,
        x,
        BARRAGE.h + TURBINE_HOUSE.h + 0.01,
        0,
        C.ROOF_DARK,
      ),
      // Sluice gate on the sea face (+z) below each house.
      box(0.16, 0.14, 0.01, x, 0.09, BARRAGE.d / 2 + 0.005, C.batteryFrame),
    ]),
    // Gate-lifting gantry portal at the east end.
    ...[-TIDAL_GANTRY.legZ, TIDAL_GANTRY.legZ].map((z) =>
      box(0.04, legH, 0.04, TIDAL_GANTRY.x, BARRAGE.h + legH / 2, z, C.gantry),
    ),
    box(
      0.06,
      TIDAL_GANTRY.beam,
      0.32,
      TIDAL_GANTRY.x,
      TIDAL_GANTRY.top - TIDAL_GANTRY.beam / 2,
      0,
      C.gantry,
    ),
    // Marker buoy off the sea face.
    cylinder(0.035, 0.05, -0.36, 0.025, 0.42, C.tidalBuoy),
    cone(0.03, 0.005, 0.06, -0.36, 0.08, 0.42, C.tidalBuoy),
  ];
  const { geometry, parts: n } = merge(parts);
  return {
    geometry,
    parts: n,
    plinth: { sx: 0.96, sz: 0.4, color: C.CONCRETE },
    windows: [],
    lamps: [{ x: TIDAL_GANTRY.x, y: TIDAL_GANTRY.top, z: 0, kind: 'aviation' }],
  };
}

// --- Geothermal plant -------------------------------------------------------

const GEO_HOUSE = { w: 0.4, h: 0.22, d: 0.3, x: -0.22, z: 0.2 };
const DRILL = { x: 0.25, z: -0.22, spread: 0.07, postH: 0.44, topH: 0.06 };
const COOLING_CELL = { size: 0.2, h: 0.18, z: -0.25, x: [-0.3, -0.08] };
const GEO_PIPE_Y = 0.06;

function geothermalPlant(): PlantModel {
  const houseFront = GEO_HOUSE.z + GEO_HOUSE.d / 2;
  const houseEast = GEO_HOUSE.x + GEO_HOUSE.w / 2;
  const parts = [
    box(
      GEO_HOUSE.w,
      GEO_HOUSE.h,
      GEO_HOUSE.d,
      GEO_HOUSE.x,
      GEO_HOUSE.h / 2,
      GEO_HOUSE.z,
      C.geoHall,
    ),
    box(
      GEO_HOUSE.w + 0.04,
      0.03,
      GEO_HOUSE.d + 0.04,
      GEO_HOUSE.x,
      GEO_HOUSE.h + 0.015,
      GEO_HOUSE.z,
      C.ROOF_DARK,
    ),
    // Drill tower: four posts and a crown block.
    ...[-1, 1].flatMap((sx) =>
      [-1, 1].map((sz) =>
        box(
          0.02,
          DRILL.postH,
          0.02,
          DRILL.x + sx * DRILL.spread,
          DRILL.postH / 2,
          DRILL.z + sz * DRILL.spread,
          C.geoTower,
        ),
      ),
    ),
    box(0.18, DRILL.topH, 0.18, DRILL.x, DRILL.postH + DRILL.topH / 2, DRILL.z, C.STEEL),
    cylinder(0.04, 0.1, DRILL.x, 0.05, DRILL.z, C.geoWellhead),
    // Cooling cells with a fan on top.
    ...COOLING_CELL.x.flatMap((x) => [
      box(
        COOLING_CELL.size,
        COOLING_CELL.h,
        COOLING_CELL.size,
        x,
        COOLING_CELL.h / 2,
        COOLING_CELL.z,
        C.geoTower,
      ),
      cylinder(0.07, 0.03, x, COOLING_CELL.h + 0.015, COOLING_CELL.z, C.STEEL),
    ]),
    // Pipe runs: wellhead → cooling cells, wellhead → control house.
    tube(0.02, 0.22, 0.11, GEO_PIPE_Y, DRILL.z, C.pole, 'x'),
    tube(0.02, 0.4, DRILL.x, GEO_PIPE_Y, 0.01, C.pole, 'z'),
    tube(0.02, 0.29, (houseEast + DRILL.x + 0.02) / 2, GEO_PIPE_Y, GEO_HOUSE.z, C.pole, 'x'),
  ];
  const { geometry, parts: n } = merge(parts);
  const sill = 0.08;
  return {
    geometry,
    parts: n,
    plinth: { sx: FULL_PLINTH, sz: FULL_PLINTH, color: C.GRAVEL },
    windows: [
      win(-0.32, sill, houseFront, 0),
      win(-0.12, sill, houseFront, 0),
      win(houseEast, sill, 0.28, 1),
    ],
    lamps: [],
  };
}

// --- Heat plant -------------------------------------------------------------

const HEAT_HALL = { w: 0.7, h: 0.26, d: 0.46, x: -0.06, z: 0.06 };
const HEAT_ROOF = 0.04;
const HEAT_FAN = { r: 0.08, h: 0.05, x: [-0.28, -0.06, 0.16] };
const HEAT_STACK = { r: 0.035, h: 0.62, x: 0.38, z: -0.32 };

function heatPlant(): PlantModel {
  const roofTop = HEAT_HALL.h + HEAT_ROOF;
  const front = HEAT_HALL.z + HEAT_HALL.d / 2;
  const back = HEAT_HALL.z - HEAT_HALL.d / 2;
  const east = HEAT_HALL.x + HEAT_HALL.w / 2;
  const parts = [
    box(
      HEAT_HALL.w,
      HEAT_HALL.h,
      HEAT_HALL.d,
      HEAT_HALL.x,
      HEAT_HALL.h / 2,
      HEAT_HALL.z,
      C.heatHall,
    ),
    box(
      HEAT_HALL.w + 0.04,
      HEAT_ROOF,
      HEAT_HALL.d + 0.04,
      HEAT_HALL.x,
      HEAT_HALL.h + HEAT_ROOF / 2,
      HEAT_HALL.z,
      C.heatRoof,
    ),
    // Heat-pump fan units on the roof, each with a dark fan grille.
    ...HEAT_FAN.x.flatMap((x) => [
      cylinder(HEAT_FAN.r, HEAT_FAN.h, x, roofTop + HEAT_FAN.h / 2, HEAT_HALL.z, C.STEEL),
      cylinder(HEAT_FAN.r - 0.015, 0.01, x, roofTop + HEAT_FAN.h + 0.005, HEAT_HALL.z, C.GLASS),
    ]),
    // District-heating outlet leaving the east wall.
    tube(0.03, 0.2, east + 0.09, 0.08, 0.18, C.heatStack, 'x'),
    // Small stack with a band.
    cylinder(HEAT_STACK.r, HEAT_STACK.h, HEAT_STACK.x, HEAT_STACK.h / 2, HEAT_STACK.z, C.heatStack),
    cylinder(
      HEAT_STACK.r + 0.008,
      0.03,
      HEAT_STACK.x,
      HEAT_STACK.h - 0.06,
      HEAT_STACK.z,
      C.batteryFrame,
    ),
    // Door on the front.
    box(0.12, 0.18, 0.01, 0.18, 0.09, front + 0.005, C.batteryFrame),
  ];
  const { geometry, parts: n } = merge(parts);
  const sill = 0.1;
  return {
    geometry,
    parts: n,
    plinth: { sx: FULL_PLINTH, sz: FULL_PLINTH, color: C.CONCRETE },
    windows: [
      win(-0.3, sill, front, 0),
      win(-0.08, sill, front, 0),
      win(-0.26, sill, back, 2),
      win(0.04, sill, back, 2),
    ],
    lamps: [],
  };
}

// --- Heat store -------------------------------------------------------------

const STORE_TANK = { r: 0.28, h: 0.49 };
const STORE_CAP = 0.02;
const STORE_BANDS = [0.12, 0.25, 0.38];
const STORE_STAIR = { x: 0.31, w: 0.04, run: 0.4, rise: 0.47 };

function heatStore(): PlantModel {
  const capTop = STORE_TANK.h + STORE_CAP;
  const stairLen = Math.hypot(STORE_STAIR.run, STORE_STAIR.rise);
  const stairAngle = Math.atan2(STORE_STAIR.rise, STORE_STAIR.run);
  const { geometry, parts } = merge([
    cylinder(STORE_TANK.r, STORE_TANK.h, 0, STORE_TANK.h / 2, 0, C.storeTank),
    ...STORE_BANDS.map((y) => cylinder(STORE_TANK.r + 0.008, 0.025, 0, y, 0, C.storePlinth)),
    cone(STORE_TANK.r, 0.06, STORE_CAP, 0, STORE_TANK.h + STORE_CAP / 2, 0, C.storeCap),
    // Stair up the east side, rising toward +z, with a landing at the top.
    tilted(
      box(STORE_STAIR.w, 0.012, stairLen, STORE_STAIR.x, STORE_STAIR.rise / 2 + 0.006, 0, C.STEEL),
      -stairAngle,
    ),
    box(
      0.06,
      0.012,
      0.08,
      STORE_STAIR.x - 0.01,
      STORE_STAIR.rise,
      STORE_STAIR.run / 2 + 0.03,
      C.STEEL,
    ),
    // District-heating connection at the foot.
    tube(0.03, 0.2, 0, 0.05, -0.38, C.storePlinth, 'z'),
  ]);
  return {
    geometry,
    parts,
    plinth: { sx: 0.7, sz: 0.7, color: C.CONCRETE },
    windows: [],
    lamps: [{ x: 0, y: capTop, z: 0, kind: 'aviation' }],
  };
}

/** Builders for the energy plant types. */
export const energyModels: Partial<Record<PlantType, () => PlantModel>> = {
  [PlantType.SolarFarm]: solarFarm,
  [PlantType.WindTurbine]: windTurbine,
  [PlantType.Battery]: battery,
  [PlantType.BiogasPlant]: biogasPlant,
  [PlantType.RunOfRiver]: runOfRiver,
  [PlantType.PumpedStorage]: pumpedStorage,
  [PlantType.HydrogenPlant]: hydrogenPlant,
  [PlantType.TidalPlant]: tidalPlant,
  [PlantType.GeothermalPlant]: geothermalPlant,
  [PlantType.HeatPlant]: heatPlant,
  [PlantType.HeatStore]: heatStore,
};
