import { SILENT_DB, SL_DB_PER_STEP } from './tables';
import type { FmOperator } from './voiceData';

/** エンベロープに要る項目。FM のオペレーターのほか、ドラムのノイズ部からも渡す */
export type EnvelopeParams = Pick<FmOperator, 'ar' | 'dr' | 'sl' | 'sr' | 'rr' | 'ksr' | 'xof'>;

export type EnvelopePhase = 'attack' | 'decay' | 'sustain' | 'release' | 'off';

/** レート（0〜15）・KSR・キーコードからレートの番号（0〜63）を求める。レート 0 は 0 のまま */
export function rateIndex(rate: number, ksr: number, kc: number): number {
  if (rate === 0) return 0;
  return Math.min(63, 4 * rate + (ksr ? kc >> 1 : kc >> 3));
}

/** レートの番号 → 1 秒あたりに下がる dB。0 は変化しない */
export function decayDbPerSec(idx: number): number {
  if (idx === 0) return 0;
  return 36600 * (1 + (idx & 3) / 4) * 2 ** ((idx >> 2) - 15);
}

/** レートの番号 → アタックにかかる秒数。0 は鳴り始めない、60 以上は一瞬 */
export function attackSeconds(idx: number): number {
  if (idx === 0) return Infinity;
  if (idx >= 60) return 0;
  return 6.17 / ((1 + (idx & 3) / 4) * 2 ** (idx >> 2));
}

export class Envelope {
  phase: EnvelopePhase = 'off';
  attenuation = SILENT_DB;

  /** アタック中の振幅（0〜1）。時間に比例して上がる */
  private amp = 0;
  private attackStep = 0;
  private decayStep = 0;
  private sustainStep = 0;
  private releaseStep = 0;
  private sustainLevel = 0;
  private ignoreKeyOff = false;

  constructor(private readonly sampleRate: number) {}

  /** kc はキーコード（0〜31。tables.ts の keyCode） */
  keyOn(op: EnvelopeParams, kc: number): void {
    const sr = this.sampleRate;
    const seconds = attackSeconds(rateIndex(op.ar, op.ksr, kc));
    this.attackStep = seconds === Infinity ? 0 : 1 / (seconds * sr);
    this.decayStep = decayDbPerSec(rateIndex(op.dr, op.ksr, kc)) / sr;
    this.sustainStep = decayDbPerSec(rateIndex(op.sr, op.ksr, kc)) / sr;
    this.releaseStep = decayDbPerSec(rateIndex(op.rr, op.ksr, kc)) / sr;
    this.sustainLevel = op.sl >= 15 ? SILENT_DB : op.sl * SL_DB_PER_STEP;
    this.ignoreKeyOff = op.xof === 1;

    this.amp = this.attenuation >= SILENT_DB ? 0 : 10 ** (-this.attenuation / 20);
    this.phase = 'attack';
    if (seconds === 0) {
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
        this.amp += this.attackStep;
        if (this.amp >= 1) {
          this.attenuation = 0;
          this.phase = 'decay';
        } else {
          this.attenuation = this.amp > 0 ? Math.min(SILENT_DB, -20 * Math.log10(this.amp)) : SILENT_DB;
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
