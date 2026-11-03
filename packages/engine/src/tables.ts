// 音源の表。「公開値」は YMF825 の IF 仕様書（YMF825_sample の manual）の値、
// 「暫定」は独自に決めた値で、試聴で調整してよい。

/** mul → 周波数の倍率（公開値） */
export const MUL_TABLE: readonly number[] = [0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 12, 12, 15, 15];

/**
 * bo → 周波数の倍率。IF 仕様書の比（×2, ×1, ×1/2, ×1/4）を保ったまま、
 * YMF825 の音色データがすべて使う bo=0 を標準の高さに置き直している（暫定）。
 */
export const BO_TABLE: readonly number[] = [1, 0.5, 0.25, 0.125];

/**
 * dt のずれの大きさ（録音との比較で決めた値）。行は d = 1〜3、列はキーコード 0〜31。
 * 周波数のずれ（Hz）= 値 × 48000 / 2^20。dt 5〜7 は同じ大きさで負、dt 0・4 はずらさない
 */
export const DT_TABLE: readonly (readonly number[])[] = [
  [0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 6, 6, 7, 8, 8, 8, 8],
  [1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 6, 6, 7, 8, 8, 9, 10, 11, 12, 13, 14, 16, 16, 16, 16],
  [2, 2, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 6, 6, 7, 8, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 20, 22, 22, 22, 22],
];

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
/** 変調側の出力 1.0 が搬送側の位相を何 rad ずらすか（録音との比較で決めた値） */
export const MOD_INDEX = 8 * Math.PI;
/** 1 ボイスの出力に掛ける係数（暫定。4 搬送波の和でも 1.0 を超えない） */
export const OUTPUT_GAIN = 0.25;

function checkTableIndex(name: string, value: number, max: number): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new RangeError(`operatorFrequency: ${name} は 0〜${max} の整数にしてください（${name}=${value}）`);
  }
}

/** オペレーターの周波数（Hz）。A4（MIDI 69）= 440 Hz の平均律 */
export function operatorFrequency(note: number, bo: number, mul: number, dt: number): number {
  checkTableIndex('note', note, 127);
  checkTableIndex('bo', bo, 3);
  checkTableIndex('mul', mul, 15);
  checkTableIndex('dt', dt, 7);
  const base = 440 * 2 ** ((note - 69) / 12);
  // 添字は checkTableIndex で表の範囲に収めてある。dt はまず Hz でずらし、その後に MULTI を掛ける
  let shift = 0;
  if (dt >= 1 && dt <= 3) shift = DT_TABLE[dt - 1]![keyCode(note, bo)]!;
  else if (dt >= 5) shift = -DT_TABLE[dt - 5]![keyCode(note, bo)]!;
  return (base * BO_TABLE[bo]! + (shift * 48000) / 2 ** 20) * MUL_TABLE[mul]!;
}

/** KSL による減衰（dB）。ノート 30 から効き始める（BO は含めない） */
export function kslAttenuation(ksl: number, note: number): number {
  return KSL_DB_PER_OCT[ksl]! * Math.max(0, (note - 30) / 12);
}

/** 全ボイスの左右の和に掛ける係数（暫定。中央の 1 音は M1 の約 0.35 倍になる） */
export const MIX_GAIN = 0.5;

/**
 * ノート番号と BO からキーコード（0〜31）を求める。
 * n = ノート − 12 × BO。block は G（43・55・67…）で変わり、sub は音名の位置で 2 か 3
 * （sub の境目は推測）。
 */
export function keyCode(note: number, bo: number): number {
  const n = note - 12 * bo;
  const block = Math.min(7, Math.max(0, Math.floor((n - 43) / 12) + 2));
  const k = (((n - 43) % 12) + 12) % 12;
  return 4 * block + (k <= 2 ? 2 : 3);
}
