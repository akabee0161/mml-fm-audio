import { TICKS_PER_QUARTER } from './song.ts';
import type { Song, Tempo } from './song.ts';

function segmentSeconds(ticks: number, bpm: number): number {
  return (ticks * 60) / (TICKS_PER_QUARTER * bpm);
}

/** tempos[i] の区間の始まりまでの秒（i 番目より前の区間を順に足したもの）。tempos は tick の順 */
function cumulativeSeconds(tempos: readonly Tempo[]): number[] {
  const cumulative: number[] = [];
  let seconds = 0;
  for (let i = 0; i < tempos.length; i++) {
    cumulative.push(seconds);
    if (i + 1 < tempos.length) seconds += segmentSeconds(tempos[i + 1].tick - tempos[i].tick, tempos[i].bpm);
  }
  return cumulative;
}

/** tick より前で最後に始まるテンポ区間の添字（tempos[i].tick < tick を満たす最大の i）。なければ -1 */
function segmentBefore(tempos: readonly Tempo[], tick: number): number {
  let lo = 0;
  let hi = tempos.length; // tempos[0..lo) は tick 未満、tempos[hi..) は tick 以上
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tempos[mid].tick < tick) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** 曲の頭（tick 0）から tick までの秒。テンポの区切りごとに足し、丸めない */
export function tickToSeconds(tempos: readonly Tempo[], tick: number): number {
  return secondsAt(tempos, cumulativeSeconds(tempos), tick);
}

function secondsAt(tempos: readonly Tempo[], cumulative: readonly number[], tick: number): number {
  const i = segmentBefore(tempos, tick);
  if (i < 0) return 0;
  return cumulative[i] + segmentSeconds(tick - tempos[i].tick, tempos[i].bpm);
}

export class Timeline {
  private readonly tempos: readonly Tempo[];
  /** 区間ごとの始まりまでの秒。構築時に一度だけ計算する */
  private readonly cumulative: readonly number[];
  private readonly loopStart: number | null;
  private readonly loopEnd: number;
  private readonly startSeconds: number;
  private readonly endSeconds: number;

  constructor(song: Pick<Song, 'tempos' | 'loopStart' | 'loopEnd'>) {
    if (song.loopStart !== null && song.loopEnd <= song.loopStart) {
      throw new RangeError(`ループの終了(${song.loopEnd})が開始(${song.loopStart})以前です`);
    }
    this.tempos = song.tempos;
    this.cumulative = cumulativeSeconds(song.tempos);
    this.loopStart = song.loopStart;
    this.loopEnd = song.loopEnd;
    this.startSeconds = song.loopStart === null ? 0 : this.at(song.loopStart);
    this.endSeconds = this.at(song.loopEnd);
  }

  private at(tick: number): number {
    return secondsAt(this.tempos, this.cumulative, tick);
  }
  /**
   * pass 回目（0 から）の tick の、再生開始からの秒。pass 0 は tick 0 から、pass 1 以降は loopStart から始まる。
   * ループする曲で tick ≥ loopEnd なら、次の回の loopStart + (tick − loopEnd) として計算する（ループ終了を越えるノートのノートオフ用）
   */
  seconds(pass: number, tick: number): number {
    if (!Number.isInteger(pass) || pass < 0) throw new RangeError(`pass は 0 以上の整数です: ${pass}`);
    const loopStart = this.loopStart;
    if (loopStart === null) {
      if (pass !== 0) throw new RangeError(`ループしない曲の pass は 0 だけです: ${pass}`);
      return this.at(tick);
    }
    if (pass >= 1 && tick < loopStart) {
      throw new RangeError(`pass ${pass} の tick(${tick}) は loopStart(${loopStart}) 以上です`);
    }
    while (tick >= this.loopEnd) {
      pass += 1;
      tick = loopStart + (tick - this.loopEnd);
    }
    if (pass === 0) return this.at(tick);
    return this.endSeconds + (pass - 1) * (this.endSeconds - this.startSeconds)
      + this.at(tick) - this.startSeconds;
  }
}
