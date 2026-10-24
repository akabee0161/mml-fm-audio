import { describe, expect, it } from 'vitest';
import { Timeline, tickToSeconds } from './timing.ts';
import { parseMml } from './parser.ts';

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

  it('ループ終了を越える tick の巻き戻しは、1 周ずつ戻す素朴な実装と一致する', () => {
    const naive = (tl: Timeline, pass: number, tick: number, ls: number, le: number) => {
      while (tick >= le) { pass += 1; tick = ls + (tick - le); }
      return tl.seconds(pass, tick);
    };
    for (const [ls, le] of [[96, 288], [0, 1], [10, 11], [0, 192], [5, 1000]] as const) {
      const tl = new Timeline({ tempos, loopStart: ls, loopEnd: le });
      for (const tick of [le, le + 1, le + (le - ls), le + 3 * (le - ls) - 1, le + 5 * (le - ls), 5000, 123457]) {
        for (const pass of [0, 1, 3]) {
          if (pass >= 1 && tick < ls) continue;
          expect(tl.seconds(pass, tick)).toBe(naive(tl, pass, tick, ls, le));
        }
      }
    }
  });

  it('ループが 1 ティックで 1e12 ティック先でも一瞬で返る', () => {
    const tl = new Timeline({ tempos, loopStart: 0, loopEnd: 1 });
    const t = performance.now();
    tl.seconds(0, 1e12);
    expect(performance.now() - t).toBeLessThan(50);
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

/** 旧実装（先頭からの走査）。二分探索版と同じ値になることの基準 */
function naiveSeconds(tempos: readonly { tick: number; bpm: number }[], tick: number): number {
  let seconds = 0;
  for (let i = 0; i < tempos.length && tempos[i].tick < tick; i++) {
    const end = i + 1 < tempos.length ? Math.min(tempos[i + 1].tick, tick) : tick;
    seconds += ((end - tempos[i].tick) * 60) / (96 * tempos[i].bpm);
  }
  return seconds;
}

describe('Timeline：テンポが非常に多い曲', () => {
  it('テンポ 4 万件・ノート 4 万個の秒の計算が速い', () => {
    const song = parseMml('A [[t120 c%1]200]200');
    expect(song.errors).toEqual([]);
    expect(song.tempos).toHaveLength(40000);
    const started = performance.now();
    const tl = new Timeline(song);
    let sum = 0;
    for (const ev of song.tracks[0].events) {
      if (ev.type !== 'note') continue;
      sum += tl.seconds(0, ev.tick) + tl.seconds(0, ev.tick + ev.gate);
    }
    expect(sum).toBeGreaterThan(0);
    expect(performance.now() - started).toBeLessThan(500); // 同期の処理はタイムアウトで止まらないため、経過時間で確かめる
  });

  it('テンポ変更の境目（ちょうど・1 つ前・最後のテンポの後ろ）で旧実装と同じ値', () => {
    const tempos = [{ tick: 0, bpm: 120 }, { tick: 100, bpm: 90 }, { tick: 250, bpm: 77.5 }, { tick: 400, bpm: 200 }];
    const tl = new Timeline({ tempos, loopStart: null, loopEnd: 1000 });
    for (const tick of [0, 1, 99, 100, 101, 249, 250, 251, 399, 400, 401, 999]) {
      expect(tl.seconds(0, tick)).toBe(naiveSeconds(tempos, tick));
    }
  });

  it('ループありでも境目で旧実装と同じ値', () => {
    const tempos = [{ tick: 0, bpm: 120 }, { tick: 100, bpm: 90 }, { tick: 250, bpm: 77.5 }];
    const tl = new Timeline({ tempos, loopStart: 100, loopEnd: 250 });
    expect(tl.seconds(0, 250)).toBe(naiveSeconds(tempos, 250));
    expect(tl.seconds(1, 100)).toBe(naiveSeconds(tempos, 250));
    expect(tl.seconds(1, 249)).toBeCloseTo(naiveSeconds(tempos, 250) + naiveSeconds(tempos, 249) - naiveSeconds(tempos, 100), 12);
  });
});
