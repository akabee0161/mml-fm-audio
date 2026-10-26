import { TICKS_PER_QUARTER } from '../../sequencer/src/index.ts';
import type { ConvWarning, Extracted, RawNote } from './extract.ts';

export const QUANTIZE_UNITS = [4, 8, 16, 32, 64] as const;
export type QuantizeUnit = (typeof QUANTIZE_UNITS)[number];
/** Extracted と同じ形で、すべての tick が整数。discarded はそのまま引き継ぐ */
export type Quantized = Extracted;

const WHOLE_NOTE_TICKS = TICKS_PER_QUARTER * 4;

const beatOf = (tick: number): number => Math.floor(tick / TICKS_PER_QUARTER);
const nearest = (tick: number, grid: number): number => Math.round(tick / grid) * grid;
const byKey = (a: { channel: number; note: number }): number => a.channel * 128 + a.note;

/**
 * ノートと変化の時刻を、`unit` 分音符の格子にそろえる。拍ごとに普通の格子と 3 連の格子のずれを比べ、
 * 3 連のほうが小さい拍だけ 3 連でそろえる。入力は変えず、新しい Extracted を返す。
 */
export function quantize(ex: Extracted, unit: QuantizeUnit): Quantized {
  const normal = WHOLE_NOTE_TICKS / unit;
  const triplet = (normal * 2) / 3;

  // 拍ごとに、ノートのオン・オフの時刻のずれの合計を格子別に集める
  const errors = new Map<number, { normal: number; triplet: number }>();
  const addError = (tick: number) => {
    const beat = beatOf(tick);
    const e = errors.get(beat) ?? { normal: 0, triplet: 0 };
    e.normal += Math.abs(tick - nearest(tick, normal));
    e.triplet += Math.abs(tick - nearest(tick, triplet));
    errors.set(beat, e);
  };
  for (const n of ex.notes) {
    addError(n.on);
    addError(n.off);
  }
  /** その時刻の属する拍の格子の単位。3 連のほうがずれが小さいときだけ 3 連 */
  const gridAt = (tick: number): number => {
    const e = errors.get(beatOf(tick));
    return e && e.triplet < e.normal ? triplet : normal;
  };
  const snap = (tick: number): number => nearest(tick, gridAt(tick));

  const warnings: ConvWarning[] = [...ex.warnings];
  const notes: RawNote[] = ex.notes.map((n) => {
    const on = snap(n.on);
    let off = snap(n.off);
    if (off <= on) {
      off = on + gridAt(on);
      warnings.push({
        tick: on,
        message: `チャンネル ${n.channel + 1} のノート ${n.note} は量子化で長さが 0 になるため、単位 1 つ分に延ばします`,
      });
    }
    return { ...n, on, off };
  });
  notes.sort((a, b) => a.on - b.on); // 安定ソート。同じ on は元の順

  // 量子化で同じ音が重なったら、前のノートを次の on で終える。長さ 0 になったら捨てる
  const lastOf = new Map<number, RawNote>();
  const dropped = new Set<RawNote>();
  for (const n of notes) {
    const key = byKey(n);
    const prev = lastOf.get(key);
    if (prev && prev.off > n.on) {
      prev.off = n.on;
      if (prev.off <= prev.on) dropped.add(prev);
    }
    lastOf.set(key, n);
  }

  const at = <T extends { tick: number }>(items: T[]): T[] =>
    items.map((item) => ({ ...item, tick: snap(item.tick) })).sort((a, b) => a.tick - b.tick);

  return {
    notes: notes.filter((n) => !dropped.has(n)),
    controls: at(ex.controls),
    tempos: at(ex.tempos),
    markers: at(ex.markers),
    timeSignatures: at(ex.timeSignatures),
    discarded: ex.discarded,
    warnings,
  };
}
