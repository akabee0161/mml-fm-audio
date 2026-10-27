import { describe, expect, it } from 'vitest';
import { extract } from './extract.ts';
import { readSmf } from './smf.ts';
import { buildSmf } from './smfBuilder.ts';
import type { SmfEvent } from './smf.ts';

function run(events: SmfEvent[], opts: { ticksPerQuarter?: number; raw?: { tick: number; bytes: number[] }[] } = {}) {
  const bytes = buildSmf({
    ticksPerQuarter: opts.ticksPerQuarter,
    tracks: [events],
    raw: opts.raw ? [opts.raw] : undefined,
  });
  return extract(readSmf(bytes));
}

const cc = (tick: number, channel: number, controller: number, value: number): SmfEvent => ({
  kind: 'controlChange', tick, channel, controller, value,
});
const on = (tick: number, channel: number, note: number, velocity = 100): SmfEvent => ({
  kind: 'noteOn', tick, channel, note, velocity,
});
const off = (tick: number, channel: number, note: number): SmfEvent => ({ kind: 'noteOff', tick, channel, note });

describe('extract', () => {
  it('分解能 480 の tick を 96 に換える', () => {
    const r = run([on(480, 0, 60), off(960, 0, 60)]);
    expect(r.notes).toEqual([{ channel: 0, note: 60, velocity: 100, on: 96, off: 192 }]);
  });

  it('同じ音のノートオンが重なったら前のノートを終える', () => {
    const r = run([on(0, 0, 60), on(240, 0, 60), off(480, 0, 60), off(480, 0, 60)]);
    expect(r.notes.map((n) => [n.on, n.off])).toEqual([[0, 48], [48, 96]]);
  });

  it('同じ tick の同じ音の重なりでは長さ 0 の前のノートを捨てる', () => {
    const r = run([on(0, 0, 60, 50), on(0, 0, 60, 80), off(480, 0, 60)]);
    expect(r.notes).toEqual([{ channel: 0, note: 60, velocity: 80, on: 0, off: 96 }]);
  });

  it('チャンネルが違えば同じ音でも別のノート', () => {
    const r = run([on(0, 0, 60), on(0, 1, 60), off(480, 0, 60), off(480, 1, 60)]);
    expect(r.notes.map((n) => n.channel)).toEqual([0, 1]);
  });

  it('ノートオフのないノートは SMF の最後の tick で終え、警告する', () => {
    const r = run([on(0, 0, 60), on(480, 0, 64), off(960, 0, 64)]);
    expect(r.notes.map((n) => [n.note, n.on, n.off])).toEqual([[60, 0, 192], [64, 96, 192]]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0].tick).toBe(0);
    expect(r.warnings[0].message).toContain('ノートオフ');
  });

  it('RPN 0 のベンド幅を反映する', () => {
    const r = run([
      cc(0, 0, 101, 0), cc(0, 0, 100, 0), cc(0, 0, 6, 12),
      { kind: 'pitchBend', tick: 10, channel: 0, value: 8191 },
    ]);
    const bend = r.controls.find((c) => c.kind === 'bend')!;
    expect(bend.value).toBeCloseTo(1199.85, 1);
    expect(r.discarded.size).toBe(0);
  });

  it('CC38 のセントもベンド幅に足す', () => {
    const r = run([
      cc(0, 0, 101, 0), cc(0, 0, 100, 0), cc(0, 0, 6, 1), cc(0, 0, 38, 50),
      { kind: 'pitchBend', tick: 10, channel: 0, value: -8192 },
    ]);
    expect(r.controls[0].value).toBeCloseTo(-150, 5);
  });

  it('RPN がなければベンド幅は 200 セント', () => {
    const r = run([{ kind: 'pitchBend', tick: 0, channel: 0, value: 8191 }]);
    expect(r.controls[0]).toMatchObject({ kind: 'bend', channel: 0 });
    expect(r.controls[0].value).toBeCloseTo(199.98, 1);
  });

  it('RPN 0 以外を選んでいるときの CC6 はベンド幅にしない', () => {
    const r = run([
      cc(0, 0, 101, 0), cc(0, 0, 100, 1), cc(0, 0, 6, 12),
      { kind: 'pitchBend', tick: 10, channel: 0, value: 8191 },
    ]);
    expect(r.controls[0].value).toBeCloseTo(199.98, 1);
  });

  it('CC7・CC11・CC10 とプログラムチェンジを controls に入れる', () => {
    const r = run([
      { kind: 'programChange', tick: 0, channel: 3, program: 5 },
      cc(0, 3, 7, 100), cc(240, 3, 11, 90), cc(480, 9, 10, 64),
    ], { ticksPerQuarter: 480 });
    expect(r.controls).toEqual([
      { tick: 0, channel: 3, kind: 'program', value: 5 },
      { tick: 0, channel: 3, kind: 'volume', value: 100 },
      { tick: 48, channel: 3, kind: 'expression', value: 90 },
      { tick: 96, channel: 9, kind: 'pan', value: 64 },
    ]);
  });

  it('捨てたイベントを種類ごとに数える', () => {
    const r = run(
      [
        cc(0, 0, 64, 127), cc(10, 0, 64, 0), cc(20, 0, 64, 127),
        cc(0, 0, 6, 2), cc(0, 0, 38, 0), cc(0, 0, 100, 0), cc(0, 0, 101, 0),
        { kind: 'programChange', tick: 0, channel: 9, program: 1 },
        { kind: 'pitchBend', tick: 0, channel: 9, value: 100 },
      ],
      { raw: [{ tick: 0, bytes: [0xf0, 0x02, 0x7e, 0xf7] }] },
    );
    expect(r.discarded.get('コントロールチェンジ 64')).toBe(3);
    expect(r.discarded.get('システムエクスクルーシブ')).toBe(1);
    expect(r.discarded.get('チャンネル 10 のプログラムチェンジ')).toBe(1);
    expect(r.discarded.get('チャンネル 10 のピッチベンド')).toBe(1);
    expect(r.discarded.size).toBe(4);
    expect(r.controls).toEqual([]);
  });

  it('テンポは BPM に、マーカーと拍子は tick を換えて渡す', () => {
    const r = run([
      { kind: 'tempo', tick: 0, microsecondsPerQuarter: 500000 },
      { kind: 'marker', tick: 960, text: 'loopStart' },
      { kind: 'timeSignature', tick: 480, numerator: 3, denominator: 4 },
    ]);
    expect(r.tempos).toEqual([{ tick: 0, bpm: 120 }]);
    expect(r.markers).toEqual([{ tick: 192, text: 'loopStart' }]);
    expect(r.timeSignatures).toEqual([{ tick: 96, numerator: 3, denominator: 4 }]);
    expect(r.discarded.size).toBe(0);
  });
});

