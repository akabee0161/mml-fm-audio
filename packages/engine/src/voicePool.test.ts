import { MAX_VOICES, VoicePool } from './voicePool';
import type { DrumVoice, FmOperator, FmVoice } from './voiceData';

const SR = 48000;

const op = (overrides: Partial<FmOperator> = {}): FmOperator => ({
  wave: 0, mul: 1, dt: 0, tl: 0, ar: 15, dr: 0, sl: 0, sr: 0, rr: 15,
  ksl: 0, ksr: 0, fb: 0, am: 0, amDepth: 0, vib: 0, vibDepth: 0, xof: 0,
  ...overrides,
});

/** 鳴らし続ける音色（キーオフで rr=15 ですぐ止まる） */
const sustain: FmVoice = { id: 0, name: 'S', kind: 'fm', bo: 0, alg: 1, lfo: 0, ops: [op(), op({ tl: 63 })] };
/** 1 オクターブ上で鳴る、区別用の音色 */
const octaveUp: FmVoice = { ...sustain, name: 'O', ops: [op({ mul: 2 }), op({ tl: 63 })] };
const shortNoise: DrumVoice = {
  id: 130, name: 'ch', kind: 'drum',
  noise: { level: 1, ar: 15, dr: 13, sl: 15, rr: 13, color: 'white' },
};

function render(pool: VoicePool, samples: number): { left: Float32Array; right: Float32Array } {
  const left = new Float32Array(samples);
  const right = new Float32Array(samples);
  pool.render(left, right, 0, samples);
  return { left, right };
}

describe('VoicePool', () => {
  it('同時発音数は 16', () => {
    expect(MAX_VOICES).toBe(16);
  });

  it('16 音まで同時に鳴る', () => {
    const pool = new VoicePool(SR);
    pool.register(0, sustain);
    for (let id = 1; id <= 16; id++) expect(pool.noteOn(id, 0, 48 + id, 64)).toBe(true);
    expect(pool.activeCount).toBe(16);
  });

  it('17 音目では最も古い音を止めて使う', () => {
    const pool = new VoicePool(SR);
    pool.register(0, sustain);
    for (let id = 1; id <= 17; id++) pool.noteOn(id, 0, 48 + id, 64);
    expect(pool.activeCount).toBe(16);
    // id 1 はもうない。noteOff(1) は何も止めない
    pool.noteOff(1);
    render(pool, 2000);
    expect(pool.activeCount).toBe(16);
    // id 2 は残っていて、noteOff で止まる
    pool.noteOff(2);
    render(pool, 2000);
    expect(pool.activeCount).toBe(15);
  });

  it('奪われた ID の noteOff は、そのボイスの新しい音を止めない', () => {
    const pool = new VoicePool(SR, 1);
    pool.register(0, sustain);
    pool.noteOn(1, 0, 60, 64);
    pool.noteOn(2, 0, 62, 64);
    pool.noteOff(1);
    render(pool, 2000);
    expect(pool.activeCount).toBe(1);
  });

  it('鳴り終えたボイスを使い回し、鳴っている音は奪わない', () => {
    const pool = new VoicePool(SR, 2);
    pool.register(0, sustain);
    pool.noteOn(1, 0, 60, 64);
    pool.noteOn(2, 0, 62, 64);
    pool.noteOff(1);
    render(pool, 2000);
    pool.noteOn(3, 0, 64, 64);
    // 奪いが起きていれば id 2 が止まっていて、noteOff(2) しても数が変わらない
    pool.noteOff(2);
    render(pool, 2000);
    expect(pool.activeCount).toBe(1);
  });

  it('未登録の program は false で、鳴らない', () => {
    const pool = new VoicePool(SR);
    expect(pool.noteOn(1, 5, 60, 64)).toBe(false);
    expect(pool.activeCount).toBe(0);
  });

  it('登録し直しても、鳴っている音は前の音色のまま', () => {
    const before = new VoicePool(SR);
    before.register(0, sustain);
    before.noteOn(1, 0, 60, 64);
    const expected = render(before, 480).left;

    const pool = new VoicePool(SR);
    pool.register(0, sustain);
    pool.noteOn(1, 0, 60, 64);
    pool.register(0, octaveUp);
    expect(Array.from(render(pool, 480).left)).toEqual(Array.from(expected));
  });

  it('ドラムを 125 ms ごとに 100 回鳴らしても、ボイスが溜まらない', () => {
    const pool = new VoicePool(SR);
    pool.register(130, shortNoise);
    const step = SR / 8;
    for (let id = 1; id <= 100; id++) {
      expect(pool.activeCount).toBeLessThanOrEqual(1);
      pool.noteOn(id, 130, 60, 64);
      render(pool, step);
    }
  });

  it('noteOff はドラムを止めない', () => {
    const pool = new VoicePool(SR);
    pool.register(130, shortNoise);
    pool.noteOn(1, 130, 60, 64);
    pool.noteOff(1);
    expect(pool.activeCount).toBe(1);
  });

  it('16 音の和を例外なく足し込み、値は有限', () => {
    const pool = new VoicePool(SR);
    pool.register(0, sustain);
    for (let id = 1; id <= 16; id++) pool.noteOn(id, 0, 40 + id * 2, id * 8 - 1);
    const { left, right } = render(pool, 4800);
    expect([...left, ...right].every(Number.isFinite)).toBe(true);
    expect(Math.max(...left.map(Math.abs))).toBeGreaterThan(0.1);
  });

  it('LFO は 1 系統で、ボイス数によらず 1 サンプルに 1 回進む', () => {
    // ビブラートの音色を 1 音と 2 音で鳴らし、1 音目の波形が同じであることを確かめる
    const vib: FmVoice = { ...sustain, lfo: 3, ops: [op({ vib: 1, vibDepth: 3 }), op({ tl: 63 })] };
    const one = new VoicePool(SR);
    one.register(0, vib);
    one.noteOn(1, 0, 60, 0);
    const two = new VoicePool(SR);
    two.register(0, vib);
    two.noteOn(1, 0, 60, 0);
    two.noteOn(2, 0, 72, 127);
    expect(Array.from(render(two, 4800).left)).toEqual(Array.from(render(one, 4800).left));
  });

  it('setPitchBend・setVolume は奪われた ID では何もしない', () => {
    const make = (): VoicePool => {
      const pool = new VoicePool(SR);
      pool.register(0, sustain);
      for (let id = 1; id <= 17; id++) pool.noteOn(id, 0, 48 + id, 64);
      return pool;
    };
    const expected = render(make(), 480).left;
    const pool = make();
    pool.setVolume(1, 0);
    pool.setPitchBend(1, 1200);
    expect(Array.from(render(pool, 480).left)).toEqual(Array.from(expected));
  });

  it('setVolume は該当する ID の音量を変える', () => {
    const pool = new VoicePool(SR);
    pool.register(0, sustain);
    pool.noteOn(1, 0, 60, 64);
    pool.setVolume(1, 0);
    expect(Math.max(...render(pool, 480).left.map(Math.abs))).toBe(0);
  });

  it('cancel はその ID の音をキーオフする', () => {
    const pool = new VoicePool(SR);
    pool.register(0, sustain);
    pool.noteOn(1, 0, 60, 64);
    pool.noteOn(2, 0, 64, 64);
    pool.cancel([2, 99]);
    render(pool, 4000);
    expect(pool.activeCount).toBe(1);
  });
});
