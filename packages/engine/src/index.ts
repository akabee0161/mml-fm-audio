import processorUrl from './processor.ts?worker&url';
import type { LoadReport } from './loadMeter';
import { PROCESSOR_NAME, type EngineMessage, type EngineReply } from './messages';
import type { AnyVoice } from './voiceData';

export { OP_FIELDS, OP_RANGES, opCount, validateDrum, validateVoice } from './voiceData';
export type {
  AnyVoice,
  DrumNoise,
  DrumValidationResult,
  DrumVoice,
  FmOperator,
  FmVoice,
  ValidationError,
  ValidationResult,
} from './voiceData';
export type { ClockKind, LoadReport } from './loadMeter';
export { MAX_VOICES } from './voicePool';

const CENTER_PAN = 64;

function isIntIn(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

/** メインスレッドから音源を操作する */
export class FmEngine {
  private readonly warningHandlers: Array<(message: string) => void> = [];
  private readonly loadHandlers: Array<(report: LoadReport) => void> = [];
  private nextId = 1;

  private constructor(
    private readonly context: BaseAudioContext,
    readonly node: AudioWorkletNode,
  ) {
    node.port.onmessage = (event: MessageEvent<EngineReply>) => {
      const reply = event.data;
      if (reply.type === 'warning') {
        for (const handler of this.warningHandlers) handler(reply.message);
      } else if (reply.type === 'load') {
        for (const handler of this.loadHandlers) handler(reply.report);
      }
    };
  }

  /** Worklet を読み込んでノードを作る。出力先への接続は呼び出し側で行う */
  static async create(context: BaseAudioContext): Promise<FmEngine> {
    await context.audioWorklet.addModule(processorUrl);
    const node = new AudioWorkletNode(context, PROCESSOR_NAME, { numberOfInputs: 0, outputChannelCount: [2] });
    return new FmEngine(context, node);
  }

  /**
   * 検証済みの音色（validateVoice・validateDrum を通したもの）を番号に登録する。
   * 0〜127 は FM 音色、128〜255 はドラム（spec §3.3）。鳴っている音は前の音色のまま鳴り終える
   */
  registerVoice(program: number, voice: AnyVoice): void {
    if (!isIntIn(program, 0, 255)) {
      throw new RangeError(`registerVoice: program は 0〜255 の整数にしてください（program=${program}）`);
    }
    this.send({ type: 'registerVoice', program, voice });
  }

  /** program の音色で note を鳴らし、音の ID を返す。pan は 0〜127（既定 64 が中央） */
  noteOn(program: number, note: number, options: { pan?: number; time?: number } = {}): number {
    const { pan = CENTER_PAN, time = this.nowFrame() } = options;
    if (!isIntIn(program, 0, 255) || !isIntIn(note, 0, 127) || !isIntIn(pan, 0, 127) || !Number.isFinite(time)) {
      throw new RangeError(
        `noteOn: program は 0〜255、note と pan は 0〜127 の整数、time は有限の数値にしてください（program=${program}, note=${note}, pan=${pan}, time=${time}）`,
      );
    }
    const id = this.nextId++;
    this.send({ type: 'noteOn', id, program, note, pan, time });
    return id;
  }

  /** noteOn が返した ID の音をキーオフする。ドラムは無視される */
  noteOff(id: number, time = this.nowFrame()): void {
    if (!Number.isInteger(id) || !Number.isFinite(time)) {
      throw new RangeError(`noteOff: id は整数、time は有限の数値にしてください（id=${id}, time=${time}）`);
    }
    this.send({ type: 'noteOff', id, time });
  }

  setQuantize(enabled: boolean): void {
    this.send({ type: 'setQuantize', enabled });
  }

  /** オンの間、Worklet が音声 1 秒ごとに処理時間の集計を onLoad に送る */
  setLoadReport(enabled: boolean): void {
    this.send({ type: 'setLoadReport', enabled });
  }

  onWarning(handler: (message: string) => void): void {
    this.warningHandlers.push(handler);
  }

  onLoad(handler: (report: LoadReport) => void): void {
    this.loadHandlers.push(handler);
  }

  private nowFrame(): number {
    return Math.round(this.context.currentTime * this.context.sampleRate);
  }

  private send(message: EngineMessage): void {
    this.node.port.postMessage(message);
  }
}
