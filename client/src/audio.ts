/**
 * Sons sintetizados com Web Audio API — nenhum arquivo de áudio.
 * Miados: fonte "glótica" (dente-de-serra) passando por filtros de formantes
 * que deslizam de "mi" para "au", com contorno de tom, envelope e vibrato.
 */
import type { ShipKind } from '../../server/src/protocol';

interface MeowVoice {
  /** Frequência fundamental base (Hz). */
  f0: number;
  /** Multiplicadores do tom: início, pico, fim. */
  contour: [number, number, number];
  /** Posição do pico (0..1). */
  peakAt: number;
  dur: number;
  wave: OscillatorType;
  vibRate: number;
  /** Profundidade do vibrato em fração de f0. */
  vibDepth: number;
  /** Escala dos formantes (gatos grandes = mais grave). */
  formant: number;
  /** Quantidade de ruído (rouquidão). */
  rasp: number;
  gain: number;
}

const VOICES: Record<ShipKind, MeowVoice> = {
  // grave e lento
  gordo: { f0: 210, contour: [0.85, 1.15, 0.7], peakAt: 0.45, dur: 1.05, wave: 'sawtooth', vibRate: 4, vibDepth: 0.02, formant: 0.75, rasp: 0.08, gain: 0.9 },
  // agudo e longo, bem "cantado"
  siames: { f0: 620, contour: [0.8, 1.35, 0.85], peakAt: 0.35, dur: 1.2, wave: 'sawtooth', vibRate: 6.5, vibDepth: 0.035, formant: 1.25, rasp: 0.02, gain: 0.7 },
  // médio
  malhado: { f0: 430, contour: [0.9, 1.2, 0.8], peakAt: 0.35, dur: 0.6, wave: 'sawtooth', vibRate: 5, vibDepth: 0.015, formant: 1.0, rasp: 0.04, gain: 0.8 },
  // rouco
  preto: { f0: 300, contour: [0.9, 1.12, 0.75], peakAt: 0.4, dur: 0.75, wave: 'square', vibRate: 9, vibDepth: 0.03, formant: 0.9, rasp: 0.45, gain: 0.6 },
  // fininho e curto
  filhote: { f0: 900, contour: [0.9, 1.3, 1.05], peakAt: 0.3, dur: 0.28, wave: 'triangle', vibRate: 0, vibDepth: 0, formant: 1.5, rasp: 0.0, gain: 0.9 },
};

