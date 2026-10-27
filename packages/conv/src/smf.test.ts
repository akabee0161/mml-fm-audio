import { describe, expect, it } from 'vitest';
import { ConvError } from './errors.ts';
import { readSmf } from './smf.ts';
import { buildSmf } from './smfBuilder.ts';

describe('readSmf', () => {
  it('フォーマット 1・分解能 480 の 2 トラックを tick の順に合わせて読む', () => {
    const bytes = buildSmf({
      format: 1,
      ticksPerQuarter: 480,
      tracks: [
        [
          { kind: 'tempo', tick: 0, microsecondsPerQuarter: 500000 },
          { kind: 'timeSignature', tick: 0, numerator: 3, denominator: 4 },
          { kind: 'marker', tick: 960, text: 'loopStart' },
        ],
        [
          { kind: 'programChange', tick: 0, channel: 2, program: 5 },
          { kind: 'controlChange', tick: 0, channel: 2, controller: 7, value: 100 },
          { kind: 'pitchBend', tick: 0, channel: 2, value: -8192 },
          { kind: 'noteOn', tick: 0, channel: 2, note: 60, velocity: 100 },
          { kind: 'pitchBend', tick: 240, channel: 2, value: 8191 },
          { kind: 'noteOff', tick: 480, channel: 2, note: 60 },
        ],
      ],
    });
    const smf = readSmf(bytes);
    expect(smf.format).toBe(1);
    expect(smf.ticksPerQuarter).toBe(480);
    expect(smf.events).toEqual([
      { kind: 'tempo', tick: 0, microsecondsPerQuarter: 500000 },
      { kind: 'timeSignature', tick: 0, numerator: 3, denominator: 4 },
      { kind: 'programChange', tick: 0, channel: 2, program: 5 },
      { kind: 'controlChange', tick: 0, channel: 2, controller: 7, value: 100 },
      { kind: 'pitchBend', tick: 0, channel: 2, value: -8192 },
      { kind: 'noteOn', tick: 0, channel: 2, note: 60, velocity: 100 },
      { kind: 'pitchBend', tick: 240, channel: 2, value: 8191 },
      { kind: 'noteOff', tick: 480, channel: 2, note: 60 },
      { kind: 'marker', tick: 960, text: 'loopStart' },
    ]);
  });

  it('ランニングステータスとベロシティ 0 のノートオンを読む', () => {
    const bytes = buildSmf({
      tracks: [[]],
      raw: [[{ tick: 0, bytes: [0x90, 60, 100, 0x83, 0x60, 60, 0] }]],
    });
    expect(readSmf(bytes).events).toEqual([
      { kind: 'noteOn', tick: 0, channel: 0, note: 60, velocity: 100 },
      { kind: 'noteOff', tick: 480, channel: 0, note: 60 },
    ]);
  });

  it('システムエクスクルーシブ・知らないメタイベント・チャンネルプレッシャーは other', () => {
    const bytes = buildSmf({
      tracks: [[]],
      raw: [
        [
          { tick: 0, bytes: [0xf0, 0x03, 0x43, 0x10, 0xf7] },
          { tick: 10, bytes: [0xff, 0x03, 0x02, 0x41, 0x42] },
          { tick: 20, bytes: [0xd1, 50] },
          { tick: 30, bytes: [0xa1, 60, 50] },
        ],
      ],
    });
    expect(readSmf(bytes).events).toEqual([
      { kind: 'other', tick: 0, label: 'システムエクスクルーシブ' },
      { kind: 'other', tick: 10, label: 'メタイベント 0x03' },
      { kind: 'other', tick: 20, label: 'チャンネルプレッシャー' },
      { kind: 'other', tick: 30, label: 'ポリフォニックキープレッシャー' },
    ]);
  });

  it('同じ tick ではトラック順を保つ', () => {
    const bytes = buildSmf({
      tracks: [
        [{ kind: 'noteOn', tick: 0, channel: 0, note: 1, velocity: 1 }],
        [{ kind: 'noteOn', tick: 0, channel: 1, note: 2, velocity: 1 }],
      ],
    });
    expect(readSmf(bytes).events.map((e) => e.kind === 'noteOn' && e.note)).toEqual([1, 2]);
  });

  it('同じ tick では、前の tick から開いている音のノートオフを先にし、ほかは元の順を保つ', () => {
    const bytes = buildSmf({
      tracks: [
        [
          { kind: 'noteOn', tick: 0, channel: 0, note: 60, velocity: 100 },
          { kind: 'noteOn', tick: 480, channel: 0, note: 60, velocity: 100 },
          { kind: 'controlChange', tick: 480, channel: 0, controller: 7, value: 1 },
          { kind: 'noteOff', tick: 480, channel: 0, note: 60 },
          { kind: 'controlChange', tick: 480, channel: 0, controller: 7, value: 2 },
        ],
      ],
    });
    const events = readSmf(bytes).events;
    expect(events.map((e) => e.kind)).toEqual(['noteOn', 'noteOff', 'noteOn', 'controlChange', 'controlChange']);
    expect(events.filter((e) => e.kind === 'controlChange').map((e) => e.kind === 'controlChange' && e.value)).toEqual([1, 2]);
  });

  it('同じ tick で開いた音の長さ 0 のノートオフは、ノートオンの後に残す', () => {
    const bytes = buildSmf({
      tracks: [
        [
          { kind: 'noteOn', tick: 480, channel: 0, note: 60, velocity: 100 },
          { kind: 'noteOff', tick: 480, channel: 0, note: 60 },
        ],
      ],
    });
    expect(readSmf(bytes).events.map((e) => e.kind)).toEqual(['noteOn', 'noteOff']);
  });

  it('フォーマット 0 の 1 トラックを読む', () => {
    const smf = readSmf(
      buildSmf({
        format: 0,
        tracks: [[
          { kind: 'noteOn', tick: 0, channel: 0, note: 60, velocity: 100 },
          { kind: 'noteOff', tick: 480, channel: 0, note: 60 },
        ]],
      }),
    );
    expect(smf.format).toBe(0);
    expect(smf.events.map((e) => e.kind)).toEqual(['noteOn', 'noteOff']);
  });

  it('marker は latin1 として読む（0x80 以上のバイトも 1 文字）', () => {
    const smf = readSmf(buildSmf({ tracks: [[{ kind: 'marker', tick: 0, text: 'a\u0080éÿ' }]] }));
    expect(smf.events).toEqual([{ kind: 'marker', tick: 0, text: 'a\u0080éÿ' }]);
  });

  describe('読めないファイルは ConvError', () => {
    const valid = buildSmf({
      tracks: [[{ kind: 'noteOn', tick: 0, channel: 0, note: 60, velocity: 100 }]],
    });

    it('フォーマット 2', () => {
      const b = valid.slice();
      b[9] = 2;
      expect(() => readSmf(b)).toThrow(ConvError);
      expect(() => readSmf(b)).toThrow('フォーマット 2 の SMF は読めません');
    });

    it('SMPTE', () => {
      const b = valid.slice();
      b[12] = 0xe7;
      expect(() => readSmf(b)).toThrow(ConvError);
      expect(() => readSmf(b)).toThrow('SMPTE');
    });

    it('MThd がない', () => {
      expect(() => readSmf(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])))
        .toThrow(ConvError);
      expect(() => readSmf(new Uint8Array([]))).toThrow('SMF ではありません');
    });

    it('分解能が 0', () => {
      const b = valid.slice();
      b[12] = 0;
      b[13] = 0;
      expect(() => readSmf(b)).toThrow(ConvError);
      expect(() => readSmf(b)).toThrow('分解能が 0');
    });

    it('MTrk の長さは正しいが、中のイベントが途中で切れている', () => {
      // MTrk の長さ 3 に収まる [デルタ 0, ノートオン ch1, ノート 60] で、ベロシティがない
      const b = Uint8Array.from([
        ...valid.slice(0, 14),
        0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 3,
        0x00, 0x90, 0x3c,
      ]);
      expect(() => readSmf(b)).toThrow(ConvError);
      expect(() => readSmf(b)).toThrow('途中で切れています');
    });

    it('途中で切れている', () => {
      expect(() => readSmf(valid.slice(0, valid.length - 5))).toThrow(ConvError);
      expect(() => readSmf(valid.slice(0, 16))).toThrow(ConvError);
    });
  });
});
