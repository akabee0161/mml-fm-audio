import { VoiceGroups } from './voiceGroups';
import { SE_VOICES } from './voicePool';
import type { FmOperator, FmVoice } from './voiceData';

const SR = 48000;

const op = (overrides: Partial<FmOperator> = {}): FmOperator => ({
  wave: 0, mul: 1, dt: 0, tl: 0, ar: 15, dr: 0, sl: 0, sr: 0, rr: 15,
  ksl: 0, ksr: 0, fb: 0, am: 0, amDepth: 0, vib: 0, vibDepth: 0, xof: 0,
  ...overrides,
});

/** 鳴らし続ける音色（キーオフで rr=15 ですぐ止まる） */
const sustain: FmVoice = { id: 0, name: 'S', kind: 'fm', bo: 0, alg: 1, lfo: 0, ops: [op(), op({ tl: 63 })] };

function renderGroup(groups: VoiceGroups, group: 'bgm' | 'se', samples: number): Float32Array {
  const left = new Float32Array(samples);
  const right = new Float32Array(samples);
  groups.render(group, left, right, 0, samples);
  return left;
}

function peakOf(buffer: Float32Array): number {
  let peak = 0;
  for (const v of buffer) peak = Math.max(peak, Math.abs(v));
  return peak;
}

/** 両方の割り当てを十分な長さ進める */
function advance(groups: VoiceGroups, blocks: number): void {
  for (let i = 0; i < blocks; i++) {
    renderGroup(groups, 'bgm', 512);
    renderGroup(groups, 'se', 512);
  }
}

describe('VoiceGroups', () => {
  it('効果音用のボイスは 4', () => {
    expect(SE_VOICES).toBe(4);
  });

  it('効果音を 4 つ鳴らしても BGM の 16 ボイスは奪われない', () => {
    const groups = new VoiceGroups(SR);
    groups.register(0, sustain);
    for (let i = 0; i < 16; i++) expect(groups.noteOn('bgm', i + 1, 0, 48 + i, 64)).toBe(true);
    for (let i = 0; i < 5; i++) groups.noteOn('se', 100 + i, 0, 72, 64); // 5 つ目は効果音の最も古いものを奪う
    expect(groups.activeCount).toBe(20);
    expect(peakOf(renderGroup(groups, 'bgm', 256))).toBeGreaterThan(0);
  });

  it('効果音が 4 つを超えると、効果音のうち最も古く鳴らしたものを止める', () => {
    const groups = new VoiceGroups(SR);
    groups.register(0, sustain);
    for (let i = 0; i < 5; i++) groups.noteOn('se', 100 + i, 0, 72, 64);
    // 100 は奪われているので、音量を 0 にしても出力は変わらない
    groups.setVolume(100, 0);
    const kept = peakOf(renderGroup(groups, 'se', 512));
    expect(kept).toBeGreaterThan(0);
    // 101 は残っているので、音量を 0 にすると出力が小さくなる
    groups.setVolume(101, 0);
    advance(groups, 4);
    const lowered = peakOf(renderGroup(groups, 'se', 512));
    expect(lowered).toBeLessThan(kept);
  });

  it('noteOff・cancel は ID でどちらの割り当ての音にも効く', () => {
    const groups = new VoiceGroups(SR);
    groups.register(0, sustain);
    groups.noteOn('bgm', 1, 0, 60, 64);
    groups.noteOn('se', 2, 0, 72, 64);
    groups.noteOn('bgm', 3, 0, 62, 64);
    groups.noteOn('se', 4, 0, 74, 64);
    advance(groups, 1);
    expect(groups.activeCount).toBe(4);
    groups.cancel([1, 2]);
    advance(groups, 20);
    expect(groups.activeCount).toBe(2);
    groups.noteOff(3);
    groups.noteOff(4);
    advance(groups, 20);
    expect(groups.activeCount).toBe(0);
  });

  it('setVolume は ID でどちらの割り当ての音にも効く', () => {
    const groups = new VoiceGroups(SR);
    groups.register(0, sustain);
    groups.noteOn('bgm', 1, 0, 60, 64);
    groups.noteOn('se', 2, 0, 72, 64);
    const bgm = peakOf(renderGroup(groups, 'bgm', 512));
    const se = peakOf(renderGroup(groups, 'se', 512));
    groups.setVolume(1, 0);
    groups.setVolume(2, 0);
    advance(groups, 8);
    expect(peakOf(renderGroup(groups, 'bgm', 512))).toBeLessThan(bgm);
    expect(peakOf(renderGroup(groups, 'se', 512))).toBeLessThan(se);
  });

  it('render(group) はその割り当ての音だけを足し込む', () => {
    const groups = new VoiceGroups(SR);
    groups.register(0, sustain);
    groups.noteOn('bgm', 1, 0, 60, 64);
    expect(peakOf(renderGroup(groups, 'se', 256))).toBe(0);
    expect(peakOf(renderGroup(groups, 'bgm', 256))).toBeGreaterThan(0);
  });

  it('silence(group) はその割り当ての音だけを即座に無音にする（キーオフのリリースを待たない）', () => {
    const groups = new VoiceGroups(SR);
    groups.register(0, sustain);
    groups.noteOn('bgm', 1, 0, 60, 64);
    groups.noteOn('bgm', 2, 0, 64, 64);
    groups.noteOn('se', 3, 0, 72, 64);
    advance(groups, 1);
    groups.silence('bgm');
    expect(peakOf(renderGroup(groups, 'bgm', 256))).toBe(0);
    expect(peakOf(renderGroup(groups, 'se', 256))).toBeGreaterThan(0);
    expect(groups.activeCount).toBe(1);
    // 止めたボイスは次の noteOn で使える
    expect(groups.noteOn('bgm', 4, 0, 60, 64)).toBe(true);
    expect(peakOf(renderGroup(groups, 'bgm', 256))).toBeGreaterThan(0);
  });

  it('silence の group が bgm・se 以外なら RangeError', () => {
    const groups = new VoiceGroups(SR);
    expect(() => groups.silence('x' as never)).toThrow(RangeError);
  });

  it('未登録の program は鳴らさず false', () => {
    const groups = new VoiceGroups(SR);
    expect(groups.noteOn('se', 1, 9, 60, 64)).toBe(false);
  });
});
