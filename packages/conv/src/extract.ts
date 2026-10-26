import { TICKS_PER_QUARTER } from '../../sequencer/src/index.ts';
import type { Smf } from './smf.ts';

/** tick は MML の分解能（四分音符 = 96）に換えた値。量子化の前なので小数でよい */
export interface RawNote { channel: number; note: number; velocity: number; on: number; off: number }
export type ControlKind = 'volume' | 'expression' | 'pan' | 'program' | 'bend';
/** bend の value はセント（RPN 0 のベンド幅を反映、丸める前）。それ以外は 0〜127 */
export interface ChannelControl { tick: number; channel: number; kind: ControlKind; value: number }
export interface ConvWarning { tick: number; message: string } // 位置は Task 5 の Meter で「小節・拍」にする
export interface Extracted {
  notes: RawNote[]; // on の順
  controls: ChannelControl[]; // tick の順
  tempos: { tick: number; bpm: number }[];
  markers: { tick: number; text: string }[];
  timeSignatures: { tick: number; numerator: number; denominator: number }[];
  discarded: Map<string, number>; // --report の「種類 → 件数」
  warnings: ConvWarning[];
}

const CC_KINDS: Record<number, ControlKind> = { 7: 'volume', 11: 'expression', 10: 'pan' };
const CC_RPN_MSB = 101;
const CC_RPN_LSB = 100;
const CC_DATA_MSB = 6;
const CC_DATA_LSB = 38;
const DEFAULT_BEND_RANGE_CENTS = 200;
const DRUM_CHANNEL = 9;

interface ChannelState {
  rpnMsb: number;
  rpnLsb: number;
  bendSemitones: number;
  bendCents: number;
}

interface OpenNote { velocity: number; on: number }

/** SMF から、チャンネルごとのノートと変化（ボリューム・エクスプレッション・パン・音色・ベンド）を取り出す。 */
export function extract(smf: Smf): Extracted {
  const scale = TICKS_PER_QUARTER / smf.ticksPerQuarter;
  const out: Extracted = {
    notes: [], controls: [], tempos: [], markers: [], timeSignatures: [], discarded: new Map(), warnings: [],
  };
  const discard = (label: string) => out.discarded.set(label, (out.discarded.get(label) ?? 0) + 1);

  const states: ChannelState[] = [];
  const stateOf = (ch: number): ChannelState =>
    (states[ch] ??= { rpnMsb: 127, rpnLsb: 127, bendSemitones: 2, bendCents: 0 });
  const open = new Map<number, OpenNote>(); // channel * 128 + note
  const lastTick = smf.events.length > 0 ? smf.events[smf.events.length - 1].tick : 0;

  const finish = (ch: number, note: number, o: OpenNote, endTick: number) => {
    const off = endTick * scale;
    if (off > o.on) out.notes.push({ channel: ch, note, velocity: o.velocity, on: o.on, off });
  };

  for (const e of smf.events) {
    const tick = e.tick * scale;
    switch (e.kind) {
      case 'noteOn': {
        const key = e.channel * 128 + e.note;
        const prev = open.get(key);
        if (prev) finish(e.channel, e.note, prev, e.tick); // 同じ音の重なり：前のノートを終える
        open.set(key, { velocity: e.velocity, on: tick });
        break;
      }
      case 'noteOff': {
        const key = e.channel * 128 + e.note;
        const prev = open.get(key);
        if (prev) {
          finish(e.channel, e.note, prev, e.tick);
          open.delete(key);
        }
        break;
      }
      case 'controlChange': {
        const st = stateOf(e.channel);
        const kind = CC_KINDS[e.controller];
        if (kind) {
          out.controls.push({ tick, channel: e.channel, kind, value: e.value });
        } else if (e.controller === CC_RPN_MSB) {
          st.rpnMsb = e.value;
        } else if (e.controller === CC_RPN_LSB) {
          st.rpnLsb = e.value;
        } else if (e.controller === CC_DATA_MSB || e.controller === CC_DATA_LSB) {
          // RPN 0（ベンド幅）を選んでいるときだけ使う。それ以外のデータエントリーは黙って読み飛ばす
          if (st.rpnMsb === 0 && st.rpnLsb === 0) {
            if (e.controller === CC_DATA_MSB) st.bendSemitones = e.value;
            else st.bendCents = e.value;
          }
        } else {
          discard(`コントロールチェンジ ${e.controller}`);
        }
        break;
      }
      case 'programChange':
        if (e.channel === DRUM_CHANNEL) discard('チャンネル 10 のプログラムチェンジ');
        else out.controls.push({ tick, channel: e.channel, kind: 'program', value: e.program });
        break;
      case 'pitchBend': {
        if (e.channel === DRUM_CHANNEL) {
          discard('チャンネル 10 のピッチベンド');
          break;
        }
        const st = stateOf(e.channel);
        const range = st.bendSemitones * 100 + st.bendCents;
        out.controls.push({ tick, channel: e.channel, kind: 'bend', value: (e.value / 8192) * range });
        break;
      }
      case 'tempo':
        out.tempos.push({ tick, bpm: 60_000_000 / e.microsecondsPerQuarter });
        break;
      case 'marker':
        out.markers.push({ tick, text: e.text });
        break;
      case 'timeSignature':
        out.timeSignatures.push({ tick, numerator: e.numerator, denominator: e.denominator });
        break;
      case 'other':
        discard(e.label);
        break;
    }
  }

  for (const [key, o] of open) {
    const ch = Math.floor(key / 128);
    const note = key % 128;
    out.warnings.push({
      tick: o.on,
      message: `チャンネル ${ch + 1} のノート ${note} にノートオフがありません。曲の最後で終えます`,
    });
    finish(ch, note, o, lastTick);
  }
  // 重なりやノートオフのない音は後から追加されるので、on の順に整える（安定ソート）
  out.notes.sort((a, b) => a.on - b.on);
  return out;
}