class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  muted = false;

  constructor() {
    try {
      this.muted = localStorage.getItem('gatinhos.muted') === '1';
    } catch {
      /* sem storage */
    }
    const unlock = () => this.unlock();
    // iOS/Android exigem um gesto do usuário para liberar o áudio.
    for (const ev of ['pointerdown', 'touchend', 'keydown']) {
      window.addEventListener(ev, unlock, { passive: true });
    }
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.ctx?.state === 'suspended') void this.ctx.resume();
    });
  }

  unlock() {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as any).webkitAudioContext;
      if (!Ctor) return;
      const ctx: AudioContext = new Ctor();
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -12;
      comp.ratio.value = 4;
      const master = ctx.createGain();
      master.gain.value = this.muted ? 0 : 0.8;
      master.connect(comp).connect(ctx.destination);
      // Buffer de ruído branco reutilizável.
      const noise = ctx.createBuffer(1, ctx.sampleRate * 1.5, ctx.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      this.ctx = ctx;
      this.master = master;
      this.noise = noise;
      // Toca um buffer silencioso (truque para iOS).
      const silent = ctx.createBufferSource();
      silent.buffer = ctx.createBuffer(1, 1, 22050);
      silent.connect(ctx.destination);
      silent.start(0);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setMuted(m: boolean) {
    this.muted = m;
    try {
      localStorage.setItem('gatinhos.muted', m ? '1' : '0');
    } catch {
      /* ignore */
    }
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.8, this.ctx.currentTime, 0.02);
  }

  private offline = false;

  private ready() {
    if (this.offline) return this.ctx;
    return this.ctx && this.master && this.noise && this.ctx.state === 'running' && !this.muted ? this.ctx : null;
  }

  /** Renderiza um som num OfflineAudioContext (usado para testar a síntese). */
  async renderOffline(seconds: number, play: (s: SoundEngine) => void): Promise<Float32Array> {
    const prev = { ctx: this.ctx, master: this.master, noise: this.noise };
    const ctx = new OfflineAudioContext(1, Math.ceil(44100 * seconds), 44100);
    const master = ctx.createGain();
    master.connect(ctx.destination);
    const noise = ctx.createBuffer(1, ctx.sampleRate * 1.5, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.ctx = ctx as unknown as AudioContext;
    this.master = master;
    this.noise = noise;
    this.offline = true;
    try {
      play(this);
    } finally {
      this.ctx = prev.ctx;
      this.master = prev.master;
      this.noise = prev.noise;
      this.offline = false;
    }
    const buf = await ctx.startRendering();
    return buf.getChannelData(0);
  }

  private noiseSource(ctx: AudioContext) {
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    return src;
  }

  /** Miado de um gato. `strong` = miado de eliminação (mais alto, longo e dramático). */
  meow(kind: ShipKind, strong = false, delay = 0) {
    const ctx = this.ready();
    if (!ctx) return;
    const v = VOICES[kind];
    const t0 = ctx.currentTime + delay + 0.01;
    const jitter = 1 + (Math.random() - 0.5) * 0.08; // cada miado um pouquinho diferente
    const f0 = v.f0 * jitter * (strong ? 1.12 : 1);
    const dur = v.dur * (strong ? 1.7 : 1) * (0.95 + Math.random() * 0.1);
    const end = t0 + dur;
    const [c0, cPeak, cEnd] = v.contour;
    const tPeak = t0 + dur * v.peakAt;

    const out = ctx.createGain();
    out.connect(this.master!);
    const peakGain = v.gain * (strong ? 1.5 : 1) * 0.5;
    out.gain.setValueAtTime(0.0001, t0);
    out.gain.exponentialRampToValueAtTime(peakGain, t0 + Math.min(0.08, dur * 0.2));
    out.gain.setValueAtTime(peakGain, end - dur * 0.35);
    out.gain.exponentialRampToValueAtTime(0.0001, end);

    // "m": abre o filtro no começo
    const mouth = ctx.createBiquadFilter();
    mouth.type = 'lowpass';
    mouth.frequency.setValueAtTime(350, t0);
    mouth.frequency.exponentialRampToValueAtTime(5000 * v.formant, t0 + Math.min(0.12, dur * 0.3));
    mouth.frequency.exponentialRampToValueAtTime(1400 * v.formant, end);

    // formantes: "i" (F1 baixo, F2 alto) -> "a" (F1 alto) -> "u" (F1/F2 baixos)
    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass';
    f1.Q.value = 5;
    f1.frequency.setValueAtTime(320 * v.formant, t0);
    f1.frequency.linearRampToValueAtTime(850 * v.formant, t0 + dur * 0.45);
    f1.frequency.linearRampToValueAtTime(450 * v.formant, end);
    const f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass';
    f2.Q.value = 7;
    f2.frequency.setValueAtTime(2300 * v.formant, t0);
    f2.frequency.linearRampToValueAtTime(1300 * v.formant, t0 + dur * 0.5);
    f2.frequency.linearRampToValueAtTime(800 * v.formant, end);
    const f1g = ctx.createGain();
    f1g.gain.value = 1.2;
    const f2g = ctx.createGain();
    f2g.gain.value = 0.8;
    const dry = ctx.createGain();
    dry.gain.value = 0.25;
    mouth.connect(f1).connect(f1g).connect(out);
    mouth.connect(f2).connect(f2g).connect(out);
    mouth.connect(dry).connect(out);

    // Fonte(s)
    const oscs: OscillatorNode[] = [];
    const voices = strong ? 2 : 1;
    for (let i = 0; i < voices; i++) {
      const osc = ctx.createOscillator();
      osc.type = v.wave;
      const detune = i === 0 ? 1 : 1.012;
      const fq = osc.frequency;
      if (strong) {
        // grito dramático: começa alto, sobe mais, cai bem baixo no final
        fq.setValueAtTime(f0 * cPeak * 0.95 * detune, t0);
        fq.exponentialRampToValueAtTime(f0 * cPeak * 1.25 * detune, t0 + dur * 0.3);
        fq.exponentialRampToValueAtTime(f0 * cEnd * 0.7 * detune, end);
      } else {
        fq.setValueAtTime(f0 * c0 * detune, t0);
        fq.exponentialRampToValueAtTime(f0 * cPeak * detune, tPeak);
        fq.exponentialRampToValueAtTime(f0 * cEnd * detune, end);
      }
      const depth = v.vibDepth * (strong ? 2 : 1);
      if (depth > 0) {
        const lfo = ctx.createOscillator();
        lfo.frequency.value = v.vibRate * (strong ? 1.3 : 1);
        const lfoGain = ctx.createGain();
        lfoGain.gain.setValueAtTime(0, t0);
        lfoGain.gain.linearRampToValueAtTime(f0 * depth, t0 + dur * 0.4); // vibrato entra aos poucos
        lfo.connect(lfoGain).connect(fq);
        lfo.start(t0);
        lfo.stop(end + 0.05);
      }
      const g = ctx.createGain();
      g.gain.value = i === 0 ? 1 : 0.6;
      osc.connect(g).connect(mouth);
      osc.start(t0);
      osc.stop(end + 0.05);
      oscs.push(osc);
    }

    // Rouquidão: ruído filtrado na região do tom
    const rasp = v.rasp + (strong ? 0.12 : 0);
    if (rasp > 0) {
      const n = this.noiseSource(ctx);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = f0 * 3;
      bp.Q.value = 1.5;
      const ng = ctx.createGain();
      ng.gain.value = rasp * 1.5;
      // modula o ruído na frequência do tom => som "arranhado"
      const am = ctx.createGain();
      am.gain.value = 0;
      const amOsc = ctx.createOscillator();
      amOsc.frequency.value = f0 / 2;
      amOsc.connect(am.gain);
      n.connect(bp).connect(ng).connect(am).connect(mouth);
      n.start(t0);
      n.stop(end + 0.05);
      amOsc.start(t0);
      amOsc.stop(end + 0.05);
    }
  }

  /** Splash de erro (água). */
  splash() {
    const ctx = this.ready();
    if (!ctx) return;
    const t = ctx.currentTime;
    const n = this.noiseSource(ctx);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(2500, t);
    bp.frequency.exponentialRampToValueAtTime(400, t + 0.45);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.6, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    n.connect(bp).connect(g).connect(this.master!);
    n.start(t);
    n.stop(t + 0.55);
    // "bloop" de gotas
    for (let i = 0; i < 3; i++) {
      const o = ctx.createOscillator();
      const og = ctx.createGain();
      const ti = t + 0.08 + i * 0.09 + Math.random() * 0.03;
      o.frequency.setValueAtTime(500 + Math.random() * 400, ti);
      o.frequency.exponentialRampToValueAtTime(1400 + Math.random() * 500, ti + 0.06);
      og.gain.setValueAtTime(0.0001, ti);
      og.gain.exponentialRampToValueAtTime(0.15, ti + 0.01);
      og.gain.exponentialRampToValueAtTime(0.0001, ti + 0.08);
      o.connect(og).connect(this.master!);
      o.start(ti);
      o.stop(ti + 0.1);
    }
  }

  /** Explosão do repelente. */
  boom() {
    const ctx = this.ready();
    if (!ctx) return;
    const t = ctx.currentTime;
    const n = this.noiseSource(ctx);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(3000, t);
    lp.frequency.exponentialRampToValueAtTime(150, t + 0.9);
    const g = ctx.createGain();
    g.gain.setValueAtTime(1.0, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.0);
    n.connect(lp).connect(g).connect(this.master!);
    n.start(t);
    n.stop(t + 1.05);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(35, t + 0.6);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.9, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
    o.connect(og).connect(this.master!);
    o.start(t);
    o.stop(t + 0.75);
  }

  /** "Psst" do spray de repelente. */
  spray() {
    const ctx = this.ready();
    if (!ctx) return;
    const t = ctx.currentTime;
    const n = this.noiseSource(ctx);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 4000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35, t + 0.03);
    g.gain.setValueAtTime(0.35, t + 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    n.connect(hp).connect(g).connect(this.master!);
    n.start(t);
    n.stop(t + 0.45);
  }

  private tone(freq: number, start: number, dur: number, type: OscillatorType = 'triangle', vol = 0.25, endFreq?: number) {
    const ctx = this.ready();
    if (!ctx) return;
    const t = ctx.currentTime + start;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (endFreq) o.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master!);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  pop() {
    this.tone(520, 0, 0.12, 'sine', 0.3, 980);
  }
  click() {
    this.tone(1200, 0, 0.04, 'square', 0.06);
  }
  error() {
    this.tone(220, 0, 0.12, 'square', 0.12, 180);
    this.tone(180, 0.12, 0.15, 'square', 0.12, 140);
  }
  yourTurn() {
    this.tone(660, 0, 0.1, 'triangle', 0.2);
    this.tone(990, 0.1, 0.18, 'triangle', 0.2);
  }
  win() {
    [523, 659, 784, 1047].forEach((f, i) => this.tone(f, i * 0.13, 0.3, 'triangle', 0.25));
  }
  lose() {
    [392, 330, 262, 196].forEach((f, i) => this.tone(f, i * 0.18, 0.35, 'triangle', 0.22));
  }
}

export const sound = new SoundEngine();
