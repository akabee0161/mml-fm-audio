import { EventQueue } from './eventQueue';
import { Lfo } from './lfo';
import { PROCESSOR_NAME, type EngineMessage, type EngineReply } from './messages';
import { clampSample, quantize16 } from './output';
import { Voice } from './voice';
import { voiceWarnings } from './waveforms';

type TimedMessage = Extract<EngineMessage, { time: number }>;

class FmProcessor extends AudioWorkletProcessor {
  private readonly voice = new Voice(sampleRate);
  private readonly lfo = new Lfo(sampleRate);
  private readonly queue = new EventQueue<TimedMessage>();
  private quantize = true;
  private mono = new Float32Array(128);

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<EngineMessage>) => this.receive(event.data);
  }

  private receive(message: EngineMessage): void {
    switch (message.type) {
      case 'setVoice':
        this.voice.setVoice(message.voice);
        this.lfo.setRate(message.voice.lfo);
        for (const warning of voiceWarnings(message.voice)) {
          this.port.postMessage({ type: 'warning', message: warning } satisfies EngineReply);
        }
        break;
      case 'setQuantize':
        this.quantize = message.enabled;
        break;
      case 'noteOn':
      case 'noteOff':
        this.queue.push(message);
        break;
    }
  }

  private apply(message: TimedMessage): void {
    if (message.type === 'noteOn') this.voice.noteOn(message.note);
    else this.voice.noteOff();
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const channels = outputs[0];
    if (!channels || channels.length === 0) return true;
    const length = channels[0]!.length;
    if (this.mono.length !== length) this.mono = new Float32Array(length);

    let pos = 0;
    for (const { offset, event } of this.queue.takeDue(currentFrame, length)) {
      if (offset > pos) {
        this.voice.render(this.mono, pos, offset, this.lfo);
        pos = offset;
      }
      this.apply(event);
    }
    this.voice.render(this.mono, pos, length, this.lfo);

    const finish = this.quantize ? quantize16 : clampSample;
    for (let i = 0; i < length; i++) {
      const value = finish(this.mono[i]!);
      for (const channel of channels) channel[i] = value;
    }
    return true;
  }
}

registerProcessor(PROCESSOR_NAME, FmProcessor);
