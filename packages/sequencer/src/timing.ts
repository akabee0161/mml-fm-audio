import { TICKS_PER_QUARTER } from './song.ts';
import type { Song, Tempo } from './song.ts';

/** 曲の頭（tick 0）から tick までの秒。テンポの区切りごとに足し、丸めない */
export function tickToSeconds(tempos: readonly Tempo[], tick: number): number {
  let seconds = 0;
  for (let i = 0; i < tempos.length && tempos[i].tick < tick; i++) {
    const end = i + 1 < tempos.length ? Math.min(tempos[i + 1].tick, tick) : tick;
    seconds += ((end - tempos[i].tick) * 60) / (TICKS_PER_QUARTER * tempos[i].bpm);
  }
  return seconds;
}

export class Timeline {
  private readonly tempos: readonly Tempo[];
  private readonly loopStart: number | null;
  private readonly loopEnd: number;
  private readonly startSeconds: number;
  private readonly endSeconds: number;

  constructor(song: Pick<Song, 'tempos' | 'loopStart' | 'loopEnd'>) {
    if (song.loopStart !== null && song.loopEnd <= song.loopStart) {
      throw new RangeError(`ループの終了(${song.loopEnd})が開始(${song.loopStart})以前です`);
    }
    this.tempos = song.tempos;
    this.loopStart = song.loopStart;
    this.loopEnd = song.loopEnd;
    this.startSeconds = song.loopStart === null ? 0 : tickToSeconds(song.tempos, song.loopStart);
    this.endSeconds = tickToSeconds(song.tempos, song.loopEnd);
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
      return tickToSeconds(this.tempos, tick);
    }
    if (pass >= 1 && tick < loopStart) {
      throw new RangeError(`pass ${pass} の tick(${tick}) は loopStart(${loopStart}) 以上です`);
    }
    while (tick >= this.loopEnd) {
      pass += 1;
      tick = loopStart + (tick - this.loopEnd);
    }
    if (pass === 0) return tickToSeconds(this.tempos, tick);
    return this.endSeconds + (pass - 1) * (this.endSeconds - this.startSeconds)
      + tickToSeconds(this.tempos, tick) - this.startSeconds;
  }
}
