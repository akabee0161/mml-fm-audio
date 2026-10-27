import { TICKS_PER_QUARTER } from '../../sequencer/src/index.ts';
import type { Quantized } from './quantize.ts';

export interface Meter {
  /** 「12 小節 3 拍」（どちらも 1 から） */
  position(tick: number): string;
  /** tick を含む小節の終わり（次の小節線）。tick が小節線ちょうどならその tick */
  barEndAtOrAfter(tick: number): number;
}

const WHOLE_NOTE_TICKS = TICKS_PER_QUARTER * 4;

/** 同じ拍子が続く区間。start から barTicks ごとに小節線がある */
interface Segment { start: number; barTicks: number; beatTicks: number; barsBefore: number }

/**
 * 拍子（なければ 4/4）から小節と拍の位置を求める。1 小節 = numerator * 384 / denominator ティック。
 * 拍子の変化が小節の途中にあっても、その tick から新しい拍子の小節が始まるとみなす。
 */
export function createMeter(timeSignatures: Quantized['timeSignatures']): Meter {
  const sorted = [...timeSignatures].sort((a, b) => a.tick - b.tick);
  const raw = sorted[0]?.tick === 0 ? sorted : [{ tick: 0, numerator: 4, denominator: 4 }, ...sorted];

  const segments: Segment[] = [];
  let barsBefore = 0;
  for (const [i, ts] of raw.entries()) {
    const beatTicks = WHOLE_NOTE_TICKS / ts.denominator;
    const seg: Segment = { start: ts.tick, barTicks: ts.numerator * beatTicks, beatTicks, barsBefore };
    segments.push(seg);
    const next = raw[i + 1];
    if (next) barsBefore += Math.ceil((next.tick - ts.tick) / seg.barTicks);
  }

  const segmentAt = (tick: number): { seg: Segment; next: Segment | undefined } => {
    let i = 0;
    while (i + 1 < segments.length && segments[i + 1].start <= tick) i++;
    return { seg: segments[i], next: segments[i + 1] };
  };

  return {
    position(tick) {
      const { seg } = segmentAt(tick);
      const offset = tick - seg.start;
      const bar = seg.barsBefore + Math.floor(offset / seg.barTicks) + 1;
      const beat = Math.floor((offset % seg.barTicks) / seg.beatTicks) + 1;
      return `${bar} 小節 ${beat} 拍`;
    },
    barEndAtOrAfter(tick) {
      const { seg, next } = segmentAt(tick);
      const end = seg.start + Math.ceil((tick - seg.start) / seg.barTicks) * seg.barTicks;
      return next ? Math.min(end, next.start) : end;
    },
  };
}
