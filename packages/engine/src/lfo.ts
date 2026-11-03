import { LFO_HZ } from './tables';

/** ボイスごとの LFO（三角波） */
export class Lfo {
  private phase = 0;
  private increment = 0;

  constructor(private readonly sampleRate: number) {
    this.setRate(0);
  }

  setRate(index: number): void {
    this.increment = LFO_HZ[index]! / this.sampleRate; // index は validateVoice で検査済み
  }

  /** 位相を 0 に戻す（次の値は -1） */
  reset(): void {
    this.phase = 0;
  }

  /** 今の値（-1〜1）を返してから 1 サンプル進める */
  next(): number {
    const p = this.phase;
    const value = p < 0.5 ? 4 * p - 1 : 3 - 4 * p;
    this.phase = (p + this.increment) % 1;
    return value;
  }
}
