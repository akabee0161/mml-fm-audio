import { TICKS_PER_QUARTER } from '../../sequencer/src/index.ts';
import { ConvError } from './errors.ts';
import type { ChannelControl, ControlKind } from './extract.ts';
import type { PlannedTrack } from './allocate.ts';
import type { LoopRange } from './loop.ts';
import type { Meter } from './meter.ts';
import type { Quantized } from './quantize.ts';
import { toMmlVolume } from './volume.ts';

// GM の初期値（SMF に値がないとき）
const DEFAULT_TEMPO = 120;
const DEFAULT_VOLUME = 100;
const DEFAULT_EXPRESSION = 127;
// MML の既定（トラックの最初の状態）
const MML_PROGRAM = 0;
const MML_PAN = 64;
const MML_VOLUME = 12;
const MML_OCTAVE = 4;
const MAX_BEND_CENTS = 1200;
const MIN_BPM = 1;
const MAX_BPM = 999;
/** 1 行の目安の長さ。超えたら同じトラック名の行を改める */
const LINE_WIDTH = 100;

const NOTE_NAMES = ['c', 'c+', 'd', 'd+', 'e', 'f', 'f+', 'g', 'g+', 'a', 'a+', 'b'];

/** ティック → 音長の書き方。付点は 1 つまで。同じ長さになるものは付点なしを優先 */
const DURATIONS = new Map<number, string>();
for (const dotted of [false, true]) {
  for (const n of [1, 2, 4, 8, 16, 32, 3, 6, 12, 24, 48]) {
    const ticks = (TICKS_PER_QUARTER * 4) / n;
    const value = dotted ? ticks * 1.5 : ticks;
    if (Number.isInteger(value) && !DURATIONS.has(value)) DURATIONS.set(value, dotted ? `${n}.` : String(n));
  }
}
const duration = (ticks: number): string => DURATIONS.get(ticks) ?? `%${ticks}`;

