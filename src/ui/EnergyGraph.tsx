/**
 * Generation vs. consumption over the last in-game day, in two sizes:
 *
 * - `EnergySparkline` — a small chip in the energy row. Always on screen,
 *   just enough to read the shape of the day at a glance.
 * - `EnergyGraph` — the wide band at the top of the detail drawer, for
 *   when the player actually wants to study the curve.
 *
 * Both share the same normalisation so the two never disagree.
 */
import { useRef } from 'react';
import {
  BALANCE,
  ENERGY_HISTORY_SAMPLES,
  TICKS_PER_DAY,
  TICKS_PER_HISTORY_SAMPLE,
} from '../shared/constants.ts';
import type { EnergyStats } from '../shared/types.ts';
import { useI18n } from './i18n.tsx';

// Theme variables (see :root in app.css), so the curves follow the HUD theme.
const GENERATION_COLOR = 'var(--hud-positive-strong)';
const CONSUMPTION_COLOR = 'var(--hud-negative-strong)';
const PRICE_COLOR = 'var(--hud-warn)';

/**
 * The graph always spans one full history window, edge to edge, whether
 * or not the city has lived long enough to fill it. Spacing samples to fit
 * however many exist instead (the obvious approach) re-spaces every point
 * and clock label each time a new sample lands during the first day.
 */
const WINDOW_INTERVALS = ENERGY_HISTORY_SAMPLES - 1;
/** Same span in days, for the clock labels. */
const WINDOW_DAYS = WINDOW_INTERVALS / ENERGY_HISTORY_SAMPLES;

/**
 * How far "now" is into the sample being accumulated, 0..1. The newest
 * history entry was taken this far back, so the whole curve is drawn
 * offset by it and scrolls continuously with the clock; when the next
 * sample lands, the offset wraps to 0 and every point stays exactly where
 * it was. Pinning the newest entry to the right edge instead froze the
 * curve between samples and lurched it one step left on each new one.
 */
function intervalProgress(timeOfDay: number): number {
  const ticksIntoDay = Math.round(timeOfDay * TICKS_PER_DAY);
  return (ticksIntoDay % TICKS_PER_HISTORY_SAMPLE) / TICKS_PER_HISTORY_SAMPLE;
}

/** The vertical scale only ever lands on one of these × a power of ten. */
const NICE_MANTISSAS = [1, 2, 5, 10];
/** Data must fit under the next-smaller nice ceiling with this much room before the scale steps down. */
const SHRINK_HEADROOM = 1.25;

function niceCeil(value: number): number {
  const base = 10 ** Math.floor(Math.log10(value));
  return (NICE_MANTISSAS.find((m) => m * base >= value) ?? 10) * base;
}

/**
 * Shared vertical scale: the smallest "nice" ceiling (10, 20, 50, 100, …)
 * that fits everything on screen, with hysteresis so it steps down only
 * once the data comfortably fits under a smaller one. Every point is
 * normalised by this, so any change to it reshapes the whole curve; that
 * makes a scale that tracks the exact peak (recomputed as the window
 * slides, or ratcheting up on each new high) constantly "breathe". Nice
 * steps change rarely and by a legible amount, like a chart axis should.
 */
function useNiceMax(energy: EnergyStats): number {
  const peak = Math.max(
    1,
    ...energy.history.flatMap((p) => [p.generation, p.consumption, p.unshifted]),
    energy.pending.generation,
    energy.pending.consumption,
    energy.pending.unshifted,
  );
  const needed = niceCeil(peak);
  const scaleRef = useRef(needed);
  if (needed > scaleRef.current) {
    scaleRef.current = needed;
  } else {
    const relaxed = niceCeil(peak * SHRINK_HEADROOM);
    if (relaxed < scaleRef.current) scaleRef.current = relaxed;
  }
  return scaleRef.current;
}

interface Series {
  generation: Array<[number, number]>;
  consumption: Array<[number, number]>;
  /** Consumption without load shifting (see `showsUnshifted`). */
  unshifted: Array<[number, number]>;
  /** Spot price factor, on its own fixed 0..spotMax scale. */
  price: Array<[number, number]>;
}

