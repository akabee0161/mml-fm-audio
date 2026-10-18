import { readFileSync } from 'node:fs';
import { GM_ASSIGNMENTS, convertAll, parseToneData, toVoice } from './ymf825';

const TONEDATA = readFileSync(new URL('../voices/ymf825/tonedata.txt', import.meta.url), 'utf8');

const GRAND_PIANO = `Name: GrandPiano
Author: YAMAHA
0b,01,0f,07,00,06,0f,27,00,01,08,07,0e,03,02,03,02,28,00,05,00,00,0d,01,01,04,03,22,01,01,00,06,0d,02,02,06,04,00,01,01,00
`;

describe('parseToneData', () => {
  it('Name・Author・41 バイトを読む', () => {
    const [entry] = parseToneData(GRAND_PIANO);
    expect(entry?.name).toBe('GrandPiano');
    expect(entry?.author).toBe('YAMAHA');
    expect(entry?.bytes).toHaveLength(41);
    expect(entry?.bytes[0]).toBe(0x0b);
  });

  it('バイト数が違えば行番号つきで失敗する', () => {
    expect(() => parseToneData('Name: X\nAuthor: Y\n01,02\n')).toThrow('3 行目');
  });

  it('16 進数でない値や 7f を超える値で失敗する', () => {
    const bad = GRAND_PIANO.replace('0b,', 'zz,');
    expect(() => parseToneData(bad)).toThrow('3 行目');
    const over = GRAND_PIANO.replace('0b,', '80,');
    expect(() => parseToneData(over)).toThrow('3 行目');
  });

  it('3 行の並びでなければ失敗する', () => {
    expect(() => parseToneData('Author: Y\nName: X\n')).toThrow('1 行目');
  });
});

describe('toVoice', () => {
  it('GrandPiano の p0 と op1 を正しく読む', () => {
    const voice = toVoice(parseToneData(GRAND_PIANO)[0]!, 0);
    expect(voice).toMatchObject({ id: 0, name: 'GrandPiano', kind: 'fm', bo: 0, lfo: 1, alg: 3 });
    expect(voice.ops[0]).toEqual({
      wave: 8, mul: 1, dt: 0, tl: 39, ar: 15, dr: 7, sl: 15, sr: 0, rr: 6,
      ksl: 1, ksr: 0, fb: 0, am: 0, amDepth: 0, vib: 0, vibDepth: 0, xof: 0,
    });
    expect(voice.ops[1]).toMatchObject({ ksl: 3, ksr: 1, ar: 14, dr: 3, sr: 2, rr: 3, sl: 2, tl: 40, mul: 5, wave: 0 });
  });

  it('変調のビットを読む（0x44 は amDepth=2・vibDepth=2）', () => {
    const bytes = parseToneData(GRAND_PIANO)[0]!.bytes.slice();
    bytes[8] = 0x44 | 0x10 | 0x01;
    const voice = toVoice({ name: 'X', author: 'Y', bytes }, null);
    expect(voice.ops[0]).toMatchObject({ amDepth: 2, am: 1, vibDepth: 2, vib: 1 });
  });
});

describe('convertAll', () => {
  it('18 音色を 16 と 2 に分け、すべて検証を通る', () => {
    const { gm, unassigned } = convertAll(TONEDATA);
    expect(gm).toHaveLength(16);
    expect(gm.map((v) => v.id)).toEqual([...Object.values(GM_ASSIGNMENTS)].sort((a, b) => a - b));
    expect(unassigned.map((v) => v.name)).toEqual(['Rim Shot', 'Castanet']);
    expect(unassigned.every((v) => v.id === null)).toBe(true);
  });
});
