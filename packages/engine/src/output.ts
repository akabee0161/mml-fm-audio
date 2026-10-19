export function clampSample(x: number): number {
  return Math.max(-1, Math.min(1, x));
}

/** 16bit 相当の刻みに丸める */
export function quantize16(x: number): number {
  return Math.round(clampSample(x) * 32767) / 32767;
}

/**
 * パン（0〜127）→ 左右の係数。等パワーで、64 をちょうど中央（π/4）にする。
 * 0〜64 と 64〜127 で刻みが違うのは、MML の p64 や SMF の CC10=64 を中央として扱うため。
 */
export function panGains(pan: number): [left: number, right: number] {
  const theta = pan <= 64 ? (pan / 64) * (Math.PI / 4) : Math.PI / 4 + ((pan - 64) / 63) * (Math.PI / 4);
  return [Math.cos(theta), Math.cos(Math.PI / 2 - theta)];
}
