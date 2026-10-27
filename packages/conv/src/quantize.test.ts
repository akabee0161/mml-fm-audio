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

  it('ドラムの短いノートオフに引っ張られず、普通の 32 分音符が 3 連に化けない', () => {
    // 480 の分解能。メロディ c8 d16 e32 f32 に、長さ 30 の 16 分のハイハットとバスドラム
    const events: SmfEvent[] = [
      { kind: 'noteOn', tick: 0, channel: 0, note: 72, velocity: 100 },
      { kind: 'noteOff', tick: 240, channel: 0, note: 72 },
      { kind: 'noteOn', tick: 240, channel: 0, note: 74, velocity: 100 },
      { kind: 'noteOff', tick: 360, channel: 0, note: 74 },
      { kind: 'noteOn', tick: 360, channel: 0, note: 76, velocity: 100 },
      { kind: 'noteOff', tick: 420, channel: 0, note: 76 },
      { kind: 'noteOn', tick: 420, channel: 0, note: 77, velocity: 100 },
      { kind: 'noteOff', tick: 480, channel: 0, note: 77 },
    ];
    for (let k = 0; k < 4; k++) {
      events.push({ kind: 'noteOn', tick: k * 120, channel: 9, note: 42, velocity: 100 });
      events.push({ kind: 'noteOff', tick: k * 120 + 30, channel: 9, note: 42 });
    }
    events.push({ kind: 'noteOn', tick: 0, channel: 9, note: 36, velocity: 100 });
    events.push({ kind: 'noteOff', tick: 30, channel: 9, note: 36 });
    const q = quantize(extract(readSmf(buildSmf({ ticksPerQuarter: 480, tracks: [events] }))), 32);
    const melody = q.notes.filter((n) => n.channel === 0);
    expect(melody.map((n) => [n.on, n.off])).toEqual([[0, 48], [48, 72], [72, 84], [84, 96]]);
  });

  it('長さ 0 の延ばし幅は、量子化後の on の属する拍の格子で決める', () => {
    // 拍 0 は 3 連（格子 32）、拍 1 は普通（格子 24）。拍 0 の末尾の短いノートは拍 1 の頭 96 に丸まる
    const q = quantize(
      withNotes(
        note(0, 15, 60), note(33, 47, 61), note(65, 79, 62), // 拍 0：3 連
        note(94, 95, 63), // 96 に丸まり、off も 96 で長さ 0
        note(120, 140, 64), note(144, 160, 65), note(168, 190, 66), // 拍 1：普通
      ),
      16,
    );
    const n63 = q.notes.find((n) => n.note === 63)!;
    expect([n63.on, n63.off]).toEqual([96, 120]);
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

  it('チャンネル 10（ドラム）の短いノートは警告しない', () => {
    const q = quantize(withNotes(note(13, 15, 38, 9)), 32);
    expect(q.warnings).toHaveLength(0);
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

  describe('既定の単位（32 分音符 = 12 ティック、3 連は 8 ティック）', () => {
    /** 分解能 480 の SMF を extract → quantize に通して、ノートの on を返す */
    function quantizedOns(starts: number[], length: number): number[] {
      const events: SmfEvent[] = [];
      starts.forEach((t, i) => {
        events.push({ kind: 'noteOn', tick: t, channel: 0, note: 60 + i, velocity: 100 });
        events.push({ kind: 'noteOff', tick: t + length, channel: 0, note: 60 + i });
      });
      const ex = extract(readSmf(buildSmf({ ticksPerQuarter: 480, tracks: [events] })));
      return quantize(ex, 32).notes.map((n) => n.on);
    }

    it('8 分の 3 連符が 3 連の長さになる', () => {
      expect(quantizedOns([480, 640, 800], 150)).toEqual([96, 128, 160]);
    });

    it('16 分の 3 連符が 3 連の長さになる', () => {
      expect(quantizedOns([480, 560, 640, 720, 800, 880], 70)).toEqual([96, 112, 128, 144, 160, 176]);
    });

    it('±数ティックずれた 8 分・16 分の 3 連符も 3 連の長さになる', () => {
      expect(quantizedOns([483, 638, 802], 150)).toEqual([96, 128, 160]);
      expect(quantizedOns([483, 558, 643, 718, 803, 878], 70)).toEqual([96, 112, 128, 144, 160, 176]);
    });
  });

  it('チャンネルが違えば重なりを縮めない', () => {
    const q = quantize(withNotes(note(0, 36, 60, 0), note(12, 48, 60, 1)), 32);
    expect(q.notes.map((n) => n.off)).toEqual([36, 48]);
  });
});
