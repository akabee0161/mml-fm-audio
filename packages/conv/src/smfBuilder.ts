import type { SmfEvent } from './smf.ts';

export interface RawEvent {
  tick: number;
  /** デルタタイムを除いたバイト列（ランニングステータスの 2 つ目以降のデルタタイムは自分で含める） */
  bytes: number[];
}

export interface BuildSmfOptions {
  format?: 0 | 1;
  ticksPerQuarter?: number;
  tracks: SmfEvent[][];
  /** トラックの添字で tracks と対応する、任意のバイト列のイベント。同じ tick では tracks のイベントの後に置く */
  raw?: RawEvent[][];
}

function vlq(n: number): number[] {
  const out = [n & 0x7f];
  for (n = Math.floor(n / 128); n > 0; n = Math.floor(n / 128)) out.unshift((n & 0x7f) | 0x80);
  return out;
}

function encode(e: SmfEvent): number[] {
  switch (e.kind) {
    case 'noteOn':
      return [0x90 | e.channel, e.note, e.velocity];
    case 'noteOff':
      return [0x80 | e.channel, e.note, 0];
    case 'controlChange':
      return [0xb0 | e.channel, e.controller, e.value];
    case 'programChange':
      return [0xc0 | e.channel, e.program];
    case 'pitchBend': {
      const v = e.value + 8192;
      return [0xe0 | e.channel, v & 0x7f, v >> 7];
    }
    case 'tempo': {
      const t = e.microsecondsPerQuarter;
      return [0xff, 0x51, 3, (t >> 16) & 0xff, (t >> 8) & 0xff, t & 0xff];
    }
    case 'marker': {
      const text = [...e.text].map((ch) => ch.charCodeAt(0) & 0xff);
      return [0xff, 0x06, ...vlq(text.length), ...text];
    }
    case 'timeSignature':
      return [0xff, 0x58, 4, e.numerator, Math.log2(e.denominator), 24, 8];
    case 'other':
      throw new Error('buildSmf は other を書けません（raw を使ってください）');
  }
}

function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

/** テスト用に SMF のバイト列を組み立てる。 */
export function buildSmf(opts: BuildSmfOptions): Uint8Array {
  const format = opts.format ?? 1;
  const ticksPerQuarter = opts.ticksPerQuarter ?? 480;
  const out: number[] = [
    ...'MThd'.split('').map((c) => c.charCodeAt(0)),
    ...u32(6),
    0,
    format,
    0,
    opts.tracks.length,
    ticksPerQuarter >> 8,
    ticksPerQuarter & 0xff,
  ];
  opts.tracks.forEach((events, i) => {
    const items = [
      ...events.map((e) => ({ tick: e.tick, bytes: encode(e) })),
      ...(opts.raw?.[i] ?? []),
    ].sort((a, b) => a.tick - b.tick); // 安定ソート：同じ tick は書いた順
    const body: number[] = [];
    let last = 0;
    for (const it of items) {
      body.push(...vlq(it.tick - last), ...it.bytes);
      last = it.tick;
    }
    body.push(0, 0xff, 0x2f, 0);
    out.push(...'MTrk'.split('').map((c) => c.charCodeAt(0)), ...u32(body.length), ...body);
  });
  return Uint8Array.from(out);
}
