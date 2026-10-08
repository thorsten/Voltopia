import { BALANCE } from '../shared/constants.ts';
import type { SimCommand, SimEvent } from '../shared/messages.ts';
import type { VehicleState } from '../shared/types.ts';
import { VehicleKind, WAGON_ID_OFFSET } from '../shared/types.ts';
import { buildRoads, bulldozeTiles, undoLastAction, type BuildResult } from './roads.ts';
import { buyInsulation } from './economy.ts';
import { setDemandResponse } from './demandResponse.ts';
import { drivingVans } from './deliveries.ts';
import { placePlant } from './energy.ts';
import { discoverGeothermalFields, generateGeothermal } from './geothermal.ts';
import { buildPowerLines } from './powerLines.ts';
import { recomputeGrid } from './powerGrid.ts';
import { buildRail } from './rail.ts';
import { leadingPoint, locomotiveAngle, runningTrains, trailingPoint, wagonsOf } from './trains.ts';
import { setSmartMeterRollout } from './smartMeters.ts';
import { buildBusStops, drivingBuses } from './transit.ts';
import { drivingVehicles } from './vehicles.ts';
import { paintZones } from './zones.ts';
import {
  collectDiffs,
  createSimState,
  deserializeState,
  serializeState,
  TrainKind,
  type SimState,
} from './state.ts';
import { generateTerrain } from './terrain.ts';
import { buildStats, stepTick } from './tick.ts';
import { generateForest, plantForest } from './forest.ts';
import { generateWater } from './water.ts';

/**
 * The engine owns the simulation state and translates commands/ticks into
 * events. It is pure logic — scheduling and postMessage live in worker.ts.
 */
export class SimEngine {
  state: SimState;

  constructor(seed: number, size: number) {
    this.state = createSimState(seed, size);
  }

  /**
   * Apply a command. Returns events to send to the main thread
   * (rejections, save data); tile changes surface via the next tick event.
   */
  applyCommand(command: SimCommand): SimEvent[] {
    const { state } = this;
    switch (command.type) {
      case 'init':
        if (command.save) {
          this.state = deserializeState(command.save);
        } else {
          this.state = createSimState(command.seed, command.size, command.startingMoney);
          // createSimState defaults to 0 (disasters off) so tests never run
          // with them on by accident; a real new city gets normal intensity
          // unless the caller (the new-game dialog, or an agent) chose one.
          this.state.disasterScale = command.disasterScale ?? 1;
          generateTerrain(this.state);
          generateWater(this.state);
          generateGeothermal(this.state);
          discoverGeothermalFields(this.state);
          generateForest(this.state);
        }
        return [];
      case 'setSpeed':
        state.speed = command.speed;
        return [];
      case 'setTaxRate':
        state.taxRate = Math.min(Math.max(command.rate, 0), BALANCE.tax.maxRate);
        state.statsDirty = true;
        return [];
      case 'setSmartMeterRollout':
        setSmartMeterRollout(state, command.active);
        return [];
      case 'setDemandResponse':
        setDemandResponse(state, command.active);
        return [];
      case 'setMarketTrading':
        state.marketTrading = command.enabled;
        state.statsDirty = true;
        return [];
      case 'inspectTile':
        state.inspectedTile = command.tile ?? -1;
        return [];
      case 'requestSave':
        return [{ type: 'saveData', save: serializeState(state) }];
      case 'requestLifetime':
        return [
          {
            type: 'lifetimeData',
            samples: state.lifetime.samples.map((sample) => ({ ...sample })),
          },
        ];
      case 'buildRoad':
        return this.toEvents(buildRoads(state, command.tiles, command.avenue ?? false));
      case 'buildPowerLine':
        return this.toEvents(buildPowerLines(state, command.tiles));
      case 'buildBusStop':
        return this.toEvents(buildBusStops(state, command.tiles));
      case 'buildRail':
        return this.toEvents(buildRail(state, command.tiles));
      case 'bulldoze':
        return this.toEvents(bulldozeTiles(state, command.tiles));
      case 'undo':
        return this.toEvents(undoLastAction(state));
      case 'paintZone':
        return this.toEvents(paintZones(state, command.tiles, command.zone));
      case 'plantForest':
        return this.toEvents(plantForest(state, command.tiles));
      case 'placePlant':
        return this.toEvents(placePlant(state, command.tile, command.plant));
      case 'buyInsulation':
        state.statsDirty = true;
        return this.toEvents(buyInsulation(state));
    }
  }

