import { describe, expect, it } from 'vitest';
import { analyzeMml, parseMml } from './parser.ts';
import { splitTracks } from './source.ts';

function notes(mml: string, track = 0) {
  const t = parseMml(mml).tracks[track];
  return t.events.filter((e) => e.type === 'note');
}

describe('parseMml: 音符', () => {
  it('c d e は 60, 62, 64 で、既定値が入る', () => {
    const song = parseMml('A c d e');
    expect(song.errors).toEqual([]);
    const ns = notes('A c d e');
    expect(ns.map((n) => n.type === 'note' && n.note)).toEqual([60, 62, 64]);
    expect(ns.map((n) => n.tick)).toEqual([0, 96, 192]);
    for (const n of ns) {
      expect(n).toMatchObject({ gate: 96, program: 0, volume: 12, pan: 64, bend: 0 });
    }
    expect(song.tracks[0].length).toBe(288);
    expect(song.length).toBe(288);
  });

  it('オクターブ・臨時記号・付点・休符', () => {
    const song = parseMml('A o5 c+8 d-16. r4 >c <c');
    expect(song.errors).toEqual([]);
    const ns = notes('A o5 c+8 d-16. r4 >c <c');
    expect(ns.map((n) => n.type === 'note' && [n.note, n.tick])).toEqual([
      [73, 0],
      [73, 48],
      [84, 180],
      [72, 276],
    ]);
    expect(ns[0]).toMatchObject({ gate: 48 });
    expect(ns[1]).toMatchObject({ gate: 36 });
    // 休符は tick 84〜180
    expect(ns[1].tick + 36).toBe(84);
    expect(ns[2].tick).toBe(180);
  });

  it('l と付点、%N', () => {
    expect(notes('A l8. c')[0]).toMatchObject({ gate: 72 });
    expect(notes('A c4.. c%36 c%36.').map((n) => n.type === 'note' && n.gate)).toEqual([168, 36, 54]);
    expect(notes('A c3 c48').map((n) => n.type === 'note' && n.gate)).toEqual([128, 8]);
  });

  it('音長の表の全数', () => {
    const table: Array<[number, number]> = [
      [1, 384], [2, 192], [4, 96], [8, 48], [16, 24], [32, 12],
      [3, 128], [6, 64], [12, 32], [24, 16], [48, 8],
    ];
    for (const [n, ticks] of table) {
      const song = parseMml(`A c${n}`);
      expect(song.errors).toEqual([]);
      expect(notes(`A c${n}`)[0]).toMatchObject({ gate: ticks });
      expect(song.tracks[0].length).toBe(ticks);
    }
  });

  it('休符で終わるトラックの length は休符の終わり', () => {
    expect(parseMml('A c4 r2').tracks[0].length).toBe(288);
  });
});

describe('parseMml: エラー', () => {
  const first = (mml: string) => parseMml(mml).errors[0];

  it('範囲外・書き忘れ・知らない文字', () => {
    expect(first('A c5')).toMatchObject({ line: 1, column: 3 });
    expect(first('A o9')).toMatchObject({ line: 1, column: 3 });
    expect(parseMml('A o0 <').errors).toHaveLength(1);
    expect(first('A x')).toMatchObject({ line: 1, column: 3 });
    expect(first('A c 4')).toMatchObject({ line: 1, column: 5 });
    expect(parseMml('A o').errors).toHaveLength(1);
    expect(parseMml('A l').errors).toHaveLength(1);
    expect(parseMml('A c%').errors).toHaveLength(1);
    expect(parseMml('A c%0').errors).toHaveLength(1);
    expect(parseMml('A c+-').errors).toHaveLength(1);
  });

  it('o0 c- はノート番号 11、o8 b+ は 120 で通る（0〜8 のオクターブでは 0〜127 を外れない）', () => {
    expect(parseMml('A o0 c-').errors).toEqual([]);
    expect(notes('A o0 c-')[0]).toMatchObject({ note: 11 });
    expect(parseMml('A o8 b+').errors).toEqual([]);
    expect(notes('A o8 b+')[0]).toMatchObject({ note: 120 });
  });

  it('付点: c48. は通る、c32... は整数にならずエラー', () => {
    expect(parseMml('A c48.').errors).toEqual([]);
    expect(notes('A c48.')[0]).toMatchObject({ gate: 12 });
    const e = parseMml('A c32...').errors;
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ line: 1, column: 3 });
  });

  it('トラック名が違う行は列 1 のエラーで捨てる', () => {
    for (const mml of ['Q c', 'a c', 'A0 c']) {
      const song = parseMml(mml);
      expect(song.errors).toHaveLength(1);
      expect(song.errors[0]).toMatchObject({ line: 1, column: 1 });
      expect(song.tracks).toEqual([]);
    }
  });

  it('1 つの命令から 2 つ目のエラーを出さない', () => {
    expect(parseMml('A c4 x c4 y').errors).toHaveLength(2);
    expect(parseMml('A c5 c4').errors).toHaveLength(1);
  });

  it('エラーは行・列の順', () => {
    const e = parseMml('A x\nQ c\nA y').errors;
    expect(e.map((x) => [x.line, x.column])).toEqual([[1, 3], [2, 1], [3, 3]]);
  });
});

