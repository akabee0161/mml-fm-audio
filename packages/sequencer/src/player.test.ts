import { describe, expect, it } from 'vitest';
import { parseMml } from './parser.ts';
import { Player, volumeGain } from './player.ts';
import type { EngineLike } from './player.ts';
import { Timeline } from './timing.ts';

type Call =
  | { type: 'noteOn'; id: number; program: number; note: number; time: number; volume: number; bend: number; pan: number }
  | { type: 'noteOff'; id: number; time: number }
  | { type: 'bend'; id: number; cents: number; time: number }
  | { type: 'volume'; id: number; volume: number; time: number }
  | { type: 'cancel'; ids: number[] };

function fakeEngine() {
  const calls: Call[] = [];
  let nextId = 1;
  const engine: EngineLike = {
    noteOn(program, note, o) {
      const id = nextId++;
      calls.push({ type: 'noteOn', id, program, note, time: o.time, volume: o.volume, bend: o.bend, pan: o.pan });
      return id;
    },
    noteOff(id, time) { calls.push({ type: 'noteOff', id, time }); },
    setPitchBend(id, cents, time) { calls.push({ type: 'bend', id, cents, time }); },
    setVolume(id, volume, time) { calls.push({ type: 'volume', id, volume, time }); },
    cancel(ids) { calls.push({ type: 'cancel', ids: [...ids] }); },
  };
  return { engine, calls };
}

const SR = 48000;
function make(mml: string, startFrame = 0) {
  const song = parseMml(mml);
  expect(song.errors).toEqual([]);
  const { engine, calls } = fakeEngine();
  const player = new Player(engine, song, { sampleRate: SR, startFrame });
  return { player, calls, song };
}
const ons = (calls: Call[]) => calls.filter((c) => c.type === 'noteOn');

describe('volumeGain', () => {
  it('15 で 1、0 で 0、1 段で 3 dB', () => {
    expect(volumeGain(15)).toBe(1);
    expect(volumeGain(0)).toBe(0);
    expect(volumeGain(13) / volumeGain(14)).toBeCloseTo(10 ** (-3 / 20), 12);
  });
});

