import { WEAPON_PISTOL, WEAPON_RIFLE, WEAPON_SHOTGUN, WEAPON_SMG } from "@br/shared";

/** Shot "voice" per weapon: band-pass center (Hz) and decay (s). */
const SHOT_TONE: Record<number, [number, number]> = {
  [WEAPON_PISTOL]: [1800, 0.09],
  [WEAPON_SMG]: [2400, 0.06],
  [WEAPON_SHOTGUN]: [700, 0.22],
  [WEAPON_RIFLE]: [1100, 0.3],
};

/** Synthesized sound effects, so there are no audio assets to load. */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noise!: AudioBuffer;

  /** Must be called from a user gesture (browsers block audio until then). */
  unlock() {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    try {
      this.ctx = new AudioContext();
    } catch {
      return;
    }
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.35;
    this.master.connect(this.ctx.destination);
    this.noise = this.ctx.createBuffer(1, this.ctx.sampleRate * 0.5, this.ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }

  shot(weapon: number, volume: number) {
    if (volume <= 0.02) return;
    const [freq, decay] = SHOT_TONE[weapon] ?? SHOT_TONE[WEAPON_PISTOL];
    this.noiseBurst(freq, decay, volume);
  }

  private noiseBurst(freq: number, decay: number, volume: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = freq;
    filter.Q.value = 0.8;
    const gain = this.envelope(volume, decay);
    src.connect(filter).connect(gain).connect(this.master);
    src.start();
    src.stop(ctx.currentTime + decay + 0.05);
  }

  hurt() {
    this.tone(140, 70, 0.15, "square", 0.5);
  }

  hit() {
    this.tone(900, 600, 0.05, "triangle", 0.35);
  }

  pickup() {
    this.tone(520, 880, 0.12, "sine", 0.4);
  }

  kill() {
    this.tone(700, 1400, 0.16, "triangle", 0.45);
  }

  reload() {
    this.tone(1500, 1200, 0.04, "square", 0.2);
    setTimeout(() => this.tone(1100, 900, 0.05, "square", 0.2), 90);
  }

  whoosh() {
    this.noiseBurst(500, 0.6, 0.35);
  }

  crateBreak() {
    this.noiseBurst(300, 0.25, 0.5);
  }

  eliminated() {
    this.tone(330, 80, 0.6, "sawtooth", 0.4);
  }

  victory() {
    [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => this.tone(f, f, 0.18, "triangle", 0.4), i * 120));
  }

  private tone(from: number, to: number, duration: number, type: OscillatorType, volume: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), ctx.currentTime + duration);
    osc.connect(this.envelope(volume, duration)).connect(this.master);
    osc.start();
    osc.stop(ctx.currentTime + duration + 0.05);
  }

  private envelope(volume: number, duration: number): GainNode {
    const ctx = this.ctx!;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    return gain;
  }
}