describe('parseMml: 行とトラック', () => {
  it('複数行は同じトラックへ連結し、トラックは初出の順', () => {
    const song = parseMml('A c\nB d\nA e');
    expect(song.errors).toEqual([]);
    expect(song.tracks.map((t) => t.name)).toEqual(['A', 'B']);
    expect(notes('A c\nB d\nA e', 0).map((n) => n.type === 'note' && [n.note, n.tick])).toEqual([
      [60, 0],
      [64, 96],
    ]);
    expect(notes('A c\nB d\nA e', 1).map((n) => n.type === 'note' && n.note)).toEqual([62]);
  });

  it('; 以降・空行・コメント行を無視する', () => {
    const song = parseMml('; 曲\n\nA c ; 注\n   \nA d');
    expect(song.errors).toEqual([]);
    expect(notes('; 曲\n\nA c ; 注\n   \nA d')).toHaveLength(2);
  });

  it('CRLF は LF と同じ', () => {
    const a = parseMml('A c\r\nA x').errors;
    const b = parseMml('A c\nA x').errors;
    expect(a).toEqual(b);
    expect(a[0]).toMatchObject({ line: 2, column: 3 });
  });

  it('空の入力', () => {
    expect(parseMml('')).toEqual({
      tracks: [],
      tempos: [{ tick: 0, bpm: 120 }],
      length: 0,
      loopStart: null,
      loopEnd: 0,
      errors: [],
    });
  });
});

describe('splitTracks', () => {
  it('positions は元の位置を引け、行の区切りは空白 1 文字', () => {
    const { tracks, errors } = splitTracks('A c d\nA e');
    expect(errors).toEqual([]);
    expect(tracks).toHaveLength(1);
    const t = tracks[0];
    expect(t.text).toBe('c d e');
    expect(t.text).toHaveLength(t.positions.length);
    expect(t.positions[0]).toEqual({ line: 1, column: 3 });
    expect(t.positions[4]).toEqual({ line: 2, column: 3 });
  });

  it('サブトラック名 A1, P12 と R を受け付ける', () => {
    const { tracks, errors } = splitTracks('A1 c\nP12 c\nR r');
    expect(errors).toEqual([]);
    expect(tracks.map((t) => t.name)).toEqual(['A1', 'P12', 'R']);
  });
});

function errs(mml: string) {
  return parseMml(mml).errors.map((e) => [e.line, e.column]);
}

describe('parseMml: @ v p q', () => {
  it('@80 v10 p32 が以降のノートに入る', () => {
    const ns = notes('A @80 v10 p32 c');
    expect(ns[0]).toMatchObject({ program: 80, volume: 10, pan: 32 });
    expect(parseMml('A @80 v10 p32 c').errors).toEqual([]);
  });

  it('v は volume イベントを出し、@ p q はイベントを出さない', () => {
    const song = parseMml('A c v8 @1 p1 q4');
    expect(song.errors).toEqual([]);
    expect(song.tracks[0].events.map((e) => e.type)).toEqual(['note', 'volume']);
    expect(song.tracks[0].events[1]).toEqual({ type: 'volume', tick: 96, volume: 8 });
  });

  it('q はゲートタイム。最小 1 ティック', () => {
    expect(notes('A q6 c4 q8 c4').map((n) => n.type === 'note' && n.gate)).toEqual([72, 96]);
    expect(notes('A q1 c%4')[0]).toMatchObject({ gate: 1 });
    // 音長（次のノートの tick）は q の影響を受けない
    expect(notes('A q4 c4 c4')[1].tick).toBe(96);
  });

  it.each(['A v16', 'A q0', 'A q9', 'A @128', 'A p128', 'A v', 'A @', 'A p', 'A q'])(
    '%s は 1 件のエラー',
    (mml) => {
      expect(errs(mml)).toEqual([[1, 3]]);
    },
  );
});

describe('parseMml: B', () => {
  it('B は bend イベントを出し、以降のノートの bend になる', () => {
    const song = parseMml('A c B+100 r4 c');
    expect(song.errors).toEqual([]);
    const bends = song.tracks[0].events.filter((e) => e.type === 'bend');
    expect(bends).toEqual([{ type: 'bend', tick: 96, cents: 100 }]);
    expect(notes('A c B+100 r4 c')[1]).toMatchObject({ bend: 100 });
  });

  it.each(['A B50', 'A B+1201', 'A B-1201', 'A B', 'A B+'])('%s は 1 件のエラー', (mml) => {
    expect(errs(mml)).toEqual([[1, 3]]);
  });

  it('B-1200 と B+0 は通る', () => {
    expect(parseMml('A B-1200 B+0 c').errors).toEqual([]);
  });
});

