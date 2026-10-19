import { SILENT_DB, SL_DB_PER_STEP } from './tables';
import type { FmOperator } from './voiceData';

export type EnvelopePhase = 'attack' | 'decay' | 'sustain' | 'release' | 'off';

/** レート 15 の減衰速度（暫定） */
const RATE15_DB_PER_SEC = 16000;
/** アタックは同じレートのディケイより何倍速いか（暫定） */
const ATTACK_SPEEDUP = 8;
/** アタックを終えたとみなす減衰量 */
const ATTACK_END_DB = 0.1;

/** レート（0〜15、小数可）→ 1 秒あたりに下がる dB。0 は変化しない */
export function decayDbPerSec(rate: number): number {
  return rate <= 0 ? 0 : RATE15_DB_PER_SEC * 2 ** (rate - 15);
}

/** アタックにかかる秒数。15 は 0、0 は鳴り始めない */
export function attackSeconds(rate: number): number {
  if (rate <= 0) return Infinity;
  if (rate >= 15) return 0;
  return SILENT_DB / decayDbPerSec(rate) / ATTACK_SPEEDUP;
}

/** KSR を反映した実効レート。ノート 60 より上は 2 オクターブごとに 1 上げる */
export function effectiveRate(rate: number, ksr: number, note: number): number {
  if (rate === 0) return 0;
  const offset = ksr ? Math.max(0, note - 60) / 24 : 0;
  return Math.min(15, rate + offset);
}

export class Envelope {
  phase: EnvelopePhase = 'off';
  attenuation = SILENT_DB;

  private attackFactor = 1;
  private decayStep = 0;
  private sustainStep = 0;
  private releaseStep = 0;
  private sustainLevel = 0;
  private ignoreKeyOff = false;

  constructor(private readonly sampleRate: number) {}

  keyOn(op: FmOperator, note: number): void {
    const rate = (r: number) => effectiveRate(r, op.ksr, note);
    const perSample = (r: number) => decayDbPerSec(rate(r)) / this.sampleRate;

    const attack = attackSeconds(rate(op.ar));
    this.attackFactor =
      attack === Infinity ? 1 : attack === 0 ? 0 : Math.exp(Math.log(ATTACK_END_DB / SILENT_DB) / (attack * this.sampleRate));
    this.decayStep = perSample(op.dr);
    this.sustainStep = perSample(op.sr);
    this.releaseStep = perSample(op.rr);
    this.sustainLevel = op.sl >= 15 ? SILENT_DB : op.sl * SL_DB_PER_STEP;
    this.ignoreKeyOff = op.xof === 1;

    this.phase = 'attack';
    if (this.attackFactor === 0) {
      this.attenuation = 0;
      this.phase = 'decay';
    }
  }

  keyOff(): void {
    if (this.ignoreKeyOff || this.phase === 'off') return;
    this.phase = 'release';
  }

  reset(): void {
    this.phase = 'off';
    this.attenuation = SILENT_DB;
  }

  /** 1 サンプル進め、減衰量（dB）を返す */
  next(): number {
    switch (this.phase) {
      case 'attack':
        this.attenuation *= this.attackFactor;
        if (this.attenuation <= ATTACK_END_DB) {
          this.attenuation = 0;
          this.phase = 'decay';
        }
        return this.attenuation;
      case 'decay':
        this.attenuation += this.decayStep;
        if (this.attenuation >= this.sustainLevel) {
          this.attenuation = this.sustainLevel;
          this.phase = 'sustain';
        }
        break;
      case 'sustain':
        this.attenuation += this.sustainStep;
        break;
      case 'release':
        this.attenuation += this.releaseStep;
        break;
      case 'off':
        return SILENT_DB;
    }
    if (this.attenuation >= SILENT_DB) {
      this.attenuation = SILENT_DB;
      this.phase = 'off';
    }
    return this.attenuation;
  }
}
