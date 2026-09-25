/**
 * Tile inspector.
 *
 * Opens when a tile is clicked with the select tool. Shows what that tile
 * costs and contributes: money upkeep, tax, energy consumption against its
 * peak (with the current load-profile factor), generation, and — for zoned
 * tiles — demand and the reasons it is not growing.
 */
import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import {
  DeliveryState,
  MAX_DELIVERY_AGE,
  PlantType,
  RoadClass,
  StopState,
  SupplyStatus,
  Terrain,
  TileType,
  Zone,
  type GrowthBlocker,
  type TileInfo,
} from '../shared/types.ts';
import { useI18n, type TranslationKey } from './i18n.tsx';

/** What felling the woods on a tile of this growth stage costs. */
function fellingFee(stage: number): number {
  return stage * BALANCE.forest.fellingCostPerStage;
}

const PLANT_LABEL: Record<PlantType, TranslationKey | null> = {
  [PlantType.None]: null,
  [PlantType.SolarFarm]: 'tool.plant-solar',
  [PlantType.WindTurbine]: 'tool.plant-wind',
  [PlantType.Battery]: 'tool.plant-battery',
  [PlantType.BiogasPlant]: 'tool.plant-biogas',
  [PlantType.ChargingHub]: 'tool.plant-hub',
  [PlantType.Park]: 'tool.plant-park',
  [PlantType.RunOfRiver]: 'tool.plant-hydro',
  [PlantType.PumpedStorage]: 'tool.plant-pumped',
  [PlantType.HydrogenPlant]: 'tool.plant-hydrogen',
  [PlantType.FireStation]: 'tool.plant-fire',
  [PlantType.PoliceStation]: 'tool.plant-police',
  [PlantType.LogisticsDepot]: 'tool.plant-depot',
  [PlantType.BusDepot]: 'tool.plant-busdepot',
  [PlantType.TidalPlant]: 'tool.plant-tidal',
  [PlantType.GeothermalPlant]: 'tool.plant-geothermal',
};

const ZONE_LABEL: Record<Zone, TranslationKey | null> = {
  [Zone.None]: null,
  [Zone.Residential]: 'tool.zone-residential',
  [Zone.Commercial]: 'tool.zone-commercial',
  [Zone.Retail]: 'tool.zone-retail',
};

const BLOCKER_LABEL: Record<GrowthBlocker, TranslationKey> = {
  noRoad: 'inspect.blocker.noRoad',
  lowDemand: 'inspect.blocker.lowDemand',
  notConnected: 'inspect.blocker.notConnected',
  undersupplied: 'inspect.blocker.undersupplied',
  tooYoung: 'inspect.blocker.tooYoung',
  maxDensity: 'inspect.blocker.maxDensity',
  cityUnhappy: 'inspect.blocker.cityUnhappy',
  notLand: 'inspect.blocker.notLand',
  noFireCoverage: 'inspect.blocker.noFireCoverage',
  noDeliveries: 'inspect.blocker.noDeliveries',
};

const DELIVERY_LABEL: Record<DeliveryState, TranslationKey> = {
  [DeliveryState.Supplied]: 'inspect.delivery.supplied',
  [DeliveryState.Due]: 'inspect.delivery.due',
  [DeliveryState.Unsupplied]: 'inspect.delivery.unsupplied',
};

const SUPPLY_LABEL: Record<SupplyStatus, TranslationKey> = {
  [SupplyStatus.NotConnected]: 'inspect.supply.notConnected',
  [SupplyStatus.Undersupplied]: 'inspect.supply.undersupplied',
  [SupplyStatus.Supplied]: 'inspect.supply.supplied',
};

const STOP_LABEL: Record<StopState, TranslationKey> = {
  [StopState.Served]: 'inspect.stop.served',
  [StopState.Due]: 'inspect.stop.due',
  [StopState.Unserved]: 'inspect.stop.unserved',
};

function energy(value: number): string {
  return value.toFixed(value < 10 ? 2 : 1);
}

function money(value: number): string {
  return value >= 100 ? Math.round(value).toLocaleString('en-US') : value.toFixed(2);
}

function Row({
  label,
  value,
  hint,
  tone,
  testId,
}: {
  label: string;
  value: string;
  /** Tooltip explaining the value format, e.g. "now / peak". */
  hint?: string;
  tone?: 'positive' | 'negative' | 'muted';
  testId?: string;
}) {
  return (
    <div className={`inspect-row ${tone ?? ''}`} data-testid={testId} title={hint ?? label}>
      <span className="inspect-row-label">{label}</span>
      <span className="inspect-row-value">{value}</span>
    </div>
  );
}

