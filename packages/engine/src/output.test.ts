import { clampSample, panGains, quantize16 } from './output';

describe('quantize16', () => {
  it('16bit の刻みに丸める', () => {
    expect(quantize16(0.5)).toBe(Math.round(0.5 * 32767) / 32767);
    expect(quantize16(1e-6)).toBe(0);
  });

  it('±1 を超えない', () => {
    expect(quantize16(2)).toBe(1);
    expect(quantize16(-2)).toBe(-1);
  });
});

describe('clampSample', () => {
  it('±1 に収める', () => {
    expect(clampSample(1.5)).toBe(1);
    expect(clampSample(-1.5)).toBe(-1);
    expect(clampSample(0.3)).toBe(0.3);
  });
});

describe('panGains', () => {
  it('0 は左だけ', () => {
    const [l, r] = panGains(0);
    expect(l).toBe(1);
    expect(r).toBeLessThan(1e-12);
  });

  it('127 は右だけ', () => {
    const [l, r] = panGains(127);
    expect(l).toBeLessThan(1e-12);
    expect(r).toBe(1);
  });

  it('64 はちょうど中央', () => {
    const [l, r] = panGains(64);
    expect(l).toBe(r);
    expect(l).toBeCloseTo(Math.SQRT1_2, 12);
  });

  it('全域で左右の二乗和は 1（等パワー）で、右へ行くほど右が大きい', () => {
    let prevRight = -1;
    for (let pan = 0; pan <= 127; pan++) {
      const [l, r] = panGains(pan);
      expect(l * l + r * r).toBeCloseTo(1, 12);
      expect(r).toBeGreaterThan(prevRight);
      prevRight = r;
    }
  });
});
