/**
 * Budget section of the HUD drawer.
 *
 * Shows where the money goes: tax income and export revenue against road
 * upkeep, per-plant-type upkeep, biogas fuel and grid imports. Numbers are
 * per in-game day (per-tick values are too small to read). The diagram is
 * a stacked bar per side plus a net line.
 */
import { TICKS_PER_DAY } from '../shared/constants.ts';
import { PlantType, type BudgetStats } from '../shared/types.ts';
import { useI18n, type TranslationKey } from './i18n.tsx';
import { useSmoothedNumber } from './useSmoothedNumber.ts';

const BAR_WIDTH = 220;
const BAR_HEIGHT = 14;

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

/** Distinct colors per expense slice (also used for the row bullets). */
const EXPENSE_COLORS: Record<string, string> = {
  roads: '#8e9bb3',
  avenues: '#b8c2d4',
  busStops: '#f2d16b',
  [PlantType.SolarFarm]: '#f2c14e',
  [PlantType.WindTurbine]: '#6fc3df',
  [PlantType.Battery]: '#9d7be0',
  [PlantType.BiogasPlant]: '#8fbf5f',
  [PlantType.ChargingHub]: '#e07fb0',
  [PlantType.Park]: '#4fa96b',
  [PlantType.RunOfRiver]: '#4f8fd6',
  [PlantType.PumpedStorage]: '#3f6fa8',
  [PlantType.FireStation]: '#d9534f',
  [PlantType.PoliceStation]: '#4a7ec2',
  [PlantType.LogisticsDepot]: '#8d99a6',
  [PlantType.BusDepot]: '#5b8fc7',
  fuel: '#d98f54',
  import: 'var(--hud-negative)',
};

const INCOME_COLORS = { tax: 'var(--hud-positive)', export: '#3f9d63', hydrogen: '#54b8c9' };

interface Slice {
  key: string;
  label: string;
  value: number;
  color: string;
  /** Optional count suffix, e.g. number of plants or road tiles. */
  count?: number;
}

function perDay(value: number): number {
  return value * TICKS_PER_DAY;
}

function money(value: number): string {
  return Math.abs(value) >= 100
    ? Math.round(value).toLocaleString('en-US')
    : value.toFixed(value >= 10 ? 1 : 2);
}

/** One horizontal stacked bar over a shared scale. */
function StackedBar({ slices, scale }: { slices: Slice[]; scale: number }) {
  let x = 0;
  return (
    <svg
      className="budget-bar"
      viewBox={`0 0 ${BAR_WIDTH} ${BAR_HEIGHT}`}
      width="100%"
      height={BAR_HEIGHT}
      // Without this the drawing is letterboxed and centred, leaving a
      // gap at both ends of the bar instead of spanning the column.
      preserveAspectRatio="none"
      role="presentation"
    >
      <rect
        x="0"
        y="0"
        width={BAR_WIDTH}
        height={BAR_HEIGHT}
        rx="3"
        style={{ fill: 'var(--hud-hover-strong)' }}
      />
      {slices.map((slice) => {
        const width = scale > 0 ? (slice.value / scale) * BAR_WIDTH : 0;
        const rect = (
          <rect
            key={slice.key}
            x={x}
            y="0"
            width={Math.max(0, width)}
            height={BAR_HEIGHT}
            style={{ fill: slice.color }}
          >
            <title>{`${slice.label}: ${money(slice.value)}`}</title>
          </rect>
        );
        x += width;
        return rect;
      })}
    </svg>
  );
}

