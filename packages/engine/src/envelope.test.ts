import { Envelope, attackSeconds, decayDbPerSec, effectiveRate } from './envelope';
import type { FmOperator } from './voiceData';

const SR = 1000;

const op = (overrides: Partial<FmOperator> = {}): FmOperator => ({
  wave: 0, mul: 1, dt: 0, tl: 0, ar: 15, dr: 0, sl: 0, sr: 0, rr: 15,
  ksl: 0, ksr: 0, fb: 0, am: 0, amDepth: 0, vib: 0, vibDepth: 0, xof: 0,
  ...overrides,
});

function run(env: Envelope, samples: number): number[] {
  return Array.from({ length: samples }, () => env.next());
}

describe('レートの表', () => {
  it('レート 15 で 16000 dB/秒、1 段ごとに半分、0 は変化しない', () => {
    expect(decayDbPerSec(15)).toBe(16000);
    expect(decayDbPerSec(14)).toBe(8000);
    expect(decayDbPerSec(0)).toBe(0);
  });

  it('アタック時間は 15 で 0、0 で無限', () => {
    expect(attackSeconds(15)).toBe(0);
    expect(attackSeconds(0)).toBe(Infinity);
    expect(attackSeconds(10)).toBeCloseTo(96 / 500 / 8, 9);
  });

  it('KSR は高い音ほど実効レートを上げ、0 と 15 を超えない', () => {
    expect(effectiveRate(10, 0, 84)).toBe(10);
    expect(effectiveRate(10, 1, 84)).toBe(11);
    expect(effectiveRate(10, 1, 48)).toBe(10);
    expect(effectiveRate(0, 1, 84)).toBe(0);
    expect(effectiveRate(15, 1, 127)).toBe(15);
  });
});

describe('Envelope', () => {
  it('キーオン前は無音で off', () => {
    const env = new Envelope(SR);
    expect(env.phase).toBe('off');
    expect(env.next()).toBe(96);
  });

  it('AR=15 は直ちに 0 dB', () => {
    const env = new Envelope(SR);
    env.keyOn(op({ ar: 15 }), 60);
    expect(env.next()).toBe(0);
  });

  it('AR=10 は単調に下がり、時間内に 0 dB へ届いてディケイに移る', () => {
    const env = new Envelope(SR);
    env.keyOn(op({ ar: 10 }), 60);
    const values = run(env, 100);
    for (let i = 1; i < values.length; i++) expect(values[i]!).toBeLessThanOrEqual(values[i - 1]!);
    expect(values[99]).toBe(0);
    expect(env.phase).toBe('sustain'); // SL=0 なので、ディケイは直ちに終わる
  });

  it('AR=0 はいつまでも鳴り始めない', () => {
    const env = new Envelope(SR);
    env.keyOn(op({ ar: 0 }), 60);
    expect(run(env, 1000).at(-1)).toBe(96);
    expect(env.phase).toBe('attack');
  });

  it('ディケイで SL まで下がり、SR=0 で保つ', () => {
    const env = new Envelope(SR);
    env.keyOn(op({ dr: 10, sl: 4, sr: 0 }), 60); // 0.5 dB/サンプルで 12 dB まで
    run(env, 50);
    expect(env.phase).toBe('sustain');
    expect(env.attenuation).toBe(12);
    expect(run(env, 1000).at(-1)).toBe(12);
  });

  it('SR>0 ならサステイン中も下がる', () => {
    const env = new Envelope(SR);
    env.keyOn(op({ dr: 15, sl: 1, sr: 5 }), 60);
    run(env, 10);
    const before = env.attenuation;
    run(env, 100);
    expect(env.attenuation).toBeGreaterThan(before);
  });

  it('SL=15 はディケイで無音まで下がって off になる', () => {
    const env = new Envelope(SR);
    env.keyOn(op({ dr: 15, sl: 15 }), 60);
    run(env, 100);
    expect(env.phase).toBe('off');
  });

  it('キーオフでリリースに移り、無音に達すると off', () => {
    const env = new Envelope(SR);
    env.keyOn(op({ rr: 10 }), 60);
    run(env, 10);
    env.keyOff();
    expect(env.phase).toBe('release');
    run(env, 300);
    expect(env.phase).toBe('off');
    expect(env.attenuation).toBe(96);
  });

  it('XOF=1 はキーオフを無視する', () => {
    const env = new Envelope(SR);
    env.keyOn(op({ xof: 1 }), 60);
    run(env, 10);
    env.keyOff();
    expect(env.phase).toBe('sustain');
  });

  it('鳴っている途中のキーオンは今の減衰量からアタックし直す', () => {
    const env = new Envelope(SR);
    env.keyOn(op({ rr: 5 }), 60);
    run(env, 10);
    env.keyOff();
    run(env, 200);
    const mid = env.attenuation;
    expect(mid).toBeGreaterThan(0);
    env.keyOn(op({ ar: 5 }), 60);
    expect(env.next()).toBeLessThanOrEqual(mid);
  });

  it('reset で直ちに無音の off に戻る', () => {
    const env = new Envelope(SR);
    env.keyOn(op(), 60);
    run(env, 10);
    env.reset();
    expect(env.phase).toBe('off');
    expect(env.next()).toBe(96);
  });
});
