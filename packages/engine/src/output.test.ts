import { clampSample, quantize16 } from './output';

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
