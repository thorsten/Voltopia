/**
 * Frame-time bookkeeping for the diagnostics panel: a ring buffer of the
 * last frames, summarised as a mean, a 95th percentile (the stutter the
 * mean hides) and the frame rate those imply.
 */

/** How many frames the window keeps — about two seconds at 60 Hz. */
export const FRAME_WINDOW = 120;

export interface FrameSummary {
  /** Mean frame time in milliseconds (0 while nothing has been recorded). */
  meanMs: number;
  /** 95th percentile frame time: the worst frames, where stutter lives. */
  p95Ms: number;
  /** Frames per second implied by the mean. */
  fps: number;
  /** Frames the summary is built from. */
  samples: number;
}

/** A fixed-size window of frame times. */
export class FrameWindow {
  private readonly samples: Float64Array;
  private readonly sorted: Float64Array;
  private count = 0;
  private next = 0;

  constructor(private readonly capacity: number = FRAME_WINDOW) {
    this.samples = new Float64Array(capacity);
    this.sorted = new Float64Array(capacity);
  }

  /** Record one frame. Non-finite or negative durations are ignored. */
  push(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
    this.samples[this.next] = milliseconds;
    this.next = (this.next + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  summary(): FrameSummary {
    if (this.count === 0) return { meanMs: 0, p95Ms: 0, fps: 0, samples: 0 };
    let sum = 0;
    for (let i = 0; i < this.count; i++) {
      const value = this.samples[i];
      sum += value;
      this.sorted[i] = value;
    }
    const window = this.sorted.subarray(0, this.count);
    window.sort();
    const meanMs = sum / this.count;
    // Nearest-rank: the lowest sample at or above 95 % of the window.
    const rank = Math.min(this.count - 1, Math.ceil(0.95 * this.count) - 1);
    return {
      meanMs,
      p95Ms: window[rank],
      fps: meanMs > 0 ? 1000 / meanMs : 0,
      samples: this.count,
    };
  }

  clear(): void {
    this.count = 0;
    this.next = 0;
  }
}