/** The dashed line only earns its place once shifting actually happens. */
export function showsUnshifted(energy: Pick<EnergyStats, 'history' | 'pending'>): boolean {
  return [...energy.history, energy.pending].some(
    (p) => Math.abs(p.unshifted - p.consumption) > 1e-6,
  );
}

/**
 * Both curves mapped into a width × height drawing space, sharing one
 * vertical scale so they stay comparable. The leading edge runs on to
 * "now" at the right edge using the in-progress sample average, which is
 * exactly what the next sample will be — so it lands without a jump.
 */
function seriesOf(
  energy: EnergyStats,
  timeOfDay: number,
  width: number,
  height: number,
  topPadding: number,
  max: number,
): Series {
  const offset = intervalProgress(timeOfDay);
  const stepX = width / WINDOW_INTERVALS;
  const newest = energy.history.length - 1;
  const y = (value: number): number =>
    height - (Math.min(value, max) / max) * (height - topPadding);

  const project = (pick: (point: EnergyStats['pending']) => number): Array<[number, number]> => {
    if (newest < 0) return [];
    const points: Array<[number, number]> = energy.history.map((point, i) => [
      width - (offset + newest - i) * stepX,
      y(pick(point)),
    ]);
    points.push([width, y(pick(energy.pending))]);
    return points;
  };
  // The price is a factor, not an energy flow: it gets its own fixed
  // scale so the curve never rescales with the energy axis.
  const yPrice = (value: number): number =>
    height -
    (Math.min(value, BALANCE.market.spotMax) / BALANCE.market.spotMax) * (height - topPadding);
  const projectPrice = (): Array<[number, number]> => {
    if (newest < 0) return [];
    const points: Array<[number, number]> = energy.history.map((point, i) => [
      width - (offset + newest - i) * stepX,
      yPrice(point.price),
    ]);
    points.push([width, yPrice(energy.pending.price)]);
    return points;
  };
  return {
    generation: project((p) => p.generation),
    consumption: project((p) => p.consumption),
    unshifted: project((p) => p.unshifted),
    price: projectPrice(),
  };
}

function line(points: Array<[number, number]>): string {
  return points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
}

