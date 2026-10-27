import { ConvError } from './errors.ts';

export type SmfEvent =
  | { kind: 'noteOn'; tick: number; channel: number; note: number; velocity: number } // velocity は 1〜127
  | { kind: 'noteOff'; tick: number; channel: number; note: number } // ベロシティ 0 のノートオンを含む
  | { kind: 'controlChange'; tick: number; channel: number; controller: number; value: number }
  | { kind: 'programChange'; tick: number; channel: number; program: number }
  | { kind: 'pitchBend'; tick: number; channel: number; value: number } // −8192〜8191
  | { kind: 'tempo'; tick: number; microsecondsPerQuarter: number }
  | { kind: 'marker'; tick: number; text: string } // latin1 で読む
  | { kind: 'timeSignature'; tick: number; numerator: number; denominator: number } // denominator は 4 など実際の値
  | { kind: 'other'; tick: number; label: string }; // --report に出す種類名

export interface Smf {
  format: 0 | 1;
  ticksPerQuarter: number;
  events: SmfEvent[];
}

const TRUNCATED = 'SMF が途中で切れています';

/** 範囲を確かめながら進む読み取り位置。 */
class Cursor {
  private readonly view: DataView;
  pos: number;
  private readonly end: number;

  // Node の型除去だけの実行では、引数に private などを書く省略形が使えない
  constructor(view: DataView, pos: number, end: number) {
    this.view = view;
    this.pos = pos;
    this.end = end;
  }

  get done(): boolean {
    return this.pos >= this.end;
  }

  u8(): number {
    if (this.pos >= this.end) throw new ConvError(TRUNCATED);
    return this.view.getUint8(this.pos++);
  }

  skip(n: number): number {
    if (this.pos + n > this.end) throw new ConvError(TRUNCATED);
    const start = this.pos;
    this.pos += n;
    return start;
  }

  /** 可変長の数（SMF は最大 4 バイト）。 */
  vlq(): number {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const b = this.u8();
      value = value * 128 + (b & 0x7f);
      if ((b & 0x80) === 0) return value;
    }
    throw new ConvError('SMF の可変長の数が長すぎます');
  }
}

function hex2(n: number): string {
  return n.toString(16).toUpperCase().padStart(2, '0');
}

function readTrack(view: DataView, start: number, end: number, out: SmfEvent[]): void {
  const c = new Cursor(view, start, end);
  let tick = 0;
  let running = 0;
  while (!c.done) {
    tick += c.vlq();
    let status = c.u8();
    let first: number | undefined;
    if (status < 0x80) {
      // ランニングステータス：直前のステータスを使い、今読んだバイトが最初のデータ
      if (running === 0) throw new ConvError('SMF の最初のイベントにステータスバイトがありません');
      first = status;
      status = running;
    }

    if (status === 0xff) {
      running = 0;
      const type = c.u8();
      const len = c.vlq();
      const at = c.skip(len);
      if (type === 0x2f) break; // End of Track
      if (type === 0x51 && len === 3) {
        out.push({
          kind: 'tempo',
          tick,
          microsecondsPerQuarter:
            (view.getUint8(at) << 16) | (view.getUint8(at + 1) << 8) | view.getUint8(at + 2),
        });
      } else if (type === 0x06) {
        let text = '';
        for (let i = 0; i < len; i++) text += String.fromCharCode(view.getUint8(at + i));
        out.push({ kind: 'marker', tick, text });
      } else if (type === 0x58 && len >= 2) {
        out.push({
          kind: 'timeSignature',
          tick,
          numerator: view.getUint8(at),
          denominator: 2 ** view.getUint8(at + 1),
        });
      } else {
        out.push({ kind: 'other', tick, label: `メタイベント 0x${hex2(type)}` });
      }
      continue;
    }
    if (status === 0xf0 || status === 0xf7) {
      running = 0;
      c.skip(c.vlq());
      out.push({ kind: 'other', tick, label: 'システムエクスクルーシブ' });
      continue;
    }
    if (status >= 0xf0) {
      throw new ConvError(`SMF に未対応のステータスバイト 0x${hex2(status)} があります`);
    }

    running = status;
    const channel = status & 0x0f;
    const type = status & 0xf0;
    const d1 = first ?? c.u8();
    switch (type) {
      case 0x80:
        c.u8();
        out.push({ kind: 'noteOff', tick, channel, note: d1 });
        break;
      case 0x90: {
        const velocity = c.u8();
        out.push(
          velocity === 0
            ? { kind: 'noteOff', tick, channel, note: d1 }
            : { kind: 'noteOn', tick, channel, note: d1, velocity },
        );
        break;
      }
      case 0xa0:
        c.u8();
        out.push({ kind: 'other', tick, label: 'ポリフォニックキープレッシャー' });
        break;
      case 0xb0:
        out.push({ kind: 'controlChange', tick, channel, controller: d1, value: c.u8() });
        break;
      case 0xc0:
        out.push({ kind: 'programChange', tick, channel, program: d1 });
        break;
      case 0xd0:
        out.push({ kind: 'other', tick, label: 'チャンネルプレッシャー' });
        break;
      default: // 0xe0
        out.push({ kind: 'pitchBend', tick, channel, value: ((c.u8() << 7) | d1) - 8192 });
    }
  }
}

