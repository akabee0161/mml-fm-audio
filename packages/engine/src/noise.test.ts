import { Noise } from './noise';

const take = (noise: Noise, n: number): number[] => Array.from({ length: n }, () => noise.next());

describe('Noise', () => {
  it('同じ種なら同じ列', () => {
    expect(take(new Noise(7), 1000)).toEqual(take(new Noise(7), 1000));
  });

  it('種が違えば列が違う', () => {
    expect(take(new Noise(7), 100)).not.toEqual(take(new Noise(8), 100));
  });

  it('値は −1 以上 1 未満で、平均はほぼ 0', () => {
    const values = take(new Noise(1), 48000);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(-1);
    expect(Math.max(...values)).toBeLessThan(1);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    expect(Math.abs(mean)).toBeLessThan(0.02);
  });

  it('種 0 でも 0 が続かない', () => {
    const values = take(new Noise(0), 10);
    expect(values.some((v) => v !== values[0])).toBe(true);
  });

  it('reset で最初からやり直せる', () => {
    const noise = new Noise(3);
    const first = take(noise, 50);
    noise.reset(3);
    expect(take(noise, 50)).toEqual(first);
  });
});
