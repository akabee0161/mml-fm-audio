import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseMml } from '../../sequencer/src/index.ts';
import { runCli } from './cli.ts';
import type { SmfEvent } from './smf.ts';
import { buildSmf } from './smfBuilder.ts';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const Q = 480;

const NOTE: SmfEvent[] = [
  { kind: 'noteOn', tick: 0, channel: 0, note: 60, velocity: 100 },
  { kind: 'noteOff', tick: Q, channel: 0, note: 60 },
];
const smfBytes = (extra: SmfEvent[] = []) => buildSmf({ ticksPerQuarter: Q, tracks: [[...extra, ...NOTE]] });

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'conv-cli-test-'));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function run(args: string[]) {
  let out = '';
  let err = '';
  const code = runCli(args, { cwd: work, stdout: (t) => (out += t), stderr: (t) => (err += t) });
  return { code, out, err };
}

describe('runCli', () => {
  it('-o で書き、警告は stderr に出る', () => {
    writeFileSync(join(work, 'in.mid'), smfBytes());
    const r = run(['in.mid', '-o', 'out.mml']);
    expect(r.code).toBe(0);
    expect(r.out).toBe('');
    expect(parseMml(readFileSync(join(work, 'out.mml'), 'utf8')).errors).toEqual([]);
  });

  it('-o を省くと stdout に MML が出る', () => {
    writeFileSync(join(work, 'in.mid'), smfBytes());
    const r = run(['in.mid']);
    expect(r.code).toBe(0);
    expect(parseMml(r.out).errors).toEqual([]);
    expect(r.out).toContain('c');
  });

  it('--report で捨てたイベントの種類と件数、チャンネルとトラック名、ループの範囲が stderr に出る', () => {
    const cc64: SmfEvent[] = [64, 64].map((_, i) => ({ kind: 'controlChange', tick: i, channel: 0, controller: 64, value: 127 }));
    writeFileSync(join(work, 'in.mid'), smfBytes(cc64));
    const r = run(['in.mid', '--report']);
    expect(r.code).toBe(0);
    expect(r.err).toContain('コントロールチェンジ 64');
    expect(r.err).toMatch(/コントロールチェンジ 64.*2/);
    expect(r.err).toMatch(/チャンネル 1/);
    expect(r.err).toContain('マーカーがないので曲全体');
  });

  it('--quantize 16 を渡せる', () => {
    writeFileSync(join(work, 'in.mid'), smfBytes());
    expect(run(['in.mid', '--quantize', '16']).code).toBe(0);
  });

  it.each([
    ['--quantize 12', ['in.mid', '-o', 'out.mml', '--quantize', '12']],
    ['入力なし', ['-o', 'out.mml']],
    ['知らない引数', ['in.mid', '-o', 'out.mml', '--nope']],
    ['読めないファイル', ['missing.mid', '-o', 'out.mml']],
  ])('%s は 0 以外で、MML を書かない', (_name, args) => {
    writeFileSync(join(work, 'in.mid'), smfBytes());
    const r = run(args);
    expect(r.code).not.toBe(0);
    expect(r.err).not.toBe('');
    expect(r.out).toBe('');
    expect(existsSync(join(work, 'out.mml'))).toBe(false);
  });

  it('引数の誤りのときは使い方を出す', () => {
    expect(run([]).err).toContain('使い方：');
  });

  it('ConvError のときは 0 以外で、出力ファイルを作らない', () => {
    writeFileSync(join(work, 'bad.mid'), new Uint8Array([1, 2, 3]));
    const r = run(['bad.mid', '-o', 'out.mml']);
    expect(r.code).toBe(1);
    expect(r.err).not.toBe('');
    expect(existsSync(join(work, 'out.mml'))).toBe(false);
  });
});

describe('コマンドとして実行する', () => {
  it('相対パスは、npm run を実行した場所（INIT_CWD）を基準に解く', () => {
    writeFileSync(join(work, 'in.mid'), smfBytes());
    execFileSync('node', ['packages/conv/src/cli.ts', 'in.mid', '-o', 'out.mml'], {
      cwd: REPO_ROOT,
      env: { ...process.env, INIT_CWD: work },
      encoding: 'utf8',
    });
    expect(existsSync(join(work, 'out.mml'))).toBe(true);
    expect(existsSync(join(REPO_ROOT, 'out.mml'))).toBe(false);
  });
});
