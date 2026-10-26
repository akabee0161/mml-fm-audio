import { ConvError } from './errors.ts';
import type { Meter } from './meter.ts';
import type { Quantized } from './quantize.ts';

export interface LoopRange { start: number; end: number; fromMarkers: boolean }

const markerTicks = (song: Quantized, name: string): number[] =>
  song.markers.filter((m) => m.text.trim().toLowerCase() === name).map((m) => m.tick);

/**
 * ループの範囲を決め、loopend の位置かそれより後のノートオンと変化・テンポを捨てた Quantized を返す
 * （捨てた件数は警告 1 件）。入力は変えない。マーカーがなければ頭から最後のノートオフを含む小節の終わりまで。
 */
export function resolveLoop(song: Quantized, meter: Meter): { song: Quantized; loop: LoopRange } {
  if (song.notes.length === 0) throw new ConvError('ノートがありません');

  const loops = markerTicks(song, 'loop');
  const ends = markerTicks(song, 'loopend');
  if (loops.length > 1) throw new ConvError(`マーカー loop が 2 つ以上あります（${loops.length} 個）。1 つにしてください`);
  if (ends.length > 1) throw new ConvError(`マーカー loopend が 2 つ以上あります（${ends.length} 個）。1 つにしてください`);
  if (loops.length !== ends.length) {
    const [has, lacks] = loops.length ? ['loop', 'loopend'] : ['loopend', 'loop'];
    throw new ConvError(`マーカー ${has} はありますが ${lacks} がありません。両方つけるか、両方外してください`);
  }

  if (loops.length === 0) {
    const lastOff = Math.max(...song.notes.map((n) => n.off));
    return { song, loop: { start: 0, end: meter.barEndAtOrAfter(lastOff), fromMarkers: false } };
  }

  const [start] = loops;
  const [end] = ends;
  if (end === start) {
    throw new ConvError(`マーカー loopend が loop と同じ位置（${meter.position(end)}）にあります。loopend は loop より後ろに置いてください`);
  }
  if (end < start) {
    throw new ConvError(
      `マーカー loopend（${meter.position(end)}）が loop（${meter.position(start)}）より前にあります。loopend は loop より後ろに置いてください`,
    );
  }

  const notes = song.notes.filter((n) => n.on < end);
  const controls = song.controls.filter((c) => c.tick < end);
  const tempos = song.tempos.filter((t) => t.tick < end);
  const droppedNotes = song.notes.length - notes.length;
  const droppedChanges = song.controls.length - controls.length + song.tempos.length - tempos.length;

  const warnings = [...song.warnings];
  if (droppedNotes > 0 || droppedChanges > 0) {
    warnings.push({
      tick: end,
      message: `ループ終了（loopend）より後のノート ${droppedNotes} 件・変化 ${droppedChanges} 件を捨てました`,
    });
  }
  return { song: { ...song, notes, controls, tempos, warnings }, loop: { start, end, fromMarkers: true } };
}