/** Headline of the panel: what kind of tile this is. */
function tileTitle(info: TileInfo, t: (key: TranslationKey) => string): string {
  if (info.tileType === TileType.Road) {
    return info.terrain === Terrain.River
      ? t('inspect.bridge')
      : info.roadClass === RoadClass.Avenue
        ? t('tool.avenue')
        : t('tool.road');
  }
  if (info.tileType === TileType.Plant) {
    const label = PLANT_LABEL[info.plantType];
    return label ? t(label) : t('inspect.plant');
  }
  if (info.density > 0) {
    const zone = ZONE_LABEL[info.zone];
    return `${zone ? t(zone) : ''} · ${t('inspect.density')} ${info.density}`;
  }
  if (info.zone !== Zone.None) {
    const zone = ZONE_LABEL[info.zone];
    return `${zone ? t(zone) : ''} · ${t('inspect.vacantLot')}`;
  }
  if (info.terrain === Terrain.River) return t('inspect.river');
  if (info.terrain === Terrain.Lake) return t('inspect.lake');
  if (info.terrain === Terrain.Sea) return t('inspect.sea');
  return t('inspect.empty');
}

export function TileInspector({ info, onClose }: { info: TileInfo; onClose: () => void }) {
  const { t } = useI18n();
  const isBuilding = info.tileType === TileType.Empty && info.density > 0;
  const isZoned = info.tileType === TileType.Empty && info.zone !== Zone.None;
  const isStation =
    info.tileType === TileType.Plant &&
    (info.plantType === PlantType.FireStation || info.plantType === PlantType.PoliceStation);
  const upkeepPerDay = (info.upkeepPerTick + info.fuelCostPerTick) * TICKS_PER_DAY;
  const taxPerDay = info.taxPerTick * TICKS_PER_DAY;
  const netPerDay = taxPerDay - upkeepPerDay;

  return (
    <aside className="tile-inspector" data-testid="tile-inspector">
      <header>
        <div>
          <h2>{tileTitle(info, t)}</h2>
          <span className="inspect-coords">
            ({info.x}, {info.y})
          </span>
        </div>
        <button
          type="button"
          data-testid="inspector-close"
          onClick={onClose}
          aria-label={t('modal.close')}
        >
          ✕
        </button>
      </header>

      {(info.terrain === Terrain.Land ||
        (info.terrainBonus > 1 && info.plantType !== PlantType.TidalPlant) ||
        info.forest > 0) && (
        <section>
          <h3>{t('inspector.terrain')}</h3>
          {info.terrain === Terrain.Land && (
            <Row
              label={t('inspector.elevation')}
              value={`${info.elevation}`}
              testId="inspect-elevation"
            />
          )}
          {info.terrainBonus > 1 && info.plantType !== PlantType.TidalPlant && (
            <Row
              label={t('inspector.terrainBonus')}
              value={`+${Math.round((info.terrainBonus - 1) * 100)} %`}
              tone="positive"
              testId="inspect-terrain-bonus"
            />
          )}
          {info.forest > 0 && (
            <Row
              label={t('inspector.forest')}
              value={t(
                info.forest >= BALANCE.forest.maxStage
                  ? 'inspector.forest.mature'
                  : 'inspector.forest.growing',
                { fee: fellingFee(info.forest) },
              )}
              testId="inspect-forest"
            />
          )}
          {info.terrain === Terrain.Land && info.slope > 1 && (
            <p className="inspect-blockers" data-testid="inspect-steep-slope">
              ⚠ {t('inspector.steepSlope')}
            </p>
          )}
          {info.hotspot && (
            <>
              <Row
                label={t('inspect.hotspot')}
                value={`${t('inspect.hotspotQuality')} ${info.hotspot.quality} · ${Math.round(
                  info.hotspot.heat * 100,
                )} %`}
                hint={t('inspect.hotspotHint')}
                testId="inspect-hotspot"
              />
              <Row
                label={t('inspect.hotspotWells')}
                value={`${info.hotspot.wells} / ${info.hotspot.capacity}`}
                tone={info.hotspot.wells > info.hotspot.capacity ? 'negative' : 'muted'}
                testId="inspect-hotspot-wells"
              />
            </>
          )}
        </section>
      )}

      <section>
        <h3>{t('inspect.section.money')}</h3>
        <Row
          label={t('inspect.upkeep')}
          value={`${money(upkeepPerDay)} ⌁/${t('budget.dayUnit')}`}
          tone={upkeepPerDay > 0 ? 'negative' : 'muted'}
          testId="inspect-upkeep"
        />
        {info.fuelCostPerTick > 0 && (
          <Row
            label={t('budget.biogasFuel')}
            value={`${money(info.fuelCostPerTick * TICKS_PER_DAY)} ⌁/${t('budget.dayUnit')}`}
            tone="negative"
          />
        )}
        {isBuilding && (
          <Row
            label={t('inspect.tax')}
            value={`${money(taxPerDay)} ⌁/${t('budget.dayUnit')}`}
            tone="positive"
            testId="inspect-tax"
          />
        )}
        <Row
          label={t('inspect.net')}
          value={`${netPerDay >= 0 ? '+' : '−'}${money(Math.abs(netPerDay))} ⌁/${t('budget.dayUnit')}`}
          tone={netPerDay >= 0 ? 'positive' : 'negative'}
          testId="inspect-net"
        />
      </section>

      <section>
        <h3>{t('inspect.section.energy')}</h3>
        {(isBuilding || isStation) && (
          <Row
            label={t('inspect.consumption')}
            value={`${energy(info.consumption)} / ${energy(info.peakConsumption)} EU`}
            hint={t('inspect.nowPeak')}
            testId="inspect-consumption"
          />
        )}
        {isBuilding && (
          <>
            <div className="inspect-meter" title={t('inspect.loadFactor')}>
              <div
                className="inspect-meter-fill"
                style={{ width: `${Math.min(100, info.loadFactor * 100)}%` }}
              />
            </div>
            <Row
              label={t('inspect.loadFactor')}
              value={`${Math.round(info.loadFactor * 100)}%`}
              tone="muted"
            />
          </>
        )}
        {info.generation > 0 && (
          <Row
            label={t('inspect.generation')}
            value={`${energy(info.generation)} / ${energy(info.peakGeneration)} EU`}
            hint={t('inspect.nowNameplate')}
            tone="positive"
            testId="inspect-generation"
          />
        )}
        {info.plantType === PlantType.TidalPlant && (
          <>
            <Row
              label={t('inspect.tideFactor')}
              value={`${Math.round(
                (info.peakGeneration > 0 ? info.generation / info.peakGeneration : 0) * 100,
              )}%`}
              testId="inspect-tide-factor"
            />
            <Row
              label={t('inspect.siteFactor')}
              value={`+${Math.round((info.terrainBonus - 1) * 100)} %`}
              tone="positive"
              testId="inspect-site-factor"
            />
          </>
        )}
        {info.storageCapacity > 0 && (
          <Row
            label={t('inspect.storedEnergy')}
            value={`${Math.round((info.storedEnergy / info.storageCapacity) * 100)}% (${Math.round(
              info.storedEnergy,
            )} EU)`}
          />
        )}
        {(isBuilding || isZoned) && (
          <Row
            label={t('inspect.supplyStatus')}
            value={t(SUPPLY_LABEL[info.supplied])}
            tone={info.supplied === SupplyStatus.Supplied ? 'positive' : 'negative'}
            testId="inspect-supply"
          />
        )}
        {!isBuilding && (
          <Row
            label={t('inspect.connected')}
            value={info.connected ? t('inspect.yes') : t('inspect.no')}
            tone={info.connected ? 'positive' : 'muted'}
          />
        )}
      </section>

      {info.tileType === TileType.Road && (
        <section data-testid="inspect-traffic">
          <h3>{t('inspect.section.traffic')}</h3>
          <Row
            label={t('inspect.roadClass')}
            value={info.roadClass === RoadClass.Avenue ? t('inspect.avenue') : t('inspect.street')}
          />
          <Row
            label={t('inspect.trafficLoad')}
            value={`${Math.round((info.trafficLoad / 255) * 100)}%`}
            tone={
              info.trafficLoad > 191 ? 'negative' : info.trafficLoad > 95 ? undefined : 'positive'
            }
            testId="inspect-traffic-load"
          />
          <Row label={t('inspect.laneCapacity')} value={String(info.laneCapacity)} tone="muted" />
        </section>
      )}

      {isBuilding && info.zone === Zone.Retail && (
        <section data-testid="inspect-deliveries">
          <h3>{t('inspect.section.deliveries')}</h3>
          <Row
            label={t('inspect.deliveryState')}
            value={t(DELIVERY_LABEL[info.deliveryState])}
            tone={
              info.deliveryState === DeliveryState.Supplied
                ? 'positive'
                : info.deliveryState === DeliveryState.Due
                  ? undefined
                  : 'negative'
            }
            testId="inspect-delivery-state"
          />
          <Row
            label={t('inspect.lastDelivery')}
            value={
              info.deliveryAgeTicks >= MAX_DELIVERY_AGE
                ? t('inspect.lastDelivery.never')
                : t('inspect.lastDelivery.daysAgo', {
                    days: (info.deliveryAgeTicks / TICKS_PER_DAY).toFixed(1),
                  })
            }
            tone="muted"
          />
        </section>
      )}

      {info.depot && (
        <section data-testid="inspect-depot">
          <h3>{t('inspect.section.deliveries')}</h3>
          <Row
            label={t('inspect.depot.vans')}
            value={t('inspect.depot.vansValue', {
              driving: info.depot.vansDriving,
              charging: info.depot.vansCharging,
              total: info.depot.vansTotal,
            })}
          />
          <Row
            label={t('inspect.depot.shopsInReach')}
            value={String(info.depot.shopsInReach)}
            tone={info.depot.shopsInReach > 0 ? 'positive' : 'negative'}
          />
        </section>
      )}

      {info.tileType === TileType.Road && (info.busStop || info.transitCovered) && (
        <section data-testid="inspect-transit">
          <h3>{t('inspect.section.transit')}</h3>
          <Row
            label={t('inspect.busStop')}
            value={info.busStop ? t('inspect.yes') : t('inspect.no')}
          />
          {info.busStop && (
            <>
              <Row
                label={t('inspect.stopState')}
                value={t(STOP_LABEL[info.stopState])}
                tone={
                  info.stopState === StopState.Served
                    ? 'positive'
                    : info.stopState === StopState.Due
                      ? undefined
                      : 'negative'
                }
                testId="inspect-stop-state"
              />
              <Row
                label={t('inspect.lastBus')}
                value={t('inspect.lastBus.hoursAgo', {
                  hours: ((info.stopAgeTicks / TICKS_PER_DAY) * 24).toFixed(1),
                })}
                tone="muted"
              />
            </>
          )}
          <Row
            label={t('inspect.transitCovered')}
            value={info.transitCovered ? t('inspect.yes') : t('inspect.no')}
            tone={info.transitCovered ? 'positive' : undefined}
          />
        </section>
      )}

      {info.busDepot && (
        <section data-testid="inspect-bus-depot">
          <h3>{t('inspect.section.transit')}</h3>
          <Row
            label={t('inspect.buses')}
            value={t('inspect.buses.value', {
              driving: info.busDepot.busesDriving,
              charging: info.busDepot.busesCharging,
              total: info.busDepot.busesTotal,
            })}
          />
          <Row
            label={t('inspect.stopsInReach')}
            value={String(info.busDepot.stopsInReach)}
            tone={info.busDepot.stopsInReach > 0 ? 'positive' : 'negative'}
          />
        </section>
      )}

      {(isBuilding || isStation) && (
        <section data-testid="inspect-services">
          <h3>{t('inspect.section.services')}</h3>
          {isBuilding && (
            <>
              <Row
                label={t('inspect.fire')}
                value={info.fireCovered ? t('inspect.covered') : t('inspect.uncovered')}
                tone={info.fireCovered ? 'positive' : 'negative'}
                testId="inspect-fire"
              />
              <Row
                label={t('inspect.police')}
                value={info.policeCovered ? t('inspect.covered') : t('inspect.uncovered')}
                tone={info.policeCovered ? 'positive' : 'negative'}
                testId="inspect-police"
              />
            </>
          )}
          {isStation && (
            <Row
              label={t('inspect.stationStatus')}
              value={
                info.stationActive ? t('inspect.stationActive') : t('inspect.stationUnpowered')
              }
              tone={info.stationActive ? 'positive' : 'negative'}
              testId="inspect-station"
            />
          )}
        </section>
      )}

      {(isBuilding || isZoned) && (
        <section>
          <h3>{t('inspect.section.growth')}</h3>
          <Row
            label={t('inspect.demand')}
            value={`${info.demand >= 0 ? '+' : ''}${Math.round(info.demand * 100)}%`}
            tone={info.demand > 0 ? 'positive' : 'negative'}
            testId="inspect-demand"
          />
          <div className="inspect-demand-track">
            <div
              className={`inspect-demand-fill ${info.demand >= 0 ? 'positive' : 'negative'}`}
              style={{
                width: `${Math.abs(info.demand) * 50}%`,
                left: info.demand >= 0 ? '50%' : 'auto',
                right: info.demand >= 0 ? 'auto' : '50%',
              }}
            />
          </div>
          {isBuilding && (
            <>
              <Row label={t('inspect.residents')} value={`${info.population}`} tone="muted" />
              <Row label={t('hud.jobs')} value={`${info.jobs}`} tone="muted" />
              <Row
                label={t('inspect.troubled')}
                value={`${info.troubledTicks}`}
                tone={info.troubledTicks > 0 ? 'negative' : 'muted'}
                testId="inspect-troubled"
              />
            </>
          )}
          {info.growthBlockers.length > 0 ? (
            <ul className="inspect-blockers" data-testid="inspect-blockers">
              {info.growthBlockers.map((blocker) => (
                <li key={blocker}>⚠ {t(BLOCKER_LABEL[blocker])}</li>
              ))}
            </ul>
          ) : (
            <p className="inspect-ok" data-testid="inspect-growth-ok">
              ✓ {t('inspect.growthOk')}
            </p>
          )}
        </section>
      )}
    </aside>
  );
}
