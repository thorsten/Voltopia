import { useEffect, useMemo, useState } from 'react';
import { annualCsv, annualReport, lifetimeCsv, type AnnualRow } from '../shared/annualReport.ts';
import { TICKS_PER_DAY } from '../shared/constants.ts';
import type { LifetimeData } from '../shared/messages.ts';
import type { LifetimeSample } from '../shared/types.ts';
import { daysPerYear } from '../sim/seasons.ts';
import type { SaveStorage, SaveSummary } from '../storage/storage.ts';
import { Modal } from './Modal.tsx';
import { useI18n } from './i18n.tsx';
import { exportTextFile } from './platform.ts';
import { alignSeries, compareOptions, csvFileName } from './statsReport.ts';
import type { SimBridge } from './useSimBridge.ts';

const WIDTH = 460;
const HEIGHT = 110;

/** SVG path for one metric; NaN values break the line (missing samples). */
function linePath(values: number[], max: number, min = 0): string {
  if (values.length < 2) return '';
  const stepX = WIDTH / (values.length - 1);
  const range = Math.max(1e-9, max - min);
  let d = '';
  let pen = false;
  values.forEach((value, i) => {
    if (Number.isNaN(value)) {
      pen = false;
      return;
    }
    const y = HEIGHT - ((value - min) / range) * (HEIGHT - 6) - 3;
    d += `${pen ? 'L' : 'M'}${(i * stepX).toFixed(1)},${y.toFixed(1)} `;
    pen = true;
  });
  return d.trim();
}

function Chart({
  title,
  series,
}: {
  title: string;
  series: Array<{ values: number[]; color: string; label: string; dashed?: boolean }>;
}) {
  const finiteValues = series.flatMap((s) => s.values.filter((v) => !Number.isNaN(v)));
  const max = Math.max(1, ...finiteValues);
  const min = Math.min(0, ...finiteValues);
  return (
    <section className="stats-chart">
      <h3>{title}</h3>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={title}>
        <line
          x1="0"
          y1={HEIGHT - 3}
          x2={WIDTH}
          y2={HEIGHT - 3}
          style={{ stroke: 'var(--hud-border)' }}
        />
        {series.map((s) => (
          <path
            key={`${s.label}${s.dashed ? ':compare' : ''}`}
            d={linePath(s.values, max, min)}
            fill="none"
            stroke={s.color}
            strokeWidth="1.5"
            strokeDasharray={s.dashed ? '4 3' : undefined}
          />
        ))}
      </svg>
      <div className="stats-legend">
        {series
          .filter((s) => !s.dashed)
          .map((s) => (
            <span key={s.label} style={{ color: s.color }}>
              {s.label}
            </span>
          ))}
      </div>
    </section>
  );
}

const fmt = (value: number): string => Math.round(value).toLocaleString('en-US');
const pct = (value: number | undefined): string =>
  value === undefined ? '–' : `${Math.round(value * 100)} %`;
const opt = (value: number | undefined): string => (value === undefined ? '–' : fmt(value));

