/**
 * Zero-asset audio. Everything is synthesised at runtime with WebAudio, so
 * the whole sound design costs 0 bytes of network transfer and games stay
 * instant to load.
 *
 * Browsers refuse to start an AudioContext without a user gesture, so nothing
 * is created until `unlock()` is called from a real interaction.
 */

export type Wave = "sine" | "square" | "sawtooth" | "triangle" | "noise";

export interface ToneSpec {
  wave?: Wave;
  /** Starting frequency in Hz. */
  freq?: number;
  /** Sweep target. Reached over `glide` seconds. */
  freqTo?: number;
  glide?: number;
  vol?: number;
  /** Envelope, in seconds. */
  attack?: number;
  hold?: number;
  release?: number;
  /** Lowpass by default; set `filterType` for others. */
  filter?: number;
  filterTo?: number;
  filterType?: BiquadFilterType;
  q?: number;
  /** Frequency modulation: adds `depth` Hz of wobble at `rate` Hz. */
  vibrato?: { rate: number; depth: number };
  /** Stereo position, -1..1. */
  pan?: number;
  /** Schedule this many seconds into the future. */
  delay?: number;
  /** Small random detune in cents, so repeated sounds don't feel robotic. */
  jitter?: number;
}

const NOTE_OFFSETS: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

