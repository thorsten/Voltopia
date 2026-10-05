import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import { dispatchCall } from './demandResponse.ts';
import type { IslandPool } from './islandPools.ts';
import { comfortWindowHours } from './smartMeters.ts';

/** One kind of electric storage on an island, summed over its tiles. */
export interface StoragePool {
  stored: number;
  capacity: number;
  powerLimit: number;
  efficiency: number;
}

/**
 * Everything one island's balance needs: its own generation, demand,
 * storage pools and links. Gathered from the tiles by the caller — this
 * module never sees a `SimState`.
 */
export interface IslandInput {
  timeOfDay: number;
  season: { sunrise: number; sunset: number };
  spotPrice: number;
  marketTrading: boolean;
  demandResponseActive: boolean;
  /** Metered coverage of this island's buildings, 0..1. */
  coverage: number;
  generation: {
    solar: number;
    wind: number;
    rooftop: number;
    hydro: number;
    tidal: number;
    geothermal: number;
  };
  /** Dispatchable biogas output available this tick (plants × maxOutput). */
  biogasCapacity: number;
  demand: {
    buildings: number;
    heating: number;
    cooling: number;
    charging: number;
    /** District-heating pumps: inflexible, and not part of the buildings' line. */
    heatPumps: number;
  };
  /** Pre-flex base load of the contracted businesses (the demand-response pool). */
  businessDemand: number;
  industrialDemand: number;
  contractedBuildings: number;
  battery: StoragePool;
  pumped: StoragePool;
  hydrogen: {
    stored: number;
    capacity: number;
    electrolyserLimit: number;
    fuelCellLimit: number;
    efficiency: number;
  };
  heatStore: { headroom: number; pumpPowerLeft: number; cop: number; nightNeedsHeat: boolean };
  /** Substations on this island: each one adds an import and an export link. */
  substations: number;
}

/**
 * One island's flows for this tick. The flow fields carry the names
 * `state.lastEnergy` uses, so the orchestrator can sum them straight
 * into the city-wide figures. Storage is reported as a signed delta
 * because `balanceIsland` works on copies of the pools: the caller
 * applies the deltas to the island's tiles.
 */
export interface IslandResult {
  solar: number;
  wind: number;
  biogas: number;
  hydro: number;
  tidal: number;
  geothermal: number;
  rooftop: number;
  buildingConsumption: number;
  chargingConsumption: number;
  heatingConsumption: number;
  coolingConsumption: number;
  curtailment: number;
  deficit: number;
  gridImport: number;
  gridExport: number;
  electrolysis: number;
  fuelCell: number;
  hydrogenSold: number;
  heatPumpConsumption: number;
  heatStoreCharge: number;
  spotPrice: number;
  tradeSell: number;
  tradeBuy: number;
  flexDeferred: number;
  flexRecovered: number;
  /** The pool's backlog after this tick. */
  flexBacklog: number;
  flexOverflow: number;
  unshifted: number;
  shed: number;
  shedPool: number;
  contractedBuildings: number;
  /** This island's import link: substations × BALANCE.market.importCapacity. */
  importCapacity: number;
  exportCapacity: number;
  /** Signed energy to apply to the island's storage tiles. */
  batteryDelta: number;
  pumpedDelta: number;
  hydrogenDelta: number;
  consumptionThisTick: number;
}

/** Absorb surplus into a storage pool within its power limit and headroom. */
export function chargePool(
  stored: number,
  capacity: number,
  powerLimit: number,
  efficiency: number,
  surplus: number,
): { stored: number; absorbed: number } {
  const headroom = Math.max(0, capacity - stored);
  const absorbed = Math.max(0, Math.min(surplus, powerLimit, headroom / efficiency));
  return { stored: stored + absorbed * efficiency, absorbed };
}

/** Release stored energy toward a shortfall within the power limit. */
export function dischargePool(
  stored: number,
  powerLimit: number,
  shortfall: number,
): { stored: number; released: number } {
  const released = Math.max(0, Math.min(shortfall, powerLimit, stored));
  return { stored: stored - released, released };
}

