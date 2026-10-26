import { describe, expect, it } from 'vitest';
import type { PlannedTrack } from './allocate.ts';
import { ConvError } from './errors.ts';
import type { ChannelControl } from './extract.ts';
import type { LoopRange } from './loop.ts';
import { createMeter } from './meter.ts';
import type { Quantized } from './quantize.ts';
import { writeMml } from './writer.ts';

const song = (over: Partial<Quantized> = {}): Quantized => ({
  notes: [], controls: [], tempos: [], markers: [], timeSignatures: [], discarded: new Map(), warnings: [], ...over,
});
const meter = createMeter([]);
const loop = (start = 0, end = 384): LoopRange => ({ start, end, fromMarkers: false });
const melody = (notes: [number, number, number][], name = 'A', velocity = 100): PlannedTrack => ({
  name, channel: 0, drum: false, notes: notes.map(([on, off, note]) => ({ on, off, note, velocity })),
});
const ctl = (tick: number, kind: ChannelControl['kind'], value: number, channel = 0): ChannelControl => ({ tick, channel, kind, value });
const write = (tracks: PlannedTrack[], s = song(), l = loop()) => writeMml(tracks, s, l, meter).trimEnd().split('\n');

describe('writeMml', () => {
  it('J は t・L・E と休符だけ。テンポがなければ 120、BPM は小数第 2 位まで', () => {
    expect(write([melody([[0, 96, 60]])])[0]).toBe('J t120 L r1 E');
    const lines = write([melody([[0, 96, 60]])], song({ tempos: [{ tick: 0, bpm: 100.456 }, { tick: 192, bpm: 90 }] }));
    expect(lines[0]).toBe('J t100.46 L r2 t90 r2 E');
  });

  it('ループ開始が途中なら L の前後を休符で埋める。tick 0 より後に最初のテンポがあれば 0 に 120 を置く', () => {
    const lines = write([melody([[0, 96, 60]])], song({ tempos: [{ tick: 96, bpm: 150 }] }), loop(96, 384));
    expect(lines[0]).toBe('J t120 r4 t150 L r2. E');
  });

  it('音長は表で表せればそれ、付点は 1 つまで、ほかは %N', () => {
    const [, a] = write([melody([[0, 96, 60], [96, 240, 62], [240, 252, 64], [252, 300, 65]])]);
    expect(a).toBe('A c4 d4. e32 f8');
    const [, b] = write([melody([[0, 100, 60]])]);
    expect(b).toBe('A c%100');
  });

  it('休符を挟み、@・p・o・v は前と違うときだけ。トラックの最初は MML の既定と違うときだけ', () => {
    const s = song({ controls: [ctl(0, 'program', 5), ctl(0, 'pan', 20), ctl(192, 'pan', 20), ctl(192, 'program', 5)] });
    const [, a] = write([melody([[0, 96, 72], [192, 288, 72]])], s);
    expect(a).toBe('A @5 p20 o5 c4 r4 c4');
  });

  it('v はベロシティとボリューム・エクスプレッションから決める', () => {
    const [, a] = write([melody([[0, 96, 60], [96, 192, 62]], 'A', 127)], song({ controls: [ctl(0, 'volume', 127)] }));
    expect(a).toBe('A v15 c4 d4');
  });

  it('ノートの途中のボリュームの変化は、タイで分けて v を書く', () => {
    const [, a] = write([melody([[0, 384, 60]])], song({ controls: [ctl(192, 'expression', 90)] }));
    expect(a).toBe('A c2&v10c2');
  });

  it('値が変わらない v は途中でも書かない', () => {
    const [, a] = write([melody([[0, 384, 60]])], song({ controls: [ctl(192, 'volume', 100)] }));
    expect(a).toBe('A c1');
  });

  it('ノートの途中のベンドはタイで分け、休符の途中のベンドは休符を分ける。最初のノートの前の変化も書く', () => {
    const s = song({ controls: [ctl(48, 'bend', 20.4), ctl(96, 'bend', 50), ctl(240, 'bend', 0), ctl(300, 'bend', -30)] });
    const [, a] = write([melody([[96, 192, 60], [288, 384, 62]])], s);
    expect(a).toBe('A r8 B+20 r8 B+50 c4 r8 B+0 r8 d32&B-30d%84');
  });

  it('ベンドは同じチャンネルのサブトラックすべてに書く', () => {
    const s = song({ controls: [ctl(0, 'bend', 100)] });
    const lines = write([melody([[0, 96, 60]], 'A1'), melody([[0, 96, 64]], 'A2')], s);
    expect(lines.slice(1)).toEqual(['A1 B+100 c4', 'A2 B+100 e4']);
  });

  it('ノート 10 は ConvError（位置つき）', () => {
    expect(() => write([melody([[96, 192, 10]])])).toThrow(ConvError);
    expect(() => write([melody([[96, 192, 10]])])).toThrow('1 小節 2 拍');
    expect(() => write([melody([[0, 96, 120]])])).toThrow(ConvError);
  });

  it('ベンドが ±1200 セントを超えたら ConvError', () => {
    expect(() => write([melody([[0, 96, 60]])], song({ controls: [ctl(0, 'bend', 1200.4)] }))).not.toThrow();
    expect(() => write([melody([[0, 96, 60]])], song({ controls: [ctl(48, 'bend', 1201)] }))).toThrow('1200');
  });

  it('テンポが 1〜999 を外れたら ConvError', () => {
    expect(() => write([melody([[0, 96, 60]])], song({ tempos: [{ tick: 0, bpm: 1000 }] }))).toThrow(ConvError);
    expect(() => write([melody([[0, 96, 60]])], song({ tempos: [{ tick: 0, bpm: 0.4 }] }))).toThrow(ConvError);
  });

  it('ドラムは次の打撃まで（最後は E まで）の音長で、v は打撃ごと、p は前と違うとき', () => {
    const drum: PlannedTrack = {
      name: 'R', channel: 9, drum: true, drumNames: ['bd', 'sd', 'bd'],
      notes: [
        { on: 0, off: 0, note: 36, velocity: 127 },
        { on: 96, off: 96, note: 38, velocity: 100 },
        { on: 288, off: 288, note: 36, velocity: 100 },
      ],
    };
    const [, r] = write([drum], song({ controls: [ctl(0, 'volume', 127, 9), ctl(0, 'pan', 30, 9)] }));
    expect(r).toBe('R v15 p30 bd4 v14 sd2 bd4');
  });

  it('長い行は同じトラック名で折り返す', () => {
    const notes: [number, number, number][] = Array.from({ length: 60 }, (_, i) => [i * 6, i * 6 + 6, 60 + (i % 2)]);
    const lines = write([melody(notes)], song(), loop(0, 384));
    expect(lines.filter((l) => l.startsWith('A ')).length).toBeGreaterThan(1);
  });
});
