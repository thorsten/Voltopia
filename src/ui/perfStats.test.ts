import { describe, expect, it } from 'vitest';
import { FrameWindow } from './perfStats.ts';

describe('FrameWindow', () => {
  it('is empty before anything is recorded', () => {
    expect(new FrameWindow().summary()).toEqual({ meanMs: 0, p95Ms: 0, fps: 0, samples: 0 });
  });

  it('averages the frames and derives the frame rate', () => {
    const window = new FrameWindow(8);
    for (const ms of [16, 16, 16, 16]) window.push(ms);
    const summary = window.summary();
    expect(summary.meanMs).toBeCloseTo(16, 6);
    expect(summary.fps).toBeCloseTo(62.5, 3);
    expect(summary.samples).toBe(4);
  });

  it('reports the slow frames in the 95th percentile, not in the mean', () => {
    const window = new FrameWindow(100);
    for (let i = 0; i < 94; i++) window.push(10);
    for (let i = 0; i < 6; i++) window.push(90);
    const summary = window.summary();
    // The mean barely moves off the smooth frames …
    expect(summary.meanMs).toBeCloseTo(14.8, 6);
    // … while the percentile lands squarely on the stutter.
    expect(summary.p95Ms).toBe(90);
  });

  it('keeps only the last `capacity` frames', () => {
    const window = new FrameWindow(4);
    for (const ms of [100, 100, 100, 100, 20, 20, 20, 20]) window.push(ms);
    const summary = window.summary();
    expect(summary.samples).toBe(4);
    expect(summary.meanMs).toBeCloseTo(20, 6);
  });

  it('ignores nonsense durations and clears on demand', () => {
    const window = new FrameWindow(4);
    window.push(Number.NaN);
    window.push(-5);
    window.push(Number.POSITIVE_INFINITY);
    expect(window.summary().samples).toBe(0);
    window.push(10);
    expect(window.summary().samples).toBe(1);
    window.clear();
    expect(window.summary().samples).toBe(0);
  });
});
