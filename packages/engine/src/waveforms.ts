import { opCount, type AnyVoice } from './voiceData';

/** 波形表 1 周期の点数 */
export const TABLE_SIZE = 1024;

const UNDEFINED_WAVES = new Set([15, 23, 31]);

const sine = (x: number): number => Math.sin(2 * Math.PI * x);
/** 頭を平らに切ったサイン（|sin| が 1/√2 を超える部分を 1 にそろえる） */
const clippedSine = (x: number): number => Math.max(-1, Math.min(1, sine(x) * Math.SQRT2));
const triangle = (x: number): number => (x < 0.25 ? 4 * x : x < 0.75 ? 2 - 4 * x : 4 * x - 4);
const sawtooth = (x: number): number => (x < 0.5 ? 2 * x : 2 * x - 2);

const BASES = [sine, clippedSine, triangle, sawtooth] as const;

function cut(base: (x: number) => number, variant: number, x: number): number {
  const half = x % 0.5;
  switch (variant) {
    case 0:
      return base(x);
    case 1:
      return x < 0.5 ? base(x) : 0;
    case 2:
      return base(half);
    case 3:
      return half < 0.25 ? base(half) : 0;
    case 4:
      return x < 0.5 ? base(2 * x) : 0;
    case 5:
      return x < 0.5 ? base((2 * x) % 0.5) : 0;
    default:
      throw new Error(`切り出し方 ${variant} はない`);
  }
}

function special(wave: number, x: number): number {
  switch (wave) {
    case 6:
      return x < 0.5 ? 1 : -1;
    case 7:
      return x < 0.5 ? 2 ** (-16 * x) : -(2 ** (-16 * (1 - x)));
    case 14:
      return x < 0.5 ? 1 : 0;
    case 22:
      return x % 0.5 < 0.25 ? 1 : 0;
    case 30:
      return x < 0.25 ? 1 : 0;
    default:
      return sine(x); // 空き番号（15, 23, 31）
  }
}

/** 波形 wave の、1 周期を 0〜1 とした位置 x での値（-1〜1） */
export function waveValue(wave: number, x: number): number {
  if (!Number.isInteger(wave) || wave < 0 || wave > 31) {
    throw new RangeError(`waveValue: wave は 0〜31 の整数にしてください（wave=${wave}）`);
  }
  if (!Number.isFinite(x) || x < 0 || x >= 1) {
    throw new RangeError(`waveValue: x は 0 以上 1 未満の数にしてください（x=${x}）`);
  }
  const variant = wave & 7;
  if (variant >= 6) return special(wave, x);
  return cut(BASES[wave >> 3]!, variant, x);
}

export function isDefinedWave(wave: number): boolean {
  return !UNDEFINED_WAVES.has(wave);
}

export const WAVE_TABLES: readonly Float32Array[] = Array.from({ length: 32 }, (_, wave) => {
  const table = new Float32Array(TABLE_SIZE);
  for (let i = 0; i < TABLE_SIZE; i++) table[i] = waveValue(wave, i / TABLE_SIZE);
  return table;
});

/** 音色が使うオペレーターのうち、未定義の波形を指定しているものの警告。ドラムは FM 部の音色を見る */
export function voiceWarnings(timbre: AnyVoice): string[] {
  const voice = timbre.kind === 'fm' ? timbre : timbre.fm?.voice;
  if (!voice) return [];
  return voice.ops
    .slice(0, opCount(voice.alg))
    .flatMap((op, i) =>
      isDefinedWave(op.wave) ? [] : [`${voice.name} の ops[${i}].wave: 波形 ${op.wave} は未定義のため、サインで代わりに鳴らします`],
    );
}
