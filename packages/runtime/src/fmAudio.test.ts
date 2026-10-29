import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FmAudio, type AudioContextLike, type GainNodeLike, type RuntimeEngine } from './fmAudio.ts';

const SR = 48000;

function fakeContext() {
  const gains: GainNodeLike[] = [];
  const connections: Array<{ from: unknown; to: unknown; output?: number }> = [];
  const param = () => ({
    value: 1,
    setValueAtTime: vi.fn(),
    setTargetAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
  });
  const destination = { name: 'destination' };
  const context = {
    currentTime: 0,
    sampleRate: SR,
    state: 'suspended',
    destination,
    resume: vi.fn(async () => {}),
    suspend: vi.fn(async () => {}),
    createGain() {
      const node: GainNodeLike = { gain: param(), connect: (to, output) => void connections.push({ from: node, to, output }) };
      gains.push(node);
      return node;
    },
  } satisfies AudioContextLike;
  return { context, gains, connections, destination };
}

type NoteOn = { id: number; program: number; note: number; time: number; group: string };

function fakeEngine() {
  const noteOns: NoteOn[] = [];
  const cancels: number[][] = [];
  const silences: string[] = [];
  let nextId = 1;
  let warn: (message: string) => void = () => {};
  const node = { connect: vi.fn(), disconnect: vi.fn() };
  const engine: RuntimeEngine = {
    noteOn(program, note, o) {
      const id = nextId++;
      noteOns.push({ id, program, note, time: o.time, group: o.group ?? 'bgm' });
      return id;
    },
    noteOff: vi.fn(),
    setPitchBend: vi.fn(),
    setVolume: vi.fn(),
    cancel(ids) {
      cancels.push([...ids]);
    },
    silence(group) {
      silences.push(group);
    },
    registerVoice: vi.fn(),
    onWarning(handler) {
      warn = handler;
    },
    node,
  };
  return { engine, noteOns, cancels, silences, node, warn: (m: string) => warn(m) };
}

function fakeDocument() {
  let listener: () => void = () => {};
  const doc = {
    hidden: false,
    addEventListener: (_type: 'visibilitychange', l: () => void) => {
      listener = l;
    },
  };
  return {
    doc,
    change: (hidden: boolean) => {
      doc.hidden = hidden;
      listener();
    },
  };
}

