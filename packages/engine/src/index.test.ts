import { FmEngine } from './index';
import type { EngineMessage } from './messages';

class FakeAudioWorkletNode {
  readonly port = { postMessage: (message: EngineMessage) => this.sent.push(message), onmessage: null as unknown };
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

describe('FmEngine.noteOn / noteOff の引数検証', () => {
  let originalAudioWorkletNode: unknown;
  let node: FakeAudioWorkletNode;

  beforeEach(async () => {
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

  it('noteOn: note が NaN なら RangeError を投げ、何も送らない', async () => {
    const { engine, node } = await createEngine();
    expect(() => engine.noteOn(NaN, 0)).toThrow(RangeError);
    expect(() => engine.noteOn(NaN, 0)).toThrow(/noteOn/);
    expect(node.sent).toHaveLength(0);
  });

  it('noteOn: time が Infinity なら RangeError を投げ、何も送らない', async () => {
    const { engine, node } = await createEngine();
    expect(() => engine.noteOn(60, Infinity)).toThrow(RangeError);
    expect(node.sent).toHaveLength(0);
  });

  it('noteOff: time が NaN なら RangeError を投げ、何も送らない', async () => {
    const { engine, node } = await createEngine();
    expect(() => engine.noteOff(NaN)).toThrow(RangeError);
    expect(() => engine.noteOff(NaN)).toThrow(/noteOff/);
    expect(node.sent).toHaveLength(0);
  });

  it('noteOn: 有限の値なら期待通りのメッセージを送る', async () => {
    const { engine, node } = await createEngine();
    engine.noteOn(60, 100);
    expect(node.sent).toEqual([{ type: 'noteOn', note: 60, time: 100 }]);
  });

  it('noteOff: 有限の値なら期待通りのメッセージを送る', async () => {
    const { engine, node } = await createEngine();
    engine.noteOff(100);
    expect(node.sent).toEqual([{ type: 'noteOff', time: 100 }]);
  });
});
