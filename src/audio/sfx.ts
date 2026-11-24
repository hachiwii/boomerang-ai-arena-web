/**
 * Lightweight zero-asset procedural Web Audio SFX for snappy Boomerang combat feedback.
 */
export class SoundFX {
  private ctx: AudioContext | null = null;
  private offlineCtx: BaseAudioContext | null = null;
  private offlineTimeSec = 0;
  private pageHidden = typeof document !== 'undefined' ? document.hidden : false;
  public muted = false;
  public volume = 1.0;

  public applySettings(soundEnabled: boolean, volumePct: number) {
    this.muted = !soundEnabled;
    this.volume = Math.max(0, Math.min(1, volumePct / 100));
  }

  public setPageHidden(hidden: boolean) {
    if (this.pageHidden === hidden) return;
    this.pageHidden = hidden;
    if (hidden) {
      if (this.ctx && this.ctx.state === 'running') {
        void this.ctx.suspend().catch(() => {});
      }
    } else if (this.ctx && this.ctx.state === 'suspended' && !this.muted) {
      void this.ctx.resume().catch(() => {});
    }
  }

  /**
   * Directs SFX scheduling into an OfflineAudioContext at an exact video timestamp
   * for frame-accurate audio muxing during offline MP4 replay export.
   */
  public setOfflineTarget(ctx: BaseAudioContext | null, timeSec = 0) {
    this.offlineCtx = ctx;
    this.offlineTimeSec = Math.max(0.001, timeSec);
  }

