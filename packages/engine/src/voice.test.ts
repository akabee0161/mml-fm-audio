import { ALGORITHMS } from './algorithms';
import { Lfo } from './lfo';
import { Voice } from './voice';
import type { FmOperator, FmVoice } from './voiceData';

const SR = 48000;

const op = (overrides: Partial<FmOperator> = {}): FmOperator => ({
  wave: 0, mul: 1, dt: 0, tl: 0, ar: 15, dr: 0, sl: 0, sr: 0, rr: 15,
  ksl: 0, ksr: 0, fb: 0, am: 0, amDepth: 0, vib: 0, vibDepth: 0, xof: 0,
  ...overrides,
});

const fmVoice = (alg: number, ops: FmOperator[]): FmVoice => ({ id: null, name: 'T', kind: 'fm', bo: 0, alg, lfo: 0, ops });

function play(voice: FmVoice, note: number, samples: number): Float32Array {
  const v = new Voice(SR);
  const lfo = new Lfo(SR);
  v.setVoice(voice);
  v.noteOn(note);
  const out = new Float32Array(samples);
  v.render(out, 0, samples, lfo);
  return out;
}

const peak = (buf: Float32Array): number => buf.reduce((m, x) => Math.max(m, Math.abs(x)), 0);

function risingZeroCrossings(buf: Float32Array): number {
  let count = 0;
  for (let i = 1; i < buf.length; i++) if (buf[i - 1]! < 0 && buf[i]! >= 0) count++;
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
  it('音色がなければ無音', () => {
    const v = new Voice(SR);
    v.noteOn(69);
    const out = new Float32Array(100).fill(1);
    v.render(out, 0, 100, new Lfo(SR));
    expect(peak(out)).toBe(0);
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

  it('変調をかけると波形が変わる（alg 0 の op1 を TL=0 にする）', () => {
    const plain = play(fmVoice(0, [op({ tl: 63 }), op()]), 69, 480);
    const modulated = play(fmVoice(0, [op(), op()]), 69, 480);
    let diff = 0;
    for (let i = 0; i < plain.length; i++) diff = Math.max(diff, Math.abs(plain[i]! - modulated[i]!));
    expect(diff).toBeGreaterThan(0.05);
  });

  it('キーオフ後はリリースを経て止まり、0 を書く', () => {
    const v = new Voice(SR);
    const lfo = new Lfo(SR);
    v.setVoice(fmVoice(1, [op({ rr: 15 }), op({ rr: 15 })]));
    v.noteOn(69);
    const out = new Float32Array(1000);
    v.render(out, 0, 1000, lfo);
    v.noteOff();
    v.render(out, 0, 1000, lfo);
    expect(v.active).toBe(false);
    out.fill(1);
    v.render(out, 0, 1000, lfo);
    expect(peak(out)).toBe(0);
  });

  it('render は指定した範囲だけに書く', () => {
    const v = new Voice(SR);
    v.setVoice(fmVoice(1, [op(), op()]));
    v.noteOn(69);
    const out = new Float32Array(100).fill(9);
    v.render(out, 10, 20, new Lfo(SR));
    expect(out[9]).toBe(9);
    expect(out[20]).toBe(9);
    expect(out[15]).not.toBe(9);
  });

  it('鳴っている最中にオペレーター数の違う音色へ切り替えると、例外なく音が止まる', () => {
    const v = new Voice(SR);
    const lfo = new Lfo(SR);
    v.setVoice(fmVoice(1, [op(), op()]));
    v.noteOn(69);
    const out = new Float32Array(100);
    v.render(out, 0, 100, lfo);
    v.setVoice(fmVoice(4, [op(), op(), op(), op()]));
    expect(v.active).toBe(false);
    expect(() => v.render(out, 0, 100, lfo)).not.toThrow();
    v.noteOn(69);
    v.render(out, 0, 100, lfo);
    expect(peak(out)).toBeGreaterThan(0);
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
