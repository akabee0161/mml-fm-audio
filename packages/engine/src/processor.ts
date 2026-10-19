import { EventQueue } from './eventQueue';
import { Lfo } from './lfo';
import { PROCESSOR_NAME, type EngineMessage, type EngineReply } from './messages';
import { clampSample, quantize16 } from './output';
import { Voice } from './voice';
import type { FmVoice } from './voiceData';
import { voiceWarnings } from './waveforms';

type TimedMessage = Extract<EngineMessage, { time: number }>;

class FmProcessor extends AudioWorkletProcessor {
  private readonly voice = new Voice(sampleRate);
  private readonly lfo = new Lfo(sampleRate);
  private readonly queue = new EventQueue<TimedMessage>();
  private timbre: FmVoice | null = null;
  private quantize = true;
  private left = new Float32Array(128);
  private right = new Float32Array(128);
  private lfoValues = new Float32Array(128);

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<EngineMessage>) => this.receive(event.data);
  }

  private receive(message: EngineMessage): void {
    switch (message.type) {
      case 'setVoice':
        this.timbre = message.voice;
        this.voice.stop();
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
    if (message.type === 'noteOn') {
      if (this.timbre) this.voice.noteOn(this.timbre, message.note, 64);
    } else {
      this.voice.noteOff();
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const channels = outputs[0];
    if (!channels || channels.length === 0) return true;
    const length = channels[0]!.length;
    if (this.left.length !== length) {
      this.left = new Float32Array(length);
      this.right = new Float32Array(length);
      this.lfoValues = new Float32Array(length);
    }
    this.left.fill(0);
    this.right.fill(0);
    for (let i = 0; i < length; i++) this.lfoValues[i] = this.lfo.next();

    let pos = 0;
    for (const { offset, event } of this.queue.takeDue(currentFrame, length)) {
      if (offset > pos) {
        this.voice.render(this.left, this.right, pos, offset, this.lfoValues);
        pos = offset;
      }
      this.apply(event);
    }
    this.voice.render(this.left, this.right, pos, length, this.lfoValues);

    const finish = this.quantize ? quantize16 : clampSample;
    const stereo = [this.left, this.right];
    channels.forEach((channel, c) => {
      const source = stereo[Math.min(c, 1)]!;
      for (let i = 0; i < length; i++) channel[i] = finish(source[i]!);
    });
    return true;
  }
}

registerProcessor(PROCESSOR_NAME, FmProcessor);
