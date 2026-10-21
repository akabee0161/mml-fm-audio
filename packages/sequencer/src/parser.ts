import { splitTracks, type SourcePosition, type TrackSource } from './source.ts';
import { DRUM_PROGRAMS, TICKS_PER_QUARTER, type MmlError, type Song, type Tempo, type Track, type TrackEvent } from './song.ts';

const DEFAULT_BPM = 120;
const DEFAULT_OCTAVE = 4;
const DEFAULT_LENGTH_TICKS = TICKS_PER_QUARTER; // l4
const DEFAULT_PROGRAM = 0;
const DEFAULT_VOLUME = 12;
const DEFAULT_PAN = 64;
const MAX_OCTAVE = 8;
const MAX_GATE_Q = 8;
const DEFAULT_GATE_Q = 8;
const MAX_REPEAT = 255;
/** 展開後の 1 トラックの events の上限。超えたらその繰り返しの位置でエラーにして読むのをやめる */
const MAX_EVENTS = 100_000;
/** 1 トラックで実行する命令の総数の上限。休符や v だけの巨大な展開（events が増えない）で固まらないため */
const MAX_EXECUTED_COMMANDS = 400_000;
/** 失敗した命令の実行回数の上限。失敗は例外を投げる分重く、繰り返しの中では同じエラーの重複でしかないため、別に小さく持つ */
const MAX_FAILED_EXECUTIONS = 10_000;

/** 音長の表の数 → ティック（全音符 = 4 * 96） */
const LENGTH_TABLE = new Map<number, number>(
  [1, 2, 4, 8, 16, 32, 3, 6, 12, 24, 48].map((n) => [n, (TICKS_PER_QUARTER * 4) / n]),
);

const NOTE_SEMITONES: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** ドラムトラックの名前（spec §3.4） */
const DRUM_TRACK_NAME = 'R';
const DRUM_NOTE = 60;

type NoteEvent = Extract<TrackEvent, { type: 'note' }>;

/**
 * 実行できた命令 1 つの記録。`E` より後の命令の検査（Task 5）が、後から tick と元の位置を引くために使う。
 * tick は命令を実行する前の tick。noteOn は、音符がノートオンする（タイの続きではない）ときだけ true
 */
export interface CommandTrace {
  command: string;
  tick: number;
  position: SourcePosition;
  noteOn: boolean;
}

interface TempoEntry extends Tempo { position: SourcePosition }

/** 命令の解析で見つけたエラー。報告する列は、原因の位置にかかわらず命令の先頭の文字にそろえる */
class CommandError extends Error {}

/**
 * 1 トラックの読み取り状態。読み取り位置 pos は TrackSource.text 上の添字で、
 * 元の行・列は source.positions[pos] で引く（`[ ]` の繰り返しで同じ位置を読み直せるようにするため）。
 */
interface TrackContext {
  source: TrackSource;
  pos: number;
  tick: number;
  octave: number;
  /** l で決めた音長（付点を含むティック） */
  defaultLength: number;
  events: TrackEvent[];
  program: number;
  volume: number;
  pan: number;
  bend: number;
  gateQ: number;
  /** 実行中の命令の先頭の text 上の添字 */
  commandStart: number;
  /** 直前の命令が音符のときだけ入る（休符で消える）。& でつなぐ対象 */
  lastNote: { event: NoteEvent; ticks: number } | null;
  /** & を読んだ後、次の音符を待っている。pos は & の text 上の添字 */
  tie: { pos: number } | null;
  /** いま実行した命令が、ノートオンした（音符・ドラム。タイの続きは含まない） */
  noteOn: boolean;
  /** ドラムトラック（R）。ドラム名を読み、使える命令が限られる */
  drumTrack: boolean;
  /** このトラックのテンポ。同じ tick は後の値 */
  tempos: TempoEntry[];
  /** 開いている `[`（外側が先頭） */
  repeats: RepeatFrame[];
}

/** 開いている `[ ]`。open は `[` の text 上の添字、bodyStart は中の先頭、done は読み終えた回数 */
interface RepeatFrame { open: number; bodyStart: number; done: number }

type Command = (ctx: TrackContext) => void;

