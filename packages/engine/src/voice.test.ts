import { ALGORITHMS } from './algorithms';
import { panGains } from './output';
import { Voice } from './voice';
import type { AnyVoice, DrumVoice, FmOperator, FmVoice } from './voiceData';

const SR = 48000;
const CENTER = panGains(64)[0];

const op = (overrides: Partial<FmOperator> = {}): FmOperator => ({
  wave: 0, mul: 1, dt: 0, tl: 0, ar: 15, dr: 0, sl: 0, sr: 0, rr: 15,
  ksl: 0, ksr: 0, fb: 0, am: 0, amDepth: 0, vib: 0, vibDepth: 0, xof: 0,
  ...overrides,
});

const fmVoice = (alg: number, ops: FmOperator[]): FmVoice => ({ id: null, name: 'T', kind: 'fm', bo: 0, alg, lfo: 0, ops });

/** 鳴り終わる FM 部（alg 1 の op1 だけを鳴らす） */
const drumBody = (): FmVoice => fmVoice(1, [op({ sl: 15, dr: 8 }), op({ tl: 63, sl: 15, dr: 8 })]);

const drum = (overrides: Partial<DrumVoice> = {}): DrumVoice => ({ id: 128, name: 'd', kind: 'drum', ...overrides });

interface Stereo {
  left: Float32Array;
  right: Float32Array;
}

function renderStereo(timbre: AnyVoice, note: number, samples: number, pan = 64): Stereo {
  const v = new Voice(SR);
  v.noteOn(timbre, note, pan);
  const left = new Float32Array(samples);
  const right = new Float32Array(samples);
  v.render(left, right, 0, samples, new Float32Array(samples));
  return { left, right };
}

/** 中央に置いた音の左チャンネルを、パンの係数で割って M1 と同じ大きさに戻す */
function play(timbre: AnyVoice, note: number, samples: number): Float32Array {
  return renderStereo(timbre, note, samples).left.map((x) => x / CENTER);
}

const peak = (buf: Float32Array, from = 0, to = buf.length): number => {
  let m = 0;
  for (let i = from; i < to; i++) m = Math.max(m, Math.abs(buf[i]!));
  return m;
};

function risingZeroCrossings(buf: Float32Array, from = 0, to = buf.length): number {
  let count = 0;
  for (let i = Math.max(1, from); i < to; i++) if (buf[i - 1]! < 0 && buf[i]! >= 0) count++;
  return count;
}

describe('ALGORITHMS', () => {
  it('8 種あり、変調元は常に自分より前のオペレーター', () => {
    expect(ALGORITHMS).toHaveLength(8);
    for (const alg of ALGORITHMS) {
      alg.modulators.forEach((mods, i) => mods.forEach((m) => expect(m).toBeLessThan(i)));
    }
  });
});

