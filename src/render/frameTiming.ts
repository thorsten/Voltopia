/**
 * Frame bookkeeping for the render loop: the GPU counters of one whole
 * frame and the two readings of a frame's duration.
 */

/**
 * Longest step an animation is asked to take, in seconds: a frame that
 * stalled longer (a background tab, a shader compile) resumes smoothly
 * instead of jumping. Measurements must not be capped by this — the
 * diagnostics panel exists to show exactly those stalls.
 */
export const MAX_ANIMATION_STEP_SECONDS = 0.1;

/** The subset of three's WebGLInfo that FrameCounters needs. */
export interface GpuCounters {
  /** three wipes the render counters at the start of every render() call while this is on. */
  autoReset: boolean;
  reset(): void;
}

/**
 * Keeps three's draw-call and triangle counters for a whole frame. The
 * post chain calls renderer.render() several times per frame (shadow
 * map, main pass, the occlusion G-buffer, the output quad), and with
 * autoReset on each call wipes the counters of the one before, so a
 * reading after the frame would show the last pass only — one call, two
 * triangles. Auto-reset is turned off here and the counters are cleared
 * once per frame instead, by beginFrame().
 */
export class FrameCounters {
  constructor(private readonly info: GpuCounters) {
    info.autoReset = false;
  }

  /** Clear the counters; call before the frame's first render pass. */
  beginFrame(): void {
    this.info.reset();
  }
}

/**
 * The time since the previous frame, twice: as measured, for anything
 * that reports frame time, and capped at MAX_ANIMATION_STEP_SECONDS for
 * anything that moves.
 */
export function frameDeltas(
  nowMs: number,
  lastFrameMs: number,
): { measuredSeconds: number; animationSeconds: number } {
  const measuredSeconds = (nowMs - lastFrameMs) / 1000;
  return {
    measuredSeconds,
    animationSeconds: Math.min(measuredSeconds, MAX_ANIMATION_STEP_SECONDS),
  };
}