function peek(ctx: TrackContext): string {
  return ctx.source.text[ctx.pos] ?? '';
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

/** 符号なし整数を読む。数字がなければ null */
function readInteger(ctx: TrackContext): number | null {
  const start = ctx.pos;
  while (isDigit(peek(ctx))) ctx.pos++;
  return ctx.pos === start ? null : Number(ctx.source.text.slice(start, ctx.pos));
}

/** 付点を読み、base に足したティックを返す。整数にならなければエラー */
function readDots(ctx: TrackContext, base: number): number {
  let total = base;
  let add = base;
  while (peek(ctx) === '.') {
    ctx.pos++;
    add /= 2;
    if (!Number.isInteger(add)) throw new CommandError('付点を付けるとティックが整数になりません');
    total += add;
  }
  return total;
}

/** 音長を読む。表の数、または %N（ティック）。なければ l の音長。付点は明示した音長にだけ付く */
function readDuration(ctx: TrackContext): number {
  const ch = peek(ctx);
  if (ch === '%') {
    ctx.pos++;
    const ticks = readInteger(ctx);
    if (ticks === null || ticks < 1) throw new CommandError('% の後には 1 以上の整数を書きます');
    return readDots(ctx, ticks);
  }
  if (isDigit(ch)) {
    const n = readInteger(ctx) as number;
    const ticks = LENGTH_TABLE.get(n);
    if (ticks === undefined) throw new CommandError(`音長 ${n} は使えません（1, 2, 4, 8, 16, 32, 3, 6, 12, 24, 48）`);
    return readDots(ctx, ticks);
  }
  return readDots(ctx, ctx.defaultLength);
}

function note(letter: string): Command {
  return (ctx) => {
    let semitone = NOTE_SEMITONES[letter];
    const sign = peek(ctx);
    if (sign === '+' || sign === '-') {
      ctx.pos++;
      semitone += sign === '+' ? 1 : -1;
      if (peek(ctx) === '+' || peek(ctx) === '-') throw new CommandError('+ と - は 1 個までです');
    }
    const number = (ctx.octave + 1) * 12 + semitone;
    const ticks = readDuration(ctx);
    if (number < 0 || number > 127) throw new CommandError(`ノート番号 ${number} が 0〜127 の範囲外です`);
    const previous = ctx.lastNote;
    if (ctx.tie && previous) {
      if (previous.event.note !== number) {
        throw new CommandError(`タイの前後でノート番号が違います（${previous.event.note} と ${number}）`);
      }
      ctx.tie = null;
      previous.ticks += ticks;
      previous.event.gate = gateOf(ctx, previous.ticks);
    } else {
      ctx.noteOn = true;
      const event: NoteEvent = {
        type: 'note',
        tick: ctx.tick,
        gate: gateOf(ctx, ticks),
        program: ctx.program,
        note: number,
        volume: ctx.volume,
        pan: ctx.pan,
        bend: ctx.bend,
      };
      ctx.events.push(event);
      ctx.lastNote = { event, ticks };
    }
    ctx.tick += ticks;
  };
}

/** ドラム名（2 文字）。R では 1 文字の命令より先に照合する */
function drum(name: keyof typeof DRUM_PROGRAMS): Command {
  return (ctx) => {
    const ticks = readDuration(ctx);
    const event: NoteEvent = {
      type: 'note',
      tick: ctx.tick,
      gate: gateOf(ctx, ticks),
      program: DRUM_PROGRAMS[name],
      note: DRUM_NOTE,
      volume: ctx.volume,
      pan: ctx.pan,
      bend: 0,
    };
    ctx.events.push(event);
    // ドラムはタイでつながない
    ctx.lastNote = null;
    ctx.noteOn = true;
    ctx.tick += ticks;
  };
}

/** q を掛けたゲート。切り捨てて、最小 1 ティック。ticks はタイでつないだ全体の長さ */
function gateOf(ctx: TrackContext, ticks: number): number {
  return Math.max(1, Math.floor((ticks * ctx.gateQ) / MAX_GATE_Q));
}

const rest: Command = (ctx) => {
  ctx.tick += readDuration(ctx);
  ctx.lastNote = null;
};

const octave: Command = (ctx) => {
  const n = readInteger(ctx);
  if (n === null) throw new CommandError('o の後にはオクターブ（0〜8）を書きます');
  if (n > MAX_OCTAVE) throw new CommandError(`オクターブ ${n} が 0〜${MAX_OCTAVE} の範囲外です`);
  ctx.octave = n;
};

function shiftOctave(delta: number): Command {
  return (ctx) => {
    const next = ctx.octave + delta;
    if (next < 0 || next > MAX_OCTAVE) throw new CommandError(`オクターブが 0〜${MAX_OCTAVE} の範囲外になります`);
    ctx.octave = next;
  };
}

const defaultLength: Command = (ctx) => {
  const n = readInteger(ctx);
  if (n === null) throw new CommandError('l の後には音長を書きます');
  const ticks = LENGTH_TABLE.get(n);
  if (ticks === undefined) throw new CommandError(`音長 ${n} は使えません（1, 2, 4, 8, 16, 32, 3, 6, 12, 24, 48）`);
  ctx.defaultLength = readDots(ctx, ticks);
};

/** 符号なし整数を読み、min〜max の範囲を確かめる */
function readRanged(ctx: TrackContext, name: string, min: number, max: number): number {
  const n = readInteger(ctx);
  if (n === null) throw new CommandError(`${name} の後には ${min}〜${max} の整数を書きます`);
  if (n < min || n > max) throw new CommandError(`${name}${n} が ${min}〜${max} の範囲外です`);
  return n;
}

const programChange: Command = (ctx) => {
  ctx.program = readRanged(ctx, '@', 0, 127);
};

const panpot: Command = (ctx) => {
  ctx.pan = readRanged(ctx, 'p', 0, 127);
};

const gateTime: Command = (ctx) => {
  ctx.gateQ = readRanged(ctx, 'q', 1, MAX_GATE_Q);
};

const volume: Command = (ctx) => {
  ctx.volume = readRanged(ctx, 'v', 0, 15);
  // R の v は、次のドラムから効く（ドラムは鳴り終わるまで鳴り、途中で音量を変える対象がない）
  if (ctx.drumTrack) return;
  ctx.events.push({ type: 'volume', tick: ctx.tick, volume: ctx.volume });
};

const pitchBend: Command = (ctx) => {
  const sign = peek(ctx);
  if (sign !== '+' && sign !== '-') throw new CommandError('B の後には符号つきの整数（B+50、B-50）を書きます');
  ctx.pos++;
  const n = readInteger(ctx);
  if (n === null) throw new CommandError('B の符号の後には整数を書きます');
  if (n > 1200) throw new CommandError(`B${sign}${n} が -1200〜+1200 の範囲外です`);
  ctx.bend = sign === '-' && n !== 0 ? -n : n;
  ctx.events.push({ type: 'bend', tick: ctx.tick, cents: ctx.bend });
};

/** 小数を読む（132.5）。整数部がない、または小数点の後に数字がなければ null */
function readDecimal(ctx: TrackContext): number | null {
  const start = ctx.pos;
  if (readInteger(ctx) === null) return null;
  if (peek(ctx) === '.') {
    ctx.pos++;
    if (readInteger(ctx) === null) return null;
  }
  return Number(ctx.source.text.slice(start, ctx.pos));
}

const tempo: Command = (ctx) => {
  const bpm = readDecimal(ctx);
  if (bpm === null) throw new CommandError('t の後には 1〜999 のテンポ（小数可）を書きます');
  if (bpm < 1 || bpm > 999) throw new CommandError(`テンポ ${bpm} が 1〜999 の範囲外です`);
  const entry = { tick: ctx.tick, bpm, position: ctx.source.positions[ctx.commandStart] };
  const same = ctx.tempos.findIndex((t) => t.tick === ctx.tick);
  if (same >= 0) ctx.tempos[same] = entry;
  else ctx.tempos.push(entry);
};

const tie: Command = (ctx) => {
  if (!ctx.lastNote) throw new CommandError('& の前に音符がありません');
  ctx.tie = { pos: ctx.commandStart };
};

const openRepeat: Command = (ctx) => {
  // [ ] の境をまたぐタイはエラーにするため、境では「直前の音符」を忘れる
  ctx.lastNote = null;
  ctx.repeats.push({ open: ctx.commandStart, bodyStart: ctx.pos, done: 1 });
};

const closeRepeat: Command = (ctx) => {
  const frame = ctx.repeats.pop();
  if (!frame) throw new CommandError('] に対応する [ がありません');
  const times = readRanged(ctx, ']', 1, MAX_REPEAT);
  ctx.lastNote = null;
  if (frame.done < times) {
    frame.done++;
    ctx.repeats.push(frame);
    ctx.pos = frame.bodyStart;
  }
};

/** L・E。[ ] の中には書けない。曲全体で 1 つまで、L と E の順序などの検査は全トラックを読んだ後 */
function loopMark(name: string): Command {
  return (ctx) => {
    if (ctx.repeats.length > 0) throw new CommandError(`${name} は [ ] の中には書けません`);
  };
}

/** 命令の先頭の文字 → その命令の解析。後続のタスクは、ここに足す */
const COMMANDS: Record<string, Command> = {
  c: note('c'), d: note('d'), e: note('e'), f: note('f'), g: note('g'), a: note('a'), b: note('b'),
  r: rest,
  o: octave,
  '<': shiftOctave(-1),
  '>': shiftOctave(1),
  l: defaultLength,
  '@': programChange,
  p: panpot,
  q: gateTime,
  v: volume,
  B: pitchBend,
  t: tempo,
  '&': tie,
  '[': openRepeat,
  ']': closeRepeat,
  L: loopMark('L'),
  E: loopMark('E'),
};

/** R に書けない命令（音符・o < > @ & B）。音符は、書きかけのドラム名として読める文字（b など）も含む */
function drumTrackForbidden(char: string): Command {
  const message = char in NOTE_SEMITONES
    ? `ドラムトラック（R）には音符を書けません（ドラム名 ${Object.keys(DRUM_PROGRAMS).join(' ')} を書きます）`
    : `ドラムトラック（R）には '${char}' を書けません`;
  return () => {
    throw new CommandError(message);
  };
}

/** R の命令表。メロディ用の表から、使えない命令をエラーにして共用する */
const DRUM_COMMANDS: Record<string, Command> = {
  ...COMMANDS,
  ...Object.fromEntries(
    [...Object.keys(NOTE_SEMITONES), 'o', '<', '>', '@', '&', 'B'].map((c) => [c, drumTrackForbidden(c)]),
  ),
};

const DRUM_NAMES: ReadonlyMap<string, Command> = new Map(
  (Object.keys(DRUM_PROGRAMS) as (keyof typeof DRUM_PROGRAMS)[]).map((name) => [name, drum(name)]),
);

/** この位置の命令。R ではドラム名を先に照合する。name は trace と E より後の検査に出す名前 */
function lookupCommand(ctx: TrackContext, start: number): { name: string; length: number; command: Command } | undefined {
  const text = ctx.source.text;
  if (ctx.drumTrack) {
    const name = text.slice(start, start + 2);
    const command = DRUM_NAMES.get(name);
    if (command) return { name, length: 2, command };
  }
  const char = text[start];
  const table = ctx.drumTrack ? DRUM_COMMANDS : COMMANDS;
  return Object.hasOwn(table, char) ? { name: char, length: 1, command: table[char] } : undefined;
}

/** & と次の音符の間に書ける命令（音符は別に許す） */
const TIE_TRANSPARENT = new Set(['B', 'v']);

function isWhitespace(ch: string): boolean {
  return /\s/u.test(ch);
}

/** エラーの後、次の命令の先頭（命令の先頭になる文字か、空白の後）まで読み飛ばす */
function skipToNextCommand(ctx: TrackContext, commandStart: number): void {
  ctx.pos = commandStart + 1;
  while (ctx.pos < ctx.source.text.length) {
    const ch = peek(ctx);
    if (isWhitespace(ch) || lookupCommand(ctx, ctx.pos)) return;
    ctx.pos++;
  }
}

interface ParsedTrack {
  track: Track;
  /** 実行できた命令の記録（tick の順）。E より後の検査（Task 5）が使う */
  trace: CommandTrace[];
  tempos: TempoEntry[];
}

function parseTrack(source: TrackSource, errors: MmlError[]): ParsedTrack {
  const ctx: TrackContext = {
    source,
    pos: 0,
    tick: 0,
    octave: DEFAULT_OCTAVE,
    defaultLength: DEFAULT_LENGTH_TICKS,
    events: [],
    program: DEFAULT_PROGRAM,
    volume: DEFAULT_VOLUME,
    pan: DEFAULT_PAN,
    bend: 0,
    gateQ: DEFAULT_GATE_Q,
    commandStart: 0,
    lastNote: null,
    tie: null,
    noteOn: false,
    drumTrack: source.name === DRUM_TRACK_NAME,
    tempos: [],
    repeats: [],
  };
  const text = source.text;
  const trace: CommandTrace[] = [];

  // [ ] の繰り返しで同じ命令を読み直しても、同じエラーは 1 回だけ報告する
  const reported = new Set<string>();
  const report = (index: number, message: string): void => {
    const key = `${index}:${message}`;
    if (reported.has(key)) return;
    reported.add(key);
    const where = source.positions[index];
    errors.push({ line: where.line, column: where.column, message });
  };

  let executed = 0;
  let failed = 0;
  let aborted = false;
  while (ctx.pos < text.length) {
    if (isWhitespace(peek(ctx))) {
      ctx.pos++;
      continue;
    }
    const start = ctx.pos;
    const char = text[start];
    const found = lookupCommand(ctx, start);
    // & の次に書けるのは音符・B・v だけ。ほかの命令なら & の位置で報告し、その命令は普通に読む
    if (ctx.tie && found && !(char in NOTE_SEMITONES) && !TIE_TRANSPARENT.has(char)) {
      report(ctx.tie.pos, `& の後に音符がありません（間に書けるのは B と v だけです。'${char}' があります）`);
      ctx.tie = null;
    }
    const tickBefore = ctx.tick;
    ctx.commandStart = start;
    ctx.noteOn = false;
    try {
      if (!found) throw new CommandError(`命令 '${char}' が分かりません`);
      ctx.pos += found.length;
      found.command(ctx);
      trace.push({
        command: found.name,
        tick: tickBefore,
        position: source.positions[start],
        noteOn: ctx.noteOn,
      });
    } catch (error) {
      if (!(error instanceof CommandError)) throw error;
      failed++;
      report(start, error.message);
      ctx.tie = null;
      skipToNextCommand(ctx, start);
    }
    // 展開しすぎ：いちばん外側の `[` の位置（開いていなければ今の命令の位置）で報告して、読むのをやめる
    const tooManyEvents = ctx.events.length > MAX_EVENTS;
    if (tooManyEvents || ++executed > MAX_EXECUTED_COMMANDS || failed > MAX_FAILED_EXECUTIONS) {
      const outer = ctx.repeats[0]?.open ?? start;
      report(
        outer,
        tooManyEvents
          ? `繰り返しを展開すると 1 トラックの events が ${MAX_EVENTS} を超えます`
          : `繰り返しを展開すると 1 トラックで実行する命令が多すぎます（${MAX_EXECUTED_COMMANDS} 個まで。エラーになる命令は ${MAX_FAILED_EXECUTIONS} 回まで）`,
      );
      aborted = true;
      break;
    }
  }
  if (!aborted) {
    for (const frame of ctx.repeats) report(frame.open, '[ が閉じていません');
    if (ctx.tie) report(ctx.tie.pos, '& の後に音符がありません');
  }

  return { track: { name: source.name, events: ctx.events, length: ctx.tick }, trace, tempos: ctx.tempos };
}

/**
 * 全トラックのテンポを tick の順に集める。違うトラックで同じ tick に違う値があれば、後に出たほうの位置でエラー。
 * tick 0 になければ既定値を先頭に入れる
 */
function mergeTempos(parsed: ParsedTrack[], errors: MmlError[]): Tempo[] {
  const entries = parsed
    .flatMap((p) => p.tempos)
    .sort((x, y) => x.position.line - y.position.line || x.position.column - y.position.column);
  const byTick = new Map<number, number>();
  for (const { tick, bpm, position } of entries) {
    const accepted = byTick.get(tick);
    if (accepted === undefined) byTick.set(tick, bpm);
    else if (accepted !== bpm) {
      errors.push({
        line: position.line,
        column: position.column,
        message: `tick ${tick} のテンポが別のトラックの値（${accepted}）と違います`,
      });
    }
  }
  const tempos = [...byTick].map(([tick, bpm]) => ({ tick, bpm })).sort((x, y) => x.tick - y.tick);
  if (tempos.length === 0 || tempos[0].tick !== 0) tempos.unshift({ tick: 0, bpm: DEFAULT_BPM });
  return tempos;
}

/** E より後に書くとエラーになる命令（音符はノートオンだけ。タイの続きと休符は書ける） */
const FORBIDDEN_AFTER_LOOP_END = new Set(['B', 'v', 't', '@', 'p', 'q', 'o', '<', '>', 'l']);

interface Mark { tick: number; position: SourcePosition }

function byPosition(x: Mark, y: Mark): number {
  return x.position.line - y.position.line || x.position.column - y.position.column;
}

function reportAt(errors: MmlError[], position: SourcePosition, message: string): void {
  errors.push({ line: position.line, column: position.column, message });
}

/**
 * L・E を全トラックから集めて検査する。「2 つ目以降」は MML 上の位置の順で数える。
 * loopEnd は、検査に通った E がなければ length
 */
function resolveLoop(
  traces: CommandTrace[][],
  length: number,
  errors: MmlError[],
): { loopStart: number | null; loopEnd: number } {
  const all = traces.flat();
  const marks = (command: string): Mark[] =>
    all.filter((t) => t.command === command).map(({ tick, position }) => ({ tick, position })).sort(byPosition);
  const loopMarks = marks('L');
  const endMarks = marks('E');
  for (const extra of loopMarks.slice(1)) reportAt(errors, extra.position, 'L は曲全体で 1 つまでです');
  for (const extra of endMarks.slice(1)) reportAt(errors, extra.position, 'E は曲全体で 1 つまでです');

  const start = loopMarks[0];
  const end = endMarks[0];
  let loopEnd = length;
  let endValid = false;
  if (end) {
    if (!start) reportAt(errors, end.position, 'E の前に L がありません');
    else if (end.tick <= start.tick) reportAt(errors, end.position, 'E は L より後の位置に書きます');
    else {
      loopEnd = end.tick;
      endValid = true;
    }
  }
  if (start && start.tick >= loopEnd) {
    reportAt(errors, start.position, 'L とループ終了が同じ位置です（繰り返す長さが 0 です）');
  }

  if (endValid) {
    const seen = new Set<string>();
    for (const t of all) {
      if (t.tick < loopEnd || !(t.noteOn || FORBIDDEN_AFTER_LOOP_END.has(t.command))) continue;
      const key = `${t.position.line}:${t.position.column}`;
      if (seen.has(key)) continue;
      seen.add(key);
      reportAt(
        errors,
        t.position,
        `E より後（tick ${t.tick}）には '${t.command}' を書けません（休符と、ループ終了を越えるノートの続きだけ書けます）`,
      );
    }
  }
  return { loopStart: start ? start.tick : null, loopEnd };
}

export function analyzeMml(mml: string): { song: Song; traces: CommandTrace[][] } {
  const { tracks: sources, errors: nameErrors } = splitTracks(mml);
  const errors: MmlError[] = [...nameErrors];
  const parsed = sources.map((source) => parseTrack(source, errors));
  const tracks = parsed.map((p) => p.track);
  const tempos = mergeTempos(parsed, errors);
  const length = tracks.reduce((max, track) => Math.max(max, track.length), 0);
  const loop = resolveLoop(parsed.map((p) => p.trace), length, errors);
  errors.sort((x, y) => x.line - y.line || x.column - y.column);
  return {
    song: { tracks, tempos, length, loopStart: loop.loopStart, loopEnd: loop.loopEnd, errors },
    traces: parsed.map((p) => p.trace),
  };
}

/** MML を解析して Song にする。ブラウザーにも Worklet にも依存しない */
export function parseMml(mml: string): Song {
  return analyzeMml(mml).song;
}