describe('Player', () => {
  it('エラーのある曲は Error', () => {
    const { engine } = fakeEngine();
    expect(() => new Player(engine, parseMml('A z'), { sampleRate: SR, startFrame: 0 })).toThrow(Error);
  });

  it('A c d：時刻・音量・順序・finished', () => {
    const { player, calls } = make('A c d', 1000);
    expect(player.finished).toBe(false);
    player.pump(0, 1e9);
    expect(ons(calls).map((c) => c.type === 'noteOn' && c.time)).toEqual([1000, 25000]);
    expect(calls.filter((c) => c.type === 'noteOff').map((c) => c.type === 'noteOff' && c.time)).toEqual([25000, 49000]);
    for (const c of ons(calls)) expect(c.type === 'noteOn' && c.volume).toBe(volumeGain(12));
    const at25000 = calls.filter((c) => c.type !== 'cancel' && c.time === 25000).map((c) => c.type);
    expect(at25000).toEqual(['noteOff', 'noteOn']);
    expect(player.finished).toBe(true);
  });

  it('先読み：pump(0, 24000) では c だけ、続く pump で残り（重複しない）', () => {
    const { player, calls } = make('A c d');
    player.pump(0, 24000);
    expect(ons(calls)).toHaveLength(1);
    expect(calls.filter((c) => c.type === 'noteOff')).toHaveLength(0);
    player.pump(24000, 48000);
    expect(ons(calls).map((c) => c.type === 'noteOn' && c.note)).toEqual([60, 62]);
    expect(calls.filter((c) => c.type === 'noteOff').map((c) => c.type === 'noteOff' && c.time)).toEqual([24000]);
    expect(player.finished).toBe(false);
    player.pump(48000, 1e9);
    expect(calls.filter((c) => c.type === 'noteOff')).toHaveLength(2);
    expect(player.finished).toBe(true);
  });

  it('ループ：A c L d e を 3 回分', () => {
    const { player, calls } = make('A c L d e');
    player.pump(0, 6 * 24000);
    const o = ons(calls).map((c) => c.type === 'noteOn' && [c.note, c.time]);
    expect(o).toEqual([[60, 0], [62, 24000], [64, 48000], [62, 72000], [64, 96000], [62, 120000]]);
    expect(player.finished).toBe(false);
  });

  it('L の前から持続中のノートは 2 回目以降に送らない', () => {
    const { player, calls } = make('A c1\nB r4 L d4 e2');
    player.pump(0, 5 * 96000);
    const o = ons(calls).map((c) => c.type === 'noteOn' && c.note);
    expect(o.filter((n) => n === 60)).toHaveLength(1);
    expect(o.filter((n) => n === 62).length).toBeGreaterThan(1);
    expect(o.filter((n) => n === 64).length).toBeGreaterThan(1);
  });

  it('ループ終了を越えるノート：ノートオフは次の回の位置', () => {
    const { player, calls, song } = make('B L c2 c2 E\nA r2 r4 r8 e8&e4');
    const tl = new Timeline(song);
    player.pump(0, 3 * 4 * 24000);
    const e = ons(calls).filter((c) => c.type === 'noteOn' && c.note === 64);
    expect(e[0].type === 'noteOn' && e[0].time).toBe(tl.seconds(0, 336) * SR);
    const off = calls.find((c) => c.type === 'noteOff' && c.id === (e[0].type === 'noteOn' ? e[0].id : -1));
    expect(off && off.type === 'noteOff' && off.time).toBe(tl.seconds(1, 96) * SR);
  });

  it('各回の始めで最後のノートを忘れる：越えてきたノートに setPitchBend を送らない', () => {
    const { player, calls } = make('B L c2 c2 E\nA r4 B+100 r4 r4 r8 e8&e4');
    player.pump(0, 3 * 4 * 24000);
    expect(ons(calls).filter((c) => c.type === 'noteOn' && c.note === 64).length).toBeGreaterThanOrEqual(3);
    expect(calls.filter((c) => c.type === 'bend')).toHaveLength(0);
  });

  it('A c8&B+50c8：bend が c の ID に送られる', () => {
    const { player, calls } = make('A c8&B+50c8');
    player.pump(0, 1e9);
    const id = ons(calls)[0].type === 'noteOn' ? (ons(calls)[0] as { id: number }).id : -1;
    expect(calls.filter((c) => c.type === 'bend')).toEqual([{ type: 'bend', id, cents: 50, time: 12000 }]);
  });

  it('v は setVolume（倍率）として持続中のノートへ', () => {
    const { player, calls } = make('A c8&v8c8');
    player.pump(0, 1e9);
    expect(calls.filter((c) => c.type === 'volume')).toEqual([{ type: 'volume', id: 1, volume: volumeGain(8), time: 12000 }]);
  });

  it('同じ時刻：ノートオフ → setPitchBend → ノートオン', () => {
    const { player, calls } = make('A c4 B+50 d4');
    player.pump(0, 1e9);
    const at = calls.filter((c) => c.type !== 'cancel' && c.time === 24000).map((c) => c.type);
    expect(at).toEqual(['noteOff', 'bend', 'noteOn']);
  });

  it('遅れ：nowFrame より前のノートオンは送らず、そのノートオフも送らない', () => {
    const { player, calls } = make('A c d e');
    player.pump(30000, 60000);
    expect(ons(calls).map((c) => c.type === 'noteOn' && c.note)).toEqual([64]);
    expect(calls.filter((c) => c.type === 'noteOff')).toHaveLength(0);
  });

  it('遅れたノートの bend は送らない', () => {
    const { player, calls } = make('A c8&B+50c8 d e');
    player.pump(30000, 1e9);
    expect(calls.filter((c) => c.type === 'bend')).toHaveLength(0);
    expect(ons(calls)).toHaveLength(1);
  });

  it('停止：ノートオフが過ぎていない送り済みのノートを cancel し、以後は何も送らない', () => {
    const { player, calls } = make('A c1');
    player.pump(0, 1000);
    const id = (ons(calls)[0] as { id: number }).id;
    player.stop();
    expect(calls.filter((c) => c.type === 'cancel')).toEqual([{ type: 'cancel', ids: [id] }]);
    const n = calls.length;
    player.pump(1000, 1e9);
    expect(calls).toHaveLength(n);
  });

  it('停止：ノートオフの時刻が過ぎたノートは cancel しない', () => {
    const { player, calls } = make('A c4 d1');
    player.pump(0, 30000);
    player.pump(26000, 30000);
    player.stop();
    const cancel = calls.find((c) => c.type === 'cancel');
    expect(cancel).toEqual({ type: 'cancel', ids: [2] });
  });
});
