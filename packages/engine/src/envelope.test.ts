import { Envelope, attackSeconds, decayDbPerSec, rateIndex } from './envelope';
import { keyCode } from './tables';
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
  it('RR 6・ノート 60 の減衰の速さは KSR 0 で約 89.4 dB/秒、KSR 1 で約 250 dB/秒', () => {
    expect(decayDbPerSec(rateIndex(6, 0, keyCode(60, 0)))).toBeCloseTo(89.36, 1);
    expect(decayDbPerSec(rateIndex(6, 1, keyCode(60, 0)))).toBeCloseTo(250.2, 1);
  });

  it('AR 4・ノート 36・KSR 0 のアタックは約 0.386 秒', () => {
    expect(attackSeconds(rateIndex(4, 0, keyCode(36, 0)))).toBeCloseTo(0.3856, 4);
  });

  it('レート 0 は変化しない', () => {
    expect(rateIndex(0, 1, 31)).toBe(0);
    expect(decayDbPerSec(0)).toBe(0);
    expect(attackSeconds(0)).toBe(Infinity);
  });

  it('idx は 63 で頭打ち、60 以上のアタックは一瞬', () => {
    expect(rateIndex(15, 0, 0)).toBe(60);
    expect(attackSeconds(60)).toBe(0);
    expect(rateIndex(15, 1, 31)).toBe(63);
    expect(decayDbPerSec(63)).toBeCloseTo(36600 * 1.75, 6);
  });
});

