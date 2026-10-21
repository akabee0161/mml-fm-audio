import { splitTracks, type TrackSource } from './source.ts';
import { TICKS_PER_QUARTER, type MmlError, type Song, type Track, type TrackEvent } from './song.ts';

const DEFAULT_BPM = 120;
const DEFAULT_OCTAVE = 4;
const DEFAULT_LENGTH_TICKS = TICKS_PER_QUARTER; // l4
const DEFAULT_PROGRAM = 0;
const DEFAULT_VOLUME = 12;
const DEFAULT_PAN = 64;
const MAX_OCTAVE = 8;

/** 音長の表の数 → ティック（全音符 = 4 * 96） */
const LENGTH_TABLE = new Map<number, number>(
  [1, 2, 4, 8, 16, 32, 3, 6, 12, 24, 48].map((n) => [n, (TICKS_PER_QUARTER * 4) / n]),
);

const NOTE_SEMITONES: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

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
}

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
    const gate = readDuration(ctx);
    if (number < 0 || number > 127) throw new CommandError(`ノート番号 ${number} が 0〜127 の範囲外です`);
    ctx.events.push({
      type: 'note',
      tick: ctx.tick,
      gate,
      program: ctx.program,
      note: number,
      volume: ctx.volume,
      pan: ctx.pan,
      bend: ctx.bend,
    });
    ctx.tick += gate;
  };
}

const rest: Command = (ctx) => {
  ctx.tick += readDuration(ctx);
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

/** 命令の先頭の文字 → その命令の解析。後続のタスクは、ここに足す */
const COMMANDS: Record<string, Command> = {
  c: note('c'), d: note('d'), e: note('e'), f: note('f'), g: note('g'), a: note('a'), b: note('b'),
  r: rest,
  o: octave,
  '<': shiftOctave(-1),
  '>': shiftOctave(1),
  l: defaultLength,
};

function isWhitespace(ch: string): boolean {
  return /\s/u.test(ch);
}

/** エラーの後、次の命令の先頭（命令の先頭になる文字か、空白の後）まで読み飛ばす */
function skipToNextCommand(ctx: TrackContext, commandStart: number): void {
  ctx.pos = commandStart + 1;
  while (ctx.pos < ctx.source.text.length) {
    const ch = peek(ctx);
    if (isWhitespace(ch) || Object.hasOwn(COMMANDS, ch)) return;
    ctx.pos++;
  }
}

function parseTrack(source: TrackSource, errors: MmlError[]): Track {
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
  };
  const text = source.text;

  while (ctx.pos < text.length) {
    if (isWhitespace(peek(ctx))) {
      ctx.pos++;
      continue;
    }
    const start = ctx.pos;
    const command = Object.hasOwn(COMMANDS, text[start]) ? COMMANDS[text[start]] : undefined;
    try {
      if (!command) throw new CommandError(`命令 '${text[start]}' が分かりません`);
      ctx.pos++;
      command(ctx);
    } catch (error) {
      if (!(error instanceof CommandError)) throw error;
      const where = source.positions[start];
      errors.push({ line: where.line, column: where.column, message: error.message });
      skipToNextCommand(ctx, start);
    }
  }

  return { name: source.name, events: ctx.events, length: ctx.tick };
}

/** MML を解析して Song にする。ブラウザーにも Worklet にも依存しない */
export function parseMml(mml: string): Song {
  const { tracks: sources, errors: nameErrors } = splitTracks(mml);
  const errors: MmlError[] = [...nameErrors];
  const tracks = sources.map((source) => parseTrack(source, errors));
  const length = tracks.reduce((max, track) => Math.max(max, track.length), 0);
  errors.sort((x, y) => x.line - y.line || x.column - y.column);
  return {
    tracks,
    tempos: [{ tick: 0, bpm: DEFAULT_BPM }],
    length,
    loopStart: null,
    loopEnd: length,
    errors,
  };
}