describe('Voice', () => {
  it('鳴らす前は無音で、active は false', () => {
    const v = new Voice(SR);
    const left = new Float32Array(100);
    const right = new Float32Array(100);
    v.render(left, right, 0, 100, new Float32Array(100));
    expect(peak(left) + peak(right)).toBe(0);
    expect(v.active).toBe(false);
  });

  it('サインの搬送波 1 つで、ノート 69 は約 440 Hz', () => {
    const out = play(fmVoice(1, [op(), op({ tl: 63 })]), 69, SR);
    expect(risingZeroCrossings(out)).toBeGreaterThanOrEqual(438);
    expect(risingZeroCrossings(out)).toBeLessThanOrEqual(442);
  });

  it('TL=0 の搬送波は OUTPUT_GAIN 程度の大きさで鳴る', () => {
    const out = play(fmVoice(1, [op(), op({ tl: 63 })]), 69, 4800);
    expect(peak(out)).toBeGreaterThan(0.2);
    expect(peak(out)).toBeLessThanOrEqual(0.26);
  });

  it('alg 0 は op2 だけが出力する：op2 の TL=63 でほぼ無音', () => {
    expect(peak(play(fmVoice(0, [op(), op({ tl: 63 })]), 69, 4800))).toBeLessThan(0.01);
    expect(peak(play(fmVoice(0, [op({ tl: 63 }), op()]), 69, 4800))).toBeGreaterThan(0.2);
  });

  it('alg 4 は op4 だけが出力する', () => {
    expect(peak(play(fmVoice(4, [op(), op(), op(), op({ tl: 63 })]), 69, 4800))).toBeLessThan(0.01);
  });

  it('alg 5 は op2 と op4 が出力する', () => {
    const silentCarriers = [op(), op({ tl: 63 }), op(), op({ tl: 63 })];
    expect(peak(play(fmVoice(5, silentCarriers), 69, 4800))).toBeLessThan(0.01);
  });

  // spec §3.6 の「出力するオペレーター」（0 始まりの添字）
  it.each([
    [1, [0, 1]],
    [2, [0, 1, 2, 3]],
    [3, [3]],
    [6, [0, 3]],
    [7, [0, 2, 3]],
  ])('alg %i の出力するオペレーターは %j', (alg, carriers) => {
    const count = alg <= 1 ? 2 : 4;
    const indices = [...Array(count).keys()];
    const build = (silent: (i: number) => boolean) =>
      fmVoice(alg, indices.map((i) => op({ tl: silent(i) ? 63 : 0 })));

    // 出力するものをすべて止めると無音
    expect(peak(play(build((i) => carriers.includes(i)), 69, 4800))).toBeLessThan(0.01);
    // 出力しないものをすべて止めても鳴る
    expect(peak(play(build((i) => !carriers.includes(i)), 69, 4800))).toBeGreaterThan(0.05);
    // 出力するもののうち 1 つだけを鳴らしても鳴る
    for (const c of carriers) {
      expect(peak(play(build((i) => i !== c), 69, 4800))).toBeGreaterThan(0.05);
    }
  });

  it('変調をかけると波形が変わる（alg 0 の op1 を TL=0 にする）', () => {
    const plain = play(fmVoice(0, [op({ tl: 63 }), op()]), 69, 480);
    const modulated = play(fmVoice(0, [op(), op()]), 69, 480);
    let diff = 0;
    for (let i = 0; i < plain.length; i++) diff = Math.max(diff, Math.abs(plain[i]! - modulated[i]!));
    expect(diff).toBeGreaterThan(0.05);
  });

  it('キーオフ後はリリースを経て止まり、何も足さない', () => {
    const v = new Voice(SR);
    v.noteOn(fmVoice(1, [op({ rr: 15 }), op({ rr: 15 })]), 69, 64);
    const left = new Float32Array(1000);
    const right = new Float32Array(1000);
    const lfo = new Float32Array(1000);
    v.render(left, right, 0, 1000, lfo);
    v.noteOff();
    v.render(left, right, 0, 1000, lfo);
    expect(v.active).toBe(false);
    left.fill(0.5);
    v.render(left, right, 0, 1000, lfo);
    expect(left.every((x) => x === 0.5)).toBe(true);
  });

  it('render は指定した範囲に足し込み、範囲外は変えない', () => {
    const v = new Voice(SR);
    v.noteOn(fmVoice(1, [op(), op()]), 69, 64);
    const left = new Float32Array(100).fill(0.5);
    const right = new Float32Array(100).fill(0.5);
    const solo = renderStereo(fmVoice(1, [op(), op()]), 69, 10);
    v.render(left, right, 10, 20, new Float32Array(100));
    expect(left[9]).toBe(0.5);
    expect(left[20]).toBe(0.5);
    for (let i = 0; i < 10; i++) expect(left[10 + i]).toBeCloseTo(0.5 + solo.left[i]!, 6);
  });

  it('パン 0 は右が無音、127 は左が無音', () => {
    const timbre = fmVoice(1, [op(), op({ tl: 63 })]);
    const hardLeft = renderStereo(timbre, 69, 4800, 0);
    expect(peak(hardLeft.left)).toBeGreaterThan(0.2);
    expect(peak(hardLeft.right)).toBeLessThan(1e-6);
    const hardRight = renderStereo(timbre, 69, 4800, 127);
    expect(peak(hardRight.left)).toBeLessThan(1e-6);
    expect(peak(hardRight.right)).toBeGreaterThan(0.2);
  });

  it('鳴っている最中にオペレーター数の違う音色で鳴らし直しても、例外なく鳴る', () => {
    const v = new Voice(SR);
    const left = new Float32Array(100);
    const right = new Float32Array(100);
    const lfo = new Float32Array(100);
    v.noteOn(fmVoice(1, [op(), op()]), 69, 64);
    v.render(left, right, 0, 100, lfo);
    v.noteOn(fmVoice(4, [op(), op(), op(), op()]), 69, 64);
    left.fill(0);
    expect(() => v.render(left, right, 0, 100, lfo)).not.toThrow();
    expect(peak(left)).toBeGreaterThan(0);
  });

  it('stop ですぐに止まる', () => {
    const v = new Voice(SR);
    v.noteOn(fmVoice(1, [op(), op()]), 69, 64);
    expect(v.active).toBe(true);
    v.stop();
    expect(v.active).toBe(false);
  });

  it('帰還（fb=7）は op1 の波形を変える', () => {
    const plain = play(fmVoice(1, [op(), op({ tl: 63 })]), 69, 480);
    const fed = play(fmVoice(1, [op({ fb: 7 }), op({ tl: 63 })]), 69, 480);
    let diff = 0;
    for (let i = 0; i < plain.length; i++) diff = Math.max(diff, Math.abs(plain[i]! - fed[i]!));
    expect(diff).toBeGreaterThan(0.05);
  });

  it('op2 の fb は無視する', () => {
    const plain = play(fmVoice(1, [op({ tl: 63 }), op()]), 69, 480);
    const fed = play(fmVoice(1, [op({ tl: 63 }), op({ fb: 7 })]), 69, 480);
    expect(Array.from(fed)).toEqual(Array.from(plain));
  });
});

