import { validateDrum, validateVoice, type AnyVoice, type ValidationError } from '../../engine/src/index.ts';
import drumData from '../../../voices/custom/drums.json';
import gmVoices from '../../../voices/ymf825/gm.json';

export interface VoiceEntry {
  program: number;
  voice: AnyVoice;
}

function describe(errors: readonly ValidationError[]): string {
  return errors.map((e) => (e.path === '' ? e.message : `${e.path}: ${e.message}`)).join('、');
}

/** 音色の一覧を検査し、通らなければ番号と理由つきで例外を投げる。kind が 'drum' ならドラム、それ以外は FM 音色として検査する */
export function validateVoiceEntries(entries: ReadonlyArray<{ program: number; voice: unknown }>): VoiceEntry[] {
  if (!Array.isArray(entries)) throw new RangeError('voices は { program, voice } の配列にしてください');
  return entries.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new RangeError(`voices[${index}] は { program, voice } にしてください`);
    }
    const { program, voice } = entry;
    const isDrum = typeof voice === 'object' && voice !== null && (voice as { kind?: unknown }).kind === 'drum';
    const result = isDrum ? validateDrum(voice) : validateVoice(voice);
    if (!result.ok) {
      throw new RangeError(`音色の検査に通りません（program=${program}）：${describe(result.errors)}`);
    }
    return { program, voice: result.voice };
  });
}

/**
 * 同梱の音色集。GM の音色は id を番号に、ドラムは id（128〜135）を番号にする。
 * unassigned.json は id が null（MML の @N で呼べない）ので含めない
 */
export function bundledVoices(): VoiceEntry[] {
  const gm = (gmVoices as Array<{ id: number }>).map((voice) => ({ program: voice.id, voice }));
  const drums = (drumData as Array<{ id: number }>).map((voice) => ({ program: voice.id, voice }));
  return validateVoiceEntries([...gm, ...drums]);
}
