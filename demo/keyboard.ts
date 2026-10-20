import { validateVoice, type ValidationResult } from '@mml-fm-audio/engine';

/** PC キーボードのキー → 基準の C からの半音数 */
export const PC_KEY_OFFSETS: Readonly<Record<string, number>> = {
  a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12,
};

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const BLACK = new Set([1, 3, 6, 8, 10]);
const MIN_BASE = 24; // C1
const MAX_BASE = 96; // C7

export interface KeyInfo {
  note: number;
  black: boolean;
  label: string;
}

export function noteName(note: number): string {
  return `${NAMES[note % 12]}${Math.floor(note / 12) - 1}`;
}

export function isBlack(note: number): boolean {
  return BLACK.has(note % 12);
}

/** 画面の鍵盤ボタンにフォーカスした状態で押すと有効化される keydown/keyup のキー */
export function isActivationKey(key: string): boolean {
  return key === 'Enter' || key === ' ';
}

/**
 * 支援技術（スクリーンリーダー等）がポインター／キーボードのイベントを経由せず
 * 直接発火する click は detail が 0。マウス・タッチの click は 1 以上になる。
 */
export function isAssistiveClick(detail: number): boolean {
  return detail === 0;
}

/** 支援技術による click を検知してから、押している体にする長さ（ms） */
export const ASSISTIVE_CLICK_HOLD_MS = 300;

/** baseNote から octaves オクターブ分（終わりの C を含む） */
export function keyLayout(baseNote: number, octaves: number): KeyInfo[] {
  const keys: KeyInfo[] = [];
  for (let note = baseNote; note <= baseNote + octaves * 12; note++) {
    keys.push({ note, black: isBlack(note), label: noteName(note) });
  }
  return keys;
}

export function shiftBase(base: number, delta: number): number {
  return Math.min(MAX_BASE, Math.max(MIN_BASE, base + delta * 12));
}

/** 貼り付けられた文字列を音色として読む。構文エラーも例外にせず返す */
export function parseVoiceJson(text: string): ValidationResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [{ path: '(JSON)', message: e instanceof Error ? e.message : String(e) }] };
  }
  return validateVoice(data);
}

/**
 * 押しているキー（PC のキーや画面のポインター）ごとに、鳴らした音の ID を覚える。
 * 離したキーの音だけをキーオフできるようにして、和音を弾けるようにする。
 */
export class PolyNoteTracker {
  private readonly held = new Map<string, number | null>();

  /** key を押し始めた。すでに押されていれば false（鳴らさない） */
  press(key: string): boolean {
    if (this.held.has(key)) return false;
    this.held.set(key, null);
    return true;
  }

  /** press が true だった key に、鳴らした音の ID を結び付ける */
  bind(key: string, id: number): void {
    if (this.held.has(key)) this.held.set(key, id);
  }

  /** 離した key の ID。なければ undefined */
  release(key: string): number | undefined {
    const id = this.held.get(key);
    this.held.delete(key);
    return id ?? undefined;
  }

  /** prefix で始まる key をすべて離し、その ID を返す */
  releaseMatching(prefix: string): number[] {
    const ids: number[] = [];
    for (const [key, id] of this.held) {
      if (!key.startsWith(prefix)) continue;
      this.held.delete(key);
      if (id !== null) ids.push(id);
    }
    return ids;
  }

  /** 押されている全 key を離し、その ID を返す */
  releaseAll(): number[] {
    const ids = [...this.held.values()].filter((id): id is number => id !== null);
    this.held.clear();
    return ids;
  }
}
