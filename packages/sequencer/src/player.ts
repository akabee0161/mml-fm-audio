import type { Song } from './song.ts';
import { Timeline } from './timing.ts';

/** Player が音源に求める操作。FmEngine（packages/engine）がこれを満たす。engine は import しない */
export interface EngineLike {
  noteOn(program: number, note: number, options: { pan: number; time: number; volume: number; bend: number }): number;
  noteOff(id: number, time: number): void;
  setPitchBend(id: number, cents: number, time: number): void;
  setVolume(id: number, volume: number, time: number): void;
  cancel(ids: readonly number[]): void;
}

/** v を 1 段下げるごとの減衰（dB）。暫定 */
export const VOLUME_DB_PER_STEP = 3;

/** v（0〜15）→ 倍率。15 で 1、0 で 0 */
export function volumeGain(v: number): number {
  if (v <= 0) return 0;
  return 10 ** (-((15 - v) * VOLUME_DB_PER_STEP) / 20);
}

export interface PlayerOptions {
  sampleRate: number;
  /** 曲の頭のサンプル番号 */
  startFrame: number;
}

/** 送るノート 1 つの状態 */
interface NoteState {
  id: number | null;
  /** ノートオンを遅れで捨てた */
  dropped: boolean;
  offFrame: number;
}

type Action =
  | { kind: 'off'; frame: number; track: number; seq: number; note: NoteState }
  | { kind: 'bend'; frame: number; track: number; seq: number; note: NoteState; cents: number }
  | { kind: 'volume'; frame: number; track: number; seq: number; note: NoteState; gain: number }
  | {
      kind: 'on'; frame: number; track: number; seq: number; note: NoteState;
      program: number; pitch: number; pan: number; gain: number; bend: number;
    };

/** 同じ時刻の順：ノートオフ → setPitchBend・setVolume → ノートオン */
const PRIORITY = { off: 0, bend: 1, volume: 1, on: 2 } as const;

function compare(a: Action, b: Action): number {
  return a.frame - b.frame || PRIORITY[a.kind] - PRIORITY[b.kind] || a.track - b.track || a.seq - b.seq;
}

export class Player {
  private readonly timeline: Timeline;
  private readonly loopStart: number | null;
  private readonly loopEnd: number;
  /** 時刻順の待ち行列。先頭から送る */
  private queue: Action[] = [];
  private sent: NoteState[] = [];
  private nextPass = 0;
  private seq = 0;
  private lastNowFrame = 0;
  private generationDone = false;
  private stopped = false;

  constructor(
    private readonly engine: EngineLike,
    private readonly song: Song,
    private readonly options: PlayerOptions,
  ) {
    if (song.errors.length > 0) {
      const e = song.errors[0];
      throw new Error(`エラーのある曲は再生できません（${song.errors.length} 件。最初：${e.line} 行 ${e.column} 列 ${e.message}）`);
    }
    this.timeline = new Timeline(song);
    this.loopStart = song.loopStart;
    this.loopEnd = song.loopEnd;
  }

  /** 時刻が horizonFrame より前のイベントを送る。nowFrame より前のノートオンは送らずに捨てる */
  pump(nowFrame: number, horizonFrame: number): void {
    if (this.stopped) return;
    this.lastNowFrame = nowFrame;
    while (!this.generationDone && this.passStartFrame(this.nextPass) < horizonFrame) this.generatePass();
    let i = 0;
    for (; i < this.queue.length && this.queue[i].frame < horizonFrame; i++) this.send(this.queue[i], nowFrame);
    this.queue.splice(0, i);
  }

  /** 送ったノートのうち、ノートオフの時刻が過ぎていないものを cancel し、以後は何も送らない */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    const ids = this.sent
      .filter((n) => n.id !== null && n.offFrame >= this.lastNowFrame)
      .map((n) => n.id as number);
    this.queue = [];
    this.sent = [];
    if (ids.length > 0) this.engine.cancel(ids);
  }

  /** ループしない曲で、最後のノートオフまで送り終えたら true */
  get finished(): boolean {
    return !this.stopped && this.loopStart === null && this.generationDone && this.queue.length === 0;
  }

  private frame(pass: number, tick: number): number {
    return this.options.startFrame + this.timeline.seconds(pass, tick) * this.options.sampleRate;
  }

  private passStartFrame(pass: number): number {
    return this.frame(pass, pass === 0 ? 0 : (this.loopStart as number));
  }

  /** nextPass 回目のイベントを待ち行列に入れる */
  private generatePass(): void {
    const pass = this.nextPass++;
    const looping = this.loopStart !== null;
    // pass 1 以降は loopStart 未満のイベントを送らない（L の前から持続中のノートを鳴らし直さない）
    const from = pass === 0 ? 0 : (this.loopStart as number);
    const to = looping ? this.loopEnd : Infinity;
    const added: Action[] = [];

    this.song.tracks.forEach((track, t) => {
      // 各回の始めで最後のノートを忘れる
      let last: NoteState | null = null;
      for (const ev of track.events) {
        if (ev.tick < from || ev.tick >= to) continue;
        if (ev.type === 'note') {
          const note: NoteState = { id: null, dropped: false, offFrame: this.frame(pass, ev.tick + ev.gate) };
          last = note;
          added.push({
            kind: 'on', frame: this.frame(pass, ev.tick), track: t, seq: this.seq++, note,
            program: ev.program, pitch: ev.note, pan: ev.pan, gain: volumeGain(ev.volume), bend: ev.bend,
          });
          added.push({ kind: 'off', frame: note.offFrame, track: t, seq: this.seq++, note });
        } else if (last !== null) {
          const frame = this.frame(pass, ev.tick);
          added.push(ev.type === 'bend'
            ? { kind: 'bend', frame, track: t, seq: this.seq++, note: last, cents: ev.cents }
            : { kind: 'volume', frame, track: t, seq: this.seq++, note: last, gain: volumeGain(ev.volume) });
        }
      }
    });

    if (!looping) this.generationDone = true;
    this.queue.push(...added);
    this.queue.sort(compare);
  }

  private send(a: Action, nowFrame: number): void {
    if (a.kind === 'on') {
      if (a.frame < nowFrame) {
        a.note.dropped = true;
        return;
      }
      a.note.id = this.engine.noteOn(a.program, a.pitch, { pan: a.pan, time: a.frame, volume: a.gain, bend: a.bend });
      this.sent.push(a.note);
      return;
    }
    if (a.note.dropped || a.note.id === null) return;
    if (a.kind === 'off') this.engine.noteOff(a.note.id, a.frame);
    else if (a.kind === 'bend') this.engine.setPitchBend(a.note.id, a.cents, a.frame);
    else this.engine.setVolume(a.note.id, a.gain, a.frame);
  }
}
