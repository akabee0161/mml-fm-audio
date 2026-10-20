import {
  PolyNoteTracker,
  PC_KEY_OFFSETS,
  isActivationKey,
  isAssistiveClick,
  isBlack,
  keyLayout,
  noteName,
  parseVoiceJson,
  shiftBase,
} from './keyboard';

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

describe('isActivationKey', () => {
  it('Enter と Space を鍵盤ボタンの有効化キーとみなす', () => {
    expect(isActivationKey('Enter')).toBe(true);
    expect(isActivationKey(' ')).toBe(true);
  });

  it('それ以外のキーは有効化キーではない', () => {
    expect(isActivationKey('a')).toBe(false);
    expect(isActivationKey('Tab')).toBe(false);
    expect(isActivationKey('Spacebar')).toBe(false);
  });
});

describe('isAssistiveClick', () => {
  it('detail が 0 なら支援技術による click とみなす', () => {
    expect(isAssistiveClick(0)).toBe(true);
  });

  it('detail が 1 以上ならマウス/タッチの click で、支援技術とはみなさない', () => {
    expect(isAssistiveClick(1)).toBe(false);
    expect(isAssistiveClick(2)).toBe(false);
  });
});

describe('PolyNoteTracker', () => {
  it('押しているキーごとに音の ID を覚え、離したキーの ID を返す', () => {
    const t = new PolyNoteTracker();
    expect(t.press('a')).toBe(true);
    t.bind('a', 1);
    expect(t.press('s')).toBe(true);
    t.bind('s', 2);
    expect(t.release('a')).toBe(1);
    expect(t.release('s')).toBe(2);
  });

  it('押したままのキーをもう一度押しても鳴らさない', () => {
    const t = new PolyNoteTracker();
    expect(t.press('a')).toBe(true);
    t.bind('a', 1);
    expect(t.press('a')).toBe(false);
    expect(t.release('a')).toBe(1);
    expect(t.press('a')).toBe(true); // 離した後は押せる
  });

  it('知らないキーを離しても何もしない', () => {
    const t = new PolyNoteTracker();
    expect(t.release('x')).toBeUndefined();
  });

  it('releaseAll は押している全キーの ID を返し、空にする', () => {
    const t = new PolyNoteTracker();
    expect(t.releaseAll()).toEqual([]);
    t.press('a');
    t.bind('a', 1);
    t.press('pointer:3');
    t.bind('pointer:3', 2);
    expect(t.releaseAll().sort()).toEqual([1, 2]);
    expect(t.releaseAll()).toEqual([]);
    expect(t.release('a')).toBeUndefined();
  });
});
