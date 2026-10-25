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

  it('ループを何周も回しても、送り済みの一覧は周回数に比例して増えない', () => {
    const { player } = make('A L c');
    const sent = () => (player as unknown as { sent: unknown[] }).sent.length;
    for (let now = 0; now < 100 * 24000; now += 128) player.pump(now, now + 4800);
    expect(sent()).toBeLessThanOrEqual(2);
  });

  it('ノートオフが過ぎたノートを捨てても、停止では持続中のノートと先読みで送り済みの未来のノートを cancel する', () => {
    const { player, calls } = make('A c d e f');
    player.pump(0, 60000);
    player.pump(30000, 60000);
    player.stop();
    expect(calls.find((c) => c.type === 'cancel')).toEqual({ type: 'cancel', ids: [2, 3] });
  });

  it('ノートオフの時刻ちょうどを nowFrame にした pump では、そのノートを捨てず、停止で cancel する', () => {
    const { player, calls } = make('A c d');
    const sent = () => (player as unknown as { sent: unknown[] }).sent.length;
    player.pump(0, 60000);
    player.pump(24000, 60000); // c のノートオフは 24000 ちょうど
    expect(sent()).toBe(2);
    player.stop();
    expect(calls.find((c) => c.type === 'cancel')).toEqual({ type: 'cancel', ids: [1, 2] });
  });

  it('sent から捨てられたノートにも、後の pump で setPitchBend が届く', () => {
    const { player, calls } = make('A c4 r4 B+50');
    const sent = () => (player as unknown as { sent: unknown[] }).sent.length;
    player.pump(0, 10000);
    expect(sent()).toBe(1);
    player.pump(30000, 40000); // c のノートオフ（24000）が過ぎ、B（48000）はまだ先
    expect(sent()).toBe(0);
    expect(calls.filter((c) => c.type === 'bend')).toEqual([]);
    player.pump(40000, 60000);
    expect(calls.filter((c) => c.type === 'bend')).toEqual([{ type: 'bend', id: 1, cents: 50, time: 48000 }]);
  });

  it('過ぎた時刻でも、送ったノートのノートオフは送る', () => {
    const { player, calls } = make('A c d');
    player.pump(0, 1000);
    expect(ons(calls)).toHaveLength(1);
    player.pump(30000, 60000);
    const offs = calls.filter((c) => c.type === 'noteOff');
    expect(offs).toEqual([{ type: 'noteOff', id: 1, time: 24000 }]);
  });

  it('1 周のアクションが非常に多い曲でも、待ち行列への追加でスタックが溢れない', () => {
    const song = parseMml('A l16 [[c]250]255');
    expect(song.errors).toEqual([]);
    const { engine } = fakeEngine();
    const player = new Player(engine, song, { sampleRate: SR, startFrame: 0 });
    expect(() => player.pump(0, 4800)).not.toThrow();
  });

  it('少しずつ作っても、一度に作ったときと送る順・時刻が同じ', () => {
    // 3 トラック・ループあり・テンポ変化・ループ終了を越えるノート・v と B を含む
    const mml = [
      'A t120 c4 L d4 B+30 e4 t180 v8 f4 g4&v5g4 E',
      'B r4 r4 c8 d8 B-20 e4 v9 f4 r8 g8&g4',
      'C r2 r4 r8 e8&e4 v7 c4',
    ].join('\n');
    const song = parseMml(mml);
    expect(song.errors).toEqual([]);
    const tl = new Timeline(song);
    // 3 周目の終わりまで。25 ms（1200 フレーム）ごと・先読み 4800 フレームの最後の pump が、同じ範囲を覆うようにそろえる
    const steps = Math.ceil(tl.seconds(3, song.loopEnd) * SR / 1200);
    const horizon = steps * 1200 + 4800;

    const once = fakeEngine();
    new Player(once.engine, song, { sampleRate: SR, startFrame: 0 }).pump(0, horizon);

    const stepped = fakeEngine();
    const player = new Player(stepped.engine, song, { sampleRate: SR, startFrame: 0 });
    for (let i = 0; i <= steps; i++) player.pump(i * 1200, i * 1200 + 4800);

    expect(once.calls.length).toBeGreaterThan(50);
    expect(once.calls.some((c) => c.type === 'bend')).toBe(true);
    expect(once.calls.some((c) => c.type === 'volume')).toBe(true);
    expect(stepped.calls).toEqual(once.calls);
  });

  it('ループする 1 トラックで、1 回の pump が作るアクションは先読みの範囲の分だけ', () => {
    const { player } = make('A L [[c%1]200]200');
    player.pump(0, 4800);
    expect(player.pendingCount).toBeLessThan(1000);
  });

  it('1 周にノートのないトラックがあっても、pump が先読みの範囲で止まる', () => {
    const { player, calls } = make('A L c4 d4 E\nB r4 r4');
    player.pump(0, 4 * 24000);
    expect(ons(calls).length).toBeGreaterThan(2);
  });
});