  private toEvents(result: BuildResult): SimEvent[] {
    return result.rejected ? [{ type: 'rejected', reason: result.rejected }] : [];
  }

  /**
   * Emit pending tile changes without advancing time — used so build
   * actions and stat-only changes (money, tax rate, upgrades) are visible
   * immediately while the game is paused.
   */
  flush(): SimEvent | null {
    // A build while paused changes the grid topology, and a tile's island
    // number is only dirtied by the recompute itself — without this, a
    // line drawn while paused would reach the client's overlay a command
    // late. Version-gated, so it is a no-op when nothing changed.
    recomputeGrid(this.state);
    if (this.state.dirty.size === 0 && !this.state.statsDirty) return null;
    this.state.statsDirty = false;
    return this.snapshot();
  }

  /**
   * Stats snapshot without advancing time, so selecting a tile fills the
   * inspector even while the game is paused.
   */
  snapshot(): SimEvent {
    recomputeGrid(this.state);
    return {
      type: 'tick',
      diffs: collectDiffs(this.state),
      stats: buildStats(this.state),
      vehicles: this.collectVehicles(),
    };
  }

  /** Advance one tick and produce the tick event. */
  tick(): SimEvent {
    stepTick(this.state);
    this.state.statsDirty = false;
    return {
      type: 'tick',
      diffs: collectDiffs(this.state),
      stats: buildStats(this.state),
      vehicles: this.collectVehicles(),
    };
  }

  private collectVehicles(): VehicleState[] {
    // Only vehicles on the road are rendered; parked ones stay hidden.
    const cars = drivingVehicles(this.state).map((v) => ({
      id: v.id,
      x: v.x,
      y: v.y,
      angle: v.angle,
      kind: VehicleKind.Car,
    }));
    const vans = drivingVans(this.state).map((v) => ({
      id: v.id,
      x: v.x,
      y: v.y,
      angle: v.angle,
      kind: VehicleKind.Van,
    }));
    const buses = drivingBuses(this.state).map((v) => ({
      id: v.id,
      x: v.x,
      y: v.y,
      angle: v.angle,
      kind: VehicleKind.Bus,
    }));
    const trains: VehicleState[] = [];
    for (const t of runningTrains(this.state)) {
      const freight = t.kind === TrainKind.Freight;
      // Push-pull: a pushing train's wagons stand ahead of the locomotive,
      // the far wagon leads and the locomotive carries the tail lights.
      const n = wagonsOf(t);
      trains.push({
        id: t.id,
        x: t.x,
        y: t.y,
        angle: locomotiveAngle(this.state, t),
        kind: freight ? VehicleKind.FreightLocomotive : VehicleKind.Locomotive,
        ...(t.pushing ? { tail: true as const } : { lead: true as const }),
      });
      for (let k = 1; k <= n; k++) {
        const gap = k * BALANCE.rail.wagonGap;
        const wagon = t.pushing
          ? leadingPoint(this.state, t, gap)
          : trailingPoint(this.state, t, gap);
        const vehicle: VehicleState = {
          id: t.id + k * WAGON_ID_OFFSET,
          x: wagon.x,
          y: wagon.y,
          angle: wagon.angle,
          kind: freight ? VehicleKind.FreightWagon : VehicleKind.Wagon,
        };
        if (k === n) {
          if (t.pushing) vehicle.lead = true;
          else vehicle.tail = true;
        }
        trains.push(vehicle);
      }
    }
    return [...cars, ...vans, ...buses, ...trains];
  }
}
