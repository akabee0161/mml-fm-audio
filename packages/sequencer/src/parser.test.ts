import { describe, expect, it } from 'vitest';
import { analyzeMml, parseMml } from './parser.ts';
import { DRUM_PROGRAMS } from './song.ts';
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

describe('トラック数の上限', () => {
  // A〜P、A1〜A14 の 30 個
  const names = [...'ABCDEFGHIJKLMNOP'.split(''), ...Array.from({ length: 14 }, (_, i) => `A${i + 1}`)];

  it('30 個ちょうどは通る。同じ名前の複数行は 1 つと数える', () => {
    const song = parseMml([...names.map((n) => `${n} c`), 'A d', 'B d'].join('\n'));
    expect(song.errors).toEqual([]);
    expect(song.tracks).toHaveLength(30);
  });

  it('31 個目の新しいトラック名の位置にエラーを 1 件出し、31 個目以降は解析しない', () => {
    const song = parseMml([...names.map((n) => `${n} c`), 'R bd', 'B2 c', 'R bd', 'A d'].join('\n'));
    expect(song.errors).toEqual([{ line: 31, column: 1, message: 'トラックが多すぎます（30 まで）' }]);
    expect(song.tracks).toHaveLength(30);
    expect(song.tracks[0]!.events.map((e) => e.type === 'note' && e.note)).toEqual([60, 62]); // 既存の名前の行は連結される
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

  it('ドラムのサブトラック R1, R12 を受け付ける', () => {
    const { tracks, errors } = splitTracks('R1 bd\nR12 sd');
    expect(errors).toEqual([]);
    expect(tracks.map((t) => t.name)).toEqual(['R1', 'R12']);
  });

  it('R0・R01 はトラック名のエラー', () => {
    expect(splitTracks('R0 bd').errors).toHaveLength(1);
    expect(splitTracks('R01 bd').errors).toHaveLength(1);
  });

  it('R1 は R と同じドラムトラックとして解析する', () => {
    const song = parseMml('R bd8 ch8\nR1 ch8 ch8');
    expect(song.errors).toEqual([]);
    expect(song.tracks[1]!.events[0]).toMatchObject({ type: 'note', tick: 0, program: DRUM_PROGRAMS.ch });
    expect(parseMml('R1 c').errors).toMatchObject([{ line: 1, column: 4, message: expect.stringContaining('音符を書けません') }]);
    expect(parseMml('R2 @3 bd').errors).toMatchObject([{ line: 1, column: 4, message: expect.stringContaining("'@' を書けません") }]);
    expect(parseMml('R1 B+5 bd').errors).toMatchObject([{ line: 1, column: 4, message: expect.stringContaining("'B' を書けません") }]);
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

  it('タイの q はノートオンした時点の値：後ろの音符の前に書いた q は効かない', () => {
    expect(notes('A c4 q4 &c4')[0]).toMatchObject({ gate: 192 });
  });

  it('タイの q はノートオンした時点の値：先に書いた q4 が全体に掛かる', () => {
    expect(notes('A q4 c4 q8 &c4')[0]).toMatchObject({ gate: 96 });
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

describe('parseMml: 繰り返し [ ]N', () => {
  const pitches = (mml: string, track = 0) =>
    notes(mml, track).map((n) => n.type === 'note' && n.note);
  const positions = (mml: string) => parseMml(mml).errors.map((e) => [e.line, e.column]);

  it('[cd]2 e は c d c d e', () => {
    expect(parseMml('A [cd]2 e').errors).toEqual([]);
    expect(pitches('A [cd]2 e')).toEqual([60, 62, 60, 62, 64]);
    expect(parseMml('A [cd]2 e').tracks[0].length).toBe(480);
  });

  it('入れ子：[[c]2 d]2 は c c d c c d', () => {
    expect(pitches('A [[c]2 d]2')).toEqual([60, 60, 62, 60, 60, 62]);
  });

  it('中の状態の変化は次の回に持ち越す', () => {
    const ns = notes('A [o5 c]2');
    expect(ns.map((n) => n.type === 'note' && n.note)).toEqual([72, 72]);
    // o を持ち越す例：[c >]2 は 60, 72
    expect(pitches('A [c >]2')).toEqual([60, 72]);
    expect(parseMml('A [c >]2').errors).toEqual([]);
  });

  it.each([
    ['A [cd]', [[1, 6]]],
    ['A [cd]0', [[1, 6]]],
    ['A [cd]256', [[1, 6]]],
    ['A cd]2', [[1, 5]]],
    ['A [cd', [[1, 3]]],
    ['A [c4&]2', [[1, 6]]],
    ['A [c x]3', [[1, 6]]],
  ])('%s のエラー', (mml, expected) => {
    expect(positions(mml)).toEqual(expected);
  });

  it('[ ] をまたぐタイは [ の直後・] の直後からもエラー', () => {
    expect(parseMml('A c [&c]2').errors).toHaveLength(1);
    expect(parseMml('A [c]2 &c').errors).toHaveLength(1);
  });

  it('入れ子の閉じ忘れは、それぞれの [ の位置', () => {
    expect(positions('A [[c]2')).toEqual([[1, 3]]);
    expect(positions('A [[c')).toEqual([[1, 3], [1, 4]]);
  });

  it('展開が 100,000 を超える入れ子は、エラー 1 つで 1 秒以内に終わる', () => {
    const start = performance.now();
    const song = parseMml('A [[[[c]255]255]255]255');
    expect(performance.now() - start).toBeLessThan(1000);
    expect(song.errors).toHaveLength(1);
    expect(song.errors[0]).toMatchObject({ line: 1, column: 3 });
  });

  it.each(['A [[[[r]255]255]255]255', 'A [[[[v8]255]255]255]255', 'A [[[[x]255]255]255]255'])(
    '%s も 1 秒以内に終わり、エラーは 1 つ以上で止まる',
    (mml) => {
      const start = performance.now();
      const song = parseMml(mml);
      expect(performance.now() - start).toBeLessThan(1000);
      expect(song.errors.filter((e) => e.line === 1 && e.column === 3)).toHaveLength(1);
      expect(song.errors.length).toBeLessThanOrEqual(2); // 展開の上限と、x があればその 1 件
    },
  );

  it('上限ぎりぎりの展開は通る', () => {
    expect(parseMml('A [[c]250]100').errors).toEqual([]);
  });
});

describe('parseMml: B-0', () => {
  it('B-0 の bend は 0（-0 にならない）', () => {
    const song = parseMml('A B-0 c');
    expect(song.errors).toEqual([]);
    const bend = song.tracks[0].events.find((e) => e.type === 'bend');
    expect(Object.is((bend as { cents: number }).cents, 0)).toBe(true);
    const n = song.tracks[0].events.find((e) => e.type === 'note');
    expect(Object.is((n as { bend: number }).bend, 0)).toBe(true);
  });
});

describe('parseMml: ループ L・E', () => {
  const positions = (mml: string) => parseMml(mml).errors.map((e) => [e.line, e.column]);

  it('A c L d e は loopStart 96、loopEnd 288', () => {
    const song = parseMml('A c L d e');
    expect(song.errors).toEqual([]);
    expect([song.loopStart, song.loopEnd]).toEqual([96, 288]);
  });

  it('A L c は loopStart 0、A c d は loopStart null で loopEnd 192', () => {
    expect(parseMml('A L c').loopStart).toBe(0);
    const song = parseMml('A c d');
    expect([song.loopStart, song.loopEnd]).toEqual([null, 192]);
  });

  it('A c L d E r4 は通り、loopEnd 192、length 288', () => {
    const song = parseMml('A c L d E r4');
    expect(song.errors).toEqual([]);
    expect([song.loopStart, song.loopEnd, song.length]).toEqual([96, 192, 288]);
  });

  it('E の後のノートオンはエラー', () => {
    expect(positions('A c L d E e')).toEqual([[1, 11]]);
  });

  it('ループ終了を越えるノートは書ける', () => {
    const mml = 'B L c2 c2 E\nA r2 r4 r8 e8&e4';
    const song = parseMml(mml);
    expect(song.errors).toEqual([]);
    expect([song.loopStart, song.loopEnd, song.length]).toEqual([0, 384, 480]);
    const a = song.tracks.find((t) => t.name === 'A')!;
    const ns = a.events.filter((e) => e.type === 'note');
    expect(ns).toHaveLength(1);
    expect(ns[0]).toMatchObject({ tick: 336, gate: 144 });
  });

  it('& と次の音符の間の E はエラー', () => {
    const errors = parseMml('A L c2 c4 r8 e8&E e4').errors;
    // & の位置（1 行 16 列）と、E の後の e4（19 列）がノートオンなのでエラー
    expect(errors.map((e) => [e.line, e.column])).toEqual([[1, 16], [1, 19]]);
  });

  it('別のトラックの E より後の v はエラー、休符は通る', () => {
    expect(positions('A L c c E\nB c d v10')).toEqual([[2, 7]]);
    expect(parseMml('A L c c E\nB c d r4').errors).toEqual([]);
  });

  it('E より後の B t @ p q o < > l と、タイの続きでない音符はエラー', () => {
    for (const cmd of ['B+10', 't100', '@1', 'p10', 'q4', 'o5', '<', '>', 'l8', 'v1']) {
      expect(positions(`A L c c E\nB c d ${cmd}`)).toEqual([[2, 7]]);
    }
  });

  it.each([
    ['A c L L d', [[1, 7]]],
    ['A c E', [[1, 5]]],
    ['A c E L d', [[1, 5]]],
    ['A L E c', [[1, 5]]],
    ['A [L c]2', [[1, 4]]],
    ['A [c E]2', [[1, 6]]],
    ['A c L', [[1, 5]]],
    ['A L c E E r', [[1, 9]]],
  ])('%s のエラー', (mml, expected) => {
    expect(positions(mml)).toEqual(expected);
  });

  it('違う長さのトラック：loopEnd は length', () => {
    const song = parseMml('A L c\nB d e f');
    expect(song.errors).toEqual([]);
    expect([song.loopStart, song.loopEnd, song.length]).toEqual([0, 288, 288]);
  });

  it('E がなければ、E より後の検査はしない', () => {
    expect(parseMml('A L c\nB c d e').errors).toEqual([]);
  });
});

describe('parseMml: ループの中の長いノート', () => {
  const errs = (mml: string) => parseMml(mml).errors.map((e) => [e.line, e.column]);
  // B が 2 ティックのループ（L r%2 E）を決め、A が長いノートを書く。上限は 2 × 16 = 32 ティック
  const loop = 'B L r%2 E\n';

  it('ゲートがループ 1 周の 16 倍ちょうどなら通り、超えるとノートの書き始めを指すエラー', () => {
    expect(errs(`${loop}A c%32`)).toEqual([]);
    const song = parseMml(`${loop}A r%1 c%33`);
    expect(song.errors).toHaveLength(1);
    expect(song.errors[0]).toMatchObject({ line: 2, column: 7 });
    expect(song.errors[0]!.message).toContain('ループの中のノートが長すぎます');
  });

  it('タイでつないだノートは、タイ全体のゲートで数え、エラーは最初の音符を指す', () => {
    expect(errs(`${loop}A c%20&c%12`)).toEqual([]);
    expect(errs(`${loop}A c%20&c%13`)).toEqual([[2, 3]]);
  });

  it('q を掛けたゲートで数える', () => {
    expect(errs(`${loop}A q4 c%64`)).toEqual([]);
    expect(errs(`${loop}A q4 c%66`)).toEqual([[2, 6]]);
  });

  it('L の前でノートオンしたノートは、長くても通る', () => {
    expect(errs('A c%1000 L r%2 E')).toEqual([]);
  });

  it('L のない曲は、長くても通る', () => {
    expect(errs('A c%1000\nB r%2')).toEqual([]);
  });

  it('E がない曲では、ノートが曲の終わり（ループ終了）を越えないので、規則に当たらない', () => {
    expect(errs('A L c%2\nB r%1 c%33')).toEqual([]);
  });

  it('複数のトラックのエラーを、位置の順に全部出す', () => {
    expect(errs(`${loop}A c%33\nC r%1 c%40`)).toEqual([[2, 3], [3, 7]]);
  });

  it('ループ 1 周の長さが 0 のときは、既存のエラーだけでゼロ除算などは起きない', () => {
    expect(errs('A L E c%1000')).toEqual([[1, 5]]);
    expect(errs('A c%1000 L')).toEqual([[1, 10]]);
  });
});

describe('parseMml: 同じ tick の v・B は最後の 1 つにまとめる', () => {
  const ctl = (mml: string, track = 0) =>
    parseMml(mml).tracks[track]!.events.map((e) => (e.type === 'volume' ? `v${e.volume}@${e.tick}` : e.type === 'bend' ? `B${e.cents}@${e.tick}` : `n@${e.tick}`));

  it('同じ tick の v は最後の 1 つだけ残る', () => {
    expect(ctl('A c v1 v2 v3 c')).toEqual(['n@0', 'v3@96', 'n@96']);
  });

  it('同じ tick の B も最後の 1 つだけ残る', () => {
    expect(ctl('A c B+10 B+20 B-30 c')).toEqual(['n@0', 'B-30@96', 'n@96']);
  });

  it('v B v B が交互でも、それぞれ最後の 1 つにまとまる', () => {
    expect(ctl('A c v1 B+1 v2 B+2 c')).toEqual(['n@0', 'v2@96', 'B2@96', 'n@96']);
  });

  it('tick が違えばまとめない', () => {
    expect(ctl('A c v1 r4 v2 c')).toEqual(['n@0', 'v1@96', 'v2@192', 'n@192']);
  });

  it('ノートの前後ではまとめない（ノートが tick を進める）', () => {
    expect(ctl('A v1 c v2 c')).toEqual(['v1@0', 'n@0', 'v2@96', 'n@96']);
  });

  it('[ ] の繰り返しで同じ tick に並んでも 1 つ', () => {
    const song = parseMml('A c [[v1]250]250 c');
    expect(song.errors).toEqual([]);
    expect(ctl('A c [[v1]250]250 c')).toEqual(['n@0', 'v1@96', 'n@96']);
  });

  it('L の前後の v：tick 0 の v5 L v6 は v6 だけ残る', () => {
    const song = parseMml('A v5 L v6 c');
    expect(ctl('A v5 L v6 c')).toEqual(['v6@0', 'n@0']);
    expect(song.loopStart).toBe(0);
  });

  it('エラーの命令は残さず、ドラムトラックの v は events に入れない', () => {
    expect(ctl('A c v1 v99 c')).toEqual(['n@0', 'v1@96', 'n@96']);
    expect(ctl('R bd v1 v2 bd')).toEqual(['n@0', 'n@96']);
  });
});

describe('parseMml: ドラムトラック R', () => {
  const drumEvents = (mml: string) => parseMml(mml).tracks[0].events;

  it('ドラム名が note イベントになる（program・tick・note 60・bend 0）', () => {
    const song = parseMml('R bd8 sd8 lt cp ch oh cy ht');
    expect(song.errors).toEqual([]);
    const events = song.tracks[0].events;
    expect(events.map((e) => e.type === 'note' && e.program)).toEqual([128, 129, 133, 135, 130, 131, 132, 134]);
    expect(events.map((e) => e.tick)).toEqual([0, 48, 96, 192, 288, 384, 480, 576]);
    expect(events[0]).toMatchObject({ type: 'note', note: 60, bend: 0, volume: 12, pan: 64 });
  });

  it('音長・付点・%N は音符と同じ', () => {
    const song = parseMml('R bd8. sd%10 ch');
    expect(song.errors).toEqual([]);
    expect(song.tracks[0].events.map((e) => e.tick)).toEqual([0, 72, 82]);
    expect(song.tracks[0].length).toBe(82 + 96);
  });

  it('v は volume イベントを出さず、次のドラムから効く', () => {
    const events = drumEvents('R l8 [bd ch]2 v8 sd');
    expect(events.some((e) => e.type === 'volume')).toBe(false);
    const notes = events.filter((e) => e.type === 'note');
    expect(notes.map((e) => e.volume)).toEqual([12, 12, 12, 12, 8]);
  });

  it('p・q・t・r・l が使える', () => {
    const song = parseMml('R p10 q4 t100 r4 l8 bd');
    expect(song.errors).toEqual([]);
    expect(song.tempos).toEqual([{ tick: 0, bpm: 100 }]);
    expect(song.tracks[0].events[0]).toMatchObject({ pan: 10, tick: 96, gate: 24 });
  });

  it.each([
    ['R c', [[1, 3]]],
    ['R b', [[1, 3]]],
    ['R bd&bd', [[1, 5]]],
    ['R @1 bd', [[1, 3]]],
    ['R o5 bd', [[1, 3]]],
    ['R B+10 bd', [[1, 3]]],
    ['R < bd', [[1, 3]]],
    ['R cx', [[1, 3]]],
  ])('%s のエラーは 1 命令 1 件', (mml, expected) => {
    expect(parseMml(mml).errors.map((e) => [e.line, e.column])).toEqual(expected);
  });

  it('エラーの後のドラムは読まれる', () => {
    const song = parseMml('R o5 bd @1 sd');
    expect(song.errors).toHaveLength(2);
    expect(song.tracks[0].events.map((e) => e.type === 'note' && e.program)).toEqual([128, 129]);
  });

  it('R L bd E は A L c E と同じに解析できる', () => {
    const drum = parseMml('R L bd E');
    const melody = parseMml('A L c E');
    expect(drum.errors).toEqual([]);
    expect([drum.loopStart, drum.loopEnd, drum.length]).toEqual([melody.loopStart, melody.loopEnd, melody.length]);
  });

  it('E より後のドラムはエラー、休符は通る', () => {
    const errors = parseMml('A L c c E\nR bd bd bd bd r4').errors;
    expect(errors.map((e) => [e.line, e.column])).toEqual([[2, 9], [2, 12]]);
    expect(errors[0].message).toContain("'bd'");
  });

  it('メロディのトラックの cd はドラム名にならず、音符 c と d', () => {
    expect(notes('A cd').map((e) => e.note)).toEqual([60, 62]);
  });
});

describe('parseMml: テンポの登録', () => {
  it('t を非常に多く書いても解析が終わる（tempos の登録が二乗にならない）', () => {
    const started = performance.now();
    const song = parseMml('A [[t120 r%1]250]255');
    expect(song.errors).toEqual([]);
    expect(song.tempos).toHaveLength(63750);
    expect(performance.now() - started).toBeLessThan(3000); // 同期の処理はタイムアウトで止まらないため、経過時間で確かめる
  });

  it('同じ tick に t を 2 回書くと、後の値が残る', () => {
    const song = parseMml('A t100 t150 c4 t90 t80');
    expect(song.errors).toEqual([]);
    expect(song.tempos).toEqual([{ tick: 0, bpm: 150 }, { tick: 96, bpm: 80 }]);
  });
});
