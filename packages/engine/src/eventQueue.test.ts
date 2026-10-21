import { EventQueue } from './eventQueue';

type Ev = { time: number; name: string };

describe('EventQueue', () => {
  it('ブロック内の時刻のものを、時刻順にブロック先頭からの位置つきで取り出す', () => {
    const q = new EventQueue<Ev>();
    q.push({ time: 150, name: 'b' });
    q.push({ time: 130, name: 'a' });
    q.push({ time: 300, name: 'c' });
    expect(q.takeDue(128, 128)).toEqual([
      { offset: 2, event: { time: 130, name: 'a' } },
      { offset: 22, event: { time: 150, name: 'b' } },
    ]);
    expect(q.size).toBe(1);
  });

  it('過去の時刻はブロック先頭（offset 0）で取り出す', () => {
    const q = new EventQueue<Ev>();
    q.push({ time: 10, name: 'late' });
    expect(q.takeDue(128, 128)).toEqual([{ offset: 0, event: { time: 10, name: 'late' } }]);
  });

  it('同じ時刻は入れた順を保つ', () => {
    const q = new EventQueue<Ev>();
    q.push({ time: 200, name: 'off' });
    q.push({ time: 200, name: 'on' });
    expect(q.takeDue(128, 128).map((d) => d.event.name)).toEqual(['off', 'on']);
  });

  it('ブロックの終わり以降は残す', () => {
    const q = new EventQueue<Ev>();
    q.push({ time: 256, name: 'next' });
    expect(q.takeDue(128, 128)).toEqual([]);
    expect(q.size).toBe(1);
  });

  it('小数の時刻でも offset は整数（切り捨て）', () => {
    const q = new EventQueue<Ev>();
    q.push({ time: 138.5, name: 'frac' });
    expect(q.takeDue(128, 128)).toEqual([{ offset: 10, event: { time: 138.5, name: 'frac' } }]);
  });

  it('takeDue は毎回同じ配列を使い回す（音声処理のスレッドでブロックごとにメモリーを確保しない）', () => {
    const q = new EventQueue<Ev>();
    const first = q.takeDue(0, 128);
    q.push({ time: 130, name: 'a' });
    const second = q.takeDue(128, 128);
    expect(second).toBe(first);
    expect(second).toEqual([{ offset: 2, event: { time: 130, name: 'a' } }]);
    expect(q.takeDue(256, 128)).toEqual([]);
  });

  it('removeWhere は合うものだけを捨て、残りの順番を保つ', () => {
    const q = new EventQueue<Ev>();
    q.push({ time: 130, name: 'a' });
    q.push({ time: 140, name: 'x' });
    q.push({ time: 150, name: 'b' });
    q.push({ time: 150, name: 'x' });
    q.push({ time: 160, name: 'c' });
    q.removeWhere((e) => e.name === 'x');
    expect(q.size).toBe(3);
    expect(q.takeDue(128, 128).map((d) => d.event.name)).toEqual(['a', 'b', 'c']);
  });
});
