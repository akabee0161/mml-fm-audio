import { describe, expect, it } from 'vitest';
import { extract } from './extract.ts';
import type { Extracted, RawNote } from './extract.ts';
import { quantize } from './quantize.ts';
import { readSmf } from './smf.ts';
import { buildSmf } from './smfBuilder.ts';
import type { SmfEvent } from './smf.ts';

function empty(): Extracted {
  return { notes: [], controls: [], tempos: [], markers: [], timeSignatures: [], discarded: new Map(), warnings: [] };
}
const note = (on: number, off: number, n = 60, channel = 0): RawNote => ({ channel, note: n, velocity: 100, on, off });
const withNotes = (...notes: RawNote[]): Extracted => ({ ...empty(), notes });

describe('quantize', () => {
  it('32 分音符単位（12 ティック）にそろえる', () => {
    const q = quantize(withNotes(note(13.2, 35)), 32);
    expect(q.notes.map((n) => [n.on, n.off])).toEqual([[12, 36]]);
  });

  it('480 の分解能で ±5 ティックずれた 16 分音符と 8 分の 3 連符をそろえる', () => {
    const events: SmfEvent[] = [];
    const add = (tick: number, n: number) => {
      events.push({ kind: 'noteOn', tick, channel: 0, note: n, velocity: 100 });
      events.push({ kind: 'noteOff', tick: tick + 110, channel: 0, note: n });
    };
    [0, 125, 235, 365].forEach((t, i) => add(t, 60 + i)); // 16 分音符 ×4（ずれあり）
    [485, 635, 805].forEach((t, i) => add(t, 70 + i)); // 8 分の 3 連符 ×3（ずれあり）
    const ex = extract(readSmf(buildSmf({ ticksPerQuarter: 480, tracks: [events] })));
    const q = quantize(ex, 16);
    const ons = (lo: number, hi: number) => q.notes.filter((n) => n.on >= lo && n.on < hi).map((n) => n.on);
    expect(ons(0, 96)).toEqual([0, 24, 48, 72]);
    expect(ons(96, 192)).toEqual([96, 128, 160]);
    expect(q.notes.every((n) => Number.isInteger(n.on) && Number.isInteger(n.off))).toBe(true);
  });

  it('普通の 32 分音符は 3 連に化けない', () => {
    const q = quantize(withNotes(note(12, 24, 60), note(24, 36, 61), note(36, 48, 62)), 32);
    expect(q.notes.map((n) => n.on)).toEqual([12, 24, 36]);
  });

  it('長さが 0 になったノートは単位 1 つ分にし、警告する', () => {
    const q = quantize(withNotes(note(13, 15)), 32);
    expect(q.notes.map((n) => [n.on, n.off])).toEqual([[12, 24]]);
    expect(q.warnings).toHaveLength(1);
    expect(q.warnings[0].message).toContain('チャンネル 1');
  });

  it('--quantize 16 では 24 ティック単位、3 連は 16 ティック', () => {
    const normal = quantize(withNotes(note(25, 47)), 16);
    expect(normal.notes.map((n) => [n.on, n.off])).toEqual([[24, 48]]);
    const triplet = quantize(withNotes(note(0, 15), note(33, 47), note(65, 79)), 16);
    expect(triplet.notes.map((n) => n.on)).toEqual([0, 32, 64]);
    expect(triplet.notes.map((n) => n.off)).toEqual([16, 48, 80]);
  });

  it('変化・テンポ・マーカーも同じ拍の選択でそろえる', () => {
    const ex: Extracted = {
      ...withNotes(note(0, 15), note(33, 47), note(65, 79)), // 拍 0 は 3 連
      controls: [{ tick: 33.4, channel: 0, kind: 'volume', value: 100 }, { tick: 100, channel: 0, kind: 'pan', value: 64 }],
      tempos: [{ tick: 31, bpm: 120 }],
      markers: [{ tick: 70, text: 'a' }],
      timeSignatures: [{ tick: 13, numerator: 4, denominator: 4 }],
    };
    const q = quantize(ex, 16);
    expect(q.controls.map((c) => c.tick)).toEqual([32, 96]); // 拍 1 は音がないので普通の単位
    expect(q.tempos[0].tick).toBe(32);
    expect(q.markers[0].tick).toBe(64);
    expect(q.timeSignatures[0].tick).toBe(16);
  });

  it('入力を変えず、discarded と元の警告を引き継ぐ', () => {
    const ex = { ...withNotes(note(13, 15)), discarded: new Map([['x', 2]]), warnings: [{ tick: 0, message: 'w' }] };
    const q = quantize(ex, 32);
    expect(ex.notes[0].on).toBe(13);
    expect(ex.warnings).toHaveLength(1);
    expect(q.discarded).toEqual(new Map([['x', 2]]));
    expect(q.warnings.map((w) => w.message)[0]).toBe('w');
    expect(q.warnings).toHaveLength(2);
  });

  it('量子化後も notes は on の順、controls は tick の順', () => {
    const ex: Extracted = {
      ...withNotes(note(11, 30, 60), note(13, 30, 61)),
      controls: [{ tick: 30, channel: 0, kind: 'pan', value: 1 }, { tick: 31, channel: 0, kind: 'volume', value: 2 }],
    };
    const q = quantize(ex, 32);
    expect(q.notes.map((n) => n.note)).toEqual([60, 61]);
    expect(q.controls.map((c) => c.kind)).toEqual(['pan', 'volume']);
  });

  it('量子化で重なった同じ音は、前のノートの off を次の on に縮める', () => {
    const q = quantize(withNotes(note(0, 30), note(25, 48)), 32);
    expect(q.notes.map((n) => [n.on, n.off])).toEqual([[0, 24], [24, 48]]);
  });

  it('縮めて長さ 0 になった前のノートは捨てる', () => {
    const q = quantize(withNotes(note(12, 24, 60), note(13, 40, 60)), 32);
    expect(q.notes.map((n) => [n.on, n.off])).toEqual([[12, 36]]);
  });

  it('チャンネルが違えば重なりを縮めない', () => {
    const q = quantize(withNotes(note(0, 36, 60, 0), note(12, 48, 60, 1)), 32);
    expect(q.notes.map((n) => n.off)).toEqual([36, 48]);
  });
});
