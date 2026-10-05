/**
 * Condensed energy row of the HUD console: one icon plus the current value
 * per source, then consumption and the balance. It doubles as the handle
 * for the detail drawer, where the same numbers appear labelled.
 */
import type { EnergyStats } from '../shared/types.ts';
import { EnergySparkline } from './EnergyGraph.tsx';
import { useI18n } from './i18n.tsx';

function formatEnergy(value: number): string {
  return value.toFixed(1);
}

interface Chip {
  /** Matches the old panel rows, so tests and muscle memory still work. */
  testId: string;
  icon: string;
  /** Full label, shown as a native tooltip and in the drawer. */
  label: string;
  value: number;
}

export function EnergyStrip({
  energy,
  riverFlow,
  timeOfDay,
  open,
  onToggle,
  islandsInDeficit,
}: {
  energy: EnergyStats;
  riverFlow: number;
  timeOfDay: number;
  open: boolean;
  onToggle: () => void;
  islandsInDeficit: number;
}) {
  const { t } = useI18n();

  const totalGeneration =
    energy.generation.solar +
    energy.generation.wind +
    energy.generation.biogas +
    energy.generation.rooftop +
    energy.generation.hydro;
  const totalConsumption =
    energy.consumption.buildings +
    energy.consumption.charging +
    energy.consumption.heating +
    energy.consumption.cooling;
  const balance = totalGeneration - totalConsumption;

  const generation: Chip[] = [
    {
      testId: 'energy-solar',
      icon: '☀️',
      label: t('energy.solar'),
      value: energy.generation.solar,
    },
    { testId: 'energy-wind', icon: '🌀', label: t('energy.wind'), value: energy.generation.wind },
    {
      testId: 'energy-hydro',
      icon: '💧',
      label: t('energy.hydro', { flow: Math.round(riverFlow * 100) }),
      value: energy.generation.hydro,
    },
    {
      testId: 'energy-biogas',
      icon: '♻️',
      label: t('energy.biogas'),
      value: energy.generation.biogas,
    },
    // Always present: a chip that comes and goes would shift the whole
    // row. Idle chips grey out instead (see the drawer rows).
    {
      testId: 'energy-rooftop',
      icon: '🏠',
      label: t('energy.rooftop'),
      value: energy.generation.rooftop,
    },
  ];
  const consumption: Chip[] = [
    {
      testId: 'energy-consumption',
      icon: '🏙',
      label: t('energy.consumption'),
      value: totalConsumption,
    },
    {
      testId: 'energy-charging',
      icon: '🔌',
      label: t('energy.charging'),
      value: energy.consumption.charging,
    },
    {
      testId: 'energy-heating',
      icon: '🔥',
      label: t('energy.heating'),
      value: energy.consumption.heating,
    },
    {
      testId: 'energy-cooling',
      icon: '❄️',
      label: t('energy.cooling'),
      value: energy.consumption.cooling,
    },
  ];

  const chip = (item: Chip) => (
    <span
      key={item.testId}
      className={`energy-chip ${Math.abs(item.value) < 0.05 ? 'idle' : ''}`}
      data-testid={item.testId}
      // An icon alone is ambiguous with the drawer closed.
      title={`${item.label}: ${formatEnergy(item.value)}`}
    >
      <span className="energy-chip-icon" aria-hidden="true">
        {item.icon}
      </span>
      <span className="energy-chip-value">{formatEnergy(item.value)}</span>
      <span className="sr-only">{item.label}</span>
    </span>
  );

  const balanceLabel = balance >= 0 ? t('energy.surplus') : t('energy.deficit');

  return (
    // The whole row is the handle for the drawer: a separate button kept
    // wrapping out of the row on narrower windows. The chevron at the end
    // says "this opens"; the label lives in the tooltip and for readers.
    <button
      type="button"
      className="hud-row hud-row-energy hud-details-toggle"
      data-testid="hud-details-toggle"
      aria-expanded={open}
      title={t('hud.details')}
      onClick={onToggle}
    >
      {generation.map(chip)}
      <span className="energy-chip-divider" aria-hidden="true" />
      {consumption.map(chip)}
      <span
        className={`energy-chip balance ${balance >= 0 ? 'positive' : 'negative'}`}
        data-testid="energy-balance"
        title={`${balanceLabel}: ${formatEnergy(Math.abs(balance))}`}
      >
        <span className="energy-chip-icon" aria-hidden="true">
          {balance >= 0 ? '▲' : '▼'}
        </span>
        <span className="energy-chip-value">{formatEnergy(Math.abs(balance))}</span>
        <span className="sr-only">{balanceLabel}</span>
      </span>
      {islandsInDeficit > 0 && (
        <span
          className="energy-chip negative"
          data-testid="energy-districts-deficit"
          title={t('hud.districtsInDeficit', { count: islandsInDeficit })}
        >
          ⚠ {islandsInDeficit}
        </span>
      )}
      <EnergySparkline energy={energy} timeOfDay={timeOfDay} collapsed={open} />
      <span className="sr-only">{t('hud.details')}</span>
      {/* Same glyphs as the goals panel header, so every expandable HUD
          card reads the same way. */}
      <span className="hud-details-chevron" aria-hidden="true">
        {open ? '▾' : '▸'}
      </span>
    </button>
  );
}