/**
 * One tick of the energy balance of a single grid island, in the order
 * the spec lists:
 * 1. renewable generation (solar + wind + rooftop + hydro + tidal + geothermal) covers
 *    consumption (buildings, heating, cooling, charging, network pumps),
 *    with the metered flexible share of household and heating load
 *    waiting for surplus in the island's own backlog,
 * 2. surplus charges batteries, then pumped storage, then the heat store
 *    through the heat pumps (only while the nights are cold), then the
 *    hydrogen tanks — storing beats selling, because a stored unit later
 *    displaces an import priced far above either sale. What the tanks
 *    cannot hold is sold over whichever route pays more at the current
 *    spot price: the export link, or the electrolysers running for
 *    direct sale. Only what neither route can take is curtailed,
 * 3. deficit discharges batteries, then pumped storage, then the
 *    hydrogen fuel cells, then dispatches biogas, then sheds contracted
 *    business load (demand response), then imports over the island's
 *    transmission link; what is left is the island's deficit,
 * 4. with market trading on, the storage pools work the link at
 *    scarcity and abundance prices.
 *
 * Pure: it reads `input`, mutates only `pool` (the island's flexible-load
 * backlog and demand-response budget) and returns the island's flows
 * plus the signed storage deltas for the caller to apply to the tiles.
 * No `SimState`, no tiles.
 */