function setup() {
  const c = fakeContext();
  const e = fakeEngine();
  const d = fakeDocument();
  const audio = FmAudio.create({ context: c.context, engine: e.engine, document: d.doc });
  /** 25 ms ずつ、時計とタイマーを進める */
  const run = (seconds: number) => {
    for (let i = 0; i < Math.round(seconds / 0.025); i++) {
      c.context.currentTime += 0.025;
      vi.advanceTimersByTime(25);
    }
  };
  return { audio, run, changeVisibility: d.change, ...c, ...e };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('FmAudio', () => {
  it('ノードを engine 出力0→bgmFade→bgmGain→master、出力1→seGain→master、master→destination とつなぐ', () => {
    const { audio, node, destination, connections, gains } = setup();
    const [bgmFade, bgmGain, seGain, master] = gains;
    expect(node.connect.mock.calls).toEqual([[bgmFade, 0], [seGain, 1]]);
    expect(connections).toEqual([
      { from: bgmFade, to: bgmGain, output: undefined },
      { from: bgmGain, to: master, output: undefined },
      { from: seGain, to: master, output: undefined },
      { from: master, to: destination, output: undefined },
    ]);
    expect(audio.output).toBe(master);
  });

  it('resume は context.resume を呼ぶ', async () => {
    const { audio, context } = setup();
    await audio.resume();
    expect(context.resume).toHaveBeenCalledTimes(1);
  });

  it('playBgm した曲のノートを BGM 側（group: bgm）へ、25 ms ごとに 0.1 秒先まで送る', () => {
    const { audio, run, noteOns } = setup();
    audio.playBgm(audio.load('A c4 d4 e4'));
    // 呼んだ直後に 1 回 pump する。曲の頭は 0.05 秒で、0.1 秒先までの c だけ
    expect(noteOns.map((n) => n.note)).toEqual([60]);
    run(0.025);
    expect(noteOns.map((n) => n.note)).toEqual([60]);
    expect(noteOns[0]).toMatchObject({ group: 'bgm', time: 2400 });
    run(1);
    expect(noteOns.map((n) => n.note)).toEqual([60, 62, 64]);
    expect(noteOns.map((n) => n.time)).toEqual([2400, 26400, 50400]);
    expect(noteOns.every((n) => n.group === 'bgm')).toBe(true);
  });

  it('playSe した曲のノートを効果音側（group: se）へ送り、同じ曲を続けて鳴らすと重なる', () => {
    const { audio, run, noteOns } = setup();
    const se = audio.load('A c4');
    audio.playSe(se);
    run(0.025);
    audio.playSe(se);
    run(0.2);
    expect(noteOns).toHaveLength(2);
    expect(noteOns.every((n) => n.group === 'se')).toBe(true);
    expect(noteOns[1]!.time).toBeGreaterThan(noteOns[0]!.time);
  });

  it('効果音の L は無視して最後まで鳴らす（A L c4 を鳴らしても noteOn は 1 回）', () => {
    const { audio, run, noteOns, context } = setup();
    audio.playSe(audio.load('A L c4'));
    run(2);
    expect(noteOns).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(context.currentTime).toBeGreaterThan(1.9);
  });

  it('playBgm を続けて呼ぶと前の Player を止める（前の曲の ID を cancel し、以後は新しい曲だけ送る）', () => {
    const { audio, run, noteOns, cancels } = setup();
    audio.playBgm(audio.load('A @1 L c4'));
    run(0.025);
    const firstId = noteOns[0]!.id;
    audio.playBgm(audio.load('A @2 L d4'));
    expect(cancels).toEqual([[firstId]]);
    const before = noteOns.length;
    run(1.5);
    const after = noteOns.slice(before);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((n) => n.program === 2)).toBe(true);
  });

  it('最初の tick が 60 ms 遅れても、playBgm・playSe の直後に 1 回 pump するので最初のノートは消えない', () => {
    const bgm = setup();
    bgm.audio.playBgm(bgm.audio.load('A t180 l16 e b4')); // e は 0.05 秒、b は約 0.133 秒
    bgm.context.currentTime = 0.06;
    vi.advanceTimersByTime(25);
    expect(bgm.noteOns.map((n) => n.note)).toEqual([64, 71]);
    const se = setup();
    se.audio.playSe(se.audio.load('A t180 l16 e b4'));
    se.context.currentTime = 0.06;
    vi.advanceTimersByTime(25);
    expect(se.noteOns.map((n) => n.note)).toEqual([64, 71]);
  });

  it('エラーのある曲を playBgm すると何も送らず、鳴っている BGM を止め、warning を 1 回出す', () => {
    const { audio, run, noteOns, cancels } = setup();
    const warnings: string[] = [];
    audio.on('warning', (m) => warnings.push(m));
    audio.playBgm(audio.load('A L c4'));
    run(0.025);
    audio.playBgm(audio.load('A c4&d4'));
    expect(cancels).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('1 行 6 列');
    const before = noteOns.length;
    run(1);
    expect(noteOns).toHaveLength(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('エラーのある曲を playSe すると何も送らず、warning を出す（鳴っている BGM はそのまま）', () => {
    const { audio, run, noteOns, cancels } = setup();
    const warnings: string[] = [];
    audio.on('warning', (m) => warnings.push(m));
    audio.playBgm(audio.load('A L c4'));
    audio.playSe(audio.load('A c4&d4'));
    expect(warnings).toHaveLength(1);
    expect(cancels).toHaveLength(0);
    run(0.2);
    expect(noteOns.length).toBeGreaterThan(0);
    expect(noteOns.every((n) => n.group === 'bgm')).toBe(true);
  });

  it('load は例外を投げず、エラーを song.errors に入れて返す', () => {
    const { audio } = setup();
    expect(() => audio.load('A c4&d4')).not.toThrow();
    expect(audio.load('A c4&d4').errors[0]).toMatchObject({ line: 1, column: 6 });
  });

  /** currentTime を直接セットしてタイマーを 1 回だけ進める（境界を避けた確認用） */
  const tickAt = (c: { currentTime: number }, seconds: number) => {
    c.currentTime = seconds;
    vi.advanceTimersByTime(25);
  };

  it('loop は L の位置が鳴る時刻に呼ぶ。先読みで送った時点では呼ばない', () => {
    const { audio, context } = setup();
    const loops = vi.fn();
    audio.on('loop', loops);
    audio.playBgm(audio.load('A L c4 d4')); // 1 周 1 秒、曲の頭は 0.05 秒なので 2 周目の頭は 1.05 秒
    tickAt(context, 1.025); // 先読み（〜1.125 秒）は 2 周目の頭を越えているが、まだ鳴る時刻ではない
    expect(loops).not.toHaveBeenCalled();
    tickAt(context, 1.06);
    expect(loops).toHaveBeenCalledTimes(1);
    tickAt(context, 1.07);
    expect(loops).toHaveBeenCalledTimes(1);
  });

  it('複数周を 1 回のタイマーで越えたら、越えた分だけ loop を呼ぶ', () => {
    const { audio, context } = setup();
    const loops = vi.fn();
    audio.on('loop', loops);
    audio.playBgm(audio.load('A L c4 d4')); // 周の頭は 1.05、2.05、3.05 秒
    tickAt(context, 2.6);
    expect(loops).toHaveBeenCalledTimes(2);
  });

  it('end は L のない BGM の曲の終わりが鳴る時刻に 1 回だけ呼び、stopBgm では呼ばない', () => {
    const { audio, context } = setup();
    const ends = vi.fn();
    audio.on('end', ends);
    audio.playBgm(audio.load('A c4 d4')); // 曲の終わりは 1.05 秒
    tickAt(context, 1.025); // 先読みは終わりを越えているが、まだ鳴る時刻ではない
    expect(ends).not.toHaveBeenCalled();
    tickAt(context, 1.06);
    expect(ends).toHaveBeenCalledTimes(1);
    tickAt(context, 2);
    expect(ends).toHaveBeenCalledTimes(1);

    context.currentTime = 3;
    audio.playBgm(audio.load('A c4 d4'));
    tickAt(context, 3.1);
    audio.stopBgm();
    tickAt(context, 6);
    expect(ends).toHaveBeenCalledTimes(1);
  });

  it('on の戻り値を呼ぶと、その handler は呼ばれなくなる', () => {
    const { audio, run } = setup();
    const ends = vi.fn();
    const off = audio.on('end', ends);
    off();
    audio.playBgm(audio.load('A c4'));
    run(1);
    expect(ends).not.toHaveBeenCalled();
  });

  it('handler が例外を投げても、他の handler と tick の残り（効果音の pump・タイマーを止める判定）は飛ばない。例外は microtask で投げ直す', () => {
    const rethrown: unknown[] = [];
    vi.stubGlobal('queueMicrotask', (f: () => void) => {
      try { f(); } catch (e) { rethrown.push(e); }
    });
    try {
      const { audio, context } = setup();
      const boom = new Error('boom');
      const second = vi.fn();
      audio.on('end', () => { throw boom; });
      audio.on('end', second);
      audio.playBgm(audio.load('A c4')); // 終わりは 0.55 秒
      audio.playSe(audio.load('A c4'));
      tickAt(context, 0.6);
      expect(second).toHaveBeenCalledTimes(1);
      expect(rethrown).toEqual([boom]);
      tickAt(context, 1);
      expect(vi.getTimerCount()).toBe(0); // タイマーを止める判定まで進んだ
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('先読みは 0.1 秒：0.1 秒より先の音は最初の pump で送らず、手前の音は送る', () => {
    const { audio, context, noteOns } = setup();
    // 曲の頭は 0.05 秒。1 ティックは 0.5 / 96 秒なので、ノートは 0.05、約 0.081、約 0.118 秒
    audio.playBgm(audio.load('A t120 c%1 r%5 d%1 r%6 e%1'));
    expect(noteOns.map((n) => n.note)).toEqual([60, 62]);
    tickAt(context, 0); // 時計が進んでいなければ先読みの範囲も変わらない
    expect(noteOns.map((n) => n.note)).toEqual([60, 62]);
    tickAt(context, 0.025); // 〜0.125 秒
    expect(noteOns.map((n) => n.note)).toEqual([60, 62, 64]);
  });

  it('効果音は、1 つ目が鳴っている最中に 2 つ目が始まる（Player が 2 つ同時にある）', () => {
    const { audio, context, noteOns, engine } = setup();
    const se = audio.load('A c4'); // 0.5 秒
    audio.playSe(se);
    tickAt(context, 0.025);
    audio.playSe(se);
    expect(noteOns).toHaveLength(2);
    expect(fn(engine.noteOff)).not.toHaveBeenCalled(); // 1 つ目はまだノートオフに達していない
    tickAt(context, 0.3);
    expect(fn(engine.noteOff)).not.toHaveBeenCalled();
    tickAt(context, 0.46); // 先読み〜0.56 秒：1 つ目のノートオフ（0.55 秒）が入る。2 つ目（0.575 秒）はまだ
    expect(fn(engine.noteOff)).toHaveBeenCalledTimes(1);
    tickAt(context, 0.6);
    expect(fn(engine.noteOff)).toHaveBeenCalledTimes(2);
    tickAt(context, 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('on に知らない種類や関数でない handler を渡すと RangeError', () => {
    const { audio } = setup();
    expect(() => audio.on('x' as never, () => {})).toThrow(RangeError);
    expect(() => audio.on('end', 'f' as never)).toThrow(RangeError);
    expect(() => audio.on('loop', null as never)).toThrow(RangeError);
  });

  it('フェード中に L のない曲が終わりまで来たら end を呼び、bgmFade は次の playBgm で 1 へ戻す', () => {
    const { audio, context, gains, silences } = setup();
    const bgmFade = gains[0]!;
    const ends = vi.fn();
    audio.on('end', ends);
    audio.playBgm(audio.load('A c4')); // 終わりは 0.55 秒
    tickAt(context, 0.025);
    audio.stopBgm({ fadeMs: 5000 });
    tickAt(context, 0.6);
    expect(ends).toHaveBeenCalledTimes(1);
    tickAt(context, 0.7);
    expect(vi.getTimerCount()).toBe(0);
    expect(silences).toEqual([]); // フェードを下げ終えたわけではないので silence しない
    expect(fn(bgmFade.gain.linearRampToValueAtTime)).toHaveBeenCalledTimes(1); // 戻していない
    audio.playBgm(audio.load('A L c4'));
    const back = fn(bgmFade.gain.linearRampToValueAtTime).mock.calls.at(-1)!;
    expect(back[0]).toBe(1);
    expect(back[1]).toBeCloseTo(0.75, 6);
  });

  it('音源の警告を warning として渡す', () => {
    const { audio, warn } = setup();
    const warnings: string[] = [];
    audio.on('warning', (m) => warnings.push(m));
    warn('未登録の音色');
    expect(warnings).toEqual(['未登録の音色']);
  });

  it('何も鳴っていなければタイマーを止め、playBgm・playSe で動かし直す', () => {
    const { audio, run } = setup();
    expect(vi.getTimerCount()).toBe(0);
    audio.playBgm(audio.load('A c4'));
    expect(vi.getTimerCount()).toBe(1);
    run(1);
    expect(vi.getTimerCount()).toBe(0);
    audio.playSe(audio.load('A c4'));
    expect(vi.getTimerCount()).toBe(1);
    run(1);
    expect(vi.getTimerCount()).toBe(0);
    audio.playBgm(audio.load('A L c4'));
    audio.stopBgm();
    run(0.025);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('playBgm・playSe に Song でない値を渡すと RangeError', () => {
    const { audio } = setup();
    expect(() => audio.playBgm('A c4' as never)).toThrow(RangeError);
    expect(() => audio.playSe({} as never)).toThrow(RangeError);
    expect(() => audio.playBgm(null as never)).toThrow(RangeError);
  });

  const fn = (f: unknown) => f as ReturnType<typeof vi.fn>;
  const targetCalls = (g: GainNodeLike) => fn(g.gain.setTargetAtTime).mock.calls;

  it('setVolume は渡した値だけ setTargetAtTime で変え、範囲外なら何も変えずに RangeError', () => {
    const { audio, gains, context } = setup();
    const [, bgmGain, seGain, master] = gains as [GainNodeLike, GainNodeLike, GainNodeLike, GainNodeLike];
    context.currentTime = 2;
    audio.setVolume({ bgm: 0.5 });
    expect(targetCalls(bgmGain)).toEqual([[0.5, 2, 0.005]]);
    expect(targetCalls(seGain)).toHaveLength(0);
    expect(targetCalls(master)).toHaveLength(0);
    audio.setVolume({ master: 0, se: 1 });
    expect(targetCalls(master)).toEqual([[0, 2, 0.005]]);
    expect(targetCalls(seGain)).toEqual([[1, 2, 0.005]]);
    for (const bad of [1.5, -0.1, Number.NaN, Infinity, '0.5']) {
      expect(() => audio.setVolume({ master: 0.5, se: bad as number })).toThrow(RangeError);
    }
    expect(targetCalls(master)).toHaveLength(1);
    expect(targetCalls(seGain)).toHaveLength(1);
  });

  it('stopBgm({ fadeMs: 1000 }) は 1 秒かけて bgmFade を 0 へ下げ、終わったタイマーで Player を止める（bgmFade は 1 に戻さない）', () => {
    const { audio, context, gains, cancels, run } = setup();
    const bgmFade = gains[0]!;
    audio.playBgm(audio.load('A L c1 d1'));
    run(0.025);
    audio.stopBgm({ fadeMs: 1000 });
    expect(fn(bgmFade.gain.cancelScheduledValues).mock.calls).toEqual([[0.025]]);
    expect(fn(bgmFade.gain.setValueAtTime).mock.calls).toEqual([[1, 0.025]]);
    const ramp = fn(bgmFade.gain.linearRampToValueAtTime).mock.calls;
    expect(ramp).toHaveLength(1);
    expect(ramp[0]![0]).toBe(0);
    expect(ramp[0]![1]).toBeCloseTo(1.025, 6);
    tickAt(context, 0.9);
    expect(cancels).toHaveLength(0);
    expect(fn(bgmFade.gain.setValueAtTime)).toHaveBeenCalledTimes(1);
    tickAt(context, 1.1);
    expect(cancels).toHaveLength(1);
    // 止めても bgmFade は 0 へ向かったまま（リリースの尾が全音量で鳴らないよう、1 を予約しない）
    expect(fn(bgmFade.gain.setValueAtTime)).toHaveBeenCalledTimes(1);
    expect(fn(bgmFade.gain.linearRampToValueAtTime)).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('フェードを下げ終えた時点で BGM 側のボイスを silence する（cancel の後に 1 回だけ）', () => {
    const { audio, context, silences, cancels } = setup();
    audio.playBgm(audio.load('A L c1 d1'));
    tickAt(context, 0.025);
    audio.stopBgm({ fadeMs: 1000 });
    tickAt(context, 0.9);
    expect(silences).toEqual([]);
    tickAt(context, 1.1);
    expect(cancels).toHaveLength(1);
    expect(silences).toEqual(['bgm']);
    tickAt(context, 2);
    expect(silences).toEqual(['bgm']);
  });

  it('フェード中の playBgm・pauseBgm・fadeMs なしの stopBgm、フェードなしの stopBgm では silence しない', () => {
    const a = setup();
    a.audio.playBgm(a.audio.load('A L c1 d1'));
    tickAt(a.context, 0.025);
    a.audio.stopBgm({ fadeMs: 2000 });
    tickAt(a.context, 0.5);
    a.audio.playBgm(a.audio.load('A L e1'));
    tickAt(a.context, 3);
    expect(a.silences).toEqual([]);

    const b = setup();
    b.audio.playBgm(b.audio.load('A L c1 d1'));
    tickAt(b.context, 0.025);
    b.audio.stopBgm({ fadeMs: 2000 });
    tickAt(b.context, 0.5);
    b.audio.pauseBgm();
    tickAt(b.context, 3);
    expect(b.silences).toEqual([]);

    const c = setup();
    c.audio.playBgm(c.audio.load('A L c1 d1'));
    tickAt(c.context, 0.025);
    c.audio.stopBgm({ fadeMs: 2000 });
    tickAt(c.context, 0.5);
    c.audio.stopBgm();
    tickAt(c.context, 3);
    expect(c.silences).toEqual([]);

    const d = setup();
    d.audio.playBgm(d.audio.load('A L c1 d1'));
    tickAt(d.context, 0.025);
    d.audio.stopBgm();
    tickAt(d.context, 3);
    expect(d.silences).toEqual([]);
  });

  it('フェードの途中で stopBgm し直すと、gain.value を読まず、予約したフェードの今の値から下げ直す', () => {
    const { audio, context, gains } = setup();
    const bgmFade = gains[0]!;
    Object.defineProperty(bgmFade.gain, 'value', { get: () => { throw new Error('gain.value を読んではいけない'); } });
    audio.playBgm(audio.load('A L c1 d1'));
    tickAt(context, 0.025);
    audio.stopBgm({ fadeMs: 1000 }); // 0.025 秒で 1、1.025 秒で 0
    tickAt(context, 0.525);
    audio.stopBgm({ fadeMs: 100 }); // 0.525 秒の値は 0.5、0.625 秒で 0
    const [value, time] = fn(bgmFade.gain.setValueAtTime).mock.calls.at(-1)!;
    expect(value).toBeCloseTo(0.5, 6);
    expect(time).toBeCloseTo(0.525, 6);
  });

  it('フェード中も BGM のノートを送り続ける', () => {
    const { audio, context, noteOns } = setup();
    audio.playBgm(audio.load('A L c4 d4')); // ノートは 0.05、0.55、1.05 秒…
    tickAt(context, 0.025);
    audio.stopBgm({ fadeMs: 2000 });
    const before = noteOns.length;
    tickAt(context, 0.5); // 先読み（〜0.6 秒）に 2 つ目のノートが入る
    expect(noteOns.length).toBe(before + 1);
    tickAt(context, 1.0);
    expect(noteOns.length).toBe(before + 2);
  });

  it('フェード中に playBgm すると新しい曲はフェードの倍率 1 で鳴る（前の曲は cancel される）', () => {
    const { audio, context, gains, cancels, noteOns } = setup();
    const bgmFade = gains[0]!;
    audio.playBgm(audio.load('A @1 L c4'));
    tickAt(context, 0.025);
    audio.stopBgm({ fadeMs: 2000 });
    tickAt(context, 0.5);
    audio.playBgm(audio.load('A @2 L d4'));
    expect(cancels).toHaveLength(1);
    expect(fn(bgmFade.gain.cancelScheduledValues).mock.calls.at(-1)).toEqual([0.5]);
    // 新しい曲の頭（0.5 + 0.05 秒）に向けて、予約したフェードから出した今の値（0.025 秒で 1、2.025 秒で 0 の直線の 0.5 秒）から 1 へ戻す
    const [startValue, startTime] = fn(bgmFade.gain.setValueAtTime).mock.calls.at(-1)!;
    expect(startValue).toBeCloseTo(1 - 0.475 / 2, 6);
    expect(startTime).toBe(0.5);
    const back = fn(bgmFade.gain.linearRampToValueAtTime).mock.calls.at(-1)!;
    expect(back[0]).toBe(1);
    expect(back[1]).toBeCloseTo(0.55, 6);
    const before = noteOns.length;
    tickAt(context, 3); // 古いフェードの終わり（2.025 秒）を過ぎても新しい曲は止まらない
    expect(cancels).toHaveLength(1);
    expect(noteOns.length).toBeGreaterThan(before);
    expect(noteOns.slice(before).every((n) => n.program === 2)).toBe(true);
  });

  it('フェード中に pauseBgm するとすぐ止まり、resumeBgm しても鳴らない', () => {
    const { audio, context, gains, cancels, noteOns } = setup();
    const bgmFade = gains[0]!;
    audio.playBgm(audio.load('A L c4 d4'));
    tickAt(context, 0.025);
    audio.stopBgm({ fadeMs: 2000 });
    tickAt(context, 0.3);
    audio.pauseBgm();
    expect(cancels).toHaveLength(1);
    expect(fn(bgmFade.gain.linearRampToValueAtTime)).toHaveBeenCalledTimes(1); // 1 へ戻さない
    vi.advanceTimersByTime(25);
    expect(vi.getTimerCount()).toBe(0);
    const before = noteOns.length;
    audio.resumeBgm();
    tickAt(context, 3);
    expect(noteOns).toHaveLength(before);
  });

  it('フェード中に fadeMs なしの stopBgm を呼ぶとすぐ止まる', () => {
    const { audio, context, gains, cancels } = setup();
    const bgmFade = gains[0]!;
    audio.playBgm(audio.load('A L c4 d4'));
    tickAt(context, 0.025);
    audio.stopBgm({ fadeMs: 2000 });
    tickAt(context, 0.3);
    audio.stopBgm();
    expect(cancels).toHaveLength(1);
    expect(fn(bgmFade.gain.linearRampToValueAtTime)).toHaveBeenCalledTimes(1); // 1 へ戻さない
    vi.advanceTimersByTime(25);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('フェード中にもう一度 fadeMs つきで呼ぶと、終わりが早いほうに合わせる', () => {
    const { audio, context, gains, cancels } = setup();
    const bgmFade = gains[0]!;
    audio.playBgm(audio.load('A L c4 d4'));
    tickAt(context, 0.025);
    audio.stopBgm({ fadeMs: 2000 }); // 終わりは 2.025 秒
    tickAt(context, 0.1);
    audio.stopBgm({ fadeMs: 5000 }); // 遅くなるので無視
    expect(fn(bgmFade.gain.linearRampToValueAtTime)).toHaveBeenCalledTimes(1);
    audio.stopBgm({ fadeMs: 400 }); // 終わりは 0.5 秒
    expect(fn(bgmFade.gain.linearRampToValueAtTime).mock.calls.at(-1)).toEqual([0, 0.5]);
    expect(fn(bgmFade.gain.cancelScheduledValues).mock.calls.at(-1)).toEqual([0.1]);
    tickAt(context, 0.4);
    expect(cancels).toHaveLength(0);
    tickAt(context, 0.6);
    expect(cancels).toHaveLength(1);
  });

  it('stopBgm の fadeMs が負・有限でないときは RangeError で、何も変えない', () => {
    const { audio, gains, cancels } = setup();
    audio.playBgm(audio.load('A L c4'));
    for (const bad of [-1, Number.NaN, Infinity, '100']) {
      expect(() => audio.stopBgm({ fadeMs: bad as number })).toThrow(RangeError);
    }
    expect(cancels).toHaveLength(0);
    expect(fn(gains[0]!.gain.linearRampToValueAtTime)).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
  });

  it('pauseBgm・resumeBgm で Player の pause・resume を呼び、一時停止中は loop・end を呼ばない', () => {
    const { audio, context, noteOns, cancels } = setup();
    const loops = vi.fn();
    audio.on('loop', loops);
    audio.playBgm(audio.load('A L c4 d4')); // 周の頭は 1.05、2.05 秒
    tickAt(context, 0.025);
    tickAt(context, 0.46); // 2 つ目のノート（0.55 秒）まで送り済み
    expect(noteOns).toHaveLength(2);
    audio.pauseBgm(); // 止める時刻は 0.51 秒
    expect(cancels).toHaveLength(1);
    vi.advanceTimersByTime(25); // 次のタイマーで止まる
    expect(vi.getTimerCount()).toBe(0);
    context.currentTime = 5; // 長く止める
    vi.advanceTimersByTime(100);
    expect(loops).not.toHaveBeenCalled();
    expect(noteOns).toHaveLength(2);
    audio.resumeBgm(); // 5.05 秒から続ける。2 周目の頭は 5.05 + (1.05 - 0.51) = 5.59 秒
    expect(vi.getTimerCount()).toBe(1);
    tickAt(context, 5.0);
    expect(noteOns).toHaveLength(3); // 止める前に送り済みだった 2 つ目のノートを送り直す
    tickAt(context, 5.3);
    expect(loops).not.toHaveBeenCalled();
    tickAt(context, 5.7);
    expect(loops).toHaveBeenCalledTimes(1);
  });

  it('pauseBgm は currentTime + 0.05 秒を止める時刻にする。その間にノートオンするノートは持続中として扱い、再開後に鳴らし直さない', () => {
    const { audio, context, noteOns, cancels } = setup();
    audio.playBgm(audio.load('A t120 l4 c d e')); // ノートオンは 0.05、0.55、1.05 秒。d は 62
    tickAt(context, 0.5); // d（0.55 秒）まで送り済み
    expect(noteOns.map((n) => n.note)).toEqual([60, 62]);
    context.currentTime = 0.52; // d は呼んだ 0.03 秒後（< 0.05 秒）に鳴る
    audio.pauseBgm();
    expect(cancels.at(-1)).toContain(noteOns[1]!.id);
    context.currentTime = 3;
    audio.resumeBgm();
    tickAt(context, 3.0);
    tickAt(context, 3.2);
    expect(noteOns.filter((n) => n.note === 62)).toHaveLength(1);
  });

  it('pauseBgm から 0.08 秒後に鳴るノートは cancel し、再開後に 1 回だけ送り直す（resumeBgm の時刻も currentTime + 0.05 秒）', () => {
    const { audio, context, noteOns } = setup();
    audio.playBgm(audio.load('A t120 l4 c d e'));
    tickAt(context, 0.47); // d（0.55 秒）まで送り済み
    expect(noteOns.map((n) => n.note)).toEqual([60, 62]);
    audio.pauseBgm(); // 止める時刻は 0.52 秒、d は 0.03 秒後
    context.currentTime = 3;
    audio.resumeBgm(); // 続きは 3.05 秒から。d は 3.05 + 0.03 = 3.08 秒
    tickAt(context, 3.0);
    tickAt(context, 3.2);
    const ds = noteOns.filter((n) => n.note === 62);
    expect(ds).toHaveLength(2);
    expect(ds[1]!.time / SR).toBeCloseTo(3.08, 6);
  });

  it('resumeBgm の直後（tick を待たずに）、再開後の最初のノートを送る', () => {
    const { audio, context, noteOns } = setup();
    audio.playBgm(audio.load('A t120 l4 c d e'));
    tickAt(context, 0.47); // d（0.55 秒）まで送り済み
    expect(noteOns.map((n) => n.note)).toEqual([60, 62]);
    audio.pauseBgm(); // 止める時刻は 0.52 秒、d は 0.03 秒後
    context.currentTime = 3;
    audio.resumeBgm(); // d は 3.05 + 0.03 = 3.08 秒。先読み（〜3.1 秒）の中
    const ds = noteOns.filter((n) => n.note === 62);
    expect(ds).toHaveLength(2);
    expect(ds[1]!.time / SR).toBeCloseTo(3.08, 6);
  });

  it('最後の tick から 50 ms 以上たって pauseBgm しても、ノートオフが未送信で一時停止の時刻より前に終わるノートは、本来の時刻でノートオフを 1 回送る（cancel しない）', () => {
    const { audio, context, noteOns, cancels, engine } = setup();
    audio.playBgm(audio.load('A t120 l16 c r4')); // c は 0.05〜0.175 秒。直後の pump（先読み〜0.1 秒）にはノートオンだけ入る
    expect(noteOns).toHaveLength(1);
    expect(engine.noteOff).not.toHaveBeenCalled();
    context.currentTime = 0.2; // tick なし。止める時刻は 0.25 秒で、c のノートオフ（0.175 秒）より後
    audio.pauseBgm();
    expect(cancels).toEqual([]);
    expect(engine.noteOff).toHaveBeenCalledTimes(1);
    const [id, time] = vi.mocked(engine.noteOff).mock.calls[0]!;
    expect(id).toBe(noteOns[0]!.id);
    expect(time).toBeCloseTo(noteOns[0]!.time + 0.125 * SR, 6);
    context.currentTime = 3;
    audio.resumeBgm();
    tickAt(context, 3.0);
    tickAt(context, 3.2);
    expect(noteOns).toHaveLength(1);
    expect(engine.noteOff).toHaveBeenCalledTimes(1);
  });

  it('一時停止中の L なし BGM は end を呼ばず、再開後に曲の終わりで呼ぶ', () => {
    const { audio, context } = setup();
    const ends = vi.fn();
    audio.on('end', ends);
    audio.playBgm(audio.load('A c4 d4')); // 終わりは 1.05 秒
    tickAt(context, 0.5);
    audio.pauseBgm();
    tickAt(context, 3);
    expect(ends).not.toHaveBeenCalled();
    audio.resumeBgm(); // 終わりは 3 + 0.55 = 3.55 秒
    tickAt(context, 3.3);
    expect(ends).not.toHaveBeenCalled();
    tickAt(context, 3.7);
    expect(ends).toHaveBeenCalledTimes(1);
  });

  it('BGM がないときの pauseBgm・resumeBgm・stopBgm は何もしない（例外にならない）', () => {
    const { audio, cancels } = setup();
    expect(() => {
      audio.pauseBgm();
      audio.resumeBgm();
      audio.stopBgm();
      audio.stopBgm({ fadeMs: 500 });
    }).not.toThrow();
    expect(cancels).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('pauseBgm を重ねても、resumeBgm を重ねても何も起きない', () => {
    const { audio, context, cancels } = setup();
    audio.playBgm(audio.load('A L c4 d4'));
    tickAt(context, 0.025);
    tickAt(context, 0.5);
    audio.resumeBgm(); // 一時停止中でなければ何もしない
    audio.pauseBgm();
    audio.pauseBgm();
    expect(cancels).toHaveLength(1);
    audio.resumeBgm();
    audio.resumeBgm();
    expect(vi.getTimerCount()).toBe(1);
  });

  it('タブが裏に回ると suspend し、表に戻ると resume する', () => {
    const { context, changeVisibility } = setup();
    (context as { state: string }).state = 'running';
    changeVisibility(true);
    expect(context.suspend).toHaveBeenCalledTimes(1);
    (context as { state: string }).state = 'suspended';
    changeVisibility(false);
    expect(context.resume).toHaveBeenCalledTimes(1);
    changeVisibility(false);
    expect(context.resume).toHaveBeenCalledTimes(1);
  });

  it('フェードを終えた後も bgmFade は 0 のまま（1 を予約しない）。次の playBgm で新しい曲の頭の時刻に 1 へ戻し、ノートも送る', () => {
    const { audio, context, gains, noteOns } = setup();
    const bgmFade = gains[0]!;
    audio.playBgm(audio.load('A L c1 d1'));
    tickAt(context, 0.025);
    audio.stopBgm({ fadeMs: 1000 });
    tickAt(context, 1.1); // フェードが終わって止まる
    expect(fn(bgmFade.gain.setValueAtTime)).toHaveBeenCalledTimes(1);
    expect(fn(bgmFade.gain.linearRampToValueAtTime)).toHaveBeenCalledTimes(1);
    const before = noteOns.length;
    audio.playBgm(audio.load('A L c4'));
    const back = fn(bgmFade.gain.linearRampToValueAtTime).mock.calls.at(-1)!;
    expect(back[0]).toBe(1);
    expect(back[1]).toBeCloseTo(1.15, 6);
    expect(fn(bgmFade.gain.cancelScheduledValues).mock.calls.at(-1)).toEqual([1.1]);
    tickAt(context, 1.12);
    expect(noteOns.length).toBeGreaterThan(before);
    // 差し替えのたびに戻す予約を増やさない
    const ramps = fn(bgmFade.gain.linearRampToValueAtTime).mock.calls.length;
    audio.playBgm(audio.load('A L d4'));
    expect(fn(bgmFade.gain.linearRampToValueAtTime)).toHaveBeenCalledTimes(ramps);
  });

  it('stopBgm({ fadeMs: 0 }) はフェードせずすぐ止まる', () => {
    const { audio, context, gains, cancels } = setup();
    audio.playBgm(audio.load('A L c1 d1'));
    tickAt(context, 0.025);
    audio.stopBgm({ fadeMs: 0 });
    expect(cancels).toHaveLength(1);
    expect(fn(gains[0]!.gain.linearRampToValueAtTime)).not.toHaveBeenCalled();
  });

  it('一時停止中に fadeMs つきで stopBgm するとフェードせずすぐ止まる', () => {
    const { audio, context, gains, noteOns } = setup();
    audio.playBgm(audio.load('A L c4 d4'));
    tickAt(context, 0.025);
    tickAt(context, 0.5);
    audio.pauseBgm();
    audio.stopBgm({ fadeMs: 1000 });
    expect(fn(gains[0]!.gain.linearRampToValueAtTime)).not.toHaveBeenCalled();
    const before = noteOns.length;
    audio.resumeBgm();
    tickAt(context, 3);
    expect(noteOns).toHaveLength(before);
  });

  it('stopBgm に object でない options を渡すと RangeError', () => {
    const { audio } = setup();
    expect(() => audio.stopBgm(null as never)).toThrow(RangeError);
    expect(() => audio.stopBgm(5 as never)).toThrow(RangeError);
  });

  it('裏に回る前から止まっていたら、表に戻っても resume しない', () => {
    const { context, changeVisibility } = setup();
    changeVisibility(true); // state は suspended のまま
    expect(context.suspend).not.toHaveBeenCalled();
    changeVisibility(false);
    expect(context.resume).not.toHaveBeenCalled();
  });
});
