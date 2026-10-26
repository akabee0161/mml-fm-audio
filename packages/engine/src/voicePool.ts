import { Lfo } from './lfo';
import { Voice } from './voice';
import type { AnyVoice } from './voiceData';

/** 同時発音数（spec §2.1。暫定で、負荷の実測を見て見直す） */
export const MAX_VOICES = 16;

/** 効果音用の同時発音数（BGM とは別に数える。暫定で、負荷の実測を見て見直す） */
export const SE_VOICES = 4;

/** 複数のボイスへの音の割り当てと、音源全体で 1 つの LFO */
export class VoicePool {
  private readonly voices: Voice[];
  /** ボイスごとの、鳴らしている音の ID（なければ null） */
  private readonly ids: (number | null)[];
  /** ボイスごとの、noteOn した順番（大きいほど新しい） */
  private readonly startedAt: number[];
  /** ボイスごとの、noteOff を受けた順番（0 はキーオン中） */
  private readonly releasedAt: number[];
  private readonly programs = new Map<number, AnyVoice>();
  private readonly lfo: Lfo;
  private lfoValues = new Float32Array(128);
  private counter = 0;

  constructor(sampleRate: number, size = MAX_VOICES) {
    this.voices = Array.from({ length: size }, () => new Voice(sampleRate));
    this.ids = this.voices.map(() => null);
    this.startedAt = this.voices.map(() => 0);
    this.releasedAt = this.voices.map(() => 0);
    this.lfo = new Lfo(sampleRate);
  }

  /** 音色を番号に登録する。鳴っている音は前の音色のまま鳴り終える */
  register(program: number, timbre: AnyVoice): void {
    this.programs.set(program, timbre);
  }

  /** 鳴らせたら true。未登録の program は鳴らさず false */
  noteOn(id: number, program: number, note: number, pan: number, volume = 1, bend = 0): boolean {
    const timbre = this.programs.get(program);
    if (!timbre) return false;
    const index = this.allocate();
    if (timbre.kind === 'fm') this.lfo.setRate(timbre.lfo);
    this.voices[index]!.noteOn(timbre, note, pan, volume, bend);
    this.ids[index] = id;
    this.startedAt[index] = ++this.counter;
    this.releasedAt[index] = 0;
    return true;
  }

  /** id の音のピッチベンド（セント）を変える。奪われた・鳴り終えた音なら何もしない */
  setPitchBend(id: number, cents: number): void {
    const index = this.ids.indexOf(id);
    if (index >= 0) this.voices[index]!.setPitchBend(cents);
  }

  /** id の音の音量（倍率）を変える。奪われた・鳴り終えた音なら何もしない */
  setVolume(id: number, volume: number): void {
    const index = this.ids.indexOf(id);
    if (index >= 0) this.voices[index]!.setVolume(volume);
  }

  /** ids の音をキーオフする（停止用）。該当なしは無視 */
  cancel(ids: readonly number[]): void {
    for (const id of ids) this.noteOff(id);
  }

  /** id の音をキーオフする。すでに奪われた・鳴り終えた音なら何もしない */
  noteOff(id: number): void {
    const index = this.ids.indexOf(id);
    if (index < 0) return;
    this.voices[index]!.noteOff();
    // ドラムは noteOff でも鳴り続けるが、奪う順番では同じくリリース中として扱う
    if (this.releasedAt[index] === 0) this.releasedAt[index] = ++this.counter;
  }

  /** すべてのボイスをすぐ無音にする（キーオフのリリースを待たない） */
  silence(): void {
    for (let i = 0; i < this.voices.length; i++) {
      this.voices[i]!.stop();
      this.ids[i] = null;
    }
  }

  /** left/right の [from, to) に足し込む */
  render(left: Float32Array, right: Float32Array, from: number, to: number): void {
    if (this.lfoValues.length < to) this.lfoValues = new Float32Array(to);
    for (let s = from; s < to; s++) this.lfoValues[s] = this.lfo.next();
    for (const voice of this.voices) voice.render(left, right, from, to, this.lfoValues);
  }

  get activeCount(): number {
    let count = 0;
    for (const voice of this.voices) if (voice.active) count++;
    return count;
  }

  /**
   * 空いているボイス。なければ、リリース中のうち最も古く noteOff を受けたボイス、
   * それもなければ最も古く鳴らしたボイスを止めて返す
   */
  private allocate(): number {
    let oldest = 0;
    let released = -1;
    for (let i = 0; i < this.voices.length; i++) {
      if (!this.voices[i]!.active) return i;
      if (this.startedAt[i]! < this.startedAt[oldest]!) oldest = i;
      const at = this.releasedAt[i]!;
      if (at > 0 && (released < 0 || at < this.releasedAt[released]!)) released = i;
    }
    const index = released >= 0 ? released : oldest;
    this.voices[index]!.stop();
    return index;
  }
}
