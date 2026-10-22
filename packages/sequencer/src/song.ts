/** 四分音符あたりのティック数 */
export const TICKS_PER_QUARTER = 96;

/** ドラム名と音色番号（M2 設計書 §5） */
export const DRUM_PROGRAMS = { bd: 128, sd: 129, ch: 130, oh: 131, cy: 132, lt: 133, ht: 134, cp: 135 } as const;

/** 行・列はどちらも 1 から。列は文字単位 */
export interface MmlError { line: number; column: number; message: string }

export type TrackEvent =
  /** gate はノートオンからノートオフまでのティック。volume は v の値（0〜15） */
  | { type: 'note'; tick: number; gate: number; program: number; note: number; volume: number; pan: number; bend: number }
  | { type: 'bend'; tick: number; cents: number }
  | { type: 'volume'; tick: number; volume: number };

/** events は tick の順、length はティック */
export interface Track { name: string; events: TrackEvent[]; length: number }

export interface Tempo { tick: number; bpm: number }

export interface Song {
  /** MML に初めて出た順 */
  tracks: Track[];
  /** tick の順。先頭は必ず tick 0 */
  tempos: Tempo[];
  /** いちばん長いトラックの長さ */
  length: number;
  loopStart: number | null;
  /** E の位置。E がなければ length */
  loopEnd: number;
  /** 行・列の順 */
  errors: MmlError[];
}
