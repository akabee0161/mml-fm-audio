import { FmEngine } from './index';
import type { EngineMessage, EngineReply } from './messages';
import type { FmVoice } from './voiceData';

class FakeAudioWorkletNode {
  readonly port = {
    postMessage: (message: EngineMessage) => this.sent.push(message),
    onmessage: null as ((event: { data: EngineReply }) => void) | null,
  };
  readonly sent: EngineMessage[] = [];
  constructor(
    public context: unknown,
    public name: string,
    public options: unknown,
  ) {}
}

const fakeContext = {
  audioWorklet: { addModule: async () => {} },
  currentTime: 0,
  sampleRate: 48000,
};

const timbre = { id: 0, name: 'T', kind: 'fm', bo: 0, alg: 1, lfo: 0, ops: [] } as unknown as FmVoice;

describe('FmEngine', () => {
  let originalAudioWorkletNode: unknown;

  beforeEach(() => {
    originalAudioWorkletNode = (globalThis as Record<string, unknown>).AudioWorkletNode;
    (globalThis as Record<string, unknown>).AudioWorkletNode = FakeAudioWorkletNode;
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).AudioWorkletNode = originalAudioWorkletNode;
  });

  async function createEngine(): Promise<{ engine: FmEngine; node: FakeAudioWorkletNode }> {
    const engine = await FmEngine.create(fakeContext as unknown as BaseAudioContext);
    return { engine, node: engine.node as unknown as FakeAudioWorkletNode };
  }

  it('noteOn は 1 から順に ID を振って返し、pan の既定は 64', async () => {
    const { engine, node } = await createEngine();
    expect(engine.noteOn(0, 60, { time: 100 })).toBe(1);
    expect(engine.noteOn(128, 36, { pan: 10, time: 200 })).toBe(2);
    expect(node.sent).toEqual([
      { type: 'noteOn', id: 1, program: 0, note: 60, pan: 64, volume: 1, bend: 0, time: 100 },
      { type: 'noteOn', id: 2, program: 128, note: 36, pan: 10, volume: 1, bend: 0, time: 200 },
    ]);
  });

  it('cancel に配列でない値を渡すと RangeError', async () => {
    const { engine } = await createEngine();
    expect(() => engine.cancel(5 as unknown as number[])).toThrow(RangeError);
    expect(() => engine.cancel(null as unknown as number[])).toThrow(RangeError);
  });

  it('noteOff は ID を送る', async () => {
    const { engine, node } = await createEngine();
    engine.noteOff(3, 100);
    expect(node.sent).toEqual([{ type: 'noteOff', id: 3, time: 100 }]);
  });

  it('registerVoice は program と音色を送る', async () => {
    const { engine, node } = await createEngine();
    engine.registerVoice(5, timbre);
    expect(node.sent).toEqual([{ type: 'registerVoice', program: 5, voice: timbre }]);
  });

  it.each([
    ['note が NaN', () => [0, NaN, {}]],
    ['note が 128', () => [0, 128, {}]],
    ['note が −1', () => [0, -1, {}]],
    ['program が 256', () => [256, 60, {}]],
    ['program が 1.5', () => [1.5, 60, {}]],
    ['pan が 128', () => [0, 60, { pan: 128 }]],
    ['pan が 0.5', () => [0, 60, { pan: 0.5 }]],
    ['time が Infinity', () => [0, 60, { time: Infinity }]],
  ] as Array<[string, () => [number, number, { pan?: number; time?: number }]]>)('noteOn: %s なら RangeError を投げ、何も送らない', async (_label, args) => {
    const { engine, node } = await createEngine();
    const [program, note, options] = args();
    expect(() => engine.noteOn(program, note, options)).toThrow(RangeError);
    expect(() => engine.noteOn(program, note, options)).toThrow(/noteOn/);
    expect(node.sent).toHaveLength(0);
  });

  it('noteOff: id が整数でない・time が NaN なら RangeError を投げ、何も送らない', async () => {
    const { engine, node } = await createEngine();
    expect(() => engine.noteOff(1.5)).toThrow(RangeError);
    expect(() => engine.noteOff(1, NaN)).toThrow(/noteOff/);
    expect(node.sent).toHaveLength(0);
  });

  it('registerVoice: program が範囲外なら RangeError', async () => {
    const { engine, node } = await createEngine();
    expect(() => engine.registerVoice(-1, timbre)).toThrow(RangeError);
    expect(node.sent).toHaveLength(0);
  });

  it('setLoadReport を送り、load の返信を onLoad に渡す', async () => {
    const { engine, node } = await createEngine();
    const reports: unknown[] = [];
    engine.onLoad((report) => reports.push(report));
    engine.setLoadReport(true);
    expect(node.sent).toEqual([{ type: 'setLoadReport', enabled: true }]);
    const report = { avgMs: 1, maxMs: 2, blockMs: 2.67, percent: 37, maxVoices: 16, clock: 'performance' as const };
    node.port.onmessage!({ data: { type: 'load', report } });
    expect(reports).toEqual([report]);
  });

  it('warning の返信を onWarning に渡す', async () => {
    const { engine, node } = await createEngine();
    const warnings: string[] = [];
    engine.onWarning((m) => warnings.push(m));
    node.port.onmessage!({ data: { type: 'warning', message: 'x' } });
    expect(warnings).toEqual(['x']);
  });

  it('小数の time はサンプル単位に丸めて送る', async () => {
    const { engine, node } = await createEngine();
    const id = engine.noteOn(0, 60, { time: 10.5 });
    engine.noteOff(id, 20.4);
    expect(node.sent).toEqual([
      { type: 'noteOn', id, program: 0, note: 60, pan: 64, volume: 1, bend: 0, time: 11 },
      { type: 'noteOff', id, time: 20 },
    ]);
  });

  it('noteOn は volume と bend を送る', async () => {
    const { engine, node } = await createEngine();
    const id = engine.noteOn(0, 60, { volume: 0.5, bend: -100, time: 10 });
    expect(node.sent).toEqual([{ type: 'noteOn', id, program: 0, note: 60, pan: 64, volume: 0.5, bend: -100, time: 10 }]);
  });

  it('setPitchBend・setVolume・cancel のメッセージを送る', async () => {
    const { engine, node } = await createEngine();
    engine.setPitchBend(3, 50, 100);
    engine.setVolume(3, 0.25, 100);
    engine.cancel([1, 2]);
    expect(node.sent).toEqual([
      { type: 'setPitchBend', id: 3, cents: 50, time: 100 },
      { type: 'setVolume', id: 3, volume: 0.25, time: 100 },
      { type: 'cancel', ids: [1, 2] },
    ]);
  });

  it('音量・ピッチベンド・取り消しの引数が範囲外なら RangeError を投げ、何も送らない', async () => {
    const { engine, node } = await createEngine();
    expect(() => engine.noteOn(0, 60, { volume: 1.5 })).toThrow(RangeError);
    expect(() => engine.noteOn(0, 60, { bend: 1201 })).toThrow(RangeError);
    expect(() => engine.setPitchBend(1.5, 0)).toThrow(/setPitchBend/);
    expect(() => engine.setPitchBend(1, -1201)).toThrow(RangeError);
    expect(() => engine.setVolume(1, NaN)).toThrow(/setVolume/);
    expect(() => engine.setVolume(1, 0.5, Infinity)).toThrow(RangeError);
    expect(() => engine.cancel([1, 2.5])).toThrow(/cancel/);
    expect(node.sent).toHaveLength(0);
  });

  it('registerVoice: FM 音色は 0〜127、ドラムは 128〜255 にしか登録できない', async () => {
    const { engine, node } = await createEngine();
    const drum = { id: 128, name: 'bd', kind: 'drum' } as const;
    expect(() => engine.registerVoice(200, timbre)).toThrow(RangeError);
    expect(() => engine.registerVoice(0, drum)).toThrow(/registerVoice/);
    expect(node.sent).toHaveLength(0);
    engine.registerVoice(127, timbre);
    engine.registerVoice(255, drum);
    expect(node.sent).toHaveLength(2);
  });
});
