import processorUrl from './processor.ts?worker&url';
import { PROCESSOR_NAME, type EngineMessage, type EngineReply } from './messages';
import type { FmVoice } from './voiceData';

export { OP_FIELDS, OP_RANGES, opCount, validateVoice } from './voiceData';
export type { FmOperator, FmVoice, ValidationError, ValidationResult } from './voiceData';

/** メインスレッドから音源を操作する */
export class FmEngine {
  private readonly warningHandlers: Array<(message: string) => void> = [];

  private constructor(
    private readonly context: BaseAudioContext,
    readonly node: AudioWorkletNode,
  ) {
    node.port.onmessage = (event: MessageEvent<EngineReply>) => {
      if (event.data.type === 'warning') {
        for (const handler of this.warningHandlers) handler(event.data.message);
      }
    };
  }

  /** Worklet を読み込んでノードを作る。出力先への接続は呼び出し側で行う */
  static async create(context: BaseAudioContext): Promise<FmEngine> {
    await context.audioWorklet.addModule(processorUrl);
    const node = new AudioWorkletNode(context, PROCESSOR_NAME, { numberOfInputs: 0, outputChannelCount: [2] });
    return new FmEngine(context, node);
  }

  /** 検証済みの音色を送る（validateVoice を通したもの） */
  setVoice(voice: FmVoice): void {
    this.send({ type: 'setVoice', voice });
  }

  noteOn(note: number, time = this.nowFrame()): void {
    if (!Number.isFinite(note) || !Number.isFinite(time)) {
      throw new RangeError(`noteOn: note と time は有限の数値にしてください（note=${note}, time=${time}）`);
    }
    this.send({ type: 'noteOn', note, time });
  }

  noteOff(time = this.nowFrame()): void {
    if (!Number.isFinite(time)) {
      throw new RangeError(`noteOff: time は有限の数値にしてください（time=${time}）`);
    }
    this.send({ type: 'noteOff', time });
  }

  setQuantize(enabled: boolean): void {
    this.send({ type: 'setQuantize', enabled });
  }

  onWarning(handler: (message: string) => void): void {
    this.warningHandlers.push(handler);
  }

  private nowFrame(): number {
    return Math.round(this.context.currentTime * this.context.sampleRate);
  }

  private send(message: EngineMessage): void {
    this.node.port.postMessage(message);
  }
}
