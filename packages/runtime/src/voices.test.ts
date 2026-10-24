import { afterEach, describe, expect, it, vi } from 'vitest';
import { FmEngine } from '../../engine/src/index.ts';
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

  it('program の範囲（FM は 0〜127、ドラムは 128〜255 の整数）を検査し、番号つきで例外', () => {
    const entries = bundledVoices();
    const fm = entries.find((e) => e.program < 128)!.voice;
    const drum = entries.find((e) => e.program >= 128)!.voice;
    for (const [program, voice] of [[128, fm], [-1, fm], [1.5, fm], [Number.NaN, fm], [127, drum], [256, drum]] as const) {
      expect(() => validateVoiceEntries([{ program, voice }])).toThrow(RangeError);
      expect(() => validateVoiceEntries([{ program, voice }])).toThrow(new RegExp(`program=${program}`));
    }
    expect(() => validateVoiceEntries([{ program: 127, voice: fm }, { program: 255, voice: drum }])).not.toThrow();
  });

  describe('init の失敗', () => {
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });

    it('自分で作った AudioContext は、FmEngine.create が失敗したら閉じてから投げ直す', async () => {
      const close = vi.fn(async () => {});
      vi.stubGlobal('AudioContext', class { close = close; });
      vi.spyOn(FmEngine, 'create').mockRejectedValue(new Error('addModule 失敗'));
      await expect(FmAudio.init({ voices: [] })).rejects.toThrow('addModule 失敗');
      expect(close).toHaveBeenCalledTimes(1);
    });

    it('registerVoice が失敗しても、自分で作った AudioContext は閉じる。渡された context は閉じない', async () => {
      const engine = { registerVoice: vi.fn(() => { throw new RangeError('registerVoice 失敗'); }) };
      vi.spyOn(FmEngine, 'create').mockResolvedValue(engine as never);
      const own = vi.fn(async () => {});
      vi.stubGlobal('AudioContext', class { close = own; });
      const entry = bundledVoices()[0]!;
      await expect(FmAudio.init({ voices: [entry] })).rejects.toThrow('registerVoice 失敗');
      expect(own).toHaveBeenCalledTimes(1);

      const given = { close: vi.fn(async () => {}) };
      await expect(FmAudio.init({ context: given as never, voices: [entry] })).rejects.toThrow('registerVoice 失敗');
      expect(given.close).not.toHaveBeenCalled();
    });

    it('検査に通らない音色なら、AudioContext を作る前に例外', async () => {
      const made = vi.fn();
      vi.stubGlobal('AudioContext', class { constructor() { made(); } });
      const bad = { ...bundledVoices()[0]!.voice, alg: 99 };
      await expect(FmAudio.init({ voices: [{ program: 5, voice: bad }] })).rejects.toThrow(/program=5/);
      expect(made).not.toHaveBeenCalled();
    });
  });
});