describe('parseMml: タイ', () => {
  it('c4&c16 は 1 つのノートで gate 120', () => {
    const ns = notes('A c4&c16');
    expect(ns).toHaveLength(1);
    expect(ns[0]).toMatchObject({ gate: 120 });
    expect(parseMml('A c4&c16').tracks[0].length).toBe(120);
  });

  it('q はつないだ全体の長さに掛ける', () => {
    expect(notes('A q4 c4&c4')[0]).toMatchObject({ gate: 96 });
  });

  it('タイの間の B・v はその位置のイベントになり、次のノートに引き継がれる', () => {
    const mml = 'A c8&B+50c8&v8c8 c';
    const song = parseMml(mml);
    expect(song.errors).toEqual([]);
    const ev = song.tracks[0].events;
    expect(ev.filter((e) => e.type === 'note')).toHaveLength(2);
    expect(ev[0]).toMatchObject({ type: 'note', tick: 0, gate: 144 });
    expect(ev).toContainEqual({ type: 'bend', tick: 48, cents: 50 });
    expect(ev).toContainEqual({ type: 'volume', tick: 96, volume: 8 });
    expect(notes(mml)[1]).toMatchObject({ tick: 144, bend: 50, volume: 8 });
  });

  it('行をまたいでよい', () => {
    const ns = notes('A c4&\nA c4');
    expect(ns).toHaveLength(1);
    expect(ns[0]).toMatchObject({ gate: 192 });
  });

  it('高さが違うタイは後ろの音符の位置でエラー', () => {
    expect(errs('A c4&d4')).toEqual([[1, 6]]);
  });

  it.each(['A c4&r4', 'A c4&', 'A c4&o5c4', 'A c4&l8c4'])('%s は & の位置で 1 件のエラー', (mml) => {
    expect(errs(mml)).toEqual([[1, 5]]);
  });

  it('& の前に音符がなければエラー', () => {
    expect(errs('A &c4')).toEqual([[1, 3]]);
    expect(errs('A c4 r4 &c4')).toEqual([[1, 9]]);
  });

  it('タイのエラーの後は続きを読める', () => {
    const song = parseMml('A c4&o5c4 d');
    expect(song.errors).toHaveLength(1);
    expect(notes('A c4&o5c4 d').map((n) => n.type === 'note' && n.note)).toEqual([60, 72, 74]);
  });
});

describe('parseMml: 回復', () => {
  it('エラーの後の音符を読む（A c5 d）', () => {
    const song = parseMml('A c5 d');
    expect(song.errors).toHaveLength(1);
    expect(song.errors[0]).toMatchObject({ line: 1, column: 3 });
    expect(notes('A c5 d').map((n) => n.type === 'note' && n.note)).toEqual([62]);
  });

  it('A v の後の命令を読む（原因が 1 つなら 1 件）', () => {
    const song = parseMml('A v c');
    expect(song.errors).toHaveLength(1);
    expect(notes('A v c')).toHaveLength(1);
    expect(errs('A vc')).toEqual([[1, 3]]);
    expect(notes('A vc')).toHaveLength(1);
  });
});

describe('parseMml: テンポ', () => {
  it('t は tempos になり、tick 0 になければ 120 を先頭に入れる', () => {
    expect(parseMml('A t140 c4 t90 c4').tempos).toEqual([{ tick: 0, bpm: 140 }, { tick: 96, bpm: 90 }]);
    expect(parseMml('A c4 t90').tempos).toEqual([{ tick: 0, bpm: 120 }, { tick: 96, bpm: 90 }]);
  });

  it('小数可', () => {
    expect(parseMml('A t132.5').tempos).toEqual([{ tick: 0, bpm: 132.5 }]);
  });

  it.each(['A t0', 'A t1000', 'A t', 'A t999.5', 'A t120.'])('%s は 1 件のエラー', (mml) => {
    expect(errs(mml)).toEqual([[1, 3]]);
  });

  it('違うトラックの同じ tick で値が違えばエラー（後に出たほうの位置）、同じなら通る', () => {
    expect(errs('A t130\nB t140')).toEqual([[2, 3]]);
    expect(parseMml('A t130\nB t130').errors).toEqual([]);
    expect(parseMml('A t130\nB t130').tempos).toEqual([{ tick: 0, bpm: 130 }]);
  });

  it('同じトラックの同じ tick では後の値', () => {
    const song = parseMml('A t100 t140 c');
    expect(song.errors).toEqual([]);
    expect(song.tempos).toEqual([{ tick: 0, bpm: 140 }]);
  });
});

describe('analyzeMml: 命令の記録', () => {
  it('実行できた命令の tick と元の位置を、トラックごとに残す', () => {
    const { traces } = analyzeMml('A c8&B+50c8 x r4\nA v8 c');
    expect(traces).toHaveLength(1);
    expect(traces[0].map((t) => [t.command, t.tick, t.position.line, t.position.column, t.noteOn])).toEqual([
      ['c', 0, 1, 3, true],
      ['&', 48, 1, 5, false],
      ['B', 48, 1, 6, false],
      ['c', 48, 1, 10, false],
      ['r', 96, 1, 15, false],
      ['v', 192, 2, 3, false],
      ['c', 192, 2, 6, true],
    ]);
  });
});
