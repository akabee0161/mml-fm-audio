import { ALGORITHMS } from './algorithms';
import { Envelope } from './envelope';
import type { Lfo } from './lfo';
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
import type { FmVoice } from './voiceData';
import { TABLE_SIZE, WAVE_TABLES } from './waveforms';

const TWO_PI = 2 * Math.PI;

/** 4 オペレーター FM の 1 ボイス */
export class Voice {
  private voice: FmVoice | null = null;
  private readonly envelopes: Envelope[];
  private readonly phase = new Float64Array(4);
  private readonly increment = new Float64Array(4);
  private readonly staticDb = new Float64Array(4);
  private readonly feedbackGain = new Float64Array(4);
  private readonly feedbackPrev1 = new Float64Array(4);
  private readonly feedbackPrev2 = new Float64Array(4);
  private readonly outputs = new Float64Array(4);
  private tables: Float32Array[] = [];

  constructor(private readonly sampleRate: number) {
    this.envelopes = [0, 1, 2, 3].map(() => new Envelope(sampleRate));
  }

  /** 音色を差し替える。鳴っている音は止める */
  setVoice(voice: FmVoice): void {
    this.voice = voice;
    for (const env of this.envelopes) env.reset();
  }

  noteOn(note: number): void {
    const voice = this.voice;
    if (!voice) return;
    const alg = ALGORITHMS[voice.alg]!;
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

  noteOff(): void {
    for (const env of this.envelopes) env.keyOff();
  }

  /** 出力するオペレーターのどれかが鳴っていれば true */
  get active(): boolean {
    const voice = this.voice;
    if (!voice) return false;
    return ALGORITHMS[voice.alg]!.carriers.some((c) => this.envelopes[c]!.phase !== 'off');
  }

  /** out[from]〜out[to - 1] に書く。LFO は鳴っていなくても進める */
  render(out: Float32Array, from: number, to: number, lfo: Lfo): void {
    const active = this.active;
    for (let s = from; s < to; s++) {
      const l = lfo.next();
      out[s] = active ? this.sample(l) : 0;
    }
  }

  private sample(lfo: number): number {
    const voice = this.voice!;
    const alg = ALGORITHMS[voice.alg]!;
    const outputs = this.outputs;
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

      let inc = this.increment[i]!;
      if (op.vib) inc *= 2 ** ((lfo * VIB_DEPTH_CENTS[op.vibDepth]!) / 1200);
      this.phase[i] = (this.phase[i]! + inc) % 1;
    }
    let mix = 0;
    for (const c of alg.carriers) mix += outputs[c]!;
    return mix * OUTPUT_GAIN;
  }
}
