/**
 * The top-centre energy console: the condensed energy row and one drawer
 * holding the detail (graph, energy rows, budget, tax and smart charging).
 * City vitals and time controls live in their own corner plates.
 */
import { BALANCE } from '../shared/constants.ts';
import type { GlobalStats } from '../shared/types.ts';
import { BudgetPanel } from './BudgetPanel.tsx';
import { EnergyGraph } from './EnergyGraph.tsx';
import { EnergyPanel } from './EnergyPanel.tsx';
import { EnergyStrip } from './EnergyStrip.tsx';
import { useI18n } from './i18n.tsx';
import { TaxSlider } from './TaxSlider.tsx';

export function HudConsole({
  stats,
  detailsOpen,
  onToggleDetails,
  onSetTaxRate,
  onSetSmartMeterRollout,
  onSetDemandResponse,
  onSetMarketTrading,
  onBuyInsulation,
}: {
  stats: GlobalStats;
  detailsOpen: boolean;
  onToggleDetails: () => void;
  onSetTaxRate: (rate: number) => void;
  onSetSmartMeterRollout: (active: boolean) => void;
  onSetDemandResponse: (active: boolean) => void;
  onSetMarketTrading: (enabled: boolean) => void;
  onBuyInsulation: () => void;
}) {
  const { t } = useI18n();

  return (
    <div className={`hud-console ${detailsOpen ? 'open' : ''}`} data-testid="hud-console">
      <EnergyStrip
        energy={stats.energy}
        riverFlow={stats.weather.riverFlow}
        timeOfDay={stats.timeOfDay}
        open={detailsOpen}
        onToggle={onToggleDetails}
      />
      {/* Hangs off the bottom of the console instead of growing it, so
          opening the details never nudges the rest of the HUD. Kept mounted
          so it can animate; `visibility: hidden` takes it out of the
          a11y tree and the tab order while closed. */}
      <div
        className={`hud-drawer-panel ${detailsOpen ? 'open' : ''}`}
        data-testid="hud-drawer"
        aria-hidden={!detailsOpen}
      >
        <EnergyGraph energy={stats.energy} timeOfDay={stats.timeOfDay} />
        <div className="hud-drawer">
          <EnergyPanel
            energy={stats.energy}
            riverFlow={stats.weather.riverFlow}
            smartMeters={stats.smartMeters}
            demandResponse={stats.demandResponse}
          />
          <BudgetPanel budget={stats.budget} />
          <section className="hud-section">
            <h2>{t('hud.section.city')}</h2>
            <TaxSlider rate={stats.taxRate} onChange={onSetTaxRate} />
            <label
              className="smart-charging-toggle smart-meters"
              data-testid="smart-charging"
              title={t('smartMeters.title', {
                perDay: BALANCE.smartMeters.installsPerDay,
                cost: BALANCE.smartMeters.costPerMeter,
              })}
            >
              <input
                type="checkbox"
                checked={stats.smartMeters.active}
                onChange={(e) => onSetSmartMeterRollout(e.target.checked)}
              />
              <span>{t('smartMeters.label')}</span>
              <span className="smart-meters-coverage" data-testid="smart-meters-coverage">
                {t('smartMeters.coverage', {
                  percent: Math.round(stats.smartMeters.coverage * 100),
                  metered: stats.smartMeters.metered,
                  buildings: stats.smartMeters.buildings,
                })}
              </span>
            </label>
            <label
              className="smart-charging-toggle smart-meters"
              data-testid="demand-response"
              title={t('demandResponse.title', {
                share: Math.round(BALANCE.demandResponse.shedShare * 100),
                retainer: BALANCE.demandResponse.retainerPerBuildingPerDay,
                price: BALANCE.demandResponse.activationPricePerEnergyUnit,
                hours: BALANCE.demandResponse.maxCallHoursPerDay,
              })}
            >
              <input
                type="checkbox"
                checked={stats.demandResponse.active}
                onChange={(e) => onSetDemandResponse(e.target.checked)}
              />
              <span>{t('demandResponse.label')}</span>
              <span className="smart-meters-coverage" data-testid="demand-response-figure">
                {t('demandResponse.figure', {
                  pool: Math.round(stats.demandResponse.pool),
                  hours: stats.demandResponse.callHoursLeft.toFixed(1),
                })}
              </span>
            </label>
            <label
              className="smart-charging-toggle"
              data-testid="market-trading"
              title={t('marketTrading.title')}
            >
              <input
                type="checkbox"
                checked={stats.marketTrading}
                onChange={(e) => onSetMarketTrading(e.target.checked)}
              />
              <span>{t('marketTrading.label')}</span>
            </label>
            <div
              className="smart-charging-toggle"
              data-testid="insulation"
              title={t('insulation.title')}
            >
              <span>{t('insulation.label')}</span>
              {stats.insulation ? (
                <span className="insulation-state">✓ {t('insulation.bought')}</span>
              ) : (
                <button
                  type="button"
                  className="insulation-buy"
                  data-testid="insulation-buy"
                  aria-label={t('insulation.title')}
                  disabled={stats.money < BALANCE.costs.insulation}
                  onClick={onBuyInsulation}
                >
                  {t('insulation.buy', { cost: BALANCE.costs.insulation.toLocaleString('en-US') })}
                </button>
              )}
            </div>
            {/* Debug-grade figure; stays mounted so tooling can read it. */}
            <div className="hud-tick" data-testid="tick-counter">
              tick {stats.tick}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
