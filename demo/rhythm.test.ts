import { DRUM_PROGRAMS, RHYTHM_PATTERN, catchUpBar, scheduleBar } from './rhythm';

describe('リズム', () => {
  it('ドラムの番号は 128〜135（設計書 §5 の順）', () => {
    expect(DRUM_PROGRAMS).toEqual({ bd: 128, sd: 129, ch: 130, oh: 131, cy: 132, lt: 133, ht: 134, cp: 135 });
  });

  it('パターンに 8 種すべてがあり、tick は 0〜15', () => {
    expect(new Set(RHYTHM_PATTERN.map((s) => s.drum))).toEqual(new Set(Object.keys(DRUM_PROGRAMS)));
    for (const step of RHYTHM_PATTERN) {
      expect(Number.isInteger(step.tick)).toBe(true);
      expect(step.tick).toBeGreaterThanOrEqual(0);
      expect(step.tick).toBeLessThanOrEqual(15);
    }
  });

  it('scheduleBar はテンポ 120 で 16 分音符（48000 Hz で 6000 サンプル）刻みの時刻を返す', () => {
    const events = scheduleBar(1000, 48000, 120);
    expect(events).toHaveLength(RHYTHM_PATTERN.length);
    RHYTHM_PATTERN.forEach((step, i) => {
      expect(events[i]).toEqual({ time: 1000 + step.tick * 6000, program: DRUM_PROGRAMS[step.drum] });
    });
  });
});

describe('catchUpBar', () => {
  it('次の小節頭が今より後なら、そのまま', () => {
    expect(catchUpBar(1000, 500, 96000)).toBe(1000);
  });

  it('タブが裏にあって小節頭を過ぎていたら、今より後の小節頭まで飛ばす（逃した小節は送らない）', () => {
    expect(catchUpBar(1000, 1000 + 96000 * 3 + 5, 96000)).toBe(1000 + 96000 * 4);
  });
});
