import type { LoadReport } from './loadMeter';
import type { AnyVoice } from './voiceData';

export const PROCESSOR_NAME = 'mml-fm-audio';

/** メインスレッド → Worklet。time は AudioContext のサンプル番号 */
export type EngineMessage =
  | { type: 'registerVoice'; program: number; voice: AnyVoice }
  | { type: 'noteOn'; id: number; program: number; note: number; pan: number; time: number }
  | { type: 'noteOff'; id: number; time: number }
  | { type: 'setQuantize'; enabled: boolean }
  | { type: 'setLoadReport'; enabled: boolean };

/** Worklet → メインスレッド */
export type EngineReply = { type: 'warning'; message: string } | { type: 'load'; report: LoadReport };
