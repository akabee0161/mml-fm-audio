/** ドラムの番号（設計書 §5。spec §3.4 の表の順） */
export const DRUM_PROGRAMS = { bd: 128, sd: 129, ch: 130, oh: 131, cy: 132, lt: 133, ht: 134, cp: 135 } as const;

export type DrumName = keyof typeof DRUM_PROGRAMS;

/** tick は 1 小節を 16 分音符 16 個に分けた位置（0〜15） */
export interface RhythmStep {
  tick: number;
  drum: DrumName;
}

/** 試聴用の 1 小節。8 種すべてを使う */
export const RHYTHM_PATTERN: readonly RhythmStep[] = [
  { tick: 0, drum: 'bd' },
  { tick: 0, drum: 'cy' },
  { tick: 2, drum: 'ch' },
  { tick: 4, drum: 'sd' },
  { tick: 4, drum: 'ch' },
  { tick: 6, drum: 'oh' },
  { tick: 8, drum: 'bd' },
  { tick: 10, drum: 'bd' },
  { tick: 10, drum: 'ch' },
  { tick: 12, drum: 'sd' },
  { tick: 12, drum: 'cp' },
  { tick: 13, drum: 'ht' },
  { tick: 14, drum: 'ht' },
  { tick: 15, drum: 'lt' },
];

/** テンポ bpm で、小節頭のサンプル時刻 barStart から始まる 1 小節分の発音時刻 */
export function scheduleBar(barStart: number, sampleRate: number, bpm: number): Array<{ time: number; program: number }> {
  const sixteenth = (60 / bpm / 4) * sampleRate;
  return RHYTHM_PATTERN.map((step) => ({
    time: Math.round(barStart + step.tick * sixteenth),
    program: DRUM_PROGRAMS[step.drum],
  }));
}
