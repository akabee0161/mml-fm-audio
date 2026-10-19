import { ALGORITHMS, type Algorithm } from './algorithms';
import { Envelope } from './envelope';
import { Noise } from './noise';
import { panGains } from './output';
import {
  AM_DEPTH_DB,
  FB_RAD,
  KSL_DB_PER_OCT,
  MOD_INDEX,
  OUTPUT_GAIN,
  SILENT_DB,
  TL_DB_PER_STEP,
  VIB_DEPTH_CENTS,
  operatorFrequency,
} from './tables';
import type { AnyVoice, DrumNoise, FmVoice } from './voiceData';
import { TABLE_SIZE, WAVE_TABLES } from './waveforms';

const TWO_PI = 2 * Math.PI;

/** 1 音。FM 音色（4 オペレーター）か、ドラム（FM 部とノイズ部）を鳴らす */
export class Voice {
  private fm: FmVoice | null = null;
  private alg: Algorithm | null = null;
  private fmLevel = 1;
  private isDrum = false;
  private gainLeft = 0;
  private gainRight = 0;

  private readonly envelopes: Envelope[];
  private readonly phase = new Float64Array(4);
  private readonly increment = new Float64Array(4);
  private readonly staticDb = new Float64Array(4);
  private readonly feedbackGain = new Float64Array(4);
  private readonly feedbackPrev1 = new Float64Array(4);
  private readonly feedbackPrev2 = new Float64Array(4);
  private readonly outputs = new Float64Array(4);
  private tables: Float32Array[] = [];

  // 音程の降下（ドラム）：半音のずれ = pitchTo + pitchDiff、pitchDiff は毎サンプル pitchDecay 倍
  private pitchTo = 0;
  private pitchDiff = 0;
  private pitchDecay = 1;
  private hasPitch = false;

  // ノイズ部（ドラム）
  private noiseParams: DrumNoise | null = null;
  private readonly noise = new Noise();
  private readonly noiseEnvelope: Envelope;
  private repeatsLeft = 0;
  private repeatInterval = 0;
  private repeatCounter = 0;

  constructor(private readonly sampleRate: number) {
    this.envelopes = [0, 1, 2, 3].map(() => new Envelope(sampleRate));
    this.noiseEnvelope = new Envelope(sampleRate);
  }

  /** timbre を note の高さで、pan（0〜127）の位置に鳴らす。鳴っていた音は切る。ドラムは note を使わない */
  noteOn(timbre: AnyVoice, note: number, pan: number): void {
    this.stop();
    [this.gainLeft, this.gainRight] = panGains(pan);

    if (timbre.kind === 'fm') {
      this.isDrum = false;
      this.fmLevel = 1;
      this.hasPitch = false;
      this.noiseParams = null;
      this.startFm(timbre, note);
      return;
    }

    this.isDrum = true;
    this.fm = null;
    this.alg = null;
    if (timbre.fm) {
      this.fmLevel = timbre.fm.level;
      this.startFm(timbre.fm.voice, timbre.fm.note);
    }
    this.hasPitch = timbre.pitch !== undefined;
    if (timbre.pitch) {
      this.pitchTo = timbre.pitch.toSemitone;
      this.pitchDiff = timbre.pitch.fromSemitone - timbre.pitch.toSemitone;
      this.pitchDecay = Math.exp(-1000 / (timbre.pitch.decayMs * this.sampleRate));
    }
    this.noiseParams = timbre.noise ?? null;
    if (timbre.noise) {
      this.keyOnNoise();
      const repeat = timbre.noise.repeat;
      this.repeatsLeft = repeat ? repeat.count - 1 : 0;
      this.repeatInterval = repeat ? Math.max(1, Math.round((repeat.intervalMs * this.sampleRate) / 1000)) : 0;
      this.repeatCounter = 0;
    }
  }

  /** キーオフ。ドラムは無視して、エンベロープが尽きるまで鳴る */
  noteOff(): void {
    if (this.isDrum) return;
    for (const env of this.envelopes) env.keyOff();
  }

  /** すぐに無音にする（ボイスを奪うとき） */
  stop(): void {
    for (const env of this.envelopes) env.reset();
    this.noiseEnvelope.reset();
    this.repeatsLeft = 0;
  }

  /** 出力するオペレーターかノイズ部のどれかが鳴っていれば true */
  get active(): boolean {
    const alg = this.alg;
    if (alg && alg.carriers.some((c) => this.envelopes[c]!.phase !== 'off')) return true;
    return this.noiseEnvelope.phase !== 'off' || this.repeatsLeft > 0;
  }

