// 音源の表。「公開値」は YMF825 の IF 仕様書（YMF825_sample の manual）の値、
// 「暫定」は独自に決めた値で、試聴で調整してよい。

/** mul → 周波数の倍率（公開値） */
export const MUL_TABLE: readonly number[] = [0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 12, 12, 15, 15];

/**
 * bo → 周波数の倍率。IF 仕様書の比（×2, ×1, ×1/2, ×1/4）を保ったまま、
 * YMF825 の音色データがすべて使う bo=0 を標準の高さに置き直している（暫定）。
 */
export const BO_TABLE: readonly number[] = [1, 0.5, 0.25, 0.125];

/** dt → cent（暫定。IF 仕様書に値の記載がない） */
export const DT_CENTS: readonly number[] = [0, 3, 6, 9, 0, -3, -6, -9];

/** lfo → Hz（公開値） */
export const LFO_HZ: readonly number[] = [1.8, 4.0, 5.9, 7.0];

/** amDepth → トレモロの深さ dB（公開値） */
export const AM_DEPTH_DB: readonly number[] = [1.3, 2.8, 5.8, 11.8];

/** vibDepth → ビブラートの深さ cent（公開値） */
export const VIB_DEPTH_CENTS: readonly number[] = [3.4, 6.7, 13.5, 26.8];

/** ksl → 1 オクターブあたりの減衰 dB（公開値） */
export const KSL_DB_PER_OCT: readonly number[] = [0, 3, 1.5, 6];

/** fb → 帰還量 rad（公開値） */
export const FB_RAD: readonly number[] = [
  0,
  Math.PI / 16,
  Math.PI / 8,
  Math.PI / 4,
  Math.PI / 2,
  Math.PI,
  2 * Math.PI,
  4 * Math.PI,
];

/** TL 1 段あたりの dB（暫定） */
export const TL_DB_PER_STEP = 0.75;
/** SL 1 段あたりの dB（暫定。SL=15 は無音として扱う） */
export const SL_DB_PER_STEP = 3;
/** これ以上の減衰は無音とみなす dB */
export const SILENT_DB = 96;
/** 変調側の出力 1.0 が搬送側の位相を何 rad ずらすか（暫定） */
export const MOD_INDEX = 4 * Math.PI;
/** 1 ボイスの出力に掛ける係数（暫定。4 搬送波の和でも 1.0 を超えない） */
export const OUTPUT_GAIN = 0.25;

function checkInt(name: string, value: number, max: number): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new RangeError(`operatorFrequency: ${name} は 0〜${max} の整数にしてください（${name}=${value}）`);
  }
}

/** オペレーターの周波数（Hz）。A4（MIDI 69）= 440 Hz の平均律 */
export function operatorFrequency(note: number, bo: number, mul: number, dt: number): number {
  checkInt('note', note, 127);
  checkInt('bo', bo, 3);
  checkInt('mul', mul, 15);
  checkInt('dt', dt, 7);
  const base = 440 * 2 ** ((note - 69) / 12);
  // 添字は checkInt で表の範囲に収めてある
  return base * BO_TABLE[bo]! * MUL_TABLE[mul]! * 2 ** (DT_CENTS[dt]! / 1200);
}

/** 全ボイスの左右の和に掛ける係数（暫定。中央の 1 音は M1 の約 0.35 倍になる） */
export const MIX_GAIN = 0.5;
