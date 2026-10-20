import { LoadMeter } from './loadMeter';

describe('LoadMeter', () => {
  const blockMs = (128 / 48000) * 1000;

  it('音声で 1 秒分（48000 Hz・128 フレームで 375 ブロック）たまったら集計を返す', () => {
    const meter = new LoadMeter(48000, 'performance');
    for (let i = 0; i < 374; i++) expect(meter.record(i % 2 === 0 ? 0.5 : 1.5, 128, i % 17)).toBeNull();
    const report = meter.record(1, 128, 3);
    expect(report).not.toBeNull();
    expect(report!.avgMs).toBeCloseTo(1, 2);
    expect(report!.maxMs).toBe(1.5);
    expect(report!.blockMs).toBeCloseTo(blockMs, 6);
    expect(report!.percent).toBeCloseTo((report!.avgMs / blockMs) * 100, 6);
    expect(report!.maxVoices).toBe(16);
    expect(report!.clock).toBe('performance');
  });

  it('返した後は数え直す', () => {
    const meter = new LoadMeter(48000, 'performance');
    for (let i = 0; i < 375; i++) meter.record(5, 128, 16);
    for (let i = 0; i < 374; i++) expect(meter.record(1, 128, 1)).toBeNull();
    const report = meter.record(1, 128, 1)!;
    expect(report.avgMs).toBe(1);
    expect(report.maxMs).toBe(1);
    expect(report.maxVoices).toBe(1);
  });

  it('Date の時計では最大を出さない（1 ms 刻みでは意味がないため）', () => {
    const meter = new LoadMeter(48000, 'date');
    let report = null;
    for (let i = 0; i < 375; i++) report = meter.record(i === 0 ? 1 : 0, 128, 0);
    expect(report!.maxMs).toBeNull();
    expect(report!.clock).toBe('date');
  });
});

describe('LoadMeter.reset', () => {
  it('途中までの集計を捨てて数え直す', () => {
    const meter = new LoadMeter(48000, 'performance');
    for (let i = 0; i < 200; i++) meter.record(9, 128, 16);
    meter.reset();
    for (let i = 0; i < 374; i++) expect(meter.record(1, 128, 2)).toBeNull();
    const report = meter.record(1, 128, 2)!;
    expect(report.maxMs).toBe(1);
    expect(report.maxVoices).toBe(2);
  });
});
