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
  /** ノートオンの時刻（曲の時刻） */
  onFrame: number;
  offFrame: number;
  /** ノートオフを音源へ送った */
  offSent: boolean;
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

/** tick が指定以上の最初のイベントの添字（なければ events.length）。events は tick の順 */
function firstIndexAtOrAfter(events: readonly { tick: number }[], tick: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid]!.tick < tick) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** compare の順に取り出せる二分ヒープ */
class ActionHeap {
  private readonly items: Action[] = [];

  get size(): number {
    return this.items.length;
  }

  peek(): Action | undefined {
    return this.items[0];
  }

  push(a: Action): void {
    const items = this.items;
    let i = items.length;
    items.push(a);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const p = items[parent]!;
      if (compare(p, a) <= 0) break;
      items[i] = p;
      i = parent;
    }
    items[i] = a;
  }

  pop(): Action | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (last === undefined || items.length === 0) return top;
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= items.length) break;
      if (child + 1 < items.length && compare(items[child + 1]!, items[child]!) < 0) child++;
      const c = items[child]!;
      if (compare(c, last) >= 0) break;
      items[i] = c;
      i = child;
    }
    items[i] = last;
    return top;
  }

  clear(): void {
    this.items.length = 0;
  }
}

/** トラックごとの読み位置。events のどこまでをアクションにしたか */
interface TrackCursor {
  /** 何周目か */
  pass: number;
  /** 次に読む events の添字 */
  index: number;
  /** この周で最後にノートオンしたノート（v・B の対象）。周の頭で忘れる */
  last: NoteState | null;
  /** pass 1 以降の読み始めの添字（tick が loopStart 以上の最初のイベント） */
  loopIndex: number;
  /** ループしない曲で、最後のイベントまで読んだ */
  done: boolean;
}

export class Player {
  private readonly engine: EngineLike;
  private readonly song: Song;
  private readonly options: PlayerOptions;
  private readonly timeline: Timeline;
  private readonly loopStart: number | null;
  private readonly loopEnd: number;
  /** 作ったが送っていないアクション。時刻順に取り出す */
  private readonly queue = new ActionHeap();
  private readonly cursors: TrackCursor[];
  /** 音源へ送ったノート（ノートオフが過ぎていないもの） */
  private sent: NoteState[] = [];
  /** 音源へ送ったアクションのうち、時刻が現在以降のもの（先読みの範囲の分）。pause でヒープへ戻す */
  private inflight: Action[] = [];
  private seq = 0;
  /** 直近の pump の nowFrame（曲の時刻） */
  private lastNowFrame = 0;
  private stopped = false;
  /** 一時停止で止めていた合計のフレーム数。アクションの時刻は曲の時刻のまま持ち、音源へ送るときに足す */
  private shift = 0;
  /** 一時停止中なら、pause に渡された nowFrame（そのままの値） */
  private pausedAt: number | null = null;

  constructor(engine: EngineLike, song: Song, options: PlayerOptions) {
    if (song.errors.length > 0) {
      const e = song.errors[0]!;
      throw new Error(`エラーのある曲は再生できません（${song.errors.length} 件。最初：${e.line} 行 ${e.column} 列 ${e.message}）`);
    }
    this.engine = engine;
    this.song = song;
    this.options = options;
    this.timeline = new Timeline(song);
    this.loopStart = song.loopStart;
    this.loopEnd = song.loopEnd;
    this.cursors = song.tracks.map((track) => ({
      pass: 0,
      index: 0,
      last: null,
      loopIndex: song.loopStart === null ? 0 : firstIndexAtOrAfter(track.events, song.loopStart),
      done: false,
    }));
  }

