import type { LoadReport } from './loadMeter';
import type { AnyVoice } from './voiceData';

export const PROCESSOR_NAME = 'mml-fm-audio';

/** 音を割り当てるボイスの組。BGM はノードの出力 0、効果音は出力 1 に出る */
export type VoiceGroup = 'bgm' | 'se';

/** メインスレッド → Worklet。time は AudioContext のサンプル番号 */
export type EngineMessage =
  | { type: 'registerVoice'; program: number; voice: AnyVoice }
  | { type: 'noteOn'; id: number; program: number; note: number; pan: number; volume: number; bend: number; group: VoiceGroup; time: number }
  | { type: 'noteOff'; id: number; time: number }
  | { type: 'setPitchBend'; id: number; cents: number; time: number }
  | { type: 'setVolume'; id: number; volume: number; time: number }
  /** 時刻を持たず、受け取ったらすぐ処理する */
  | { type: 'cancel'; ids: number[] }
  | { type: 'setQuantize'; enabled: boolean }
  | { type: 'setLoadReport'; enabled: boolean };

/** Worklet → メインスレッド */
export type EngineReply = { type: 'warning'; message: string } | { type: 'load'; report: LoadReport };
