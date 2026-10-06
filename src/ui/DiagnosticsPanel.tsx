import { useEffect, useRef, useState } from 'react';
import type { GameRenderer } from '../render/renderer.ts';
import type { GlobalStats } from '../shared/types.ts';
import { TICK_MS } from '../shared/constants.ts';
import { useI18n } from './i18n.tsx';
import { FrameWindow, type FrameSummary } from './perfStats.ts';

/** How often the figures are refreshed; reading them every frame would measure itself. */
const SAMPLE_MS = 500;

interface RenderInfo {
  drawCalls: number;
  triangles: number;
  instances: number;
  instancedMeshes: number;
  geometries: number;
  textures: number;
  programs: number;
}

const EMPTY_FRAME: FrameSummary = { meanMs: 0, p95Ms: 0, fps: 0, samples: 0 };

/**
 * What the game currently costs: frame time with its 95th percentile,
 * what a frame asks of the GPU, and what a simulation tick costs the
 * worker against the 250 ms it has. Shown only while the diagnostics
 * setting is on — it is a measuring instrument, not a HUD element.
 */
export function DiagnosticsPanel({
  rendererRef,
  getTickMs,
  stats,
  gridSize,
}: {
  rendererRef: React.RefObject<GameRenderer | null>;
  /** Stable getter for the worker's smoothed tick cost (see useSimBridge). */
  getTickMs: () => number;
  stats: GlobalStats | null;
  gridSize: number;
}) {
  const { t } = useI18n();
  const frames = useRef(new FrameWindow());
  const [frame, setFrame] = useState<FrameSummary>(EMPTY_FRAME);
  const [info, setInfo] = useState<RenderInfo | null>(null);
  const [tickMs, setTickMs] = useState(0);

  useEffect(() => {
    const window_ = frames.current;
    const record = (deltaSeconds: number) => window_.push(deltaSeconds * 1000);
    const renderer = rendererRef.current;
    renderer?.onFrame(record);
    const timer = setInterval(() => {
      setFrame(window_.summary());
      setInfo(rendererRef.current?.renderInfo() ?? null);
      setTickMs(getTickMs());
    }, SAMPLE_MS);
    return () => {
      clearInterval(timer);
      renderer?.offFrame(record);
      window_.clear();
    };
    // Both are stable identities: a ref object and a useCallback getter.
  }, [rendererRef, getTickMs]);

  const tickShare = (tickMs / TICK_MS) * 100;

  return (
    <div className="diagnostics-panel" data-testid="diagnostics-panel">
      <h4>{t('diagnostics.title')}</h4>
      <dl>
        <div>
          <dt>{t('diagnostics.frame')}</dt>
          <dd data-testid="diagnostics-frame">
            {frame.meanMs.toFixed(1)} ms · p95 {frame.p95Ms.toFixed(1)} ms · {Math.round(frame.fps)}{' '}
            fps
          </dd>
        </div>
        <div>
          <dt>{t('diagnostics.tick')}</dt>
          <dd data-testid="diagnostics-tick">
            {tickMs.toFixed(1)} ms · {tickShare.toFixed(0)} % ({TICK_MS} ms)
          </dd>
        </div>
        <div>
          <dt>{t('diagnostics.draws')}</dt>
          <dd>
            {info?.drawCalls ?? 0} · {((info?.triangles ?? 0) / 1000).toFixed(0)} k{' '}
            {t('diagnostics.triangles')}
          </dd>
        </div>
        <div>
          <dt>{t('diagnostics.instances')}</dt>
          <dd>
            {(info?.instances ?? 0).toLocaleString()} · {info?.instancedMeshes ?? 0}{' '}
            {t('diagnostics.meshes')}
          </dd>
        </div>
        <div>
          <dt>{t('diagnostics.memory')}</dt>
          <dd>
            {info?.geometries ?? 0} · {info?.textures ?? 0} · {info?.programs ?? 0}
          </dd>
        </div>
        <div>
          <dt>{t('diagnostics.city')}</dt>
          <dd>
            {gridSize}² · {stats?.counts.buildingTiles ?? 0} · {stats?.traffic.driving ?? 0} ·{' '}
            {stats?.rail.trainsRunning ?? 0}
          </dd>
        </div>
      </dl>
    </div>
  );
}