describe('Voice（ドラム）', () => {
  const noise = { level: 1, ar: 15, dr: 13, sl: 15, rr: 13, color: 'white' as const };

  it('noteOff を無視し、エンベロープが尽きると止まる', () => {
    const v = new Voice(SR);
    v.noteOn(drum({ fm: { voice: drumBody(), note: 36, level: 1 }, noise }), 60, 64);
    v.noteOff();
    const n = SR * 2;
    const left = new Float32Array(n);
    const right = new Float32Array(n);
    v.render(left, right, 0, 100, new Float32Array(n));
    expect(v.active).toBe(true); // noteOff で止まっていない
    v.render(left, right, 100, n, new Float32Array(n));
    expect(v.active).toBe(false);
  });

  it('noteOn の note ではなく fm.note の高さで鳴る', () => {
    const out = play(drum({ fm: { voice: fmVoice(1, [op({ sl: 15, dr: 1 }), op({ tl: 63, sl: 15, dr: 1 })]), note: 69, level: 1 } }), 30, 4800);
    const crossings = risingZeroCrossings(out);
    expect(crossings).toBeGreaterThanOrEqual(43); // 0.1 秒で約 44 回
    expect(crossings).toBeLessThanOrEqual(45);
  });

  it('pitch があると、鳴り始めが高い', () => {
    const fm = { voice: drumBody(), note: 48, level: 1 };
    const plain = play(drum({ fm }), 60, 4800);
    const swept = play(drum({ fm, pitch: { fromSemitone: 24, toSemitone: 0, decayMs: 40 } }), 60, 4800);
    expect(risingZeroCrossings(swept, 0, 480)).toBeGreaterThan(risingZeroCrossings(plain, 0, 480) + 2);
  });

  it('pitch は toSemitone に近づく', () => {
    const fm = { voice: fmVoice(1, [op({ sl: 15, dr: 1 }), op({ tl: 63, sl: 15, dr: 1 })]), note: 69, level: 1 };
    const swept = play(drum({ fm, pitch: { fromSemitone: 12, toSemitone: 0, decayMs: 5 } }), 60, SR);
    // 0.5〜1 秒の区間は 440 Hz（220 回前後）
    const crossings = risingZeroCrossings(swept, SR / 2, SR);
    expect(crossings).toBeGreaterThanOrEqual(218);
    expect(crossings).toBeLessThanOrEqual(222);
  });

  it('ノイズだけのドラムが鳴る', () => {
    expect(peak(play(drum({ noise }), 60, 480))).toBeGreaterThan(0.05);
  });

  it('fm.level が 0 なら FM 部は聞こえない', () => {
    expect(peak(play(drum({ fm: { voice: drumBody(), note: 48, level: 0 } }), 60, 480))).toBe(0);
  });

  it('repeat でノイズのエンベロープがかけ直される', () => {
    const ms = SR / 1000;
    const out = play(drum({ noise: { ...noise, dr: 15, repeat: { count: 3, intervalMs: 10 } } }), 60, 40 * ms);
    for (const start of [0, 10, 20]) {
      expect(peak(out, start * ms, (start + 2) * ms)).toBeGreaterThan(0.05);
      expect(peak(out, (start + 8) * ms, (start + 10) * ms)).toBeLessThan(0.01);
    }
    expect(peak(out, 30 * ms, 40 * ms)).toBeLessThan(0.01); // 3 回で終わる
  });
});
