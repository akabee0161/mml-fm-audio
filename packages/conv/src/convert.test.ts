import { describe, expect, it } from 'vitest';
import { DRUM_PROGRAMS, parseMml } from '../../sequencer/src/index.ts';
import { convertSmf } from './convert.ts';
import { ConvError } from './errors.ts';
import type { SmfEvent } from './smf.ts';
import { buildSmf } from './smfBuilder.ts';

const Q = 480; // SMF の四分音符
const on = (tick: number, note: number, channel = 0, velocity = 100): SmfEvent => ({ kind: 'noteOn', tick, channel, note, velocity });
const off = (tick: number, note: number, channel = 0): SmfEvent => ({ kind: 'noteOff', tick, channel, note });
const convert = (events: SmfEvent[], options?: Parameters<typeof convertSmf>[1]) =>
  convertSmf(buildSmf({ tracks: [events], ticksPerQuarter: Q }), options);
const notesOf = (mml: string, name: string) => {
  const track = parseMml(mml).tracks.find((t) => t.name === name)!;
  return track.events.filter((e) => e.type === 'note');
};

describe('convertSmf', () => {
  it('C-E-G の和音と 4 拍のメロディが、parseMml で同じノートになる', () => {
    const events: SmfEvent[] = [
      { kind: 'controlChange', tick: 0, channel: 0, controller: 10, value: 20 },
      { kind: 'programChange', tick: 0, channel: 0, program: 5 },
      ...[60, 64, 67].flatMap((n) => [on(0, n), off(4 * Q, n)]),
      on(0, 72, 1), off(Q, 72, 1), on(Q, 74, 1), off(2 * Q, 74, 1), on(2 * Q, 76, 1), off(4 * Q, 76, 1),
    ];
    const { mml, report } = convert(events);
    const song = parseMml(mml);
    expect(song.errors).toEqual([]);
    expect(report.perChannel).toEqual([{ channel: 0, names: ['A1', 'A2', 'A3'] }, { channel: 1, names: ['B'] }]);
    expect(notesOf(mml, 'A1').map((n) => n.type === 'note' && [n.tick, n.note, n.gate, n.volume, n.pan, n.program]))
      .toEqual([[0, 67, 384, 12, 20, 5]]);
    expect(notesOf(mml, 'A3').map((n) => n.type === 'note' && n.note)).toEqual([60]);
    expect(notesOf(mml, 'B').map((n) => n.type === 'note' && [n.tick, n.note, n.gate, n.pan, n.program]))
      .toEqual([[0, 72, 96, 64, 0], [96, 74, 96, 64, 0], [192, 76, 192, 64, 0]]);
    expect(song.loopStart).toBe(0);
    expect(song.loopEnd).toBe(384);
  });

  it('持続中のノートの途中のテンポ・音量・ベンドの変化が、その tick に入る', () => {
    const { mml } = convert([
      on(0, 60), off(4 * Q, 60),
      { kind: 'tempo', tick: 2 * Q, microsecondsPerQuarter: 400_000 },
      { kind: 'controlChange', tick: 2 * Q, channel: 0, controller: 11, value: 60 },
      { kind: 'pitchBend', tick: Q, channel: 0, value: 4096 }, // +100 セント
    ]);
    const song = parseMml(mml);
    expect(song.errors).toEqual([]);
    expect(song.tempos).toEqual([{ tick: 0, bpm: 120 }, { tick: 192, bpm: 150 }]);
    const events = song.tracks.find((t) => t.name === 'A')!.events;
    expect(events.filter((e) => e.type === 'note')).toHaveLength(1);
    expect(events.find((e) => e.type === 'bend')).toMatchObject({ tick: 96, cents: 100 });
    expect(events.find((e) => e.type === 'volume')).toMatchObject({ tick: 192 });
  });

  it('ドラムの同時打ちが R1・R2 になり、note の program が DRUM_PROGRAMS の値', () => {
    const { mml, report } = convert([
      on(0, 36, 9), on(0, 42, 9), off(Q, 36, 9), off(Q, 42, 9), on(Q, 38, 9), on(Q, 42, 9), off(2 * Q, 38, 9), off(2 * Q, 42, 9),
    ]);
    const song = parseMml(mml);
    expect(song.errors).toEqual([]);
    expect(report.perChannel).toEqual([{ channel: 9, names: ['R1', 'R2'] }]);
    const programs = (name: string) => notesOf(mml, name).map((n) => n.type === 'note' && [n.tick, n.program]);
    expect(programs('R1')).toEqual([[0, DRUM_PROGRAMS.bd], [96, DRUM_PROGRAMS.sd]]);
    expect(programs('R2')).toEqual([[0, DRUM_PROGRAMS.ch], [96, DRUM_PROGRAMS.ch]]);
  });

  it('ループのマーカーがあると J に L と E が入る', () => {
    const { mml, report } = convert([
      on(0, 60), off(Q, 60), on(Q, 62), off(2 * Q, 62), on(2 * Q, 64), off(3 * Q, 64),
      { kind: 'marker', tick: Q, text: 'loop' },
      { kind: 'marker', tick: 3 * Q, text: 'loopend' },
    ]);
    const song = parseMml(mml);
    expect(song.errors).toEqual([]);
    expect(song.loopStart).toBe(96);
    expect(song.loopEnd).toBe(288);
    expect(report.loop).toEqual({ start: 96, end: 288, fromMarkers: true });
  });

  it('マーカーがない曲は L が tick 0、E が最後のノートオフを含む小節の終わり', () => {
    const { mml, report } = convert([on(0, 60), off(5 * Q, 60)]);
    const song = parseMml(mml);
    expect(song.loopStart).toBe(0);
    expect(song.loopEnd).toBe(768);
    expect(report.loop.fromMarkers).toBe(false);
  });

  it('警告は「小節 拍：」付きの文字列で、tick の順', () => {
    const { warnings } = convert([on(0, 60), off(Q, 60), on(Q, 27, 9), off(2 * Q, 27, 9), on(0, 36, 9), off(Q, 36, 9)]);
    expect(warnings).toEqual(['1 小節 2 拍：ドラムのノート 27 は割り当てがないため捨てます（1 件）']);
  });

  it('範囲外はどれも ConvError', () => {
    const wideBend: SmfEvent[] = [
      { kind: 'controlChange', tick: 0, channel: 0, controller: 101, value: 0 },
      { kind: 'controlChange', tick: 0, channel: 0, controller: 100, value: 0 },
      { kind: 'controlChange', tick: 0, channel: 0, controller: 6, value: 13 }, // ベンド幅 13 半音
      { kind: 'pitchBend', tick: 0, channel: 0, value: 8191 },
    ];
    expect(() => convert([on(0, 60), off(Q, 60), ...wideBend])).toThrow(ConvError);
    expect(() => convert([on(0, 10), off(Q, 10)])).toThrow(ConvError);
    expect(() => convert([on(0, 60), off(Q, 60), { kind: 'tempo', tick: 0, microsecondsPerQuarter: 60_000 }])).toThrow(ConvError);
  });

  it('parseMml がエラーを返したら ConvError にして MML を返さない', () => {
    // ループ 1 周は 1 拍（96）。その 18 倍の長さのノートが、loopend を越えて続く
    const events: SmfEvent[] = [
      on(0, 60), off(18 * Q, 60),
      { kind: 'marker', tick: 0, text: 'loop' },
      { kind: 'marker', tick: Q, text: 'loopend' },
    ];
    expect(() => convert(events)).toThrow(ConvError);
    expect(() => convert(events)).toThrow('ループの中のノートが長すぎます');
  });
});
