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
const MAX_BEND = 1200;

function isFiniteIn(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}

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
    const [min, max] = voice.kind === 'fm' ? [0, 127] : [128, 255];
    if (!isIntIn(program, min, max)) {
      throw new RangeError(
        `registerVoice: ${voice.kind === 'fm' ? 'FM 音色' : 'ドラム'}の program は ${min}〜${max} の整数にしてください（program=${program}）`,
      );
    }
    this.send({ type: 'registerVoice', program, voice });
  }

  /**
   * program の音色で note を鳴らし、音の ID を返す。pan は 0〜127（既定 64 が中央）。
   * volume は 0〜1（既定 1）、bend は −1200〜1200 セント（既定 0）。time はサンプル番号で、小数は丸める
   */
  noteOn(
    program: number,
    note: number,
    options: { pan?: number; time?: number; volume?: number; bend?: number } = {},
  ): number {
    const { pan = CENTER_PAN, time = this.nowFrame(), volume = 1, bend = 0 } = options;
    if (
      !isIntIn(program, 0, 255) ||
      !isIntIn(note, 0, 127) ||
      !isIntIn(pan, 0, 127) ||
      !Number.isFinite(time) ||
      !isFiniteIn(volume, 0, 1) ||
      !isFiniteIn(bend, -MAX_BEND, MAX_BEND)
    ) {
      throw new RangeError(
        `noteOn: program は 0〜255、note と pan は 0〜127 の整数、time は有限の数値、volume は 0〜1、bend は −${MAX_BEND}〜${MAX_BEND} にしてください（program=${program}, note=${note}, pan=${pan}, time=${time}, volume=${volume}, bend=${bend}）`,
      );
    }
    const id = this.nextId++;
    this.send({ type: 'noteOn', id, program, note, pan, volume, bend, time: Math.round(time) });
    return id;
  }

  /** 鳴っている音のピッチベンドをセント単位（−1200〜1200）で変える。ドラムは無視される */
  setPitchBend(id: number, cents: number, time = this.nowFrame()): void {
    if (!Number.isInteger(id) || !isFiniteIn(cents, -MAX_BEND, MAX_BEND) || !Number.isFinite(time)) {
      throw new RangeError(
        `setPitchBend: id は整数、cents は −${MAX_BEND}〜${MAX_BEND}、time は有限の数値にしてください（id=${id}, cents=${cents}, time=${time}）`,
      );
    }
    this.send({ type: 'setPitchBend', id, cents, time: Math.round(time) });
  }

  /** 鳴っている音の音量を 0〜1 で変える */
  setVolume(id: number, volume: number, time = this.nowFrame()): void {
    if (!Number.isInteger(id) || !isFiniteIn(volume, 0, 1) || !Number.isFinite(time)) {
      throw new RangeError(
        `setVolume: id は整数、volume は 0〜1、time は有限の数値にしてください（id=${id}, volume=${volume}, time=${time}）`,
      );
    }
    this.send({ type: 'setVolume', id, volume, time: Math.round(time) });
  }

  /** ids の、まだ処理していないイベントを捨て、鳴っていればキーオフする */
  cancel(ids: readonly number[]): void {
    if (!ids.every((id) => Number.isInteger(id))) {
      throw new RangeError(`cancel: ids は整数の配列にしてください（ids=${JSON.stringify(ids)}）`);
    }
    this.send({ type: 'cancel', ids: [...ids] });
  }

  /** noteOn が返した ID の音をキーオフする。ドラムは無視される */
  noteOff(id: number, time = this.nowFrame()): void {
    if (!Number.isInteger(id) || !Number.isFinite(time)) {
      throw new RangeError(`noteOff: id は整数、time は有限の数値にしてください（id=${id}, time=${time}）`);
    }
    this.send({ type: 'noteOff', id, time: Math.round(time) });
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
