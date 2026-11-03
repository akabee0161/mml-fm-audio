import { DT_TABLE, MOD_INDEX, MUL_TABLE, TL_DB_PER_STEP, keyCode, kslAttenuation, operatorFrequency } from './tables';

describe('keyCode', () => {
  it('ノートからキーコードを求める（ブロックは G で変わる）', () => {
    expect(keyCode(60, 0)).toBe(15);
    expect(keyCode(36, 0)).toBe(7);
    expect(keyCode(42, 0)).toBe(7);
    expect(keyCode(43, 0)).toBe(10);
    expect(keyCode(45, 0)).toBe(10);
    expect(keyCode(46, 0)).toBe(11);
  });

  it('BO 1 は 12 下げて数える', () => {
    expect(keyCode(72, 1)).toBe(keyCode(60, 0));
  });

  it('block は 0〜7 に止まる', () => {
    expect(keyCode(0, 3)).toBe(3);
    expect(keyCode(127, 0)).toBe(30);
    expect(keyCode(126, 0)).toBe(31);
  });
});

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

  it('dt は Hz でずらす', () => {
    const d = operatorFrequency(72, 0, 1, 3) - operatorFrequency(72, 0, 1, 0);
    expect(d).toBeCloseTo(0.4578, 3);
    expect(operatorFrequency(72, 0, 1, 7) - operatorFrequency(72, 0, 1, 0)).toBeCloseTo(-d, 9);
    expect(operatorFrequency(72, 0, 1, 4)).toBe(operatorFrequency(72, 0, 1, 0));
    // MULTI はずらした後に掛ける
    expect(operatorFrequency(72, 0, 2, 3) - operatorFrequency(72, 0, 2, 0)).toBeCloseTo(2 * d, 9);
  });

  it('DT の表は kc 0〜31 の 32 個ずつ', () => {
    expect(DT_TABLE.length).toBe(3);
    for (const row of DT_TABLE) expect(row.length).toBe(32);
    expect(DT_TABLE[2]![31]).toBe(22);
  });

  it('端のノート・BO でも周波数は有限の正の数', () => {
    for (const f of [operatorFrequency(0, 3, 0, 7), operatorFrequency(127, 0, 15, 3)]) {
      expect(Number.isFinite(f)).toBe(true);
      expect(f).toBeGreaterThan(0);
    }
  });

  it('変調指数は TL 20 で 4.45 rad', () => {
    expect(MOD_INDEX * 10 ** (-(20 * TL_DB_PER_STEP) / 20)).toBeCloseTo(4.45, 1);
  });

  it('kslAttenuation はノート 30 から効き始める', () => {
    expect(kslAttenuation(1, 54)).toBe(6);
    expect(kslAttenuation(3, 30)).toBe(0);
    expect(kslAttenuation(3, 20)).toBe(0);
    expect(kslAttenuation(2, 42)).toBe(1.5);
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

  it('operatorFrequency は mul・dt・bo の下限（-1）・小数・NaN も RangeError', () => {
    for (const bad of [-1, 0.5, Number.NaN, Infinity]) {
      expect(() => operatorFrequency(60, bad, 1, 0)).toThrow(/bo/);
      expect(() => operatorFrequency(60, 0, bad, 0)).toThrow(/mul/);
      expect(() => operatorFrequency(60, 0, 1, bad)).toThrow(/dt/);
      expect(() => operatorFrequency(bad, 0, 1, 0)).toThrow(/note/);
    }
  });
});