  private ensure(): BaseAudioContext | null {
    if (this.muted || this.volume <= 0.001) return null;
    if (this.offlineCtx) return this.offlineCtx;
    if (this.pageHidden) return null;
    if (!this.ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  private tone(freq0: number, freq1: number, dur: number, type: OscillatorType, gainVal: number, delay = 0) {
    const ctx = this.ensure();
    if (!ctx) return;
    const gScaled = Math.max(0.0002, gainVal * this.volume);
    const baseTime = this.offlineCtx ? this.offlineTimeSec : ctx.currentTime;
    const t0 = Math.max(0.001, baseTime + delay);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq0, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq1), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(gScaled, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  private noise(dur: number, gainVal: number, filterFreq: number, q = 1.5, delay = 0) {
    const ctx = this.ensure();
    if (!ctx) return;
    const gScaled = Math.max(0.0002, gainVal * this.volume);
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const flt = ctx.createBiquadFilter();
    flt.type = 'bandpass';
    flt.frequency.value = filterFreq;
    flt.Q.value = q;
    const g = ctx.createGain();
    const baseTime = this.offlineCtx ? this.offlineTimeSec : ctx.currentTime;
    const t0 = Math.max(0.001, baseTime + delay);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(gScaled, t0 + Math.min(0.004, dur * 0.25));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(flt).connect(g).connect(ctx.destination);
    src.start(t0);
    src.stop(t0 + dur + 0.015);
  }

  public playThrow() {
    this.tone(420, 860, 0.11, 'triangle', 0.12);
    this.noise(0.09, 0.08, 1600, 1.2);
  }

  public playSlash() {
    this.noise(0.12, 0.16, 2200, 0.9);
    this.tone(720, 220, 0.11, 'sawtooth', 0.09);
  }

  public playKick() {
    this.tone(190, 65, 0.12, 'sine', 0.18);
    this.noise(0.07, 0.1, 600, 1.0);
  }

  public playKickHit() {
    this.tone(240, 70, 0.16, 'triangle', 0.22);
    this.noise(0.09, 0.15, 900, 0.8);
  }

  public playDash() {
    this.noise(0.11, 0.11, 1200, 1.4);
    this.tone(260, 520, 0.1, 'sine', 0.08);
  }

  public playClash() {
    this.tone(1450, 920, 0.16, 'square', 0.08);
    this.tone(2180, 1620, 0.14, 'triangle', 0.12);
  }

  public playBlock() {
    this.tone(1100, 1800, 0.14, 'triangle', 0.14);
    this.tone(1650, 2400, 0.1, 'sine', 0.09, 0.02);
  }

  public playCatch() {
    this.tone(520, 780, 0.07, 'sine', 0.08);
  }

  public playRecallCall() {
    this.tone(440, 980, 0.18, 'sine', 0.1);
  }

  // ---------- Recall channel: continuous charge hum → release cue ----------
  private charge: {
    ctx: BaseAudioContext;
    oscA: OscillatorNode;
    oscB: OscillatorNode;
    lfo: OscillatorNode;
    lfoDepth: GainNode;
    filter: BiquadFilterNode;
    gain: GainNode;
  } | null = null;

  /** Starts a rising "charging" hum while the human player channels a recall (live play only). */
  public startRecallCharge() {
    this.stopRecallCharge(true);
    if (this.offlineCtx) return;
    const ctx = this.ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime;
    const oscA = ctx.createOscillator();
    const oscB = ctx.createOscillator();
    const lfo = ctx.createOscillator();
    const lfoDepth = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    const trem = ctx.createGain();
    const gain = ctx.createGain();
    oscA.type = 'sine';
    oscB.type = 'triangle';
    oscA.frequency.setValueAtTime(190, t0);
    oscB.frequency.setValueAtTime(285, t0);
    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(7, t0);
    lfoDepth.gain.setValueAtTime(0.35, t0);
    trem.gain.setValueAtTime(0.65, t0);
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(900, t0);
    filter.Q.value = 2.2;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(Math.max(0.0002, 0.055 * this.volume), t0 + 0.06);
    const bGain = ctx.createGain();
    bGain.gain.value = 0.45;
    oscA.connect(filter);
    oscB.connect(bGain).connect(filter);
    filter.connect(trem).connect(gain).connect(ctx.destination);
    lfo.connect(lfoDepth).connect(trem.gain);
    oscA.start(t0);
    oscB.start(t0);
    lfo.start(t0);
    this.charge = { ctx, oscA, oscB, lfo, lfoDepth, filter, gain };
  }

  /** progress 0..1 → pitch climbs two octaves, tremolo speeds up, brightness & level swell. */
  public updateRecallCharge(progress: number) {
    const c = this.charge;
    if (!c) return;
    const p = Math.max(0, Math.min(1, progress));
    const t = c.ctx.currentTime;
    const f = 190 * Math.pow(2, p * 2);
    c.oscA.frequency.setTargetAtTime(f, t, 0.03);
    c.oscB.frequency.setTargetAtTime(f * 1.5, t, 0.03);
    c.lfo.frequency.setTargetAtTime(7 + p * 17, t, 0.05);
    c.filter.frequency.setTargetAtTime(900 + p * 3600, t, 0.04);
    c.gain.gain.setTargetAtTime(Math.max(0.0002, (0.055 + p * 0.05) * this.volume), t, 0.05);
  }

  /** Fades the charge hum out (fast when it resolves into the release cue, softer on cancel). */
  public stopRecallCharge(released = false) {
    const c = this.charge;
    if (!c) return;
    this.charge = null;
    const t = c.ctx.currentTime;
    const fade = released ? 0.02 : 0.07;
    try {
      c.gain.gain.cancelScheduledValues(t);
      c.gain.gain.setValueAtTime(Math.max(0.0001, c.gain.gain.value), t);
      c.gain.gain.exponentialRampToValueAtTime(0.0001, t + fade);
      if (!released) {
        c.oscA.frequency.setTargetAtTime(120, t, 0.04);
      }
      const stopAt = t + fade + 0.03;
      c.oscA.stop(stopAt);
      c.oscB.stop(stopAt);
      c.lfo.stop(stopAt);
    } catch {
      // already stopped
    }
  }

  /** Recall channel completed: bright whoosh-snap as the dart flies back. */
  public playRecallRelease() {
    this.tone(140, 58, 0.13, 'sine', 0.13);
    this.tone(660, 1980, 0.16, 'triangle', 0.12);
    this.tone(1320, 2640, 0.12, 'sine', 0.07, 0.025);
    this.noise(0.2, 0.11, 2600, 0.9, 0.01);
  }

  public playHitKill() {
    this.tone(320, 95, 0.22, 'sawtooth', 0.15);
    this.tone(880, 1320, 0.12, 'triangle', 0.11, 0.02);
    this.noise(0.14, 0.14, 1800, 0.8);
  }

  public playFall() {
    this.tone(540, 140, 0.35, 'sine', 0.12);
  }

  public playCollapse() {
    this.tone(95, 42, 0.28, 'triangle', 0.15);
    this.noise(0.22, 0.1, 320, 0.9);
  }

  /**
   * Crumbling gravel & cracking stone warning cue when the human player is standing
   * on a floor tile about to collapse. `urgency` in [0..1] ramps density & grit.
   */
  public playCrumble(urgency = 0.5) {
    const u = Math.max(0, Math.min(1, urgency));
    // Subtle low rock shift under feet
    const baseFreq = 135 + u * 55 + Math.random() * 25;
    this.tone(baseFreq, 48 + Math.random() * 14, 0.055 + u * 0.025, 'triangle', 0.065 + u * 0.055);
    // Dry stone fracture scrape
    this.noise(0.042 + u * 0.02, 0.075 + u * 0.055, 820 + u * 360 + Math.random() * 240, 2.2);
    // Staggered loose pebbles / gravel clacks
    const pebbles = 3 + Math.floor(u * 2.5) + (Math.random() < 0.45 ? 1 : 0);
    for (let i = 0; i < pebbles; i++) {
      const delay = i === 0 ? 0.004 : 0.014 + i * (0.018 - u * 0.005) + Math.random() * 0.022;
      const freq = 1750 + Math.random() * 2600 + u * 400;
      const dur = 0.014 + Math.random() * 0.018;
      const gain = (0.05 + u * 0.055) * (0.65 + Math.random() * 0.55);
      this.noise(dur, gain, freq, 3.2 + Math.random() * 2.2, delay);
    }
  }

  public playVictory() {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) => {
      this.tone(f, f * 1.01, 0.22, 'triangle', 0.12, i * 0.08);
    });
  }

  public playCountdownTick(num: 3 | 2 | 1) {
    const base = num === 3 ? 523.25 : num === 2 ? 587.33 : 659.25;
    this.tone(base, base * 0.98, 0.13, 'triangle', 0.14);
    this.tone(base * 2, base * 1.96, 0.08, 'sine', 0.05);
  }

  public playCountdownGo() {
    this.tone(1046.5, 1060, 0.24, 'triangle', 0.16);
    this.tone(1318.5, 1340, 0.22, 'sine', 0.11, 0.04);
  }

  public playRankUp() {
    const notes = [587.33, 783.99, 987.77, 1174.66];
    notes.forEach((f, i) => {
      this.tone(f, f * 1.01, 0.18, 'triangle', 0.11, i * 0.065);
    });
  }

  public playRankDown() {
    this.tone(392, 311, 0.18, 'triangle', 0.09);
    this.tone(311, 246.9, 0.22, 'sine', 0.08, 0.1);
  }
}
