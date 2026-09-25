import type { EnergyStats } from '../shared/types.ts';
import { useI18n } from './i18n.tsx';
import { useSmoothedNumber } from './useSmoothedNumber.ts';

function formatEnergy(value: number): string {
  return value.toFixed(1);
}

/** Below this a value is "nothing to see", and the row is dimmed. */
const IDLE_THRESHOLD = 0.05;

function Row({
  label,
  value,
  testId,
  tone,
  standby,
}: {
  label: string;
  value: number;
  testId: string;
  tone?: 'positive' | 'negative';
  /** Show a standby label instead of the value (installed but idle). */
  standby?: boolean;
}) {
  const { t } = useI18n();
  // Eased so weather/load noise doesn't make the digit flicker every tick.
  const smoothed = useSmoothedNumber(value);
  // Idle rows stay in place and grey out. They used to unmount, which
  // reshuffled the panel every time a plant came online or went idle.
  const idle = Math.abs(smoothed) < IDLE_THRESHOLD;
  return (
    <div className={`energy-row ${idle && !standby ? 'muted' : (tone ?? '')}`} data-testid={testId}>
      <span>{label}</span>
      <span>{standby ? t('energy.standby') : formatEnergy(smoothed)}</span>
    </div>
  );
}

function SocBlock({
  label,
  stored,
  capacity,
  testId,
}: {
  label: string;
  stored: number;
  capacity: number;
  testId: string;
}) {
  const share = capacity > 0 ? stored / capacity : 0;
  const smoothedShare = useSmoothedNumber(share);
  return (
    <div className={`soc-block ${capacity > 0 ? '' : 'muted'}`} data-testid={testId}>
      <div className="soc-label">
        <span>{label}</span>
        <span>{capacity > 0 ? `${Math.round(smoothedShare * 100)}%` : '—'}</span>
      </div>
      <div className="soc-track">
        <div className="soc-fill" style={{ width: `${smoothedShare * 100}%` }} />
      </div>
    </div>
  );
}

/**
 * Energy section of the HUD drawer: the labelled per-source breakdown
 * behind the condensed strip, plus storage state of charge. The day graph
 * lives in the band above it.
 *
 * Every row and meter is always rendered, dimmed when it has nothing to
 * report, so building a battery or firing up a biogas plant never changes
 * the panel's height or shuffles the rows underneath.
 */
export function EnergyPanel({ energy, riverFlow }: { energy: EnergyStats; riverFlow: number }) {
  const { t } = useI18n();
  const totalGeneration =
    energy.generation.solar +
    energy.generation.wind +
    energy.generation.biogas +
    energy.generation.rooftop +
    energy.generation.hydro +
    energy.generation.hydrogen +
    energy.generation.tidal +
    energy.generation.geothermal;
  const totalConsumption =
    energy.consumption.buildings +
    energy.consumption.charging +
    energy.consumption.heating +
    energy.consumption.cooling +
    energy.consumption.electrolysis;
  const balance = useSmoothedNumber(totalGeneration - totalConsumption);

  return (
    <section className="hud-section energy-panel" data-testid="energy-panel">
      <h2>{t('energy.title')}</h2>
      <div className="energy-rows">
        <Row
          label={t('energy.solar')}
          value={energy.generation.solar}
          testId="detail-energy-solar"
        />
        <Row label={t('energy.wind')} value={energy.generation.wind} testId="detail-energy-wind" />
        <Row
          label={t('energy.hydro', { flow: Math.round(riverFlow * 100) })}
          value={energy.generation.hydro}
          testId="detail-energy-hydro"
        />
        <Row
          label={t('energy.tidal')}
          value={energy.generation.tidal}
          testId="detail-energy-tidal"
        />
        <Row
          label={t('energy.geothermal')}
          value={energy.generation.geothermal}
          testId="detail-energy-geothermal"
        />
        {/* Biogas is dispatchable backup: an installed but idle plant is
            on standby, not broken. */}
        <Row
          label={t('energy.biogas')}
          value={energy.generation.biogas}
          testId="detail-energy-biogas"
          standby={energy.biogasCapacity > 0 && energy.generation.biogas <= 0}
        />
        <Row
          label={t('energy.rooftop')}
          value={energy.generation.rooftop}
          testId="detail-energy-rooftop"
        />
        {/* The fuel cell is dispatchable like biogas: installed but idle
            means standby, not broken. */}
        <Row
          label={t('energy.fuelCell')}
          value={energy.generation.hydrogen}
          testId="detail-energy-fuelcell"
          standby={energy.hydrogenCapacity > 0 && energy.generation.hydrogen <= 0}
        />
        <Row
          label={t('energy.consumption')}
          value={totalConsumption}
          testId="detail-energy-consumption"
        />
        <Row
          label={t('energy.charging')}
          value={energy.consumption.charging}
          testId="detail-energy-charging"
        />
        <Row
          label={t('energy.heating')}
          value={energy.consumption.heating}
          testId="detail-energy-heating"
        />
        <Row
          label={t('energy.cooling')}
          value={energy.consumption.cooling}
          testId="detail-energy-cooling"
        />
        <Row
          label={t('energy.electrolysis')}
          value={energy.consumption.electrolysis}
          testId="detail-energy-electrolysis"
        />
        <div
          className={`energy-row balance ${balance >= 0 ? 'positive' : 'negative'}`}
          data-testid="detail-energy-balance"
        >
          <span>{balance >= 0 ? t('energy.surplus') : t('energy.deficit')}</span>
          <span>{formatEnergy(Math.abs(balance))}</span>
        </div>
        {/* Spot price is a factor on the link prices, not an energy flow,
            so it gets its own row instead of the smoothed Row component. */}
        <div className="energy-row" data-testid="detail-energy-spot">
          <span>{t('energy.spot')}</span>
          <span>{`×${energy.spotPrice.toFixed(2)}`}</span>
        </div>
        <Row
          label={t('energy.import')}
          value={energy.gridImport}
          testId="detail-energy-import"
          tone="negative"
        />
        <Row
          label={t('energy.export')}
          value={energy.gridExport}
          testId="detail-energy-export"
          tone="positive"
        />
        <Row
          label={t('energy.hydrogenSold')}
          value={energy.hydrogenSold}
          testId="detail-energy-hydrogen-sold"
          tone="positive"
        />
        <Row
          label={t('energy.curtailed')}
          value={energy.curtailment}
          testId="detail-energy-curtailment"
        />
      </div>

      <SocBlock
        label={t('energy.storage')}
        stored={energy.storedEnergy}
        capacity={energy.storageCapacity}
        testId="energy-soc"
      />
      <SocBlock
        label={t('energy.pumpedStorage')}
        stored={energy.pumpedStoredEnergy}
        capacity={energy.pumpedCapacity}
        testId="energy-pumped-soc"
      />
      <SocBlock
        label={t('energy.hydrogenStorage')}
        stored={energy.hydrogenStoredEnergy}
        capacity={energy.hydrogenCapacity}
        testId="energy-hydrogen-soc"
      />
    </section>
  );
}
