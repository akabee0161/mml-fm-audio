import { Lfo } from './lfo';

describe('Lfo', () => {
  it('lfo=1 は 4 Hz の三角波（-1〜1）', () => {
    const lfo = new Lfo(1000);
    lfo.setRate(1);
    const values = Array.from({ length: 251 }, () => lfo.next());
    expect(Math.max(...values)).toBeCloseTo(1, 1);
    expect(Math.min(...values)).toBeCloseTo(-1, 1);
    expect(values[250]).toBeCloseTo(values[0]!, 5); // 250 サンプル = 1 周期
  });
});
