import { describe, expect, it } from 'vitest';
import { ConvError } from './errors.ts';
import type { RawNote } from './extract.ts';
import { resolveLoop } from './loop.ts';
import { createMeter } from './meter.ts';
import type { Quantized } from './quantize.ts';

const song = (over: Partial<Quantized> = {}): Quantized => ({
  notes: [{ channel: 0, note: 60, velocity: 100, on: 0, off: 96 }],
  controls: [],
  tempos: [],
  markers: [],
  timeSignatures: [],
  discarded: new Map(),
  warnings: [],
  ...over,
});
const note = (on: number, off: number, n = 60): RawNote => ({ channel: 0, note: n, velocity: 100, on, off });
const meter = createMeter([]);
const mk = (tick: number, text: string) => ({ tick, text });

describe('resolveLoop', () => {
  it('マーカー loop・loopend（大文字小文字・前後の空白を区別しない）の位置をループにする', () => {
    const r = resolveLoop(song({ markers: [mk(96, ' LOOP '), mk(480, 'LoopEnd')] }), meter);
    expect(r.loop).toEqual({ start: 96, end: 480, fromMarkers: true });
  });

  it('マーカーがない曲は頭から、最後のノートオフを含む小節の終わりまで', () => {
    const r = resolveLoop(song({ notes: [note(0, 100), note(300, 400)] }), meter);
    expect(r.loop).toEqual({ start: 0, end: 768, fromMarkers: false });
  });

  it('最後のノートオフが小節線ちょうどなら、その小節線', () => {
    const r = resolveLoop(song({ notes: [note(0, 384)] }), meter);
    expect(r.loop.end).toBe(384);
  });

  it('loop だけは ConvError', () => {
    expect(() => resolveLoop(song({ markers: [mk(0, 'loop')] }), meter)).toThrow(ConvError);
    expect(() => resolveLoop(song({ markers: [mk(0, 'loop')] }), meter)).toThrow('loopend');
  });

  it('loopend だけ・順序が逆・同じ位置・2 つ以上は ConvError', () => {
    expect(() => resolveLoop(song({ markers: [mk(96, 'loopend')] }), meter)).toThrow('loop');
    expect(() => resolveLoop(song({ markers: [mk(200, 'loop'), mk(100, 'loopend')] }), meter)).toThrow('前');
    expect(() => resolveLoop(song({ markers: [mk(100, 'loop'), mk(100, 'loopend')] }), meter)).toThrow('同じ位置');
    expect(() =>
      resolveLoop(song({ markers: [mk(0, 'loop'), mk(96, 'loop'), mk(192, 'loopend')] }), meter),
    ).toThrow('2 つ以上');
    expect(() =>
      resolveLoop(song({ markers: [mk(0, 'loop'), mk(96, 'loopend'), mk(192, 'loopend')] }), meter),
    ).toThrow('2 つ以上');
  });

  it('ノートが 1 つもない曲は ConvError', () => {
    expect(() => resolveLoop(song({ notes: [] }), meter)).toThrow('ノートがありません');
  });

  it('loopend と同じ位置かそれより後を捨て、件数を警告 1 件にまとめる', () => {
    const over = note(90, 300, 62); // loopend の前にオンして越える：残る
    const input = song({
      markers: [mk(0, 'loop'), mk(192, 'loopend')],
      notes: [note(0, 96), over, note(192, 288, 64), note(400, 500, 65)],
      controls: [
        { tick: 100, channel: 0, kind: 'pan', value: 10 },
        { tick: 192, channel: 0, kind: 'pan', value: 20 },
        { tick: 192, channel: 0, kind: 'volume', value: 20 },
        { tick: 192, channel: 0, kind: 'program', value: 20 },
        { tick: 192, channel: 0, kind: 'bend', value: 20 },
        { tick: 300, channel: 0, kind: 'expression', value: 20 },
      ],
      tempos: [
        { tick: 0, bpm: 120 },
        { tick: 192, bpm: 100 },
      ],
      timeSignatures: [{ tick: 384, numerator: 3, denominator: 4 }],
      warnings: [{ tick: 5, message: '前の警告' }],
    });
    const copy = structuredClone(input);
    const r = resolveLoop(input, meter);
    expect(input).toEqual(copy); // 入力は変えない
    expect(r.song.notes).toEqual([note(0, 96), over]);
    expect(r.song.controls.map((c) => c.tick)).toEqual([100]);
    expect(r.song.tempos).toEqual([{ tick: 0, bpm: 120 }]);
    expect(r.song.markers).toEqual(input.markers);
    expect(r.song.timeSignatures).toEqual(input.timeSignatures);
    expect(r.song.warnings).toHaveLength(2);
    expect(r.song.warnings[0]).toEqual({ tick: 5, message: '前の警告' });
    expect(r.song.warnings[1].tick).toBe(192);
    expect(r.song.warnings[1].message).toBe('ループ終了（loopend）より後のノート 2 件・変化 6 件を捨てました');
  });

  it('捨てるものがなければ警告を足さない', () => {
    const r = resolveLoop(song({ markers: [mk(0, 'loop'), mk(384, 'loopend')] }), meter);
    expect(r.song.warnings).toEqual([]);
  });
});