export function balanceIsland(input: IslandInput, pool: IslandPool): IslandResult {
  const { solar, wind, rooftop, hydro, tidal, geothermal } = input.generation;
  const generation = solar + wind + rooftop + hydro + tidal + geothermal;
  const spotPrice = input.spotPrice;

  // The island's links: no substation, no link. Everything below that
  // used to read the BALANCE figures directly scales with them.
  const importCapacity = input.substations * BALANCE.market.importCapacity;
  const exportCapacity = input.substations * BALANCE.market.exportCapacity;

  let buildingDemand = input.demand.buildings;
  let heatingDemand = input.demand.heating;
  const coolingDemand = input.demand.cooling;
  const chargingDemand = input.demand.charging;
  const pumpPower = input.demand.heatPumps;

  // Smart meters: a share of metered household load and on-site electric
  // heating waits for renewable surplus (see smartMeters.ts). Cooling,
  // charging and the network pumps stay inflexible. With no coverage
  // every term is 0 and the step is unchanged.
  const unshifted = buildingDemand + heatingDemand + coolingDemand + chargingDemand + pumpPower;
  const { householdFlexShare, heatingFlexShare, maxDrainShare } = BALANCE.smartMeters;
  const flexible =
    input.coverage * (householdFlexShare * buildingDemand + heatingFlexShare * heatingDemand);
  const inflexible = unshifted - flexible;
  const renewableSurplus = generation - inflexible;
  let servedNow = 0;
  let recovered = 0;
  let deferred = flexible;
  if (renewableSurplus > 0) {
    servedNow = Math.min(flexible, renewableSurplus);
    recovered = Math.min(pool.flexBacklog, renewableSurplus - servedNow);
    deferred = flexible - servedNow;
  }
  // The backlog may only drain so fast. The comfort bound below scales
  // with the current pool, so anything that shrinks the pool at once —
  // insulation halving the heating load, a heat plant coming online,
  // storm damage, a mass bulldoze — would leave the whole backlog above
  // the new bound and serve it in a single tick, a city-wide deficit out
  // of nowhere. Capped, the backlog may sit above the bound for a while
  // and empties over several ticks instead.
  const drainCap = maxDrainShare * unshifted;
  recovered = Math.min(recovered, drainCap);
  // Comfort bound: past a few hours of deferred demand the pool is served
  // regardless of the weather — at night, hours enough to reach the
  // morning sun (see comfortWindowHours).
  const backlogCapacity =
    flexible * comfortWindowHours(input.timeOfDay, input.season) * (TICKS_PER_DAY / 24);
  const overflow = Math.min(
    Math.max(0, pool.flexBacklog + deferred - recovered - backlogCapacity),
    Math.max(0, drainCap - recovered),
  );
  pool.flexBacklog = Math.max(0, pool.flexBacklog + deferred - recovered - overflow);
  // No load at all (an empty island, or every building disconnected):
  // there is nothing to drain into, and the cap would hold the backlog
  // forever.
  if (unshifted === 0) pool.flexBacklog = 0;
  const totalDemand = inflexible + servedNow + recovered + overflow;
  // Report both lines as what was actually served this tick. The shift is
  // split in proportion to what each line contributed to the pool —
  // charging all of it to the household line would print a negative
  // figure on a cold night, where heating alone is the larger share.
  const householdFlex = householdFlexShare * buildingDemand;
  const householdShare =
    flexible > 0 ? householdFlex / (householdFlex + heatingFlexShare * heatingDemand) : 0;
  const shift = -deferred + recovered + overflow;
  buildingDemand += householdShare * shift;
  heatingDemand += (1 - householdShare) * shift;

  // Local copies of the island's storage: the cascade mutates these and
  // reports the deltas, so the caller stays the only writer of tiles.
  const battery = { ...input.battery };
  const pumped = { ...input.pumped };
  const hydrogen = { ...input.hydrogen };
  const { electrolyserLimit, fuelCellLimit } = input.hydrogen;

  let curtailment = 0;
  let biogas = 0;
  let deficit = 0;
  let gridImport = 0;
  let gridExport = 0;
  let electrolysis = 0;
  let fuelCell = 0;
  let hydrogenSold = 0;
  let batteryPowerUsed = 0;
  let pumpedPowerUsed = 0;
  let heatStoreCharge = 0;
  let shed = 0;
  let shedPool = 0;

  const net = generation - totalDemand;
  if (net >= 0) {
    shedPool = dispatchCall(
      pool,
      input.demandResponseActive,
      input.businessDemand,
      input.industrialDemand,
      0,
      spotPrice,
      importCapacity,
    ).pool;
    const charged = chargePool(
      battery.stored,
      battery.capacity,
      battery.powerLimit,
      battery.efficiency,
      net,
    );
    battery.stored = charged.stored;
    batteryPowerUsed = charged.absorbed;
    const pumpedCharged = chargePool(
      pumped.stored,
      pumped.capacity,
      pumped.powerLimit,
      pumped.efficiency,
      net - charged.absorbed,
    );
    pumped.stored = pumpedCharged.stored;
    pumpedPowerUsed = pumpedCharged.absorbed;
    // The heat store drinks after the electric storages and before the
    // hydrogen tanks: a cheap one-way sink that shifts the heating peak.
    // Same rule as `chargeHeatStore` in heat.ts, which the caller runs
    // for the heat-side bookkeeping.
    const forStore = net - charged.absorbed - pumpedCharged.absorbed;
    const { nightNeedsHeat, pumpPowerLeft, headroom, cop } = input.heatStore;
    // The guards are `chargeHeatStore`'s own, kept so an idle heat side
    // (no pump power, no headroom, and no COP to divide by) stays 0.
    heatStoreCharge =
      nightNeedsHeat && forStore > 0 && pumpPowerLeft > 0 && headroom > 0
        ? Math.max(0, Math.min(forStore, pumpPowerLeft, headroom / cop))
        : 0;
    let remaining = forStore - heatStoreCharge;
    // Filling the tanks comes before either sale: a stored unit is
    // released 1:1 by the fuel cell later and so displaces an import at
    // importCostPerEnergyUnit * spot, worth several times what selling
    // the same surplus now earns.
    const electrolysed = chargePool(
      hydrogen.stored,
      hydrogen.capacity,
      electrolyserLimit,
      hydrogen.efficiency,
      remaining,
    );
    hydrogen.stored = electrolysed.stored;
    electrolysis = electrolysed.absorbed;
    remaining -= electrolysed.absorbed;

    // What the tanks cannot hold is sold over the better-paying route
    // and the other one mops up. The link earns exportRevenue * spot per
    // energy unit; keeping the electrolysers running for direct sale
    // earns chargeEfficiency * saleRevenue, independent of the spot
    // price. Surplus usually falls at a sunny, windy midday — exactly
    // when the spot price is at its lowest — so this is the common case,
    // not an edge case.
    const exportValue = BALANCE.market.exportRevenuePerEnergyUnit * spotPrice;
    const hydrogenSaleValue = hydrogen.efficiency * BALANCE.hydrogen.saleRevenuePerEnergyUnit;
    const sellOverLink = (amount: number): number => {
      const sold = Math.min(amount, exportCapacity - gridExport);
      gridExport += sold;
      return sold;
    };
    const sellAsHydrogen = (amount: number): number => {
      const used = Math.min(amount, electrolyserLimit - electrolysis);
      electrolysis += used;
      hydrogenSold += used * hydrogen.efficiency;
      return used;
    };
    const routes =
      exportValue >= hydrogenSaleValue
        ? [sellOverLink, sellAsHydrogen]
        : [sellAsHydrogen, sellOverLink];
    for (const sell of routes) remaining -= sell(remaining);
    curtailment = remaining;
  } else {
    let shortfall = -net;
    const released = dischargePool(battery.stored, battery.powerLimit, shortfall);
    battery.stored = released.stored;
    shortfall -= released.released;
    batteryPowerUsed = released.released;
    const pumpedReleased = dischargePool(pumped.stored, pumped.powerLimit, shortfall);
    pumped.stored = pumpedReleased.stored;
    shortfall -= pumpedReleased.released;
    pumpedPowerUsed = pumpedReleased.released;
    const fromTanks = dischargePool(hydrogen.stored, fuelCellLimit, shortfall);
    hydrogen.stored = fromTanks.stored;
    fuelCell = fromTanks.released;
    shortfall -= fuelCell;
    biogas = Math.min(shortfall, input.biogasCapacity);
    shortfall -= biogas;
    // The demand-response contract sheds business load when a call is
    // cheaper than importing or the link alone cannot carry the rest.
    const call = dispatchCall(
      pool,
      input.demandResponseActive,
      input.businessDemand,
      input.industrialDemand,
      shortfall,
      spotPrice,
      importCapacity,
    );
    shedPool = call.pool;
    shed = call.shed;
    shortfall -= shed;
    // Expensive imports over the limited transmission link come last.
    gridImport = Math.min(shortfall, importCapacity);
    shortfall -= gridImport;
    deficit = shortfall;
  }

  // Spot-market trading: with the toggle on, the storage pools work the
  // link. At scarcity prices they sell the top slice of a nearly full
  // pool, and only while the island is in surplus, so the slice is
  // refilled from energy that was headed for the export link or for
  // curtailment: the sale time-shifts that energy into an expensive hour
  // instead of eating the reserve a Dunkelflaute will need. At abundance
  // prices they buy up to a modest ceiling. The bands are disjoint
  // (buyCeiling < sellFloor), so the same energy can never be bought low
  // and sold high.
  let tradeSell = 0;
  let tradeBuy = 0;
  if (input.marketTrading) {
    const trading = BALANCE.market.trading;
    if (net >= 0 && spotPrice >= trading.sellThreshold && deficit === 0 && gridImport === 0) {
      let exportRoom = exportCapacity - gridExport;
      const sellFrom = (stored: number, floor: number, power: number): number => {
        const sold = Math.min(exportRoom, power, Math.max(0, stored - floor));
        exportRoom -= sold;
        return sold;
      };
      const fromBattery = sellFrom(
        battery.stored,
        trading.sellFloor * battery.capacity,
        battery.powerLimit - batteryPowerUsed,
      );
      battery.stored -= fromBattery;
      const fromPumped = sellFrom(
        pumped.stored,
        trading.sellFloor * pumped.capacity,
        pumped.powerLimit - pumpedPowerUsed,
      );
      pumped.stored -= fromPumped;
      tradeSell = fromBattery + fromPumped;
      gridExport += tradeSell;
    } else if (spotPrice <= trading.buyThreshold && curtailment === 0 && gridExport === 0) {
      let importRoom = importCapacity - gridImport;
      const buyInto = (stored: number, ceiling: number, power: number, efficiency: number) => {
        const bought = Math.min(power, importRoom, Math.max(0, (ceiling - stored) / efficiency));
        importRoom -= bought;
        return { stored: stored + bought * efficiency, bought };
      };
      const batteryBought = buyInto(
        battery.stored,
        trading.buyCeiling * battery.capacity,
        battery.powerLimit - batteryPowerUsed,
        battery.efficiency,
      );
      battery.stored = batteryBought.stored;
      const pumpedBought = buyInto(
        pumped.stored,
        trading.buyCeiling * pumped.capacity,
        pumped.powerLimit - pumpedPowerUsed,
        pumped.efficiency,
      );
      pumped.stored = pumpedBought.stored;
      tradeBuy = batteryBought.bought + pumpedBought.bought;
      gridImport += tradeBuy;
    }
  }

  // Shed load was never served: it leaves the businesses' line and the
  // tick's consumption, so the dashed unshifted curve shows it as a gap.
  buildingDemand -= shed;
  const consumptionThisTick = totalDemand - shed;

  return {
    solar,
    wind,
    biogas,
    hydro,
    tidal,
    geothermal,
    rooftop,
    buildingConsumption: buildingDemand,
    chargingConsumption: chargingDemand,
    heatingConsumption: heatingDemand,
    coolingConsumption: coolingDemand,
    curtailment,
    deficit,
    gridImport,
    gridExport,
    electrolysis,
    fuelCell,
    hydrogenSold,
    heatPumpConsumption: pumpPower + heatStoreCharge,
    heatStoreCharge,
    spotPrice,
    tradeSell,
    tradeBuy,
    flexDeferred: deferred,
    flexRecovered: recovered,
    flexBacklog: pool.flexBacklog,
    flexOverflow: overflow,
    unshifted,
    shed,
    shedPool,
    contractedBuildings: input.contractedBuildings,
    importCapacity,
    exportCapacity,
    batteryDelta: battery.stored - input.battery.stored,
    pumpedDelta: pumped.stored - input.pumped.stored,
    hydrogenDelta: hydrogen.stored - input.hydrogen.stored,
    consumptionThisTick,
  };
}
