const dB = (value: number): number => 40 * Math.log10(value / 127);

/**
 * チャンネルボリューム・エクスプレッション・ベロシティ（どれも 0〜127）を MML の v（0〜15）に換える。
 * 各値を 40 * log10(値 / 127) dB とみなして足し、v = 15 + round(合計 / 3)（1 段 3 dB）。
 * どれかが 0 なら 0、それ以外は 1〜15 に収める。
 */
export function toMmlVolume(channelVolume: number, expression: number, velocity: number): number {
  if (channelVolume <= 0 || expression <= 0 || velocity <= 0) return 0;
  const steps = 15 + Math.round((dB(channelVolume) + dB(expression) + dB(velocity)) / 3);
  return Math.min(15, Math.max(1, steps));
}
