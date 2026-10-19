// YMF825_sample の tonedata.txt（sysexspec.md の p0〜p40）を音色 JSON に変換する。
// Node で直接実行するため、import は拡張子つきで書く。
import { validateVoice, type FmOperator, type FmVoice } from '../packages/engine/src/voiceData.ts';

export interface ToneEntry {
  name: string;
  author: string;
  bytes: number[];
}

const TONE_BYTES = 41;

/** GM の楽器番号の割り当て。ここにない音色は id: null */
export const GM_ASSIGNMENTS: Readonly<Record<string, number>> = {
  GrandPiano: 0,
  BrightPiano: 1,
  'E.Piano': 4,
  Harpsichord: 6,
  Vibes: 11,
  RockOrgan: 18,
  ChurchOrgan: 19,
  Harmonica: 22,
  NylonGuiter: 24,
  PickBass: 34,
  TenorSax: 66,
  Flute: 73,
  SquareLead: 80,
  SawLead: 81,
  NewAgePd: 88,
  TnklBell: 112,
};

export function parseToneData(text: string): ToneEntry[] {
  const lines = text
    .split(/\r?\n/)
    .map((content, i) => ({ content: content.trim(), line: i + 1 }))
    .filter((l) => l.content !== '');
  const entries: ToneEntry[] = [];
  for (let i = 0; i < lines.length; i += 3) {
    const [nameLine, authorLine, dataLine] = [lines[i]!, lines[i + 1], lines[i + 2]];
    if (!nameLine.content.startsWith('Name:') || !authorLine?.content.startsWith('Author:') || !dataLine) {
      throw new Error(`${nameLine.line} 行目：Name・Author・データの 3 行の並びになっていません`);
    }
    const bytes = dataLine.content.split(',').map((s) => (/^[0-9a-f]{2}$/i.test(s.trim()) ? Number.parseInt(s.trim(), 16) : NaN));
    if (bytes.length !== TONE_BYTES || bytes.some((b) => Number.isNaN(b) || b > 0x7f)) {
      throw new Error(`${dataLine.line} 行目：00〜7f の 16 進数が ${TONE_BYTES} 個必要です`);
    }
    entries.push({
      name: nameLine.content.slice('Name:'.length).trim(),
      author: authorLine.content.slice('Author:'.length).trim(),
      bytes,
    });
  }
  return entries;
}

function decodeOperator(p: number[], index: number): FmOperator {
  const b = 1 + index * 10;
  const key = p[b]!;
  const modulation = p[b + 7]!;
  const pitch = p[b + 8]!;
  return {
    wave: p[b + 9]! & 31,
    mul: pitch & 15,
    dt: (pitch >> 4) & 7,
    tl: p[b + 6]! & 63,
    ar: p[b + 1]! & 15,
    dr: p[b + 2]! & 15,
    sl: p[b + 5]! & 15,
    sr: p[b + 3]! & 15,
    rr: p[b + 4]! & 15,
    ksl: key & 3,
    ksr: (key >> 2) & 1,
    fb: (key >> 4) & 7,
    am: (modulation >> 4) & 1,
    amDepth: (modulation >> 5) & 3,
    vib: modulation & 1,
    vibDepth: (modulation >> 1) & 3,
    xof: (key >> 3) & 1,
  };
}

export function toVoice(entry: ToneEntry, id: number | null): FmVoice {
  const p0 = entry.bytes[0]!;
  return {
    id,
    name: entry.name,
    kind: 'fm',
    bo: (p0 >> 5) & 3,
    alg: p0 & 7,
    lfo: (p0 >> 3) & 3,
    ops: [0, 1, 2, 3].map((k) => decodeOperator(entry.bytes, k)),
  };
}

function validated(voice: FmVoice): FmVoice {
  const result = validateVoice(voice);
  if (!result.ok) {
    throw new Error(`${voice.name}: ${result.errors.map((e) => `${e.path} ${e.message}`).join('、')}`);
  }
  return result.voice;
}

export function convertAll(text: string): { gm: FmVoice[]; unassigned: FmVoice[] } {
  const voices = parseToneData(text).map((entry) => validated(toVoice(entry, GM_ASSIGNMENTS[entry.name] ?? null)));
  return {
    gm: voices.filter((v) => v.id !== null).sort((a, b) => a.id! - b.id!),
    unassigned: voices.filter((v) => v.id === null),
  };
}
