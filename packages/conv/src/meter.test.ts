import { describe, expect, it } from 'vitest';
import { createMeter } from './meter.ts';

describe('createMeter', () => {
  it('拍子がなければ 4/4', () => {
    const m = createMeter([]);
    expect(m.position(0)).toBe('1 小節 1 拍');
    expect(m.position(96 * 5)).toBe('2 小節 2 拍');
    expect(m.barEndAtOrAfter(10)).toBe(384);
    expect(m.barEndAtOrAfter(384)).toBe(384);
    expect(m.barEndAtOrAfter(0)).toBe(0);
  });

  it('3/4 に変わった後の位置と小節の終わり', () => {
    // 4/4 を 2 小節（768）してから 3/4（1 小節 288）
    const m = createMeter([
      { tick: 0, numerator: 4, denominator: 4 },
      { tick: 768, numerator: 3, denominator: 4 },
    ]);
    expect(m.position(768)).toBe('3 小節 1 拍');
    expect(m.position(768 + 288 + 96)).toBe('4 小節 2 拍');
    expect(m.barEndAtOrAfter(770)).toBe(768 + 288);
    expect(m.barEndAtOrAfter(700)).toBe(768);
  });

  it('頭が 6/8 の曲（1 小節 = 288、1 拍 = 48）', () => {
    const m = createMeter([{ tick: 0, numerator: 6, denominator: 8 }]);
    expect(m.position(288 + 48)).toBe('2 小節 2 拍');
    expect(m.barEndAtOrAfter(289)).toBe(576);
  });

  it('先頭より後から始まる拍子は、それまでを 4/4 とみなす', () => {
    const m = createMeter([{ tick: 384, numerator: 2, denominator: 4 }]);
    expect(m.barEndAtOrAfter(385)).toBe(384 + 192);
    expect(m.barEndAtOrAfter(100)).toBe(384);
  });
});
