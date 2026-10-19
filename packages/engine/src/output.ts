export function clampSample(x: number): number {
  return Math.max(-1, Math.min(1, x));
}

/** 16bit 相当の刻みに丸める */
export function quantize16(x: number): number {
  return Math.round(clampSample(x) * 32767) / 32767;
}