describe('extract: 同じ tick でノートオンがノートオフより先に並ぶ SMF', () => {
  it('同じ高さの連打が消えず 3 音になる', () => {
    const Q = 480;
    const ex = run(
      [on(0, 0, 60), on(Q, 0, 60), off(Q, 0, 60), on(2 * Q, 0, 60), off(2 * Q, 0, 60), off(3 * Q, 0, 60)],
      { ticksPerQuarter: Q },
    );
    expect(ex.notes.map((n) => [n.on, n.off])).toEqual([[0, 96], [96, 192], [192, 288]]);
  });
});

describe('extract: 同じ tick に書かれた長さ 0 のノート', () => {
  it('ノートオン → ノートオフが同じ tick のノートは notes に入らず、警告も出ない', () => {
    const ex = run([on(96, 0, 60), off(96, 0, 60), on(480, 0, 62), off(960, 0, 62)]);
    expect(ex.notes.map((n) => n.note)).toEqual([62]);
    expect(ex.warnings).toEqual([]);
  });
});

describe('extract: 端の場合', () => {
  it('最後の tick のノートオンでノートオフがないノートは、長さ 0 になるので警告なしに捨てる', () => {
    const ex = run([on(0, 0, 60), on(480, 0, 62)]);
    expect(ex.notes.map((n) => [n.note, n.on, n.off])).toEqual([[60, 0, 96]]);
    // 警告は曲の最後で終えたノート 60 の分だけ
    expect(ex.warnings.map((w) => w.message)).toEqual([expect.stringContaining('ノート 60 にノートオフがありません')]);
  });

  it('チャンネル 10 のノートも notes に入る', () => {
    const ex = run([on(0, 9, 36), off(120, 9, 36)]);
    expect(ex.notes).toEqual([{ channel: 9, note: 36, velocity: 100, on: 0, off: 24 }]);
  });

  it('対応するノートオンのないノートオフは無視する（ノートも警告も増えない）', () => {
    const ex = run([off(0, 0, 60), on(0, 0, 62), off(480, 0, 62)]);
    expect(ex.notes.map((n) => n.note)).toEqual([62]);
    expect(ex.warnings).toEqual([]);
  });
});
