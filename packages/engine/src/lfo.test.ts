import { Lfo } from './lfo';

describe('Lfo', () => {
  it('三角波（-1〜1）', () => {
    const lfo = new Lfo(1000);
    lfo.setRate(1);
    const values = Array.from({ length: 240 }, () => lfo.next());
    expect(Math.max(...values)).toBeCloseTo(1, 1);
    expect(Math.min(...values)).toBeCloseTo(-1, 1);
  });

  it('lfo=1 は 4.2 Hz', () => {
    const lfo = new Lfo(4200);
    lfo.setRate(1);
    const values = Array.from({ length: 1001 }, () => lfo.next());
    expect(values[1000]).toBeCloseTo(values[0]!, 5); // 1000 サンプル = 1 周期
    expect(values[500]).toBeCloseTo(1, 5);
    expect(values[250]).toBeCloseTo(0, 5);
  });

  it('reset で -1 から始まる', () => {
    const lfo = new Lfo(1000);
    lfo.setRate(2);
    for (let i = 0; i < 123; i++) lfo.next();
    lfo.reset();
    expect(lfo.next()).toBeCloseTo(-1, 6);
  });
});