  /** left/right の [from, to) に足し込む。lfo[s] はサンプル s の LFO 値（−1〜1） */
  render(left: Float32Array, right: Float32Array, from: number, to: number, lfo: Float32Array): void {
    if (!this.active) return;
    const gl = this.gainLeft;
    const gr = this.gainRight;
    for (let s = from; s < to; s++) {
      let value = this.alg ? this.sampleFm(lfo[s]!) * this.fmLevel : 0;
      if (this.noiseParams) value += this.sampleNoise(this.noiseParams);
      left[s] = left[s]! + value * gl;
      right[s] = right[s]! + value * gr;
    }
  }

  private startFm(voice: FmVoice, note: number): void {
    this.fm = voice;
    const alg = ALGORITHMS[voice.alg]!;
    this.alg = alg;
    const octavesAboveC4 = Math.max(0, (note - 60) / 12);
    this.tables = [];
    for (let i = 0; i < alg.opCount; i++) {
      const op = voice.ops[i]!;
      this.phase[i] = 0;
      this.feedbackPrev1[i] = 0;
      this.feedbackPrev2[i] = 0;
      this.increment[i] = operatorFrequency(note, voice.bo, op.mul, op.dt) / this.sampleRate;
      this.staticDb[i] = op.tl * TL_DB_PER_STEP + KSL_DB_PER_OCT[op.ksl]! * octavesAboveC4;
      this.feedbackGain[i] = alg.feedback.includes(i) ? FB_RAD[op.fb]! : 0;
      this.tables.push(WAVE_TABLES[op.wave]!);
      this.envelopes[i]!.keyOn(op, note);
    }
  }

  private keyOnNoise(): void {
    const n = this.noiseParams!;
    // SL に達した後は rr の速さで下がる（ドラムにはキーオフが来ないため）
    this.noiseEnvelope.keyOn({ ar: n.ar, dr: n.dr, sl: n.sl, sr: n.rr, rr: n.rr, ksr: 0, xof: 0 }, 60);
  }

  private sampleNoise(n: DrumNoise): number {
    // repeatCounter は直前にかけた時からのサンプル数
    if (this.repeatsLeft > 0 && this.repeatCounter >= this.repeatInterval) {
      this.repeatCounter = 0;
      this.repeatsLeft--;
      this.keyOnNoise();
    }
    this.repeatCounter++;
    const db = this.noiseEnvelope.next();
    if (db >= SILENT_DB) return 0;
    return this.noise.next() * 10 ** (-db / 20) * n.level * OUTPUT_GAIN;
  }

  private sampleFm(lfo: number): number {
    const voice = this.fm!;
    const alg = this.alg!;
    const outputs = this.outputs;
    let pitchRatio = 1;
    if (this.hasPitch) {
      pitchRatio = 2 ** ((this.pitchTo + this.pitchDiff) / 12);
      this.pitchDiff *= this.pitchDecay;
    }
    for (let i = 0; i < alg.opCount; i++) {
      const op = voice.ops[i]!;
      let db = this.envelopes[i]!.next() + this.staticDb[i]!;
      if (op.am) db += ((lfo + 1) / 2) * AM_DEPTH_DB[op.amDepth]!;

      let mod = 0;
      for (const m of alg.modulators[i]!) mod += outputs[m]!;
      mod *= MOD_INDEX;
      const fbGain = this.feedbackGain[i]!;
      if (fbGain > 0) mod += ((this.feedbackPrev1[i]! + this.feedbackPrev2[i]!) / 2) * fbGain;

      const pos = this.phase[i]! + mod / TWO_PI;
      const frac = pos - Math.floor(pos);
      const value = db >= SILENT_DB ? 0 : this.tables[i]![(frac * TABLE_SIZE) | 0]! * 10 ** (-db / 20);
      outputs[i] = value;
      if (fbGain > 0) {
        this.feedbackPrev2[i] = this.feedbackPrev1[i]!;
        this.feedbackPrev1[i] = value;
      }

      let inc = this.increment[i]! * pitchRatio;
      if (op.vib) inc *= 2 ** ((lfo * VIB_DEPTH_CENTS[op.vibDepth]!) / 1200);
      this.phase[i] = (this.phase[i]! + inc) % 1;
    }
    let mix = 0;
    for (const c of alg.carriers) mix += outputs[c]!;
    return mix * OUTPUT_GAIN;
  }
}