/** sorted の中で value 以上の最初の位置 */
function lowerBound(sorted: number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** tick の順の変化の列。同じ tick の変化は最後の値が勝つ */
class Series {
  private readonly ticks: number[] = [];
  private readonly values: number[] = [];
  private readonly initial: number;
  constructor(items: { tick: number; value: number }[], initial: number) {
    this.initial = initial;
    for (const item of items) {
      this.ticks.push(item.tick);
      this.values.push(item.value);
    }
  }
  at(tick: number): number {
    const i = lowerBound(this.ticks, tick + 1); // tick 以下の最後
    return i === 0 ? this.initial : this.values[i - 1];
  }
  /** from より後、to より前の、変化のある tick（重複なし、昇順） */
  between(from: number, to: number): number[] {
    const out: number[] = [];
    for (let i = lowerBound(this.ticks, from + 1); i < this.ticks.length && this.ticks[i] < to; i++) {
      if (out[out.length - 1] !== this.ticks[i]) out.push(this.ticks[i]);
    }
    return out;
  }
}

const formatBend = (cents: number): string => `B${cents < 0 ? '-' : '+'}${Math.abs(cents)}`;

/** 行の長さの目安で折り返しながら、トラックの 1 行目以降を組み立てる */
function wrap(name: string, tokens: string[]): string {
  const lines: string[] = [];
  let line = name;
  for (const token of tokens) {
    if (line.length > name.length && line.length + 1 + token.length > LINE_WIDTH) {
      lines.push(line);
      line = name;
    }
    line += ` ${token}`;
  }
  lines.push(line);
  return lines.join('\n');
}

/** 割り当て済みのトラックから MML のテキストを書く。1 行目は指揮用の J、続いて tracks の順 */
export function writeMml(tracks: PlannedTrack[], song: Quantized, loop: LoopRange, meter: Meter): string {
  const series = new Map<string, Series>();
  const seriesOf = (channel: number, kind: ControlKind, initial: number, transform = (v: number) => v): Series => {
    const key = `${channel}:${kind}`;
    let s = series.get(key);
    if (!s) {
      const items = song.controls
        .filter((c: ChannelControl) => c.channel === channel && c.kind === kind)
        .map((c) => ({ tick: c.tick, value: transform(c.value) }));
      s = new Series(items, initial);
      series.set(key, s);
    }
    return s;
  };
  const conductor = writeConductor(song, loop, meter);
  const lines = [conductor];
  for (const track of tracks) {
    const tokens = track.drum
      ? writeDrumTrack(track, loop, meter, seriesOf)
      : writeMelodyTrack(track, meter, seriesOf);
    lines.push(wrap(track.name, tokens));
  }
  return lines.join('\n') + '\n';
}

type SeriesOf = (channel: number, kind: ControlKind, initial: number, transform?: (v: number) => number) => Series;

/** 指揮用の J：t・L・E と休符だけ */
function writeConductor(song: Quantized, loop: LoopRange, meter: Meter): string {
  const marks: { tick: number; order: number; text: string }[] = [];
  const tempos = new Map<number, number>();
  for (const t of song.tempos) if (t.tick < loop.end) tempos.set(t.tick, t.bpm);
  if (!tempos.has(0)) tempos.set(0, DEFAULT_TEMPO);
  let previous: number | undefined;
  for (const tick of [...tempos.keys()].sort((a, b) => a - b)) {
    const bpm = Math.round(tempos.get(tick)! * 100) / 100;
    if (bpm < MIN_BPM || bpm > MAX_BPM) {
      throw new ConvError(`${meter.position(tick)}：テンポ ${bpm} が ${MIN_BPM}〜${MAX_BPM} の範囲外です`);
    }
    if (bpm !== previous) marks.push({ tick, order: 0, text: `t${bpm}` });
    previous = bpm;
  }
  marks.push({ tick: loop.start, order: 1, text: 'L' }, { tick: loop.end, order: 2, text: 'E' });
  marks.sort((a, b) => a.tick - b.tick || a.order - b.order);

  const tokens: string[] = [];
  let pos = 0;
  for (const m of marks) {
    if (m.tick > pos) tokens.push(`r${duration(m.tick - pos)}`);
    pos = m.tick;
    tokens.push(m.text);
  }
  return wrap('J', tokens);
}

function checkNoteRange(note: number, tick: number, meter: Meter): void {
  if (note < 12 || note >= 120) {
    throw new ConvError(`${meter.position(tick)}：ノート番号 ${note} は MML のオクターブ（o0〜o8）で書けません（12〜119 の範囲）`);
  }
}

function writeDrumTrack(track: PlannedTrack, loop: LoopRange, meter: Meter, seriesOf: SeriesOf): string[] {
  const tokens: string[] = [];
  const volume = seriesOf(track.channel, 'volume', DEFAULT_VOLUME);
  const expression = seriesOf(track.channel, 'expression', DEFAULT_EXPRESSION);
  const pan = seriesOf(track.channel, 'pan', MML_PAN);
  let curV = MML_VOLUME;
  let curPan = MML_PAN;
  let pos = 0;
  track.notes.forEach((hit, i) => {
    if (hit.on > pos) tokens.push(`r${duration(hit.on - pos)}`);
    const next = i + 1 < track.notes.length ? track.notes[i + 1].on : loop.end;
    if (next <= hit.on) {
      throw new ConvError(`${meter.position(hit.on)}：ドラムの打撃がループ終了の位置にあり、書けません`);
    }
    const v = toMmlVolume(volume.at(hit.on), expression.at(hit.on), hit.velocity);
    if (v !== curV) tokens.push(`v${v}`);
    curV = v;
    const p = pan.at(hit.on);
    if (p !== curPan) tokens.push(`p${p}`);
    curPan = p;
    tokens.push(`${track.drumNames![i]}${duration(next - hit.on)}`);
    pos = next;
  });
  return tokens;
}

function writeMelodyTrack(track: PlannedTrack, meter: Meter, seriesOf: SeriesOf): string[] {
  const ch = track.channel;
  const volume = seriesOf(ch, 'volume', DEFAULT_VOLUME);
  const expression = seriesOf(ch, 'expression', DEFAULT_EXPRESSION);
  const pan = seriesOf(ch, 'pan', MML_PAN);
  const program = seriesOf(ch, 'program', MML_PROGRAM);
  const bend = seriesOf(ch, 'bend', 0, Math.round);
  const bendAt = (tick: number): number => bend.at(tick);

  // ベンドの範囲は、使う前にまとめて確かめる（位置つきで止める）
  for (const tick of bend.between(-1, Infinity)) {
    const cents = bendAt(tick);
    if (Math.abs(cents) > MAX_BEND_CENTS) {
      throw new ConvError(
        `${meter.position(tick)}：チャンネル ${ch + 1} のピッチベンド ${cents} セントが ±${MAX_BEND_CENTS} を超えます`,
      );
    }
  }
  const volumeAt = (tick: number, velocity: number): number =>
    toMmlVolume(volume.at(tick), expression.at(tick), velocity);
  const volumeTicks = (from: number, to: number): number[] =>
    [...new Set([...volume.between(from, to), ...expression.between(from, to)])].sort((a, b) => a - b);

  const tokens: string[] = [];
  let curV = MML_VOLUME;
  let curPan = MML_PAN;
  let curProgram = MML_PROGRAM;
  let curOctave = MML_OCTAVE;
  let curBend = 0;

  const syncBend = (tick: number, out: string[]): void => {
    const cents = bendAt(tick);
    if (cents !== curBend) out.push(formatBend(cents));
    curBend = cents;
  };

  const writeRest = (from: number, to: number): void => {
    syncBend(from, tokens);
    let cur = from;
    for (const t of bend.between(from, to)) {
      if (bendAt(t) === curBend) continue;
      tokens.push(`r${duration(t - cur)}`);
      cur = t;
      syncBend(t, tokens);
    }
    tokens.push(`r${duration(to - cur)}`);
  };

  const writeNote = (n: PlannedTrack['notes'][number]): void => {
    checkNoteRange(n.note, n.on, meter);
    const pr = program.at(n.on);
    if (pr !== curProgram) tokens.push(`@${pr}`);
    curProgram = pr;
    const p = pan.at(n.on);
    if (p !== curPan) tokens.push(`p${p}`);
    curPan = p;
    const octave = Math.floor(n.note / 12) - 1;
    if (octave !== curOctave) tokens.push(`o${octave}`);
    curOctave = octave;
    const v = volumeAt(n.on, n.velocity);
    if (v !== curV) tokens.push(`v${v}`);
    curV = v;
    syncBend(n.on, tokens);

    // ノートの途中で v か B が変わる位置でタイで分ける。タイの間には v と B だけを書く
    const name = NOTE_NAMES[n.note % 12];
    const cutTicks = [...new Set([...volumeTicks(n.on, n.off), ...bend.between(n.on, n.off)])].sort((a, b) => a - b);
    let text = '';
    let cur = n.on;
    for (const t of cutTicks) {
      const nextV = volumeAt(t, n.velocity);
      const nextBend = bendAt(t);
      if (nextV === curV && nextBend === curBend) continue;
      text += `${name}${duration(t - cur)}&`;
      if (nextV !== curV) text += `v${nextV}`;
      curV = nextV;
      const tmp: string[] = [];
      syncBend(t, tmp);
      text += tmp.join('');
      cur = t;
    }
    tokens.push(`${text}${name}${duration(n.off - cur)}`);
  };

  let pos = 0;
  for (const n of track.notes) {
    if (n.on > pos) writeRest(pos, n.on);
    writeNote(n);
    pos = n.off;
  }
  return tokens;
}
