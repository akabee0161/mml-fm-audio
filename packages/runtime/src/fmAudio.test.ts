import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FmAudio, type AudioContextLike, type BiquadFilterNodeLike, type GainNodeLike, type RuntimeEngine } from './fmAudio.ts';

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
      const node: GainNodeLike = { gain: param(), connect: (to, output) => void connections.push({ from: node, to, output }), disconnect() {} };
      gains.push(node);
      return node;
    },
    createBiquadFilter() {
      const node: BiquadFilterNodeLike = { type: "lowpass", frequency: param(), Q: param(), connect: (to, output) => void connections.push({ from: node, to, output }), disconnect() {} };
      return node;
    },
  } satisfies AudioContextLike;
  return { context, gains, connections, destination };
}

type NoteOn = { id: number; program: number; note: number; time: number; group: string };

function fakeEngine() {
  const noteOns: NoteOn[] = [];
  const cancels: number[][] = [];
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
    registerVoice: vi.fn(),
    onWarning(handler) {
      warn = handler;
    },
    node,
  };
  return { engine, noteOns, cancels, node, warn: (m: string) => warn(m) };
}

function setup() {
  const c = fakeContext();
  const e = fakeEngine();
  const audio = FmAudio.create({ context: c.context, engine: e.engine });
  /** 25 ms ずつ、時計とタイマーを進める */
  const run = (seconds: number) => {
    for (let i = 0; i < Math.round(seconds / 0.025); i++) {
      c.context.currentTime += 0.025;
      vi.advanceTimersByTime(25);
    }
  };
  return { audio, run, ...c, ...e };
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
    expect(noteOns).toHaveLength(0);
    run(0.025);
    // 曲の頭は 0.05 秒。0.025 + 0.1 までの c だけ
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
});
