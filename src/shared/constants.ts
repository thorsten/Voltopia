import { PlantType, SEASON_ORDER, Zone } from './types.ts';

/** Structural constants (not balancing). */
export const GRID_SIZE = 64;
export const TICK_RATE = 4; // simulation ticks per real-time second at 1x speed
export const TICK_MS = 1000 / TICK_RATE;
export const SAVE_VERSION = 1;

/** One in-game day lasts 4 real-time minutes at 1x speed. */
export const TICKS_PER_DAY = 4 * 60 * TICK_RATE;

/** Samples kept in the energy history graph (one per in-game half hour). */
export const ENERGY_HISTORY_SAMPLES = 48;
export const TICKS_PER_HISTORY_SAMPLE = TICKS_PER_DAY / ENERGY_HISTORY_SAMPLES;

/** In-game days per season; a year is SEASON_ORDER.length seasons. */
export const DAYS_PER_SEASON = 5;

/**
 * Central balancing configuration. All gameplay tuning values live here —
 * no magic numbers in simulation code.
 *
 * Energy amounts are in abstract "energy units" (EU) per tick.
 */
export const BALANCE = {
  startingMoney: 25_000,

  costs: {
    roadPerTile: 10,
    bridgePerTile: 40,
    /** Avenue on land; upgrading a street pays the difference to roadPerTile. */
    avenuePerTile: 30,
    /** Avenue over the river; upgrading a bridge pays the difference to bridgePerTile. */
    avenueBridgePerTile: 90,
    /** Power line per tile on land; over river or lake it is an overhead crossing. */
    powerLinePerTile: 4,
    powerLineWaterPerTile: 12,
    /** One bus stop marked on a road tile. */
    busStop: 60,
    zonePerTile: 5,
    insulation: 4_000,
    plant: {
      [PlantType.SolarFarm]: 1_200,
      /**
       * Wind is the expensive, more baseload-like investment; solar is
       * the cheap entry option. Priced from a headless probe
       * (scripts/probe-generation.mjs, deleted after use) over 3 in-game
       * years x 10 seeds: a turbine on an average land tile averages
       * 78.9 EU/tick — mean wind factor 0.574, mean site factor 1.144
       * (elevation 3.9, windForestFactor 0.97) — against a solar farm's
       * 23.1 EU/tick, whose mean solar factor of 0.154 is the product of
       * night, a 0.45 mean cloud cover and a 0.725 mean solarStrength.
       * At 4_500 that is 17.5 EU per 1_000 invested against solar's 19.2:
       * wind pays a ~9 % premium per unit of energy for generating at
       * night (and so needing less storage to be useful), and a
       * deliberately sited turbine (hilltop, clear of woods — site factor
       * up to 1.32) earns that premium back. (Was 1_800, i.e. 43.8 EU per
       * 1_000: wind out-produced solar 3.4:1 at 1.5x the price, so there
       * was no reason to ever build a solar farm.)
       */
      [PlantType.WindTurbine]: 4_500,
      [PlantType.Battery]: 1_500,
      [PlantType.BiogasPlant]: 2_500,
      [PlantType.ChargingHub]: 800,
      [PlantType.Park]: 400,
      [PlantType.RunOfRiver]: 2_200,
      [PlantType.PumpedStorage]: 4_000,
      [PlantType.FireStation]: 1_500,
      [PlantType.PoliceStation]: 1_200,
      [PlantType.LogisticsDepot]: 1_000,
      [PlantType.BusDepot]: 1_200,
      [PlantType.HydrogenPlant]: 5_000,
      /**
       * Priced like run-of-river (2_200) per unit of *effective* peak
       * output (peak x mean site factor), plus a modest premium for
       * marine construction — a probe-measured parity, not a coincidence.
       * Exempt from sea.offshoreCostFactor (see placePlant): a tidal
       * plant has no choice of going offshore the way a wind turbine
       * does, so its marine cost already lives in this base number —
       * applying the surcharge on top would silently break this parity.
       */
      [PlantType.TidalPlant]: 2_400,
      /**
       * Firmness is the cost. Probe-measured capital per unit of *mean*
       * output: run-of-river 86, tidal 108, geothermal 133 on a typical
       * quality-2 hotspot (103 on a quality-3 one, 190 on a quality-1
       * one). Geothermal pays about a fifth more than tidal per energy
       * unit and gets weather-proof baseload for it — and the quality
       * spread is what makes a poor hotspot a bad investment rather than
       * just a smaller one.
       */
      [PlantType.GeothermalPlant]: 3_200,
      /**
       * A large heat pump plus the street mains: priced near a
       * geothermal well. Probe-measured capital per unit of *avoided*
       * mean demand: two plants plus one store saved 69.3 EU/tick over a
       * full year, so 81 money per EU/tick and plant — beside
       * run-of-river's 86 for a plant whose saving is firm (no weather)
       * but only pays while it is cold and only for the buildings its
       * reach happens to cover. On a town less densely built than the
       * probe's it lands above geothermal's 133.
       */
      [PlantType.HeatPlant]: 2_800,
      /**
       * A hot-water tank: cheap capacity, but it only holds heat. Parity
       * with a battery at the measured charging COP of 2.52: per unit of
       * *electricity* it shifts the store costs 0.67 against the
       * battery's 0.50, so it never out-competes a battery
       * electricity-for-electricity. It wins only on heat, and only at
       * the peak the pumps cannot cover, where a battery's stored
       * electricity reaches the buildings as 1:1 own heating: 0.27 money
       * per heat unit against 0.50.
       */
      [PlantType.HeatStore]: 1_600,
    } as Record<PlantType, number>,
  },

  upkeepPerTick: {
    roadPerTile: 0.005,
    avenuePerTile: 0.012,
    powerLinePerTile: 0.0005,
    busStop: 0.004,
    plant: {
      [PlantType.SolarFarm]: 0.05,
      /**
       * 0.0022 per average EU generated (78.9 EU/tick, see the cost
       * above), the rate solar (0.0022), run-of-river (0.0024) and tidal
       * (0.0027) already run at. (Was 0.08 = 0.0010 per EU, under half
       * of every other plant's rate — the running-cost half of the same
       * wind dominance the cost above fixes.)
       */
      [PlantType.WindTurbine]: 0.17,
      [PlantType.Battery]: 0.04,
      [PlantType.BiogasPlant]: 0.1,
      [PlantType.ChargingHub]: 0.02,
      [PlantType.Park]: 0.015,
      [PlantType.RunOfRiver]: 0.06,
      [PlantType.PumpedStorage]: 0.08,
      [PlantType.FireStation]: 0.06,
      [PlantType.PoliceStation]: 0.05,
      [PlantType.LogisticsDepot]: 0.03,
      [PlantType.BusDepot]: 0.03,
      [PlantType.HydrogenPlant]: 0.1,
      /** Same rate as run-of-river: comparable average output per plant. */
      [PlantType.TidalPlant]: 0.06,
      /**
       * Below run-of-river (0.06): no fuel, no moving water, just pumps.
       * Measured against comparable mean output (24.0 vs 25.5 EU/tick),
       * that is ~11 % less upkeep per energy unit — the one place where
       * geothermal is cheaper than the other site-bound plants.
       */
      [PlantType.GeothermalPlant]: 0.05,
      /**
       * Run-of-river's rate: per unit of demand the probe measured it
       * avoiding (34.6 EU/tick and plant over a year), 0.06 is 0.0017
       * money per EU against run-of-river's 0.0024 per EU generated —
       * the same order, and the gap closes on a sparser town.
       */
      [PlantType.HeatPlant]: 0.06,
      /** Half the plant's: a tank with no pump of its own. */
      [PlantType.HeatStore]: 0.03,
    } as Record<PlantType, number>,
    /** Additional fuel cost per energy unit generated by biogas. */
    biogasFuelCostPerEnergyUnit: 0.15,
  },

  tax: {
    defaultRate: 0.1,
    maxRate: 0.3,
    /** Income per tick = rate * (population * perResident + jobs * perJob). */
    incomePerResident: 0.09,
    incomePerJob: 0.12,
    /**
     * Income per industrial job: factories pay a trade rate, twice the
     * job rate. Per unit of energy a factory draws, its tax at the job
     * rate was the worst in the city — 75 energy units per money of tax
     * against 61 for a dense home, 37 for a shop and 30 for an office —
     * so a band was a loss wherever its night shift met biogas. At 0.24
     * (with the load one notch lower, see consumptionByZoneAndDensity)
     * a factory earns like a shop per unit: 28 units per money. Measured
     * in the second industrial probe (2026-10-05, the 560-building town,
     * 40 density-2 factories, 20 days): the band's year-one balance
     * against the town without it moved from -179_000 to -66_000 on
     * seed 11 and from -558_000 to -364_000 on seed 7, whose park burns
     * biogas every night; with 40 batteries bought for the band (60_000)
     * seed 11 breaks even in year one (-11_000) and keeps the tax
     * afterwards. Whether a band pays is still the park's call.
     */
    incomePerIndustrialJob: 0.24,
    /** Tax rate above which happiness starts to suffer. */
    happinessNeutralRate: 0.12,
  },

  energy: {
    /** Peak PV output per solar farm at full sun, clear sky. */
    solarPeakOutput: 150,
    /** Peak output per wind turbine at windSpeed = 1. */
    windPeakOutput: 120,
    /** Wind output is proportional to windSpeed^3 (capped), like real turbines. */
    windCutInSpeed: 0.1,
    /**
     * Normalised wind speed at which turbines feather their blades and
     * stop. Real turbines cut out in a storm; only a severe storm's gust
     * pushes the city's wind this high (see BALANCE.disasters.storm.gust),
     * so a moderate storm merely runs the fleet flat out.
     */
    windCutOutSpeed: 0.92,
    /** Energy a single battery can store. */
    batteryCapacity: 3_000,
    /** Max charge/discharge rate per battery per tick. */
    batteryPowerLimit: 120,
    /** Round-trip efficiency applied on charge. */
    batteryChargeEfficiency: 0.92,
    /** Dispatchable biogas output per plant per tick. */
    biogasMaxOutput: 90,
    /** Run-of-river output per plant per tick at full river flow. */
    hydroPeakOutput: 40,
    /**
     * Tidal plant output per plant per tick at peak current. Tuned from a
     * 20-day headless probe (scripts/probe-tidal.mjs, deleted after use):
     * tideFactor averages ~0.5 and the site factor on a typical coastal
     * tile averages ~1.23, so two tidal plants land close to two
     * run-of-river plants at typical flow (per-plant average ~21.5 EU vs
     * ~22 EU) — a visible but not dominating share, as steady generation
     * rather than a bigger one. (Was 110, which made two tidal plants
     * out-generate the rest of a small city's plant mix combined.)
     */
    tidalPeakOutput: 35,
    /**
     * Geothermal output per plant per tick at quality factor 1 and a full
     * reservoir — constant, with no weather, daylight or tide factor, so
     * this is both the peak and the mean.
     *
     * Confirmed (not changed) by a 20-day headless probe over five seeds
     * (scripts/probe-geothermal.mjs, deleted after use). Per plant it
     * lands between the two other site-bound plants' measured daily
     * averages — tidal 22.3 EU, geothermal q2 24.0 EU, run-of-river
     * 25.5 EU — and one field drilled to capacity covers 10.0 % of a
     * mid-game city's generation against hydro's 5.7 % plus tidal's
     * 5.0 %: the intended "as big as those two together, never bigger".
     *
     * Ceiling, deliberately left standing: a 64×64 map carries six
     * fields, and a player who drills every one of them reaches 30 % of
     * generation — ~330 EU/tick of firm baseload for ~42_000 money plus
     * power lines to six scattered spots. That is the reward for a
     * map-wide effort, not the default outcome.
     */
    geothermalPeakOutput: 24,
    /** Pumped storage: one plant's capacity, power limit and efficiency. */
    pumpedStorageCapacity: 12_000,
    pumpedStoragePowerLimit: 200,
    pumpedStorageChargeEfficiency: 0.78,
    /**
     * Tiles around an energised line tile or a supply plant that count as
     * connected (Chebyshev distance).
     */
    lineSupplyRadius: 3,
    /**
     * Supply radius before power lines existed; only used to migrate saves
     * without a line layer.
     */
    legacySupplyRadius: 14,
    /**
     * Rooftop PV grows automatically with density: peak output per
     * building by density level 1..3 (only connected buildings feed in).
     */
    rooftopSolarPeakByDensity: [0, 0, 2, 6],
    /** Base consumption per building by zone and density level 1..3. */
    consumptionByZoneAndDensity: {
      [Zone.Residential]: [0, 2, 4.5, 8],
      [Zone.Commercial]: [0, 3, 6.5, 11],
      [Zone.Retail]: [0, 2.5, 5, 9],
      /**
       * Factories draw more than offices of the same density. Measured in
       * the industrial probe (a 64×64 town of 560 density-3 buildings,
       * 40 density-2 factories, a 405-plant park, 20 days, contract on):
       * at [4, 9, 16] the band raised deficit ticks from 210 to 327 on
       * the seed whose weather never diverged (11) and cost 209_000 of
       * the city's 939_000 net money, mostly biogas burnt for the night
       * shift. One notch down, [3.5, 8, 14], trims that to 306 ticks and
       * 178_000 and keeps every level above the offices. No notch makes
       * the band lower deficits: the contract can shed at most 60 % of
       * the load the band adds, and only four hours a day.
       *
       * Second probe (2026-10-05, with the trade tax rate, see
       * tax.incomePerIndustrialJob): one more notch to [3, 6, 11] — the
       * density-3 level still tops the offices' 11 over the day because
       * of the night shift — takes the band's extra biogas from 509_000
       * to 400_000 on seed 7 and 167_000 to 123_000 on seed 11, and its
       * extra deficit ticks from 767 to 448 and 96 to 58. The contract
       * still sheds 164_000-190_000 against 77_000-88_000 without the
       * band: the night pool keeps its bite.
       */
      [Zone.Industrial]: [0, 3, 6, 11],
    } as Record<Zone, number[]>,
    /**
     * Hourly load profile per zone (24 factors, index = hour). Residential
     * peaks in the morning and evening, commercial during office hours,
     * retail from daytime into the evening.
     */
    loadProfileByZone: {
      [Zone.Residential]: [
        0.3, 0.25, 0.22, 0.22, 0.25, 0.35, 0.6, 0.85, 0.7, 0.5, 0.45, 0.45, 0.5, 0.45, 0.45, 0.5,
        0.6, 0.8, 0.95, 1.0, 0.95, 0.8, 0.6, 0.4,
      ],
      [Zone.Commercial]: [
        0.15, 0.12, 0.12, 0.12, 0.15, 0.2, 0.4, 0.7, 0.95, 1.0, 1.0, 1.0, 0.95, 1.0, 1.0, 0.95,
        0.85, 0.6, 0.4, 0.3, 0.25, 0.2, 0.18, 0.15,
      ],
      [Zone.Retail]: [
        0.12, 0.1, 0.1, 0.1, 0.12, 0.15, 0.25, 0.45, 0.7, 0.9, 1.0, 1.0, 0.95, 0.95, 1.0, 1.0, 1.0,
        0.95, 0.9, 0.8, 0.6, 0.35, 0.2, 0.15,
      ],
      /**
       * Two-shift plant: 0.7 through the night, ramps at 5 and 22 h, full
       * load from 6 to 21 h — the only zone with real night-time load.
       */
      [Zone.Industrial]: [
        0.7, 0.7, 0.7, 0.7, 0.7, 0.85, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0.85, 0.7,
      ],
    } as Record<Zone, number[]>,
  },

  market: {
    /**
     * The city has a limited transmission link to the wider (green)
     * grid: imports cover small deficits at a steep price, exports earn
     * a little instead of curtailing. Big shortfalls still black out.
     */
    importCapacity: 60,
    importCostPerEnergyUnit: 0.4,
    exportCapacity: 80,
    exportRevenuePerEnergyUnit: 0.03,
    /**
     * The spot price: both link prices scale with a common factor driven
     * by regional demand (time of day) and regional renewable supply
     * (weather fronts are regional, so the city's weather is the proxy):
     * factor = 1 + spotSwing * (demand - supply), clamped below.
     */
    spotSwing: 1.2,
    spotMin: 0.25,
    spotMax: 2.5,
    /** Regional renewable mix weights (sum to 1). */
    spotSolarShare: 0.55,
    spotWindShare: 0.45,
    trading: {
      /** Storage sells into the link at or above this spot factor... */
      sellThreshold: 1.6,
      /**
       * ...but only the charge above this state of charge, and only
       * while the city is running a surplus that will refill it (see
       * energyStep). Both conditions together make a sale a time-shift
       * of energy the city was going to export or curtail anyway into an
       * expensive hour — worth exportRevenue * spot now against
       * exportRevenue * (the lower) spot when the surplus arrives — and
       * keep the reserve proper untouched. (Was 0.7, which sold nearly a
       * third of the reserve on any price spike, for 0.03 * 1.6 = 0.048
       * per energy unit against the 0.4 * 1.6 = 0.64 the same unit saves
       * by covering a later import: switching market trading on made the
       * player strictly worse off, and it emptied the reserve exactly
       * when a multi-day Dunkelflaute was about to need it.)
       */
      sellFloor: 0.95,
      /** Storage buys from the link at or below this spot factor... */
      buyThreshold: 0.55,
      /** ...and only up to this state of charge. Keeping the bands
       *  disjoint (buyCeiling < sellFloor) makes buy-low-sell-high
       *  wash-trading of the same energy impossible. */
      buyCeiling: 0.6,
    },
  },

  hydrogen: {
    /**
     * A hydrogen plant bundles electrolyser, tank and fuel cell. It
     * absorbs surplus that batteries and pumped storage cannot take —
     * ahead of the export link, because a stored unit later displaces an
     * import instead of earning the link's thin margin — and
     * re-electrifies in a deficit after the other storages ran dry. Once
     * the tanks are full the electrolysers keep running for direct sale
     * whenever that pays better than exporting (see energyStep).
     */
    /** Hydrogen one plant's tank can store (energy units). */
    capacity: 30_000,
    /** Max electrolyser input per plant per tick (charging or selling). */
    electrolyserPowerLimit: 100,
    /** Max fuel-cell output per plant per tick. */
    fuelCellPowerLimit: 80,
    /** Electricity-to-hydrogen efficiency, applied on charge (the fuel
     *  cell then releases stored units 1:1, like the other pools). */
    chargeEfficiency: 0.5,
    /** Revenue per stored-hydrogen unit sold once the tanks are full. */
    saleRevenuePerEnergyUnit: 0.08,
  },

  /**
   * District heating. A heat plant is a large heat pump that injects
   * heat into the road network; a heat store is a hot-water tank the
   * surplus cascade fills through the pumps. Heat never turns back
   * into electricity, so the store is a one-way flexible load.
   *
   * Every value below was confirmed (none changed) by a headless probe
   * (src/sim/heat.probe.test.ts, deleted after use): one four-street
   * town of 72 dense buildings run through a winter, with and without
   * the network. Two well-placed plants serve 86 % of it and cut the
   * electricity for heat to 0.52 of the individual-heating case
   * (0.48 over a full year). That is the expected mix: the unserved
   * share still heats itself 1:1 and the served share pays 1/COP, so
   * (1 − 0.86) + 0.86 / 2.42 = 0.50 at the mean winter COP of 2.42,
   * plus the store's standing loss and the heat the pumps could not
   * make.
   */
  heat: {
    /**
     * Road tiles (4-neighbour hops) the network extends from a plant.
     * Probe sweep at 60 pump power, two plants: 8 hops serves 44 % of
     * the town (ratio 0.75, no fallback at all), 12 serves 86 %
     * (ratio 0.52), 16 serves 100 % but starves the pumps (24 % of the
     * coldest hours fall back). 12 is the one that leaves a well-placed
     * second and third plant worth buying.
     */
    reachHops: 12,
    /** At or above this °C the COP is copWarm. */
    copWarmTemperature: 10,
    /** Heat units per electricity unit in mild weather. */
    copWarm: 3.5,
    /** At or below this °C the COP is copCold. */
    copColdTemperature: -10,
    /**
     * COP in deep cold. The default climate bottoms out near −7 °C, so
     * the probe never saw the floor itself (lowest measured COP 2.06);
     * pulling copColdTemperature up to −7 or −5 to make it bite pushed
     * the winter ratio to 0.57 and 0.62 and the coldest hours' fallback
     * to 20 % and 25 % — out of the intended band, so the curve keeps
     * its honest endpoints and only its middle is in play.
     */
    copCold: 1.8,
    /**
     * Electricity one plant can draw per tick (serving plus charging).
     * Deliberately just under what a full reach needs in the coldest
     * hours: at 60 the probe's two plants left 9 % of the coldest hours'
     * heat to the buildings themselves, which a third plant removes
     * entirely. 45 starved them (33 %), 75 removed every fallback tick
     * and with it the reason to ever build a third plant.
     */
    pumpPowerLimit: 60,
    /**
     * Heat units one store holds. The probe's tank filled to capacity on
     * windy nights, drained to empty on calm ones (~11 cycles per
     * in-game day with one store) and carried more charge through the evening peak
     * (mean 2 466) than through the morning (1 049).
     */
    storeCapacity: 6_000,
    /** Heat units one store releases per tick. */
    storeDischargeLimit: 150,
    /** Share of the stored heat lost per tick (~38 % left after two in-game days). */
    storeLossPerTick: 0.0005,
  },

  forest: {
    /** Growth stages of a wooded tile: 1 sapling .. maxStage mature. */
    maxStage: 3,
    /** Value-noise cell size of the generated woods, in tiles. */
    noiseCellSize: 9,
    /** Noise level above which generated land starts out wooded
     *  (measured: ~20 % of the land, in a handful of coherent patches). */
    noiseThreshold: 0.7,
    /** Cost of planting one sapling tile. */
    plantCost: 60,
    /** Felling cost per growth stage, charged when building on woods. */
    fellingCostPerStage: 45,
    /** Ticks one growth stage takes (also the sweep period). */
    growthIntervalTicks: 2 * TICKS_PER_DAY,
    /** Chebyshev radius in which buildings count as having woods nearby. */
    coverRadius: 5,
    /** Max happiness bonus when every building has woods in reach. */
    coverBonus: 0.06,
    /** Wind turbines: radius scanned for sheltering woods... */
    windPenaltyRadius: 2,
    /** ...output lost per fully grown wooded tile in it... */
    windPenaltyPerTile: 0.0125,
    /** ...capped here (a turbine in closed forest). */
    maxWindPenalty: 0.3,
  },

  water: {
    /** River entry/exit stay this many tiles away from map corners. */
    edgeMargin: 4,
    /** Lateral meander amplitude as a fraction of the map size (two waves). */
    meanderAmplitudes: [0.12, 0.05] as const,
    /** Meander wave counts along the river. */
    meanderPeriods: [1.5, 3.2] as const,
    /** Per-row chance that a two-tile-wide section starts, and its length. */
    wideSectionChance: 0.08,
    wideSectionLength: 4,
    /** Lake diameter range in tiles. */
    lakeDiameter: [5, 9] as const,
    /** The lake sits this far (fraction) along the river. */
    lakePositionRange: [0.2, 0.8] as const,
    /** Evenly spaced lake position candidates within the range. */
    lakeCandidates: 13,
    /** Per-tile radius noise on the lake edge (0 = perfect ellipse). */
    lakeEdgeNoise: 0.3,
    /** Rain falls (and river flow rises) above this cloud cover. */
    rainCloudThreshold: 0.72,
    /** Flow gain per tick at full rain intensity. */
    rainRate: 0.003,
    /** Per-tick fraction of the distance to the dry baseline recovered. */
    dryRate: 0.001,
    dryBaselineFlow: 0.25,
    initialFlow: 0.5,
    /** Run-of-river output fraction at zero flow. */
    minFlowFactor: 0.4,
  },

  sea: {
    /** Depth of the coastal band in tiles, per column (seeded noise). */
    depthRange: [3, 7] as const,
    /** Noise cell size along the coast, in tiles (large = long smooth bays). */
    depthCellSize: 10,
    /** The band never shrinks below this depth. */
    minDepth: 2,
    /** Extra depth at the river mouth, tapering over estuaryTaper columns. */
    estuaryWidening: 3,
    estuaryTaper: 6,
    /** The sea never covers more than this share of the map. */
    maxSeaFraction: 0.12,
    /** Chebyshev radius in which buildings count as having a sea view. */
    coastRadius: 4,
    /** Max happiness bonus when every building has the sea in reach. */
    coastBonus: 0.05,
    /** Two tidal constituents; their beat produces spring and neap tides. */
    tide: {
      /** Lunar semidiurnal (M2) period in in-game hours. */
      lunarPeriodHours: 12.42,
      /** Solar semidiurnal (S2) period in in-game hours. */
      solarPeriodHours: 12.0,
      /** Weight of the solar constituent; sets the neap depth to (1-w)/(1+w). */
      solarWeight: 0.29,
    },
    tidal: {
      /** Output bonus at full narrowness (all 8 neighbours are land). */
      currentBonus: 0.6,
      /** Extra bonus when a river tile lies within estuaryRadius. */
      estuaryBonus: 0.35,
      estuaryRadius: 2,
      /**
       * Cap on the combined site factor. Deliberate headroom, not a
       * currently reachable limit: with currentBonus 0.6 and estuaryBonus
       * 0.35 the strongest legal site tops out at 1.95, just under this
       * cap. Keeps the formula safe if either bonus is tuned up later
       * without silently producing an unbounded site factor.
       */
      maxSiteFactor: 2.0,
    },
    /**
     * Wind turbine output bonus offshore (free wind, no shelter). Just
     * above the best possible land bonus (windBonusPerLevel * maxLevel =
     * 0.045 * 7 = 0.315) — offshore is the strongest single site, but only
     * just.
     */
    offshoreWindBonus: 0.35,
    /**
     * Construction cost multiplier for building on a sea tile. Tuned so
     * an offshore turbine's raw output/cost ratio lands close to a decent
     * (not exceptional) hilltop turbine's — offshore is attractive on its
     * own, but the power line needed to reach it (often a long, expensive
     * water crossing — see the probe's connectability findings) is what
     * decides whether it beats a good hilltop once actually built. (Was
     * 1.5, which made offshore worse than a turbine on flat land even
     * before counting the line.)
     */
    offshoreCostFactor: 1.2,
  },

  geothermal: {
    /** One hotspot field per this many map tiles, before the clamp. */
    tilesPerSpot: 700,
    /** Field count is clamped into this range (target, not a guarantee). */
    minSpots: 3,
    maxSpots: 8,
    /** Chebyshev distance kept between two field seeds. */
    minSpotDistance: 8,
    /** A field grows to this many tiles (inclusive). */
    clusterSizeRange: [2, 5] as const,
    /** Elevation from which a tile counts as highland. */
    highlandLevel: 3,
    /** How much more often a highland tile is drawn as a field seed. */
    highlandWeight: 4,
    /** Output factor by quality; index 0 is unused (0 = no hotspot). */
    qualityFactor: [0, 0.7, 1.0, 1.3],
    /** Wells one field tile sustains before the reservoir starts cooling. */
    sustainablePerTile: 0.5,
    /**
     * Heat recovered per tick toward a full reservoir. 1/recharge = 1250
     * ticks ≈ 1.3 in-game days, so a field that lost its excess wells is
     * measurably back (probe-measured, from the 76.9 % equilibrium:
     * 89 % after one day, 95 % after two, 99 % after four) without the
     * loss having been meaningless.
     *
     * recharge and drain only ever appear as a *pair*: their ratio fixes
     * every equilibrium (see drain), their absolute size fixes how fast
     * the reservoir gets there. Both were scaled up by 1.6 from the
     * hand-derived 0.0005 / 0.00015 — same ratio, same equilibria, but
     * the cooling now lands inside a session: the probe measured only
     * 61 % of the drop within the first one and a half in-game days at
     * the old values, 78 % at these. Scale the pair, never one alone.
     */
    recharge: 0.0008,
    /**
     * Heat drawn per tick per well above capacity. One excess well settles
     * a field at recharge/(recharge+drain) = 76.9 % (probe-measured:
     * 85 % after one day, 82 % after one and a half, settled from day
     * seven on); total field output rises with every extra well but flattens
     * toward recharge/drain ≈ 3.3 well-equivalents, so overdrilling
     * wastes capital, never destroys. Measured on a four-tile,
     * capacity-two field: 2.00 well-equivalents at two wells, 2.31 at
     * three, 2.50 at four — drilling the field out yields a quarter more
     * energy for twice the plants.
     */
    drain: 0.00024,
  },

  terrain: {
    /** Highest elevation level; levels run 0..maxLevel. */
    maxLevel: 7,
    /** Value-noise cell size in tiles (large = broad hills). */
    noiseCellSize: 12,
    /** Octave weights; octave i uses cell size noiseCellSize / 2^i. */
    octaveWeights: [1, 0.35] as const,
    /** Exponent shaping the height distribution toward low levels. */
    noiseExponent: 1.6,
    /** Levels of seed-chosen edge-to-edge tilt (ridges toward one edge). */
    tiltLevels: 3,
    /** Box-blur passes over the raw height field. */
    smoothingPasses: 2,
    /** Height (in levels) above which the terrain steepens into cliffs. */
    cliffLevel: 3,
    /** Vertical stretch of the field above cliffLevel; makes mountain
     *  flanks exceed maxBuildSlope so tooSteep is a real constraint
     *  (1 disables). */
    cliffFactor: 5,
    /** Required fraction of land tiles with slope <= maxBuildSlope. */
    minBuildableFraction: 0.7,
    /** Extra blur passes tried before the flatten fallback kicks in. */
    maxSmoothingAttempts: 6,
    /** Largest slope (level difference to a neighbour) that stays buildable. */
    maxBuildSlope: 1,
    /** Cost multiplier for building on a sloped (slope >= 1) tile. */
    slopeCostFactor: 1.25,
    /** Wind turbine output bonus per elevation level of its tile. */
    windBonusPerLevel: 0.045,
    /** Run-of-river output bonus per level of drop at the plant tile. */
    hydroDropBonus: 0.2,
    /** Pumped-storage capacity/power bonus per level of head above the lake. */
    headBonusPerLevel: 0.12,
    /** Chebyshev radius scanned for the pumped-storage head (nearby hilltop). */
    headRadius: 2,
  },

  growth: {
    /** How many growth attempts happen per tick (seeded random tiles). */
    attemptsPerTick: 3,
    /** Demand must exceed this for a zone to spawn/densify buildings. */
    growthDemandThreshold: 0.05,
    /** Population/jobs provided per building by zone and density level 1..3. */
    populationByDensity: [0, 5, 12, 26],
    jobsByZoneAndDensity: {
      [Zone.Residential]: [0, 0, 0, 0],
      [Zone.Commercial]: [0, 4, 10, 22],
      [Zone.Retail]: [0, 3, 6, 12],
      /**
       * Floor space per worker is large: fewer jobs per tile than offices.
       * In the industrial probe the 40 density-2 factories (320 jobs) add
       * 51_600 tax over 20 days, 2_580 a day — the 200 money of zoning is
       * back within the first in-game hours. Tax is not what decides
       * whether a factory band pays: in the probe park its night shift
       * cost 171_000 in extra biogas and import (seed 11), 3.3 times its
       * tax, so the bill depends on the generation the player builds for
       * it, not on this table. Unchanged by both probes; the second one
       * raised the rate these jobs are taxed at instead
       * (tax.incomePerIndustrialJob), which leaves growth untouched.
       */
      [Zone.Industrial]: [0, 3, 8, 18],
    } as Record<Zone, number[]>,
    /** Jobs the city can sustain per resident (service jobs etc. abstracted). */
    jobsPerResident: 0.65,
    /**
     * Residents a brand-new city attracts before any jobs exist, so growth
     * can bootstrap.
     */
    pioneerPopulation: 30,
    /**
     * Growth targets are scaled up by this factor so residential and
     * commercial demand can never BOTH fall under growthDemandThreshold at
     * the same time (which froze cities at ~300 residents). Must exceed
     * 1 / (1 - growthDemandThreshold).
     */
    demandHeadroom: 1.08,
    /** Retail floor space supported per resident + per job. */
    retailPerResident: 0.1,
    retailPerJob: 0.08,
    /** Industrial jobs the city wants per retail job (factories follow the shops they stock). */
    industrialPerRetailJob: 1.0,
    /** Ticks a building must be fully supplied before it can densify. */
    densifyMinAge: TICKS_PER_DAY / 4,
    /** Chance (0..1) that an eligible growth attempt succeeds. */
    growthChance: 0.6,
    /**
     * Abandonment: after this many ticks without full supply a building
     * starts to decay (one density level at a time, eventually emptying).
     * Only active once the energy system is in play (a plant exists).
     */
    abandonAfterTicks: TICKS_PER_DAY,
    /** Per-tick chance that an eligible troubled building decays. */
    abandonChancePerTick: 0.01,
    /**
     * Visual age stages (render only, no gameplay effect): ticks of
     * buildingAge at which a building turns lived-in, then weathered.
     * One season, then one year.
     */
    ageStageTicks: [
      DAYS_PER_SEASON * TICKS_PER_DAY,
      SEASON_ORDER.length * DAYS_PER_SEASON * TICKS_PER_DAY,
    ] as [number, number],
  },

  /**
   * Smart-meter rollout: paced installation and the flexible load it
   * unlocks.
   *
   * Confirmed (not changed) by a headless probe
   * (src/sim/_smartMetersProbe.test.ts, deleted after use): a
   * 144-building, 960-resident town on 16 plants (7 wind, 6 PV, 2
   * batteries, 1 biogas) on two weather seeds, plus a 298-building,
   * 1_766-resident city on 35 plants, each run a full in-game year
   * (20 days, all four seasons) per configuration against the same city
   * with the rollout paused. No value moved; the figures behind each one
   * are below.
   */
  smartMeters: {
    /**
     * Money per installed meter (billed as the crews install). At
     * installsPerDay that is 900 money a day while the crews work —
     * 4.2-4.5 % of either probe city's daily tax income — and 60 money
     * per building in total: 8_640 for the small town (about five
     * batteries' worth of capital), 18_000 for the 298-building city.
     * A year at full coverage then came out 20_000-34_000 money ahead of
     * the paused town (import 10-13 % lower), so the programme repays
     * its capital inside a year of full coverage while costing more than
     * it earns in the year it is being built.
     */
    costPerMeter: 60,
    /**
     * Meters the crews install per in-game day while the rollout is
     * active. 15 takes the 298-building probe city — a mid-size city on
     * the default 64x64 map — from nothing to 98 % coverage over a
     * 20-day year, the intended "roughly one in-game year"; the small
     * 144-building town is done in ten days. 8/day left that same city
     * at 51 % after a year, two in-game years for a mechanic the player
     * pays for up front.
     */
    installsPerDay: 15,
    /**
     * Share of a metered building's base load that can wait for surplus.
     * With heatingFlexShare this puts the flexible pool at 11-13 % of
     * the town's load in summer (household load only) and 21-23 % in
     * winter, which moves the served load 10-25 % away from the
     * unshifted line hour by hour. 0.2/0.35 cut import by a further
     * 8 percentage points but made a quarter of all city load flexible
     * and pushed the worst one-tick recovery spike to 1.9-2.3x the
     * unshifted peak.
     */
    householdFlexShare: 0.15,
    /** Share of a metered building's on-site electric heating that can wait (thermal inertia). */
    heatingFlexShare: 0.3,
    /**
     * Hours of flexible demand the backlog may hold before comfort wins.
     * 4 hours recovers 2.1-2.2 % of a full-coverage year's consumption
     * (up to 6.4 % on a single day) and leaves the batteries their job
     * (mean state of charge 0.42 / 0.54 against the paused town's
     * 0.46 / 0.50, and 0.553 against 0.553 on the larger city).
     * 2 hours lets 87 % of all deferred energy overflow
     * under the comfort rule, so the mechanic barely does anything
     * (1.2 %); 6-8 hours grows the backlog to 57_000-77_000 energy units
     * — ten times the town's battery fleet — and drops the mean state of
     * charge to 0.38-0.40, i.e. the pool takes over storage's job.
     */
    backlogHours: 4,
    /**
     * Cap on the backlog drained per tick — recovered plus overflow —
     * as a share of the unshifted load, so a shrinking pool empties
     * over several ticks instead of one. The comfort bound scales with
     * the *current* flexible pool, so anything that shrinks that pool
     * at once (buying insulation halves the heating load, a heat plant
     * coming online, storm damage, a mass bulldoze) would otherwise
     * leave the whole backlog above the new bound and serve it in a
     * single tick — a city-wide deficit out of nowhere. 0.35 is above
     * the pool's own share of the load (at most householdFlexShare /
     * heatingFlexShare of it, so under 0.3), which is what guarantees
     * the backlog still shrinks every tick while it sits above the
     * bound instead of stalling at a level it can never drain.
     */
    maxDrainShare: 0.35,
    /** Coverage the flexibleCity goal requires. */
    goalCoverage: 0.8,
  },

  /**
   * Demand response: a contract with the commercial and retail zones
   * under which a share of their base load is shed in a deficit. Called
   * automatically inside the cascade (after biogas, before import)
   * when a call is cheaper than importing at the tick's spot price, or
   * when the shortfall exceeds the import link.
   *
   * Frozen by a 20-day headless probe over two weather seeds
   * (src/sim/_demandResponseProbe.test.ts, deleted after use). The probe
   * city: 288 density-3 buildings in six banded rows, 96 of them
   * commercial and retail, smart meters on, against a 158-plant park (36
   * wind, 36 solar, 64 batteries, 16 biogas, 6 hydrogen) — generation
   * 3_723 EU/tick mean against 2_106 EU of load, so a well-supplied city
   * that still runs dry on a Dunkelflaute: 13-14 of its 20 days need no
   * call at all and the deficits all sit in the dark, calm hours. Every
   * figure below is that city measured against itself with the contract
   * off. (A thinner 122-plant park was measured too, as a stretched
   * city; its numbers are in the spec, but the trajectories part company
   * once a day blacks out hard enough to abandon buildings, because the
   * abandonment roll only draws from the Rng for a chronically troubled
   * building, so the two runs' weather streams desynchronise. The
   * well-supplied city never diverges and is what the values are tuned
   * on.)
   */
  demandResponse: {
    /**
     * Share of the commercial and retail base load the contract may shed.
     * At 0.4 the pool is 212 EU/tick on the probe city — a tenth of its
     * load, and 37 % of the 568 EU mean depth of the deficits it is
     * called into, which is why the contract thins blackouts rather than
     * ending them: 8-10 % fewer deficit ticks over a year (790 -> 711 and
     * 1_505 -> 1_382 on the two seeds), 10-15 % less unserved energy and
     * 8.7-10.2 % less import money. 0.6 buys 14-17 % fewer deficit ticks for
     * 27-29 % more contract money and sheds 60 % of a shop district's base
     * load, which the design prices at nothing (the daily allowance is
     * the only comfort rule); 0.2 halves the effect to 4-6 % fewer
     * deficit ticks, at which point the retainer buys almost nothing.
     * The deep shortfalls stay deep at every share: no plausible pool
     * reaches the spec's hoped-for halving of blackout ticks, because a
     * dark, calm night takes the whole city off its generation, not a
     * tenth of it.
     *
     * The pool itself is shedShare of the businesses' pre-flex base
     * load (businessDemand, read before smart meters shift anything).
     * Under full smart-meter coverage the flexible pool defers part of
     * that same line, so against what the businesses actually draw
     * after the shift the contract can shed up to ≈47 % rather than
     * 40 % — a modelling inexactness, not a bug: the adjusted line
     * stays >= 0.85 x raw while the shed stays <= 0.4 x raw, so nothing
     * goes negative.
     */
    shedShare: 0.4,
    /**
     * Share of the industrial base load the contract may shed. Process
     * load is more flexible than office lighting and IT, and it is the
     * only load of any size on a dark, calm night — the gap the
     * commercial pool could not fill. In the industrial probe the
     * contract with 40 factories in it sheds 192_000 over 20 days
     * against 88_000 for the businesses alone (seed 11) and saves 146
     * deficit ticks instead of 101 (452 -> 306, -32 %; 55 % less
     * unserved energy). On seed 7, over the 16 days before the two
     * runs' weather diverges, it halves the deficit ticks (250 -> 127)
     * where the business pool alone takes 27 % off (120 -> 88). 0.7,
     * measured with the old [4, 9, 16] load, saved another 18 ticks
     * (327 -> 309) for 2_500 more contract money — not worth giving
     * up more of a factory's day.
     */
    industrialShedShare: 0.6,
    /**
     * Retainer per contracted business building and in-game day, paid
     * while the contract runs. 96 businesses at 6 is 576 money a day —
     * 2.4 % of the probe city's daily net income, and 11_520 over a year
     * against a measured import saving of 3_600-5_700 (avoided
     * abandonment was not measured). That is the intended shape: the
     * contract leaves a well-supplied city 4.8-8.6 % behind on the year's
     * net income, so signing it is a decision about reliability, not a
     * free upgrade. The spec's 20 put the retainer at 38_400 a year and
     * left this city 12.0 % behind (and the stretched one up to 21.5 %)
     * — more than the whole mechanic is worth, and the retainer alone
     * was 63 % of the bill.
     */
    retainerPerBuildingPerDay: 6,
    /**
     * Paid per energy unit shed. Below market.importCostPerEnergyUnit, so
     * a call beats importing whenever spot >= activationPrice / importCost
     * (0.5 at these values) — normal and scarce prices, not abundance
     * (market.spotMin clamps the spot at 0.25, though the weather model
     * never actually gets there: the cheapest the link gets is a sunny,
     * windy 11 am, at a factor of ≈0.355-0.3625 depending on the season
     * (import price ≈0.14-0.145) — still well under the 0.2 premium and
     * never spotMin; see the abundance-price test in energy.test.ts).
     *
     * In practice this is a cost knob, not a dispatch knob: the import
     * link carries only market.importCapacity = 60 EU/tick, so nearly
     * every deficit the probe city sees is deeper than the link and the
     * security rule calls the pool whatever the price. The premium
     * therefore decides how much of the call is insurance the city pays
     * for rather than import it avoids — 15_300 of the year's 26_800
     * contract bill on the quiet seed. The spec's 0.3 (threshold 0.75)
     * cost 28 % more for the same shedding — 34_465 instead of 26_816 on
     * that seed; 0.15 would drop the threshold to 0.375 — below every
     * import price the weather model can produce bar the single cheapest
     * hour (0.145), so the contract would be calling businesses even
     * when the regional grid is all but giving energy away.
     */
    activationPricePerEnergyUnit: 0.2,
    /**
     * Hours of full-pool shedding the contract allows per in-game day.
     * 4 rations the mechanic exactly where it is meant to: the probe
     * city spends 9.5-18.5 call hours over a whole 20-day year, uses
     * none at all on 13-14 of the 20 days, and runs the allowance flat
     * out on the two worst winter days. 6 h a day is affordable
     * (454_898 / 292_516 net money against 458_952 / 294_798) and on one
     * seed nearly doubles the blackout aversion (711 -> 648 deficit
     * ticks), but on the other it changes nothing at all (1_382 either
     * way) — so it buys a seed-dependent extra at the price of letting a
     * shop district sit shed for a quarter of the day, and the daily
     * allowance is the only comfort rule the design has. Kept at 4.
     */
    maxCallHoursPerDay: 4,
    /**
     * Cumulative shed energy the loadManager goal requires. A contracted
     * probe city sheds 76_000-110_000 energy units over a 20-day year
     * (77_000-197_000 on the stretched park), so 20_000 is about a
     * quarter of the quietest year: reachable inside one in-game year of
     * holding the contract through a winter, but not on a single windless
     * evening. The spec's 2_000 was one Dunkelflaute day's shedding —
     * the goal would have unlocked with the toggle.
     */
    goalShedEnergy: 20_000,
  },

  happiness: {
    /** Smoothing factor per tick toward the target happiness. */
    smoothing: 0.02,
    base: 0.75,
    taxPenaltyWeight: 2.0,
    undersupplyPenaltyWeight: 0.6,
    /**
     * Max happiness bonus when every building has a park nearby; the
     * actual bonus scales with the share of buildings within parkRadius
     * (Chebyshev) of any park.
     */
    parksAndLightsBonus: 0.08,
    parkRadius: 6,
    /**
     * Homes within this Chebyshev radius of a factory count as disturbed.
     * In the industrial probe a home band whose two sides stood 3 and 5
     * tiles from the factories counted only its near side (coverage
     * 0.10); moved one tile closer, 2 and 4 tiles, it counted both
     * (0.20). Kept at 4: a street of homes right across from a factory
     * is disturbed, the next block is not.
     */
    industryRadius: 4,
    /**
     * Max happiness penalty when every home has a factory nearby; scales
     * with the share of residential buildings within industryRadius.
     * Above the park bonus, so a factory among the homes costs more than
     * a park next door buys back. In the industrial probe a fifth of the
     * homes sits in reach of the factory band: at 0.1 mean happiness
     * fell 0.019 and 0.014 below the town without industry (seeds 7, 11),
     * the second just short of the 0.015-0.03 aimed for; at 0.12 it falls
     * 0.024 and 0.018 — felt, but a city stays content, so placement
     * is a decision rather than a wall.
     */
    industryPenaltyWeight: 0.12,
    /**
     * Commute penalty: when the average commute takes this factor
     * longer than free flow, happiness starts to suffer (scaled by
     * weight, capped).
     */
    commuteCongestionThreshold: 1.25,
    commutePenaltyWeight: 0.25,
    commuteMaxPenalty: 0.15,
    /** Below this happiness, growth stops entirely. */
    growthMinimum: 0.35,
  },

  vehicles: {
    /** One visible vehicle per this many (population + jobs). */
    citizensPerVehicle: 18,
    maxVehicles: 220,
    /** Tiles per second at 1x speed. */
    speedTilesPerSecond: 1.6,
    /** Energy drawn per tick by one actively charging vehicle. */
    chargingEnergyPerVehicle: 1.5,
    /** State-of-charge gained per tick while charging (0..1 scale). */
    chargeRatePerTick: 0.0012,
    /** State of charge consumed per road tile driven. */
    batteryDrainPerTile: 0.02,
    /** Below this SoC, smart charging charges regardless of surplus. */
    smartChargeFloor: 0.35,
    /** A hub serves workplaces within this Chebyshev radius. */
    hubRadius: 5,
    /** Vehicles per road tile AND direction (one lane each way) before followers must wait. */
    maxPerRoadTile: 2,
    /**
     * Ticks a blocked vehicle waits before it squeezes past anyway. Breaks
     * gridlocks (rings of full tiles) that would otherwise never clear.
     */
    maxWaitTicks: 40,
    /** Vehicles per lane on an avenue tile. */
    avenueMaxPerTile: 4,
    /** Avenue tiles are driven this much faster than streets. */
    avenueSpeedFactor: 1.5,
    /** Route cost multiplier applied per tile at full traffic load. */
    routeLoadPenalty: 2,
    /** Traffic load smoothing per tick (EMA weight of the current tick). */
    trafficLoadSmoothing: 0.05,
    /**
     * Commuting: vehicles drive home -> workplace in the morning and
     * back in the evening (hours of the in-game day). Departures are
     * spread over the window so traffic ramps up naturally.
     */
    commute: {
      morningStartHour: 6.5,
      eveningStartHour: 17.25,
      departureWindowHours: 1.5,
    },
    /** Vehicles one charging hub can serve simultaneously. */
    vehiclesPerHub: 25,
  },

  weather: {
    /** How fast cloud cover drifts (per tick). */
    cloudDrift: 0.003,
    windDrift: 0.002,
    /**
     * Multi-day pressure systems ("fronts") slowly shift the mean the
     * short-term weather noise reverts to. Two incommensurate periods per
     * quantity so calm sunny spells and dark doldrums (Dunkelflaute)
     * emerge naturally when the waves align. Periods in in-game days.
     */
    fronts: {
      cloud: { periodsDays: [2.6, 4.3] as const, amplitudes: [0.28, 0.12] as const, base: 0.45 },
      wind: { periodsDays: [3.4, 5.7] as const, amplitudes: [0.3, 0.1] as const, base: 0.5 },
    },
  },

  seasons: {
    /** A year has seasonsPerYear × daysPerSeason in-game days. */
    daysPerSeason: DAYS_PER_SEASON,
    /** Seasonal mean temperature swings between these (°C). */
    winterLow: -4,
    summerHigh: 24,
    /** Year phase of the warmest seasonal mean (late summer lag). */
    warmestPhase: 0.35,
    /** Diurnal cycle: ± this many °C, coldest at coldestTime (fraction of day). */
    diurnalAmplitude: 3,
    coldestTime: 0.2,
    /** Overcast daytime is cooler by up to this many °C. */
    cloudDamping: 2,
    /** Day length in hours at the shortest and longest day. */
    dayLengthHours: { shortest: 9.5, longest: 14.5 },
    /** Year phase of the longest day. */
    longestDayPhase: 0.3,
    /** Sun elevation factor at the shortest day (1 at the longest). */
    winterSolarStrength: 0.45,
    /** Front base offsets: +amplitude in winter, −amplitude in summer. */
    cloudBiasAmplitude: 0.12,
    windBiasAmplitude: 0.12,
    /** Precipitation below this temperature falls as snow (°C). */
    snowTemperature: 0,
    /** Snowpack melts above this temperature, meltRate per tick per °C. */
    meltTemperature: 2,
    meltRate: 0.0001,
    heating: {
      /** No heating above this temperature; full heating heatingRange below it. */
      comfortTemperature: 16,
      heatingRange: 20,
      /** Heating load at full cold as a multiple of the zone's base consumption. */
      weightByZone: {
        [Zone.Residential]: 0.8,
        [Zone.Commercial]: 0.45,
        [Zone.Retail]: 0.45,
        [Zone.Industrial]: 0.3,
      } as Record<Zone, number>,
      /** Heating multiplier once building insulation is bought. */
      insulationFactor: 0.5,
    },
    cooling: {
      /** No cooling at or below this temperature; full cooling coolingRange above it. */
      comfortTemperature: 20,
      coolingRange: 8,
      /** Cooling load at full heat as a multiple of the zone's base consumption. */
      weightByZone: {
        [Zone.Residential]: 0.26,
        [Zone.Commercial]: 0.45,
        [Zone.Retail]: 0.45,
        [Zone.Industrial]: 0.3,
      } as Record<Zone, number>,
      /** Cooling multiplier once building insulation is bought. */
      insulationFactor: 0.5,
    },
  },

  services: {
    fire: {
      /** Chebyshev radius (tiles) a fire station covers. */
      radius: 7,
    },
    police: {
      /** Chebyshev radius (tiles) a police station covers. */
      radius: 8,
    },
    /** Energy drawn per tick by one connected station. */
    stationConsumption: 2,
    /** Police consequences (happiness, tax) apply from this population on. */
    minPopulation: 100,
    /** Tax multiplier for buildings without police coverage. */
    uncoveredTaxFactor: 0.7,
    /** Max happiness penalty when no building has police coverage. */
    policePenaltyWeight: 0.1,
    /** Coverage share (per service) the safe-city goal requires. */
    goalCoverage: 0.9,
  },

  /**
   * Tuned from a headless probe (scripts/disaster-probe.mjs, deleted after
   * use): eight seeds x three intensity levels x 20 in-game days, on one
   * scripted city per seed grown for a warm-up year with the disasters off
   * — ~700 residents, ~95 buildings, ~130 power-line tiles, 8 turbines /
   * 8 solar farms / 4 batteries / biogas / hydrogen, one fire station
   * covering 30-64 % of the buildings, and a riverside quarter of ~30 lots
   * in the floodplain.
   *
   * What the numbers below buy at intensity 1 (per 20 in-game days, mean
   * over the eight seeds):
   *
   *   storms  4.3 (one every 4.7 days), 58 damaged tiles and 2_390 money
   *           each, 17 of 34 ridden out with no deficit tick at all and
   *           the stormProof goal reached by all eight cities
   *   fires   4.1 (one every 4.9 days), 4 of 5 fires that started on
   *           covered ground stayed a single tile, against uncovered ones
   *           spreading over 18 tiles
   *   floods  1.3, seven of ten of them in the first three days of spring
   *           (the melt peak), ~14 damaged tiles and 1_810 money each
   *   repairs 13_110 against 207_750 of tax income = 6.3 %, with the
   *           treasury still gaining 3_410/day
   *
   * Per 20 days at intensity 0.5 / 1 / 1.6 the counts came out as storms
   * 2.5 / 4.3 / 4.6, fires 2.9 / 4.1 / 5.9, floods 0.6 / 1.3 / 1.4, and
   * the repair bill as 5.3 % / 6.3 % / 7.4 % of tax income: rising at
   * every step, but the storm's 1 → 1.6 step is nearly flat, because the
   * kinds are rolled in order with a shared `cooldownTicks` and once
   * events are frequent the cooldown, not the risk, is the limit. Read
   * these counts as Poisson samples: eight seeds is 34 storms, so ±6 is
   * noise, and the per-season split is noisier still (see
   * `storm.winterFactor` for the noise-free answer on seasonality).
   */
  disasters: {
    /**
     * Ticks after one event is scheduled before another may be rolled
     * (half an in-game day), so a storm, a fire and a flood never pile
     * onto the same evening by accident.
     *
     * It also holds the realised event counts well under what the risks
     * alone predict — measured ~0.75x for storms and ~0.4x for floods
     * (which are rolled last, so a storm or fire usually claims the
     * cooldown first). Raise any baseRisk with that discount in mind.
     */
    cooldownTicks: 480,
    repair: {
      /** Damage points a tile heals per tick (1 point = 1 tick of work). */
      pointsPerTick: 1,
      /**
       * Money per healed damage point. Was 0.5. The storm's strike count
       * came down when `hitsPerTick` became a real rate (80 tiles a storm
       * to 58) and the flood stopped writing off everything it touched, so
       * the whole bill fell to 4.5 % of tax income; 0.7 puts it back at
       * 6.3 % over 20 days with one storm costing ~2_390 and one flood
       * ~1_810 — a day or two of a healthy city's net income, paid in one
       * go. Measured at 5.3 % / 6.3 % / 7.4 % across the three intensity
       * levels, with the treasury still gaining ~3_400/day.
       */
      costPerPoint: 0.7,
    },
    /** Happiness: standing penalty weight on the damaged-building share. */
    damagedPenaltyWeight: 0.35,
    /** Happiness: acute penalty while any event is active. */
    activeEventPenalty: 0.05,
    storm: {
      /**
       * Risk per tick at the highest wind mean, before the intensity
       * scale. Was 0.0008, which gave one storm every 10 in-game days —
       * too rare to be the headline event. The probe integrates
       * `sum(stormRisk / baseRisk)` to ~2_950 per 20 days, so 0.002 lands
       * a storm every 4.7 days measured (every 8.0 at intensity 0.5,
       * every 4.3 at 1.6 — see the block comment on why that last step is
       * nearly flat).
       */
      baseRisk: 0.002,
      /** Front wind mean from which a storm becomes possible at all. */
      windThreshold: 0.6,
      /**
       * Risk factor in winter. Confirmed by the probe's storm almanac,
       * which integrates the risk over a year with no city and no rng and
       * so answers "more often in winter" free of event-count noise:
       * winter carries 42.4 % of the year's storm risk against autumn's
       * 29.5 %, spring's 18.7 % and summer's 9.4 %. That is 1.7x the
       * uniform share — this factor plus the seasonal wind bias.
       */
      winterFactor: 1.5,
      /**
       * Warning lead and duration in ticks (4 h / 3 h), both as the spec
       * asks. An earlier pass shortened the storm to 2 h to cut how much
       * it wrecked, because `hitsPerTick` was inert: it rounded up to one
       * strike per tick, `targets` never offers the same tile twice, and
       * so a storm damaged exactly `durationTicks` tiles whatever its
       * severity or the city's size. The rate is a real rate now (see
       * `hitsPerTick`), so the duration is free to be the storm's length
       * again rather than its blast radius.
       */
      warnTicks: 160,
      durationTicks: 120,
      severityRange: [0.4, 1] as const,
      /**
       * Added to the wind speed while the storm blows (× severity). Was
       * 0.6: since a storm only rolls above `windThreshold`, that pushed
       * even the mildest storm past `energy.windCutOutSpeed` and the whole
       * fleet feathered every time. At 0.35 severity decides — measured
       * 27 % of storm ticks in deficit and 17 of 34 storms ridden out with
       * none at all, so `stormProof` was reached by all eight probe cities
       * at every intensity level. (Half the storms costing a deficit tick
       * is the price of the 3 h duration: a longer cut-out drains more
       * storage than the 2 h version this was first measured at, where 23
       * of 35 came through clean.)
       */
      gust: 0.35,
      /**
       * Tiles struck per tick at severity 1 — a rate, and deliberately
       * below one: `strikesThisTick` differences a running total, so 0.7
       * strikes on seven ticks in ten instead of rounding up to every
       * tick. Was 3, with a `max(1, …)` floor that made severity irrelevant
       * to a storm's breadth; at 3 hits over 120 ticks a storm damaged all
       * ~250 damageable tiles of this city at once (measured 206-218) and
       * ground the population from ~690 to ~500 over 20 days.
       *
       * At 0.7 over 120 ticks severity decides the footprint: 33 tiles at
       * the mildest severity, 84 at the worst, measured mean 58 — about a
       * quarter of this city's damageable tiles, repaired in ~90 ticks
       * (2 in-game hours) of parallel work for ~2_390 money.
       */
      hitsPerTick: 0.7,
      /**
       * Draw weights of the target pool. Unchanged, but worth knowing what
       * they mean once a city is wired: line tiles outnumber everything
       * else (~130 against ~95 buildings, 8 turbines and ~14 other plants
       * here), so ~78 % of strikes land on pylons and a storm reads as a
       * grid event. That is why the aftermath is islanded districts rather
       * than rubble.
       */
      weights: { line: 4, turbine: 4, plant: 2, building: 1 },
      /**
       * Damage points per strike, before severity. Unchanged: at the
       * measured mean severity of ~0.7 a storm writes ~4_400 points over
       * its 80 tiles, so the wreckage is cleared in ~90 ticks (2 in-game
       * hours) of parallel repair for ~2_180 money.
       */
      damage: { line: 90, turbine: 120, plant: 60, building: 30 },
    },
    fire: {
      /**
       * Confirmed (not changed): the probe integrates
       * `sum(fireRisk / baseRisk)` to ~2_500 per 20 days, and 0.0022
       * lands 4.1 fires per 20 days measured — one every 4.9 in-game days
       * — against 2.9 at intensity 0.5 and 5.9 at 1.6.
       *
       * Fires are rolled after storms, and one event per tick claims the
       * shared `cooldownTicks`, so raising the storm risk measurably
       * crowds fires out: an earlier pass that tripled `storm.baseRisk`
       * alone left the fire count flat at 3.1 between intensity 0.5 and 1
       * even though the fire risk itself had doubled. Budget the two
       * together rather than one at a time.
       */
      baseRisk: 0.0022,
      /** Fires strike without warning — that is why fire stations pay off. */
      warnTicks: 0,
      /** Hard cap (~2 h): nothing burns forever. */
      durationTicks: 80,
      severityRange: [0.5, 1] as const,
      /** Temperature (°C) at which the city starts drying out, and the span to full dryness. */
      dryTemperature: 8,
      dryTemperatureSpan: 14,
      /** Cloud cover from which nothing is dry any more. */
      dryCloudCeiling: 0.6,
      /**
       * Ignition draw weight per density level, covered and uncovered.
       * Were 1 and 4. The ratio is what matters and it is unchanged — a
       * covered lot is a quarter as likely to catch — but the absolute
       * size does too: `fireCandidates` also puts every mature forest tile
       * in the pool at weight 1, and a 64×64 map carries several hundred
       * of them. At 1/4 the buildings were only ~30 % of the pool, so the
       * measured damage was 0.7 tiles per fire: almost every fire was a
       * woodland fire that cleared trees and cost the city nothing. At
       * 3/12 the city is about half the pool and a fire damages 3.8 tiles.
       */
      coveredIgnitionWeight: 3,
      uncoveredIgnitionWeight: 12,
      /**
       * Candidate pool size at which the exposure factor saturates at 1.
       * Was 400, which the forest alone exceeds on any map — the factor
       * was a constant 1 and did nothing. The probe measures ~2_030 for a
       * mid-game city plus its woods, so 2_000 keeps the risk of this
       * reference city where it was (exposure ~1) while a young, small or
       * sparsely wooded city genuinely burns less often, which is what
       * this factor is for.
       */
      exposureSaturation: 2_000,
      /**
       * Ticks one tile burns; a covered tile loses this many per tick
       * instead of one. `extinguishCovered` was 4 (a 6-tick burn), which
       * held covered fires to a single tile 5 times out of 7; at 6 (a
       * 4-tick burn) the probe measured 5 of 6 at intensity 1 and 10 of 10
       * at 1.6, against uncovered fires spreading over 10-15 tiles.
       */
      burnTicks: 24,
      extinguishCovered: 6,
      /** Per-neighbour ignition chance per tick (× severity). */
      spreadChance: 0.06,
      spreadChanceCovered: 0.01,
      /** Damage points a burning tile takes per tick (× severity). */
      damagePerTick: 4,
    },
    flood: {
      /**
       * Was 0.0018. The flood is the one kind whose count does not follow
       * its risk: the risk lives in two short flow peaks a year, and
       * within a peak the 480-tick cooldown lets at most one or two
       * through, so raising this mostly makes the spring flood *certain*
       * rather than frequent. Measured 1.3 floods per 20 days at 0.0016 —
       * seven of ten of them in the first three days of spring — against
       * 0.6 at intensity 0.5 and 1.4 at 1.6.
       */
      baseRisk: 0.0016,
      /** River flow from which a flood becomes possible. */
      flowThreshold: 0.75,
      /**
       * Risk factor while a snowpack is melting. Was 2, which left only
       * 69 % of the year's flood risk in the melt and sprinkled the rest
       * over the autumn rains. At 4 the melt carries 73 % of it (probe:
       * 937 of a 1_290 risk integral), which is what "roughly once per
       * spring melt" means; the autumn peak survives as the rarer second
       * chance, not as a second season of floods.
       */
      meltFactor: 4,
      /**
       * Warning lead and duration in ticks (6 h / 8 h), both as the spec
       * asks. An earlier pass cut the flood to 4.5 h because `addDamage`
       * floored every call at one point, so anything under water for more
       * than MAX_DAMAGE ticks was written off whatever `damagePerTick`
       * said. `floodSpec.apply` accumulates a sub-point rate itself now,
       * so the duration is the flood's length again.
       */
      warnTicks: 240,
      durationTicks: 320,
      severityRange: [0.4, 1] as const,
      /**
       * Elevation levels the water rises above its bed at severity 1
       * (`max(1, round(maxRise * severity))`, so 1 at the mildest flood and
       * 2 at the worst) — and, because `floodArea` spends one level of head
       * per tile of land it crosses, also how many tiles it reaches over
       * dead-flat ground. The single dial on the floodplain: there is no
       * separate lateral limit, which is what keeps the area monotone in
       * severity (verified over 16 seeds x severity 0.01..1.00 in 0.01
       * steps, no step losing a tile).
       *
       * Measured floodplain at 2: 32 tiles at the mildest severity up to
       * 235 at the worst, i.e. 0.9-6.5 % of a map's land, in a band along
       * the river and the lake.
       */
      maxRise: 2,
      /**
       * Damage points per tick (× severity), plus this much per level of
       * depth. Was 2, which said "a flood is a strike every tick" and, with
       * addDamage's old one-point floor, could not say anything else — each
       * flood saturated every tile it covered at MAX_DAMAGE (measured
       * exactly: 255 x 41 tiles). At 0.8 standing water is a soak: a tile
       * at the edge of the plain ends around 180 points after 8 hours and
       * is repairable, while the deep middle still saturates. Measured
       * ~186 points over ~14 damaged tiles = ~1_810 money a flood.
       */
      damagePerTick: 0.8,
      depthFactor: 0.5,
    },
  },

  deliveries: {
    /** Vans stationed at one depot. */
    vansPerDepot: 3,
    /**
     * Shops one tour visits at most. Tuned down from 5 by the headless
     * balance probe: at 5 stops a single depot still served 30 shops
     * across a whole shopping street, so a second depot was never worth
     * building.
     */
    stopsPerTour: 3,
    /** Route cost from the depot a stop must be within (tiles on empty streets). */
    maxRouteTiles: 60,
    /** Hours of the in-game day in which tours may start. */
    windowStartHour: 7,
    windowEndHour: 19,
    /** Ticks a van spends at the depot between tours. */
    turnaroundTicks: 20,
    /** Ticks a van unloads at a stop. */
    unloadTicks: 8,
    /** Ticks a van loads at a factory before its shop leg. */
    loadTicks: 8,
    /**
     * Paid per tour a depot starts without a powered factory in reach:
     * the goods are imported. In the industrial probe eight depots keep
     * 80 shops fully supplied on 27 tours a day; without factories every
     * tour imports, 6_500 over 20 days (325 a day, 0.7 % of the town's
     * net income), and with the factory band in reach not one does. The
     * fee pays back the 200 money of zoning 40 factory tiles in under a
     * day on its own; a 10-20-day payback would need a fee near 1,
     * which makes imported goods free, so the fee stays a steady nudge
     * and the localGoods goal is the carrot. The factories' energy bill,
     * not the fee, decides whether a band pays (see jobsByZoneAndDensity).
     */
    importFeePerTour: 12,
    /** Vans drive this fraction of the car speed (streets and avenues alike). */
    speedFactor: 0.8,
    /** A van needs at least this state of charge to start a tour. */
    minTripCharge: 0.3,
    /** Energy drawn per tick by one charging van. */
    chargingEnergyPerVan: 3,
    /** State of charge gained per tick while charging (0..1). */
    chargeRatePerTick: 0.0012,
    /** A shop counts as supplied for this long after a delivery. */
    supplyWindowDays: 1.5,
    /** The overlay and inspector call a shop "due" after this long. */
    dueAfterDays: 1,
    /** Share of shops that must be supplied for the well-stocked goal. */
    goalSuppliedShare: 0.95,
    /** Retail buildings the well-stocked goal requires. */
    goalMinShops: 20,
    /** Shops the localGoods goal requires, with at least goalSuppliedShare of them supplied. */
    goalLocalMinShops: 10,
    /** Factories the localGoods goal requires. */
    goalLocalMinFactories: 3,
  },

  transit: {
    /** Buses stationed at one depot. */
    busesPerDepot: 3,
    /** Stops one tour visits at most. */
    stopsPerTour: 5,
    /** Route cost from the depot a stop must be within (tiles on empty streets). */
    maxRouteTiles: 60,
    /** Hours of the in-game day in which tours may start. */
    windowStartHour: 5,
    windowEndHour: 23,
    /** Ticks a bus spends at the depot between tours. */
    turnaroundTicks: 12,
    /** Ticks a bus halts at a stop. */
    dwellTicks: 6,
    /** Buses drive this fraction of the car speed (streets and avenues alike). */
    speedFactor: 0.8,
    /** A bus needs at least this state of charge to start a tour. */
    minTripCharge: 0.3,
    /** Energy drawn per tick by one charging bus. */
    chargingEnergyPerBus: 4,
    /** State of charge gained per tick while charging (0..1). */
    chargeRatePerTick: 0.0012,
    /** A stop counts as served for this long after a bus halted there. */
    serviceWindowDays: 0.4,
    /** The overlay and inspector call a stop "due" after this long. */
    dueAfterDays: 0.28,
    /** Road tiles within this Chebyshev radius of a served stop are covered. */
    stopRadius: 4,
    /** Share of commuters that must ride for the modal-shift goal. */
    goalRiderShare: 0.3,
    /** Population the modal-shift goal requires. */
    goalMinPopulation: 300,
  },

  traffic: {
    /** Congestion factor (commute time over free flow) up to which traffic counts as flowing. */
    flowing: 1.15,
    /** Above this factor the HUD calls it a jam. */
    jammed: 1.5,
    /** Population the free-flow goal requires. */
    goalMinPopulation: 300,
  },
} as const;
