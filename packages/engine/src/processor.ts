import { EventQueue } from './eventQueue';
import { LoadMeter, type ClockKind } from './loadMeter';
import { PROCESSOR_NAME, type EngineMessage, type EngineReply, type VoiceGroup } from './messages';
import { clampSample, quantize16 } from './output';
import { MIX_GAIN } from './tables';
import { VoiceGroups } from './voiceGroups';
import { voiceWarnings } from './waveforms';

/** 出力の番号順。出力 0 が BGM、出力 1 が効果音 */
const GROUPS: readonly VoiceGroup[] = ['bgm', 'se'];

type TimedMessage = Extract<EngineMessage, { time: number }>;

// performance.now() が Worklet で使えるかはブラウザーによって違う
const clockKind: ClockKind = typeof performance !== 'undefined' && typeof performance.now === 'function' ? 'performance' : 'date';
const now = clockKind === 'performance' ? () => performance.now() : () => Date.now();

class FmProcessor extends AudioWorkletProcessor {
  private readonly pool = new VoiceGroups(sampleRate);
  private readonly queue = new EventQueue<TimedMessage>();
  private readonly meter = new LoadMeter(sampleRate, clockKind);
  private quantize = true;
  private loadReport = false;
  /** 未登録の警告を出した番号 */
  private readonly warnedPrograms = new Set<number>();
  /** 出力ごとの左右のバッファ（0 が BGM、1 が効果音） */
  private readonly buffers = GROUPS.map(() => ({ left: new Float32Array(128), right: new Float32Array(128) }));

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
      case 'cancel': {
        const ids = new Set(message.ids);
        this.queue.removeWhere((event) => ids.has(event.id));
        this.pool.cancel(message.ids);
        break;
      }
      case 'silence':
        this.pool.silence(message.group);
        break;
      case 'noteOn':
      case 'noteOff':
      case 'setPitchBend':
      case 'setVolume':
        this.queue.push(message);
        break;
    }
  }

  private apply(message: TimedMessage): void {
    switch (message.type) {
      case 'noteOff':
        this.pool.noteOff(message.id);
        break;
      case 'setPitchBend':
        this.pool.setPitchBend(message.id, message.cents);
        break;
      case 'setVolume':
        this.pool.setVolume(message.id, message.volume);
        break;
      case 'noteOn':
        if (!this.pool.noteOn(message.group, message.id, message.program, message.note, message.pan, message.volume, message.bend)) {
          // 繰り返し鳴らす曲で警告があふれないよう、番号ごとに 1 回だけ出す（登録し直すまで）
          if (!this.warnedPrograms.has(message.program)) {
            this.warnedPrograms.add(message.program);
            this.reply({ type: 'warning', message: `音色 ${message.program} は登録されていません` });
          }
        }
        break;
    }
  }

  /** 区間 [from, to) を出力ごとのバッファへ足し込む */
  private renderRange(from: number, to: number): void {
    for (let o = 0; o < GROUPS.length; o++) {
      const { left, right } = this.buffers[o]!;
      this.pool.render(GROUPS[o]!, left, right, from, to);
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const started = this.loadReport ? now() : 0;
    const first = outputs[0];
    if (!first || first.length === 0) return true;
    const length = first[0]!.length;
    for (const buffer of this.buffers) {
      if (buffer.left.length !== length) {
        buffer.left = new Float32Array(length);
        buffer.right = new Float32Array(length);
      }
      buffer.left.fill(0);
      buffer.right.fill(0);
    }

    let pos = 0;
    const due = this.queue.takeDue(currentFrame, length);
    for (let k = 0; k < due.length; k++) {
      const { offset, event } = due[k]!;
      if (offset > pos) {
        this.renderRange(pos, offset);
        pos = offset;
      }
      this.apply(event);
    }
    this.renderRange(pos, length);

    const finish = this.quantize ? quantize16 : clampSample;
    // ノードは outputChannelCount: [2, 2] で作るので、各出力の 0 が左、1 が右
    for (let o = 0; o < GROUPS.length; o++) {
      const channels = outputs[o];
      if (!channels) continue;
      const { left, right } = this.buffers[o]!;
      for (let c = 0; c < channels.length; c++) {
        const channel = channels[c]!;
        const source = c === 0 ? left : right;
        for (let i = 0; i < length; i++) channel[i] = finish(source[i]! * MIX_GAIN);
      }
    }

    if (this.loadReport) {
      const report = this.meter.record(now() - started, length, this.pool.activeCount);
      if (report) this.reply({ type: 'load', report });
    }
    return true;
  }
}

registerProcessor(PROCESSOR_NAME, FmProcessor);