/** The same curve closed along the baseline, for the soft fill underneath. */
function area(points: Array<[number, number]>, width: number, height: number): string {
  if (points.length === 0) return '';
  const head = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`);
  return `${head.join(' ')} L${width} ${height} L0 ${height} Z`;
}

/**
 * Each curve is drawn twice, a dark halo under the colour: the console
 * background is translucent, so thin lines otherwise vanish over sunlit
 * terrain.
 */
function Curves({ series, width }: { series: Series; width: number }) {
  return (
    <>
      {[
        { points: series.consumption, color: CONSUMPTION_COLOR, stroke: width },
        { points: series.generation, color: GENERATION_COLOR, stroke: width + 0.25 },
      ].map((curve) => (
        <g key={curve.color}>
          <polyline
            points={line(curve.points)}
            fill="none"
            style={{ stroke: 'var(--hud-graph-halo)' }}
            strokeWidth={curve.stroke + 2.5}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
          <polyline
            points={line(curve.points)}
            fill="none"
            style={{ stroke: curve.color }}
            strokeWidth={curve.stroke}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </g>
      ))}
    </>
  );
}

const SPARK_WIDTH = 150;
const SPARK_HEIGHT = 26;

/**
 * Compact version for the energy row: no legend, no fill, no chrome.
 * `collapsed` folds it away when the drawer shows the full-size graph, so
 * the same curve is never on screen twice.
 */
export function EnergySparkline({
  energy,
  timeOfDay,
  collapsed,
}: {
  energy: EnergyStats;
  timeOfDay: number;
  collapsed: boolean;
}) {
  const { t } = useI18n();
  const max = useNiceMax(energy);
  const series = seriesOf(energy, timeOfDay, SPARK_WIDTH, SPARK_HEIGHT, 3, max);
  return (
    <svg
      className={`energy-sparkline ${collapsed ? 'collapsed' : ''}`}
      data-testid="energy-sparkline"
      aria-hidden={collapsed}
      viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={t('energy.graph.label')}
    >
      <title>{t('energy.graph.label')}</title>
      <Curves series={series} width={1.25} />
    </svg>
  );
}

const BAND_WIDTH = 1000;
const BAND_HEIGHT = 120;
/** Label spacings that read well on a clock. */
const TICK_STEPS_HOURS = [1, 2, 3, 6, 12];
/** Roughly how many labels to aim for across the window. */
const TARGET_TICKS = 4;
const TICK_STEP_HOURS =
  TICK_STEPS_HOURS.find((candidate) => candidate >= (WINDOW_DAYS * 24) / TARGET_TICKS) ?? 12;

interface HourTick {
  /** 0..1 across the graph. */
  position: number;
  hour: number;
}

/**
 * Clock times of day inside the window, which always reaches `WINDOW_DAYS`
 * back from "now" — the same mapping the curve uses, so labels and curve
 * scroll together.
 */
function hourTicks(timeOfDay: number): HourTick[] {
  const startDays = timeOfDay - WINDOW_DAYS;
  const ticks: HourTick[] = [];
  // Walk whole-hour marks from the first one inside the window. These are
  // hours since midnight of the *start* day, so they can go negative when
  // the window crosses midnight.
  const firstHour = Math.ceil((startDays * 24) / TICK_STEP_HOURS) * TICK_STEP_HOURS;
  for (let hour = firstHour; hour <= timeOfDay * 24 + 1e-6; hour += TICK_STEP_HOURS) {
    ticks.push({
      position: (hour / 24 - startDays) / WINDOW_DAYS,
      hour: ((Math.round(hour) % 24) + 24) % 24,
    });
  }
  return ticks;
}

/** Wide band across the top of the detail drawer. */
export function EnergyGraph({ energy, timeOfDay }: { energy: EnergyStats; timeOfDay: number }) {
  const { t } = useI18n();
  const max = useNiceMax(energy);
  // Generous top padding leaves the legend a strip the curves stay out of.
  const series = seriesOf(energy, timeOfDay, BAND_WIDTH, BAND_HEIGHT, 26, max);
  const ticks = hourTicks(timeOfDay);

  return (
    <div className="hud-row-graph" data-testid="energy-graph">
      <svg
        viewBox={`0 0 ${BAND_WIDTH} ${BAND_HEIGHT}`}
        // Stretching the drawing space is what makes the curve span the
        // console; strokes opt out of the distortion.
        preserveAspectRatio="none"
        role="img"
        aria-label={t('energy.graph.label')}
      >
        <defs>
          <linearGradient id="energy-graph-fade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: GENERATION_COLOR }} stopOpacity="0.22" />
            <stop offset="100%" style={{ stopColor: GENERATION_COLOR }} stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((tick) => (
          <line
            key={tick.hour}
            x1={tick.position * BAND_WIDTH}
            x2={tick.position * BAND_WIDTH}
            y1="0"
            y2={BAND_HEIGHT}
            style={{ stroke: 'var(--hud-track)' }}
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <path d={area(series.generation, BAND_WIDTH, BAND_HEIGHT)} fill="url(#energy-graph-fade)" />
        <polyline
          points={line(series.price)}
          fill="none"
          style={{ stroke: PRICE_COLOR }}
          strokeWidth="1.5"
          strokeDasharray="5 4"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        {showsUnshifted(energy) && (
          <polyline
            points={line(series.unshifted)}
            fill="none"
            style={{ stroke: CONSUMPTION_COLOR, opacity: 0.55 }}
            strokeWidth="1.5"
            strokeDasharray="4 3"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        )}
        <Curves series={series} width={2} />
      </svg>
      {/* Labels sit outside the SVG: the drawing space is stretched, which
          would squash text. */}
      <div className="energy-graph-ticks" aria-hidden="true">
        {ticks.map((tick) => (
          <span key={tick.hour} style={{ left: `${tick.position * 100}%` }}>
            {String(tick.hour).padStart(2, '0')}:00
          </span>
        ))}
      </div>
      <div className="energy-graph-legend">
        <span className="legend-generation">{t('energy.legend.generation')}</span>
        <span className="legend-consumption">{t('energy.legend.consumption')}</span>
        {showsUnshifted(energy) && (
          <span className="legend-unshifted">{t('energy.legend.unshifted')}</span>
        )}
        <span className="legend-price">{t('energy.legend.price')}</span>
      </div>
    </div>
  );
}
