import { useEffect, useState } from 'react';
import type { LifetimeSample } from '../shared/types.ts';
import { Modal } from './Modal.tsx';
import { useI18n } from './i18n.tsx';
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
  series: Array<{ values: number[]; color: string; label: string }>;
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
            key={s.label}
            d={linePath(s.values, max, min)}
            fill="none"
            stroke={s.color}
            strokeWidth="1.5"
          />
        ))}
      </svg>
      <div className="stats-legend">
        {series.map((s) => (
          <span key={s.label} style={{ color: s.color }}>
            {s.label}
          </span>
        ))}
      </div>
    </section>
  );
}

/** Lifetime statistics: one sample per in-game day since founding. */
export function StatsPage({
  bridge,
  sandbox,
  onClose,
}: {
  bridge: SimBridge;
  /** Sandbox city: the treasury is pinned, so its chart would be a flat line. */
  sandbox: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [samples, setSamples] = useState<LifetimeSample[] | null>(null);

  const { send, onLifetime } = bridge;
  useEffect(() => {
    const unsubscribe = onLifetime((data) => setSamples(data));
    send({ type: 'requestLifetime' });
    return unsubscribe;
  }, [send, onLifetime]);

  return (
    <Modal title={t('stats.title')} onClose={onClose} testId="stats-page">
      {!samples || samples.length < 2 ? (
        <p className="stats-empty">{t('stats.empty')}</p>
      ) : (
        <>
          <Chart
            title={t('stats.population')}
            series={[
              {
                values: samples.map((s) => s.population),
                color: '#67c26b',
                label: t('hud.residents'),
              },
              { values: samples.map((s) => s.jobs), color: '#5b8fd6', label: t('hud.jobs') },
            ]}
          />
          <Chart
            title={t('stats.energy')}
            series={[
              {
                values: samples.map((s) => s.avgGeneration),
                color: '#7be07f',
                label: t('energy.legend.generation'),
              },
              {
                values: samples.map((s) => s.avgConsumption),
                color: '#e0788a',
                label: t('energy.legend.consumption'),
              },
            ]}
          />
          {!sandbox && (
            <Chart
              title={t('stats.money')}
              series={[{ values: samples.map((s) => s.money), color: '#ffd166', label: '⌁' }]}
            />
          )}
          <Chart
            title={t('stats.happiness')}
            series={[
              {
                values: samples.map((s) => s.happiness * 100),
                color: '#d6a2e8',
                label: '%',
              },
            ]}
          />
          <Chart
            title={t('stats.temperature')}
            series={[
              {
                values: samples.map((s) => s.temperature ?? NaN),
                color: '#f4a261',
                label: '°C',
              },
            ]}
          />
        </>
      )}
    </Modal>
  );
}
