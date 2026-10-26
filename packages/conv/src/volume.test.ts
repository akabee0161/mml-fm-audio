import { describe, expect, it } from 'vitest';
import { toMmlVolume } from './volume.ts';

describe('toMmlVolume', () => {
  it('GM の初期値（100・127）とベロシティ 100 は v12', () => {
    expect(toMmlVolume(100, 127, 100)).toBe(12);
  });
  it('すべて最大なら v15', () => {
    expect(toMmlVolume(127, 127, 127)).toBe(15);
  });
  it('どれかが 0 なら v0', () => {
    expect(toMmlVolume(100, 127, 0)).toBe(0);
    expect(toMmlVolume(0, 127, 100)).toBe(0);
    expect(toMmlVolume(100, 0, 100)).toBe(0);
  });
  it('0 でなければ小さくても v1 以上', () => {
    expect(toMmlVolume(1, 1, 1)).toBe(1);
  });
  it('ベロシティ 64 は約 -12 dB で v11', () => {
    expect(toMmlVolume(127, 127, 64)).toBe(11);
  });
});
