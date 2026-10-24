import { describe, expect, it } from 'vitest';
import { FmAudio } from './fmAudio.ts';
import { bundledVoices, validateVoiceEntries } from './voices.ts';

describe('bundledVoices', () => {
  it('GM 16 種とドラム 8 種を番号つきで返し、すべて検査を通る', () => {
    const entries = bundledVoices();
    const programs = entries.map((e) => e.program);
    expect(programs.filter((p) => p < 128)).toHaveLength(16);
    expect(programs.filter((p) => p >= 128)).toEqual([128, 129, 130, 131, 132, 133, 134, 135]);
    expect(new Set(programs).size).toBe(24);
    expect(entries.filter((e) => e.program < 128).every((e) => e.voice.kind === 'fm')).toBe(true);
    expect(entries.filter((e) => e.program >= 128).every((e) => e.voice.kind === 'drum')).toBe(true);
    expect(() => validateVoiceEntries(entries)).not.toThrow();
  });

  it('init に検査を通らない音色を渡すと、番号と理由つきで例外', async () => {
    const bad = { ...bundledVoices()[0]!.voice, alg: 99 };
    await expect(FmAudio.init({ voices: [{ program: 5, voice: bad }] })).rejects.toThrow(/program=5.*alg/);
  });
});