export function BudgetPanel({ budget }: { budget: BudgetStats }) {
  const { t } = useI18n();

  const income: Slice[] = [
    {
      key: 'tax',
      label: t('budget.tax'),
      value: perDay(budget.taxIncome),
      color: INCOME_COLORS.tax,
    },
    {
      key: 'export',
      label: t('budget.export'),
      value: perDay(budget.gridExportRevenue),
      color: INCOME_COLORS.export,
    },
    {
      key: 'hydrogen',
      label: t('budget.hydrogen'),
      value: perDay(budget.hydrogenRevenue),
      color: INCOME_COLORS.hydrogen,
    },
  ].filter((slice) => slice.value > 0);

  const expenses: Slice[] = [
    {
      key: 'roads',
      label: t('budget.roads'),
      value: perDay(budget.gridUpkeep - budget.avenueUpkeep - budget.busStopUpkeep),
      color: EXPENSE_COLORS.roads,
      count: budget.roadTiles - budget.avenueTiles,
    },
    {
      key: 'avenues',
      label: t('budget.avenues'),
      value: perDay(budget.avenueUpkeep),
      color: EXPENSE_COLORS.avenues,
      count: budget.avenueTiles,
    },
    {
      key: 'busStops',
      label: t('budget.busStops'),
      value: perDay(budget.busStopUpkeep),
      color: EXPENSE_COLORS.busStops,
      count: budget.busStops,
    },
    ...Object.entries(budget.plantUpkeepByType)
      .map(([type, upkeep]) => {
        const plant = Number(type) as PlantType;
        const label = PLANT_LABEL[plant];
        return {
          key: type,
          label: label ? t(label) : type,
          value: perDay(upkeep),
          color: EXPENSE_COLORS[plant] ?? '#888',
          count: budget.plantCountByType[plant],
        };
      })
      .filter((slice) => slice.value > 0),
    {
      key: 'fuel',
      label: t('budget.biogasFuel'),
      value: perDay(budget.biogasFuelCost),
      color: EXPENSE_COLORS.fuel,
    },
    {
      key: 'import',
      label: t('budget.import'),
      value: perDay(budget.gridImportCost),
      color: EXPENSE_COLORS.import,
    },
  ].filter((slice) => slice.value > 0);

  const incomeTotal = income.reduce((sum, slice) => sum + slice.value, 0);
  const expenseTotal = expenses.reduce((sum, slice) => sum + slice.value, 0);
  const scale = Math.max(incomeTotal, expenseTotal, 1);
  const net = perDay(budget.net);

  // Only the headline totals ease — the bars and per-slice legend below
  // react instantly, since the slice list itself changes length (plants
  // built/sold) and can't carry one smoothing hook per dynamic entry.
  const displayNet = useSmoothedNumber(net);
  const displayIncomeTotal = useSmoothedNumber(incomeTotal);
  const displayExpenseTotal = useSmoothedNumber(expenseTotal);

  return (
    <section className="hud-section budget-panel" data-testid="budget-panel">
      <h2>
        <span>{t('budget.title')}</span>
        <span className={`budget-net ${displayNet >= 0 ? 'positive' : 'negative'}`}>
          {displayNet >= 0 ? '+' : '−'}
          {money(Math.abs(displayNet))} ⌁/{t('budget.dayUnit')}
        </span>
      </h2>

      <div className="budget-body" data-testid="budget-body">
        <div className="budget-section-label">
          <span>{t('budget.income')}</span>
          <span>{money(displayIncomeTotal)}</span>
        </div>
        <StackedBar slices={income} scale={scale} />
        <div className="budget-section-label">
          <span>{t('budget.expenses')}</span>
          <span>{money(displayExpenseTotal)}</span>
        </div>
        <StackedBar slices={expenses} scale={scale} />

        <ul className="budget-legend">
          {[...income, ...expenses].map((slice) => (
            <li key={`${slice.key}-legend`} data-testid={`budget-slice-${slice.key}`}>
              <span className="budget-dot" style={{ background: slice.color }} />
              <span className="budget-legend-label">
                {slice.label}
                {slice.count !== undefined && slice.count > 0 && (
                  <span className="budget-count"> ×{slice.count}</span>
                )}
              </span>
              <span className="budget-legend-value">{money(slice.value)}</span>
            </li>
          ))}
        </ul>
        <p className="budget-note">{t('budget.note')}</p>
      </div>
    </section>
  );
}
