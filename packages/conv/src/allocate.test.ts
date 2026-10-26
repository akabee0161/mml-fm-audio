import { describe, expect, it } from 'vitest';
import { allocateTracks } from './allocate.ts';
import { ConvError } from './errors.ts';
import type { RawNote } from './extract.ts';
import { createMeter } from './meter.ts';
import type { Quantized } from './quantize.ts';

const song = (notes: RawNote[]): Quantized => ({
  notes: [...notes].sort((a, b) => a.on - b.on),
  controls: [],
  tempos: [],
  markers: [],
  timeSignatures: [],
  discarded: new Map(),
  warnings: [],
});
const n = (channel: number, note: number, on: number, off: number, velocity = 100): RawNote => ({ channel, note, velocity, on, off });
const meter = createMeter([]);
const alloc = (notes: RawNote[]) => allocateTracks(song(notes), meter);
const names = (notes: RawNote[]) => alloc(notes).tracks.map((t) => t.name);

describe('allocateTracks', () => {
  it('和音のないチャンネルは A のまま、チャンネル 2 は B、チャンネル 11 は K', () => {
    const r = alloc([n(0, 60, 0, 96), n(1, 62, 0, 96), n(10, 64, 0, 96)]);
    expect(r.tracks.map((t) => [t.name, t.channel, t.drum])).toEqual([['A', 0, false], ['B', 1, false], ['K', 10, false]]);
    expect(r.perChannel).toEqual([{ channel: 0, names: ['A'] }, { channel: 1, names: ['B'] }, { channel: 10, names: ['K'] }]);
  });

  it('3 和音は A1・A2・A3 に、高い音が若い番号', () => {
    const r = alloc([n(0, 60, 0, 96), n(0, 64, 0, 96), n(0, 67, 0, 96)]);
    expect(r.tracks.map((t) => [t.name, t.notes[0].note])).toEqual([['A1', 67], ['A2', 64], ['A3', 60]]);
  });

  it('持続中のノートは移さず、空いているサブトラックへ入れる', () => {
    const r = alloc([n(0, 67, 0, 384), n(0, 72, 96, 192), n(0, 60, 192, 288)]);
    const byName = Object.fromEntries(r.tracks.map((t) => [t.name, t.notes.map((x) => x.note)]));
    // 72 は G の持続中なので A2。192 では A2 が空くので、60 は A2（A1 は G が持続中）
    expect(byName).toEqual({ A1: [67], A2: [72, 60] });
  });

  it('終わったサブトラックは次のノートに使われ、持続中の A1 は変わらない', () => {
    const r = alloc([n(0, 60, 0, 96), n(0, 64, 0, 192), n(0, 72, 96, 192)]);
    const byName = Object.fromEntries(r.tracks.map((t) => [t.name, t.notes.map((x) => x.note)]));
    expect(byName).toEqual({ A1: [64], A2: [60, 72] });
  });

  it('同時に打つドラムを R1・R2 に分ける（キーの順）', () => {
    const r = alloc([n(9, 42, 0, 10), n(9, 36, 0, 10), n(9, 38, 96, 106)]);
    expect(r.tracks.map((t) => [t.name, t.drum, t.channel])).toEqual([['R1', true, 9], ['R2', true, 9]]);
    expect(r.tracks[0].drumNames).toEqual(['bd', 'sd']);
    expect(r.tracks[0].notes.map((x) => [x.on, x.note])).toEqual([[0, 36], [96, 38]]);
    expect(r.tracks[1].drumNames).toEqual(['ch']);
    expect(r.perChannel).toEqual([{ channel: 9, names: ['R1', 'R2'] }]);
  });

  it('同時打ちがなければ R、チャンネル 10 のトラックは最後', () => {
    const r = alloc([n(9, 36, 0, 10), n(0, 60, 0, 96)]);
    expect(r.tracks.map((t) => t.name)).toEqual(['A', 'R']);
  });

  it('同じ tick の 35 と 36 は 1 つにまとめ、ベロシティの大きいほうを使う', () => {
    const r = alloc([n(9, 35, 0, 10, 50), n(9, 36, 0, 10, 90)]);
    expect(r.tracks).toHaveLength(1);
    expect(r.tracks[0].name).toBe('R');
    expect(r.tracks[0].notes).toEqual([{ on: 0, off: 0, note: 36, velocity: 90 }]);
  });

  it('割り当てのないドラムのノートは捨て、番号ごとに 1 件、件数つきで警告する', () => {
    const r = alloc([n(9, 80, 0, 10), n(9, 80, 96, 106), n(9, 36, 192, 202)]);
    expect(r.tracks).toHaveLength(1);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0].tick).toBe(0);
    expect(r.warnings[0].message).toContain('ドラムのノート 80');
    expect(r.warnings[0].message).toContain('2 件');
  });

  it('J を含めて 30 を超えたら ConvError、文にチャンネルごとのトラック数', () => {
    const notes: RawNote[] = [];
    for (let ch = 0; ch < 16; ch++) {
      if (ch === 9) continue;
      notes.push(n(ch, 60, 0, 96), n(ch, 64, 0, 96));
    }
    expect(() => alloc(notes)).toThrow(ConvError);
    expect(() => alloc(notes)).toThrow(/31 個.*上限の 30.*チャンネル 1：2.*指揮用 J：1/);
  });

  it('J を含めてちょうど 30 なら通る', () => {
    const notes: RawNote[] = [];
    for (let ch = 0; ch < 15; ch++) {
      if (ch === 9) continue;
      notes.push(n(ch, 60, 0, 96), n(ch, 64, 0, 96));
    }
    notes.push(n(15, 60, 0, 96));
    expect(alloc(notes).tracks).toHaveLength(29);
  });

  it('同時に鳴るノートが 16 を超えたら、超えた最初の tick で 1 件だけ警告する', () => {
    const r = alloc(Array.from({ length: 17 }, (_, i) => n(0, 40 + i, 0, 96)));
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0].tick).toBe(0);
    expect(r.warnings[0].message).toContain('17');
    expect(alloc(Array.from({ length: 16 }, (_, i) => n(0, 40 + i, 0, 96))).warnings).toEqual([]);
  });

  it('16 以下に戻ってからまた超えたら、また警告する', () => {
    const notes = [
      ...Array.from({ length: 17 }, (_, i) => n(0, 40 + i, 0, 96)),
      ...Array.from({ length: 17 }, (_, i) => n(0, 40 + i, 192, 288)),
    ];
    expect(alloc(notes).warnings.map((w) => w.tick)).toEqual([0, 192]);
  });

  it('同時に打つドラムの並びは bd sd ch oh cy lt ht cp で、cp が最後', () => {
    const r = alloc([n(9, 37, 0, 10), n(9, 47, 0, 10), n(9, 36, 0, 10)]);
    expect(r.tracks.map((t) => [t.name, t.drumNames])).toEqual([['R1', ['bd']], ['R2', ['ht']], ['R3', ['cp']]]);
  });

  it('ドラムの打撃も同時発音に数える（打撃の tick だけ）', () => {
    const melody = Array.from({ length: 15 }, (_, i) => n(0, 40 + i, 0, 96));
    // 15 + bd・sd の 2 打 = 17
    const together = alloc([...melody, n(9, 36, 0, 10), n(9, 38, 0, 10)]);
    expect(together.warnings).toHaveLength(1);
    expect(together.warnings[0].message).toContain('17');
    // 打撃は次の tick には残らない：15 + 1 打 = 16 は通り、メロディが終わった 96 の打撃も数えない
    expect(alloc([...melody, n(9, 36, 48, 58), n(9, 36, 96, 106)]).warnings).toEqual([]);
  });

  it('perChannel はチャンネルの順で、チャンネル 10 はチャンネル 11 以降の前に来る', () => {
    const r = alloc([n(10, 60, 0, 96), n(9, 36, 0, 10), n(0, 60, 0, 96)]);
    expect(r.tracks.map((t) => t.name)).toEqual(['A', 'K', 'R']);
    expect(r.perChannel).toEqual([
      { channel: 0, names: ['A'] },
      { channel: 9, names: ['R'] },
      { channel: 10, names: ['K'] },
    ]);
  });

  it('ノートのないチャンネルにはトラックを作らない', () => {
    expect(names([])).toEqual([]);
  });
});