/** "A4" -> 440. Accepts sharps ("C#4") and flats ("Db4"). */
export function noteToFreq(note: string): number {
  const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(note.trim());
  if (!m) return 440;
  const [, letter, accidental, octave] = m;
  let semis = NOTE_OFFSETS[letter.toUpperCase()];
  if (accidental === "#") semis += 1;
  if (accidental === "b") semis -= 1;
  const midi = semis + (parseInt(octave, 10) + 1) * 12;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Semitone offset from a base frequency. */
export const transpose = (freq: number, semitones: number) =>
  freq * Math.pow(2, semitones / 12);

export class AudioKit {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private _muted = false;
  private _volume = 0.7;
  private musicTimer: number | null = null;
  private musicStep = 0;
  private nextNoteTime = 0;

  /** Sounds fired before unlock are dropped rather than queued. */
  get ready() {
    return this.ctx !== null && this.ctx.state === "running";
  }

  get muted() {
    return this._muted;
  }

  get currentTime() {
    return this.ctx?.currentTime ?? 0;
  }

  /**
   * Must be called from a user gesture handler. Safe to call repeatedly —
   * subsequent calls just resume a suspended context.
   */
  unlock = () => {
    if (typeof window === "undefined") return;
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this._muted ? 0 : this._volume;
      this.master.connect(this.ctx.destination);
      this.noiseBuffer = this.makeNoise(this.ctx);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  };

  setMuted(muted: boolean) {
    this._muted = muted;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(
        muted ? 0 : this._volume,
        this.ctx.currentTime,
        0.02,
      );
    }
  }

  setVolume(v: number) {
    this._volume = Math.max(0, Math.min(1, v));
    if (this.master && this.ctx && !this._muted) {
      this.master.gain.setTargetAtTime(this._volume, this.ctx.currentTime, 0.02);
    }
  }

  suspend() {
    if (this.ctx && this.ctx.state === "running") void this.ctx.suspend();
  }

  resume() {
    if (this.ctx && this.ctx.state === "suspended") void this.ctx.resume();
  }

  dispose() {
    this.stopMusic();
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
      this.master = null;
    }
  }

  private makeNoise(ctx: AudioContext): AudioBuffer {
    const len = ctx.sampleRate * 1.0;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** The one primitive every sound is built from. */
  play(spec: ToneSpec): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || this._muted) return;

    const {
      wave = "square",
      freq = 440,
      freqTo,
      glide,
      vol = 0.3,
      attack = 0.004,
      hold = 0.05,
      release = 0.08,
      filter,
      filterTo,
      filterType = "lowpass",
      q = 1,
      vibrato,
      pan = 0,
      delay = 0,
      jitter = 0,
    } = spec;

    const t0 = ctx.currentTime + delay;
    const detune = jitter ? (Math.random() * 2 - 1) * jitter : 0;

    let source: AudioScheduledSourceNode;
    let freqParam: AudioParam | null = null;

    if (wave === "noise") {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.loop = true;
      // Playback rate shifts the noise character (higher = hissier).
      src.playbackRate.value = Math.max(0.1, freq / 440);
      if (freqTo !== undefined) {
        src.playbackRate.setValueAtTime(Math.max(0.1, freq / 440), t0);
        src.playbackRate.exponentialRampToValueAtTime(
          Math.max(0.05, freqTo / 440),
          t0 + (glide ?? hold + release),
        );
      }
      source = src;
    } else {
      const osc = ctx.createOscillator();
      osc.type = wave;
      osc.frequency.setValueAtTime(Math.max(1, freq), t0);
      if (detune) osc.detune.setValueAtTime(detune, t0);
      if (freqTo !== undefined) {
        const target = Math.max(1, freqTo);
        osc.frequency.exponentialRampToValueAtTime(
          target,
          t0 + (glide ?? hold + release),
        );
      }
      freqParam = osc.frequency;
      source = osc;
    }

    const gain = ctx.createGain();
    const peak = Math.max(0.0001, vol);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + attack);
    gain.gain.setValueAtTime(peak, t0 + attack + hold);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + hold + release);

    let node: AudioNode = source;

    if (filter !== undefined) {
      const biquad = ctx.createBiquadFilter();
      biquad.type = filterType;
      biquad.Q.value = q;
      biquad.frequency.setValueAtTime(Math.max(20, filter), t0);
      if (filterTo !== undefined) {
        biquad.frequency.exponentialRampToValueAtTime(
          Math.max(20, filterTo),
          t0 + attack + hold + release,
        );
      }
      node.connect(biquad);
      node = biquad;
    }

    node.connect(gain);

    let tail: AudioNode = gain;
    if (pan !== 0 && ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, pan));
      gain.connect(panner);
      tail = panner;
    }
    tail.connect(master);

    let lfo: OscillatorNode | null = null;
    if (vibrato && freqParam) {
      lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      lfo.frequency.value = vibrato.rate;
      lfoGain.gain.value = vibrato.depth;
      lfo.connect(lfoGain);
      lfoGain.connect(freqParam);
      lfo.start(t0);
    }

    const stopAt = t0 + attack + hold + release + 0.02;
    source.start(t0);
    source.stop(stopAt);
    if (lfo) lfo.stop(stopAt);

    source.onended = () => {
      source.disconnect();
      gain.disconnect();
    };
  }

  /** Fire several tones as one sound. */
  chord(specs: ToneSpec[]): void {
    for (const s of specs) this.play(s);
  }

  // --- presets -------------------------------------------------------------
  // Tuned by ear. Every game gets a usable palette without designing sounds.

  blip(freq = 660, vol = 0.18) {
    this.play({ wave: "square", freq, vol, attack: 0.002, hold: 0.02, release: 0.05, jitter: 12 });
  }

  click(vol = 0.14) {
    this.play({ wave: "noise", freq: 1800, vol, attack: 0.001, hold: 0.005, release: 0.03, filter: 3000, filterType: "highpass" });
  }

  pickup(freq = 520, vol = 0.2) {
    this.play({ wave: "square", freq, freqTo: freq * 2, glide: 0.09, vol, attack: 0.002, hold: 0.04, release: 0.09 });
  }

  coin(vol = 0.2) {
    this.play({ wave: "square", freq: 988, vol, attack: 0.002, hold: 0.03, release: 0.04 });
    this.play({ wave: "square", freq: 1319, vol, attack: 0.002, hold: 0.06, release: 0.12, delay: 0.055 });
  }

  jump(vol = 0.2) {
    this.play({ wave: "triangle", freq: 220, freqTo: 620, glide: 0.12, vol, attack: 0.003, hold: 0.03, release: 0.1 });
  }

  hit(vol = 0.28) {
    this.play({ wave: "noise", freq: 700, freqTo: 120, vol, attack: 0.001, hold: 0.03, release: 0.12, filter: 2200, filterTo: 300 });
    this.play({ wave: "square", freq: 180, freqTo: 60, glide: 0.1, vol: vol * 0.6, attack: 0.001, hold: 0.02, release: 0.1 });
  }

  explode(vol = 0.35) {
    this.play({ wave: "noise", freq: 500, freqTo: 60, vol, attack: 0.002, hold: 0.08, release: 0.45, filter: 1600, filterTo: 120 });
    this.play({ wave: "sawtooth", freq: 90, freqTo: 30, glide: 0.35, vol: vol * 0.5, attack: 0.002, hold: 0.06, release: 0.35 });
  }

  laser(vol = 0.2) {
    this.play({ wave: "sawtooth", freq: 1400, freqTo: 260, glide: 0.12, vol, attack: 0.001, hold: 0.02, release: 0.09, filter: 3200, filterTo: 700 });
  }

  whoosh(vol = 0.18) {
    this.play({ wave: "noise", freq: 300, freqTo: 1400, vol, attack: 0.05, hold: 0.03, release: 0.14, filter: 500, filterTo: 3000, filterType: "bandpass", q: 2 });
  }

  powerUp(vol = 0.24) {
    const base = 440;
    [0, 4, 7, 12].forEach((s, i) => {
      this.play({ wave: "square", freq: transpose(base, s), vol, attack: 0.002, hold: 0.04, release: 0.1, delay: i * 0.055 });
    });
  }

  fail(vol = 0.28) {
    const base = 330;
    [0, -3, -7].forEach((s, i) => {
      this.play({ wave: "sawtooth", freq: transpose(base, s), vol, attack: 0.004, hold: 0.09, release: 0.22, delay: i * 0.11, filter: 1400, filterTo: 400 });
    });
  }

  thud(vol = 0.3) {
    this.play({ wave: "sine", freq: 160, freqTo: 45, glide: 0.14, vol, attack: 0.002, hold: 0.04, release: 0.2 });
  }

  tick(vol = 0.1) {
    this.play({ wave: "square", freq: 1200, vol, attack: 0.001, hold: 0.004, release: 0.02 });
  }

  // --- music ---------------------------------------------------------------
  /**
   * Lookahead scheduler (Chris Wilson's "A Tale of Two Clocks"): a coarse
   * setInterval decides *what* to play, WebAudio timestamps decide *when*.
   * setTimeout alone drifts audibly; this does not.
   */
  startMusic(
    onStep: (step: number, time: number, kit: AudioKit) => void,
    bpm = 120,
    stepsPerBeat = 4,
  ) {
    this.stopMusic();
    if (!this.ctx) return;
    const stepDuration = 60 / bpm / stepsPerBeat;
    this.musicStep = 0;
    this.nextNoteTime = this.ctx.currentTime + 0.08;

    const LOOKAHEAD_MS = 25;
    const SCHEDULE_AHEAD = 0.12;

    const schedule = () => {
      const ctx = this.ctx;
      if (!ctx) return;
      while (this.nextNoteTime < ctx.currentTime + SCHEDULE_AHEAD) {
        onStep(this.musicStep, this.nextNoteTime - ctx.currentTime, this);
        this.nextNoteTime += stepDuration;
        this.musicStep++;
      }
    };

    schedule();
    this.musicTimer = window.setInterval(schedule, LOOKAHEAD_MS);
  }

  stopMusic() {
    if (this.musicTimer !== null) {
      clearInterval(this.musicTimer);
      this.musicTimer = null;
    }
  }
}

/** One context for the whole site — browsers cap how many you may open. */
export const audio = new AudioKit();