describe('一時停止・再開', () => {
  const noteOffs = (calls: Call[]) => calls.filter((c) => c.type === 'noteOff');

  it('pause で持続中のノートを cancel し、resume 後はずらした時刻で続きを送る', () => {
    const { player, calls } = make('A c4 d4');
    player.pump(0, 4800);
    expect(ons(calls)).toHaveLength(1);
    player.pause(12000);
    expect(calls.filter((c) => c.type === 'cancel')).toEqual([{ type: 'cancel', ids: [1] }]);
    player.resume(60000);
    calls.length = 0;
    player.pump(60000, 1e9);
    expect(ons(calls).map((c) => c.type === 'noteOn' && c.time)).toEqual([72000]);
    // c のノートオフ（24000 + 48000）は送らない。d のノートオフ（48000 + 48000）だけ
    expect(noteOffs(calls).map((c) => c.type === 'noteOff' && c.time)).toEqual([96000]);
    expect(calls.some((c) => c.type === 'cancel')).toBe(false);
  });

  it('ノートオフ未送信で、ノートオフが一時停止の時刻より前のノートは、本来の時刻でノートオフを 1 回送り（cancel しない）、再開後に重ねて送らない', () => {
    const { player, calls } = make('A c4 r4 d4');
    player.pump(0, 4800); // c のノートオンだけ送る（ノートオフ 24000 は先読みの外）
    expect(ons(calls)).toHaveLength(1);
    player.pause(30000); // c のノートオフ（24000）は 30000 より前
    expect(noteOffs(calls)).toEqual([{ type: 'noteOff', id: 1, time: 24000 }]);
    expect(calls.some((c) => c.type === 'cancel')).toBe(false);
    player.resume(60000);
    calls.length = 0;
    player.pump(60000, 1e9);
    // c のノートオン・ノートオフは送らない。d のノートオン（48000 + 30000）とノートオフだけ
    expect(ons(calls).map((c) => c.type === 'noteOn' && c.note)).toEqual([62]);
    expect(noteOffs(calls)).toHaveLength(1);
    expect(noteOffs(calls).some((c) => c.type === 'noteOff' && c.id === 1)).toBe(false);
  });

  it('ノートオフ送り済みで一時停止の時刻より前に終わるノートは、pause で何も送らない', () => {
    const { player, calls } = make('A c4 d4');
    player.pump(0, 30000); // c のノートオフ（24000）まで送り済み
    expect(noteOffs(calls)).toHaveLength(1);
    calls.length = 0;
    player.pause(40000);
    expect(calls.filter((c) => c.type === 'noteOff' && c.id === 1)).toEqual([]);
  });

  it('ノートオフ送り済みで再送されたノートは、ノートオンを送り直すたびにノートオフが未送信に戻り、2 回目の pause でずらした時刻のノートオフが送られる', () => {
    const { player, calls } = make('A r4 c4 d4');
    player.pump(0, 60000); // c のノートオン 24000・ノートオフ 48000 まで送り済み
    expect(noteOffs(calls)).toHaveLength(1);
    player.pause(10000); // c のノートオンは 10000 以降なので id を捨てて再送する
    player.resume(60000); // shift = 50000
    calls.length = 0;
    player.pump(60000, 80000); // c のノートオン（24000 + 50000）だけ再送。ノートオフ（98000）は先読みの外
    expect(ons(calls).map((c) => c.type === 'noteOn' && c.note)).toEqual([60]);
    const newId = ons(calls)[0]!.type === 'noteOn' ? (ons(calls)[0] as { id: number }).id : -1;
    expect(noteOffs(calls)).toEqual([]);
    player.pause(100000); // 曲の時刻 50000 > c のノートオフ 48000
    expect(noteOffs(calls)).toEqual([{ type: 'noteOff', id: newId, time: 48000 + 50000 }]);
    expect(calls.some((c) => c.type === 'cancel')).toBe(false);
  });

  it('持続中のノートの bend も再開後に送らない', () => {
    const { player, calls } = make('A c8&B+50c8 d4');
    player.pump(0, 4800);
    player.pause(6000);
    player.resume(6000);
    calls.length = 0;
    player.pump(6000, 1e9);
    expect(calls.filter((c) => c.type === 'bend')).toEqual([]);
    expect(calls.filter((c) => 'id' in c && c.id === 1)).toEqual([]);
    expect(ons(calls)).toHaveLength(1);
  });

  it('先読みで送り済みのノートは再開後に 1 回だけ鳴る', () => {
    const { player, calls } = make('A c4 d4');
    player.pump(20000, 24800);
    const dOn = ons(calls)[0];
    expect(dOn.type === 'noteOn' && dOn.time).toBe(24000);
    player.pause(20000);
    const cancel = calls.filter((c) => c.type === 'cancel')[0];
    expect(cancel.type === 'cancel' && cancel.ids).toContain(dOn.type === 'noteOn' ? dOn.id : -1);
    player.resume(30000);
    calls.length = 0;
    player.pump(30000, 1e9);
    expect(ons(calls).map((c) => c.type === 'noteOn' && c.time)).toEqual([34000]);
    expect(noteOffs(calls)).toHaveLength(1);
  });

  it('一時停止中は pump しても何も送らない、pause・resume を重ねて呼んでも例外にならない', () => {
    const { player, calls } = make('A c4 d4');
    player.resume(100);
    expect(player.paused).toBe(false);
    player.pump(0, 4800);
    player.pause(1000);
    player.pause(5000);
    expect(player.paused).toBe(true);
    const n = calls.length;
    player.pump(1000, 1e9);
    expect(calls.length).toBe(n);
    player.resume(2000);
    player.resume(9000);
    expect(player.paused).toBe(false);
    player.pump(2000, 1e9);
    // 最初の pause(1000) からのずれ 1000 だけ。2 回目の resume は無視される
    expect(ons(calls).map((c) => c.type === 'noteOn' && c.time)).toEqual([0, 25000]);
  });

  it('一時停止中に stop すると、再開しても何も送らない。cancel を重ねない', () => {
    const { player, calls } = make('A c4 d4');
    player.pump(0, 4800);
    player.pause(12000);
    player.stop();
    expect(calls.filter((c) => c.type === 'cancel')).toHaveLength(1);
    const n = calls.length;
    player.resume(20000);
    player.pump(20000, 1e9);
    expect(calls.length).toBe(n);
  });

  it('loopFrame と endFrame は一時停止のずれを含む', () => {
    const looped = make('A L c4 d4').player;
    expect(looped.loopFrame(1)).toBe(48000);
    expect(looped.endFrame).toBeNull();
    looped.pause(10000);
    looped.resume(20000);
    expect(looped.loopFrame(1)).toBe(58000);
    expect(() => looped.loopFrame(0)).toThrow(RangeError);

    const plain = make('A c4 d4').player;
    expect(plain.endFrame).toBe(48000);
    expect(() => plain.loopFrame(1)).toThrow(RangeError);
    plain.pause(0);
    plain.resume(5000);
    expect(plain.endFrame).toBe(53000);
  });

  it('pause・resume は有限でない nowFrame と、一時停止した時刻より前の resume を理由つきの RangeError にして、状態を変えない', () => {
    const { player, calls } = make('A c4 d4');
    player.pump(0, 4800);
    for (const bad of [Number.NaN, Infinity, -Infinity]) {
      expect(() => player.pause(bad)).toThrow(RangeError);
      expect(() => player.resume(bad)).toThrow(/resume.*有限/);
    }
    expect(player.paused).toBe(false);
    player.pause(12000);
    for (const bad of [Number.NaN, Infinity]) expect(() => player.resume(bad)).toThrow(RangeError);
    expect(() => player.resume(11999)).toThrow(/resume.*12000/);
    expect(player.paused).toBe(true);
    player.resume(60000); // 状態が変わっていないので、正しい値なら再開できる
    calls.length = 0;
    player.pump(60000, 1e9);
    expect(ons(calls).map((c) => c.type === 'noteOn' && c.time)).toEqual([72000]);
  });

  it('先読みが次の周の頭にかかった状態で pause しても、各ノートは再開後に 1 回ずつしか鳴らない', () => {
    const { player, calls } = make('A L c4 d4'); // 1 周 48000 フレーム
    player.pump(0, 49000); // 先読みが 2 周目の頭（48000）を越えている
    expect(ons(calls).map((c) => c.type === 'noteOn' && c.time)).toEqual([0, 24000, 48000]);
    player.pause(20000);
    // 20000 より前に鳴り始めた c は持続中（再開後に鳴らし直さない）。それ以後の d と 2 周目の c は cancel して送り直す
    expect(calls.filter((c) => c.type === 'cancel')).toEqual([{ type: 'cancel', ids: [1, 2, 3] }]);
    player.resume(100000); // 80000 フレームずらす
    calls.length = 0;
    player.pump(100000, 100000 + 49000);
    player.pump(120000, 120000 + 49000);
    // 1 回目の pump で d（104000）と 2 周目の c（128000）、2 回目の pump で 2 周目の d（152000）。重複はない
    expect(ons(calls).map((c) => c.type === 'noteOn' && c.time)).toEqual([104000, 128000, 152000]);
    expect(player.loopFrame(1)).toBe(128000);
    expect(player.loopFrame(2)).toBe(176000);
  });

  it('3 回以上の一時停止で、ずらす分が積み上がる', () => {
    const { player, calls } = make('A c4 d4 e4');
    player.pause(1000);
    player.resume(2000); // +1000
    player.pause(3000);
    player.resume(5000); // +2000（合計 3000）
    player.pause(6000);
    player.resume(6500); // +500（合計 3500）
    expect(player.endFrame).toBe(72000 + 3500);
    player.pump(3500, 1e9);
    expect(ons(calls).map((c) => c.type === 'noteOn' && c.time)).toEqual([3500, 27500, 51500]);
  });

  it('一時停止中の loopFrame・endFrame は、今回の停止の分を含まない（resume の後に増える）', () => {
    const loop = make('A L c4 d4').player;
    loop.pause(1000);
    expect(loop.loopFrame(1)).toBe(48000);
    loop.resume(5000);
    expect(loop.loopFrame(1)).toBe(52000);
    const plain = make('A c4 d4').player;
    plain.pause(1000);
    expect(plain.endFrame).toBe(48000);
    plain.resume(5000);
    expect(plain.endFrame).toBe(52000);
  });

  it('pause → stop → resume → pump で、何も送らない', () => {
    const { player, calls } = make('A c4 d4');
    player.pump(0, 4800);
    player.pause(12000);
    player.stop();
    player.resume(60000);
    calls.length = 0;
    player.pump(60000, 1e9);
    expect(calls).toEqual([]);
  });

  it('ループ終了を越えるタイが 2 万個続く曲は、解析エラーで Player を作れない', () => {
    const song = parseMml('A t999 L r%1 c%1 E ' + '&c1'.repeat(20000));
    expect(song.errors.length).toBeGreaterThan(0);
    expect(song.errors[0]!.message).toContain('ループの中のノートが長すぎます');
    const { engine } = fakeEngine();
    expect(() => new Player(engine, song, { sampleRate: SR, startFrame: 0 })).toThrow(Error);
  });

  it('ゲートがループ 1 周の 16 倍ちょうどのノートを 16 トラックで周ごとに重ねても、溜まっている数は再生時間に比例して増えない', () => {
    const names = 'ACDEFGHIJKLMNOP'.split('');
    const { player } = make(['B t999 L r%2 E', ...names.map((n) => `${n} c%32`)].join('\n'));
    let step = 0;
    let maxSent = 0;
    let maxPending = 0;
    const runTo = (seconds: number) => {
      for (; step < seconds / 0.025; step++) {
        const now = Math.round(step * 0.025 * SR);
        player.pump(now, now + 0.1 * SR);
        maxSent = Math.max(maxSent, player.sentCount);
        maxPending = Math.max(maxPending, player.pendingCount);
      }
    };
    runTo(10);
    const at10 = { sent: maxSent, pending: maxPending };
    expect(at10.sent).toBeGreaterThan(0);
    runTo(40);
    // 毎周ためると 40 秒で 3 万周 × 15 トラックになる。10 秒の時点で頭打ちで、40 秒でも最大は変わらない
    expect({ sent: maxSent, pending: maxPending }).toEqual(at10);
  });
});
