/**
 * Tiny WebAudio synthesizer for UI feedback — no audio assets needed.
 * The AudioContext is created lazily on the first (user-gesture-driven)
 * play call, satisfying autoplay policies.
 */
export type SoundKind = 'click' | 'build' | 'reject' | 'achievement' | 'alarm';

class SoundManager {
  enabled = true;
  volume = 0.4;
  private context: AudioContext | null = null;
  private master: GainNode | null = null;

  play(kind: SoundKind): void {
    if (!this.enabled) return;
    const context = this.ensureContext();
    if (!context || !this.master) return;
    this.master.gain.value = this.volume;
    const now = context.currentTime;
    switch (kind) {
      case 'click':
        this.tone(now, 880, 0.03, 0.12, 'sine');
        break;
      case 'build':
        this.tone(now, 330, 0.06, 0.25, 'triangle');
        this.tone(now + 0.05, 440, 0.08, 0.2, 'triangle');
        break;
      case 'reject':
        this.tone(now, 220, 0.09, 0.25, 'sawtooth');
        this.tone(now + 0.09, 165, 0.12, 0.22, 'sawtooth');
        break;
      case 'achievement':
        this.tone(now, 523.25, 0.12, 0.25, 'sine');
        this.tone(now + 0.1, 659.25, 0.12, 0.25, 'sine');
        this.tone(now + 0.2, 783.99, 0.22, 0.25, 'sine');
        break;
      case 'alarm':
        // Two-tone descending beep: unmistakably a warning, but short
        // enough not to grate when a storm's countdown fires it once.
        this.tone(now, 660, 0.16, 0.28, 'square');
        this.tone(now + 0.18, 440, 0.22, 0.28, 'square');
        break;
    }
  }

  private ensureContext(): AudioContext | null {
    if (this.context) {
      if (this.context.state === 'suspended') void this.context.resume();
      return this.context;
    }
    try {
      this.context = new AudioContext();
      this.master = this.context.createGain();
      this.master.connect(this.context.destination);
      return this.context;
    } catch {
      return null;
    }
  }

  private tone(
    startTime: number,
    frequency: number,
    duration: number,
    gain: number,
    type: OscillatorType,
  ): void {
    const context = this.context;
    if (!context || !this.master) return;
    const oscillator = context.createOscillator();
    oscillator.type = type;
    oscillator.frequency.value = frequency;
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0, startTime);
    envelope.gain.linearRampToValueAtTime(gain, startTime + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
    oscillator.connect(envelope);
    envelope.connect(this.master);
    oscillator.start(startTime);
    oscillator.stop(startTime + duration + 0.05);
  }
}

/** App-wide sound singleton. */
export const sound = new SoundManager();