function AnnualTable({ rows, sandbox }: { rows: AnnualRow[]; sandbox: boolean }) {
  const { t } = useI18n();
  const total = daysPerYear();
  return (
    <section className="stats-chart">
      <h3>{t('stats.annual')}</h3>
      <div className="stats-table-wrap">
        <table className="stats-table">
          <thead>
            <tr>
              <th>{t('stats.col.year')}</th>
              <th>{t('stats.col.population')}</th>
              <th>{t('stats.col.jobs')}</th>
              <th>{t('stats.col.happiness')}</th>
              <th>{t('stats.col.generation')}</th>
              <th>{t('stats.col.consumption')}</th>
              <th>{t('stats.col.renewable')}</th>
              <th>{t('stats.col.import')}</th>
              <th>{t('stats.col.export')}</th>
              <th>{t('stats.col.deficit')}</th>
              {!sandbox && <th>{t('stats.col.money')}</th>}
              {!sandbox && <th>{t('stats.col.moneyDelta')}</th>}
            </tr>
          </thead>
          <tbody>
            {[...rows].reverse().map((row) => (
              <tr key={row.year} className={row.complete ? undefined : 'stats-row-running'}>
                <td>
                  {row.year}
                  {!row.complete && (
                    <small> {t('stats.annual.running', { days: row.days, total })}</small>
                  )}
                </td>
                <td>{fmt(row.population)}</td>
                <td>{fmt(row.jobs)}</td>
                <td>{pct(row.happiness)}</td>
                <td>{fmt(row.generation)}</td>
                <td>{fmt(row.consumption)}</td>
                <td>{pct(row.renewableShare)}</td>
                <td>{opt(row.gridImport)}</td>
                <td>{opt(row.gridExport)}</td>
                <td>{opt(row.deficitTicks)}</td>
                {!sandbox && <td>{fmt(row.moneyEnd)}</td>}
                {!sandbox && <td>{(row.moneyDelta >= 0 ? '+' : '') + fmt(row.moneyDelta)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Lifetime statistics: one sample per in-game day since founding, folded into years. */
export function StatsPage({
  bridge,
  sandbox,
  storage,
  onClose,
}: {
  bridge: SimBridge;
  /** Sandbox city: the treasury is pinned, so its chart would be a flat line. */
  sandbox: boolean;
  storage: SaveStorage;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [data, setData] = useState<LifetimeData | null>(null);
  const [saves, setSaves] = useState<SaveSummary[]>([]);
  const [compareId, setCompareId] = useState('');
  const [other, setOther] = useState<(LifetimeData & { sandbox: boolean }) | null>(null);

  const { send, onLifetime } = bridge;
  useEffect(() => {
    const unsubscribe = onLifetime((next) => setData(next));
    send({ type: 'requestLifetime' });
    return unsubscribe;
  }, [send, onLifetime]);

  useEffect(() => {
    void storage.list().then(setSaves);
  }, [storage]);

  useEffect(() => {
    if (!compareId) {
      setOther(null);
      return;
    }
    let cancelled = false;
    void storage.load(compareId).then((save) => {
      if (cancelled || !save) return;
      setOther({
        samples: save.lifetime ?? [],
        seasonOriginDay: save.seasonOriginDay ?? Math.floor(save.tick / TICKS_PER_DAY),
        sandbox: save.sandbox === true,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [storage, compareId]);

  const samples = data?.samples ?? [];
  const rows = useMemo(
    () =>
      data ? annualReport(data.samples, data.seasonOriginDay, daysPerYear(), TICKS_PER_DAY) : [],
    [data],
  );

  const series = (
    pick: (s: LifetimeSample) => number | undefined,
    color: string,
    label: string,
    { money = false } = {},
  ) => {
    const own = { values: samples.map((s) => pick(s) ?? NaN), color, label };
    if (!data || !other || (money && other.sandbox)) return [own];
    return [own, { values: alignSeries(data, other, pick), color, label, dashed: true }];
  };

  const exportCsv = (kind: 'days' | 'years'): void => {
    const text = kind === 'days' ? lifetimeCsv(samples, sandbox) : annualCsv(rows, sandbox);
    void exportTextFile(csvFileName(kind, new Date()), text);
  };

  return (
    <Modal title={t('stats.title')} onClose={onClose} testId="stats-page">
      <div className="stats-toolbar">
        <label>
          {t('stats.compare')}{' '}
          <select
            data-testid="stats-compare"
            value={compareId}
            onChange={(e) => setCompareId(e.target.value)}
          >
            <option value="">{t('stats.compare.none')}</option>
            {compareOptions(saves).map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          data-testid="stats-csv-days"
          onClick={() => exportCsv('days')}
          disabled={samples.length === 0}
        >
          {t('stats.csvDays')}
        </button>
        <button
          type="button"
          data-testid="stats-csv-years"
          onClick={() => exportCsv('years')}
          disabled={rows.length === 0}
        >
          {t('stats.csvYears')}
        </button>
      </div>
      {other && <p className="stats-hint">{t('stats.compare.hint')}</p>}
      {samples.length < 2 ? (
        <p className="stats-empty">{t('stats.empty')}</p>
      ) : (
        <>
          <AnnualTable rows={rows} sandbox={sandbox} />
          <Chart
            title={t('stats.population')}
            series={[
              ...series((s) => s.population, '#67c26b', t('hud.residents')),
              ...series((s) => s.jobs, '#5b8fd6', t('hud.jobs')),
            ]}
          />
          <Chart
            title={t('stats.energy')}
            series={[
              ...series((s) => s.avgGeneration, '#7be07f', t('energy.legend.generation')),
              ...series((s) => s.avgConsumption, '#e0788a', t('energy.legend.consumption')),
            ]}
          />
          <Chart
            title={t('stats.gridTrade')}
            series={[
              ...series((s) => s.gridImport, '#f28c6b', t('energy.legend.import')),
              ...series((s) => s.gridExport, '#6bc5f2', t('energy.legend.export')),
            ]}
          />
          <Chart
            title={t('stats.deficit')}
            series={series((s) => s.deficitTicks, '#e05a5a', t('stats.col.deficit'))}
          />
          {!sandbox && (
            <Chart
              title={t('stats.money')}
              series={series((s) => s.money, '#ffd166', '⌁', { money: true })}
            />
          )}
          <Chart
            title={t('stats.happiness')}
            series={series((s) => s.happiness * 100, '#d6a2e8', '%')}
          />
          <Chart
            title={t('stats.temperature')}
            series={series((s) => s.temperature, '#f4a261', '°C')}
          />
        </>
      )}
    </Modal>
  );
}
