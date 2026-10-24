import { DT_CENTS, MUL_TABLE, operatorFrequency } from './tables';

describe('MUL_TABLE', () => {
  it('IF 仕様書の倍率どおりで、線形でない', () => {
    expect(MUL_TABLE).toEqual([0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 12, 12, 15, 15]);
  });
});

describe('operatorFrequency', () => {
  it('bo=0・mul=1・dt=0 で MIDI ノート 69 は 440 Hz', () => {
    expect(operatorFrequency(69, 0, 1, 0)).toBeCloseTo(440, 6);
  });

  it('ノートが 12 上がると 2 倍になる', () => {
    expect(operatorFrequency(81, 0, 1, 0)).toBeCloseTo(880, 6);
  });

  it('bo は 0 を基準に 1 段ごとに 1 オクターブ下げる', () => {
    expect(operatorFrequency(69, 1, 1, 0)).toBeCloseTo(220, 6);
    expect(operatorFrequency(69, 3, 1, 0)).toBeCloseTo(55, 6);
  });

  it('mul の倍率を掛ける', () => {
    expect(operatorFrequency(69, 0, 0, 0)).toBeCloseTo(220, 6);
    expect(operatorFrequency(69, 0, 11, 0)).toBeCloseTo(4400, 6);
  });

  it('dt は表の cent だけずらす', () => {
    expect(DT_CENTS).toEqual([0, 3, 6, 9, 0, -3, -6, -9]);
    expect(operatorFrequency(69, 0, 1, 1)).toBeCloseTo(440 * 2 ** (3 / 1200), 6);
    expect(operatorFrequency(69, 0, 1, 5)).toBeCloseTo(440 * 2 ** (-3 / 1200), 6);
  });

  it('operatorFrequency は範囲外の引数で RangeError', () => {
    expect(() => operatorFrequency(128, 0, 1, 0)).toThrow(RangeError);
    expect(() => operatorFrequency(-1, 0, 1, 0)).toThrow(RangeError);
    expect(() => operatorFrequency(60, 4, 1, 0)).toThrow(RangeError);
    expect(() => operatorFrequency(60, 0, 16, 0)).toThrow(RangeError);
    expect(() => operatorFrequency(60, 0, 1, 8)).toThrow(RangeError);
    expect(() => operatorFrequency(60.5, 0, 1, 0)).toThrow(RangeError);
    expect(operatorFrequency(69, 0, 1, 0)).toBeCloseTo(440, 9);
  });
});
