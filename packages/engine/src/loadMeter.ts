/** 処理時間を測った時計。Worklet で performance.now() が使えないブラウザーでは Date.now() */
export type ClockKind = 'performance' | 'date';

/** 音声 1 秒分の集計 */
export interface LoadReport {
  /** 1 ブロックの処理時間の平均（ms） */
  avgMs: number;
  /** 1 ブロックの処理時間の最大（ms）。Date の時計では 1 ms 刻みで意味がないため null */
  maxMs: number | null;
  /** 1 ブロックの長さ（ms） */
  blockMs: number;
  /** blockMs に対する avgMs の割合（%） */
  percent: number;
  /** 鳴っていたボイス数の最大 */
  maxVoices: number;
  clock: ClockKind;
}

/** process 1 回ごとの処理時間を、音声 1 秒分ずつ集計する */
export class LoadMeter {
  private frames = 0;
  private blocks = 0;
  private totalMs = 0;
  private maxMs = 0;
  private maxVoices = 0;
  private blockFrames = 128;

  constructor(
    private readonly sampleRate: number,
    private readonly clock: ClockKind,
  ) {}

  /** 1 ブロック分を記録する。音声で 1 秒分たまったら集計を返して数え直す。そうでなければ null */
  record(elapsedMs: number, blockFrames: number, activeVoices: number): LoadReport | null {
    this.frames += blockFrames;
    this.blocks++;
    this.totalMs += elapsedMs;
    this.maxMs = Math.max(this.maxMs, elapsedMs);
    this.maxVoices = Math.max(this.maxVoices, activeVoices);
    this.blockFrames = blockFrames;
    if (this.frames < this.sampleRate) return null;

    const avgMs = this.totalMs / this.blocks;
    const blockMs = (this.blockFrames / this.sampleRate) * 1000;
    const report: LoadReport = {
      avgMs,
      maxMs: this.clock === 'performance' ? this.maxMs : null,
      blockMs,
      percent: (avgMs / blockMs) * 100,
      maxVoices: this.maxVoices,
      clock: this.clock,
    };
    this.reset();
    return report;
  }

  /** 途中までの集計を捨てる（計測をオンにし直したとき） */
  reset(): void {
    this.frames = 0;
    this.blocks = 0;
    this.totalMs = 0;
    this.maxMs = 0;
    this.maxVoices = 0;
  }
}
