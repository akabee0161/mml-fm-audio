import { TABLE_SIZE, WAVE_TABLES, isDefinedWave, voiceWarnings, waveValue } from './waveforms';
import type { DrumVoice, FmOperator, FmVoice } from './voiceData';

const S = Math.SQRT1_2; // sin(π/4)

// [番号, [x, 期待値] の組]
const POINTS: Array<[number, Array<[number, number]>]> = [
  [0, [[0, 0], [0.125, S], [0.25, 1], [0.5, 0], [0.75, -1]]],
  [1, [[0.25, 1], [0.75, 0]]],
  [2, [[0.25, 1], [0.75, 1]]],
  [3, [[0.125, S], [0.375, 0], [0.625, S], [0.875, 0]]],
  [4, [[0.125, 1], [0.375, -1], [0.75, 0]]],
  [5, [[0.125, 1], [0.375, 1], [0.75, 0]]],
  [6, [[0.25, 1], [0.75, -1]]],
  [7, [[0, 1], [0.5, -1 / 256], [0.999, -(2 ** (-16 * 0.001))]]],
  [8, [[0.25, 1], [0.125, 1], [0.75, -1]]],
  [14, [[0.25, 1], [0.75, 0]]],
  [16, [[0.125, 0.5], [0.25, 1], [0.5, 0], [0.75, -1]]],
  [17, [[0.25, 1], [0.75, 0]]],
  [22, [[0.125, 1], [0.375, 0], [0.625, 1], [0.875, 0]]],
  [24, [[0, 0], [0.25, 0.5], [0.75, -0.5]]],
  [26, [[0.25, 0.5], [0.75, 0.5]]],
  [30, [[0.125, 1], [0.375, 0]]],
];

describe('waveValue', () => {
  for (const [wave, points] of POINTS) {
    it(`波形 ${wave} の代表点`, () => {
      for (const [x, expected] of points) {
        expect(waveValue(wave, x)).toBeCloseTo(expected, 5);
      }
    });
  }

  it('頭を平らに切ったサイン（8）は ±1 を超えない', () => {
    for (let i = 0; i < 100; i++) {
      expect(Math.abs(waveValue(8, i / 100))).toBeLessThanOrEqual(1);
    }
  });

  it('空き番号はサインと同じ', () => {
    for (const wave of [15, 23, 31]) {
      expect(waveValue(wave, 0.25)).toBeCloseTo(1, 5);
      expect(waveValue(wave, 0.75)).toBeCloseTo(-1, 5);
    }
  });

  it('waveValue は範囲外の引数で RangeError', () => {
    expect(() => waveValue(32, 0)).toThrow(RangeError);
    expect(() => waveValue(-1, 0)).toThrow(RangeError);
    expect(() => waveValue(0, 1)).toThrow(RangeError);
    expect(() => waveValue(0, -0.1)).toThrow(RangeError);
    expect(() => waveValue(0, Number.NaN)).toThrow(RangeError);
    expect(waveValue(0, 0.25)).toBeCloseTo(1, 12);
  });

  it('waveValue は wave の小数（1.5）・x の無限大・NaN も RangeError', () => {
    expect(() => waveValue(1.5, 0)).toThrow(RangeError);
    expect(() => waveValue(Number.NaN, 0)).toThrow(RangeError);
    expect(() => waveValue(0, Infinity)).toThrow(RangeError);
    expect(() => waveValue(0, -Infinity)).toThrow(RangeError);
  });
});

describe('WAVE_TABLES', () => {
  it('32 個の表があり、それぞれ TABLE_SIZE 点', () => {
    expect(WAVE_TABLES).toHaveLength(32);
    for (const table of WAVE_TABLES) expect(table).toHaveLength(TABLE_SIZE);
  });

  it('表の値は waveValue と一致する', () => {
    expect(WAVE_TABLES[0]![256]).toBeCloseTo(1, 5);
    expect(WAVE_TABLES[16]![128]).toBeCloseTo(0.5, 5);
  });
});

describe('isDefinedWave / voiceWarnings', () => {
  it('15・23・31 だけが未定義', () => {
    const undefinedWaves = Array.from({ length: 32 }, (_, i) => i).filter((w) => !isDefinedWave(w));
    expect(undefinedWaves).toEqual([15, 23, 31]);
  });

  it('使っているオペレーターの未定義波形だけを警告する', () => {
    const op = (wave: number): FmOperator => ({
      wave, mul: 1, dt: 0, tl: 0, ar: 15, dr: 0, sl: 0, sr: 0, rr: 15,
      ksl: 0, ksr: 0, fb: 0, am: 0, amDepth: 0, vib: 0, vibDepth: 0, xof: 0,
    });
    const voice: FmVoice = { id: null, name: 'T', kind: 'fm', bo: 0, alg: 1, lfo: 0, ops: [op(0), op(23), op(31), op(15)] };
    expect(voiceWarnings(voice)).toEqual(['T の ops[1].wave: 波形 23 は未定義のため、サインで代わりに鳴らします']);
  });

  it('ドラムは FM 部の音色の未定義波形を警告し、FM 部がなければ何も言わない', () => {
    const op = (wave: number): FmOperator => ({
      wave, mul: 1, dt: 0, tl: 0, ar: 15, dr: 1, sl: 15, sr: 0, rr: 15,
      ksl: 0, ksr: 0, fb: 0, am: 0, amDepth: 0, vib: 0, vibDepth: 0, xof: 0,
    });
    const body: FmVoice = { id: null, name: 'B', kind: 'fm', bo: 0, alg: 1, lfo: 0, ops: [op(23), op(0)] };
    const drum: DrumVoice = { id: 128, name: 'bd', kind: 'drum', fm: { voice: body, note: 36, level: 1 } };
    expect(voiceWarnings(drum)).toEqual(['B の ops[0].wave: 波形 23 は未定義のため、サインで代わりに鳴らします']);
    expect(voiceWarnings({ id: 130, name: 'ch', kind: 'drum' })).toEqual([]);
  });
});
