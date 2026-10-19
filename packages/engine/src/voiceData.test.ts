import { ALGORITHMS } from './algorithms';
import { CARRIERS, opCount, validateDrum, validateVoice, type FmOperator } from './voiceData';

const op = (overrides: Partial<FmOperator> = {}): FmOperator => ({
  wave: 0, mul: 1, dt: 0, tl: 0, ar: 15, dr: 0, sl: 0, sr: 0, rr: 15,
  ksl: 0, ksr: 0, fb: 0, am: 0, amDepth: 0, vib: 0, vibDepth: 0, xof: 0,
  ...overrides,
});

const voice = (overrides: Record<string, unknown> = {}) => ({
  id: 0, name: 'Test', kind: 'fm', bo: 0, alg: 4, lfo: 0,
  ops: [op(), op(), op(), op()],
  ...overrides,
});

describe('opCount', () => {
  it('alg 0〜1 は 2、2〜7 は 4', () => {
    expect(opCount(0)).toBe(2);
    expect(opCount(1)).toBe(2);
    expect(opCount(2)).toBe(4);
    expect(opCount(7)).toBe(4);
  });
});

describe('validateVoice', () => {
  it('正しい音色を受け付ける', () => {
    const result = validateVoice(voice());
    expect(result.ok).toBe(true);
  });

  it('id は null でもよい', () => {
    expect(validateVoice(voice({ id: null })).ok).toBe(true);
  });

  it('範囲外の値を項目名つきで報告する', () => {
    const result = validateVoice(voice({ ops: [op(), op(), op({ tl: 64 }), op()] }));
    expect(result).toEqual({
      ok: false,
      errors: [{ path: 'ops[2].tl', message: '0〜63 の整数を指定してください（値: 64）' }],
    });
  });

  it('整数でない値・文字列・欠けた項目を報告する', () => {
    const result = validateVoice(voice({ bo: 1.5, lfo: '1', ops: [op(), op(), op(), { ...op(), ar: undefined }] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.path)).toEqual(['bo', 'lfo', 'ops[3].ar']);
  });

  it('4 オペレーターのアルゴリズムで ops が足りないとエラー', () => {
    const result = validateVoice(voice({ alg: 3, ops: [op(), op()] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toEqual({ path: 'ops', message: 'アルゴリズム 3 には 4 個のオペレーターが必要です（2 個）' });
  });

  it('2 オペレーターのアルゴリズムでは余分な ops を無視する', () => {
    const result = validateVoice(voice({ alg: 1, ops: [op(), op(), op({ tl: 99 }), op()] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.voice.ops).toHaveLength(2);
  });

  it('kind と name を確かめる', () => {
    const result = validateVoice(voice({ kind: 'drum', name: '' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.path)).toEqual(['name', 'kind']);
  });

  it('オブジェクトでない入力を報告する', () => {
    expect(validateVoice(null)).toEqual({ ok: false, errors: [{ path: '', message: '音色はオブジェクトで指定してください' }] });
    expect(validateVoice([1, 2])).toEqual({ ok: false, errors: [{ path: '', message: '音色はオブジェクトで指定してください' }] });
  });

  it('ops が配列でない・要素がオブジェクトでない場合を報告する', () => {
    const notArray = validateVoice(voice({ ops: 'x' }));
    expect(notArray.ok).toBe(false);
    if (!notArray.ok) expect(notArray.errors[0]?.path).toBe('ops');
    const badItem = validateVoice(voice({ ops: [op(), 3, op(), op()] }));
    expect(badItem.ok).toBe(false);
    if (!badItem.ok) expect(badItem.errors[0]?.path).toBe('ops[1]');
  });

  it('成功時は余計な項目を落とした新しいオブジェクトを返す', () => {
    const result = validateVoice({ ...voice(), extra: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.voice)).toEqual(['id', 'name', 'kind', 'bo', 'alg', 'lfo', 'ops']);
  });
});

describe('validateDrum', () => {
  // ドラムの FM 部は鳴り終わる必要があるので、出力するオペレーターは sl=15 にしておく
  const drumFm = (alg = 0) => ({
    id: null, name: 'Body', kind: 'fm', bo: 0, alg, lfo: 0,
    ops: [op({ sl: 15 }), op({ sl: 15 }), op({ sl: 15 }), op({ sl: 15 })],
  });
  const bd = (overrides: Record<string, unknown> = {}) => ({
    id: 128, name: 'bd', kind: 'drum',
    fm: { voice: drumFm(), note: 36, level: 1 },
    pitch: { fromSemitone: 24, toSemitone: 0, decayMs: 40 },
    ...overrides,
  });
  const noise = (overrides: Record<string, unknown> = {}) => ({
    level: 0.5, ar: 15, dr: 12, sl: 15, rr: 12, color: 'white', ...overrides,
  });
  const paths = (input: unknown): string[] => {
    const result = validateDrum(input);
    return result.ok ? [] : result.errors.map((e) => e.path);
  };

  it('FM と音程の降下のドラムを受け付ける', () => {
    const result = validateDrum(bd());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.voice.fm?.voice.alg).toBe(0);
  });

  it('ノイズだけのドラムを受け付ける', () => {
    expect(validateDrum({ id: 130, name: 'ch', kind: 'drum', noise: noise() }).ok).toBe(true);
  });

  it('ノイズの repeat を受け付ける', () => {
    const cp = { id: 135, name: 'cp', kind: 'drum', noise: noise({ repeat: { count: 3, intervalMs: 12 } }) };
    expect(validateDrum(cp).ok).toBe(true);
  });

  it('FM もノイズもないとエラー', () => {
    expect(paths({ id: 128, name: 'x', kind: 'drum' })).toContain('');
  });

  it('FM がないのに pitch があるとエラー', () => {
    expect(paths({ id: 128, name: 'x', kind: 'drum', noise: noise(), pitch: { fromSemitone: 1, toSemitone: 0, decayMs: 10 } })).toContain('pitch');
  });

  it('id は 128〜255', () => {
    expect(paths(bd({ id: 127 }))).toContain('id');
    expect(paths(bd({ id: 256 }))).toContain('id');
  });

  it('kind は "drum"', () => {
    expect(paths(bd({ kind: 'fm' }))).toContain('kind');
  });

  it('ノイズの色は white のみ', () => {
    expect(paths({ id: 130, name: 'ch', kind: 'drum', noise: noise({ color: 'pink' }) })).toContain('noise.color');
  });

  it('ノイズの rr は 1 以上', () => {
    expect(paths({ id: 130, name: 'ch', kind: 'drum', noise: noise({ rr: 0 }) })).toContain('noise.rr');
  });

  it('repeat の範囲を検査する', () => {
    const p = paths({ id: 135, name: 'cp', kind: 'drum', noise: noise({ repeat: { count: 9, intervalMs: 0 } }) });
    expect(p).toContain('noise.repeat.count');
    expect(p).toContain('noise.repeat.intervalMs');
  });

  it('level は 0〜1', () => {
    expect(paths(bd({ fm: { voice: drumFm(), note: 36, level: 1.5 } }))).toContain('fm.level');
  });

  it('FM 部の音色のエラーは fm.voice. を前置する', () => {
    expect(paths(bd({ fm: { voice: { ...drumFm(), alg: 9 }, note: 36, level: 1 } }))).toContain('fm.voice.alg');
  });

  it('pitch の範囲を検査する', () => {
    const p = paths(bd({ pitch: { fromSemitone: 49, toSemitone: 0, decayMs: 0 } }));
    expect(p).toContain('pitch.fromSemitone');
    expect(p).toContain('pitch.decayMs');
  });

  it('出力するオペレーターが sl<15 かつ sr=0 だと鳴り終わらないのでエラー', () => {
    const v = drumFm(0);
    v.ops[1] = op({ sl: 3, sr: 0 });
    expect(paths(bd({ fm: { voice: v, note: 36, level: 1 } }))).toContain('fm.voice.ops[1].sr');
  });

  it('出力しないオペレーターは sl<15 かつ sr=0 でもよい', () => {
    const v = drumFm(0);
    v.ops[0] = op({ sl: 3, sr: 0 });
    expect(validateDrum(bd({ fm: { voice: v, note: 36, level: 1 } })).ok).toBe(true);
  });

  it('出力するオペレーターの表が ALGORITHMS と一致する', () => {
    ALGORITHMS.forEach((alg, i) => expect(CARRIERS[i]).toEqual(alg.carriers));
  });
});
