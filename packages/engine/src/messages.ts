import type { FmVoice } from './voiceData';

export const PROCESSOR_NAME = 'mml-fm-audio';

/** メインスレッド → Worklet。time は AudioContext のサンプル番号 */
export type EngineMessage =
  | { type: 'setVoice'; voice: FmVoice }
  | { type: 'noteOn'; note: number; time: number }
  | { type: 'noteOff'; time: number }
  | { type: 'setQuantize'; enabled: boolean };

/** Worklet → メインスレッド */
export type EngineReply = { type: 'warning'; message: string };