/** SMF（フォーマット 0・1）を読み、全トラックを tick の順に合わせたイベント列にする。 */
export function readSmf(bytes: Uint8Array): Smf {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) =>
    at + 4 <= bytes.length ? String.fromCharCode(...bytes.subarray(at, at + 4)) : '';
  if (tag(0) !== 'MThd' || bytes.length < 14) throw new ConvError('SMF ではありません（MThd がありません）');
  const headerLen = view.getUint32(4);
  if (headerLen < 6 || 8 + headerLen > bytes.length) throw new ConvError(TRUNCATED);
  const format = view.getUint16(8);
  const trackCount = view.getUint16(10);
  const division = view.getUint16(12);
  if (format !== 0 && format !== 1) throw new ConvError(`フォーマット ${format} の SMF は読めません`);
  if (division & 0x8000) throw new ConvError('SMPTE 形式の分解能の SMF は読めません');
  if (division === 0) throw new ConvError('SMF の分解能が 0 です');

  const events: SmfEvent[] = [];
  let pos = 8 + headerLen;
  let tracks = 0;
  while (tracks < trackCount) {
    if (pos + 8 > bytes.length) throw new ConvError(TRUNCATED);
    const len = view.getUint32(pos + 4);
    const bodyStart = pos + 8;
    if (bodyStart + len > bytes.length) throw new ConvError(TRUNCATED);
    if (tag(pos) === 'MTrk') {
      readTrack(view, bodyStart, bodyStart + len, events);
      tracks++;
    }
    pos = bodyStart + len; // MTrk 以外のチャンクは読み飛ばす
  }
  // tick の順（Array.prototype.sort は安定なので、同じ tick ではトラック順・ファイル内の順が残る）
  events.sort((a, b) => a.tick - b.tick);
  return { format, ticksPerQuarter: division, events: offsFirst(events) };
}

/**
 * 同じ tick の中で、前の tick から開いている音のノートオフを先頭に出す（次のノートオンが前のノートオフより
 * 先に書かれた SMF で、同じ高さの連打が消えないように）。同じ tick で開いた音の長さ 0 のノートオフは、
 * ノートオンの後の元の位置に残す。ほかのイベントは元の順を保つ。
 */
function offsFirst(sorted: SmfEvent[]): SmfEvent[] {
  const result: SmfEvent[] = [];
  const open = new Set<number>(); // 前の tick までに開いた（チャンネル, 音）
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j < sorted.length && sorted[j].tick === sorted[i].tick) j++;
    const group = sorted.slice(i, j);
    const isClosing = (e: SmfEvent) => e.kind === 'noteOff' && open.has(e.channel * 128 + e.note);
    const ordered = [...group.filter(isClosing), ...group.filter((e) => !isClosing(e))];
    result.push(...ordered);
    for (const e of ordered) {
      if (e.kind === 'noteOn') open.add(e.channel * 128 + e.note);
      else if (e.kind === 'noteOff') open.delete(e.channel * 128 + e.note);
    }
    i = j;
  }
  return result;
}
