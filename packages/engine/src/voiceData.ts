// 音色 JSON の型と検証。tools/import-ymf825.ts から Node で直接読むため、
// このファイルは他のファイルを import しない。

export interface FmOperator {
  wave: number;
  mul: number;
  dt: number;
  tl: number;
  ar: number;
  dr: number;
  sl: number;
  sr: number;
  rr: number;
  ksl: number;
  ksr: number;
  fb: number;
  am: number;
  amDepth: number;
  vib: number;
  vibDepth: number;
  xof: number;
}

export interface FmVoice {
  /** GM の楽器番号（0〜127）。割り当てない音色は null */
  id: number | null;
  name: string;
  kind: 'fm';
  bo: number;
  alg: number;
  lfo: number;
  ops: FmOperator[];
}

export interface ValidationError {
  path: string;
  message: string;
}

export type ValidationResult = { ok: true; voice: FmVoice } | { ok: false; errors: ValidationError[] };

export interface DrumNoise {
  level: number;
  ar: number;
  dr: number;
  sl: number;
  /** SL に達した後に下がる速さ（ドラムにはキーオフが来ないため） */
  rr: number;
  color: 'white';
  /** エンベロープを intervalMs ごとに count 回かけ直す */
  repeat?: { count: number; intervalMs: number };
}

export interface DrumVoice {
  /** ドラムの番号（128〜255） */
  id: number;
  name: string;
  kind: 'drum';
  fm?: { voice: FmVoice; note: number; level: number };
  /** 音程を fromSemitone から toSemitone へ、decayMs を時定数として近づける */
  pitch?: { fromSemitone: number; toSemitone: number; decayMs: number };
  noise?: DrumNoise;
}

export type AnyVoice = FmVoice | DrumVoice;

export type DrumValidationResult = { ok: true; voice: DrumVoice } | { ok: false; errors: ValidationError[] };

type Range = readonly [number, number];

export const OP_RANGES: Readonly<Record<keyof FmOperator, Range>> = {
  wave: [0, 31],
  mul: [0, 15],
  dt: [0, 7],
  tl: [0, 63],
  ar: [0, 15],
  dr: [0, 15],
  sl: [0, 15],
  sr: [0, 15],
  rr: [0, 15],
  ksl: [0, 3],
  ksr: [0, 1],
  fb: [0, 7],
  am: [0, 1],
  amDepth: [0, 3],
  vib: [0, 1],
  vibDepth: [0, 3],
  xof: [0, 1],
};

export const OP_FIELDS = Object.keys(OP_RANGES) as readonly (keyof FmOperator)[];

const ID_RANGE: Range = [0, 127];
const BO_RANGE: Range = [0, 3];
const ALG_RANGE: Range = [0, 7];
const LFO_RANGE: Range = [0, 3];

/** アルゴリズムが使うオペレーターの数 */
export function opCount(alg: number): 2 | 4 {
  return alg <= 1 ? 2 : 4;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkInt(value: unknown, [min, max]: Range, path: string, errors: ValidationError[]): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    errors.push({ path, message: `${min}〜${max} の整数を指定してください（値: ${JSON.stringify(value)}）` });
    return min;
  }
  return value;
}