describe('Envelope', () => {
  it('キーオン前は無音で off', () => {
    const env = new Envelope(SR);
    expect(env.phase).toBe('off');
    expect(env.next()).toBe(96);
  });

  it('オペレーター以外の、エンベロープの項目だけのオブジェクトでも鳴り、SR で下がって止まる', () => {
    const env = new Envelope(SR);
    env.keyOn({ ar: 15, dr: 15, sl: 4, sr: 10, rr: 15, ksr: 0, xof: 0 }, keyCode(60, 0));
    expect(env.phase).toBe('decay');
    run(env, 10);
    expect(env.phase).toBe('sustain');
    run(env, 10_000);
    expect(env.phase).toBe('off');
  });

  it('AR=15 は直ちに 0 dB', () => {
    const env = new Envelope(SR);
    env.keyOn(op({ ar: 15 }), keyCode(60, 0));
    expect(env.next()).toBe(0);
  });

  it('AR=10 は単調に下がり、時間内に 0 dB へ届いてディケイに移る', () => {
    const env = new Envelope(SR);
    env.keyOn(op({ ar: 10 }), keyCode(60, 0));
    const values = run(env, 100);
    for (let i = 1; i < values.length; i++) expect(values[i]!).toBeLessThanOrEqual(values[i - 1]!);
    expect(values[99]).toBe(0);
    expect(env.phase).toBe('sustain'); // SL=0 なので、ディケイは直ちに終わる
  });

  it('AR=0 はいつまでも鳴り始めない', () => {
    const env = new Envelope(SR);
    env.keyOn(op({ ar: 0 }), keyCode(60, 0));
    expect(run(env, 1000).at(-1)).toBe(96);
    expect(env.phase).toBe('attack');
  });

  it('ディケイで SL まで下がり、SR=0 で保つ', () => {
    const env = new Envelope(SR);
    env.keyOn(op({ dr: 10, sl: 4, sr: 0 }), keyCode(60, 0)); // 新しい式で DR 10・kc 15 は約 1.43 dB/サンプル（旧 0.5）。12 dB まで 9 サンプル
    run(env, 50);
    expect(env.phase).toBe('sustain');
    expect(env.attenuation).toBe(12);
    expect(run(env, 1000).at(-1)).toBe(12);
  });

  it('SR>0 ならサステイン中も下がる', () => {
    const env = new Envelope(SR);
    env.keyOn(op({ dr: 15, sl: 1, sr: 5 }), keyCode(60, 0));
    run(env, 10);
    const before = env.attenuation;
    run(env, 100);
    expect(env.attenuation).toBeGreaterThan(before);
  });

  it('SL=0 なら DR=0 と DR=1 の出力はサンプル単位で同じ', () => {
    for (const ar of [15, 10]) {
      const outputs = [0, 1].map((dr) => {
        const env = new Envelope(SR);
        env.keyOn(op({ ar, dr, sl: 0, sr: 8 }), keyCode(60, 0));
        return run(env, 3000);
      });
      expect(outputs[0]).toEqual(outputs[1]);
      expect(outputs[0]!.at(-1)).toBe(96);
    }
  });

  it('SL=15 はディケイで無音まで下がって off になる', () => {
    const env = new Envelope(SR);
    env.keyOn(op({ dr: 15, sl: 15 }), keyCode(60, 0));
    run(env, 100);
    expect(env.phase).toBe('off');
  });

  it('キーオフでリリースに移り、無音に達すると off', () => {
    const env = new Envelope(SR);
    env.keyOn(op({ rr: 10 }), keyCode(60, 0));
    run(env, 10);
    env.keyOff();
    expect(env.phase).toBe('release');
    run(env, 300);
    expect(env.phase).toBe('off');
    expect(env.attenuation).toBe(96);
  });

  it('XOF=1 はキーオフを無視する', () => {
    const env = new Envelope(SR);
    env.keyOn(op({ xof: 1 }), keyCode(60, 0));
    run(env, 10);
    env.keyOff();
    expect(env.phase).toBe('sustain');
  });

  it('鳴っている途中のキーオンは今の減衰量からアタックし直す', () => {
    const env = new Envelope(SR);
    env.keyOn(op({ rr: 5 }), keyCode(60, 0));
    run(env, 10);
    env.keyOff();
    run(env, 200);
    const mid = env.attenuation;
    expect(mid).toBeGreaterThan(0);
    env.keyOn(op({ ar: 5 }), keyCode(60, 0));
    expect(env.next()).toBeLessThanOrEqual(mid);
  });

  it('アタックは振幅が時間に比例して上がる', () => {
    const env = new Envelope(SR);
    env.keyOn(op({ ar: 4 }), 7);
    const seconds = attackSeconds(rateIndex(4, 0, 7));
    run(env, Math.round((seconds * SR) / 2));
    expect(10 ** (-env.attenuation / 20)).toBeCloseTo(0.5, 2);
    run(env, Math.ceil(seconds * SR));
    expect(env.phase).not.toBe('attack');
    expect(env.attenuation).toBe(0);
  });

  it('idx が 60 以上なら最初のサンプルから 0 dB', () => {
    const env = new Envelope(SR);
    env.keyOn(op({ ar: 15 }), 0);
    expect(env.next()).toBe(0);
  });

  it('途中のキーオンは今の振幅から上げる', () => {
    const env = new Envelope(SR);
    env.keyOn(op({ rr: 5 }), keyCode(60, 0));
    run(env, 10);
    env.keyOff();
    run(env, 200);
    const before = 10 ** (-env.attenuation / 20);
    expect(before).toBeLessThan(1);
    env.keyOn(op({ ar: 5 }), keyCode(60, 0));
    const after = 10 ** (-env.next() / 20);
    const slope = 1 / (attackSeconds(rateIndex(5, 0, keyCode(60, 0))) * SR);
    expect(after).toBeGreaterThanOrEqual(before);
    expect(after - before).toBeLessThanOrEqual(slope + 1e-9);
  });

  it('reset で直ちに無音の off に戻る', () => {
    const env = new Envelope(SR);
    env.keyOn(op(), keyCode(60, 0));
    run(env, 10);
    env.reset();
    expect(env.phase).toBe('off');
    expect(env.next()).toBe(96);
  });
});
