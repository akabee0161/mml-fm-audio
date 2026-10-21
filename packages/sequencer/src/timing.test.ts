import { describe, expect, it } from 'vitest';
import { Timeline, tickToSeconds } from './timing.ts';

describe('tickToSeconds', () => {
  it('テンポ 120 で 96 ティックは 0.5 秒', () => {
    expect(tickToSeconds([{ tick: 0, bpm: 120 }], 96)).toBe(0.5);
  });
  it('テンポの区切りごとに足す（120 で 192 ティック＝1 秒、60 で 192 ティック＝2 秒）', () => {
    const tempos = [{ tick: 0, bpm: 120 }, { tick: 192, bpm: 60 }];
    expect(tickToSeconds(tempos, 384)).toBe(3);
    expect(tickToSeconds(tempos, 192)).toBe(1);
    expect(tickToSeconds(tempos, 100)).toBeCloseTo(100 / 192, 12);
  });
});

describe('Timeline', () => {
  const tempos = [{ tick: 0, bpm: 120 }];
  const loop = { tempos, loopStart: 96, loopEnd: 288 };

  it('ループの回ごとの秒', () => {
    const tl = new Timeline(loop);
    expect(tl.seconds(0, 0)).toBe(0);
    expect(tl.seconds(0, 288)).toBe(1.5);
    expect(tl.seconds(1, 96)).toBe(1.5);
    expect(tl.seconds(1, 192)).toBe(2);
    expect(tl.seconds(2, 96)).toBe(2.5);
  });

  it('ループ終了を越える tick は次の回の loopStart から数える', () => {
    const tl = new Timeline(loop);
    expect(tl.seconds(0, 336)).toBe(1.75);
    expect(tl.seconds(0, 336)).toBe(tl.seconds(1, 144));
    expect(tl.seconds(1, 336)).toBe(tl.seconds(2, 144));
  });

  it('テンポの戻り：L の位置のテンポ 120 で進み直す', () => {
    const tl = new Timeline({ tempos: [{ tick: 0, bpm: 120 }, { tick: 192, bpm: 60 }], loopStart: 96, loopEnd: 288 });
    expect(tl.seconds(1, 192) - tl.seconds(1, 96)).toBeCloseTo(0.5, 12);
    // 1 周の長さは 120 で 96 ティック（0.5 秒）＋ 60 で 96 ティック（1 秒）
    expect(tl.seconds(2, 96) - tl.seconds(1, 96)).toBeCloseTo(1.5, 12);
  });

  it('1000 回目のループでも誤差が 1e-9 秒未満', () => {
    const tl = new Timeline(loop);
    expect(Math.abs(tl.seconds(1000, 96) - (1.5 + 999 * 1))).toBeLessThan(1e-9);
    expect(Math.abs(tl.seconds(1000, 192) - (1.5 + 999 * 1 + 0.5))).toBeLessThan(1e-9);
  });

  it('ループしない曲は pass 0 だけ', () => {
    const tl = new Timeline({ tempos, loopStart: null, loopEnd: 288 });
    expect(tl.seconds(0, 96)).toBe(0.5);
    expect(() => tl.seconds(1, 0)).toThrow();
  });

  it('範囲外の引数は例外', () => {
    const tl = new Timeline(loop);
    expect(() => tl.seconds(1, 95)).toThrow();
    expect(() => tl.seconds(-1, 0)).toThrow();
    expect(() => tl.seconds(1.5, 100)).toThrow();
  });
});
