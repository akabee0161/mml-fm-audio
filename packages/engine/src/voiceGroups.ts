import type { VoiceGroup } from './messages';
import type { AnyVoice } from './voiceData';
import { MAX_VOICES, SE_VOICES, VoicePool } from './voicePool';

/** BGM 用と効果音用の 2 つの割り当て。効果音が増えても BGM のボイスは奪われない */
export class VoiceGroups {
  private readonly pools: Record<VoiceGroup, VoicePool>;

  constructor(sampleRate: number, bgmSize = MAX_VOICES, seSize = SE_VOICES) {
    this.pools = { bgm: new VoicePool(sampleRate, bgmSize), se: new VoicePool(sampleRate, seSize) };
  }

  /** 音色を両方の割り当てへ登録する */
  register(program: number, timbre: AnyVoice): void {
    this.pools.bgm.register(program, timbre);
    this.pools.se.register(program, timbre);
  }

  /** 鳴らせたら true。未登録の program は鳴らさず false */
  noteOn(group: VoiceGroup, id: number, program: number, note: number, pan: number, volume = 1, bend = 0): boolean {
    return this.pools[group].noteOn(id, program, note, pan, volume, bend);
  }

  // ID は FmEngine が通しで振るので 2 つの割り当てで重ならない。持っていない側は何もしない

  noteOff(id: number): void {
    this.pools.bgm.noteOff(id);
    this.pools.se.noteOff(id);
  }

  setPitchBend(id: number, cents: number): void {
    this.pools.bgm.setPitchBend(id, cents);
    this.pools.se.setPitchBend(id, cents);
  }

  setVolume(id: number, volume: number): void {
    this.pools.bgm.setVolume(id, volume);
    this.pools.se.setVolume(id, volume);
  }

  cancel(ids: readonly number[]): void {
    this.pools.bgm.cancel(ids);
    this.pools.se.cancel(ids);
  }

  /** group の音だけを left/right の [from, to) に足し込む */
  render(group: VoiceGroup, left: Float32Array, right: Float32Array, from: number, to: number): void {
    this.pools[group].render(left, right, from, to);
  }

  /** 両方の割り当ての、鳴っているボイスの合計 */
  get activeCount(): number {
    return this.pools.bgm.activeCount + this.pools.se.activeCount;
  }
}
