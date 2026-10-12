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
