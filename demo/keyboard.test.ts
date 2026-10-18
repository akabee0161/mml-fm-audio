import { MonoNoteTracker, PC_KEY_OFFSETS, isBlack, keyLayout, noteName, parseVoiceJson, shiftBase } from './keyboard';

describe('鍵盤の配置', () => {
  it('ノート名は MIDI の慣例（60 = C4）', () => {
    expect(noteName(60)).toBe('C4');
    expect(noteName(69)).toBe('A4');
    expect(noteName(61)).toBe('C#4');
  });

  it('黒鍵を判定する', () => {
    expect([60, 61, 62, 63, 64, 65, 66].map(isBlack)).toEqual([false, true, false, true, false, false, true]);
  });

  it('2 オクターブは 25 鍵（両端の C を含む）', () => {
    const keys = keyLayout(60, 2);
    expect(keys).toHaveLength(25);
    expect(keys[0]).toEqual({ note: 60, black: false, label: 'C4' });
    expect(keys.at(-1)?.note).toBe(84);
  });

  it('オクターブの切り替えは C1〜C7 に収める', () => {
    expect(shiftBase(60, 1)).toBe(72);
    expect(shiftBase(60, -1)).toBe(48);
    expect(shiftBase(96, 1)).toBe(96);
    expect(shiftBase(24, -1)).toBe(24);
  });

  it('PC キーボードは a〜k が白鍵、w e t y u が黒鍵', () => {
    expect(PC_KEY_OFFSETS).toEqual({ a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12 });
  });
});

describe('parseVoiceJson', () => {
  it('JSON の構文エラーを例外にせず返す', () => {
    const result = parseVoiceJson('{ "id": ');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.path).toBe('(JSON)');
  });

  it('構文が正しければ音色として検証する', () => {
    const result = parseVoiceJson('{"id": 0}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.path)).toContain('name');
  });
});

describe('MonoNoteTracker', () => {
  it('押した音を返し、最後に押した音を離したときだけキーオフする', () => {
    const t = new MonoNoteTracker();
    expect(t.press('a', 60)).toBe(60);
    expect(t.press('s', 62)).toBe(62);
    expect(t.release('a')).toBe(false); // 先に押したキーを離しても 62 は止めない
    expect(t.release('s')).toBe(true);
  });

  it('知らないキーを離しても何もしない', () => {
    const t = new MonoNoteTracker();
    expect(t.release('x')).toBe(false);
  });

  it('releaseAll: 鳴っている音があればキーオフし、なければ何もしない', () => {
    const t = new MonoNoteTracker();
    expect(t.releaseAll()).toBe(false); // まだ何も押していない
    t.press('a', 60);
    expect(t.releaseAll()).toBe(true);
    expect(t.releaseAll()).toBe(false); // 既に止めた後は何もしない
    expect(t.release('a')).toBe(false); // releaseAll 後は 'a' の release も無効
  });
});
