import { EventQueue } from './eventQueue';
import { LoadMeter, type ClockKind } from './loadMeter';
import { PROCESSOR_NAME, type EngineMessage, type EngineReply } from './messages';
import { clampSample, quantize16 } from './output';
import { MIX_GAIN } from './tables';
import { VoicePool } from './voicePool';
import { voiceWarnings } from './waveforms';

type TimedMessage = Extract<EngineMessage, { time: number }>;

// performance.now() が Worklet で使えるかはブラウザーによって違う
const clockKind: ClockKind = typeof performance !== 'undefined' && typeof performance.now === 'function' ? 'performance' : 'date';
const now = clockKind === 'performance' ? () => performance.now() : () => Date.now();

class FmProcessor extends AudioWorkletProcessor {
  private readonly pool = new VoicePool(sampleRate);
  private readonly queue = new EventQueue<TimedMessage>();
  private readonly meter = new LoadMeter(sampleRate, clockKind);
  private quantize = true;
  private loadReport = false;
  /** 未登録の警告を出した番号 */
  private readonly warnedPrograms = new Set<number>();
  private left = new Float32Array(128);
  private right = new Float32Array(128);

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<EngineMessage>) => this.receive(event.data);
  }

  private reply(message: EngineReply): void {
    this.port.postMessage(message);
  }

  private receive(message: EngineMessage): void {
    switch (message.type) {
      case 'registerVoice':
        this.pool.register(message.program, message.voice);
        this.warnedPrograms.delete(message.program);
        for (const warning of voiceWarnings(message.voice)) this.reply({ type: 'warning', message: warning });
        break;
      case 'setQuantize':
        this.quantize = message.enabled;
        break;
      case 'setLoadReport':
        // オンにし直したときに前の途中までの集計が混ざらないよう捨てる
        if (message.enabled && !this.loadReport) this.meter.reset();
        this.loadReport = message.enabled;
        break;
      case 'noteOn':
      case 'noteOff':
        this.queue.push(message);
        break;
    }
  }

  private apply(message: TimedMessage): void {
    if (message.type === 'noteOff') {
      this.pool.noteOff(message.id);
    } else if (!this.pool.noteOn(message.id, message.program, message.note, message.pan)) {
      // 繰り返し鳴らす曲で警告があふれないよう、番号ごとに 1 回だけ出す（登録し直すまで）
      if (!this.warnedPrograms.has(message.program)) {
        this.warnedPrograms.add(message.program);
        this.reply({ type: 'warning', message: `音色 ${message.program} は登録されていません` });
      }
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const started = this.loadReport ? now() : 0;
    const channels = outputs[0];
    if (!channels || channels.length === 0) return true;
    const length = channels[0]!.length;
    if (this.left.length !== length) {
      this.left = new Float32Array(length);
      this.right = new Float32Array(length);
    }
    const { left, right } = this;
    left.fill(0);
    right.fill(0);

    let pos = 0;
    for (const { offset, event } of this.queue.takeDue(currentFrame, length)) {
      if (offset > pos) {
        this.pool.render(left, right, pos, offset);
        pos = offset;
      }
      this.apply(event);
    }
    this.pool.render(left, right, pos, length);

    const finish = this.quantize ? quantize16 : clampSample;
    // ノードは outputChannelCount: [2] で作るので、0 が左、1 が右
    for (let c = 0; c < channels.length; c++) {
      const channel = channels[c]!;
      const source = c === 0 ? left : right;
      for (let i = 0; i < length; i++) channel[i] = finish(source[i]! * MIX_GAIN);
    }

    if (this.loadReport) {
      const report = this.meter.record(now() - started, length, this.pool.activeCount);
      if (report) this.reply({ type: 'load', report });
    }
    return true;
  }
}

registerProcessor(PROCESSOR_NAME, FmProcessor);