export function validateVoice(input: unknown): ValidationResult {
  if (!isRecord(input)) {
    return { ok: false, errors: [{ path: '', message: '音色はオブジェクトで指定してください' }] };
  }
  const errors: ValidationError[] = [];

  const id = input.id === null ? null : checkInt(input.id, ID_RANGE, 'id', errors);
  const name = input.name;
  if (typeof name !== 'string' || name === '') {
    errors.push({ path: 'name', message: '空でない文字列を指定してください' });
  }
  if (input.kind !== 'fm') {
    errors.push({ path: 'kind', message: '"fm" を指定してください' });
  }
  const bo = checkInt(input.bo, BO_RANGE, 'bo', errors);
  const alg = checkInt(input.alg, ALG_RANGE, 'alg', errors);
  const lfo = checkInt(input.lfo, LFO_RANGE, 'lfo', errors);

  const ops: FmOperator[] = [];
  if (!Array.isArray(input.ops)) {
    errors.push({ path: 'ops', message: '配列を指定してください' });
  } else {
    const need = opCount(alg);
    if (input.ops.length < need) {
      errors.push({ path: 'ops', message: `アルゴリズム ${alg} には ${need} 個のオペレーターが必要です（${input.ops.length} 個）` });
    }
    input.ops.slice(0, need).forEach((raw: unknown, i: number) => {
      if (!isRecord(raw)) {
        errors.push({ path: `ops[${i}]`, message: 'オブジェクトで指定してください' });
        return;
      }
      const op = {} as FmOperator;
      for (const field of OP_FIELDS) {
        op[field] = checkInt(raw[field], OP_RANGES[field], `ops[${i}].${field}`, errors);
      }
      ops.push(op);
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, voice: { id, name: name as string, kind: 'fm', bo, alg, lfo, ops } };
}

/**
 * アルゴリズムごとの出力するオペレーター（0 始まり、spec §3.6）。
 * algorithms.ts と同じ内容だが、このファイルは他を import できないため持つ。
 */
export const CARRIERS: readonly (readonly number[])[] = [[1], [0, 1], [0, 1, 2, 3], [3], [3], [1, 3], [0, 3], [0, 2, 3]];

const DRUM_ID_RANGE: Range = [128, 255];
const NOTE_RANGE: Range = [0, 127];
// ノイズは ar・dr が 0 だと鳴り終わらないため 1 から
const NOISE_ENV_RANGE: Range = [1, 15];
const ENV_RANGE: Range = [0, 15];
const NOISE_RR_RANGE: Range = [1, 15];
const REPEAT_COUNT_RANGE: Range = [1, 8];

function checkNumber(value: unknown, [min, max]: Range, path: string, errors: ValidationError[], minExclusive = false): number {
  const tooSmall = typeof value === 'number' && (minExclusive ? value <= min : value < min);
  if (typeof value !== 'number' || !Number.isFinite(value) || tooSmall || value > max) {
    const lower = minExclusive ? `${min} より大きく` : `${min} 以上`;
    errors.push({ path, message: `${lower} ${max} 以下の数を指定してください（値: ${JSON.stringify(value)}）` });
    return min;
  }
  return value;
}

function checkRecord(value: unknown, path: string, errors: ValidationError[]): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  errors.push({ path, message: 'オブジェクトで指定してください' });
  return null;
}

/** ドラム音色（spec §3.4）を検証する */
export function validateDrum(input: unknown): DrumValidationResult {
  if (!isRecord(input)) {
    return { ok: false, errors: [{ path: '', message: 'ドラム音色はオブジェクトで指定してください' }] };
  }
  const errors: ValidationError[] = [];
  const id = checkInt(input.id, DRUM_ID_RANGE, 'id', errors);
  const name = input.name;
  if (typeof name !== 'string' || name === '') {
    errors.push({ path: 'name', message: '空でない文字列を指定してください' });
  }
  if (input.kind !== 'drum') {
    errors.push({ path: 'kind', message: '"drum" を指定してください' });
  }
  if (input.fm === undefined && input.noise === undefined) {
    errors.push({ path: '', message: 'fm と noise の少なくとも一方を指定してください' });
  }

  const drum: DrumVoice = { id, name: name as string, kind: 'drum' };

  if (input.fm !== undefined) {
    const fm = checkRecord(input.fm, 'fm', errors);
    if (fm) {
      const result = validateVoice(fm.voice);
      if (!result.ok) {
        for (const e of result.errors) errors.push({ path: e.path ? `fm.voice.${e.path}` : 'fm.voice', message: e.message });
      } else {
        // ドラムはキーオフを無視するので、出力するオペレーターが自分で鳴り終わる必要がある
        for (const c of CARRIERS[result.voice.alg]!) {
          const op = result.voice.ops[c]!;
          const fail = (field: string, message: string) =>
            errors.push({ path: `fm.voice.ops[${c}].${field}`, message: `ドラムは鳴り終わる必要があるため、${message}` });
          if (op.ar === 0) fail('ar', 'ar≥1 にしてください');
          if (op.dr === 0) fail('dr', 'dr≥1 にしてください');
          if (op.sl < 15 && op.sr === 0) fail('sr', 'sl=15 か sr≥1 にしてください');
        }
      }
      const note = checkInt(fm.note, NOTE_RANGE, 'fm.note', errors);
      const level = checkNumber(fm.level, [0, 1], 'fm.level', errors);
      if (result.ok) drum.fm = { voice: result.voice, note, level };
    }
  }

  if (input.pitch !== undefined) {
    if (input.fm === undefined) {
      errors.push({ path: 'pitch', message: 'pitch は fm と一緒に指定してください' });
    }
    const pitch = checkRecord(input.pitch, 'pitch', errors);
    if (pitch) {
      drum.pitch = {
        fromSemitone: checkNumber(pitch.fromSemitone, [-48, 48], 'pitch.fromSemitone', errors),
        toSemitone: checkNumber(pitch.toSemitone, [-48, 48], 'pitch.toSemitone', errors),
        decayMs: checkNumber(pitch.decayMs, [0, 1000], 'pitch.decayMs', errors, true),
      };
    }
  }

  if (input.noise !== undefined) {
    const noise = checkRecord(input.noise, 'noise', errors);
    if (noise) {
      if (noise.color !== 'white') {
        errors.push({ path: 'noise.color', message: '"white" を指定してください' });
      }
      drum.noise = {
        level: checkNumber(noise.level, [0, 1], 'noise.level', errors),
        ar: checkInt(noise.ar, NOISE_ENV_RANGE, 'noise.ar', errors),
        dr: checkInt(noise.dr, NOISE_ENV_RANGE, 'noise.dr', errors),
        sl: checkInt(noise.sl, ENV_RANGE, 'noise.sl', errors),
        rr: checkInt(noise.rr, NOISE_RR_RANGE, 'noise.rr', errors),
        color: 'white',
      };
      if (noise.repeat !== undefined) {
        const repeat = checkRecord(noise.repeat, 'noise.repeat', errors);
        if (repeat) {
          drum.noise.repeat = {
            count: checkInt(repeat.count, REPEAT_COUNT_RANGE, 'noise.repeat.count', errors),
            intervalMs: checkNumber(repeat.intervalMs, [1, 100], 'noise.repeat.intervalMs', errors),
          };
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, voice: drum };
}