  /** 時刻が horizonFrame より前のイベントを送る。nowFrame より前のノートオンは送らずに捨てる */
  pump(nowFrame: number, horizonFrame: number): void {
    if (this.stopped || this.pausedAt !== null) return;
    nowFrame -= this.shift;
    horizonFrame -= this.shift;
    this.lastNowFrame = nowFrame;
    this.song.tracks.forEach((_, t) => this.generate(t, horizonFrame));
    for (let a = this.queue.peek(); a !== undefined && a.frame < horizonFrame; a = this.queue.peek()) {
      this.queue.pop();
      this.send(a, nowFrame);
    }
    let keptActions = 0;
    for (const a of this.inflight) if (a.frame >= nowFrame) this.inflight[keptActions++] = a;
    this.inflight.length = keptActions;
    // ノートオフが過ぎたノートは stop() でも cancel しない（offFrame >= lastNowFrame だけが対象）ので捨てる。
    // nowFrame は pump ごとに減らない（時刻が戻らない）前提
    let kept = 0;
    for (const n of this.sent) if (n.offFrame >= nowFrame) this.sent[kept++] = n;
    this.sent.length = kept;
  }

  /**
   * 送ったノートのうち、ノートオフの時刻が過ぎていないものを cancel し、以後は何も送らない。
   * 一時停止中は pause がすでに cancel しているので、重ねて cancel しない
   */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    const ids = this.cancelableIds();
    this.queue.clear();
    this.sent = [];
    this.inflight = [];
    if (ids.length > 0) this.engine.cancel(ids);
  }

  get paused(): boolean {
    return this.pausedAt !== null;
  }

  /**
   * nowFrame の時点で止める。送り済みのノートのうち、ノートオフが nowFrame 以降のものは cancel する。
   * ノートオンが nowFrame より前のノートは再開後も鳴らし直さず、nowFrame 以降のノートは再開後に送り直す。
   * ノートオフが nowFrame より前で、まだ送っていないノートは、cancel せずに本来の時刻でノートオフを送る（ノートオフ送り済みのノートと同じく、その時刻まで鳴る）。
   * 一時停止中・停止後は何もしない。nowFrame が有限の数でなければ RangeError
   */
  pause(nowFrame: number): void {
    if (!Number.isFinite(nowFrame)) throw new RangeError(`pause: nowFrame は有限の数にしてください（nowFrame=${nowFrame}）`);
    if (this.stopped || this.pausedAt !== null) return;
    this.pausedAt = nowFrame;
    const songNow = nowFrame - this.shift;
    // 直近の pump より前の時刻を渡されても、cancel の対象（ノートオフが過ぎていないもの）を広げない
    this.lastNowFrame = Math.max(this.lastNowFrame, songNow);
    const ids = this.cancelableIds();
    for (const n of this.sent) {
      // ノートオフが一時停止の時刻より前で、まだ送っていないノートは、本来の時刻でノートオフを送る
      // （cancel しない。ヒープに残るノートオフは dropped のため再開後に捨てられ、送られないままになるのを防ぐ）
      if (n.id !== null && !n.offSent && n.offFrame < this.lastNowFrame) {
        this.engine.noteOff(n.id, n.offFrame + this.shift);
        n.offSent = true;
      }
      if (n.onFrame < songNow) n.dropped = true;
      else n.id = null;
    }
    this.sent = [];
    for (const a of this.inflight) if (a.frame >= songNow) this.queue.push(a);
    this.inflight = [];
    if (ids.length > 0) this.engine.cancel(ids);
  }

  /**
   * 一時停止した位置から続ける。以後のすべての時刻を、止めていた分だけ後ろへずらす。一時停止していなければ何もしない。
   * nowFrame が有限の数でない、または一時停止した時刻より前なら RangeError（状態は変えない）
   */
  resume(nowFrame: number): void {
    if (!Number.isFinite(nowFrame)) throw new RangeError(`resume: nowFrame は有限の数にしてください（nowFrame=${nowFrame}）`);
    if (this.pausedAt === null) return;
    if (nowFrame < this.pausedAt) {
      throw new RangeError(`resume: nowFrame は一時停止した時刻 ${this.pausedAt} 以降にしてください（nowFrame=${nowFrame}）`);
    }
    this.shift += nowFrame - this.pausedAt;
    this.pausedAt = null;
  }

  /** pass 回目（1 以上）の周の頭（L の位置）が鳴る時刻。再開済みの一時停止のずれを含む。一時停止中は今回の停止の分を含まず、resume の後に増える */
  loopFrame(pass: number): number {
    if (this.loopStart === null) throw new RangeError('ループしない曲に loopFrame は使えません');
    if (!Number.isInteger(pass) || pass < 1) throw new RangeError(`pass は 1 以上の整数です（${pass}）`);
    return this.passStartFrame(pass) + this.shift;
  }

  /** ループしない曲の終わり（song.length）が鳴る時刻。ループする曲では null。一時停止中は今回の停止の分を含まず、resume の後に増える（loopFrame と同じ） */
  get endFrame(): number | null {
    if (this.loopStart !== null) return null;
    return this.frame(0, this.song.length) + this.shift;
  }

  /** ループしない曲で、最後のノートオフまで送り終えたら true */
  get finished(): boolean {
    return !this.stopped && this.loopStart === null && this.cursors.every((c) => c.done) && this.queue.size === 0;
  }

  /** テスト用。作ったがまだ送っていないアクションの数 */
  get pendingCount(): number {
    return this.queue.size;
  }

  private cancelableIds(): number[] {
    return this.sent
      .filter((n) => n.id !== null && n.offFrame >= this.lastNowFrame)
      .map((n) => n.id as number);
  }

  private frame(pass: number, tick: number): number {
    return this.options.startFrame + this.timeline.seconds(pass, tick) * this.options.sampleRate;
  }

  private passStartFrame(pass: number): number {
    return this.frame(pass, pass === 0 ? 0 : (this.loopStart as number));
  }

  /** トラック t の、時刻が horizonFrame より前のイベントをアクションにして待ち行列に入れる */
  private generate(t: number, horizonFrame: number): void {
    const cursor = this.cursors[t]!;
    const events = this.song.tracks[t]!.events;
    const loopStart = this.loopStart;
    while (!cursor.done) {
      if (cursor.index >= events.length || (loopStart !== null && events[cursor.index]!.tick >= this.loopEnd)) {
        // 周の終わり。ループしない曲はここで終わり、ループする曲は次の周の loopStart 以上の最初のイベントへ移る。
        // pass 1 以降は loopStart 未満のイベントを送らない（L の前から持続中のノートを鳴らし直さない）
        if (loopStart === null) {
          cursor.done = true;
          return;
        }
        cursor.pass++;
        cursor.index = cursor.loopIndex;
        cursor.last = null;
        // イベントのない周が続いても止まらないよう、周の頭が先読みの外なら止める
        if (this.passStartFrame(cursor.pass) >= horizonFrame) return;
        continue;
      }
      const ev = events[cursor.index]!; // 上で index < events.length を確かめた
      const frame = this.frame(cursor.pass, ev.tick);
      if (frame >= horizonFrame) return;
      cursor.index++;
      if (ev.type === 'note') {
        const note: NoteState = { id: null, dropped: false, onFrame: frame, offFrame: this.frame(cursor.pass, ev.tick + ev.gate), offSent: false };
        cursor.last = note;
        this.queue.push({
          kind: 'on', frame, track: t, seq: this.seq++, note,
          program: ev.program, pitch: ev.note, pan: ev.pan, gain: volumeGain(ev.volume), bend: ev.bend,
        });
        this.queue.push({ kind: 'off', frame: note.offFrame, track: t, seq: this.seq++, note });
      } else if (cursor.last !== null) {
        this.queue.push(ev.type === 'bend'
          ? { kind: 'bend', frame, track: t, seq: this.seq++, note: cursor.last, cents: ev.cents }
          : { kind: 'volume', frame, track: t, seq: this.seq++, note: cursor.last, gain: volumeGain(ev.volume) });
      }
    }
  }

  private send(a: Action, nowFrame: number): void {
    if (a.kind === 'on') {
      if (a.frame < nowFrame) {
        a.note.dropped = true;
        return;
      }
      a.note.id = this.engine.noteOn(a.program, a.pitch, { pan: a.pan, time: a.frame + this.shift, volume: a.gain, bend: a.bend });
      this.sent.push(a.note);
      this.inflight.push(a);
      return;
    }
    if (a.note.dropped || a.note.id === null) return;
    const time = a.frame + this.shift;
    if (a.kind === 'off') {
      this.engine.noteOff(a.note.id, time);
      a.note.offSent = true;
    }
    else if (a.kind === 'bend') this.engine.setPitchBend(a.note.id, a.cents, time);
    else this.engine.setVolume(a.note.id, a.gain, time);
    this.inflight.push(a);
  }
}
