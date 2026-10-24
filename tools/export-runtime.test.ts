import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';
import { exportRuntime } from './export-runtime.ts';

const INFO = { commit: 'abc1234def', date: '2026-10-24' };

/** dir の下のファイルを、dir からの相対パスで全部挙げる */
function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    return e.isDirectory() ? listFiles(path, base) : [path.slice(base.length + 1)];
  });
}

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'export-runtime-test-'));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('exportRuntime', () => {
  it('使う部分だけをコピーし、テストと demo・tools・docs は入れない', () => {
    const dest = join(work, 'mml-fm-audio');
    exportRuntime(dest, INFO);
    const files = listFiles(dest);
    expect(files).toContain('packages/runtime/src/index.ts');
    expect(files).toContain('packages/engine/src/processor.ts');
    expect(files).toContain('packages/sequencer/src/player.ts');
    expect(files).toContain('voices/ymf825/gm.json');
    expect(files).toContain('voices/custom/drums.json');
    expect(files).toContain('voices/LICENSE-YMF825.txt');
    expect(files).toContain('UPSTREAM.md');
    expect(files.filter((f) => f.endsWith('.test.ts'))).toEqual([]);
    expect(files.filter((f) => /^(demo|tools|docs)\//.test(f))).toEqual([]);
    expect(files.some((f) => f.endsWith('tonedata.txt'))).toBe(false);
    expect(files.every((f) => /^(packages\/(engine|sequencer|runtime)\/src\/|voices\/|UPSTREAM\.md$)/.test(f))).toBe(true);
  });

  it('UPSTREAM.md に commit・日付・直さないこと・前提を書く', () => {
    const dest = join(work, 'mml-fm-audio');
    exportRuntime(dest, INFO);
    const text = readFileSync(join(dest, 'UPSTREAM.md'), 'utf8');
    expect(text).toContain('https://github.com/akabee0161/mml-fm-audio');
    expect(text).toContain('abc1234def');
    expect(text).toContain('2026-10-24');
    expect(text).toContain('直さない');
    expect(text).toContain('npm run export:runtime');
    expect(text).toContain('packages/runtime/src/index.ts');
    expect(text).toContain('Vite');
    expect(text).toContain('"allowImportingTsExtensions": true');
    expect(text).not.toContain('未コミット');
  });

  it('作業ツリーに未コミットの変更があるときは、その旨を書く', () => {
    const dest = join(work, 'mml-fm-audio');
    exportRuntime(dest, { ...INFO, dirty: true });
    expect(readFileSync(join(dest, 'UPSTREAM.md'), 'utf8')).toContain('未コミット');
  });

  it('コピー先が symlink なら何も書かずに止める', () => {
    const target = join(work, 'target');
    mkdirSync(target);
    const dest = join(work, 'link');
    symlinkSync(target, dest);
    expect(() => exportRuntime(dest, INFO)).toThrow(/symlink/);
    expect(readdirSync(target)).toEqual([]);
  });

  it('UPSTREAM.md のない既存のフォルダには書かずに止める', () => {
    const dest = join(work, 'other');
    mkdirSync(dest);
    writeFileSync(join(dest, 'keep.txt'), 'x');
    expect(() => exportRuntime(dest, INFO)).toThrow(/UPSTREAM\.md/);
    expect(readdirSync(dest)).toEqual(['keep.txt']);
  });

  it('コピー先がファイルなら止める', () => {
    const dest = join(work, 'file');
    writeFileSync(dest, 'x');
    expect(() => exportRuntime(dest, INFO)).toThrow(/フォルダ/);
    expect(readFileSync(dest, 'utf8')).toBe('x');
  });

  it('2 回目のコピーで、元から消したファイルはコピー先からも消える', () => {
    const dest = join(work, 'mml-fm-audio');
    exportRuntime(dest, INFO);
    writeFileSync(join(dest, 'packages/runtime/src/old.ts'), 'stale');
    mkdirSync(join(dest, 'extra'));
    writeFileSync(join(dest, 'extra/x.txt'), 'stale');
    exportRuntime(dest, { commit: 'second', date: '2026-10-25' });
    expect(existsSync(join(dest, 'packages/runtime/src/old.ts'))).toBe(false);
    expect(existsSync(join(dest, 'extra'))).toBe(false);
    expect(readFileSync(join(dest, 'UPSTREAM.md'), 'utf8')).toContain('second');
    expect(statSync(join(dest, 'packages/runtime/src/index.ts')).isFile()).toBe(true);
  });

  it('入れ替えのとき、コピー先の中の symlink の先（コピー先の外）は消さない', () => {
    const outside = join(work, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'precious.txt'), 'keep');
    const dest = join(work, 'mml-fm-audio');
    exportRuntime(dest, INFO);
    symlinkSync(outside, join(dest, 'packages', 'linked'));
    exportRuntime(dest, INFO);
    expect(readFileSync(join(outside, 'precious.txt'), 'utf8')).toBe('keep');
    expect(existsSync(join(dest, 'packages', 'linked'))).toBe(false);
  });
});
