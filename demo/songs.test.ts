import { readFileSync } from 'node:fs';
import { parseMml } from '@mml-fm-audio/sequencer';

const source = readFileSync(new URL('./songs/m3-demo.mml', import.meta.url), 'utf8');

describe('m3-demo.mml', () => {
  const song = parseMml(source);

  it('エラーなく解析できる', () => {
    expect(song.errors).toEqual([]);
  });

  it('ループの位置と長さ', () => {
    expect(song.loopStart).toBe(768);
    expect(song.loopEnd).toBe(5376);
    expect(song.length).toBe(5472);
  });

  it('トラックは A, B, C1, C2, C3, R の 6 つで、A 以外の長さは 5376', () => {
    expect(song.tracks.map((t) => t.name)).toEqual(['A', 'B', 'C1', 'C2', 'C3', 'R']);
    for (const t of song.tracks) if (t.name !== 'A') expect(t.length).toBe(5376);
  });

  it('A にピッチベンドと音量のイベントがあり、テンポは 120 → 112', () => {
    const a = song.tracks.find((t) => t.name === 'A')!;
    expect(a.events.some((e) => e.type === 'bend')).toBe(true);
    expect(a.events.some((e) => e.type === 'volume')).toBe(true);
    expect(song.tempos).toEqual([
      { tick: 0, bpm: 120 },
      { tick: 4992, bpm: 112 },
    ]);
  });
});
