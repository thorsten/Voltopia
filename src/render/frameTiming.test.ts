import { describe, expect, it } from 'vitest';
import { FrameCounters, MAX_ANIMATION_STEP_SECONDS, frameDeltas } from './frameTiming.ts';

/** The subset of three's WebGLInfo the counters touch, with its auto-reset behaviour. */
function fakeInfo() {
  const info = {
    autoReset: true,
    render: { calls: 0, triangles: 0 },
    reset() {
      info.render.calls = 0;
      info.render.triangles = 0;
    },
  };
  // What WebGLRenderer.render does at its start: wipe the counters when autoReset is on.
  const pass = (calls: number, triangles: number) => {
    if (info.autoReset) info.reset();
    info.render.calls += calls;
    info.render.triangles += triangles;
  };
  return { info, pass };
}

describe('FrameCounters', () => {
  it('adds up every render pass of a frame instead of keeping only the last one', () => {
    const { info, pass } = fakeInfo();
    const counters = new FrameCounters(info);
    counters.beginFrame();
    pass(40, 90_000); // shadow map
    pass(62, 400_000); // main pass
    pass(1, 2); // output quad
    expect(info.render).toEqual({ calls: 103, triangles: 490_002 });
  });

  it('starts every frame from zero', () => {
    const { info, pass } = fakeInfo();
    const counters = new FrameCounters(info);
    counters.beginFrame();
    pass(40, 1);
    counters.beginFrame();
    pass(3, 1);
    expect(info.render.calls).toBe(3);
  });
});

describe('frameDeltas', () => {
  it('reports the real frame time and a separate capped animation step', () => {
    expect(frameDeltas(2500, 1000)).toEqual({
      measuredSeconds: 1.5,
      animationSeconds: MAX_ANIMATION_STEP_SECONDS,
    });
  });

  it('leaves an ordinary frame uncapped', () => {
    const { measuredSeconds, animationSeconds } = frameDeltas(1016, 1000);
    expect(measuredSeconds).toBeCloseTo(0.016);
    expect(animationSeconds).toBeCloseTo(0.016);
  });
});
